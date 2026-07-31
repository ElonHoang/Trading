// Bộ vẽ chart dùng chung cho web UI (canvas trình duyệt) và bot Telegram
// (@napi-rs/canvas). Chỉ nhận một context 2D, không chạm tới document/window,
// nhờ vậy cùng một code chạy được ở cả hai nơi.

export const PAD = { left: 8, right: 68, top: 10, bottom: 22 };

export const COLORS = {
  up: '#26a69a',
  down: '#ef5350',
  ma50: '#f0b90b',
  ma200: '#a371f7',
  band: '#37414f33',
  grid: '#1d232c',
  gridSoft: '#2b333e',
  text: '#8b949e',
  accent: '#58a6ff',
  accentInk: '#04101f',
  bg: '#0e1116',
  crosshair: '#64748b',
};

/* ---------- format (dùng chung để web và ảnh hiện số giống nhau) ---------- */

// Crypto có mã giá rất nhỏ (SHIB ~0.000008) nên số chữ số thập phân phải co giãn.
export function decimalsFor(v) {
  const a = Math.abs(v);
  if (!a) return 2;
  if (a < 0.001) return 8;
  if (a < 1) return 6;
  if (a < 100) return 4;
  return 2;
}

// Mọi số trong app đi qua đây để dấu thập phân nhất quán (kiểu vi-VN).
const num = (v, d) => v.toLocaleString('vi-VN', {
  minimumFractionDigits: d, maximumFractionDigits: d,
});

export function fmt(v, d = decimalsFor(v)) {
  if (v == null || Number.isNaN(v)) return '—';
  return num(v, d);
}

export function pct(v, d = 2) {
  if (v == null) return '—';
  // Làm tròn trước khi chọn dấu, tránh hiện "-0,00%" khi giá trị âm rất nhỏ.
  const rounded = Number(v.toFixed(d));
  return `${rounded > 0 ? '+' : ''}${num(rounded, d)}%`;
}

export function compact(v) {
  if (v == null) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${num(v / 1e9, 2)}B`;
  if (abs >= 1e6) return `${num(v / 1e6, 2)}M`;
  if (abs >= 1e3) return `${num(v / 1e3, 2)}K`;
  return num(v, 2);
}

const isIntraday = (iv) => /m$|^\d+h$/.test(iv);

export function timeLabel(ms, iv) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return isIntraday(iv)
    ? `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`
    : `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/* ---------- vẽ ---------- */

function polyline(ctx, series, color, xOf, yOf) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < series.length; i++) {
    if (series[i] == null) { started = false; continue; }
    const x = xOf(i);
    const y = yOf(series[i]);
    if (started) ctx.lineTo(x, y);
    else { ctx.moveTo(x, y); started = true; }
  }
  ctx.stroke();
}

function crosshair(ctx, hover, top, height, xOf) {
  if (hover == null) return;
  ctx.strokeStyle = COLORS.crosshair;
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(xOf(hover), top);
  ctx.lineTo(xOf(hover), top + height);
  ctx.stroke();
  ctx.setLineDash([]);
}

/**
 * Khung giá: lưới, dải Bollinger, nến, MA50/MA200, đường giá hiện tại,
 * khối lượng dưới chân và nhãn thời gian.
 */
