// Xuất chart ra PNG cho bot Telegram, dùng chung bộ vẽ với giao diện realtime (render.js).

import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import {
  renderPricePanel, renderCvdPanel, COLORS, fmt, pct, decimalsFor, FORWARD_RATIO,
} from './render.js';

const HEADER_H = 58;
// Số nến vẽ. Ít nến -> mỗi nến to và dễ đọc hơn; Telegram nén ảnh nên chart dày
// đặc 180-300 nến gần như không xem được trên điện thoại.
const MAX_BARS = 90;
// Khi CÓ kèo thì vẽ ít nến hơn nữa: thang giá co lại nên hộp Long/Short giãn ra
// theo chiều dọc, các mức entry/SL/TP tách nhau rõ thay vì chồng thành một dải.
const MAX_BARS_WITH_SETUP = 45;

// @napi-rs/canvas KHÔNG kèm font nào, chỉ có binary — nên phải dùng font hệ thống.
// Font mặc định cũng thiếu glyph tiếng Việt (ậ, ỹ, ủ, ộ... ra ô vuông).
//
// Danh sách gồm cả font Windows và font Linux phổ biến, vì VPS thường chỉ có
// nhóm sau. Nếu host không có font nào thì ảnh sẽ trắng chữ — phải BÁO RA, đừng
// im lặng rơi về 'sans-serif' (họ font đó có thể không tồn tại trên Linux tối giản).
GlobalFonts.loadSystemFonts();

const FONT_CANDIDATES = [
  'Segoe UI', 'Arial',                                  // Windows / macOS
  'Noto Sans', 'DejaVu Sans', 'Liberation Sans',         // Linux, có tiếng Việt
  'FreeSans', 'Ubuntu', 'Helvetica',
];
const FONT = FONT_CANDIDATES.find((f) => GlobalFonts.has(f)) ?? 'sans-serif';

if (FONT === 'sans-serif') {
  console.error(
    '[chart] CẢNH BÁO: không tìm thấy font nào trong '
    + `${FONT_CANDIDATES.join(', ')} (hệ thống báo ${GlobalFonts.families.length} họ font).\n`
    + '        Ảnh chart sẽ mất chữ hoặc ra ô vuông. Trên Debian/Ubuntu cài:\n'
    + '        apt-get install -y fonts-noto-core   (hoặc fonts-dejavu-core)',
  );
}

/**
 * Vẽ snapshot từ engine.analyze() (cần opts.includeSeries) thành ảnh PNG.
 * `scale` là hệ số nét: vẽ ở kích thước logic rồi phóng to pixel để chữ không rỗ.
 */
export function renderAnalysisPng(snap, {
  width = 1280, priceHeight = 560, cvdHeight = 210, scale = 2, setup = null,
  projections = null, maxBars = null,
} = {}) {
  const s = snap.series;
  if (!s || !s.close?.length) throw new Error('Snapshot thiếu series — gọi analyze với includeSeries');

  const hasSetup = setup && setup.side && setup.side !== 'none' && setup.entry != null;

  // Chưa có kèo thì vẫn vẽ hộp — dùng kịch bản đang được điểm ủng hộ, đánh dấu
  // là CHỜ. Nếu không thì ảnh mất hẳn hộp Long/Short mỗi khi cổng đồng thuận
  // chặn, và người xem không biết cần chờ mốc nào.
  let box = hasSetup ? setup : null;
  if (!box && projections) {
    const pick = projections.primary === 'short' ? projections.down
      : projections.primary === 'long' ? projections.up : null;
    if (pick) {
      box = {
        side: pick.direction,
        entry: pick.entry,
        stopLoss: pick.stopLoss,
        targets: pick.targets,
        rrToTp1: pick.rrToStructure,
        pending: true,
      };
    }
  }
  const bars = maxBars ?? (box ? MAX_BARS_WITH_SETUP : MAX_BARS);

  // Chỉ lấy `bars` nến cuối cho dễ đọc. Cắt đồng bộ mọi mảng song song, nếu
  // lệch index thì CVD sẽ không khớp nến.
  const from = Math.max(0, s.close.length - bars);
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
  renderPricePanel(ctx, {
    candles,
    volumeAvg: cut(s.volumeAvg),
    interval: snap.interval,
    width,
    height: priceHeight,
    // KHÔNG vẽ hỗ trợ/kháng cự và tường lệnh trên ảnh: cộng lại là 10 đường kẻ
    // ngang cùng nhãn, che nến và làm rối mắt. Số liệu vẫn có đủ trong caption
    // (buildCaption), và các mức đó vẫn được dùng để tính entry/SL/TP.
    levels: null,
    walls: [],
    setup: box,
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
    forwardRatio: box ? FORWARD_RATIO : 0,
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
