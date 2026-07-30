// Web Worker: chạy train và backtest ngoài luồng giao diện.
// Train 16.000 nến mất khoảng 30-90 giây tuỳ máy — nếu chạy trên main thread thì
// cả trang sẽ đứng, kể cả biểu đồ.
//
// Import trực tiếp module lõi trong src/ — chính là code mà bot Telegram dùng,
// không có bản sao riêng cho browser.

import { trainModel } from '../src/ml/train.js';
import { backtest } from '../src/backtest.js';

const post = (type, payload) => self.postMessage({ type, ...payload });

self.onmessage = async (e) => {
  const { job, id, symbol, interval, strategy, candles, storedModel } = e.data || {};
  const onProgress = (message) => post('progress', { id, message });

  try {
    if (job === 'train') {
      const { payload, verdict } = await trainModel(symbol, interval, strategy, onProgress);
      post('done', { id, result: { payload, verdict } });
    } else if (job === 'backtest') {
      const result = await backtest(symbol, interval, strategy, {
        candles,
        storedModel,
        onProgress,
      });
      post('done', { id, result });
    } else {
      throw new Error(`Job không hợp lệ: ${job}`);
    }
  } catch (err) {
    post('failed', { id, error: err?.message || String(err) });
  }
};
