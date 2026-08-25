// Dashboard chạy hoàn toàn trong browser — không cần server.
//
// Import trực tiếp các module lõi trong src/ (cùng code mà bot Telegram dùng):
// dữ liệu lấy thẳng từ Binance, chỉ báo và model ML tính tại máy người dùng,
// Claude gọi trực tiếp bằng API key của chính họ.

// Analysis, models and backtests now run in the Java service.
const INTERVALS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M'];
const INTERVAL_MS = Object.fromEntries(INTERVALS.map((interval) => [interval, 1]));
const normalizeSymbol = (input) => input.trim().toUpperCase().replace(/[\/_\-\s]/g, '');
import {
  loadStrategy, setStrategyValue, flattenStrategy, resetStrategy, overrideCount, isOverridden,
  loadPrompt, savePrompt, resetPrompt, promptIsCustom,
  getApiKey, setApiKey,
} from './store.js';
import { loadModel, saveModel, deleteModel, listModels } from './model-store.js';
import { generateReport, askAbout, testApiKey } from './claude.js';
import { canWrite, csrfFetch, getAuthSession } from './auth.js';

const $ = (id) => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';

const state = {
  snapshot: null,
  strategy: null,
  symbol: null,
  interval: '4h',
  configLoaded: false,
  busy: false,
  worker: null,
  jobId: 0,
  abort: null,
  performanceRange: 'week',
  performanceData: null,
  auth: null,
  canWrite: false,
  profileAvatar: null,
};

// ---------- Tiện ích ----------

function fmtNum(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toLocaleString('vi-VN', { maximumFractionDigits: 2 });
  if (abs >= 1) return v.toFixed(3);
  if (abs >= 0.01) return v.toFixed(5);
  return v.toPrecision(4);
}

function fmtSigned(v, digits = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}`;
}

function fmtPct(v, digits = 1) {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

function fmtTime(ms, interval) {
  const d = new Date(ms);
  if (/[dwM]$/.test(interval)) {
    return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: '2-digit' });
  }
  const date = d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
  return `${date} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function mk(tag, attrs = {}, text) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, String(v));
  if (text != null) node.textContent = String(text);
  return node;
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

function setStatus(text, spinning = false) {
  const el = $('status');
  clear(el);
  if (spinning) {
    const sp = document.createElement('span');
    sp.className = 'spin';
    el.appendChild(sp);
  }
  el.appendChild(document.createTextNode(text ? ` ${text}` : ''));
}

function showBanner(message, kind = 'error') {
  const b = $('banner');
  b.className = `banner ${kind}`;
  b.textContent = message;
}
function hideBanner() { $('banner').className = 'banner hidden'; }

function chip(label, { color, kind } = {}) {
  const span = document.createElement('span');
  span.className = `chip${kind ? ` ${kind}` : ''}`;
  if (color) {
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = color;
    span.appendChild(sw);
  }
  span.appendChild(document.createTextNode(label));
  return span;
}

function legendItem(label, color, dashed = false) {
  const item = document.createElement('span');
  item.className = 'legend-item';
  const sw = document.createElement('span');
  sw.className = 'legend-swatch';
  sw.style.background = dashed
    ? `repeating-linear-gradient(90deg, ${color} 0 4px, transparent 4px 7px)`
    : color;
  item.append(sw, document.createTextNode(label));
  return item;
}

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---------- Thang điểm tổng hợp (diverging) ----------

function drawScoreBar(score, thresholds) {
  const svg = $('score-bar');
  clear(svg);
  const W = 600, padX = 6, trackY = 20, trackH = 16;
  const x = (v) => padX + ((v + 100) / 200) * (W - padX * 2);

  svg.appendChild(mk('rect', {
    x: padX, y: trackY, width: W - padX * 2, height: trackH, rx: 4, fill: cssVar('--div-mid'),
  }));
  for (const [from, to, color] of [
    [-100, thresholds.strongSell, cssVar('--div-neg')],
    [thresholds.strongBuy, 100, cssVar('--div-pos')],
  ]) {
    svg.appendChild(mk('rect', {
      x: x(from), y: trackY, width: Math.max(0, x(to) - x(from)), height: trackH,
      rx: 4, fill: color, opacity: 0.18,
    }));
  }
  for (const v of [-100, thresholds.strongSell, thresholds.sell, 0,
    thresholds.buy, thresholds.strongBuy, 100]) {
    svg.appendChild(mk('line', {
      x1: x(v), y1: trackY - 3, x2: x(v), y2: trackY + trackH + 3,
      class: v === 0 ? 'axis-line' : 'grid-line',
    }));
  }
  svg.appendChild(mk('text', { x: padX, y: trackY + trackH + 16 }, '−100 giảm mạnh'));
  svg.appendChild(mk('text', { x: W / 2, y: trackY + trackH + 16, 'text-anchor': 'middle' }, '0'));
  svg.appendChild(mk('text', { x: W - padX, y: trackY + trackH + 16, 'text-anchor': 'end' }, '+100 tăng mạnh'));

  const color = score >= 0 ? cssVar('--div-pos') : cssVar('--div-neg');
  const from = Math.min(0, score), to = Math.max(0, score);
  svg.appendChild(mk('rect', {
    x: x(from), y: trackY, width: Math.max(2, x(to) - x(from)), height: trackH, rx: 4, fill: color,
  }));
  svg.appendChild(mk('line', {
    x1: x(score), y1: trackY - 7, x2: x(score), y2: trackY + trackH + 7,
    stroke: cssVar('--text-primary'), 'stroke-width': 2,
  }));
  svg.appendChild(mk('text', {
    x: Math.min(W - 26, Math.max(24, x(score))), y: 12,
    'text-anchor': 'middle', class: 'series-label', fill: cssVar('--text-primary'),
  }, fmtSigned(score, 1)));
}

// ---------- Crosshair + tooltip ----------

