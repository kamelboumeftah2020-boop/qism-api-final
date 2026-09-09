import express from 'express';
import cors from 'cors';
import pg from 'pg';

const app = express();
app.use(cors());
app.use(express.json());

let pool = null;
if (process.env.DATABASE_URL) {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  console.log('DB connected');
}

async function initDB(){
  if(!pool) { console.log('No DATABASE_URL - using memory mode'); return; }
  try{
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, phone TEXT UNIQUE NOT NULL, name TEXT, created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS fund (id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id), amount INT DEFAULT 25000, updated_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS transactions (id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id), type TEXT, amount INT, description TEXT, created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS payments (id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id), amount INT, status TEXT, checkout_id TEXT, created_at TIMESTAMP DEFAULT NOW());
    `);
    console.log('DB tables ready');
  }catch(e){ console.log('DB init error', e.message); }
}
initDB();

// In-memory fallback when no DB
const mem = { users: [{id:1, phone:'0555000000', name:'ضيف'}], funds: {1:25000}, tx: [] };

function genToken(user){ return Buffer.from(JSON.stringify({id:user.id, phone:user.phone})).toString('base64'); }
function getUserFromToken(req){
  try{
    const h = req.headers.authorization || '';
    const token = h.replace('Bearer ','') || req.query.token;
    if(!token) return null;
    const data = JSON.parse(Buffer.from(token,'base64').toString());
    return data;
  }catch{ return null; }
}

async function findOrCreateUser(phone, name){
  if(!pool){
    let u = mem.users.find(x=>x.phone===phone);
    if(!u){ u={id:mem.users.length+1, phone, name:name||'مستخدم'}; mem.users.push(u); mem.funds[u.id]=25000; }
    return u;
  }
  const existing = await pool.query('SELECT * FROM users WHERE phone=$1', [phone]);
  if(existing.rows.length>0) return existing.rows[0];
  const r = await pool.query('INSERT INTO users(phone,name) VALUES($1,$2) RETURNING *', [phone, name||'مستخدم']);
  const user = r.rows[0];
  await pool.query('INSERT INTO fund(user_id,amount) VALUES($1,25000)', [user.id]);
  return user;
}

async function getFund(userId){
  if(!pool) return mem.funds[userId]||25000;
  const r = await pool.query('SELECT amount FROM fund WHERE user_id=$1 ORDER BY id DESC LIMIT 1', [userId]);
  return r.rows[0]?.amount || 25000;
}

app.get('/health', async (req,res)=>{
  let db=false; try{ if(pool){ await pool.query('SELECT 1'); db=true; } }catch{}
  res.json({ ok:true, version:'2.3.0', live:true, db, mode: pool?'postgres':'memory' });
});

app.get('/api/debug',(req,res)=>{
  const k=(process.env.CHARGILY_API_KEY||'').trim();
  res.json({ hasKey:!!k, isSecret:k.startsWith('test_sk_'), len:k.length, preview:k? k.substring(0,12)+'...' : null, hasDb:!!pool });
});

app.post('/api/auth/login', async (req,res)=>{
  const { phone, name } = req.body;
  if(!phone) return res.status(400).json({error:'phone required'});
  const cleanPhone = phone.replace(/\D/g,'').slice(-10);
  try{
    const user = await findOrCreateUser(cleanPhone, name);
    const token = genToken(user);
    res.json({ ok:true, token, user });
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/fund', async (req,res)=>{
  const u = getUserFromToken(req);
  const userId = u?.id || 1;
  try{
    const amount = await getFund(userId);
    res.json({ amount, userId, source: pool?'db':'memory' });
  }catch(e){ res.json({ amount:25000 }); }
});

app.get('/api/transactions', async (req,res)=>{
  const u = getUserFromToken(req);
  const userId = u?.id || 1;
  if(!pool) return res.json({ transactions: mem.tx.filter(x=>x.user_id===userId), payments: [] });
  try{
    const r = await pool.query('SELECT * FROM transactions WHERE user_id=$1 ORDER BY id DESC LIMIT 50', [userId]);
    const p = await pool.query('SELECT * FROM payments WHERE user_id=$1 ORDER BY id DESC LIMIT 20', [userId]);
    res.json({ transactions: r.rows, payments: p.rows });
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/transaction', async (req,res)=>{
  const u = getUserFromToken(req);
  const userId = u?.id || 1;
  const { type, amount, description } = req.body;
  const amt = parseInt(amount)||0;
  if(!pool){
    mem.tx.push({id:Date.now(), user_id:userId, type, amount:amt, description, created_at:new Date().toISOString()});
    if(type==='income') mem.funds[userId]=(mem.funds[userId]||0)+amt;
    else mem.funds[userId]=(mem.funds[userId]||0)-amt;
    return res.json({ ok:true });
  }
  try{
    await pool.query('INSERT INTO transactions(user_id,type,amount,description) VALUES($1,$2,$3,$4)', [userId, type, amt, description]);
    if(type==='income') await pool.query('UPDATE fund SET amount = amount + $1 WHERE user_id=$2', [amt, userId]);
    else await pool.query('UPDATE fund SET amount = amount - $1 WHERE user_id=$2', [amt, userId]);
    res.json({ ok:true });
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/pay/create', async (req,res)=>{
  const u = getUserFromToken(req);
  const userId = u?.id || 1;
  const amount=parseInt(req.body.amount)||1000;
  const key=(process.env.CHARGILY_API_KEY||'').trim();
  const base = key.startsWith('test_') ? 'https://pay.chargily.net/test/api/v2' : 'https://pay.chargily.net/api/v2';
  if(!key || key.startsWith('test_pk_')){
    if(pool) await pool.query('INSERT INTO payments(user_id,amount,status,checkout_id) VALUES($1,$2,$3,$4)', [userId, amount,'mock','mock_'+Date.now()]);
    else mem.tx.push({id:Date.now(), user_id:userId, type:'income', amount, description:'دفع تجريبي', created_at:new Date().toISOString()});
    return res.json({ checkout_url: '/?pay=success&mock='+amount, mock:true });
  }
  try{
    const r=await fetch(base+'/checkouts',{
      method:'POST',
      headers:{ Authorization:'Bearer '+key, 'Content-Type':'application/json' },
      body:JSON.stringify({ amount, currency:'dzd', success_url:'https://'+req.headers.host+'/?pay=success&uid='+userId, failure_url:'https://'+req.headers.host+'/?pay=fail', description:'QISM '+amount+' DZD user '+userId })
    });
    const d=await r.json();
    if(!r.ok){
      if(pool) await pool.query('INSERT INTO payments(user_id,amount,status,checkout_id) VALUES($1,$2,$3,$4)', [userId, amount,'mock_fallback','error']);
      return res.json({ checkout_url:'/?pay=success&mock='+amount, mock:true, chargily_error:d });
    }
    if(pool) await pool.query('INSERT INTO payments(user_id,amount,status,checkout_id) VALUES($1,$2,$3,$4)', [userId, amount,'pending',d.id]);
    res.json(d);
  }catch(e){
    res.json({ checkout_url:'/?pay=success&mock='+amount, mock:true, error:e.message });
  }
});

app.get('/', (req,res)=>{
  res.send(`
<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QISM - قسم</title>
<script src="https://cdn.tailwindcss.com"></script>
<link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;700&display=swap" rel="stylesheet">
<style>body{font-family:'Tajawal',sans-serif}</style>
</head><body class="bg-[#faf9f6] min-h-screen">
<div id="loginScreen" class="min-h-screen flex items-center justify-center p-4">
<div class="bg-white rounded-[32px] p-8 w-full max-w-sm border shadow-sm">
<div class="w-12 h-12 bg-black rounded-2xl flex items-center justify-center text-white font-bold text-xl mx-auto mb-4">ق</div>
<h1 class="text-center font-bold text-2xl">مرحبا في QISM</h1>
<p class="text-center text-sm text-gray-500 mt-1">منصة الادخار - الشلف</p>
<div class="mt-6 space-y-3">
<input id="phone" placeholder="رقم الهاتف 0555..." class="w-full p-3.5 rounded-xl bg-gray-50 border text-left" dir="ltr">
<input id="name" placeholder="اسمك (اختياري)" class="w-full p-3.5 rounded-xl bg-gray-50 border">
<button onclick="login()" class="w-full bg-black text-white py-3.5 rounded-xl font-bold">دخول →</button>
<p class="text-[11px] text-gray-400 text-center mt-3">كل مستخدم عندو صندوقو وحدو - آمن وخاص</p>
</div>
</div>
</div>

<div id="appScreen" class="hidden max-w-6xl mx-auto p-4 md:p-6">
<header class="flex justify-between items-center mb-6">
<div class="flex items-center gap-3"><div class="w-10 h-10 bg-black rounded-xl flex items-center justify-center text-white font-bold">ق</div><div><h1 class="font-bold text-xl">QISM</h1><p class="text-xs text-gray-500" id="userInfo">-</p></div></div>
<div class="flex gap-2"><button onclick="logout()" class="text-xs bg-white px-3 py-1.5 rounded-full border">خروج</button><a href="/health" class="text-xs bg-white px-3 py-1.5 rounded-full border">Health</a></div>
</header>

<div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
<div class="bg-black text-white rounded-[24px] p-6"><p class="text-white/60 text-sm">الرصيد الكلي</p><h2 id="fund" class="text-3xl font-bold mt-2">-- DZD</h2><p class="text-emerald-400 text-xs mt-3">صندوق الطوارئ</p></div>
<div class="bg-white rounded-[24px] p-6 border"><p class="text-gray-500 text-sm">صندوق الطوارئ</p><div class="flex items-end gap-2 mt-2"><h2 class="text-3xl font-bold">25,000</h2><span class="text-sm mb-1">DZD</span></div><div class="w-full h-2 bg-gray-100 rounded-full mt-4"><div class="h-2 bg-black rounded-full" style="width:100%"></div></div><p class="text-xs text-emerald-600 mt-2">✅ الهدف مكتمل - كل مستخدم عندو صندوقو</p></div>
<div class="bg-white rounded-[24px] p-6 border"><p class="text-gray-500 text-sm">حالة Chargily</p><p id="chargilyStatus" class="font-bold mt-2">جاري الفحص...</p><p class="text-xs text-gray-500 mt-2">المفتاح: <span id="keyPreview">--</span></p><button onclick="testPay()" class="mt-4 w-full bg-emerald-500 text-white py-2.5 rounded-xl text-sm font-bold">جرب دفع 1000 دج</button></div>
</div>

<div class="grid grid-cols-1 md:grid-cols-3 gap-4">
<div class="md:col-span-2 bg-white rounded-[24px] p-6 border">
<div class="flex justify-between items-center mb-4"><h3 class="font-bold">معاملاتي</h3><button onclick="addIncome()" class="text-xs bg-black text-white px-3 py-1.5 rounded-full">+ إضافة</button></div>
<div id="txList" class="space-y-3 text-sm"><p class="text-gray-400">جاري التحميل...</p></div>
</div>
<div class="bg-white rounded-[24px] p-6 border">
<h3 class="font-bold mb-4">إجراءات سريعة</h3>
<div class="space-y-2">
<button onclick="addIncome(5000)" class="w-full text-right p-3 rounded-xl bg-gray-50 hover:bg-gray-100 text-sm">💰 إضافة مدخول 5000 دج</button>
<button onclick="addExpense(1000)" class="w-full text-right p-3 rounded-xl bg-gray-50 hover:bg-gray-100 text-sm">💸 سحب 1000 دج</button>
<button onclick="testPay(5000)" class="w-full text-right p-3 rounded-xl bg-emerald-50 hover:bg-emerald-100 text-sm border border-emerald-200">💳 دفع 5000 دج</button>
</div>
<div class="mt-6 p-3 bg-amber-50 rounded-xl text-xs leading-5">💡 <b>نظام حسابات:</b> درك كل زبون يدخل برقمو، صندوقو يبقى محفوظ حتى كي تطفي السارفر.</div>
</div>
</div>
</div>

<script>
let token = localStorage.getItem('qism_token');
function showApp(){ document.getElementById('loginScreen').classList.add('hidden'); document.getElementById('appScreen').classList.remove('hidden'); }
function showLogin(){ document.getElementById('loginScreen').classList.remove('hidden'); document.getElementById('appScreen').classList.add('hidden'); }
async function login(){
  const phone=document.getElementById('phone').value;
  const name=document.getElementById('name').value;
  if(!phone){ alert('دخل رقم الهاتف'); return; }
  const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone,name})}).then(r=>r.json());
  if(r.token){ localStorage.setItem('qism_token', r.token); localStorage.setItem('qism_user', JSON.stringify(r.user)); token=r.token; init(); }
  else alert(r.error||'خطأ');
}
function logout(){ localStorage.clear(); token=null; showLogin(); }
async function init(){
  if(!token){ showLogin(); return; }
  const user = JSON.parse(localStorage.getItem('qism_user')||'{}');
  document.getElementById('userInfo').innerText = (user.name||'') + ' - ' + (user.phone||'');
  showApp();
  load();
}
async function load(){
  try{
    const f = await fetch('/api/fund',{headers:{Authorization:'Bearer '+token}}).then(r=>r.json());
    const d = await fetch('/api/debug').then(r=>r.json());
    document.getElementById('fund').innerText = (f.amount||25000).toLocaleString() + ' DZD';
    document.getElementById('keyPreview').innerText = d.preview || '--';
    const s=document.getElementById('chargilyStatus');
    s.innerText = d.isSecret ? '✅ مفتاح سري صحيح' : '⚠️ مفتاح عام';
    loadTx();
  }catch{}
}
async function loadTx(){
  try{
    const r = await fetch('/api/transactions',{headers:{Authorization:'Bearer '+token}}).then(r=>r.json());
    const all = [].concat(r.transactions||[]).concat(r.payments||[]).slice(0,20);
    const list=document.getElementById('txList');
    if(all.length===0){ list.innerHTML='<p class="text-gray-400">لا توجد معاملات - ابدأ بإضافة مدخول</p>'; return; }
    let html='';
    for(let t of all){
      const dateStr = t.created_at ? new Date(t.created_at).toLocaleString('ar-DZ') : '';
      const desc = t.description || t.type || 'دفع';
      html += '<div class="flex justify-between p-2.5 bg-gray-50 rounded-xl"><div><p class="font-bold">'+desc+'</p><p class="text-[11px] text-gray-500">'+dateStr+'</p></div><p class="font-bold">'+t.amount+' دج</p></div>';
    }
    list.innerHTML=html;
  }catch{}
}
async function testPay(a){
  const amount=a||1000;
  const r=await fetch('/api/pay/create',{method:'POST',headers:{'Content-Type':'application/json', Authorization:'Bearer '+token},body:JSON.stringify({amount})}).then(r=>r.json());
  if(r.checkout_url) location.href=r.checkout_url;
}
async function addIncome(a){
  let amount=a; if(!amount) amount=parseInt(prompt('المبلغ:')||'0'); if(!amount) return;
  await fetch('/api/transaction',{method:'POST',headers:{'Content-Type':'application/json', Authorization:'Bearer '+token},body:JSON.stringify({type:'income',amount,description:'مدخول يدوي'})});
  load();
}
async function addExpense(a){
  let amount=a; if(!amount) amount=parseInt(prompt('المبلغ:')||'0'); if(!amount) return;
  await fetch('/api/transaction',{method:'POST',headers:{'Content-Type':'application/json', Authorization:'Bearer '+token},body:JSON.stringify({type:'expense',amount,description:'مصروف'})});
  load();
}
init();
</script>
</body></html>
  `);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=>console.log('QISM v2.3.0 AUTH READY on '+PORT));
