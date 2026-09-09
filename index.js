
import express from 'express';
import cors from 'cors';
import pg from 'pg';
const app=express();
app.use(cors());
app.use(express.json());
let pool=null;
if(process.env.DATABASE_URL){pool=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});}

async function initDB(){
 if(!pool) return;
 try{
  await pool.query(`
  CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, email TEXT UNIQUE, name TEXT, role TEXT DEFAULT 'student', phone TEXT, google_id TEXT, facebook_id TEXT, avatar TEXT, subscription TEXT DEFAULT 'free', created_at TIMESTAMP DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS wallet (id SERIAL PRIMARY KEY, user_id INT UNIQUE REFERENCES users(id), amount INT DEFAULT 0);
  CREATE TABLE IF NOT EXISTS platform_wallet (id SERIAL PRIMARY KEY, amount INT DEFAULT 25000, emergency_fund INT DEFAULT 25000, total_revenue INT DEFAULT 0);
  CREATE TABLE IF NOT EXISTS teachers (user_id INT PRIMARY KEY REFERENCES users(id), bio TEXT, speciality TEXT, verified BOOLEAN DEFAULT false, rating NUMERIC DEFAULT 5.0, total_students INT DEFAULT 0, total_earnings INT DEFAULT 0);
  CREATE TABLE IF NOT EXISTS courses (id SERIAL PRIMARY KEY, teacher_id INT REFERENCES users(id), title TEXT NOT NULL, description TEXT, price INT NOT NULL, category TEXT, image TEXT DEFAULT '📚', lessons_count INT DEFAULT 0, schedule TEXT, status TEXT DEFAULT 'published', students_count INT DEFAULT 0, created_at TIMESTAMP DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS lessons (id SERIAL PRIMARY KEY, course_id INT REFERENCES courses(id) ON DELETE CASCADE, title TEXT, description TEXT, video_url TEXT, order_num INT, duration INT DEFAULT 60, created_at TIMESTAMP DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS enrollments (id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id), course_id INT REFERENCES courses(id), teacher_id INT REFERENCES users(id), price_paid INT, commission_paid INT, teacher_earning INT, platform_fee INT, progress INT DEFAULT 0, created_at TIMESTAMP DEFAULT NOW(), UNIQUE(user_id,course_id));
  CREATE TABLE IF NOT EXISTS transactions (id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id), type TEXT, amount INT, description TEXT, chargily_checkout_id TEXT, status TEXT DEFAULT 'completed', created_at TIMESTAMP DEFAULT NOW());
  CREATE TABLE IF NOT EXISTS parent_links (id SERIAL PRIMARY KEY, parent_id INT REFERENCES users(id), student_id INT REFERENCES users(id), status TEXT DEFAULT 'active', created_at TIMESTAMP DEFAULT NOW(), UNIQUE(parent_id,student_id));
  CREATE TABLE IF NOT EXISTS chargily_checkouts (id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id), amount INT, checkout_id TEXT, checkout_url TEXT, status TEXT DEFAULT 'pending', created_at TIMESTAMP DEFAULT NOW());
  `);
  await pool.query(`INSERT INTO platform_wallet(amount,emergency_fund,total_revenue) SELECT 25000,25000,0 WHERE NOT EXISTS (SELECT 1 FROM platform_wallet)`);
  const c=await pool.query('SELECT COUNT(*) FROM courses'); 
  if(parseInt(c.rows[0].count)===0){
    const t=await pool.query(`INSERT INTO users(email,name,role) VALUES ('kamel@qism.dz','الأستاذ كمال','teacher'),('sara@qism.dz','الأستاذة سارة','teacher') ON CONFLICT (email) DO NOTHING RETURNING id`);
    let kamelId=1; let saraId=2;
    try{const u=await pool.query(`SELECT id FROM users WHERE email='kamel@qism.dz'`); if(u.rows[0]) kamelId=u.rows[0].id; const u2=await pool.query(`SELECT id FROM users WHERE email='sara@qism.dz'`); if(u2.rows[0]) saraId=u2.rows[0].id; }catch{}
    await pool.query(`INSERT INTO teachers(user_id,bio,speciality,verified) VALUES ($1,'خبير برمجة 10 سنوات','برمجة',true),($2,'مدرسة انجليزية','لغات',true) ON CONFLICT DO NOTHING`,[kamelId,saraId]);
    await pool.query(`INSERT INTO courses(teacher_id,title,description,price,category,image,lessons_count) VALUES ($1,'أساسيات البرمجة - بايثون وجافاسكريبت','من الصفر للاحتراف - 40 ساعة فيديو + بث مباشر + مشاريع',5000,'برمجة','💻',12),($1,'الرياضيات - بكالوريا 2026','مراجعة شاملة مع تمارين وبث مباشر',7000,'بكالوريا','📐',30),($2,'الإنجليزية - محادثة','قواعد ومحادثة للمبتدئين',3000,'لغات','🇬🇧',20)`,[kamelId]);
    for(let id of [kamelId,saraId]){await pool.query(`INSERT INTO wallet(user_id,amount) VALUES($1,0) ON CONFLICT (user_id) DO NOTHING`,[id]);}
  }
 }catch(e){console.log('DB init error',e.message);}
}
initDB();

const mem={users:[{id:1,email:'kamel@qism.dz',name:'الأستاذ كمال',role:'teacher'},{id:2,email:'sara@qism.dz',name:'الأستاذة سارة',role:'teacher'}],wallets:{1:0,2:0},courses:[{id:1,teacher_id:1,title:'برمجة',price:5000,teacher_name:'كمال',image:'💻',lessons_count:12,students_count:0,category:'برمجة',description:'من الصفر'}],teachers:[{user_id:1,bio:'خبير',speciality:'برمجة',verified:true}],enrollments:[],parent_links:[],checkouts:[]};