function attachCrosshair(svg, tip, { plotX, plotW, count, onIndex, top = 0, bottom = 0 }) {
  const cursor = mk('line', {
    y1: top, y2: bottom, class: 'axis-line', 'stroke-dasharray': '3 3', opacity: 0,
  });
  svg.appendChild(cursor);

  const move = (clientX, clientY) => {
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const svgX = ((clientX - rect.left) / rect.width) * vb.width;
    const t = (svgX - plotX) / plotW;
    const i = Math.max(0, Math.min(count - 1, Math.round(t * (count - 1))));
    const cx = plotX + (count > 1 ? (i / (count - 1)) * plotW : plotW / 2);
    cursor.setAttribute('x1', cx);
    cursor.setAttribute('x2', cx);
    cursor.setAttribute('opacity', 1);
    const html = onIndex(i);
    if (!html) return;
    tip.innerHTML = html;
    tip.classList.add('on');
    const wrap = svg.parentElement.getBoundingClientRect();
    const tw = tip.offsetWidth || 160;
    let left = clientX - wrap.left + 14;
    if (left + tw > wrap.width) left = clientX - wrap.left - tw - 14;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${Math.max(4, Math.min(wrap.height - 60, clientY - wrap.top + 12))}px`;
  };
  const leave = () => { cursor.setAttribute('opacity', 0); tip.classList.remove('on'); };

  svg.addEventListener('pointermove', (e) => move(e.clientX, e.clientY));
  svg.addEventListener('pointerleave', leave);
  svg.addEventListener('pointerdown', (e) => move(e.clientX, e.clientY));
}

const ttRow = (label, value) => `<div class="tt-row"><span>${label}</span><span>${value}</span></div>`;

// ---------- Hiệu suất dòng tiền từ lệnh đã đóng ----------

function fmtMoney(value, { signed = false } = {}) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const number = Number(value);
  const sign = signed && number > 0 ? '+' : '';
  return `${sign}${number.toLocaleString('vi-VN', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 2,
  })}`;
}

function renderPerformanceKpis(data) {
  const summary = data.summary;
  const values = [
    ['P&L', `${fmtMoney(summary.pnlUsd, { signed: true })} (${fmtSigned(summary.pnlPercent)}%)`,
      summary.pnlUsd > 0 ? 'delta-up' : summary.pnlUsd < 0 ? 'delta-down' : ''],
    ['Tỷ lệ thắng', summary.winRatePercent == null ? '—' : `${summary.winRatePercent.toFixed(1)}%`, ''],
    ['Thắng / thua', `${summary.wins} / ${summary.losses}`, ''],
    ['TB mỗi lệnh', fmtMoney(summary.averagePnlUsd, { signed: true }),
      summary.averagePnlUsd > 0 ? 'delta-up' : summary.averagePnlUsd < 0 ? 'delta-down' : ''],
    ['Lệnh đã đóng', String(summary.totalTrades), ''],
  ];
  const host = $('performance-kpis');
  clear(host);
  for (const [label, value, cls] of values) {
    const box = document.createElement('div');
    box.className = 'performance-kpi';
    const name = document.createElement('span'); name.textContent = label;
    const result = document.createElement('strong'); result.textContent = value;
    if (cls) result.className = cls;
    box.append(name, result);
    host.appendChild(box);
  }
}

function drawPerformance(data) {
  const svg = $('performance-chart');
  const tip = $('performance-tip');
  const empty = $('performance-empty');
  clear(svg);
  tip.classList.remove('on');
  renderPerformanceKpis(data);

  const mobile = window.innerWidth < 700;
  const W = mobile ? 600 : 1200;
  const H = mobile ? 300 : 260;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const hasTrades = data.summary.totalTrades > 0;
  empty.classList.toggle('hidden', hasTrades);
  empty.textContent = data.message || 'Chưa có lệnh đóng trong khoảng thời gian này.';
  $('performance-note').textContent = `PnL chưa nhân đòn bẩy · vốn giả định ${fmtMoney(data.summary.capitalPerTradeUsd)} mỗi lệnh · múi giờ Việt Nam`;
  if (!hasTrades) return;

  const padL = 58, padR = 22, padT = 16, padB = 35;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const points = data.points;
  const values = points.flatMap((point) => [point.pnlUsd, point.cumulativePnlUsd, 0]);
  let min = Math.min(...values), max = Math.max(...values);
  const span = max - min || Math.max(1, Math.abs(max));
  min -= span * 0.12;
  max += span * 0.12;
  const y = (value) => padT + ((max - value) / (max - min)) * plotH;
  const step = plotW / points.length;
  const x = (index) => padL + (index + 0.5) * step;
  const zeroY = y(0);

  for (let tick = 0; tick <= 4; tick++) {
    const value = min + ((max - min) * tick) / 4;
    const yy = y(value);
    svg.appendChild(mk('line', {
      x1: padL, y1: yy, x2: W - padR, y2: yy,
      class: Math.abs(value) < 1e-9 ? 'axis-line' : 'grid-line',
    }));
    svg.appendChild(mk('text', { x: padL - 7, y: yy + 3, 'text-anchor': 'end' },
      `${value > 0 ? '+' : ''}$${Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1)}`));
  }
  svg.appendChild(mk('line', { x1: padL, y1: zeroY, x2: W - padR, y2: zeroY, class: 'axis-line' }));

  const barWidth = Math.max(3, Math.min(30, step * 0.58));
  points.forEach((point, index) => {
    const yy = y(point.pnlUsd);
    const height = Math.max(1, Math.abs(zeroY - yy));
    svg.appendChild(mk('rect', {
      x: x(index) - barWidth / 2,
      y: point.pnlUsd >= 0 ? yy : zeroY,
      width: barWidth,
      height,
      rx: 2,
      fill: point.pnlUsd >= 0 ? cssVar('--good') : cssVar('--critical'),
      opacity: point.trades ? 0.78 : 0.18,
    }));
  });

  const linePoints = points.map((point, index) => `${x(index)},${y(point.cumulativePnlUsd)}`).join(' ');
  svg.appendChild(mk('polyline', {
    points: linePoints, fill: 'none', stroke: cssVar('--series-1'),
    'stroke-width': 2.2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
  }));
  points.forEach((point, index) => {
    svg.appendChild(mk('circle', {
      cx: x(index), cy: y(point.cumulativePnlUsd), r: points.length > 20 ? 2 : 3,
      fill: cssVar('--series-1'), stroke: cssVar('--surface-1'), 'stroke-width': 1,
    }));
  });

  const labelEvery = Math.max(1, Math.ceil(points.length / 8));
  points.forEach((point, index) => {
    if (index % labelEvery !== 0 && index !== points.length - 1) return;
    svg.appendChild(mk('text', { x: x(index), y: H - 12, 'text-anchor': 'middle' }, point.label));
  });

  attachCrosshair(svg, tip, {
    plotX: x(0), plotW: Math.max(1, x(points.length - 1) - x(0)), count: points.length,
    top: padT, bottom: H - padB,
    onIndex: (index) => {
      const point = points[index];
      return `<div class="tt-time">${point.label}</div>`
        + ttRow('P&L kỳ', `${fmtMoney(point.pnlUsd, { signed: true })} (${fmtSigned(point.pnlPercent)}%)`)
        + ttRow('Tích lũy', fmtMoney(point.cumulativePnlUsd, { signed: true }))
        + ttRow('Thắng / thua', `${point.wins} / ${point.losses}`)
        + ttRow('Lệnh đóng', point.trades);
    },
  });
}

async function loadTradingPerformance(range = state.performanceRange) {
  state.performanceRange = range;
  for (const button of document.querySelectorAll('.performance-range')) {
    button.classList.toggle('active', button.dataset.range === range);
  }
  $('performance-empty').classList.remove('hidden');
  $('performance-empty').textContent = 'Đang tải dữ liệu lệnh…';
  try {
    const response = await fetch(`/api/trading-performance?range=${encodeURIComponent(range)}`, {
      headers: { accept: 'application/json' }, cache: 'no-store',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    state.performanceData = data;
    drawPerformance(data);
  } catch {
    state.performanceData = null;
    $('performance-empty').classList.remove('hidden');
    $('performance-empty').textContent = 'Không tải được lịch sử lệnh. Hãy mở trang bằng Java server.';
    $('performance-note').textContent = '';
  }
}

// ---------- Biểu đồ giá ----------

function drawPriceChart(snap) {
  const svg = $('price-chart');
  const tip = $('price-tip');
  clear(svg);
  const s = snap.series;
  if (!s || !s.close.length) return;

  const W = 900, H = 460;
  const padL = 6, padR = 66, padT = 10;
  const priceTop = padT, priceH = 320;
  const volTop = priceTop + priceH + 34, volH = 62;
  const plotW = W - padL - padR;
  const n = s.close.length;

  const lows = s.low.filter((v) => v != null);
  const highs = s.high.filter((v) => v != null);
  const srPrices = [...snap.structure.support, ...snap.structure.resistance]
    .filter((l) => Math.abs(l.distancePct) < 12).map((l) => l.price);

  let min = Math.min(...lows, ...srPrices);
  let max = Math.max(...highs, ...srPrices);
  const pad = (max - min) * 0.06 || Math.abs(max) * 0.01 || 1;
  min -= pad; max += pad;

  const x = (i) => padL + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
  const y = (v) => priceTop + priceH - ((v - min) / (max - min)) * priceH;
  const step = plotW / Math.max(1, n - 1);
  const bodyW = Math.max(1.2, Math.min(9, step * 0.62));

  for (let k = 0; k <= 5; k++) {
    const v = min + ((max - min) * k) / 5;
    const yy = y(v);
    svg.appendChild(mk('line', { x1: padL, y1: yy, x2: W - padR, y2: yy, class: 'grid-line' }));
    svg.appendChild(mk('text', { x: W - padR + 5, y: yy + 3 }, fmtNum(v)));
  }

  // Hỗ trợ/kháng cự là khung tham chiếu duy nhất trên biểu đồ giá — không còn
  // EMA hay Bollinger (xem .claude/skills/chi-bao/SKILL.md).
  const srColor = { support: cssVar('--good'), resistance: cssVar('--critical') };
  for (const kind of ['support', 'resistance']) {
    for (const lvl of snap.structure[kind].slice(0, 3)) {
      if (lvl.price < min || lvl.price > max) continue;
      const yy = y(lvl.price);
      // Mức bị chạm nhiều lần thì vẽ dày hơn.
      svg.appendChild(mk('line', {
        x1: padL, y1: yy, x2: W - padR, y2: yy,
        stroke: srColor[kind], 'stroke-width': Math.min(2.5, 1 + (lvl.touches - 1) * 0.5),
        'stroke-dasharray': '5 4', opacity: 0.75,
      }));
      svg.appendChild(mk('text', {
        x: W - padR - 3, y: yy - 3, 'text-anchor': 'end',
        fill: srColor[kind], class: 'series-label',
      }, `${kind === 'support' ? 'HT' : 'KC'} ${fmtNum(lvl.price)} · ${lvl.touches}x`));
    }
  }

  const up = cssVar('--up'), down = cssVar('--down');
  for (let i = 0; i < n; i++) {
    const o = s.open[i], c = s.close[i], h = s.high[i], l = s.low[i];
    if ([o, c, h, l].some((v) => v == null)) continue;
    const col = c >= o ? up : down;
    svg.appendChild(mk('line', { x1: x(i), y1: y(h), x2: x(i), y2: y(l), stroke: col, 'stroke-width': 1 }));
    svg.appendChild(mk('rect', {
      x: x(i) - bodyW / 2, y: y(Math.max(o, c)), width: bodyW,
      height: Math.max(1, Math.abs(y(o) - y(c))), fill: col, rx: Math.min(1.5, bodyW / 3),
    }));
  }

  // Tường lệnh trong sổ lệnh: vẽ như mức ngang, chỉ khi nằm trong khung giá.
  for (const w of snap.orderBook?.walls ?? []) {
    if (w.price < min || w.price > max) continue;
    const yy = y(w.price);
    const col = w.side === 'bid' ? cssVar('--good') : cssVar('--critical');
    svg.appendChild(mk('line', {
      x1: padL, y1: yy, x2: W - padR, y2: yy,
      stroke: col, 'stroke-width': 3, opacity: 0.3,
    }));
    svg.appendChild(mk('text', {
      x: padL + 3, y: yy - 3, fill: col, class: 'series-label',
    }, `Tường ${w.side === 'bid' ? 'MUA' : 'BÁN'} ${w.ratioToAvg.toFixed(1)}x`));
  }

  const maxVol = Math.max(...s.volume.filter(Number.isFinite), 1);
  const vy = (v) => volTop + volH - (v / maxVol) * volH;
  svg.appendChild(mk('line', {
    x1: padL, y1: volTop + volH, x2: W - padR, y2: volTop + volH, class: 'axis-line',
  }));
  svg.appendChild(mk('text', { x: padL, y: volTop - 4 }, 'Khối lượng'));
  for (let i = 0; i < n; i++) {
    const v = s.volume[i];
    if (!Number.isFinite(v)) continue;
    svg.appendChild(mk('rect', {
      x: x(i) - bodyW / 2, y: vy(v), width: bodyW,
      height: Math.max(0.6, volTop + volH - vy(v)),
      fill: s.close[i] >= s.open[i] ? up : down, opacity: 0.45, rx: Math.min(1.5, bodyW / 3),
    }));
  }
  const volAvgPts = [];
  for (let i = 0; i < n; i++) if (s.volumeAvg[i] != null) volAvgPts.push(`${x(i)},${vy(s.volumeAvg[i])}`);
  if (volAvgPts.length > 2) {
    svg.appendChild(mk('polyline', {
      points: volAvgPts.join(' '), fill: 'none', stroke: cssVar('--text-muted'),
      'stroke-width': 1.5, 'stroke-dasharray': '4 3',
    }));
  }

  const tickEvery = Math.max(1, Math.floor(n / 7));
  for (let i = 0; i < n; i += tickEvery) {
    svg.appendChild(mk('text', {
      x: x(i), y: H - 4, 'text-anchor': i === 0 ? 'start' : 'middle',
    }, fmtTime(s.time[i], snap.interval)));
  }

  attachCrosshair(svg, tip, {
    plotX: padL, plotW, count: n, top: priceTop, bottom: volTop + volH,
    onIndex: (i) => {
      const changePct = ((s.close[i] - s.open[i]) / s.open[i]) * 100;
      const share = s.volume[i] ? (s.cvdDelta[i] / s.volume[i]) * 100 : null;
      return `<div class="tt-time">${fmtTime(s.time[i], snap.interval)}</div>`
        + ttRow('Mở', fmtNum(s.open[i])) + ttRow('Cao', fmtNum(s.high[i]))
        + ttRow('Thấp', fmtNum(s.low[i]))
        + ttRow('Đóng', `${fmtNum(s.close[i])} (${fmtSigned(changePct)}%)`)
        + ttRow('Khối lượng', fmtNum(s.volume[i]))
        + ttRow('Mua chủ động', share == null ? '—' : `${fmtSigned(share)}% KL`);
    },
  });

  const lg = $('price-legend');
  clear(lg);
  lg.append(
    legendItem('Hỗ trợ', cssVar('--good'), true),
    legendItem('Kháng cự', cssVar('--critical'), true),
    legendItem('Khối lượng TB', cssVar('--text-muted'), true),
  );
  $('price-chart-sub').textContent =
    `${n} nến ${snap.interval} · nến xanh = đóng cao hơn mở · HT/KC kèm số lần chạm`;

  renderCandleTable(snap);
}

function renderCandleTable(snap) {
  const s = snap.series;
  const host = $('candle-table');
  clear(host);
  const table = document.createElement('table');
  const head = document.createElement('thead');
  head.innerHTML = '<tr><th>Thời gian</th><th class="num">Mở</th><th class="num">Cao</th>'
    + '<th class="num">Thấp</th><th class="num">Đóng</th><th class="num">%</th>'
    + '<th class="num">Mua CĐ</th></tr>';
  const body = document.createElement('tbody');
  for (let i = Math.max(0, s.close.length - 10); i < s.close.length; i++) {
    const chg = ((s.close[i] - s.open[i]) / s.open[i]) * 100;
    const tr = document.createElement('tr');
    for (const [text, cls] of [
      [fmtTime(s.time[i], snap.interval), ''],
      [fmtNum(s.open[i]), 'num'], [fmtNum(s.high[i]), 'num'],
      [fmtNum(s.low[i]), 'num'], [fmtNum(s.close[i]), 'num'],
      [`${fmtSigned(chg)}%`, `num ${chg >= 0 ? 'delta-up' : 'delta-down'}`],
      [s.volume[i] && s.cvdDelta[i] != null
        ? `${fmtSigned((s.cvdDelta[i] / s.volume[i]) * 100)}%` : '—',
      `num ${(s.cvdDelta[i] ?? 0) >= 0 ? 'delta-up' : 'delta-down'}`],
    ]) {
      const td = document.createElement('td');
      td.className = cls;
      td.textContent = text;
      tr.appendChild(td);
    }
    body.append(tr);
  }
  table.append(head, body);
  host.appendChild(table);
}

// ---------- CVD luỹ tiến ----------

function drawCvd(snap) {
  const svg = $('cvd-chart');
  const tip = $('cvd-tip');
  clear(svg);
  const s = snap.series;
  const W = 420, H = 130, padL = 4, padR = 44, padT = 14, padB = 16;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = s.cvd.length;
  const vals = s.cvd.filter((v) => v != null);
  if (!vals.length) return;
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || Math.abs(hi) || 1;
  const x = (i) => padL + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
  const y = (v) => padT + plotH - ((v - lo) / span) * plotH;

  for (const v of [lo, lo + span / 2, hi]) {
    svg.appendChild(mk('line', {
      x1: padL, y1: y(v), x2: W - padR, y2: y(v), class: 'grid-line',
    }));
    svg.appendChild(mk('text', { x: W - padR + 4, y: y(v) + 3 }, fmtNum(v)));
  }

  const pts = [];
  for (let i = 0; i < n; i++) if (s.cvd[i] != null) pts.push(`${x(i)},${y(s.cvd[i])}`);
  if (pts.length > 1) {
    svg.appendChild(mk('polyline', {
      points: pts.join(' '), fill: 'none', stroke: cssVar('--series-1'),
      'stroke-width': 2, 'stroke-linejoin': 'round',
    }));
  }
  const lastCvd = [...s.cvd].reverse().find((v) => v != null);
  if (lastCvd != null) {
    svg.appendChild(mk('circle', {
      cx: x(n - 1), cy: y(lastCvd), r: 4.5,
      fill: cssVar('--series-1'), stroke: cssVar('--surface-1'), 'stroke-width': 2,
    }));
  }

  const slope = snap.indicators.cvdSlope;
  svg.appendChild(mk('text', {
    x: padL, y: 10, class: 'series-label', fill: cssVar('--text-secondary'),
  }, `CVD luỹ tiến · ${snap.indicatorParams?.cvdSlope ?? 20} nến: `
    + `${slope == null ? '—' : fmtSigned(slope * 100)}% khối lượng`));

  attachCrosshair(svg, tip, {
    plotX: padL, plotW, count: n, top: padT, bottom: padT + plotH,
    onIndex: (i) => (s.cvd[i] == null ? null
      : `<div class="tt-time">${fmtTime(s.time[i], snap.interval)}</div>`
        + ttRow('CVD', fmtNum(s.cvd[i]))
        + ttRow('Độ dốc', s.cvdSlope[i] == null ? '—' : `${fmtSigned(s.cvdSlope[i] * 100)}% KL`)),
  });
}

// ---------- Delta từng nến ----------

function drawFlow(snap) {
  const svg = $('flow-chart');
  const tip = $('flow-tip');
  clear(svg);
  const s = snap.series;
  const W = 420, H = 120, padL = 4, padR = 44, padT = 14, padB = 14;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = s.cvdDelta.length;
  // Chuẩn hoá delta theo volume từng nến -> so được giữa các nến to nhỏ khác nhau.
  const share = s.cvdDelta.map((d, i) => (d != null && s.volume[i] ? d / s.volume[i] : null));
  const extent = Math.max(...share.filter((v) => v != null).map(Math.abs), 0.05);
  const x = (i) => padL + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
  const y = (v) => padT + plotH / 2 - (v / extent) * (plotH / 2);
  const barW = Math.max(1, Math.min(6, (plotW / Math.max(1, n - 1)) * 0.6));

  svg.appendChild(mk('line', { x1: padL, y1: y(0), x2: W - padR, y2: y(0), class: 'axis-line' }));
  for (let i = 0; i < n; i++) {
    const v = share[i];
    if (v == null) continue;
    svg.appendChild(mk('rect', {
      x: x(i) - barW / 2, y: v >= 0 ? y(v) : y(0), width: barW,
      height: Math.max(0.8, Math.abs(y(v) - y(0))),
      fill: v >= 0 ? cssVar('--up') : cssVar('--down'), opacity: 0.75, rx: Math.min(1.5, barW / 3),
    }));
  }
  svg.appendChild(mk('text', {
    x: padL, y: 10, class: 'series-label', fill: cssVar('--text-secondary'),
  }, 'Mua chủ động ròng mỗi nến (% khối lượng)'));
  svg.appendChild(mk('text', { x: W - padR + 4, y: y(0) + 3 }, '0'));
  svg.appendChild(mk('text', { x: W - padR + 4, y: y(extent) + 3 }, `+${(extent * 100).toFixed(0)}%`));
  svg.appendChild(mk('text', { x: W - padR + 4, y: y(-extent) + 3 }, `−${(extent * 100).toFixed(0)}%`));

  attachCrosshair(svg, tip, {
    plotX: padL, plotW, count: n, top: padT, bottom: padT + plotH,
    onIndex: (i) => (share[i] == null ? null
      : `<div class="tt-time">${fmtTime(s.time[i], snap.interval)}</div>`
        + ttRow('Mua chủ động', `${fmtSigned(share[i] * 100)}% KL`)
        + ttRow('Delta', fmtNum(s.cvdDelta[i]))
        + ttRow('Khối lượng', fmtNum(s.volume[i]))),
  });

  const lg = $('osc-legend');
  clear(lg);
  lg.append(
    legendItem('CVD luỹ tiến', cssVar('--series-1')),
    legendItem('Mua chủ động', cssVar('--up')),
    legendItem('Bán chủ động', cssVar('--down')),
  );
}

// ---------- Đóng góp từng nhóm ----------

const GROUP_LABELS = {
  cvd: 'CVD', volume: 'Khối lượng', derivatives: 'Phái sinh (OI + funding)', positioning: 'Định vị đám đông',
  structure: 'Hỗ trợ/kháng cự', orderBook: 'Sổ lệnh', historicalPattern: 'Mẫu hình lịch sử',
};

function drawBreakdown(snap) {
  const svg = $('breakdown-chart');
  const tip = $('breakdown-tip');
  clear(svg);
  const entries = Object.entries(snap.rules.breakdown)
    .filter(([, v]) => v.weight > 0)
    .sort((a, b) => Math.abs(b[1].contributionPct) - Math.abs(a[1].contributionPct));
  if (!entries.length) return;

  const rowH = 30, W = 560, padL = 106, padR = 54, padT = 22;
  const H = padT + entries.length * rowH + 14;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const plotW = W - padL - padR;
  const maxAbs = Math.max(...entries.map(([, v]) => Math.abs(v.contributionPct)), 8);
  const cx = padL + plotW / 2;
  const x = (v) => cx + (v / maxAbs) * (plotW / 2);

  svg.appendChild(mk('text', { x: padL, y: 12 }, '← nghiêng giảm'));
  svg.appendChild(mk('text', { x: W - padR, y: 12, 'text-anchor': 'end' }, 'nghiêng tăng →'));
  svg.appendChild(mk('line', { x1: cx, y1: padT - 6, x2: cx, y2: H - 10, class: 'axis-line' }));

  entries.forEach(([key, v], idx) => {
    const yTop = padT + idx * rowH + 5;
    const barH = 15;
    const val = v.contributionPct;
    const color = val >= 0 ? cssVar('--div-pos') : cssVar('--div-neg');
    const from = Math.min(0, val), to = Math.max(0, val);

    svg.appendChild(mk('rect', {
      x: x(from), y: yTop, width: Math.max(2, x(to) - x(from)), height: barH, rx: 4,
      fill: color, stroke: cssVar('--surface-1'), 'stroke-width': 1,
    }));
    svg.appendChild(mk('text', {
      x: padL - 8, y: yTop + barH - 3, 'text-anchor': 'end', fill: cssVar('--text-secondary'),
    }, GROUP_LABELS[key] || key));
    svg.appendChild(mk('text', {
      x: val >= 0 ? x(to) + 5 : x(from) - 5, y: yTop + barH - 3,
      'text-anchor': val >= 0 ? 'start' : 'end',
      fill: cssVar('--text-primary'), class: 'series-label',
    }, fmtSigned(val, 1)));

    const hit = mk('rect', { x: padL, y: yTop - 6, width: plotW, height: rowH, fill: 'transparent' });
    hit.addEventListener('pointerenter', (e) => {
      tip.innerHTML = `<div class="tt-time">${GROUP_LABELS[key] || key}</div>`
        + ttRow('Đóng góp', fmtSigned(val, 2))
        + ttRow('Điểm nhóm', fmtSigned(v.score * 100, 0))
        + ttRow('Trọng số', v.weight);
      tip.classList.add('on');
      const wrap = svg.parentElement.getBoundingClientRect();
      tip.style.left = `${Math.min(wrap.width - 180, e.clientX - wrap.left + 12)}px`;
      tip.style.top = `${e.clientY - wrap.top + 10}px`;
    });
    hit.addEventListener('pointerleave', () => tip.classList.remove('on'));
    svg.appendChild(hit);
  });

  const host = $('breakdown-reasons');
  clear(host);
  for (const [key, v] of entries) {
    const det = document.createElement('details');
    const sum = document.createElement('summary');
    sum.className = 'small';
    sum.style.cssText = 'cursor:pointer; padding:3px 0';
    sum.textContent = `${GROUP_LABELS[key] || key} — ${fmtSigned(v.contributionPct, 1)} (trọng số ${v.weight})`;
    const ul = document.createElement('ul');
    ul.className = 'notes';
    for (const r of v.reasons) {
      const li = document.createElement('li');
      li.textContent = r;
      ul.appendChild(li);
    }
    det.append(sum, ul);
    host.appendChild(det);
  }
}

// ---------- Thẻ số liệu ----------

function renderHero(snap) {
  const signalColors = {
    'MUA MẠNH': cssVar('--good'), MUA: cssVar('--good'),
    'TRUNG LẬP': cssVar('--text-muted'),
    BÁN: cssVar('--critical'), 'BÁN MẠNH': cssVar('--critical'),
  };
  const label = $('signal-label');
  clear(label);
  const dot = document.createElement('span');
  dot.className = 'signal-dot';
  dot.style.background = signalColors[snap.combined.signal] || cssVar('--text-muted');
  label.append(dot, document.createTextNode(snap.combined.signal));

  const chg = snap.price.change24hPercent;
  const priceLine = $('price-line');
  clear(priceLine);
  priceLine.appendChild(document.createTextNode(fmtNum(snap.price.live)));
  if (chg != null) {
    const sp = document.createElement('span');
    sp.className = `small ${chg >= 0 ? 'delta-up' : 'delta-down'}`;
    sp.style.marginLeft = '8px';
    sp.textContent = `${fmtSigned(chg)}% / 24h`;
    priceLine.appendChild(sp);
  }

  const drift = ((snap.price.live - snap.price.lastClose) / snap.price.lastClose) * 100;
  $('price-sub').textContent = `${snap.symbol} · ${snap.interval} · nến đã đóng gần nhất `
    + `${fmtTime(new Date(snap.lastClosedCandleTime).getTime(), snap.interval)} `
    + `tại ${fmtNum(snap.price.lastClose)}`
    + (Math.abs(drift) >= 0.15 ? ` (giá đã chạy ${fmtSigned(drift)}% từ lúc đó)` : '');

  $('score-value').textContent = fmtSigned(snap.combined.score, 1);
  drawScoreBar(snap.combined.score, state.strategy.thresholds);

  const parts = $('score-parts');
  clear(parts);
  parts.appendChild(chip(`Quy tắc ${fmtSigned(snap.rules.score, 1)}`));
  if (snap.ml.available) {
    const used = snap.combined.mlWeightUsed > 0;
    parts.appendChild(chip(
      `ML ${snap.ml.probUpPercent}% tăng${used ? ` · trọng số ${snap.combined.mlWeightUsed}` : ' · KHÔNG tính vào điểm'}`,
      { kind: used ? 'ok' : 'warn' },
    ));
  } else {
    parts.appendChild(chip('Chưa có model ML', { kind: 'warn' }));
  }
  if (snap.higherTimeframe && typeof snap.higherTimeframe.ruleScore === 'number') {
    parts.appendChild(chip(`Khung ${snap.higherTimeframe.interval}: ${snap.higherTimeframe.signal} `
      + `(${fmtSigned(snap.higherTimeframe.ruleScore, 0)})`));
  }

  const list = $('conflicts');
  clear(list);
  for (const c of snap.conflicts) {
    const li = document.createElement('li');
    li.className = 'alert';
    li.textContent = c;
    list.appendChild(li);
  }
}

function renderLevels(snap) {
  const host = $('levels-body');
  clear(host);
  const lv = snap.levels;
  $('levels-sub').textContent = lv.side === 'none'
    ? 'Không có setup rõ ràng'
    : `Setup ${lv.side === 'long' ? 'LONG' : 'SHORT'} — mức tham chiếu tính từ giá đóng nến`;

  const table = document.createElement('table');
  const body = document.createElement('tbody');
  const row = (label, value, extra, cls) => {
    const tr = document.createElement('tr');
    const th = document.createElement('th'); th.textContent = label;
    const td = document.createElement('td'); td.className = `num ${cls || ''}`; td.textContent = value;
    const td2 = document.createElement('td'); td2.className = 'num muted small'; td2.textContent = extra || '';
    tr.append(th, td, td2);
    body.appendChild(tr);
  };
  if (lv.side !== 'none') {
    row('Entry', fmtNum(lv.entry), '');
    row('Stop loss', fmtNum(lv.stopLoss), `rủi ro ${lv.riskPercent}%`, 'delta-down');
    for (const t of lv.targets) {
      const pct = ((t.price - lv.entry) / lv.entry) * 100;
      row(`${t.label} (${t.r}R)`, fmtNum(t.price), `${fmtSigned(pct)}%`, 'delta-up');
    }
  }
  table.appendChild(body);
  host.appendChild(table);

  for (const [title, arr, color] of [
    ['Kháng cự', snap.structure.resistance, cssVar('--critical')],
    ['Hỗ trợ', snap.structure.support, cssVar('--good')],
  ]) {
    if (!arr.length) continue;
    const h = document.createElement('div');
    h.className = 'small';
    h.style.cssText = 'margin:12px 0 4px; font-weight:600';
    h.append(chip(title, { color }));
    host.appendChild(h);
    const t2 = document.createElement('table');
    const b2 = document.createElement('tbody');
    for (const l of arr.slice(0, 4)) {
      const tr = document.createElement('tr');
      for (const [txt, cls] of [
        [fmtNum(l.price), 'num'],
        [`${fmtSigned(l.distancePct)}%`, 'num'],
        [`${l.touches} lần chạm`, 'num muted small'],
      ]) {
        const td = document.createElement('td');
        td.className = cls;
        td.textContent = txt;
        tr.appendChild(td);
      }
      b2.appendChild(tr);
    }
    t2.appendChild(b2);
    host.appendChild(t2);
  }
}

function renderIndicators(snap) {
  const host = $('indicators-body');
  clear(host);
  const i = snap.indicators;
  const dl = document.createElement('dl');
  dl.className = 'kv';
  const rows = [
    ['Khối lượng', `${fmtNum(i.volume)} (${i.volumeRatio}x trung bình)`],
    ['CVD luỹ tiến', fmtNum(i.cvd)],
    ['Mua chủ động nến này',
      i.cvdDeltaShare == null ? '—' : `${fmtSigned(i.cvdDeltaShare * 100)}% khối lượng`],
    [`CVD ${snap.indicatorParams?.cvdSlope ?? 20} nến`,
      i.cvdSlope == null ? '—' : `${fmtSigned(i.cvdSlope * 100)}% khối lượng cùng kỳ`],
  ];
  if (snap.derivatives?.fundingRate != null) {
    rows.push(['Funding rate', `${snap.derivatives.fundingRatePercent}%`]);
    if (snap.derivatives.openInterestChangePct != null) {
      rows.push(['Open interest', `${fmtSigned(snap.derivatives.openInterestChangePct)}%`]);
    }
  }
  if (snap.orderBook) {
    rows.push(['Lệch sổ lệnh', `${fmtSigned(snap.orderBook.imbalance * 100)}%`]);
    if (snap.orderBook.depthSpanPct != null) {
      rows.push(['Độ trải sổ lệnh', `±${snap.orderBook.depthSpanPct.toFixed(2)}%`]);
    }
    for (const w of snap.orderBook.walls ?? []) {
      rows.push([`Tường ${w.side === 'bid' ? 'mua' : 'bán'}`,
        `${fmtNum(w.price)} (${fmtSigned(w.distancePct)}%, ${w.ratioToAvg.toFixed(1)}x TB)`]);
    }
  }
  if (snap.historicalPattern?.available) {
    const hp = snap.historicalPattern;
    rows.push(['Mẫu hình lịch sử', `${hp.matched} mẫu, giống TB ${hp.avgSimilarity}%`]);
    rows.push(['Sai số chart tương đối', `TB ${hp.avgRelativePathError}% · P95 ${hp.avgP95RelativePathError}% · ${hp.avgBarsWithinRelativeTolerancePercent}% nến trong tolerance`]);
    rows.push(['Diễn biến sau mẫu', `${hp.side === 'long' ? 'Tăng' : 'Giảm'} TB ${fmtSigned(hp.avgForwardReturnPct)}% sau ${hp.futureBars} nến`]);
  }
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = String(v);
    dl.append(dt, dd);
  }
  host.appendChild(dl);
}

// ---------- Điều phối ----------

function renderAll(snap) {
  state.snapshot = snap;
  renderHero(snap);
  drawPriceChart(snap);
  drawCvd(snap);
  drawFlow(snap);
  drawBreakdown(snap);
  renderLevels(snap);
  renderIndicators(snap);
  updateTargetLabel();
}

/**
 * Token đang chọn = ô nhập, luôn luôn. Không có fallback về BTC: nếu để trống
 * thì báo lỗi chứ không âm thầm phân tích một token khác.
 */
async function selectedSymbol() {
  const raw = $('symbol').value.trim();
  if (!raw) throw new Error('Nhập mã token trước đã (ví dụ BTC, ETH, SOL).');
  // Đối chiếu danh sách cặp thật của Binance thay vì đoán, để "wbtc" ra WBTCUSDT
  // còn "ethbtc" ra ETHBTC.
  // Java resolves the live Binance symbol and enforces its whitelist.
  return raw;
}

/** Cho người dùng thấy train/backtest sẽ chạy trên token nào. */
function updateTargetLabel() {
  const el = $('train-target');
  if (!el) return;
  const raw = $('symbol').value.trim();
  if (!raw) {
    el.textContent = 'Chưa chọn token';
    return;
  }
  try {
    el.textContent = `Sẽ train: ${normalizeSymbol(raw)} ${$('interval').value}`;
  } catch {
    // Đang gõ dở, chưa thành mã hợp lệ.
    el.textContent = 'Chưa chọn token';
  }
}

async function runAnalyze() {
  if (state.busy) return;
  state.busy = true;
  hideBanner();
  const interval = $('interval').value;
  $('btn-analyze').disabled = true;
  setStatus('đang lấy dữ liệu Binance…', true);
  try {
    const symbol = await selectedSymbol();
    state.symbol = symbol;
    state.interval = interval;
    let response;
    if (state.canWrite) {
      state.strategy = await loadStrategy();
      response = await csrfFetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ symbol, interval, bars: 180, strategy: state.strategy }),
      });
    } else {
      const params = new URLSearchParams({ symbol, interval, bars: '180' });
      response = await fetch(`/api/analyze?${params}`, { cache: 'no-store' });
    }
    const snap = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(snap.error || `HTTP ${response.status}`);
    renderAll(snap);
    setStatus(`cập nhật ${new Date().toLocaleTimeString('vi-VN')}`);
    const q = new URLSearchParams({ symbol, interval });
    history.replaceState(null, '', `?${q}`);
  } catch (err) {
    showBanner(err.message);
    setStatus('lỗi');
  } finally {
    state.busy = false;
    $('btn-analyze').disabled = false;
  }
}

// ---------- Claude ----------

async function runAiReport() {
  if (!getApiKey()) {
    switchTab('tab-settings');
    showBanner('Chưa có API key của Claude. Nhập key ở tab "Cài đặt AI" — key chỉ lưu trong '
      + 'trình duyệt của bạn và chỉ gửi tới api.anthropic.com.', 'warn');
    return;
  }
  if (!state.snapshot) await runAnalyze();
  if (!state.snapshot) return;

  switchTab('tab-ai');
  const out = $('ai-report');
  out.textContent = '';
  const live = document.createElement('div');
  const waiting = document.createElement('div');
  waiting.className = 'small muted';
  waiting.innerHTML = '<span class="spin"></span> Claude đang đọc số liệu và suy luận…';
  out.append(waiting, live);

  $('btn-ai').disabled = true;
  setStatus('AI đang suy luận…', true);
  state.abort = new AbortController();
  try {
    const r = await generateReport(state.snapshot, state.strategy, {
      signal: state.abort.signal,
      onDelta: (_chunk, full) => {
        waiting.remove();
        live.textContent = full;
      },
    });
    waiting.remove();
    if (r.refusal) {
      live.textContent = `Claude từ chối trả lời: ${r.refusal}`;
    } else {
      live.textContent = r.text;
      const foot = document.createElement('div');
      foot.className = 'small muted';
      foot.style.marginTop = '12px';
      foot.textContent = `${r.model}`
        + (r.usage ? ` · ${r.usage.inputTokens} token vào / ${r.usage.outputTokens} token ra` : '')
        + (r.truncated ? ' · BỊ CẮT vì đạt giới hạn token (tăng llm.maxTokens ở tab Cấu hình)' : '');
      out.appendChild(foot);
    }
    setStatus('xong');
  } catch (err) {
    waiting.remove();
    live.textContent = err.name === 'AbortError' ? 'Đã huỷ.' : `Lỗi: ${err.message}`;
    setStatus('lỗi');
  } finally {
    $('btn-ai').disabled = false;
    state.abort = null;
  }
}

async function runAsk() {
  const q = $('ask-input').value.trim();
  if (!q) return;
  if (!state.snapshot) { showBanner('Hãy phân tích một token trước.', 'warn'); return; }
  if (!getApiKey()) { switchTab('tab-settings'); showBanner('Chưa có API key của Claude.', 'warn'); return; }

  const out = $('ai-report');
  out.textContent = '';
  const live = document.createElement('div');
  const waiting = document.createElement('div');
  waiting.className = 'small muted';
  waiting.innerHTML = '<span class="spin"></span> Đang suy nghĩ…';
  out.append(waiting, live);
  $('btn-ask').disabled = true;
  try {
    const r = await askAbout(state.snapshot, q, state.strategy, {
      onDelta: (_c, full) => { waiting.remove(); live.textContent = full; },
    });
    waiting.remove();
    live.textContent = r.refusal ? `Claude từ chối: ${r.refusal}` : r.text;
  } catch (err) {
    waiting.remove();
    live.textContent = `Lỗi: ${err.message}`;
  } finally {
    $('btn-ask').disabled = false;
  }
}

// ---------- Worker: train & backtest ----------

function getWorker() {
  if (!state.worker) {
    state.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  }
  return state.worker;
}

function runWorkerJob(kind, message, { logEl, resultEl, button, onDone }) {
  logEl.classList.remove('hidden');
  logEl.textContent = '';
  clear(resultEl);
  button.disabled = true;
  setStatus(`${kind} đang chạy…`, true);

  const id = ++state.jobId;
  const worker = getWorker();
  const appendLog = (msg) => {
    logEl.textContent += `${msg}\n`;
    logEl.scrollTop = logEl.scrollHeight;
  };

  const handler = (e) => {
    const d = e.data;
    if (d.id !== id) return;
    if (d.type === 'progress') { appendLog(d.message); return; }
    worker.removeEventListener('message', handler);
    button.disabled = false;
    if (d.type === 'done') {
      appendLog('— hoàn tất —');
      setStatus('xong');
      onDone(d.result);
    } else {
      appendLog(`LỖI: ${d.error}`);
      setStatus('lỗi');
    }
  };
  worker.addEventListener('message', handler);
  worker.addEventListener('error', (e) => {
    appendLog(`LỖI worker: ${e.message}`);
    button.disabled = false;
    setStatus('lỗi');
  }, { once: true });
  worker.postMessage({ ...message, id });
}

async function runTrain() {
  // Lấy từ ô nhập, KHÔNG lấy từ snapshot cũ: người dùng có thể đã đổi token mà
  // chưa bấm Phân tích, khi đó train phải theo token mới.
  let symbol;
  try {
    symbol = await selectedSymbol();
  } catch (err) {
    return showBanner(err.message);
  }
  const interval = $('interval').value;
  const strategy = state.strategy || await loadStrategy();
  runWorkerJob('Train', { job: 'train', symbol, interval, strategy }, {
    logEl: $('train-log'),
    resultEl: $('train-result'),
    button: $('btn-train'),
    onDone: ({ payload, verdict }) => {
      const saved = saveModel(payload.symbol, payload.interval, payload);
      renderTrainResult(payload, verdict, saved);
      loadModelsList();
      runAnalyze();
    },
  });
}

function renderTrainResult(p, verdict, saved) {
  const host = $('train-result');
  clear(host);
  const m = p.metrics;

  const head = document.createElement('div');
  head.className = 'banner';
  head.style.marginBottom = '12px';
  head.textContent = verdict;
  if (/TỐT/.test(verdict)) head.style.borderColor = cssVar('--good');
  else if (/KHÔNG ĐÁNG TIN|KÉM/.test(verdict)) head.classList.add('error');
  else head.classList.add('warn');
  host.appendChild(head);

  if (saved && !saved.ok) {
    const w = document.createElement('div');
    w.className = 'banner error';
    w.style.marginBottom = '12px';
    w.textContent = `${saved.error} — model vẫn dùng được cho phiên này nhưng sẽ mất khi tải lại trang.`;
    host.appendChild(w);
  }

  const grid = document.createElement('div');
  grid.className = 'grid-3';
  grid.append(
    statTile('AUC holdout', String(m.test?.auc ?? '—'), '0.5 = tung xu'),
    statTile('AUC walk-forward', String(m.walkForward?.meanAuc ?? '—'),
      `${m.walkForward?.folds?.length || 0} fold`),
    statTile('Đúng khi tự tin nhất',
      m.tail?.combinedAccuracy != null ? fmtPct(m.tail.combinedAccuracy) : '—',
      m.tail ? `trên ${m.tail.bullishSignals + m.tail.bearishSignals} lần` : ''),
  );
  host.appendChild(grid);

  const dl = document.createElement('dl');
  dl.className = 'kv';
  dl.style.marginTop = '12px';
  const rows = [
    ['Nến dùng để train', `${p.candleRange.count} (${p.candleRange.from.slice(0, 10)} → ${p.candleRange.to.slice(0, 10)})`],
    ['Mẫu học', `${p.dataset.samples} (bỏ ${p.dataset.skippedNeutral} mẫu nhiễu)`],
    ['Nhãn', `${p.dataset.thresholdMode}, horizon ${p.dataset.horizon} nến`],
    ['Cây giữ lại', `${p.model.trees.length} / ${m.earlyStopping?.maxTrees} (dừng sớm theo ${m.earlyStopping?.metric})`],
  ];
  if (m.simulation?.trades) {
    rows.push(['Mô phỏng (không SL)',
      `${m.simulation.trades} lệnh, thắng ${fmtPct(m.simulation.winRate)}, tổng ${m.simulation.totalReturnPercent}%`]);
  }
  if (saved?.ok) rows.push(['Đã lưu vào trình duyệt', `${(saved.bytes / 1024).toFixed(0)} KB`]);
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = String(v);
    dl.append(dt, dd);
  }
  host.appendChild(dl);

  if (p.importance?.length) {
    const det = document.createElement('details');
    det.style.marginTop = '10px';
    const sum = document.createElement('summary');
    sum.className = 'small muted';
    sum.style.cursor = 'pointer';
    sum.textContent = 'Top chỉ báo model dựa vào';
    const ul = document.createElement('ul');
    ul.className = 'notes';
    for (const f of p.importance.slice(0, 10)) {
      const li = document.createElement('li');
      li.textContent = `${f.feature} — ${f.pct.toFixed(1)}%`;
      ul.appendChild(li);
    }
    det.append(sum, ul);
    host.appendChild(det);
  }

  // Cho tải một bản model về để sao lưu thủ công.
  const dlBtn = document.createElement('button');
  dlBtn.textContent = 'Tải file model (.json)';
  dlBtn.style.marginTop = '12px';
  dlBtn.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(p)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${p.symbol}_${p.interval}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  host.appendChild(dlBtn);
  const hint = document.createElement('div');
  hint.className = 'small muted';
  hint.style.marginTop = '4px';
  hint.textContent = 'Đây chỉ là bản sao lưu. Model dùng chung được lệnh train của server lưu thẳng vào database.';
  host.appendChild(hint);
}

function statTile(title, value, sub, tone) {
  const d = document.createElement('div');
  d.className = 'card';
  d.style.padding = '10px 12px';
  const t = document.createElement('div');
  t.className = 'small muted';
  t.textContent = title;
  const v = document.createElement('div');
  v.style.cssText = 'font-size:22px; font-weight:660; font-variant-numeric:tabular-nums';
  if (tone) v.style.color = tone;
  v.textContent = value;
  d.append(t, v);
  if (sub) {
    const s = document.createElement('div');
    s.className = 'small muted';
    s.textContent = sub;
    d.appendChild(s);
  }
  return d;
}

async function runBacktest() {
  let symbol;
  try {
    symbol = await selectedSymbol();
  } catch (err) {
    return showBanner(err.message);
  }
  const interval = $('interval').value;
  const strategy = state.strategy || await loadStrategy();
  const candles = Number($('bt-candles').value) || 3000;
  runWorkerJob('Backtest', {
    job: 'backtest', symbol, interval, strategy, candles,
    storedModel: await loadModel(symbol, interval),
  }, {
    logEl: $('bt-log'),
    resultEl: $('bt-result'),
    button: $('btn-backtest'),
    onDone: (r) => renderBacktest(r),
  });
}

function renderBacktest(r) {
  const host = $('bt-result');
  clear(host);
  const st = r.stats;

  const head = document.createElement('p');
  head.className = 'small muted';
  head.style.margin = '0 0 10px';
  head.textContent = `${r.symbol} ${r.interval} · ${r.period.from.slice(0, 10)} → ${r.period.to.slice(0, 10)} `
    + `(${r.period.candles} nến) · phí ${r.settings.feePercent}%/chiều · `
    + `thoát "${r.settings.exitStrategy}" · ML ${r.settings.usedModel ? `bật (${r.settings.mlWeight})` : 'chưa có model'}`;
  host.appendChild(head);

  if (!st.trades) {
    const p = document.createElement('div');
    p.className = 'banner warn';
    p.textContent = st.note;
    host.appendChild(p);
    return;
  }

  const good = cssVar('--good-text'), bad = cssVar('--critical');
  const grid = document.createElement('div');
  grid.className = 'grid-3';
  grid.append(
    statTile('Tổng lợi nhuận', `${fmtSigned(st.totalReturnPercent)}%`,
      `mua & giữ ${fmtSigned(st.buyHoldReturnPercent)}%`,
      st.totalReturnPercent >= 0 ? good : bad),
    statTile('Profit factor', String(st.profitFactor ?? '—'),
      st.profitFactor >= 1 ? 'trên 1 = có lãi' : 'dưới 1 = lỗ',
      st.profitFactor >= 1 ? good : bad),
    statTile('Sụt giảm tối đa', `−${st.maxDrawdownPercent}%`, 'từ đỉnh vốn', bad),
  );
  host.appendChild(grid);

  const dl = document.createElement('dl');
  dl.className = 'kv';
  dl.style.marginTop = '12px';
  for (const [k, v] of [
    ['Số lệnh', `${st.trades} (long ${st.longTrades} / short ${st.shortTrades})`],
    ['Tỉ lệ thắng', `${st.winRatePercent}% (long ${st.longWinRate ?? '—'}% / short ${st.shortWinRate ?? '—'}%)`],
    ['Lãi TB khi thắng', `${st.avgWinPercent}%`],
    ['Lỗ TB khi thua', `${st.avgLossPercent}%`],
    ['Kỳ vọng mỗi lệnh', `${st.expectancyPercent}%`],
    ['Lý do đóng lệnh', Object.entries(st.exitReasons).map(([a, b]) => `${a}: ${b}`).join(' · ')],
  ]) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = String(v);
    dl.append(dt, dd);
  }
  host.appendChild(dl);

  if (st.trades < 40) {
    const warn = document.createElement('div');
    warn.className = 'banner warn';
    warn.style.marginTop = '10px';
    warn.textContent = `Chỉ có ${st.trades} lệnh — quá ít để kết luận. Số liệu này có thể chỉ là ngẫu nhiên.`;
    host.appendChild(warn);
  }

  const det = document.createElement('details');
  det.style.marginTop = '12px';
  const sum = document.createElement('summary');
  sum.className = 'small muted';
  sum.style.cursor = 'pointer';
  sum.textContent = `${r.trades.length} lệnh gần nhất (tổng ${r.allTradeCount})`;
  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>Vào lệnh</th><th>Hướng</th><th class="num">Entry</th>'
    + '<th class="num">Thoát</th><th class="num">Lãi/lỗ</th><th>Lý do</th></tr></thead>';
  const tb = document.createElement('tbody');
  for (const t of [...r.trades].reverse()) {
    const tr = document.createElement('tr');
    for (const [txt, cls] of [
      [t.entryTime.slice(0, 16).replace('T', ' '), ''],
      [t.side === 'long' ? 'Long' : 'Short', ''],
      [fmtNum(t.entry), 'num'], [fmtNum(t.exit), 'num'],
      [`${fmtSigned(t.netPercent)}%`, `num ${t.netPercent >= 0 ? 'delta-up' : 'delta-down'}`],
      [t.reason, 'small muted'],
    ]) {
      const td = document.createElement('td');
      td.className = cls;
      td.textContent = txt;
      tr.appendChild(td);
    }
    tb.appendChild(tr);
  }
  table.appendChild(tb);
  det.append(sum, table);
  host.appendChild(det);
}

// ---------- Cấu hình ----------

const CFG_GROUP_LABELS = {
  indicators: 'Tham số chỉ báo', weights: 'Trọng số tín hiệu', thresholds: 'Ngưỡng ra tín hiệu',
  ml: 'Model học máy', risk: 'Quản lý rủi ro', llm: 'Cách Claude suy luận',
  alerts: 'Cảnh báo (chỉ dùng cho bot Telegram)', analysis: 'Phạm vi phân tích',
};

async function loadConfigEditor() {
  const host = $('config-body');
  try {
    const strategy = await loadStrategy();
    const flat = flattenStrategy(strategy);
    state.configLoaded = true;
    clear(host);

    const bar = document.createElement('div');
    bar.className = 'controls';
    bar.style.marginBottom = '12px';
    const count = document.createElement('span');
    count.className = 'small muted';
    count.textContent = overrideCount()
      ? `${overrideCount()} khoá đã sửa khác mặc định`
      : 'Đang dùng toàn bộ giá trị mặc định';
    const reset = document.createElement('button');
    reset.textContent = 'Về mặc định';
    reset.addEventListener('click', () => {
      resetStrategy();
      state.configLoaded = false;
      loadConfigEditor();
      runAnalyze();
    });
    bar.append(count, reset);
    host.appendChild(bar);

    const groups = new Map();
    for (const item of flat) {
      const g = item.path.split('.')[0];
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(item);
    }
    for (const [g, items] of groups) {
      const box = document.createElement('div');
      box.className = 'cfg-group';
      const h = document.createElement('h3');
      h.textContent = CFG_GROUP_LABELS[g] || g;
      box.appendChild(h);
      if (strategy[g]?._note) {
        const note = document.createElement('p');
        note.className = 'cfg-note';
        note.textContent = strategy[g]._note;
        box.appendChild(note);
      }
      for (const item of items) box.appendChild(configRow(item));
      host.appendChild(box);
    }
  } catch (err) {
    host.textContent = `Không tải được cấu hình: ${err.message}`;
  }
}

function configRow(item) {
  const row = document.createElement('div');
  row.className = 'cfg-row';
  const label = document.createElement('label');
  label.textContent = item.path;
  label.htmlFor = `cfg-${item.path}`;
  if (isOverridden(item.path)) label.style.fontWeight = '650';

  let input;
  if (typeof item.value === 'boolean') {
    input = document.createElement('select');
    for (const v of ['true', 'false']) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = v === 'true' ? 'bật' : 'tắt';
      input.appendChild(o);
    }
    input.value = String(item.value);
  } else {
    input = document.createElement('input');
    input.type = typeof item.value === 'number' ? 'number' : 'text';
    if (input.type === 'number') input.step = 'any';
    input.value = Array.isArray(item.value) ? item.value.join(',') : String(item.value);
  }
  input.id = `cfg-${item.path}`;
  let original = input.value;

  const commit = async () => {
    if (input.value === original) return;
    try {
      await setStrategyValue(item.path, input.value);
      original = input.value;
      row.classList.remove('changed');
      label.style.fontWeight = isOverridden(item.path) ? '650' : '';
      setStatus(`đã lưu ${item.path}`);
      state.strategy = await loadStrategy();
      if (state.snapshot) runAnalyze();
    } catch (err) {
      showBanner(`Không lưu được ${item.path}: ${err.message}`);
      input.value = original;
      row.classList.remove('changed');
    }
  };

  input.addEventListener('input', () => row.classList.toggle('changed', input.value !== original));
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });

  row.append(label, input);
  return row;
}

// ---------- Prompt ----------

async function loadPromptEditor() {
  const text = await loadPrompt();
  $('prompt-text').value = text;
  $('prompt-status').textContent = `${text.length} ký tự`
    + (promptIsCustom() ? ' · đang dùng bản bạn sửa' : ' · đang dùng bản mặc định');
}

function savePromptEditor() {
  const text = $('prompt-text').value;
  if (text.trim().length < 50) {
    $('prompt-status').textContent = 'Prompt quá ngắn (cần ≥ 50 ký tự)';
    return;
  }
  $('prompt-status').textContent = savePrompt(text)
    ? `Đã lưu · ${text.length} ký tự`
    : 'Không lưu được (trình duyệt ở chế độ riêng tư?)';
}

// ---------- Danh sách model ----------

async function loadModelsList() {
  const host = $('models-list');
  try {
    const models = await listModels();
    clear(host);
    if (!models.length) { host.textContent = 'Chưa có model nào.'; return; }
    const table = document.createElement('table');
    table.innerHTML = '<thead><tr><th>Cặp</th><th class="num">AUC holdout</th>'
      + '<th class="num">AUC walk-fwd</th><th class="num">Mẫu</th><th>Nguồn</th><th>Train lúc</th><th></th></tr></thead>';
    const tb = document.createElement('tbody');
    for (const m of models) {
      const tr = document.createElement('tr');
      for (const [txt, cls] of [
        [`${m.symbol} ${m.interval}`, ''],
        [String(m.testAuc ?? '—'), 'num'],
        [String(m.walkForwardAuc ?? '—'), 'num'],
        [String(m.samples ?? '—'), 'num'],
        [m.source === 'local' ? 'bạn train' : 'trong repo', 'small muted'],
        [m.trainedAt ? new Date(m.trainedAt).toLocaleString('vi-VN') : '—', 'small muted'],
      ]) {
        const td = document.createElement('td');
        td.className = cls;
        td.textContent = txt;
        tr.appendChild(td);
      }
      const tdBtn = document.createElement('td');
      if (m.source === 'local') {
        const del = document.createElement('button');
        del.textContent = 'Xoá';
        del.style.padding = '2px 8px';
        del.addEventListener('click', () => {
          deleteModel(m.symbol, m.interval);
          loadModelsList();
          if (state.snapshot) runAnalyze();
        });
        tdBtn.appendChild(del);
      }
      tr.appendChild(tdBtn);
      tb.appendChild(tr);
    }
    table.appendChild(tb);
    host.appendChild(table);
  } catch (err) {
    host.textContent = err.message;
  }
}

// ---------- Cài đặt AI ----------

function initSettingsPanel() {
  const input = $('apikey-input');
  input.value = getApiKey();
  updateKeyStatus();

  $('btn-save-key').addEventListener('click', () => {
    const ok = setApiKey(input.value.trim());
    $('key-status').textContent = ok
      ? (input.value.trim() ? 'Đã lưu key vào trình duyệt này.' : 'Đã xoá key.')
      : 'Không lưu được (chế độ riêng tư?)';
    updateKeyStatus();
    hideBanner();
  });

  $('btn-test-key').addEventListener('click', async () => {
    const btn = $('btn-test-key');
    btn.disabled = true;
    $('key-status').textContent = 'Đang kiểm tra…';
    try {
      setApiKey(input.value.trim());
      const r = await testApiKey();
      $('key-status').textContent = `Key hoạt động — ${r.model} trả lời: "${r.reply}"`;
      updateKeyStatus();
    } catch (err) {
      $('key-status').textContent = `Lỗi: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });
}

