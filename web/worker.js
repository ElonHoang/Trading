// The expensive jobs now run in the Java runtime.  Keep the Worker boundary so
// the UI protocol stays stable and a slow request never blocks rendering.

import { csrfFetch } from './auth.js';

const post = (type, payload) => self.postMessage({ type, ...payload });

async function request(path, body) {
  const response = await csrfFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function verdict(payload) {
  const auc = Number(payload?.metrics?.test?.auc);
  if (!Number.isFinite(auc)) return 'Đã train xong; chưa đủ dữ liệu kiểm chứng.';
  if (auc >= 0.58) return 'TỐT — model có tín hiệu tốt hơn ngẫu nhiên trên holdout.';
  if (auc >= 0.52) return 'CÓ THỂ DÙNG THAM KHẢO — cần xem thêm walk-forward.';
  return 'KHÔNG ĐÁNG TIN — không dùng model này làm tín hiệu chính.';
}

self.onmessage = async (event) => {
  const { job, id, symbol, interval, strategy, candles } = event.data || {};
  try {
    if (job === 'train') {
      post('progress', { id, message: `Đang huấn luyện ${symbol} ${interval} trên Java server…` });
      const payload = await request('/api/train', { symbol, interval, strategy });
      post('done', { id, result: { payload, verdict: verdict(payload) } });
    } else if (job === 'backtest') {
      post('progress', { id, message: `Đang backtest ${symbol} ${interval} trên Java server…` });
      const result = await request('/api/backtest', { symbol, interval, candles, strategy });
      post('done', { id, result });
    } else {
      throw new Error(`Job không hợp lệ: ${job}`);
    }
  } catch (error) {
    post('failed', { id, error: error?.message || String(error) });
  }
};
