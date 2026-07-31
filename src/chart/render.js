// Bộ vẽ chart dùng chung cho giao diện realtime (canvas trình duyệt) và bot
// Telegram (@napi-rs/canvas). Chỉ nhận một context 2D, không chạm tới
// document/window, nhờ vậy cùng một code chạy được ở cả hai nơi.
//
// Chỉ vẽ những chỉ báo được phép dùng (xem .claude/skills/chi-bao/SKILL.md):
// nến, khối lượng, hỗ trợ/kháng cự, tường lệnh, CVD.

export const PAD = { left: 8, right: 68, top: 10, bottom: 22 };

export const COLORS = {
  up: '#26a69a',
  down: '#ef5350',
  support: '#26a69a',
  resistance: '#ef5350',
  volAvg: '#8b949e',
  cvd: '#58a6ff',
  entry: '#58a6ff',
  stop: '#ef5350',
  target: '#26a69a',
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

function polyline(ctx, series, color, xOf, yOf, width = 1.3) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
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
 * Khung giá: lưới, nến, hỗ trợ/kháng cự (dày theo số lần chạm), tường lệnh,
 * đường giá hiện tại, khối lượng dưới chân và nhãn thời gian.
 *
 * `candles` là mảng { openTime, open, high, low, close, volume }.
 * `volumeAvg` là mảng cùng độ dài (null ở phần chưa đủ chu kỳ).
 * `levels` = { support: [{price, touches}], resistance: [...] } (tuỳ chọn).
 * `walls`  = [{ side: 'bid'|'ask', price, ratioToAvg }] (tuỳ chọn).
 */
/**
 * Tỉ lệ chiều rộng chừa bên phải để vẽ hộp chiếu kèo (kiểu Long/Short Position
 * của TradingView). Panel CVD phải dùng CÙNG tỉ lệ này, nếu không trục thời gian
 * của hai panel sẽ lệch nhau.
 */
export const FORWARD_RATIO = 0.22;

export function renderPricePanel(ctx, {
  candles, volumeAvg = [], interval, width, height, levels = null, walls = [],
  setup = null, hover = null, font = '11px sans-serif', volumeRatio = 0.2,
}) {
  ctx.font = font;
  const volH = Math.round((height - PAD.top - PAD.bottom) * volumeRatio);
  const fullW = width - PAD.left - PAD.right;
  // Có kèo thì chừa chỗ bên phải cho hộp chiếu; không thì nến chiếm hết.
  const hasSetup = setup && setup.side && setup.side !== 'none' && setup.entry != null;
  const plotW = hasSetup ? fullW * (1 - FORWARD_RATIO) : fullW;
  const zoneX = PAD.left + plotW;
  const zoneW = fullW - plotW;
  const plotH = height - PAD.top - PAD.bottom - volH - 6;

  let lo = Infinity;
  let hi = -Infinity;
  for (const c of candles) {
    lo = Math.min(lo, c.low);
    hi = Math.max(hi, c.high);
  }
  // Bao cả các mức S/R gần giá để chúng không bị cắt ngoài khung.
  for (const lv of [...(levels?.support ?? []), ...(levels?.resistance ?? [])]) {
    if (lv.price > lo * 0.85 && lv.price < hi * 1.15) {
      lo = Math.min(lo, lv.price);
      hi = Math.max(hi, lv.price);
    }
  }
  // Entry/SL/TP phải nằm trong khung, nếu không người xem không thấy kèo.
  // Chỉ nới trong ±20% để nến không bị bẹt khi TP xa.
  const setupPrices = setup
    ? [setup.entry, setup.stopLoss, ...(setup.targets ?? []).map((t) => t.price)]
      .filter((p) => p != null)
    : [];
  const anchor = candles[candles.length - 1].close;
  for (const p of setupPrices) {
    if (p > anchor * 0.8 && p < anchor * 1.2) {
      lo = Math.min(lo, p);
      hi = Math.max(hi, p);
    }
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

  // Các mức S/R và tường lệnh thường chen nhau trong một dải hẹp, nên nhãn phải
  // tự nhường chỗ: mỗi bên giữ danh sách y đã dùng, trùng thì bỏ nhãn (vẫn vẽ đường).
  const usedRight = [];
  const usedLeft = [];
  const claim = (used, y) => {
    if (used.some((v) => Math.abs(v - y) < 11)) return false;
    used.push(y);
    return true;
  };

  // Hỗ trợ / kháng cự: mức bị chạm nhiều lần vẽ dày hơn.
  for (const [kind, list] of [['support', levels?.support], ['resistance', levels?.resistance]]) {
    for (const lv of (list ?? []).slice(0, 3)) {
      if (lv.price < lo || lv.price > hi) continue;
      const y = yOf(lv.price);
      const color = kind === 'support' ? COLORS.support : COLORS.resistance;
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.min(2.5, 1 + ((lv.touches ?? 1) - 1) * 0.5);
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(width - PAD.right, y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (claim(usedRight, y)) {
        ctx.fillStyle = color;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText(
          `${kind === 'support' ? 'HT' : 'KC'} ${fmt(lv.price, priceDec)} · ${lv.touches ?? 1}x`,
          width - PAD.right - 4, y - 2,
        );
      }
    }
  }

  // Tường lệnh trong sổ lệnh — nét dày mờ, chú thích bên trái. Chỉ 2 mức mỗi bên
  // để không lấp chart; tường lớn nhất được ưu tiên (binance.js đã sắp theo giá trị).
  const wallsToDraw = ['bid', 'ask'].flatMap(
    (side) => walls.filter((w) => w.side === side).slice(0, 2),
  );
  for (const w of wallsToDraw) {
    if (w.price < lo || w.price > hi) continue;
    const y = yOf(w.price);
    const color = w.side === 'bid' ? COLORS.support : COLORS.resistance;
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.28;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(width - PAD.right, y);
    ctx.stroke();
    ctx.globalAlpha = 1;
    if (claim(usedLeft, y)) {
      ctx.fillStyle = color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`Tường ${w.side === 'bid' ? 'MUA' : 'BÁN'} ${w.ratioToAvg.toFixed(1)}x`,
        PAD.left + 3, y - 2);
    }
  }
  ctx.textBaseline = 'middle';

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

  // --- Hộp chiếu kèo, kiểu Long/Short Position của TradingView ---
  // Hai hình chữ nhật chiếu RA PHÍA TRƯỚC bên phải nến cuối: xanh = entry→TP,
  // đỏ = entry→SL. Không kẻ ngang suốt chart để không lấp nến.
  if (hasSetup) {
    const lastTp = setup.targets?.[setup.targets.length - 1];
    const yEntry = yOf(setup.entry);
    const clampY = (y) => Math.max(PAD.top, Math.min(PAD.top + plotH, y));

    const box = (toPrice, fill, stroke) => {
      if (toPrice == null) return null;
      const y1 = clampY(yEntry);
      const y2 = clampY(yOf(toPrice));
      const top = Math.min(y1, y2);
      const h = Math.abs(y2 - y1);
      ctx.fillStyle = fill;
      ctx.fillRect(zoneX, top, zoneW, h);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;
      ctx.strokeRect(zoneX, top, zoneW, h);
      return { top, h, y2 };
    };

    const profit = box(lastTp?.price, '#26a69a33', '#26a69a99');
    const risk = box(setup.stopLoss, '#ef535033', '#ef535099');

    // Vạch TP trung gian trong hộp lợi nhuận.
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = '#26a69a77';
    ctx.lineWidth = 1;
    for (const tp of (setup.targets ?? []).slice(0, -1)) {
      const y = clampY(yOf(tp.price));
      ctx.beginPath();
      ctx.moveTo(zoneX, y);
      ctx.lineTo(zoneX + zoneW, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Đường entry kẻ mảnh qua phần nến để thấy mức so với quá khứ.
    ctx.strokeStyle = COLORS.entry;
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(PAD.left, yEntry);
    ctx.lineTo(zoneX + zoneW, yEntry);
    ctx.stroke();
    ctx.setLineDash([]);

    // Nhãn: dán ngoài hộp, canh phải, nền đặc để đọc được.
    const tag = (text, y, bg, align = 'right') => {
      ctx.font = font;
      const w = ctx.measureText(text).width + 10;
      const x = align === 'right' ? zoneX + zoneW - w : zoneX + 2;
      ctx.fillStyle = bg;
      ctx.fillRect(x, y - 8, w, 16);
      ctx.fillStyle = COLORS.accentInk;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x + 5, y);
    };

    const movePct = (p) => ((p - setup.entry) / setup.entry) * 100;
    if (profit && lastTp) {
      tag(`Mục tiêu ${fmt(lastTp.price, priceDec)} (${pct(movePct(lastTp.price))})`,
        clampY(yOf(lastTp.price)) + (setup.side === 'long' ? 9 : -9), '#26a69a');
    }
    if (risk && setup.stopLoss != null) {
      tag(`Cắt lỗ ${fmt(setup.stopLoss, priceDec)} (${pct(movePct(setup.stopLoss))})`,
        clampY(yOf(setup.stopLoss)) + (setup.side === 'long' ? -9 : 9), '#ef5350');
    }
    tag(`${setup.side === 'long' ? 'LONG' : 'SHORT'} vào ${fmt(setup.entry, priceDec)}`
      + (setup.rrToTp1 ? ` · R:R ${fmt(setup.rrToTp1, 2)}` : ''),
    yEntry, COLORS.entry, 'left');
  }

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

  // Khối lượng dưới chân chart + đường trung bình
  const volTop = PAD.top + plotH + 6;
  const volMax = Math.max(...candles.map((c) => c.volume)) || 1;
  const vy = (v) => volTop + volH - (v / volMax) * volH;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    ctx.fillStyle = c.close >= c.open ? '#26a69a55' : '#ef535055';
    ctx.fillRect(xOf(i) - bodyW / 2, vy(c.volume), bodyW, Math.max(0.6, volTop + volH - vy(c.volume)));
  }
  if (volumeAvg.some((v) => v != null)) {
    ctx.setLineDash([4, 3]);
    polyline(ctx, volumeAvg, COLORS.volAvg, xOf, vy, 1.2);
    ctx.setLineDash([]);
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

/**
 * Khung CVD: đường luỹ tiến + cột mua chủ động ròng mỗi nến (đã chuẩn hoá theo
 * volume nến đó nên so được giữa các nến to nhỏ khác nhau).
 */
export function renderCvdPanel(ctx, {
  candles, cvd, cvdDelta, width, height, hover = null, font = '11px sans-serif',
  forwardRatio = 0,
}) {
  ctx.font = font;
  // Phải khớp vùng chừa của panel giá, nếu không trục thời gian hai panel lệch nhau.
  const plotW = (width - PAD.left - PAD.right) * (1 - forwardRatio);
  const barsH = Math.round((height - 14 - 8) * 0.38);
  const lineH = height - 14 - 8 - barsH - 4;
  const xOf = (i) => PAD.left + (plotW / candles.length) * (i + 0.5);

  const vals = cvd.filter((v) => v != null);
  if (!vals.length) return;
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || Math.abs(hi) || 1;
  const yLine = (v) => 14 + lineH - ((v - lo) / span) * lineH;

  ctx.strokeStyle = COLORS.grid;
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  for (const v of [hi, lo + span / 2, lo]) {
    ctx.beginPath();
    ctx.moveTo(PAD.left, yLine(v));
    ctx.lineTo(PAD.left + plotW, yLine(v));
    ctx.stroke();
    ctx.fillText(compact(v), width - PAD.right + 7, yLine(v));
  }
  polyline(ctx, cvd, COLORS.cvd, xOf, yLine, 1.6);

  // Cột delta chuẩn hoá theo volume từng nến
  const share = cvdDelta.map((d, i) => (d != null && candles[i]?.volume ? d / candles[i].volume : null));
  const extent = Math.max(...share.filter((v) => v != null).map(Math.abs), 0.05);
  const barsTop = 14 + lineH + 4;
  const yBar = (v) => barsTop + barsH / 2 - (v / extent) * (barsH / 2);
  const barW = Math.max(1, Math.min((plotW / candles.length) * 0.7, 14));

  ctx.strokeStyle = COLORS.gridSoft;
  ctx.beginPath();
  ctx.moveTo(PAD.left, yBar(0));
  ctx.lineTo(PAD.left + plotW, yBar(0));
  ctx.stroke();
  for (let i = 0; i < share.length; i++) {
    if (share[i] == null) continue;
    ctx.fillStyle = share[i] >= 0 ? '#26a69acc' : '#ef5350cc';
    ctx.fillRect(xOf(i) - barW / 2, share[i] >= 0 ? yBar(share[i]) : yBar(0),
      barW, Math.max(0.8, Math.abs(yBar(share[i]) - yBar(0))));
  }
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = 'left';
  ctx.fillText(`±${(extent * 100).toFixed(0)}%`, width - PAD.right + 7, yBar(0));

  ctx.textBaseline = 'top';
  ctx.fillText('CVD luỹ tiến · cột = mua chủ động ròng mỗi nến (% KL)', PAD.left + 2, 2);
  crosshair(ctx, hover, 14, lineH + 4 + barsH, xOf);
}