export function renderPricePanel(ctx, {
  candles, series, interval, width, height, hover = null,
  font = '11px sans-serif', volumeRatio = 0.2,
}) {
  ctx.font = font;
  const volH = Math.round((height - PAD.top - PAD.bottom) * volumeRatio);
  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom - volH - 6;

  // Thang giá bao cả Bollinger để dải không bị cắt ngoài khung.
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < candles.length; i++) {
    lo = Math.min(lo, candles[i].low, series.bbLower[i] ?? Infinity);
    hi = Math.max(hi, candles[i].high, series.bbUpper[i] ?? -Infinity);
  }
  const pad = (hi - lo) * 0.06 || hi * 0.01;
  lo -= pad;
  hi += pad;

  const step = plotW / candles.length;
  const xOf = (i) => PAD.left + step * (i + 0.5);
  const yOf = (p) => PAD.top + plotH - ((p - lo) / (hi - lo)) * plotH;
  const priceDec = decimalsFor(candles[candles.length - 1].close);

  // Lưới ngang + nhãn giá bên phải
  ctx.strokeStyle = COLORS.grid;
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const y = PAD.top + (plotH / 4) * g;
    ctx.beginPath();
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(width - PAD.right, y);
    ctx.stroke();
    ctx.fillText(fmt(hi - ((hi - lo) / 4) * g, priceDec), width - PAD.right + 7, y);
  }

  // Dải Bollinger
  const bandTop = [];
  const bandBottom = [];
  for (let i = 0; i < candles.length; i++) {
    if (series.bbUpper[i] == null) continue;
    bandTop.push([xOf(i), yOf(series.bbUpper[i])]);
    bandBottom.push([xOf(i), yOf(series.bbLower[i])]);
  }
  if (bandTop.length > 1) {
    ctx.fillStyle = COLORS.band;
    ctx.beginPath();
    bandTop.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    for (let i = bandBottom.length - 1; i >= 0; i--) ctx.lineTo(bandBottom[i][0], bandBottom[i][1]);
    ctx.closePath();
    ctx.fill();
  }

  // Nến: thân + bóng. Thân tối thiểu 1px để nến doji vẫn thấy được.
  const bodyW = Math.max(1, Math.min(step * 0.7, 14));
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const color = c.close >= c.open ? COLORS.up : COLORS.down;
    const x = xOf(i);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, yOf(c.high));
    ctx.lineTo(x, yOf(c.low));
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillRect(
      x - bodyW / 2,
      yOf(Math.max(c.open, c.close)),
      bodyW,
      Math.max(1, Math.abs(yOf(c.close) - yOf(c.open))),
    );
  }

  polyline(ctx, series.ma50, COLORS.ma50, xOf, yOf);
  polyline(ctx, series.ma200, COLORS.ma200, xOf, yOf);

  // Đường giá hiện tại + thẻ giá bên phải
  const lastClose = candles[candles.length - 1].close;
  const yLast = yOf(lastClose);
  ctx.strokeStyle = COLORS.accent;
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD.left, yLast);
  ctx.lineTo(width - PAD.right, yLast);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = COLORS.accent;
  ctx.fillRect(width - PAD.right + 2, yLast - 8, PAD.right - 4, 16);
  ctx.fillStyle = COLORS.accentInk;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(fmt(lastClose, priceDec), width - PAD.right + 6, yLast);

  // Khối lượng dưới chân chart
  const volTop = PAD.top + plotH + 6;
  const volMax = Math.max(...candles.map((c) => c.volume)) || 1;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    ctx.fillStyle = c.close >= c.open ? '#26a69a55' : '#ef535055';
    const bh = (c.volume / volMax) * volH;
    ctx.fillRect(xOf(i) - bodyW / 2, volTop + volH - bh, bodyW, bh);
  }

  // Nhãn thời gian: ~6 mốc, tránh chữ chồng nhau
  ctx.fillStyle = COLORS.text;
  ctx.textBaseline = 'top';
  const every = Math.max(1, Math.ceil(candles.length / 6));
  for (let i = 0; i < candles.length; i += every) {
    ctx.textAlign = i === 0 ? 'left' : 'center';
    ctx.fillText(timeLabel(candles[i].openTime, interval), xOf(i), height - PAD.bottom + 7);
  }

  crosshair(ctx, hover, PAD.top, plotH + 6 + volH, xOf);
}

/** Khung RSI với mốc 30/50/70. */
export function renderRsiPanel(ctx, {
  candles, series, width, height, hover = null, font = '11px sans-serif',
}) {
  ctx.font = font;
  const plotW = width - PAD.left - PAD.right;
  const plotH = height - 12 - 8;
  const xOf = (i) => PAD.left + (plotW / candles.length) * (i + 0.5);
  const yOf = (v) => 12 + plotH - (v / 100) * plotH;

  ctx.fillStyle = COLORS.text;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const level of [30, 50, 70]) {
    ctx.strokeStyle = level === 50 ? COLORS.grid : COLORS.gridSoft;
    ctx.setLineDash(level === 50 ? [] : [3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD.left, yOf(level));
    ctx.lineTo(width - PAD.right, yOf(level));
    ctx.stroke();
    ctx.fillText(String(level), width - PAD.right + 7, yOf(level));
  }
  ctx.setLineDash([]);
  polyline(ctx, series.rsi, COLORS.accent, xOf, yOf);
  ctx.fillStyle = COLORS.text;
  ctx.textBaseline = 'top';
  ctx.fillText('RSI 14', PAD.left + 2, 2);
  crosshair(ctx, hover, 12, plotH, xOf);
}
