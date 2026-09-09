import express from 'express';
import cors from 'cors';
import pg from 'pg';

const app = express();
app.use(cors());
app.use(express.json());

let pool = null;
if (process.env.DATABASE_URL) {
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
}

app.get('/health', async (req,res)=>{
  let db=false;
  if(pool){ try{ await pool.query('SELECT 1'); db=true; }catch{} }
  res.json({ ok:true, version:'2.1.17', live:true, db, fund:25000 });
});

app.get('/api/fund', async (req,res)=>{
  if(!pool) return res.json({ amount:25000, source:'memory' });
  try{
    await pool.query(`CREATE TABLE IF NOT EXISTS fund (id SERIAL PRIMARY KEY, amount INT DEFAULT 25000);
    CREATE TABLE IF NOT EXISTS payments (id SERIAL PRIMARY KEY, amount INT, status TEXT, checkout_id TEXT, created_at TIMESTAMP DEFAULT NOW());`);
    const r = await pool.query('SELECT amount FROM fund ORDER BY id DESC LIMIT 1');
    if(r.rows.length===0) await pool.query('INSERT INTO fund(amount) VALUES(25000)');
    const f = await pool.query('SELECT amount FROM fund ORDER BY id DESC LIMIT 1');
    res.json({ amount: f.rows[0].amount, source:'db' });
  }catch(e){ res.status(500).json({error:e.message}); }
});

// إنشاء رابط دفع Chargily
app.post('/api/pay/create', async (req,res)=>{
  const { amount = 1000 } = req.body;
  if(!process.env.CHARGILY_API_KEY) return res.status(400).json({error:'CHARGILY_API_KEY ناقص في Render'});

  try{
    const resp = await fetch('https://pay.chargily.net/api/v2/checkouts', {
      method:'POST',
      headers:{
        'Authorization': `Bearer ${process.env.CHARGILY_API_KEY}`,
        'Content-Type':'application/json'
      },
      body: JSON.stringify({
        amount,
        currency:'dzd',
        success_url:`${req.headers.origin || 'https://qism-api-final.onrender.com'}/?pay=success`,
        failure_url:`${req.headers.origin || 'https://qism-api-final.onrender.com'}/?pay=fail`,
        webhook_endpoint: process.env.WEBHOOK_URL
      })
    });
    const data = await resp.json();
    if(pool) await pool.query('INSERT INTO payments(amount,status,checkout_id) VALUES($1,$2,$3)', [amount,'pending',data.id || data.checkout_id]);
    res.json(data);
  }catch(e){ res.status(500).json({error:e.message}); }
});

// Webhook يأكد الدفع ويزيد الصندوق
app.post('/api/pay/webhook', async (req,res)=>{
  try{
    const { checkout_id, status } = req.body;
    if(status==='paid' && pool){
      await pool.query("UPDATE payments SET status='paid' WHERE checkout_id=$1", [checkout_id]);
      await pool.query("UPDATE fund SET amount = amount + (SELECT amount FROM payments WHERE checkout_id=$1)", [checkout_id]);
    }
    res.json({ok:true});
  }catch(e){ res.json({ok:true}); }
});

app.get('/', (req,res)=>res.send(`<h1>QISM v2.1.17 LIVE ✅</h1>
<p><a href=/health>Health</a> | <a href=/api/fund>Fund</a></p>
<button onclick="fetch('/api/pay/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount:1000})}).then(r=>r.json()).then(d=>{if(d.checkout_url) location.href=d.checkout_url; else alert(JSON.stringify(d))})">جرب دفع 1000 دج</button>`));

const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=>console.log('QISM FINAL on '+PORT));
