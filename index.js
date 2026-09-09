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

app.get('/health', async (req,res)=>{
  let db=false;
  if(pool){ try{ await pool.query('SELECT 1'); db=true; }catch{} }
  res.json({ ok:true, version:'2.1.17', live:true, db, fund:25000 });
});

app.get('/api/debug', (req,res)=>{
  const key = process.env.CHARGILY_API_KEY || '';
  res.json({ hasKey:!!key, prefix: key.substring(0,5), length: key.length, hasDb:!!process.env.DATABASE_URL });
});

app.get('/api/fund', async (req,res)=>{
  if(!pool) return res.json({ amount:25000, source:'memory - زيد DATABASE_URL باش تولي db' });
  try{
    await pool.query(`CREATE TABLE IF NOT EXISTS fund (id SERIAL PRIMARY KEY, amount INT DEFAULT 25000);
    CREATE TABLE IF NOT EXISTS payments (id SERIAL PRIMARY KEY, amount INT, status TEXT, checkout_id TEXT, created_at TIMESTAMP DEFAULT NOW());`);
    const r = await pool.query('SELECT amount FROM fund ORDER BY id DESC LIMIT 1');
    if(r.rows.length===0) await pool.query('INSERT INTO fund(amount) VALUES(25000)');
    const f = await pool.query('SELECT amount FROM fund ORDER BY id DESC LIMIT 1');
    res.json({ amount: f.rows[0].amount, source:'db' });
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/pay/create', async (req,res)=>{
  const { amount = 1000 } = req.body;
  const key = process.env.CHARGILY_API_KEY || '';

  if(!key){
    return res.json({ checkout_url: `/?pay=success&mock=${amount}`, mock:true, message:'Mode تجريبي - زيد CHARGILY_API_KEY' });
  }

  // هذا هو الحل: نبدلو الرابط حسب المفتاح
  const isTest = key.startsWith('test_');
  const baseUrl = isTest? 'https://pay.chargily.net/test/api/v2' : 'https://pay.chargily.net/api/v2';

  try{
    const resp = await fetch(`${baseUrl}/checkouts`, {
      method:'POST',
      headers:{ 'Authorization': `Bearer ${key}`, 'Content-Type':'application/json' },
      body: JSON.stringify({
        amount: parseInt(amount),
        currency:'dzd',
        success_url: `https://${req.headers.host}/?pay=success`,
        failure_url: `https://${req.headers.host}/?pay=fail`
      })
    });
    const data = await resp.json();
    console.log('Chargily URL:', baseUrl, 'Status:', resp.status, 'Data:', data);

    if(!resp.ok){
      return res.status(resp.status).json({
        chargily_error: data,
        used_url: baseUrl,
        hint: isTest? 'مفتاح test_ لازم يضرب في /test/api/v2 - درك صححناه' : 'تأكد حسابك مفعل في Chargily'
      });
    }
    if(pool) await pool.query('INSERT INTO payments(amount,status,checkout_id) VALUES($1,$2,$3)', [amount,'pending',data.id]);
    res.json(data);
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/pay/webhook', async (req,res)=>{
  try{
    const { checkout_id, status } = req.body;
    if(status==='paid' && pool){
      await pool.query("UPDATE payments SET status='paid' WHERE checkout_id=$1", [checkout_id]);
      await pool.query("UPDATE fund SET amount = amount + (SELECT amount FROM payments WHERE checkout_id=$1)", [checkout_id]);
    }
    res.json({ok:true});
  }catch{ res.json({ok:true}); }
});

app.get('/', (req,res)=>res.send(`<h1>QISM v2.1.17 LIVE ✅</h1>
<p><a href=/health>Health</a> | <a href=/api/debug>Debug</a> | <a href=/api/fund>Fund</a></p>
<button onclick="fetch('/api/pay/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount:1000})}).then(r=>r.json()).then(d=>{console.log(d); if(d.checkout_url) location.href=d.checkout_url; else alert(JSON.stringify(d,null,2))})">جرب دفع 1000 دج</button>`));

const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=>console.log('QISM FINAL on '+PORT));
