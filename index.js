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

app.get('/health', async (req,res)=>{
  let db = false;
  if(pool){ try{ await pool.query('SELECT 1'); db=true; }catch(e){} }
  res.json({ ok:true, version:'2.1.17', live:true, db_connected:db, emergency_fund:25000 });
});

app.get('/', (req,res)=>res.send('<h1>QISM v2.1.17 LIVE ✅</h1><a href=/health>Health</a> | <a href=/api/fund>Fund</a>'));

app.get('/api/fund', async (req,res)=>{
  if(!pool) return res.json({ fund:25000, source:'memory' });
  try{
    const r = await pool.query('CREATE TABLE IF NOT EXISTS fund (id SERIAL PRIMARY KEY, amount INT); INSERT INTO fund(amount) SELECT 25000 WHERE NOT EXISTS (SELECT 1 FROM fund); SELECT * FROM fund ORDER BY id DESC LIMIT 1;');
    res.json({ fund: r.rows[0]?.amount || 25000, source:'db' });
  }catch(e){ res.status(500).json({error:e.message}); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=>console.log('QISM FINAL on '+PORT));