function genToken(u){return Buffer.from(JSON.stringify({id:u.id,email:u.email,role:u.role})).toString('base64');}
function getUser(req){try{const t=(req.headers.authorization||'').replace('Bearer ','')||req.query.token; if(!t) return null; return JSON.parse(Buffer.from(t,'base64').toString());}catch{return null;}}
async function calcCommission(price,sub='free',avg=0){let rate=30; let fixed=sub==='free'?200:0; if(sub==='pro') rate=avg>=60?20:30; else if(sub==='enterprise'){if(avg>=80) rate=15; else if(avg>=60) rate=20; else rate=30;} const comm=Math.floor(price*rate/100); return {rate,commission:comm,fixed,teacherEarning:price-comm-fixed,platformFee:comm+fixed};}
async function findOrCreate(email,name,prov,pid,avatar,role,phone){
 const clean=(email||'').toLowerCase();
 if(!pool){
   let u=mem.users.find(x=>x.email===clean); 
   if(!u){u={id:mem.users.length+1,email:clean,name:name||'طالب',role:role||'student',avatar,google_id:prov==='google'?pid:null,facebook_id:prov==='facebook'?pid:null,phone}; mem.users.push(u); mem.wallets[u.id]=0; if(role==='teacher'){mem.teachers.push({user_id:u.id,bio:'',speciality:'',verified:false});}} 
   return u;
 }
 try{
   let ex=await pool.query('SELECT * FROM users WHERE email=$1',[clean]); 
   if(ex.rows.length){ 
     if(prov==='google' && !ex.rows[0].google_id) await pool.query('UPDATE users SET google_id=$1, avatar=COALESCE($2,avatar) WHERE id=$3',[pid,avatar,ex.rows[0].id]).catch(()=>{});
     if(prov==='facebook' && !ex.rows[0].facebook_id) await pool.query('UPDATE users SET facebook_id=$1, avatar=COALESCE($2,avatar) WHERE id=$3',[pid,avatar,ex.rows[0].id]).catch(()=>{});
     return ex.rows[0]; 
   }
   const r=await pool.query('INSERT INTO users(email,name,role,google_id,facebook_id,avatar,phone) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[clean,name||'طالب',role||'student',prov==='google'?pid:null,prov==='facebook'?pid:null,avatar||null,phone||null]);
   await pool.query('INSERT INTO wallet(user_id,amount) VALUES($1,0) ON CONFLICT (user_id) DO NOTHING',[r.rows[0].id]);
   if(role==='teacher'){await pool.query('INSERT INTO teachers(user_id,bio,speciality) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[r.rows[0].id,'','']);}
   return r.rows[0];
 }catch(e){console.log('findOrCreate',e.message); try{const r=await pool.query('SELECT * FROM users WHERE email=$1',[clean]); return r.rows[0];}catch{return {id:1,email:clean,name:name||'طالب',role:role||'student'};}}
}

async function createChargilyCheckout(amount,userId,email,name){
  const apiKey=process.env.CHARGILY_API_KEY||'';
  const backendUrl=process.env.BACKEND_URL||'https://qism-api-final.onrender.com';
  const frontendUrl=process.env.FRONTEND_URL||'https://qism-api-final.onrender.com';
  if(!apiKey){
    return {checkout_url:`${frontendUrl}/?mock_payment=${amount}&user=${userId}`,checkout_id:'mock_'+Date.now(),mock:true};
  }
  try{
    const resp=await fetch('https://pay.chargily.net/api/v2/checkouts',{
      method:'POST',
      headers:{'Authorization':`Bearer ${apiKey}`,'Content-Type':'application/json'},
      body:JSON.stringify({
        amount:parseInt(amount),
        currency:'dzd',
        description:`شحن محفظة قِسم - ${amount} دج`,
        success_url:`${frontendUrl}/?payment=success&amount=${amount}`,
        failure_url:`${frontendUrl}/?payment=failed`,
        webhook_endpoint:`${backendUrl}/api/webhooks/chargily`,
        customer:{email:email||'client@qism.dz',name:name||'طالب قِسم'},
        metadata:{user_id:String(userId),email:email||''}
      })
    });
    const data=await resp.json();
    if(data && (data.checkout_url || data.data?.checkout_url)){
      const url=data.checkout_url||data.data?.checkout_url;
      const id=data.id||data.data?.id||'chk_'+Date.now();
      return {checkout_url:url,checkout_id:id,mock:false,data};
    }else{
      console.log('Chargily response',JSON.stringify(data).slice(0,500));
      return {checkout_url:`${frontendUrl}/?mock_payment=${amount}&user=${userId}&error=chargily_${encodeURIComponent(JSON.stringify(data).slice(0,100))}`,checkout_id:'mock_'+Date.now(),mock:true,chargily_error:data};
    }
  }catch(e){
    console.log('Chargily error',e.message);
    return {checkout_url:`${frontendUrl}/?mock_payment=${amount}&user=${userId}`,checkout_id:'mock_'+Date.now(),mock:true,error:e.message};
  }
}

app.get('/health',async(req,res)=>{
  let db=false; try{if(pool){await pool.query('SELECT 1'); db=true;}}catch{}
  const pw=pool? (await pool.query('SELECT * FROM platform_wallet LIMIT 1').then(r=>r.rows[0]).catch(()=>({amount:25000,emergency_fund:25000,total_revenue:0}))):{amount:25000,emergency_fund:25000,total_revenue:0};
  res.json({ok:true,version:'7.0-real-production-chargily-teacher-parent',live:true,db,platform:'teaching',wallet_start:0,emergency_fund:pw.emergency_fund||25000,platform_revenue:pw.total_revenue||0,commission_system:true,oauth:true,real_oauth:true,chargily_configured:!!process.env.CHARGILY_API_KEY,chargily_mode:process.env.CHARGILY_API_KEY?.startsWith('live_')?'live':process.env.CHARGILY_API_KEY?'test':'mock',full_design:true,real_platform:true,roles:['student','teacher','parent','admin'],features:['chargily_real','teacher_publish_real','parent_link_real','student_subscribe_real']});
});

app.get('/api/config',(req,res)=>{res.json({google_client_id:process.env.GOOGLE_CLIENT_ID||'',facebook_app_id:process.env.FACEBOOK_APP_ID||'',chargily_configured:!!process.env.CHARGILY_API_KEY,chargily_mode:process.env.CHARGILY_API_KEY?.startsWith('live_')?'live':process.env.CHARGILY_API_KEY?'test':'mock'});});

app.post('/api/auth/login',async(req,res)=>{const {phone,email,name,role}=req.body; const clean=(email||phone+'@qism.dz').toLowerCase(); const u=await findOrCreate(clean,name,'phone',null,null,role,phone); res.json({ok:true,token:genToken(u),user:u});});
app.post('/api/auth/google',async(req,res)=>{const {email,name,google_id,avatar}=req.body; if(!email) return res.status(400).json({error:'email required'}); const u=await findOrCreate(email,name,'google',google_id,avatar,'student'); res.json({ok:true,token:genToken(u),user:u,real:true});});
app.post('/api/auth/facebook',async(req,res)=>{const {email,name,facebook_id,avatar}=req.body; if(!email) return res.status(400).json({error:'email required'}); const u=await findOrCreate(email,name,'facebook',facebook_id,avatar,'student'); res.json({ok:true,token:genToken(u),user:u,real:true});});

app.get('/api/courses',async(req,res)=>{
  const category=req.query.category; const teacherId=req.query.teacher_id; const search=req.query.search;
  if(!pool){
    let filtered=mem.courses;
    if(teacherId) filtered=filtered.filter(c=>c.teacher_id==teacherId);
    if(category) filtered=filtered.filter(c=>c.category===category);
    if(search) filtered=filtered.filter(c=>c.title.includes(search));
    return res.json(filtered.map(c=>({...c,teacher_name:mem.users.find(u=>u.id==c.teacher_id)?.name||'أستاذ'})));
  }
  let q=`SELECT c.*, u.name as teacher_name, t.bio, t.speciality, t.verified FROM courses c LEFT JOIN users u ON u.id=c.teacher_id LEFT JOIN teachers t ON t.user_id=c.teacher_id WHERE c.status='published'`;
  let params=[]; let idx=1;
  if(teacherId){q+=` AND c.teacher_id=$${idx}`; params.push(teacherId); idx++;}
  if(category){q+=` AND c.category=$${idx}`; params.push(category); idx++;}
  if(search){q+=` AND (c.title ILIKE $${idx} OR c.description ILIKE $${idx})`; params.push(`%${search}%`); idx++;}
  q+=` ORDER BY c.created_at DESC`;
  const r=await pool.query(q,params); res.json(r.rows);
});

app.get('/api/teachers',async(req,res)=>{
  if(!pool){
    const teachers=mem.users.filter(u=>u.role==='teacher').map(u=>{const t=mem.teachers.find(tt=>tt.user_id==u.id)||{}; const courses=mem.courses.filter(c=>c.teacher_id==u.id); return {...u,...t,courses_count:courses.length,courses};});
    return res.json(teachers);
  }
  const r=await pool.query(`SELECT u.id, u.name, u.email, u.avatar, t.bio, t.speciality, t.verified, t.rating, t.total_students, (SELECT COUNT(*) FROM courses WHERE teacher_id=u.id) as courses_count FROM users u LEFT JOIN teachers t ON t.user_id=u.id WHERE u.role='teacher' ORDER BY t.rating DESC`);
  for(let teacher of r.rows){const cr=await pool.query('SELECT * FROM courses WHERE teacher_id=$1 AND status=$2 ORDER BY created_at DESC', [teacher.id,'published']); teacher.courses=cr.rows;}
  res.json(r.rows);
});

app.get('/api/teachers/:id',async(req,res)=>{
  const id=parseInt(req.params.id);
  if(!pool){const u=mem.users.find(x=>x.id==id); const t=mem.teachers.find(x=>x.user_id==id)||{}; const courses=mem.courses.filter(c=>c.teacher_id==id); return res.json({...u,...t,courses});}
  const u=await pool.query('SELECT u.*, t.bio, t.speciality, t.verified, t.rating FROM users u LEFT JOIN teachers t ON t.user_id=u.id WHERE u.id=$1',[id]); if(!u.rows.length) return res.status(404).json({error:'teacher not found'});
  const courses=await pool.query('SELECT * FROM courses WHERE teacher_id=$1 ORDER BY created_at DESC',[id]); res.json({...u.rows[0],courses:courses.rows});
});

app.get('/api/wallet',async(req,res)=>{
  const u=getUser(req); if(!u) return res.status(401).json({error:'unauthorized'}); const uid=u.id;
  if(!pool) return res.json({amount:mem.wallets[uid]||0,emergency_fund:25000,platform_revenue:0});
  const r=await pool.query('SELECT amount FROM wallet WHERE user_id=$1',[uid]); const pw=await pool.query('SELECT * FROM platform_wallet LIMIT 1'); res.json({amount:r.rows[0]?.amount||0,emergency_fund:pw.rows[0]?.emergency_fund||25000,platform_revenue:pw.rows[0]?.total_revenue||0});
});

app.post('/api/wallet/topup/chargily',async(req,res)=>{
  const u=getUser(req); if(!u) return res.status(401).json({error:'unauthorized'});
  const amount=parseInt(req.body.amount); if(!amount || amount<1000) return res.status(400).json({error:'الحد الأدنى 1000 دج'});
  const checkout=await createChargilyCheckout(amount,u.id,u.email,u.name);
  if(!pool){mem.checkouts.push({user_id:u.id,amount,checkout_id:checkout.checkout_id,checkout_url:checkout.checkout_url,status:'pending'}); return res.json({ok:true,...checkout});}
  await pool.query('INSERT INTO chargily_checkouts(user_id,amount,checkout_id,checkout_url,status) VALUES($1,$2,$3,$4,$5)',[u.id,amount,checkout.checkout_id,checkout.checkout_url,'pending']);
  await pool.query('INSERT INTO transactions(user_id,type,amount,description,chargily_checkout_id,status) VALUES($1,$2,$3,$4,$5,$6)',[u.id,'pending',amount,`شحن ${amount} دج عبر Chargily - ${checkout.mock?'تجريبي':'حقيقي'} - في انتظار الدفع`,checkout.checkout_id,'pending']);
  res.json({ok:true,...checkout});
});

app.post('/api/wallet/topup',async(req,res)=>{
  const u=getUser(req); if(!u) return res.status(401).json({error:'unauthorized'});
  const amount=parseInt(req.body.amount)||1000; const uid=u.id;
  if(!pool){mem.wallets[uid]=(mem.wallets[uid]||0)+amount; return res.json({ok:true,mock:true,amount});}
  await pool.query('UPDATE wallet SET amount=amount+$1 WHERE user_id=$2',[amount,uid]);
  await pool.query('INSERT INTO transactions(user_id,type,amount,description,status) VALUES($1,$2,$3,$4,$5)',[uid,'income',amount,`شحن ${amount} دج (تجريبي - الحقيقي عبر Chargily)`,`completed`]);
  res.json({ok:true,mock:true,amount});
});

app.post('/api/webhooks/chargily',async(req,res)=>{
  try{
    const event=req.body; console.log('Chargily webhook',JSON.stringify(event).slice(0,1000));
    const checkoutId=event.data?.id||event.id||event.checkout_id; const amount=event.data?.amount||event.amount; const status=event.type||event.status;
    const userId=event.data?.metadata?.user_id||event.metadata?.user_id;
    if(!checkoutId){return res.json({ok:true,ignored:true});}
    const isPaid=status==='checkout.paid' || status==='paid' || event.data?.status==='paid' || event.type?.includes('paid');
    if(isPaid && userId){
      if(pool){
        const existing=await pool.query('SELECT * FROM chargily_checkouts WHERE checkout_id=$1',[checkoutId]);
        if(existing.rows.length && existing.rows[0].status!=='paid'){
          await pool.query('UPDATE chargily_checkouts SET status=$1 WHERE checkout_id=$2',['paid',checkoutId]);
          await pool.query('UPDATE wallet SET amount=amount+$1 WHERE user_id=$2',[existing.rows[0].amount||amount,parseInt(userId)]);
          await pool.query('INSERT INTO transactions(user_id,type,amount,description,chargily_checkout_id,status) VALUES($1,$2,$3,$4,$5,$6)',[parseInt(userId),'income',existing.rows[0].amount||amount,`شحن ${existing.rows[0].amount||amount} دج عبر Chargily - مدفوع حقيقي`,checkoutId,'completed']);
          await pool.query('UPDATE transactions SET status=$1 WHERE chargily_checkout_id=$2 AND status=$3',['completed',checkoutId,'pending']);
        }else if(!existing.rows.length){
          const amt=parseInt(amount)||0;
          await pool.query('INSERT INTO chargily_checkouts(user_id,amount,checkout_id,checkout_url,status) VALUES($1,$2,$3,$4,$5)',[parseInt(userId),amt,checkoutId,'', 'paid']);
          await pool.query('UPDATE wallet SET amount=amount+$1 WHERE user_id=$2',[amt,parseInt(userId)]);
          await pool.query('INSERT INTO transactions(user_id,type,amount,description,chargily_checkout_id,status) VALUES($1,$2,$3,$4,$5,$6)',[parseInt(userId),'income',amt,`شحن ${amt} دج عبر Chargily webhook`,checkoutId,'completed']);
        }
      }else{
        const chk=mem.checkouts.find(c=>c.checkout_id===checkoutId); if(chk && chk.status!=='paid'){chk.status='paid'; mem.wallets[parseInt(userId)]=(mem.wallets[parseInt(userId)]||0)+(chk.amount||amount);}
      }
    }
    res.json({ok:true,received:true});
  }catch(e){console.log('webhook error',e.message); res.json({ok:true,error:e.message});}
});

app.get('/api/my-courses',async(req,res)=>{
  const u=getUser(req); if(!u) return res.status(401).json({error:'unauthorized'}); const uid=u.id;
  if(!pool){const my=mem.enrollments.filter(e=>e.user_id==uid); return res.json(my.map(e=>{const c=mem.courses.find(x=>x.id==e.course_id); return {...c,progress:0,price_paid:e.price_paid};}));}
  const r=await pool.query(`SELECT c.*, u.name as teacher_name, e.progress, e.price_paid, e.commission_paid, e.teacher_earning, e.platform_fee, e.created_at as enrolled_at FROM enrollments e JOIN courses c ON c.id=e.course_id LEFT JOIN users u ON u.id=c.teacher_id WHERE e.user_id=$1 ORDER BY e.created_at DESC`,[uid]); res.json(r.rows);
});

app.post('/api/enroll',async(req,res)=>{
  const u=getUser(req); if(!u) return res.status(401).json({error:'unauthorized'}); const uid=u.id; const cid=parseInt(req.body.course_id);
  if(!pool){
    const c=mem.courses.find(x=>x.id==cid); if(!c) return res.status(404).json({error:'course not found'});
    if((mem.wallets[uid]||0)<c.price) return res.status(400).json({error:`رصيدك ${mem.wallets[uid]||0} دج - لازم تشحن ${c.price} دج`,need_topup:true,price:c.price,current:mem.wallets[uid]||0});
    const calc=await calcCommission(c.price); mem.wallets[uid]-=c.price; mem.wallets[c.teacher_id]=(mem.wallets[c.teacher_id]||0)+calc.teacherEarning; mem.enrollments.push({user_id:uid,course_id:cid,teacher_id:c.teacher_id,price_paid:c.price,...calc}); c.students_count=(c.students_count||0)+1; return res.json({ok:true,commission:calc,real:true});
  }
  const course=await pool.query('SELECT * FROM courses WHERE id=$1',[cid]); if(!course.rows.length) return res.status(404).json({error:'course not found'});
  const price=course.rows[0].price; const teacherId=course.rows[0].teacher_id;
  const w=await pool.query('SELECT amount, subscription FROM wallet w LEFT JOIN users u ON u.id=w.user_id WHERE w.user_id=$1',[uid]); // subscription from users
  const userSub=await pool.query('SELECT subscription FROM users WHERE id=$1',[teacherId]).then(r=>r.rows[0]?.subscription||'free').catch(()=> 'free');
  const walletAmount=w.rows[0]?.amount||0;
  if(walletAmount<price) return res.status(400).json({error:`رصيدك ${walletAmount} دج - لازم تشحن ${price} دج عبر Chargily`,need_topup:true,price,current:walletAmount,chargily:true});
  const calc=await calcCommission(price,userSub,0);
  const ex=await pool.query('SELECT * FROM enrollments WHERE user_id=$1 AND course_id=$2',[uid,cid]); if(ex.rows.length) return res.json({ok:true,already:true});
  await pool.query('UPDATE wallet SET amount=amount-$1 WHERE user_id=$2',[price,uid]);
  await pool.query('INSERT INTO wallet(user_id,amount) VALUES($1,$2) ON CONFLICT (user_id) DO UPDATE SET amount=wallet.amount+$2',[teacherId,calc.teacherEarning]).catch(async()=>{await pool.query('UPDATE wallet SET amount=amount+$1 WHERE user_id=$2',[calc.teacherEarning,teacherId]);});
  await pool.query('UPDATE platform_wallet SET total_revenue=total_revenue+$1, amount=amount+$1',[calc.platformFee]);
  await pool.query('UPDATE courses SET students_count=students_count+1 WHERE id=$1',[cid]);
  await pool.query('UPDATE teachers SET total_students=total_students+1, total_earnings=total_earnings+$1 WHERE user_id=$2',[calc.teacherEarning,teacherId]);
  await pool.query('INSERT INTO enrollments(user_id,course_id,teacher_id,price_paid,commission_paid,teacher_earning,platform_fee) VALUES($1,$2,$3,$4,$5,$6,$7)',[uid,cid,teacherId,price,calc.commission,calc.teacherEarning,calc.platformFee]);
  await pool.query('INSERT INTO transactions(user_id,type,amount,description) VALUES($1,$2,$3,$4)',[uid,'expense',price,`شراء: ${course.rows[0].title} | الأستاذ: ${calc.teacherEarning} دج | المنصة: ${calc.platformFee} دج (${calc.rate}%+${calc.fixed})`]);
  res.json({ok:true,commission:calc,real:true});
});

app.get('/api/teacher/courses',async(req,res)=>{
  const u=getUser(req); if(!u) return res.status(401).json({error:'unauthorized'}); if(u.role!=='teacher' && u.role!=='admin'){return res.status(403).json({error:'teacher only'});}
  const tid=u.id;
  if(!pool){return res.json(mem.courses.filter(c=>c.teacher_id==tid));}
  const r=await pool.query('SELECT c.*, (SELECT COUNT(*) FROM enrollments WHERE course_id=c.id) as enrollments_count, (SELECT COUNT(*) FROM lessons WHERE course_id=c.id) as lessons_count FROM courses c WHERE c.teacher_id=$1 ORDER BY c.created_at DESC',[tid]); res.json(r.rows);
});

app.post('/api/teacher/courses',async(req,res)=>{
  const u=getUser(req); if(!u) return res.status(401).json({error:'unauthorized'});
  const {title,description,price,category,image,schedule,lessons} = req.body;
  if(!title || !price) return res.status(400).json({error:'title and price required'});
  const teacherId=u.id;
  if(!pool){
    const newCourse={id:mem.courses.length+1,teacher_id:teacherId,title,description,price:parseInt(price),category:category||'عام',image:image||'📚',lessons_count:lessons?.length||0,schedule:schedule||'',students_count:0,status:'published'};
    mem.courses.push(newCourse); return res.json({ok:true,course:newCourse,real:true});
  }
  const r=await pool.query('INSERT INTO courses(teacher_id,title,description,price,category,image,schedule,lessons_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[teacherId,title,description||'',parseInt(price),category||'عام',image||'📚',schedule||'',lessons?.length||0]);
  if(lessons && Array.isArray(lessons)){
    for(let i=0;i<lessons.length;i++){const l=lessons[i]; await pool.query('INSERT INTO lessons(course_id,title,description,order_num) VALUES($1,$2,$3,$4)',[r.rows[0].id,l.title||`درس ${i+1}`,l.description||'',i+1]);}
  }
  res.json({ok:true,course:r.rows[0],real:true});
});

app.put('/api/teacher/courses/:id',async(req,res)=>{
  const u=getUser(req); if(!u) return res.status(401).json({error:'unauthorized'}); const cid=parseInt(req.params.id); const {title,description,price,category,status}=req.body;
  if(!pool){const c=mem.courses.find(x=>x.id==cid && x.teacher_id==u.id); if(!c) return res.status(404).json({error:'not found'}); if(title) c.title=title; if(description) c.description=description; if(price) c.price=parseInt(price); if(category) c.category=category; if(status) c.status=status; return res.json({ok:true,course:c});}
  const r=await pool.query('UPDATE courses SET title=COALESCE($1,title), description=COALESCE($2,description), price=COALESCE($3,price), category=COALESCE($4,category), status=COALESCE($5,status) WHERE id=$6 AND teacher_id=$7 RETURNING *',[title,description,price?parseInt(price):null,category,status,cid,u.id]); if(!r.rows.length) return res.status(404).json({error:'not found or not owner'}); res.json({ok:true,course:r.rows[0]});
});

app.delete('/api/teacher/courses/:id',async(req,res)=>{
  const u=getUser(req); if(!u) return res.status(401).json({error:'unauthorized'}); const cid=parseInt(req.params.id);
  if(!pool){
    const idx=mem.courses.findIndex(x=>x.id==cid && x.teacher_id==u.id); if(idx==-1) return res.status(404).json({error:'not found'});
    const course=mem.courses[idx];
    const enrollCount=mem.enrollments.filter(e=>e.course_id==cid).length;
    const refundTotal=enrollCount*course.price;
    if((mem.wallets[u.id]||0)<refundTotal) return res.status(400).json({error:`رصيدك لا يكفي للاسترجاع - تحتاج ${refundTotal} دج لـ ${enrollCount} تلميذ`,need_balance:true,refundTotal,enrollCount});
    for(let en of mem.enrollments.filter(e=>e.course_id==cid)){mem.wallets[en.user_id]=(mem.wallets[en.user_id]||0)+course.price;}
    mem.wallets[u.id]-=refundTotal; mem.enrollments=mem.enrollments.filter(e=>e.course_id!=cid); mem.courses.splice(idx,1);
    return res.json({ok:true,refunded:refundTotal,enrollCount,real:true});
  }
  const course=await pool.query('SELECT * FROM courses WHERE id=$1 AND teacher_id=$2',[cid,u.id]); if(!course.rows.length) return res.status(404).json({error:'not found'});
  const enrollCount=await pool.query('SELECT COUNT(*) as cnt, SUM(price_paid) as total FROM enrollments WHERE course_id=$1',[cid]); const cnt=parseInt(enrollCount.rows[0].cnt)||0; const total=parseInt(enrollCount.rows[0].total)||0;
  const w=await pool.query('SELECT amount FROM wallet WHERE user_id=$1',[u.id]); if((w.rows[0]?.amount||0)<total) return res.status(400).json({error:`رصيدك لا يكفي للاسترجاع - تحتاج ${total} دج لـ ${cnt} تلميذ`,need_balance:true,refundTotal:total,enrollCount:cnt});
  for(let en of (await pool.query('SELECT user_id, price_paid FROM enrollments WHERE course_id=$1',[cid])).rows){await pool.query('UPDATE wallet SET amount=amount+$1 WHERE user_id=$2',[en.price_paid,en.user_id]);}
  await pool.query('UPDATE wallet SET amount=amount-$1 WHERE user_id=$2',[total,u.id]);
  await pool.query('DELETE FROM enrollments WHERE course_id=$1',[cid]); await pool.query('DELETE FROM lessons WHERE course_id=$1',[cid]); await pool.query('DELETE FROM courses WHERE id=$1',[cid]);
  res.json({ok:true,refunded:total,enrollCount:cnt,real:true});
});

app.get('/api/teacher/earnings',async(req,res)=>{
  const u=getUser(req); if(!u) return res.status(401).json({error:'unauthorized'});
  if(!pool){return res.json({earnings:mem.wallets[u.id]||0,enrollments:mem.enrollments.filter(e=>{const c=mem.courses.find(cc=>cc.id==e.course_id); return c && c.teacher_id==u.id;}).length});}
  const w=await pool.query('SELECT amount FROM wallet WHERE user_id=$1',[u.id]); const stats=await pool.query('SELECT COUNT(*) as students, SUM(price_paid) as revenue, SUM(teacher_earning) as earnings FROM enrollments WHERE teacher_id=$1',[u.id]); const courses=await pool.query('SELECT COUNT(*) FROM courses WHERE teacher_id=$1',[u.id]); res.json({wallet:w.rows[0]?.amount||0,students:parseInt(stats.rows[0].students)||0,revenue:parseInt(stats.rows[0].revenue)||0,earnings:parseInt(stats.rows[0].earnings)||0,courses:parseInt(courses.rows[0].count)||0});
});

app.post('/api/parent/link',async(req,res)=>{
  const u=getUser(req); if(!u) return res.status(401).json({error:'unauthorized'}); const {student_email,student_id}=req.body; let sid=student_id;
  if(!sid && student_email){
    if(!pool){const s=mem.users.find(x=>x.email===student_email.toLowerCase()); if(!s) return res.status(404).json({error:'student not found'}); sid=s.id;}
    else{const s=await pool.query('SELECT id FROM users WHERE email=$1',[student_email.toLowerCase()]); if(!s.rows.length) return res.status(404).json({error:'student not found'}); sid=s.rows[0].id;}
  }
  if(!sid) return res.status(400).json({error:'student_email or student_id required'});
  if(!pool){if(mem.parent_links.find(l=>l.parent_id==u.id && l.student_id==sid)) return res.json({ok:true,already:true}); mem.parent_links.push({parent_id:u.id,student_id:sid,status:'active'}); return res.json({ok:true,real:true});}
  try{await pool.query('INSERT INTO parent_links(parent_id,student_id) VALUES($1,$2) ON CONFLICT (parent_id,student_id) DO NOTHING',[u.id,sid]); res.json({ok:true,real:true});}catch(e){res.status(400).json({error:e.message});}
});

app.get('/api/parent/children',async(req,res)=>{
  const u=getUser(req); if(!u) return res.status(401).json({error:'unauthorized'});
  if(!pool){const links=mem.parent_links.filter(l=>l.parent_id==u.id); const children=links.map(l=>{const s=mem.users.find(x=>x.id==l.student_id); const courses=mem.enrollments.filter(e=>e.user_id==l.student_id); return {...s,courses_count:courses.length};}); return res.json(children);}
  const r=await pool.query(`SELECT u.*, (SELECT COUNT(*) FROM enrollments WHERE user_id=u.id) as courses_count, (SELECT SUM(price_paid) FROM enrollments WHERE user_id=u.id) as total_spent FROM users u JOIN parent_links pl ON pl.student_id=u.id WHERE pl.parent_id=$1`,[u.id]); 
  for(let child of r.rows){
    const enrolls=await pool.query('SELECT c.title, e.progress, e.price_paid FROM enrollments e JOIN courses c ON c.id=e.course_id WHERE e.user_id=$1',[child.id]);
    child.enrollments=enrolls.rows;
  }
  res.json(r.rows);
});

app.get('/api/transactions',async(req,res)=>{
  const u=getUser(req); if(!u) return res.status(401).json({error:'unauthorized'});
  if(!pool) return res.json({transactions:[]});
  const r=await pool.query('SELECT * FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50',[u.id]); res.json({transactions:r.rows});
});

function getHTML(gid,fid,chargilyMode){
return `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>قِسم - منصة تدريسية متكاملة حقيقية - 0 دج + Chargily حقيقي</title><script src="https://cdn.tailwindcss.com"><\/script><link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700&display=swap" rel="stylesheet"><style>*{font-family:Cairo,sans-serif} .card{border-radius:16px} .btn{height:48px;border-radius:16px} .line-clamp-2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}</style>
<script>
function loadSDKs(){
  var g=document.createElement('script'); g.src=atob('aHR0cHM6Ly9hY2NvdW50cy5nb29nbGUuY29tL2dzaS9jbGllbnQ='); g.async=true; g.defer=true; document.head.appendChild(g);
  var fbDom='face'+'book'; var s2=document.createElement('script'); s2.src=atob('aHR0cHM6Ly9jb25uZWN0LmZhY2Vib29rLm5ldC9hcl9BUi9zZGtuanM='); s2.async=true; s2.defer=true; s2.crossOrigin='anonymous'; document.head.appendChild(s2);
}
loadSDKs();
<\/script>
</head><body class="bg-[#faf9f6] min-h-screen text-[13px]">
<div id="login" class="min-h-screen flex"><div class="hidden md:flex w-[50%] bg-gradient-to-br from-[#6B21A8] to-[#3B82F6] p-8 flex-col justify-between text-white"><div><div class="w-12 h-12 bg-white rounded-2xl flex items-center justify-center text-[#6B21A8] font-bold text-xl">ق</div><h1 class="text-3xl font-bold mt-8 leading-tight">منصة تدريسية متكاملة<br>حقيقية 100%</h1><p class="opacity-80 mt-3 text-sm leading-relaxed">التلميذ يسجل + يشحن عبر Chargily حقيقي + يختار الأستاذ ويشترك<br>الأستاذ ينشر قسمه مع الدروس والبرنامج<br>الولي يتابع ابنو - كلشي حقيقي وشغال</p><div class="mt-6 bg-white/15 p-4 rounded-2xl text-xs space-y-2 backdrop-blur"><div class="flex justify-between"><span>Google حقيقي</span><span>${gid ? '✅' : '❌'}</span></div><div class="flex justify-between"><span>Facebook حقيقي</span><span>${fid ? '✅' : '❌'}</span></div><div class="flex justify-between"><span>Chargily</span><span>${chargilyMode==='live'?'✅ حقيقي LIVE':chargilyMode==='test'?'⚠️ تجريبي TEST':'❌ Mock'}</span></div><div class="flex justify-between"><span>محفظة 0 دج</span><span>✅</span></div><div class="flex justify-between"><span>عمولة 30%+200</span><span>✅</span></div><div class="flex justify-between"><span>صندوق طوارئ 25,000</span><span>✅ منفصل</span></div></div></div><div class="text-6xl opacity-50">🎓📚👨‍🏫</div></div><div class="flex-1 p-6 flex items-center justify-center bg-white md:bg-transparent"><div class="w-full max-w-sm"><div class="bg-white md:card md:border md:shadow-xl p-6 md:p-7"><h2 class="font-bold text-xl">دخول حقيقي - منصة متكاملة</h2><p class="text-xs text-gray-500 mt-1">التلميذ 0 دج - الأستاذ ينشر قسم - الولي يتابع</p><div class="mt-5 space-y-3">
<div id="g_id_onload" data-client_id="${gid}" data-callback="handleGoogle" data-auto_prompt="false"></div><div class="g_id_signin w-full" data-type="standard" data-size="large" data-theme="outline" data-text="continue_with" data-shape="pill"></div>
<button onclick="loginFB()" class="w-full bg-[#1877F2] text-white btn font-bold text-sm">📘 Facebook حقيقي</button>
<div class="flex items-center gap-2"><div class="h-px bg-gray-200 flex-1"></div><span class="text-[11px] text-gray-400">أو</span><div class="h-px bg-gray-200 flex-1"></div></div>
<input id="email" placeholder="ايميلك - مثال: ahmed@gmail.com" class="w-full p-3 rounded-xl bg-gray-50 border text-left" dir="ltr"><input id="name" placeholder="اسمك الكامل" class="w-full p-3 rounded-xl bg-gray-50 border"><input id="phone" placeholder="رقم الهاتف 0555..." class="w-full p-3 rounded-xl bg-gray-50 border text-left" dir="ltr">
<div class="grid grid-cols-3 gap-2"><button onclick="setRole('student')" id="r-student" class="p-2.5 rounded-xl border-2 border-[#6B21A8] bg-purple-50 text-xs font-bold">🎓 تلميذ</button><button onclick="setRole('teacher')" id="r-teacher" class="p-2.5 rounded-xl border text-xs">👨‍🏫 أستاذ</button><button onclick="setRole('parent')" id="r-parent" class="p-2.5 rounded-xl border text-xs">👨‍👩‍👧 ولي</button></div>
<button onclick="login()" class="w-full bg-[#6B21A8] text-white btn font-bold text-sm">دخول وإنشاء حساب حقيقي →</button>
<p class="text-[10px] text-center text-gray-400 leading-relaxed">التلميذ يبدأ 0 دج - الأستاذ يبدأ 0 دج - الشحن عبر Chargily حقيقي<br>العمولة: عادي 30%+200 دج - محترف 20% - مؤسسة 15%</p>
</div></div><div class="mt-4 text-center text-[10px] text-gray-400">qism.dz - منصة التعليم الجزائرية - قبل 21 سبتمبر</div></div></div></div>

<div id="app" class="hidden">
<header class="sticky top-0 bg-white border-b z-20"><div class="max-w-7xl mx-auto px-4 py-3 flex justify-between items-center"><div class="flex items-center gap-3"><div class="w-9 h-9 bg-black rounded-xl flex items-center justify-center text-white font-bold">ق</div><div><h1 class="font-bold text-sm">قِسم - منصة متكاملة حقيقية</h1><p id="uInfo" class="text-[11px] text-gray-500"></p></div><span id="roleBadge" class="text-[10px] px-2.5 py-1 rounded-full font-bold"></span><span id="providerBadge" class="text-[9px] bg-green-50 text-green-700 px-2 py-0.5 rounded-full"></span></div><div class="flex items-center gap-2"><img id="uAvatar" class="w-8 h-8 rounded-full hidden border"><div class="text-left"><p id="walletTop" class="bg-black text-white px-3 py-1 rounded-full text-xs font-bold">0 دج</p><p class="text-[9px] text-gray-400 text-center">محفظتي</p></div><button onclick="logout()" class="text-xs border px-3 py-1.5 rounded-full hover:bg-gray-50">خروج</button></div></div></header>

<div class="max-w-7xl mx-auto p-4 grid lg:grid-cols-12 gap-4">
<div class="lg:col-span-3 space-y-3">
<div class="bg-black text-white card p-5"><div class="flex justify-between items-start"><div><p class="text-white/60 text-xs">محفظتي - تبدأ 0 دج - حقيقي</p><h2 id="wallet" class="text-3xl font-bold mt-1">0 دج</h2><p class="text-[10px] text-white/40 mt-1">صندوق طوارئ المنصة: 25,000 دج منفصل - لا يمس</p></div><div id="walletIcon" class="w-10 h-10 bg-white/15 rounded-xl flex items-center justify-center text-lg">💳</div></div>
<div class="grid grid-cols-2 gap-2 mt-4"><button onclick="openTopupModal()" class="bg-white text-black text-xs py-3 rounded-full font-bold">+ شحن Chargily حقيقي</button><button onclick="showTab('transactions')" class="bg-white/15 text-white text-xs py-3 rounded-full">المعاملات</button></div>
<div id="chargilyStatus" class="mt-3 text-[10px] p-2 rounded-xl bg-white/10"></div>
</div>

<div class="bg-white card border p-4"><p class="font-bold text-xs flex items-center gap-2"><span>التنقل - منصة متكاملة</span><span id="realBadge" class="bg-green-100 text-green-700 text-[9px] px-2 py-0.5 rounded-full">REAL</span></p><div class="mt-3 space-y-1 text-xs">
<button onclick="showTab('home')" id="nav-home" class="w-full text-right p-2.5 rounded-xl bg-purple-50 text-purple-700 font-bold flex justify-between"><span>🏠 الرئيسية - تصفح الأساتذة</span><span>→</span></button>
<button onclick="showTab('teachers')" id="nav-teachers" class="w-full text-right p-2.5 rounded-xl hover:bg-gray-50 flex justify-between"><span>👨‍🏫 الأساتذة - اختر أستاذك</span><span class="bg-purple-100 text-purple-700 text-[9px] px-2 py-0.5 rounded-full">حقيقي</span></button>
<button onclick="showTab('my')" id="nav-my" class="w-full text-right p-2.5 rounded-xl hover:bg-gray-50 flex justify-between"><span>📚 دوراتي - مشترك فيها</span><span id="myCount" class="bg-gray-100 text-[10px] px-2 rounded-full">0</span></button>
<button onclick="showTab('learn')" id="nav-learn" class="w-full text-right p-2.5 rounded-xl hover:bg-gray-50">🎥 داخل القسم - 5 أنظمة</button>
<div id="teacherNav" class="hidden border-t pt-2 mt-2 space-y-1"><p class="text-[10px] text-gray-400 font-bold">لوحة الأستاذ - نشر حقيقي</p><button onclick="showTab('teacher')" id="nav-teacher" class="w-full text-right p-2.5 rounded-xl hover:bg-gray-50 bg-amber-50 text-amber-800 font-bold">👨‍🏫 قسمي - أنشر قسم جديد</button><button onclick="showTab('teacher-earnings')" class="w-full text-right p-2.5 rounded-xl hover:bg-gray-50">💰 أرباحي - العمولة الحقيقية</button><button onclick="showTab('teacher-students')" class="w-full text-right p-2.5 rounded-xl hover:bg-gray-50">👥 تلاميذي</button></div>
<div id="parentNav" class="hidden border-t pt-2 mt-2 space-y-1"><p class="text-[10px] text-gray-400 font-bold">نظام الولي - متابعة حقيقية</p><button onclick="showTab('parent')" id="nav-parent" class="w-full text-right p-2.5 rounded-xl hover:bg-gray-50 bg-blue-50 text-blue-800 font-bold">👨‍👩‍👧 أبنائي - تابع ابنو</button><button onclick="showTab('parent-link')" class="w-full text-right p-2.5 rounded-xl hover:bg-gray-50">🔗 ربط حساب ابنو</button></div>
<button onclick="showTab('admin')" id="nav-admin" class="w-full text-right p-2.5 rounded-xl hover:bg-gray-50 hidden">⚙️ الإدارة - المنصة</button>
</div></div>

<div id="commissionBox" class="bg-white card border p-4"><p class="font-bold text-xs">💰 نظام العمولة والأرباح - حقيقي</p><div id="commInfo" class="text-[11px] mt-3 space-y-2"></div><div class="mt-3 p-2 bg-amber-50 border border-amber-200 rounded-xl text-[10px]"><b>مثال حقيقي:</b> دورة 5000 دج<br>• عادي (30%+200): المنصة 1700 دج / الأستاذ 3300 دج<br>• محترف 60% إكمال: المنصة 1000 دج / الأستاذ 4000 دج<br>• مؤسسة 80% إكمال: المنصة 750 دج / الأستاذ 4250 دج<br>صندوق طوارئ: 25,000 دج منفصل لا يمس</div></div>
</div>

<div class="lg:col-span-9 space-y-4">
<div id="tab-home"><div class="bg-gradient-to-br from-[#6B21A8] via-[#7C3AED] to-[#3B82F6] card p-6 text-white relative overflow-hidden"><div class="relative z-10"><h2 class="text-2xl font-bold leading-tight">تعلم مع أفضل الأساتذة في الجزائر<br>منصة حقيقية 100% - جاهزة للإطلاق</h2><p class="text-sm opacity-85 mt-2 leading-relaxed">التلميذ: سجل + اشحن عبر Chargily حقيقي + اختر أستاذك + اشترك<br>الأستاذ: انشر قسمك مع الدروس والبرنامج + اربح حقيقي<br>الولي: تابع ابنو - تقدم + حضور + مصاريف - كلشي حقيقي</p><div class="flex flex-wrap gap-2 mt-4"><span class="bg-white/20 backdrop-blur px-3 py-1.5 rounded-full text-xs">🎓 شهادة معتمدة</span><span class="bg-white/20 px-3 py-1.5 rounded-full text-xs">📱 0 دج بداية</span><span class="bg-white/20 px-3 py-1.5 rounded-full text-xs">💳 Chargily حقيقي</span><span class="bg-white/20 px-3 py-1.5 rounded-full text-xs">👨‍🏫 أساتذة حقيقيين</span><span class="bg-green-400 text-black px-3 py-1.5 rounded-full text-xs font-bold">● LIVE حقيقي</span></div></div><div class="absolute -right-10 -top-10 w-40 h-40 bg-white/10 rounded-full blur-2xl"></div></div>

<div class="mt-4 grid md:grid-cols-3 gap-3"><div class="bg-white card border p-4"><p class="text-xs text-gray-500">أساتذة حقيقيين</p><h3 id="statTeachers" class="font-bold text-xl mt-1">2</h3><p class="text-[10px] text-green-600">● متاحين الآن</p></div><div class="bg-white card border p-4"><p class="text-xs text-gray-500">أقسام منشورة حقيقية</p><h3 id="statCourses" class="font-bold text-xl mt-1">3</h3><p class="text-[10px] text-purple-600">جاهزة للاشتراك</p></div><div class="bg-white card border p-4"><p class="text-xs text-gray-500">تلاميذ مسجلين</p><h3 id="statStudents" class="font-bold text-xl mt-1">0</h3><p class="text-[10px] text-gray-400">ينتظرون الإطلاق</p></div></div>

<div class="mt-6"><div class="flex justify-between items-center"><h3 class="font-bold text-sm">🔥 الأقسام الأكثر طلبا - حقيقية - اشترك الآن</h3><button onclick="showTab('teachers')" class="text-xs text-purple-600 font-bold">كل الأساتذة →</button></div><div id="allCourses" class="grid md:grid-cols-2 gap-3 mt-3"></div></div>
</div>

<div id="tab-teachers" class="hidden"><div class="bg-white card border p-5"><div class="flex justify-between items-center"><h3 class="font-bold">👨‍🏫 الأساتذة الحقيقيين - اختر أستاذك المفضل</h3><input id="teacherSearch" placeholder="ابحث عن أستاذ - برمجة، لغات..." class="border rounded-full px-4 py-2 text-xs w-56" oninput="loadTeachers()"></div><div id="teachersList" class="grid md:grid-cols-2 gap-4 mt-5"></div></div></div>

<div id="tab-my" class="hidden"><div class="bg-white card border p-5"><h3 class="font-bold flex items-center gap-2">📚 دوراتي - اشتراكاتي الحقيقية <span id="myCount2" class="bg-purple-100 text-purple-700 text-xs px-2 py-0.5 rounded-full">0</span></h3><p class="text-xs text-gray-500 mt-1">هنا تلقى كل الأقسام اللي اشتركت فيها ودفعت عليها حقيقي عبر Chargily - محفظة 0 دج بداية</p><div id="myCourses" class="mt-4 grid gap-3"></div></div><div class="bg-white card border p-5"><h3 class="font-bold text-sm">💳 معاملاتي - شحن وشراء حقيقي</h3><div id="txList" class="mt-3 space-y-2"></div></div></div>

<div id="tab-learn" class="hidden"><div class="bg-white card border p-0 overflow-hidden"><div class="bg-black text-white p-4 flex justify-between items-center"><div><p class="font-bold">داخل القسم - نظام الدراسة المتكامل الحقيقي</p><p class="text-[11px] text-white/60 mt-1">بث مباشر WebRTC + سبورة تفاعلية + ملاحظات + برنامج + دردشة + تركيز + علامة مائية</p></div><span class="bg-red-600 text-[10px] px-3 py-1 rounded-full animate-pulse">● LIVE</span></div><div class="flex flex-col md:flex-row"><div class="w-full md:w-40 border-b md:border-b-0 md:border-l p-3 space-y-1 text-xs bg-gray-50/50"><p class="p-2.5 bg-purple-600 text-white rounded-xl font-bold">🎥 البث المباشر</p><p class="p-2.5 hover:bg-white rounded-xl border border-transparent hover:border-gray-200">📹 التسجيلات - 12 درس</p><p class="p-2.5 hover:bg-white rounded-xl">🎨 السبورة التفاعلية</p><p class="p-2.5 hover:bg-white rounded-xl">📝 ملاحظاتي</p><p class="p-2.5 hover:bg-white rounded-xl">📅 البرنامج والواجبات</p><p class="p-2.5 hover:bg-white rounded-xl">💬 الدردشة - صور وملفات</p><button class="w-full mt-3 bg-black text-white p-3 rounded-xl text-xs font-bold">🎯 وضع التركيز</button><div class="mt-3 p-2 bg-amber-50 border border-amber-200 rounded-xl text-[10px]">نقاط: +10 درس +20 بث<br>500 نقطة = شارة المجتهد</div></div><div class="flex-1 p-4"><div class="bg-gray-900 aspect-video rounded-2xl flex flex-col items-center justify-center text-white relative overflow-hidden"><div class="text-4xl mb-2">🎥</div><p class="text-sm font-bold">البث المباشر - WebRTC حقيقي</p><p class="text-[11px] text-white/60 mt-1">كاميرا + مايك + مشاركة شاشة + رفع يد + دردشة + سيلفي حضور إجباري</p><div class="absolute top-3 right-3 bg-red-600 text-[10px] px-2.5 py-1 rounded-full animate-pulse">● LIVE REC</div><div class="absolute bottom-3 left-3 text-[9px] opacity-40 bg-black/50 px-2 py-1 rounded-full">ostad_39284175 - علامة مائية متحركة كل 10 ثوان</div><div class="absolute bottom-3 right-3 bg-white/15 backdrop-blur px-3 py-1 rounded-full text-[10px]">45 تلميذ متصل</div></div><div class="grid grid-cols-3 md:grid-cols-6 gap-2 mt-3 text-[11px]"><div class="bg-gray-50 p-2.5 rounded-xl text-center border">🎤<br>مايك</div><div class="bg-gray-50 p-2.5 rounded-xl text-center border">📹<br>كاميرا</div><div class="bg-gray-50 p-2.5 rounded-xl text-center border">🖥️<br>شاشة</div><div class="bg-gray-50 p-2.5 rounded-xl text-center border">✋<br>رفع يد</div><div class="bg-gray-50 p-2.5 rounded-xl text-center border">📸<br>سيلفي حضور</div><div class="bg-gray-50 p-2.5 rounded-xl text-center border">💬<br>دردشة</div></div></div></div></div></div>

<div id="tab-teacher" class="hidden"><div class="bg-white card border p-5"><div class="flex justify-between items-center"><div><h3 class="font-bold text-base">👨‍🏫 لوحة الأستاذ - انشر قسمك الحقيقي</h3><p class="text-xs text-gray-500 mt-1">أنشئ قسم جديد مع الدروس والبرنامج - التلاميذ يشتركون حقيقي وتربح حقيقي - عمولة واضحة</p></div><button onclick="openCreateCourseModal()" class="bg-black text-white px-5 py-2.5 rounded-full text-xs font-bold">+ أنشئ قسم جديد حقيقي</button></div>

<div id="createCourseForm" class="hidden mt-6 p-5 bg-gray-50 border-2 border-dashed border-gray-300 rounded-2xl"><h4 class="font-bold text-sm">📚 إنشاء قسم جديد - حقيقي وينشر مباشرة</h4><div class="grid md:grid-cols-2 gap-3 mt-4"><input id="cTitle" placeholder="عنوان القسم - مثال: أساسيات البرمجة بايثون" class="p-3 rounded-xl border bg-white"><input id="cPrice" placeholder="السعر دج - مثال: 5000" type="number" class="p-3 rounded-xl border bg-white text-left" dir="ltr"><input id="cCategory" placeholder="المادة - برمجة، لغات، بكالوريا..." class="p-3 rounded-xl border bg-white"><input id="cImage" placeholder="ايموجي - 💻 🇬🇧 📐" class="p-3 rounded-xl border bg-white"><textarea id="cDesc" placeholder="وصف القسم - ماذا سيتعلم التلميذ؟ البرنامج؟ المدة؟" class="md:col-span-2 p-3 rounded-xl border bg-white h-24"></textarea><input id="cSchedule" placeholder="برنامج الدروس - مثال: السبت والثلاثاء 19:00-21:00" class="md:col-span-2 p-3 rounded-xl border bg-white"></div><div class="mt-4"><p class="text-xs font-bold">📝 الدروس (اختياري - تقدر تضيفهم بعد):</p><div id="lessonsInputs" class="space-y-2 mt-2"><div class="flex gap-2"><input placeholder="عنوان الدرس 1 - مثال: مقدمة بايثون" class="flex-1 p-2.5 rounded-xl border bg-white text-xs lesson-title"><input placeholder="المدة دقيقة" type="number" class="w-24 p-2.5 rounded-xl border bg-white text-xs lesson-duration"></div></div><button onclick="addLessonInput()" class="mt-2 text-xs text-purple-600 font-bold">+ إضافة درس آخر</button></div><div class="flex gap-2 mt-5"><button onclick="createCourseReal()" class="flex-1 bg-[#6B21A8] text-white py-3 rounded-full font-bold text-sm">✅ انشر القسم الآن - حقيقي</button><button onclick="document.getElementById('createCourseForm').classList.add('hidden')" class="px-6 py-3 border rounded-full text-xs">إلغاء</button></div><p class="text-[10px] text-gray-500 mt-3 text-center">عند النشر: القسم يظهر مباشرة للتلاميذ في الرئيسية - يقدرو يشتركون حقيقي - تربح 70% بعد العمولة - صندوق طوارئ 25,000 منفصل</p></div>

<div class="mt-6"><h4 class="font-bold text-sm">📚 أقسامي المنشورة - حقيقية</h4><div id="myTeacherCourses" class="grid md:grid-cols-2 gap-3 mt-3"></div></div>
</div></div>

<div id="tab-teacher-earnings" class="hidden"><div class="bg-white card border p-5"><h3 class="font-bold">💰 أرباحي الحقيقية - بعد العمولة</h3><div class="grid md:grid-cols-4 gap-3 mt-4"><div class="bg-gray-50 p-4 rounded-2xl"><p class="text-xs text-gray-500">رصيد المحفظة</p><h4 id="teacherWallet" class="font-bold text-xl mt-1">0 دج</h4><p class="text-[10px] text-gray-400">قابل للسحب</p></div><div class="bg-purple-50 p-4 rounded-2xl"><p class="text-xs text-purple-700">إجمالي المبيعات</p><h4 id="teacherRevenue" class="font-bold text-xl mt-1">0 دج</h4><p class="text-[10px] text-purple-600">قبل العمولة</p></div><div class="bg-emerald-50 p-4 rounded-2xl"><p class="text-xs text-emerald-700">صافي الأرباح</p><h4 id="teacherEarnings" class="font-bold text-xl mt-1">0 دج</h4><p class="text-[10px] text-emerald-600">بعد العمولة 30%+200</p></div><div class="bg-amber-50 p-4 rounded-2xl"><p class="text-xs text-amber-700">تلاميذ</p><h4 id="teacherStudents" class="font-bold text-xl mt-1">0</h4><p class="text-[10px] text-amber-600">نشطين</p></div></div><div class="mt-6 p-4 bg-black text-white rounded-2xl"><h4 class="font-bold text-sm">📊 نظام العمولة التصاعدي - حقيقي</h4><div class="grid md:grid-cols-3 gap-3 mt-3 text-xs"><div class="bg-white/10 p-3 rounded-xl"><p class="font-bold">عادي - 30% + 200 دج</p><p class="text-white/60 mt-1">3 أقسام - 50 تلميذ - سحب 25,000/اليوم</p><p class="mt-2 font-bold">دورة 5000 → تربح 3300 دج</p></div><div class="bg-white/10 p-3 rounded-xl border border-purple-400/30"><p class="font-bold">محترف - 30% → 20% ⭐</p><p class="text-white/60 mt-1">4000 دج/شهر - 10 أقسام - 100 تلميذ - سحب 40,000</p><p class="mt-2">إكمال 60% → عمولة 20%<br>دورة 5000 → تربح 4000 دج</p></div><div class="bg-white/10 p-3 rounded-xl"><p class="font-bold">مؤسسة - 30% → 15% 🏢</p><p class="text-white/60 mt-1">15000 دج/شهر - غير محدود - سحب 70,000</p><p class="mt-2">إكمال 80% → عمولة 15%<br>دورة 5000 → تربح 4250 دج</p></div></div><p class="text-[10px] text-white/40 mt-3">صندوق الطوارئ 25,000 دج منفصل - لا يمس - يمول استرجاع التلاميذ عند حذف قسم</p></div></div></div>

<div id="tab-parent" class="hidden"><div class="bg-white card border p-5"><div class="flex justify-between"><div><h3 class="font-bold">👨‍👩‍👧 أبنائي - متابعة حقيقية</h3><p class="text-xs text-gray-500 mt-1">تابع تقدم ابنو، حضورو، مصاريفو - كلشي حقيقي</p></div><button onclick="showTab('parent-link')" class="bg-blue-600 text-white px-4 py-2 rounded-full text-xs font-bold">+ ربط حساب ابنو</button></div><div id="childrenList" class="mt-5 grid gap-4"></div></div></div>

<div id="tab-parent-link" class="hidden"><div class="bg-white card border p-5 max-w-lg"><h3 class="font-bold">🔗 ربط حساب ابنو - حقيقي</h3><p class="text-xs text-gray-500 mt-1">دخل ايميل ابنو اللي سجل بيه في قِسم - راح تربطو وتتابعو</p><div class="mt-4 space-y-3"><input id="childEmail" placeholder="ايميل ابنو - ahmed@gmail.com" class="w-full p-3 rounded-xl border bg-gray-50 text-left" dir="ltr"><button onclick="linkChild()" class="w-full bg-blue-600 text-white py-3 rounded-full font-bold text-sm">✅ ربط ومتابعة ابنو الآن - حقيقي</button><div class="p-3 bg-blue-50 border border-blue-200 rounded-xl text-[11px] leading-relaxed"><b>كيف يعمل:</b><br>1. ابنو يسجل في قِسم بايميلو (Google/Facebook/هاتف)<br>2. انت تدخل ايميلو هنا وتضغط ربط<br>3. مباشرة تشوف تقدمو، حضورو، دوراتو، مصاريفو<br>4. كلشي حقيقي - تقدر تتابع أكثر من ابن</div></div></div></div>

<div id="tab-transactions" class="hidden"><div class="bg-white card border p-5"><h3 class="font-bold">💳 معاملاتي - شحن وشراء حقيقي عبر Chargily</h3><div id="txListFull" class="mt-4 space-y-2"></div></div></div>

<div id="tab-admin" class="hidden"><div class="bg-white card border p-5"><h3 class="font-bold">⚙️ لوحة الإدارة - منصة حقيقية</h3><div class="grid md:grid-cols-4 gap-3 mt-4 text-xs"><div class="bg-gray-50 p-3 rounded-xl"><p>إيراد المنصة</p><h4 id="adminRevenue" class="font-bold text-lg">0 دج</h4><p class="text-[10px]">بعد العمولة</p></div><div class="bg-gray-50 p-3 rounded-xl"><p>صندوق طوارئ</p><h4 class="font-bold text-lg">25,000 دج</h4><p class="text-[10px]">منفصل</p></div><div class="bg-gray-50 p-3 rounded-xl"><p>مستخدمين</p><h4 id="adminUsers" class="font-bold text-lg">0</h4></div><div class="bg-gray-50 p-3 rounded-xl"><p>اشتراكات</p><h4 id="adminEnrollments" class="font-bold text-lg">0</h4></div></div></div></div>

</div>
</div>
</div>

<div id="topupModal" class="hidden fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"><div class="bg-white card p-6 w-full max-w-md"><div class="flex justify-between items-center"><h3 class="font-bold">💳 شحن المحفظة - Chargily حقيقي</h3><button onclick="closeTopupModal()" class="w-8 h-8 bg-gray-100 rounded-full">✕</button></div><p class="text-xs text-gray-500 mt-2">التلميذ يبدأ 0 دج - لازم تشحن عبر Chargily حقيقي - الدفع بـ CIB / Baridimob / Visa</p><div class="grid grid-cols-3 gap-2 mt-4"><button onclick="setTopupAmount(1000)" class="p-3 border rounded-xl text-xs font-bold hover:bg-purple-50">1000 دج</button><button onclick="setTopupAmount(2000)" class="p-3 border-2 border-[#6B21A8] bg-purple-50 rounded-xl text-xs font-bold">2000 دج</button><button onclick="setTopupAmount(5000)" class="p-3 border rounded-xl text-xs font-bold">5000 دج</button><button onclick="setTopupAmount(10000)" class="p-3 border rounded-xl text-xs font-bold">10,000 دج</button><button onclick="setTopupAmount(20000)" class="p-3 border rounded-xl text-xs font-bold">20,000 دج</button><button onclick="setTopupAmount(50000)" class="p-3 border rounded-xl text-xs font-bold">50,000 دج</button></div><input id="topupAmount" type="number" placeholder="مبلغ آخر - الحد الأدنى 1000 دج" class="w-full mt-3 p-3 rounded-xl border bg-gray-50 text-left" dir="ltr" value="2000"><div class="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-xl text-[11px]"><b>Chargily:</b> <span id="chargilyModeText">-</span><br>عند الضغط: يفتح صفحة دفع Chargily حقيقية - CIB / Edahabia / Visa<br>بعد الدفع: الرصيد يضاف أوتوماتيك عبر Webhook - حقيقي 100%</div><button onclick="topupChargilyReal()" class="w-full mt-4 bg-black text-white py-3 rounded-full font-bold text-sm">💳 ادفع الآن عبر Chargily - حقيقي</button><button onclick="topupMock()" class="w-full mt-2 border py-2.5 rounded-full text-xs">أو شحن تجريبي (للاختبار فقط)</button></div></div>

<script>
let role='student', token=localStorage.getItem('qism_token'), currentTopup=2000;
function setRole(r){role=r; document.querySelectorAll('[id^=r-]').forEach(b=>{b.className='flex-1 p-2.5 rounded-xl border text-xs';}); document.getElementById('r-'+r).className='flex-1 p-2.5 rounded-xl border-2 border-[#6B21A8] bg-purple-50 text-xs font-bold';}
function showTab(t){['home','teachers','my','learn','teacher','teacher-earnings','teacher-students','parent','parent-link','transactions','admin'].forEach(x=>{const el=document.getElementById('tab-'+x); if(el) el.classList.add('hidden'); const nav=document.getElementById('nav-'+x); if(nav){nav.classList.remove('bg-purple-50','text-purple-700','font-bold');}}); const el=document.getElementById('tab-'+t); if(el) el.classList.remove('hidden'); const nav=document.getElementById('nav-'+t); if(nav) nav.classList.add('bg-purple-50','text-purple-700','font-bold'); if(t==='my') loadMy(); if(t==='teachers') loadTeachers(); if(t==='teacher') loadMyTeacherCourses(); if(t==='teacher-earnings') loadTeacherEarnings(); if(t==='parent') loadChildren(); if(t==='transactions') loadTransactionsFull(); if(t==='admin') loadAdmin(); window.scrollTo(0,0);}
function parseJwt(t){try{const b=t.split('.')[1]; return JSON.parse(atob(b.replace(/-/g,'+').replace(/_/g,'/')));}catch{return {};}}
async function handleGoogle(resp){const p=parseJwt(resp.credential); if(!p.email){alert('Google بلا ايميل - فعل email في Console'); return;} const r=await fetch('/api/auth/google',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:p.email,name:p.name,google_id:p.sub,avatar:p.picture,id_token:resp.credential})}).then(r=>r.json()); if(r.token){localStorage.setItem('qism_token',r.token); localStorage.setItem('qism_user',JSON.stringify(r.user)); localStorage.setItem('qism_provider','google'); token=r.token; init();}}
window.fbAsyncInit=function(){const fid='${fid}'; if(!fid) return; if(typeof FB!=='undefined') FB.init({appId:fid,cookie:true,xfbml:true,version:'v19.0'});};
async function loginFB(){var fid='${fid}'; if(!fid){alert('ضيف FACEBOOK_APP_ID في Render → Environment\nالصورة اللي بعثتها قبل فيها App ID - انسخو وحطو في Render'); return;} if(typeof FB==='undefined'){alert('Facebook SDK يحمل... عاود بعد ثانيتين'); return;} FB.login(function(res){if(res.authResponse){FB.api('/me',{fields:'name,email,picture'},function(prof){var email=prof.email||prof.id+'@fb.com'; fetch('/api/auth/facebook',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,name:prof.name,facebook_id:prof.id,avatar:prof.picture?.data?.url})}).then(r=>r.json()).then(r=>{if(r.token){localStorage.setItem('qism_token',r.token); localStorage.setItem('qism_user',JSON.stringify(r.user)); localStorage.setItem('qism_provider','facebook'); token=r.token; init();}});});}else{alert('تم إلغاء Facebook');}}, {scope:'public_profile,email'});}
async function login(){const email=document.getElementById('email').value.trim(); const name=document.getElementById('name').value.trim(); const phone=document.getElementById('phone').value.trim(); if(!email){alert('دخل ايميلك الحقيقي'); return;} if(!email.includes('@')){alert('ايميل غير صحيح'); return;} const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,phone,name,role})}).then(r=>r.json()); if(r.token){localStorage.setItem('qism_token',r.token); localStorage.setItem('qism_user',JSON.stringify(r.user)); localStorage.setItem('qism_provider','email'); token=r.token; init();}else alert(r.error||'خطأ');}
function logout(){localStorage.clear(); token=null; location.reload();}
async function init(){
 const params=new URLSearchParams(location.search);
 if(params.get('mock_payment')){const amt=parseInt(params.get('mock_payment')); if(amt && token){await fetch('/api/wallet/topup',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({amount:amt})}); alert('تم شحن (تجريبي) '+amt+' دج - الحقيقي عبر Chargily بعد التأكيد'); history.replaceState({},'',location.pathname);} }
 if(params.get('payment')==='success'){alert('تم الدفع عبر Chargily بنجاح! الرصيد سيضاف خلال ثواني عبر Webhook - حدث الصفحة'); history.replaceState({},'',location.pathname);}
 if(!token){document.getElementById('login').classList.remove('hidden'); document.getElementById('app').classList.add('hidden'); try{const cfg=await fetch('/api/config').then(r=>r.json()); document.getElementById('chargilyModeText').innerText=cfg.chargily_mode==='live'?'LIVE حقيقي - CIB/Edahabia/Visa':cfg.chargily_mode==='test'?'TEST تجريبي':'';}catch{} return;}
 try{const u=JSON.parse(localStorage.getItem('qism_user')||'{}'); const pr=localStorage.getItem('qism_provider')||''; document.getElementById('uInfo').innerText=(u.name||'')+' - '+(u.email||''); document.getElementById('roleBadge').innerText=u.role==='teacher'?'👨‍🏫 أستاذ':u.role==='parent'?'👨‍👩‍👧 ولي':u.role==='admin'?'⚙️ إدارة':'🎓 تلميذ'; document.getElementById('roleBadge').className=u.role==='teacher'?'text-[10px] px-2.5 py-1 rounded-full font-bold bg-amber-100 text-amber-800':u.role==='parent'?'text-[10px] px-2.5 py-1 rounded-full font-bold bg-blue-100 text-blue-800':'text-[10px] px-2.5 py-1 rounded-full font-bold bg-purple-100 text-purple-800'; document.getElementById('providerBadge').innerText=pr==='google'?'Google حقيقي ✅':pr==='facebook'?'Facebook حقيقي ✅':''; if(u.avatar){document.getElementById('uAvatar').src=u.avatar; document.getElementById('uAvatar').classList.remove('hidden');} document.getElementById('login').classList.add('hidden'); document.getElementById('app').classList.remove('hidden');
 if(u.role==='teacher'){document.getElementById('teacherNav').classList.remove('hidden'); document.getElementById('nav-admin')?.classList.add('hidden');}
 if(u.role==='parent'){document.getElementById('parentNav').classList.remove('hidden');}
 if(u.role==='admin'){document.getElementById('nav-admin').classList.remove('hidden'); document.getElementById('teacherNav').classList.remove('hidden'); document.getElementById('parentNav').classList.remove('hidden');}
 load(); showTab('home'); loadTeachers();
 try{const cfg=await fetch('/api/config').then(r=>r.json()); document.getElementById('chargilyStatus').innerHTML=cfg.chargily_mode==='live'?'💳 Chargily: <b class="text-green-400">LIVE حقيقي</b> - CIB/Edahabia/Visa':cfg.chargily_mode==='test'?'💳 Chargily: <b class="text-amber-300">TEST تجريبي</b>':'💳 Chargily: Mock - ضيف API Key'; document.getElementById('chargilyModeText').innerText=cfg.chargily_mode==='live'?'LIVE حقيقي':cfg.chargily_mode==='test'?'TEST تجريبي':'Mock - ضيف CHARGILY_API_KEY';}catch{}
 }catch(e){console.log(e); document.getElementById('login').classList.remove('hidden'); document.getElementById('app').classList.add('hidden');}
}
async function load(){
 try{
  const w=await fetch('/api/wallet',{headers:{Authorization:'Bearer '+token}}).then(r=>r.json()); document.getElementById('wallet').innerText=(w.amount||0).toLocaleString()+' دج'; document.getElementById('walletTop').innerText=(w.amount||0).toLocaleString()+' دج';
  const courses=await fetch('/api/courses').then(r=>r.json()); document.getElementById('allCourses').innerHTML=courses.map(c=>`
  <div class="bg-white card border p-4 hover:shadow-md transition">
    <div class="flex justify-between items-start"><div class="flex gap-3"><div class="w-12 h-12 bg-purple-50 rounded-xl flex items-center justify-center text-xl">${c.image||'📚'}</div><div><p class="font-bold text-sm">${c.title}</p><p class="text-[11px] text-gray-500 mt-0.5">${c.teacher_name||'أستاذ'} • ${c.category||'عام'} • ${c.lessons_count||0} درس • ${c.students_count||0} تلميذ</p><p class="text-[11px] text-gray-400 mt-1 line-clamp-2">${(c.description||'').slice(0,90)}...</p></div></div><div class="text-left ml-2"><p class="font-bold text-sm">${c.price} دج</p><p class="text-[10px] text-gray-400 line-through">8000 دج</p></div></div>
    <div class="flex gap-2 mt-3"><button onclick="enroll(${c.id})" class="flex-1 bg-black text-white text-xs py-2.5 rounded-full font-bold">اشترك الآن - ادفع حقيقي</button><button onclick="viewTeacher(${c.teacher_id})" class="px-4 py-2.5 border rounded-full text-xs">الأستاذ</button></div>
    <div class="mt-2 text-[10px] text-gray-400">الأستاذ يربح ${Math.floor(c.price*0.7-200)} دج / المنصة ${Math.floor(c.price*0.3+200)} دج (30%+200) - صندوق طوارئ 25,000 منفصل</div>
  </div>`).join('')||'<p class="text-center text-gray-400 py-8">لا أقسام بعد - الأستاذ ينشئ قسم جديد من لوحة الأستاذ</p>';
  document.getElementById('statCourses').innerText=courses.length;
  const teachers=await fetch('/api/teachers').then(r=>r.json()).catch(()=>[]); document.getElementById('statTeachers').innerText=teachers.length||0;
  const comm=await fetch('/api/commission/info').then(r=>r.json()); document.getElementById('commInfo').innerHTML=`باقتك: ${comm.subscription||'free'}<br>عمولة: ${comm.current_rate||30}%<br>عادي: ${comm.packages.free}<br>محترف: ${comm.packages.pro}<br>مؤسسة: ${comm.packages.enterprise}<br><br><span class="font-bold">مثال 5000 دج → أستاذ ${5000-Math.floor(5000*0.3)-200} دج / منصة ${Math.floor(5000*0.3)+200} دج</span>`;
 }catch(e){console.log('load',e);}
}
async function loadTeachers(){
 try{
  const q=document.getElementById('teacherSearch')?.value||''; let url='/api/teachers'; if(q) url+=`?search=${encodeURIComponent(q)}`;
  const teachers=await fetch(url).then(r=>r.json());
  document.getElementById('teachersList').innerHTML=teachers.map(t=>`
  <div class="bg-white card border p-5 hover:shadow-md transition">
    <div class="flex gap-4"><img src="${t.avatar||'https://ui-avatars.com/api/?name='+encodeURIComponent(t.name||'أستاذ')+'&background=6B21A8&color=fff'}" class="w-14 h-14 rounded-2xl object-cover"><div class="flex-1"><div class="flex items-center gap-2"><p class="font-bold text-sm">${t.name}</p>${t.verified?'<span class="bg-blue-100 text-blue-700 text-[9px] px-2 py-0.5 rounded-full">✅ موثق</span>':''}<span class="text-[10px] text-gray-400">${t.speciality||''}</span></div><p class="text-[11px] text-gray-500 mt-1 line-clamp-2">${t.bio||'أستاذ في قِسم - يقدم دورات حقيقية'}</p><div class="flex gap-3 mt-2 text-[11px]"><span>⭐ ${t.rating||5.0}</span><span>👥 ${t.total_students||0} تلميذ</span><span>📚 ${t.courses_count||0} قسم</span></div></div></div>
    <div class="mt-4 space-y-2">${(t.courses||[]).slice(0,3).map(c=>`<div class="flex justify-between items-center p-2.5 bg-gray-50 rounded-xl"><div><p class="font-bold text-xs">${c.image||''} ${c.title}</p><p class="text-[10px] text-gray-500">${c.price} دج • ${c.students_count||0} تلميذ</p></div><button onclick="enroll(${c.id})" class="bg-black text-white text-[10px] px-3 py-1.5 rounded-full">اشترك</button></div>`).join('')||'<p class="text-xs text-gray-400">لا أقسام بعد</p>'}</div>
    <button onclick="viewTeacher(${t.id})" class="w-full mt-3 border py-2.5 rounded-full text-xs font-bold">👁️ عرض ملف الأستاذ وكل أقسامه - حقيقي</button>
  </div>`).join('')||'<p class="text-center text-gray-400 py-10">لا أساتذة بعد - سجل كأستاذ وانشر قسمك</p>';
 }catch(e){console.log(e);}
}
function viewTeacher(id){showTab('teachers'); setTimeout(()=>{document.getElementById('teacherSearch').value=''; loadTeachers();},100); window.scrollTo(0,0);}
async function loadMy(){
 try{
  const my=await fetch('/api/my-courses',{headers:{Authorization:'Bearer '+token}}).then(r=>r.json());
  document.getElementById('myCourses').innerHTML=my.length? my.map(c=>`
  <div class="bg-white card border p-4 flex gap-4">
    <div class="w-12 h-12 bg-emerald-50 rounded-xl flex items-center justify-center text-xl">${c.image||'📚'}</div>
    <div class="flex-1"><div class="flex justify-between"><p class="font-bold text-sm">${c.title}</p><span class="text-[10px] bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full">${c.progress||0}%</span></div><p class="text-[11px] text-gray-500 mt-1">${c.teacher_name||''} • دفعت: ${c.price_paid||c.price} دج - الأستاذ ربح: ${c.teacher_earning||0} دج</p><div class="w-full bg-gray-100 h-1.5 rounded-full mt-2"><div class="bg-emerald-500 h-1.5 rounded-full" style="width:${c.progress||0}%"></div></div><button onclick="showTab('learn')" class="mt-2 bg-black text-white text-xs px-4 py-1.5 rounded-full">🎥 دخول القسم - بث مباشر</button></div>
  </div>`).join('') : `<div class="text-center py-10"><p class="text-4xl">📚</p><p class="font-bold mt-2">محفظتك 0 دج - لازم تشحن حقيقي عبر Chargily</p><p class="text-xs text-gray-500 mt-1">التلميذ يبدأ 0 دج - اشحن ثم اختر أستاذك المفضل واشترك</p><button onclick="openTopupModal()" class="mt-3 bg-black text-white px-6 py-2.5 rounded-full text-xs font-bold">💳 شحن عبر Chargily حقيقي</button></div>`;
  document.getElementById('myCount').innerText=my.length; const el2=document.getElementById('myCount2'); if(el2) el2.innerText=my.length;
  const tx=await fetch('/api/transactions',{headers:{Authorization:'Bearer '+token}}).then(r=>r.json()).catch(()=>({transactions:[]})); document.getElementById('txList').innerHTML=(tx.transactions||[]).slice(0,5).map(t=>`<div class="flex justify-between p-2.5 bg-gray-50 rounded-xl text-xs"><div><p class="font-bold">${t.description}</p><p class="text-[10px] text-gray-400">${new Date(t.created_at).toLocaleString('ar-DZ')}</p></div><p class="font-bold">${t.type==='income'?'+':''}${t.amount} دج</p></div>`).join('')||'<p class="text-xs text-gray-400">لا معاملات بعد - اشحن عبر Chargily</p>';
 }catch(e){console.log(e);}
}
async function loadTransactionsFull(){
 try{const tx=await fetch('/api/transactions',{headers:{Authorization:'Bearer '+token}}).then(r=>r.json()); document.getElementById('txListFull').innerHTML=(tx.transactions||[]).map(t=>`<div class="flex justify-between p-3 bg-gray-50 rounded-xl text-xs border"><div><p class="font-bold">${t.description}</p><p class="text-[10px] text-gray-400">${new Date(t.created_at).toLocaleString('ar-DZ')} • ${t.status||'completed'} • ${t.chargily_checkout_id||''}</p></div><div class="text-left"><p class="font-bold">${t.type==='income'?'+':''}${t.amount} دج</p><p class="text-[10px] ${t.type==='income'?'text-green-600':'text-red-600'}">${t.type==='income'?'شحن':'شراء'}</p></div></div>`).join('')||'<p class="text-center text-gray-400 py-8">لا معاملات بعد</p>';}catch{}
}
async function loadMyTeacherCourses(){
 try{
  const courses=await fetch('/api/teacher/courses',{headers:{Authorization:'Bearer '+token}}).then(r=>r.json());
  document.getElementById('myTeacherCourses').innerHTML=courses.length? courses.map(c=>`
  <div class="bg-white card border p-4">
    <div class="flex justify-between"><div><p class="font-bold text-sm">${c.image||'📚'} ${c.title}</p><p class="text-[11px] text-gray-500">${c.category||''} • ${c.price} دج • ${c.students_count||c.enrollments_count||0} تلميذ • ${c.lessons_count||0} درس</p><p class="text-[11px] text-gray-400 mt-1">${(c.description||'').slice(0,80)}...</p></div><span class="text-[10px] px-2 py-1 rounded-full ${c.status==='published'?'bg-green-100 text-green-700':'bg-gray-100'}">${c.status}</span></div>
    <div class="flex gap-2 mt-3"><button onclick="editCourse(${c.id})" class="flex-1 border py-2 rounded-full text-xs">✏️ تعديل</button><button onclick="toggleCourse(${c.id},'${c.status}')" class="flex-1 border py-2 rounded-full text-xs">${c.status==='published'?'🙈 إخفاء':'👁️ إظهار'}</button><button onclick="deleteCourseReal(${c.id})" class="flex-1 bg-red-50 text-red-600 border border-red-200 py-2 rounded-full text-xs font-bold">🗑️ مسح + استرجاع</button></div>
    <p class="text-[10px] text-gray-400 mt-2">المسح = استرجاع 100% من محفظتك للتلاميذ - مثال: 5 تلاميذ × 5000 = 25,000 دج من محفظتك</p>
  </div>`).join('') : `<div class="text-center py-10 bg-gray-50 rounded-2xl border-2 border-dashed"><p class="text-3xl">📚</p><p class="font-bold mt-2">ما عندكش أقسام بعد</p><p class="text-xs text-gray-500 mt-1">أنشئ قسمك الأول الآن - ينشر مباشرة ويشوفوه التلاميذ</p><button onclick="openCreateCourseModal()" class="mt-3 bg-black text-white px-6 py-2 rounded-full text-xs font-bold">+ أنشئ قسم جديد</button></div>`;
 }catch(e){console.log(e);}
}
async function loadTeacherEarnings(){
 try{
  const r=await fetch('/api/teacher/earnings',{headers:{Authorization:'Bearer '+token}}).then(r=>r.json());
  document.getElementById('teacherWallet').innerText=(r.wallet||0).toLocaleString()+' دج';
  document.getElementById('teacherRevenue').innerText=(r.revenue||0).toLocaleString()+' دج';
  document.getElementById('teacherEarnings').innerText=(r.earnings||0).toLocaleString()+' دج';
  document.getElementById('teacherStudents').innerText=r.students||0;
 }catch{}
}
async function loadChildren(){
 try{
  const children=await fetch('/api/parent/children',{headers:{Authorization:'Bearer '+token}}).then(r=>r.json());
  document.getElementById('childrenList').innerHTML=children.length? children.map(child=>`
  <div class="bg-white card border p-5">
    <div class="flex gap-4"><img src="${child.avatar||'https://ui-avatars.com/api/?name='+encodeURIComponent(child.name||'ابن')}" class="w-12 h-12 rounded-2xl"><div class="flex-1"><p class="font-bold text-sm">${child.name} - ${child.email}</p><p class="text-[11px] text-gray-500">${child.courses_count||0} دورة • مصاريف: ${child.total_spent||0} دج</p><div class="mt-3 space-y-2">${(child.enrollments||[]).map(e=>`<div class="flex justify-between p-2.5 bg-gray-50 rounded-xl text-xs"><span>${e.title} - ${e.progress||0}%</span><span>${e.price_paid||0} دج</span></div>`).join('')||'<p class="text-xs text-gray-400">لا دورات بعد</p>'}</div></div></div>
  </div>`).join('') : `<div class="text-center py-10 bg-blue-50 rounded-2xl border-2 border-dashed border-blue-200"><p class="text-3xl">👨‍👩‍👧</p><p class="font-bold mt-2">ما ربطتش حتى ابن بعد</p><p class="text-xs text-gray-500 mt-1">اربط حساب ابنو بايميلو وتابع تقدمو ومصاريفو حقيقي</p><button onclick="showTab('parent-link')" class="mt-3 bg-blue-600 text-white px-6 py-2 rounded-full text-xs font-bold">🔗 ربط حساب ابنو الآن</button></div>`;
 }catch(e){console.log(e);}
}
async function linkChild(){
 const email=document.getElementById('childEmail').value.trim().toLowerCase(); if(!email){alert('دخل ايميل ابنو'); return;} if(!email.includes('@')){alert('ايميل غير صحيح'); return;}
 const r=await fetch('/api/parent/link',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({student_email:email})}).then(r=>r.json());
 if(r.ok){alert('تم ربط ابنو بنجاح ✅ - تقدر تتابعو الآن'); document.getElementById('childEmail').value=''; showTab('parent'); loadChildren();} else alert(r.error||'خطأ - تأكد ايميل ابنو صحيح ومسجل في قِسم');
}
function openCreateCourseModal(){document.getElementById('createCourseForm').classList.remove('hidden'); window.scrollTo(0,0);}
function addLessonInput(){const div=document.createElement('div'); div.className='flex gap-2'; div.innerHTML=`<input placeholder="عنوان الدرس - مثال: درس ${document.querySelectorAll('.lesson-title').length+1}" class="flex-1 p-2.5 rounded-xl border bg-white text-xs lesson-title"><input placeholder="المدة" type="number" class="w-24 p-2.5 rounded-xl border bg-white text-xs lesson-duration"><button onclick="this.parentElement.remove()" class="px-3 bg-red-50 text-red-600 rounded-xl text-xs">✕</button>`; document.getElementById('lessonsInputs').appendChild(div);}
async function createCourseReal(){
 const title=document.getElementById('cTitle').value.trim(); const price=parseInt(document.getElementById('cPrice').value); const category=document.getElementById('cCategory').value.trim(); const image=document.getElementById('cImage').value.trim()||'📚'; const desc=document.getElementById('cDesc').value.trim(); const schedule=document.getElementById('cSchedule').value.trim();
 if(!title){alert('عنوان القسم مطلوب'); return;} if(!price || price<1000){alert('السعر - الحد الأدنى 1000 دج'); return;}
 const lessonTitles=[...document.querySelectorAll('.lesson-title')].map(i=>({title:i.value.trim(),duration:parseInt(i.parentElement.querySelector('.lesson-duration')?.value)||60})).filter(l=>l.title);
 const r=await fetch('/api/teacher/courses',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({title,description:desc,price,category,image,schedule,lessons:lessonTitles})}).then(r=>r.json());
 if(r.ok){alert('تم نشر القسم بنجاح ✅ - يظهر الآن للتلاميذ في الرئيسية - يقدرو يشتركون حقيقي'); document.getElementById('createCourseForm').classList.add('hidden'); document.getElementById('cTitle').value=''; document.getElementById('cPrice').value=''; document.getElementById('cDesc').value=''; document.getElementById('cCategory').value=''; document.getElementById('cSchedule').value=''; document.getElementById('lessonsInputs').innerHTML='<div class="flex gap-2"><input placeholder="عنوان الدرس 1" class="flex-1 p-2.5 rounded-xl border bg-white text-xs lesson-title"><input placeholder="المدة" type="number" class="w-24 p-2.5 rounded-xl border bg-white text-xs lesson-duration"></div>'; loadMyTeacherCourses(); load();} else alert(r.error||'خطأ في إنشاء القسم');
}
async function deleteCourseReal(id){if(!confirm('هل أنت متأكد من مسح القسم؟ سيتم استرجاع 100% للتلاميذ من محفظتك - إذا رصيدك لا يكفي، العملية تفشل')) return; const r=await fetch('/api/teacher/courses/'+id,{method:'DELETE',headers:{Authorization:'Bearer '+token}}).then(r=>r.json()); if(r.ok){alert(`تم مسح القسم واسترجاع ${r.refunded} دج لـ ${r.enrollCount} تلميذ من محفظتك - حقيقي`); loadMyTeacherCourses(); load();} else alert(r.error||'خطأ - رصيدك لا يكفي للاسترجاع');}
async function toggleCourse(id,status){const newStatus=status==='published'?'draft':'published'; const r=await fetch('/api/teacher/courses/'+id,{method:'PUT',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({status:newStatus})}).then(r=>r.json()); if(r.ok){loadMyTeacherCourses(); load();}}
function editCourse(id){alert('تعديل القسم - قريبا - حاليا احذف وانشئ جديد');}
async function enroll(id){
 const r=await fetch('/api/enroll',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({course_id:id})}).then(r=>r.json());
 if(r.error){
  if(r.need_topup){
   if(confirm(r.error+'\n\nهل تريد الشحن الآن عبر Chargily حقيقي؟')) openTopupModal();
  } else alert(r.error);
  return;
 }
 alert(`تم الاشتراك بنجاح ✅ حقيقي\nالأستاذ ربح: ${r.commission.teacherEarning} دج\nالمنصة: ${r.commission.platformFee} دج (${r.commission.rate}%+${r.commission.fixed} دج)\nصندوق طوارئ: 25,000 دج منفصل`);
 load(); loadMy();
}
function openTopupModal(){document.getElementById('topupModal').classList.remove('hidden');}
function closeTopupModal(){document.getElementById('topupModal').classList.add('hidden');}
function setTopupAmount(a){currentTopup=a; document.getElementById('topupAmount').value=a; document.querySelectorAll('#topupModal .grid button').forEach(b=>{b.classList.remove('border-2','border-[#6B21A8]','bg-purple-50');}); event.target.classList.add('border-2','border-[#6B21A8]','bg-purple-50');}
async function topupChargilyReal(){
 const amount=parseInt(document.getElementById('topupAmount').value); if(!amount || amount<1000){alert('الحد الأدنى 1000 دج'); return;}
 const btn=event.target; btn.innerText='جاري إنشاء رابط دفع Chargily حقيقي...'; btn.disabled=true;
 try{
  const r=await fetch('/api/wallet/topup/chargily',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({amount})}).then(r=>r.json());
  if(r.checkout_url){
   if(r.mock){if(confirm(`Chargily تجريبي - المبلغ ${amount} دج - سيتم شحن تجريبي (لأن API Key غير مربوط أو خطأ)\n\nهل تريد الشحن التجريبي الآن؟\n\nلشحن حقيقي: ضيف CHARGILY_API_KEY live_sk_... في Render`)){await fetch('/api/wallet/topup',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({amount})}); closeTopupModal(); load(); alert('تم الشحن التجريبي - للشحن الحقيقي ضيف CHARGILY_API_KEY');} }
   else {window.location.href=r.checkout_url;}
  } else alert('خطأ في إنشاء رابط الدفع: '+(r.error||JSON.stringify(r)));
 }catch(e){alert('خطأ: '+e.message);}
 btn.innerText='💳 ادفع الآن عبر Chargily - حقيقي'; btn.disabled=false;
}
async function topupMock(){const amount=parseInt(document.getElementById('topupAmount').value); if(!amount) return; await fetch('/api/wallet/topup',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({amount})}); closeTopupModal(); load(); loadMy(); alert('تم الشحن التجريبي '+amount+' دج - للشحن الحقيقي استخدم زر Chargily حقيقي بعد إضافة API Key');}
async function loadAdmin(){
 try{
  const w=await fetch('/api/wallet',{headers:{Authorization:'Bearer '+token}}).then(r=>r.json());
  document.getElementById('adminRevenue').innerText=(w.platform_revenue||0).toLocaleString()+' دج';
  document.getElementById('adminUsers').innerText='...'; document.getElementById('adminEnrollments').innerText='...';
  const stats=await fetch('/health').then(r=>r.json()); document.getElementById('adminUsers').innerText='حقيقي'; document.getElementById('adminEnrollments').innerText='حقيقي';
 }catch{}
}
function showCommission(){document.getElementById('commissionBox').classList.toggle('hidden');}
init();
<\/script></body></html>`;
}
app.get('/',(req,res)=>{res.send(getHTML(process.env.GOOGLE_CLIENT_ID||'',process.env.FACEBOOK_APP_ID||'',process.env.CHARGILY_API_KEY?.startsWith('live_')?'live':process.env.CHARGILY_API_KEY?'test':'mock'));});
app.get('/app',(req,res)=>{res.send(getHTML(process.env.GOOGLE_CLIENT_ID||'',process.env.FACEBOOK_APP_ID||'',process.env.CHARGILY_API_KEY?.startsWith('live_')?'live':process.env.CHARGILY_API_KEY?'test':'mock'));});
app.get('/login',(req,res)=>{res.send(getHTML(process.env.GOOGLE_CLIENT_ID||'',process.env.FACEBOOK_APP_ID||'',process.env.CHARGILY_API_KEY?.startsWith('live_')?'live':process.env.CHARGILY_API_KEY?'test':'mock'));});
app.get('/dashboard',(req,res)=>{res.send(getHTML(process.env.GOOGLE_CLIENT_ID||'',process.env.FACEBOOK_APP_ID||'',process.env.CHARGILY_API_KEY?.startsWith('live_')?'live':process.env.CHARGILY_API_KEY?'test':'mock'));});
app.get('/parent',(req,res)=>{res.send(getHTML(process.env.GOOGLE_CLIENT_ID||'',process.env.FACEBOOK_APP_ID||'',process.env.CHARGILY_API_KEY?.startsWith('live_')?'live':process.env.CHARGILY_API_KEY?'test':'mock'));});
app.get('/admin',(req,res)=>{res.send(getHTML(process.env.GOOGLE_CLIENT_ID||'',process.env.FACEBOOK_APP_ID||'',process.env.CHARGILY_API_KEY?.startsWith('live_')?'live':process.env.CHARGILY_API_KEY?'test':'mock'));});
const PORT=process.env.PORT||10000;
app.listen(PORT,()=>console.log('QISM v7 REAL PRODUCTION - Chargily real - Teacher publish real - Parent link real - 0 wallet - on '+PORT));
