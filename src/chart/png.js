// Xuất chart ra PNG cho bot Telegram, dùng chung bộ vẽ với giao diện realtime (render.js).

import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import {
  renderPricePanel, renderCvdPanel, COLORS, fmt, pct, decimalsFor, FORWARD_RATIO,
} from './render.js';

const HEADER_H = 58;
// Số nến vẽ. Ít nến -> mỗi nến to và dễ đọc hơn; Telegram nén ảnh nên chart dày
// đặc 180-300 nến gần như không xem được trên điện thoại.
const MAX_BARS = 90;

// Font mặc định của @napi-rs/canvas thiếu glyph tiếng Việt (ậ, ỹ, ủ, ộ... ra ô
// vuông). Nạp font hệ thống rồi chọn họ đầu tiên có sẵn.
GlobalFonts.loadSystemFonts();
const FONT = ['Segoe UI', 'Arial', 'DejaVu Sans', 'Liberation Sans', 'Helvetica']
  .find((f) => GlobalFonts.has(f)) ?? 'sans-serif';

/**
 * Vẽ snapshot từ engine.analyze() (cần opts.includeSeries) thành ảnh PNG.
 * `scale` là hệ số nét: vẽ ở kích thước logic rồi phóng to pixel để chữ không rỗ.
 */
export function renderAnalysisPng(snap, {
  width = 1280, priceHeight = 560, cvdHeight = 210, scale = 2, setup = null,
  maxBars = MAX_BARS,
} = {}) {
  const s = snap.series;
  if (!s || !s.close?.length) throw new Error('Snapshot thiếu series — gọi analyze với includeSeries');

  // Chỉ lấy `maxBars` nến cuối cho dễ đọc. Cắt đồng bộ mọi mảng song song, nếu
  // lệch index thì CVD sẽ không khớp nến.
  const from = Math.max(0, s.close.length - maxBars);
  const cut = (arr) => (Array.isArray(arr) ? arr.slice(from) : arr);

  // series là các mảng song song; dựng lại thành mảng nến cho bộ vẽ.
  const time = cut(s.time);
  const open = cut(s.open);
  const high = cut(s.high);
  const low = cut(s.low);
  const close = cut(s.close);
  const volume = cut(s.volume);
  const candles = close.map((c, i) => ({
    openTime: time[i],
    open: open[i],
    high: high[i],
    low: low[i],
    close: c,
    volume: volume[i],
  }));

  const height = HEADER_H + priceHeight + cvdHeight;
  const canvas = createCanvas(width * scale, height * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, width, height);

  drawHeader(ctx, { width, snap });

  ctx.save();
  ctx.translate(0, HEADER_H);
  const hasSetup = setup && setup.side && setup.side !== 'none' && setup.entry != null;
  renderPricePanel(ctx, {
    candles,
    volumeAvg: cut(s.volumeAvg),
    interval: snap.interval,
    width,
    height: priceHeight,
    levels: snap.structure,
    walls: snap.orderBook?.walls ?? [],
    setup,
    font: `13px ${FONT}`,
  });
  ctx.restore();

  ctx.save();
  ctx.translate(0, HEADER_H + priceHeight);
  renderCvdPanel(ctx, {
    candles,
    cvd: cut(s.cvd),
    cvdDelta: cut(s.cvdDelta),
    width,
    height: cvdHeight,
    // Phải khớp vùng chừa của panel giá để trục thời gian không lệch.
    forwardRatio: hasSetup ? FORWARD_RATIO : 0,
    font: `13px ${FONT}`,
  });
  ctx.restore();

  return canvas.toBuffer('image/png');
}

function drawHeader(ctx, { width, snap }) {
  const price = snap.price.lastClose;
  const d = decimalsFor(price);
  const change = snap.price.change24hPercent;

  ctx.textBaseline = 'middle';

  // Con trỏ x chạy dần sang phải. Mỗi đoạn phải được đo bằng đúng font vẽ nó,
  // nếu không các cụm chữ sẽ đè lên nhau.
  let x = 12;
  const put = (text, font, color) => {
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.fillText(text, x, HEADER_H / 2);
    x += ctx.measureText(text).width;
  };

  put(`${snap.symbol} · ${snap.interval}`, `bold 21px ${FONT}`, '#e6edf3');
  x += 12;
  const priceColor = change == null ? '#e6edf3' : change >= 0 ? COLORS.up : COLORS.down;
  put(fmt(price, d), `bold 24px ${FONT}`, priceColor);
  if (change != null) {
    x += 10;
    put(pct(change), `15px ${FONT}`, priceColor);
  }

  // Cụm số liệu bên phải, canh phải để không đè lên giá.
  ctx.textAlign = 'right';
  ctx.font = `14px ${FONT}`;
  ctx.fillStyle = COLORS.text;
  const ind = snap.indicators;
  const bits = [
    `${snap.combined.signal} ${snap.combined.score >= 0 ? '+' : ''}${snap.combined.score}`,
    ind.volumeRatio == null ? null : `KL ${ind.volumeRatio}x`,
    ind.cvdSlope == null ? null : `CVD ${pct(ind.cvdSlope * 100, 1)}`,
  ].filter(Boolean);
  ctx.fillText(bits.join('   '), width - 12, HEADER_H / 2);

  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, HEADER_H - 0.5);
  ctx.lineTo(width, HEADER_H - 0.5);
  ctx.stroke();
}
