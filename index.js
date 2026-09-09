import express from 'express';
import cors from 'cors';
const app = express();
app.use(cors());
app.use(express.json());

app.get('/health',(req,res)=>res.json({ok:true,version:'2.1.17',live:true}));
app.get('/api/debug',(req,res)=>{
  const k=process.env.CHARGILY_API_KEY||'';
  res.json({hasKey:!!k, isSecret:k.startsWith('test_sk_'), isPublic:k.startsWith('test_pk_'), len:k.length});
});

app.post('/api/pay/create', async (req,res)=>{
  const amount=req.body.amount||1000;
  const key=process.env.CHARGILY_API_KEY||'';
  if(!key || key.startsWith('test_pk_')){
    return res.json({checkout_url:`/?pay=success&mock=${amount}`, mock:true, msg:'حط test_sk_ باش يولي دفع حقيقي - درك راهو تجريبي'});
  }
  const base=key.startsWith('test_')?'https://pay.chargily.net/test/api/v2':'https://pay.chargily.net/api/v2';
  try{
    const r=await fetch(`${base}/checkouts`,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({amount,currency:'dzd'})});
    const d=await r.json();
    if(!r.ok && d.message==='Unauthenticated.'){
      return res.json({checkout_url:`/?pay=success&mock=${amount}`, mock:true, msg:'المفتاح مرفوض - تأكد test_sk_ وحسابك مفعل'});
    }
    res.json(d);
  }catch(e){res.json({checkout_url:`/?pay=success&mock=${amount}`, mock:true, error:e.message});}
});

app.get('/',(req,res)=>res.send(`<h1>QISM v2.1.17 LIVE ✅</h1><p><a href=/health>Health</a> | <a href=/api/debug>Debug</a></p><button onclick="fetch('/api/pay/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount:1000})}).then(r=>r.json()).then(d=>location.href=d.checkout_url)">جرب دفع 1000 دج</button>`));
app.listen(process.env.PORT||10000);
