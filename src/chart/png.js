// Xuất chart ra PNG cho bot Telegram, dùng chung bộ vẽ với web UI (render.js).

import { createCanvas } from '@napi-rs/canvas';
import {
  renderPricePanel, renderRsiPanel, COLORS, fmt, pct, decimalsFor,
} from './render.js';

const HEADER_H = 46;
const FONT = 'sans-serif';

/**
 * Vẽ payload từ analyze() thành ảnh PNG.
 * `scale` là hệ số nét: vẽ ở kích thước logic rồi phóng to pixel để chữ không rỗ.
 */
export function renderAnalysisPng(payload, {
  width = 1000, priceHeight = 430, rsiHeight = 120, scale = 2,
} = {}) {
  const { candles, series, interval, symbol, summary, ticker } = payload;
  const height = HEADER_H + priceHeight + rsiHeight;

  const canvas = createCanvas(width * scale, height * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, width, height);

  drawHeader(ctx, { width, symbol, interval, summary, ticker });

  ctx.save();
  ctx.translate(0, HEADER_H);
  renderPricePanel(ctx, {
    candles, series, interval, width, height: priceHeight, font: `11px ${FONT}`,
  });
  ctx.restore();

  ctx.save();
  ctx.translate(0, HEADER_H + priceHeight);
  renderRsiPanel(ctx, {
    candles, series, width, height: rsiHeight, font: `11px ${FONT}`,
  });
  ctx.restore();

  return canvas.toBuffer('image/png');
}

function drawHeader(ctx, { width, symbol, interval, summary, ticker }) {
  const d = decimalsFor(summary.price);
  const change = ticker?.priceChangePercent;

  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';

  // Con trỏ x chạy dần sang phải. Mỗi đoạn phải được đo bằng đúng font vẽ nó,
  // nếu không các cụm chữ sẽ đè lên nhau.
  let x = 12;
  const put = (text, font, color) => {
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.fillText(text, x, HEADER_H / 2);
    x += ctx.measureText(text).width;
  };

  put(`${symbol} · ${interval}`, `bold 17px ${FONT}`, '#e6edf3');
  x += 12;
  const priceColor = change == null ? '#e6edf3' : change >= 0 ? COLORS.up : COLORS.down;
  put(fmt(summary.price, d), `bold 19px ${FONT}`, priceColor);
  if (change != null) {
    x += 10;
    put(pct(change), `13px ${FONT}`, priceColor);
  }

  // Cụm chỉ báo ngắn bên phải, canh phải để không đè lên giá.
  ctx.textAlign = 'right';
  ctx.font = `12px ${FONT}`;
  ctx.fillStyle = COLORS.text;
  const bits = [
    summary.rsi == null ? null : `RSI ${fmt(summary.rsi, 1)}`,
    summary.ma50 == null ? null : `MA50 ${fmt(summary.ma50, d)}`,
    summary.ma200 == null ? null : `MA200 ${fmt(summary.ma200, d)}`,
  ].filter(Boolean);
  ctx.fillText(bits.join('   '), width - 12, HEADER_H / 2);

  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, HEADER_H - 0.5);
  ctx.lineTo(width, HEADER_H - 0.5);
  ctx.stroke();
}