function updateKeyStatus() {
  const has = Boolean(getApiKey());
  $('ai-key-chip').textContent = has ? 'Đã có API key' : 'Chưa có API key';
  $('ai-key-chip').className = `chip ${has ? 'ok' : 'warn'}`;
}

function initials(name) {
  const words = String(name || 'Tài khoản').trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((word) => word[0]).join('').toLocaleUpperCase('vi-VN') || '?';
}

function renderSideAvatar(avatar, name) {
  const host = $('side-avatar');
  clear(host);
  if (!avatar) {
    host.textContent = initials(name);
    return;
  }
  const image = document.createElement('img');
  image.alt = '';
  image.src = avatar;
  image.addEventListener('error', () => {
    clear(host);
    host.textContent = initials(name);
  }, { once: true });
  host.appendChild(image);
}

function renderProfileAvatar(avatar, name) {
  const image = $('profile-avatar-image');
  const fallback = $('profile-avatar-fallback');
  if (!avatar) {
    image.hidden = true;
    image.removeAttribute('src');
    fallback.hidden = false;
    fallback.textContent = initials(name);
    return;
  }
  fallback.hidden = true;
  image.hidden = false;
  image.src = avatar;
  image.onerror = () => {
    image.hidden = true;
    image.removeAttribute('src');
    fallback.hidden = false;
    fallback.textContent = initials(name);
  };
}

