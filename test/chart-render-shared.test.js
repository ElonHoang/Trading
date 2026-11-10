// src/chart/render.js được DÙNG CHUNG: trang web vẽ lên canvas trình duyệt, bot Telegram
// vẽ ảnh PNG bằng @napi-rs/canvas. Test này ghi lại mọi lệnh vẽ cho một bộ dữ liệu cố định
// rồi băm, để chặn việc sửa giao diện web vô tình làm đổi ảnh bot gửi đi.
//
// Mặc định (không truyền `colors`, `compact`, `timeTicks`) PHẢI cho đúng các hash dưới đây.
// Chỉ khi cố ý đổi cách bot vẽ chart thì mới cập nhật hash — và nói rõ điều đó trong commit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  renderPricePanel, renderCvdPanel, FORWARD_RATIO, COLORS, PAD,
  fmt, pct, compact, decimalsFor, timeLabel,
} from '../src/chart/render.js';

function recorder(log) {
  const state = {};
  return new Proxy({}, {
    get(_, prop) {
      if (prop === 'measureText') return (t) => ({ width: String(t).length * 6.1 });
      if (prop in state) return state[prop];
      return (...args) => {
        log.push([String(prop), ...args.map((a) => (typeof a === 'number' ? +a.toFixed(6) : a))]);
      };
    },
    set(_, prop, value) { state[prop] = value; log.push(['=' + String(prop), value]); return true; },
  });
}

const hash = (log) => createHash('sha256').update(JSON.stringify(log)).digest('hex').slice(0, 16);
const run = (fn, opts) => { const log = []; fn(recorder(log), opts); return hash(log); };

// Dữ liệu giả tất định (không dùng Math.random).
const candles = [];
{
  let price = 100;
  for (let i = 0; i < 120; i++) {
    const open = price;
    const close = price + Math.sin(i / 7) * 1.8 + Math.cos(i / 3) * 0.6;
    candles.push({
      openTime: 1_700_000_000_000 + i * 14_400_000, open, close,
      high: Math.max(open, close) + 0.9, low: Math.min(open, close) - 0.8, volume: 1000 + ((i * 37) % 400),
    });
    price = close;
  }
}
const volumeAvg = candles.map((_, i) => (i < 20 ? null : 1200));
const cvd = candles.map((_, i) => Math.sin(i / 9) * 5000 + i * 20);
const cvdDelta = candles.map((_, i) => Math.cos(i / 4) * 300);
const last = candles.at(-1).close;
const levels = {
  support: [{ price: last - 3, touches: 4 }, { price: last - 6, touches: 2 }, { price: last - 9, touches: 1 }],
  resistance: [{ price: last + 2.5, touches: 5 }, { price: last + 5, touches: 3 }],
};
const walls = [{ side: 'bid', price: last - 2, ratioToAvg: 3.4 }, { side: 'ask', price: last + 1.5, ratioToAvg: 2.2 }];
const setup = {
  side: 'long', entry: last, stopLoss: last - 2.2, rrToTp1: 1.5,
  targets: [{ label: 'TP1', price: last + 3 }, { label: 'TP2', price: last + 6 }],
};

test('bộ vẽ chung: lệnh vẽ mặc định không đổi (ảnh Telegram giữ nguyên)', () => {
  const base = { candles, volumeAvg, interval: '4h', width: 1280, height: 560 };
  assert.equal(run(renderPricePanel, base), 'e3f70bbc85265636');
  assert.equal(run(renderPricePanel, { ...base, levels, walls }), 'c7ba423166371c3e');
  assert.equal(run(renderPricePanel, { ...base, levels, walls, setup, font: '12px sans-serif' }), 'b1c45cd8890d109c');
  assert.equal(run(renderPricePanel, {
    ...base, interval: '1h', width: 900, height: 380, levels, walls, hover: 40,
    setup: { ...setup, side: 'short', pending: true, stopLoss: last + 2.2, targets: [{ label: 'TP1', price: last - 3 }] },
  }), 'f6e1e325fea3858c');
  assert.equal(run(renderCvdPanel, { candles, cvd, cvdDelta, width: 1280, height: 210 }), '7c2fe47659acfe25');
  assert.equal(run(renderCvdPanel, {
    candles, cvd, cvdDelta, width: 900, height: 150, hover: 12, forwardRatio: FORWARD_RATIO,
  }), '096701b40c3e5b4b');
});

test('bộ vẽ chung: hằng số và hàm định dạng không đổi', () => {
  const h = createHash('sha256').update(JSON.stringify([
    fmt(74760.24), fmt(0.000008123), pct(-0.004), compact(5_400_000), decimalsFor(3.2),
    timeLabel(1_700_000_000_000, '4h'), COLORS, PAD, FORWARD_RATIO,
  ])).digest('hex').slice(0, 16);
  assert.equal(h, 'ad24563ed998790d');
});

test('tuỳ chọn của giao diện web có tác dụng nhưng chỉ khi được truyền vào', () => {
  const base = { candles, volumeAvg, interval: '4h', width: 600, height: 400, levels, walls, setup };
  const plain = run(renderPricePanel, base);
  assert.notEqual(run(renderPricePanel, { ...base, colors: { up: '#0e9f6e', down: '#e0443e', grid: '#e3e6eb' } }), plain);
  assert.notEqual(run(renderPricePanel, { ...base, compact: true }), plain);
  assert.notEqual(run(renderPricePanel, { ...base, timeTicks: 2 }), plain);
  // truyền đúng giá trị mặc định thì phải ra y hệt không truyền
  assert.equal(run(renderPricePanel, { ...base, timeTicks: 6, compact: false, colors: null }), plain);
  const cvdBase = { candles, cvd, cvdDelta, width: 600, height: 160 };
  assert.notEqual(run(renderCvdPanel, { ...cvdBase, compact: true }), run(renderCvdPanel, cvdBase));
});
