import express from 'express';
import cors from 'cors';
import pg from 'pg';

const app = express();
app.use(cors());
app.use(express.json());

let pool = null;
if (process.env.DATABASE_URL) {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
}

async function initDB(){
  if(!pool) return;
  try{
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fund (id SERIAL PRIMARY KEY, amount INT DEFAULT 25000, updated_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS payments (id SERIAL PRIMARY KEY, amount INT, status TEXT, checkout_id TEXT, method TEXT DEFAULT 'chargily', created_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS transactions (id SERIAL PRIMARY KEY, type TEXT, amount INT, description TEXT, created_at TIMESTAMP DEFAULT NOW());
    `);
    const f = await pool.query('SELECT * FROM fund LIMIT 1');
    if(f.rows.length===0) await pool.query('INSERT INTO fund(amount) VALUES(25000)');
    console.log('DB ready');
  }catch(e){ console.log('DB init error', e.message); }
}
initDB();

app.get('/health', async (req,res)=>{
  let db=false; try{ if(pool){ await pool.query('SELECT 1'); db=true; } }catch{}
  res.json({ ok:true, version:'2.2.1', live:true, db, fund:25000 });
});

app.get('/api/debug',(req,res)=>{
  const k=(process.env.CHARGILY_API_KEY||'').trim();
  res.json({ hasKey:!!k, isSecret:k.startsWith('test_sk_'), len:k.length, preview:k? k.substring(0,12)+'...' : null, hasDb:!!pool });
});

app.get('/api/fund', async (req,res)=>{
  if(!pool) return res.json({ amount:25000, source:'memory' });
  try{
    const r = await pool.query('SELECT amount FROM fund ORDER BY id DESC LIMIT 1');
    res.json({ amount: r.rows[0]?.amount || 25000, source:'db' });
  }catch(e){ res.json({ amount:25000, source:'error' }); }
});

app.get('/api/transactions', async (req,res)=>{
  if(!pool) return res.json({transactions:[], payments:[]});
  try{
    const r = await pool.query('SELECT * FROM transactions ORDER BY id DESC LIMIT 50');
    const p = await pool.query('SELECT * FROM payments ORDER BY id DESC LIMIT 20');
    res.json({ transactions: r.rows, payments: p.rows });
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/transaction', async (req,res)=>{
  const { type, amount, description } = req.body;
  if(!pool) return res.json({ ok:true, mock:true });
  try{
    await pool.query('INSERT INTO transactions(type,amount,description) VALUES($1,$2,$3)', [type, parseInt(amount), description]);
    if(type==='income') await pool.query('UPDATE fund SET amount = amount + $1', [parseInt(amount)]);
    else await pool.query('UPDATE fund SET amount = amount - $1', [parseInt(amount)]);
    res.json({ ok:true });
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/pay/create', async (req,res)=>{
  const amount=parseInt(req.body.amount)||1000;
  const key=(process.env.CHARGILY_API_KEY||'').trim();
  const base = key.startsWith('test_') ? 'https://pay.chargily.net/test/api/v2' : 'https://pay.chargily.net/api/v2';
  if(!key || key.startsWith('test_pk_')){
    if(pool) await pool.query('INSERT INTO payments(amount,status,checkout_id) VALUES($1,$2,$3)', [amount,'mock','mock_'+Date.now()]);
    return res.json({ checkout_url: '/?pay=success&mock='+amount, mock:true });
  }
  try{
    const r=await fetch(base+'/checkouts',{
      method:'POST',
      headers:{ Authorization:'Bearer '+key, 'Content-Type':'application/json' },
      body:JSON.stringify({ amount, currency:'dzd', success_url:'https://'+req.headers.host+'/?pay=success', failure_url:'https://'+req.headers.host+'/?pay=fail', description:'QISM '+amount+' DZD' })
    });
    const d=await r.json();
    if(!r.ok){
      if(pool) await pool.query('INSERT INTO payments(amount,status,checkout_id) VALUES($1,$2,$3)', [amount,'mock_fallback','error']);
      return res.json({ checkout_url:'/?pay=success&mock='+amount, mock:true, chargily_error:d });
    }
    if(pool) await pool.query('INSERT INTO payments(amount,status,checkout_id) VALUES($1,$2,$3)', [amount,'pending',d.id]);
    res.json(d);
  }catch(e){
    res.json({ checkout_url:'/?pay=success&mock='+amount, mock:true, error:e.message });
  }
});

app.get('/', (req,res)=>{
  const html = `
<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QISM - قسم</title>
<script src="https://cdn.tailwindcss.com"></script>
<link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;700&display=swap" rel="stylesheet">
<style>body{font-family:'Tajawal',sans-serif}</style>
</head><body class="bg-[#faf9f6] min-h-screen">
<div class="max-w-6xl mx-auto p-4 md:p-6">
<header class="flex justify-between items-center mb-6">
<div class="flex items-center gap-3"><div class="w-10 h-10 bg-black rounded-xl flex items-center justify-center text-white font-bold">ق</div><div><h1 class="font-bold text-xl">QISM</h1><p class="text-xs text-gray-500">منصة الادخار - الشلف</p></div></div>
<div class="flex gap-2"><a href="/health" class="text-xs bg-white px-3 py-1.5 rounded-full border">Health</a><a href="/api/debug" class="text-xs bg-white px-3 py-1.5 rounded-full border">Debug</a></div>
</header>

<div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
<div class="bg-black text-white rounded-[24px] p-6"><p class="text-white/60 text-sm">الرصيد الكلي</p><h2 id="fund" class="text-3xl font-bold mt-2">-- DZD</h2><p class="text-emerald-400 text-xs mt-3">صندوق الطوارئ 25,000 دج</p></div>
<div class="bg-white rounded-[24px] p-6 border"><p class="text-gray-500 text-sm">صندوق الطوارئ</p><div class="flex items-end gap-2 mt-2"><h2 class="text-3xl font-bold">25,000</h2><span class="text-sm mb-1">DZD</span></div><div class="w-full h-2 bg-gray-100 rounded-full mt-4"><div class="h-2 bg-black rounded-full" style="width:100%"></div></div><p class="text-xs text-gray-500 mt-2">الهدف مكتمل ✅</p></div>
<div class="bg-white rounded-[24px] p-6 border"><p class="text-gray-500 text-sm">حالة Chargily</p><p id="chargilyStatus" class="font-bold mt-2">جاري الفحص...</p><p class="text-xs text-gray-500 mt-2">المفتاح: <span id="keyPreview">--</span></p><button onclick="testPay()" class="mt-4 w-full bg-emerald-500 text-white py-2.5 rounded-xl text-sm font-bold">جرب دفع 1000 دج</button></div>
</div>

<div class="grid grid-cols-1 md:grid-cols-3 gap-4">
<div class="md:col-span-2 bg-white rounded-[24px] p-6 border">
<div class="flex justify-between items-center mb-4"><h3 class="font-bold">المعاملات الأخيرة</h3><button onclick="addIncome()" class="text-xs bg-black text-white px-3 py-1.5 rounded-full">+ إضافة</button></div>
<div id="txList" class="space-y-3 text-sm"><p class="text-gray-400">جاري التحميل...</p></div>
</div>
<div class="bg-white rounded-[24px] p-6 border">
<h3 class="font-bold mb-4">إجراءات سريعة</h3>
<div class="space-y-2">
<button onclick="addIncome(5000)" class="w-full text-right p-3 rounded-xl bg-gray-50 hover:bg-gray-100 text-sm">💰 إضافة مدخول 5000 دج</button>
<button onclick="addExpense(1000)" class="w-full text-right p-3 rounded-xl bg-gray-50 hover:bg-gray-100 text-sm">💸 سحب 1000 دج</button>
<button onclick="testPay(5000)" class="w-full text-right p-3 rounded-xl bg-emerald-50 hover:bg-emerald-100 text-sm border border-emerald-200">💳 دفع 5000 دج عبر البطاقة</button>
<button onclick="location.href='/api/transactions'" class="w-full text-right p-3 rounded-xl bg-gray-50 text-sm">📊 عرض المعاملات JSON</button>
</div>
<div class="mt-6 p-3 bg-amber-50 rounded-xl text-xs leading-5">💡 <b>نصيحة QISM:</b> صندوق الطوارئ 25,000 دج يكفيك 3 أشهر. حافظ عليه.</div>
</div>
</div>

<div class="mt-6 text-center text-[11px] text-gray-400">QISM v2.2.1 • LIVE • Chlef, Algeria</div>
</div>

<script>
async function load(){
  try{
    const f = await fetch('/api/fund').then(r=>r.json());
    const d = await fetch('/api/debug').then(r=>r.json());
    document.getElementById('fund').innerText = (f.amount||25000).toLocaleString() + ' DZD';
    document.getElementById('keyPreview').innerText = d.preview || 'غير موجود';
    const s = document.getElementById('chargilyStatus');
    if(d.isSecret){ s.innerText='✅ مفتاح سري صحيح'; s.className='font-bold mt-2 text-emerald-600'; }
    else { s.innerText='⚠️ مفتاح عام - بدله'; s.className='font-bold mt-2 text-amber-600'; }
    loadTx();
  }catch(e){}
}
async function loadTx(){
  try{
    const r = await fetch('/api/transactions').then(r=>r.json());
    const all = [].concat(r.transactions||[]).concat(r.payments||[]).slice(0,10);
    const list = document.getElementById('txList');
    if(all.length===0){ list.innerHTML='<p class="text-gray-400">لا توجد معاملات بعد</p>'; return; }
    let html='';
    for(let i=0;i<all.length;i++){
      const t=all[i];
      const dateStr = t.created_at ? new Date(t.created_at).toLocaleString('ar-DZ') : '';
      const desc = t.description || t.type || 'دفع';
      html += '<div class="flex justify-between p-2.5 bg-gray-50 rounded-xl"><div><p class="font-bold">'+desc+'</p><p class="text-[11px] text-gray-500">'+dateStr+'</p></div><p class="font-bold">'+t.amount+' دج</p></div>';
    }
    list.innerHTML=html;
  }catch{}
}
async function testPay(a){
  const amount = a || 1000;
  try{
    const r = await fetch('/api/pay/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount})}).then(r=>r.json());
    if(r.checkout_url){ location.href=r.checkout_url; } else alert(JSON.stringify(r));
  }catch(e){ alert(e.message); }
}
async function addIncome(a){
  let amount = a;
  if(!amount) amount = parseInt(prompt('المبلغ:')||'0');
  if(!amount) return;
  await fetch('/api/transaction',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'income',amount,description:'مدخول يدوي'})});
  load();
}
async function addExpense(a){
  let amount = a;
  if(!amount) amount = parseInt(prompt('المبلغ:')||'0');
  if(!amount) return;
  await fetch('/api/transaction',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'expense',amount,description:'مصروف'})});
  load();
}
load();
</script>
</body></html>
`;
  res.send(html);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=>console.log('QISM v2.2.1 READY on '+PORT));