function syncProfileEditor(session) {
  const user = session?.user;
  if (!user) return;
  state.profileAvatar = user.avatar || null;
  $('profile-display-name').value = user.name || '';
  $('profile-avatar-input').value = '';
  renderProfileAvatar(state.profileAvatar, user.name);
}

async function updateAuthStatus(session = null) {
  const link = $('auth-link');
  try {
    const { user } = session || await getAuthSession();
    if (!user) return;
    link.textContent = '';
    if (user.avatar) {
      const avatar = document.createElement('img');
      avatar.src = user.avatar;
      avatar.alt = '';
      link.appendChild(avatar);
    }
    link.appendChild(document.createTextNode(user.name || 'Tài khoản'));
    link.setAttribute('href', '#profile');
    link.setAttribute('aria-label', `Tài khoản: ${user.name || user.email || ''}`);
    $('side-user-name').textContent = user.name || 'Tài khoản';
    renderSideAvatar(user.avatar, user.name);
  } catch { /* Dashboard vẫn hoạt động nếu API xác thực chưa sẵn sàng. */ }
}

function setProfileStatus(message, kind = 'muted') {
  const status = $('profile-status');
  status.textContent = message;
  status.className = `small ${kind}`;
}

function initSidebar() {
  for (const button of document.querySelectorAll('[data-open-tab]')) {
    button.addEventListener('click', () => {
      switchTab(button.dataset.openTab);
      $('workspace').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  $('side-logout').addEventListener('click', async () => {
    const button = $('side-logout');
    button.disabled = true;
    try {
      const response = await csrfFetch('/auth/logout', { method: 'POST' });
      if (!response.ok) throw new Error('Không thể đăng xuất. Vui lòng thử lại.');
      location.assign('/login/');
    } catch (error) {
      button.disabled = false;
      showBanner(error.message);
    }
  });
}

function initProfileEditor() {
  const avatarInput = $('profile-avatar-input');
  const allowedTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

  avatarInput.addEventListener('change', () => {
    const file = avatarInput.files?.[0];
    if (!file) return;
    if (!allowedTypes.has(file.type) || file.size > 500 * 1024) {
      avatarInput.value = '';
      setProfileStatus('Ảnh phải là PNG, JPEG, WebP hoặc GIF và không quá 500 KB.', 'error');
      return;
    }
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      state.profileAvatar = String(reader.result || '');
      renderProfileAvatar(state.profileAvatar, $('profile-display-name').value);
      setProfileStatus('Ảnh mới đã sẵn sàng để lưu.');
    });
    reader.addEventListener('error', () => setProfileStatus('Không thể đọc ảnh đã chọn.', 'error'));
    reader.readAsDataURL(file);
  });

  $('profile-remove-avatar').addEventListener('click', () => {
    state.profileAvatar = null;
    avatarInput.value = '';
    renderProfileAvatar(null, $('profile-display-name').value);
    setProfileStatus('Ảnh đại diện sẽ được gỡ khi bạn lưu.');
  });

  $('profile-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const displayName = $('profile-display-name').value.trim();
    if (displayName.length < 2 || displayName.length > 80) {
      setProfileStatus('Tên hiển thị cần có từ 2 đến 80 ký tự.', 'error');
      return;
    }

    const button = $('profile-save');
    button.disabled = true;
    setProfileStatus('Đang lưu…');
    try {
      const response = await csrfFetch('/api/auth/profile', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName, avatar: state.profileAvatar }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.user) {
        throw new Error(payload?.error || 'Không thể lưu thông tin. Vui lòng thử lại.');
      }
      state.auth = { ...state.auth, user: payload.user };
      syncProfileEditor(state.auth);
      await updateAuthStatus(state.auth);
      setProfileStatus('Đã lưu thay đổi.', 'ok');
    } catch (error) {
      setProfileStatus(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });
}

function applyAuthorization(session) {
  state.auth = session;
  state.canWrite = canWrite(session);
  document.body.dataset.canWrite = String(state.canWrite);
  for (const element of document.querySelectorAll('[data-admin-only]')) {
    element.hidden = !state.canWrite;
  }
}

// ---------- Tabs & khởi động ----------

function switchTab(id) {
  for (const btn of document.querySelectorAll('[role="tab"]')) {
    const on = btn.id === id;
    btn.setAttribute('aria-selected', String(on));
    $(btn.dataset.panel).classList.toggle('hidden', !on);
  }
  if (id === 'tab-config' && !state.configLoaded) loadConfigEditor();
  if (id === 'tab-prompt' && !$('prompt-text').value) loadPromptEditor();
  if (id === 'tab-train') loadModelsList();
}

function applyTheme(mode) {
  if (mode) document.documentElement.setAttribute('data-theme', mode);
  else document.documentElement.removeAttribute('data-theme');
  try { localStorage.setItem('ta.theme', mode || ''); } catch { /* riêng tư */ }
  if (state.snapshot) renderAll(state.snapshot);
  if (state.performanceData) drawPerformance(state.performanceData);
}

async function init() {
  try { applyTheme(localStorage.getItem('ta.theme') || ''); } catch { /* bỏ qua */ }
  try {
    const session = await getAuthSession();
    if (!session.user) {
      location.assign(`/login/?${new URLSearchParams({ returnTo: location.pathname + location.search })}`);
      return;
    }
    applyAuthorization(session);
    await updateAuthStatus(session);
    syncProfileEditor(session);
    initSidebar();
    initProfileEditor();
  } catch (err) {
    showBanner(err.message);
    return;
  }
  loadTradingPerformance();

  const sel = $('interval');
  for (const iv of Object.keys(INTERVAL_MS)) {
    const o = document.createElement('option');
    o.value = iv;
    o.textContent = iv;
    sel.appendChild(o);
  }

  try {
    state.strategy = await loadStrategy();
  } catch (err) {
    showBanner(`Không tải được cấu hình: ${err.message}`);
    return;
  }

  const params = new URLSearchParams(location.search);
  sel.value = params.get('interval') || '4h';
  if (params.get('symbol')) $('symbol').value = params.get('symbol');

  $('btn-analyze').addEventListener('click', runAnalyze);
  $('btn-ai').addEventListener('click', runAiReport);
  $('btn-ask').addEventListener('click', runAsk);
  $('btn-train').addEventListener('click', runTrain);
  $('btn-backtest').addEventListener('click', runBacktest);
  $('btn-save-prompt').addEventListener('click', savePromptEditor);
  $('btn-reset-prompt').addEventListener('click', () => { resetPrompt(); loadPromptEditor(); });
  $('symbol').addEventListener('keydown', (e) => { if (e.key === 'Enter') runAnalyze(); });
  $('ask-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') runAsk(); });
  $('interval').addEventListener('change', runAnalyze);
  // Nhãn "Sẽ train" phải theo ô nhập ngay khi gõ, để không train nhầm token.
  $('symbol').addEventListener('input', updateTargetLabel);
  $('interval').addEventListener('change', updateTargetLabel);
  for (const button of document.querySelectorAll('.performance-range')) {
    button.addEventListener('click', () => loadTradingPerformance(button.dataset.range));
  }
  updateTargetLabel();
  for (const btn of document.querySelectorAll('[role="tab"]')) {
    btn.addEventListener('click', () => switchTab(btn.id));
  }
  $('btn-theme').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  });
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.snapshot) drawPriceChart(state.snapshot);
      if (state.performanceData) drawPerformance(state.performanceData);
    }, 150);
  });

  if (state.canWrite) initSettingsPanel();
  await runAnalyze();
}

init();
