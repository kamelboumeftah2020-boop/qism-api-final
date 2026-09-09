import express from 'express';
import cors from 'cors';
const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/debug',(req,res)=>{
  const k=(process.env.CHARGILY_API_KEY||'').trim();
  res.json({hasKey:!!k, isSecret:k.startsWith('test_sk_'), len:k.length, preview:k.substring(0,12)+'...'});
});

app.post('/api/pay/create', async (req,res)=>{
  const amount=parseInt(req.body.amount)||1000;
  const key=(process.env.CHARGILY_API_KEY||'').trim();
  if(!key ||!key.startsWith('test_sk_')){
    return res.json({checkout_url:`/?pay=success&mock=${amount}`, mock:true});
  }
  const base='https://pay.chargily.net/test/api/v2';
  try{
    const r=await fetch(`${base}/checkouts`,{
      method:'POST',
      headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},
      body:JSON.stringify({
        amount,
        currency:'dzd',
        success_url:`https://${req.headers.host}/?pay=success`,
        failure_url:`https://${req.headers.host}/?pay=fail`,
        description:'QISM test payment'
      })
    });
    const d=await r.json();
    if(!r.ok){
      console.log('Chargily fail',r.status,d);
      // إذا الحساب مازال معلق، رجع mock باش تكمل
      return res.json({checkout_url:`/?pay=success&mock=${amount}`, mock:true, chargily_error:d});
    }
    res.json(d);
  }catch(e){res.json({checkout_url:`/?pay=success&mock=${amount}`, mock:true, error:e.message});}
});

app.get('/',(req,res)=>res.send(`<h1>QISM v2.1.17 LIVE ✅</h1><a href=/api/debug>Debug</a><br><button onclick="fetch('/api/pay/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount:1000})}).then(r=>r.json()).then(d=>location.href=d.checkout_url)">جرب دفع 1000 دج</button>`));
app.listen(process.env.PORT||10000);
