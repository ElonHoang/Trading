// Server cho UI local. Không cần API key: mọi dữ liệu lấy từ REST công khai của Binance.

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze } from './analysis/analyze.js';
import { INTERVALS } from './data/binance.js';
import { readWatchlist, addSymbol, removeSymbol } from './data/watchlist.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;

// Module browser import trực tiếp: tính lại chỉ báo và vẽ chart khi WebSocket
// đẩy nến mới. Chỉ mở đúng các file này, không expose cả thư mục src/.
const BROWSER_MODULES = {
  'indicators.js': 'analysis/indicators.js',
  'summary.js': 'analysis/summary.js',
  'chart.js': 'chart/render.js',
};

const app = express();
app.use(express.json());
app.use(express.static(path.join(rootDir, 'public')));

for (const [name, rel] of Object.entries(BROWSER_MODULES)) {
  app.get(`/lib/${name}`, (req, res) => {
    res.type('application/javascript').sendFile(path.join(rootDir, 'src', rel));
  });
}

app.get('/api/intervals', (req, res) => res.json(INTERVALS));

app.get('/api/analyze', async (req, res) => {
  const { symbol, interval = '4h', limit } = req.query;
  try {
    if (!symbol) throw new Error('Thiếu tham số symbol');
    res.json(await analyze(symbol, interval, Number(limit) || 300));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/watchlist', async (req, res) => res.json(await readWatchlist()));

app.post('/api/watchlist', async (req, res) => {
  try {
    res.json(await addSymbol(req.body?.symbol));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/watchlist/:symbol', async (req, res) => {
  res.json(await removeSymbol(req.params.symbol));
});

app.listen(PORT, () => {
  console.log(`Giao diện phân tích: http://localhost:${PORT}`);
});
