// Server cho UI local. Không cần API key: mọi dữ liệu lấy từ REST công khai của Binance.
//
// Phục vụ hai giao diện:
//   /            dashboard tĩnh local (index.html + web/) —
//                mọi tính toán chạy trong browser bằng chính các module trong src/
//   /realtime/   giao diện realtime (public/index.html) — nến cập nhật qua WebSocket
//                Binance, số liệu phân tích lấy từ /api/analyze
//
// Chỉ những thư mục trong ALLOWED_ROOTS được phục vụ, nên .env, node_modules
// và data/ không bị lộ.

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze } from './analysis/engine.js';
import { INTERVALS, resolveSymbol } from './data/binance.js';
import { assertAllowedTradeSymbol } from './data/trading-universe.js';
import { loadPrompt, loadStrategy } from './config.js';
import { listModels, loadModel } from './ml/model-store.js';
import { readWatchlist, addSymbol, removeSymbol } from './data/watchlist.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;

// Dashboard tĩnh import trực tiếp module trong src/ qua HTTP, nên phải phục vụ
// nguyên trạng các thư mục này.
const ALLOWED_ROOTS = ['web', 'src'];
const ALLOWED_FILES = ['/', '/index.html', '/favicon.ico', '/README.md'];

const app = express();
app.use(express.json());

// Giao diện realtime
app.use('/realtime', express.static(path.join(rootDir, 'public')));

app.get('/api/intervals', (req, res) => res.json(INTERVALS));

app.get('/api/content/strategy', async (req, res, next) => {
  try { res.json(await loadStrategy()); } catch (error) { next(error); }
});

app.get('/api/content/prompt', async (req, res, next) => {
  try { res.type('text/plain; charset=utf-8').send(await loadPrompt()); } catch (error) { next(error); }
});

app.get('/api/content/models', async (req, res, next) => {
  try { res.json(await listModels()); } catch (error) { next(error); }
});

app.get('/api/content/models/:symbol/:interval', async (req, res, next) => {
  try {
    const model = await loadModel(req.params.symbol, req.params.interval);
    if (!model) return res.status(404).json({ error: 'Không tìm thấy model' });
    return res.json(model);
  } catch (error) {
    return next(error);
  }
});

app.get('/api/analyze', async (req, res) => {
  const { symbol, interval = '4h', bars } = req.query;
  try {
    if (!symbol) throw new Error('Thiếu tham số symbol');
    // Đối chiếu danh sách cặp thật của Binance, không đoán.
    const normalized = await resolveSymbol(symbol);
    const strategy = await loadStrategy();
    assertAllowedTradeSymbol(normalized, strategy);
    // Chưa train model cho cặp này thì engine tự báo trong ml.reason.
    const storedModel = await loadModel(normalized, interval).catch(() => null);
    res.json(await analyze(normalized, interval, strategy, {
      storedModel,
      includeSeries: true,
      seriesBars: Number(bars) || 180,
    }));
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

// Static cho dashboard tĩnh, đặt sau /api để không chắn route.
app.use((req, res, next) => {
  const top = req.path.split('/')[1];
  if (ALLOWED_FILES.includes(req.path) || ALLOWED_ROOTS.includes(top)) return next();
  return res.status(404).type('text/plain; charset=utf-8').send(`Không tìm thấy: ${req.path}`);
});
app.use(express.static(rootDir, { index: 'index.html', dotfiles: 'deny' }));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  return res.status(500).json({ error: error.message });
});

app.listen(PORT, () => {
  console.log(`Dashboard tĩnh:      http://localhost:${PORT}`);
  console.log(`Giao diện realtime:  http://localhost:${PORT}/realtime/`);
});
