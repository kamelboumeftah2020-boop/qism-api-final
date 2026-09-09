import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ 
    ok: true, 
    version: '2.1.17', 
    status: 'QISM شغال 100%',
    emergency_fund: 25000 
  });
});

app.get('/', (req, res) => {
  res.send('<h1>QISM API v2.1.17 شغال ✅</h1><p>روح لـ /health</p>');
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('QISM running on ' + PORT));
