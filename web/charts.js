// Biểu đồ SVG của dashboard (/): giá + vùng giá quan trọng + kịch bản, CVD, mua chủ động.
//
// Khác bản cũ:
//  - viewBox luôn bằng bề rộng thật của khung chứa (1 đơn vị = 1 pixel) nên chữ giữ
//    nguyên cỡ ở mọi màn hình, không bị thu nhỏ còn vài pixel trên điện thoại;
//  - chỉ vẽ tối đa 2 mức hỗ trợ + 2 kháng cự GẦN GIÁ NHẤT, nhãn tự nhường chỗ nhau;
//  - tường lệnh, kịch bản, khối lượng là các lớp bật/tắt được.
// Chỉ vẽ các chỉ báo được phép của dự án (xem .claude/skills/chi-bao/SKILL.md).

import { fmt, pct, compact, decimalsFor, timeLabel } from '../src/chart/render.js';
import { cssVar, esc, num, nearestLevels } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';

function mk(tag, attrs = {}, text) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    // CSS `svg text { fill }` luôn thắng thuộc tính fill, nên màu chữ phải đi qua style.
    if (tag === 'text' && k === 'fill') node.style.fill = String(v);
    else node.setAttribute(k, String(v));
  }
  if (text != null) node.textContent = String(text);
  return node;
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

/** Bề rộng thực của khung chứa; đặt viewBox = bề rộng này để 1 đơn vị = 1 pixel. */
function setup(svg, height) {
  const W = Math.max(280, Math.floor(svg.parentElement.clientWidth || 600));
  svg.setAttribute('viewBox', `0 0 ${W} ${height}`);
  svg.setAttribute('height', height);
  return W;
}

/**
 * Dàn nhãn theo chiều dọc: nhãn nào sát nhãn trên quá `gap` thì đẩy xuống,
 * rồi kéo ngược lên nếu tràn đáy. Trả về y mới cho từng phần tử (giữ nguyên thứ tự vào).
 */
function spread(items, gap, lo, hi) {
  const order = items.map((it, i) => ({ i, y: it.y })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < order.length; k++) {
    if (order[k].y - order[k - 1].y < gap) order[k].y = order[k - 1].y + gap;
  }
  const over = order.length ? order[order.length - 1].y - hi : 0;
  if (over > 0) {
    for (let k = order.length - 1; k >= 0; k--) {
      order[k].y -= over;
      if (k > 0 && order[k].y - order[k - 1].y >= gap) break;
    }
  }
  const out = new Array(items.length);
  for (const o of order) out[o.i] = Math.max(lo, o.y);
  return out;
}

const ttRow = (label, value) => `<div class="tt-row"><span>${label}</span><span>${value}</span></div>`;

/** Crosshair + tooltip: rê chuột hoặc chạm/kéo ngang để xem từng nến. */
function attachCrosshair(svg, tip, { left, step, count, xOf, top, bottom, html }) {
  const cursor = mk('line', { y1: top, y2: bottom, class: 'axis-line', 'stroke-dasharray': '3 3', opacity: 0 });
  svg.appendChild(cursor);

  const move = (clientX, clientY) => {
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const svgX = ((clientX - rect.left) / rect.width) * vb.width;
    const i = Math.max(0, Math.min(count - 1, Math.floor((svgX - left) / step)));
    cursor.setAttribute('x1', xOf(i));
    cursor.setAttribute('x2', xOf(i));
    cursor.setAttribute('opacity', 1);
    const content = html(i);
    if (!content) return;
    tip.innerHTML = content;
    tip.classList.add('on');
    const wrap = svg.parentElement.getBoundingClientRect();
    const tw = tip.offsetWidth || 170;
    let x = clientX - wrap.left + 14;
    if (x + tw > wrap.width) x = clientX - wrap.left - tw - 14;
    tip.style.left = `${Math.max(4, x)}px`;
    tip.style.top = `${Math.max(4, Math.min(wrap.height - tip.offsetHeight - 4, clientY - wrap.top + 12))}px`;
  };
  const leave = () => { cursor.setAttribute('opacity', 0); tip.classList.remove('on'); };

  svg.onpointermove = (e) => move(e.clientX, e.clientY);
  svg.onpointerdown = (e) => move(e.clientX, e.clientY);
  svg.onpointerleave = leave;
}

/* ---------- Biểu đồ giá ---------- */

export function drawPriceChart(svg, tip, snap, layers) {
  clear(svg);
  const s = snap.series;
  if (!s || !s.close.length) return;

  const W = Math.max(280, Math.floor(svg.parentElement.clientWidth || 600));
  const small = W < 560;
  const H = small ? 380 : 440;
  setup(svg, H);

  const padL = 8;
  const padR = small ? 68 : 84;
  const padT = 12;
  const padB = 24;
  const volH = layers.volume ? (small ? 46 : 60) : 0;
  const volGap = layers.volume ? 12 : 0;
  const priceH = H - padT - padB - volH - volGap;
  const n = s.close.length;
  const last = snap.price.live ?? s.close[n - 1];

  const near = layers.levels ? nearestLevels(snap.structure, last, { perSide: 2, minGapPct: 1.2 }) : { support: [], resistance: [] };
  const plan = layers.plan && snap.levels && snap.levels.side !== 'none' && snap.levels.entry != null
    ? snap.levels : null;
  // Tối đa 2 tường lớn nhất mỗi phía (engine đã sắp theo giá trị), giống bộ vẽ chung.
  const walls = layers.walls
    ? ['bid', 'ask'].flatMap((side) => (snap.orderBook?.walls ?? []).filter((w) => w.side === side).slice(0, 2))
    : [];

  // Chừa chỗ bên phải cho hộp kịch bản (giống Long/Short Position của TradingView).
  const fullW = W - padL - padR;
  const boxRatio = plan ? (small ? 0.36 : 0.28) : 0;
  const plotW = fullW * (1 - boxRatio);
  const zoneX = padL + plotW;
  const zoneW = fullW - plotW;
  const step = plotW / n;
  const xOf = (i) => padL + step * (i + 0.5);

  // Thang giá: nến + các lớp đang bật. Mức nào xa giá quá 12% thì bỏ khỏi thang
  // (nếu không nến bị ép thành một dải mỏng).
  const within = (p) => Math.abs(p - last) / last < 0.12;
  const extra = [
    ...near.support.map((l) => l.price), ...near.resistance.map((l) => l.price),
    ...walls.map((w) => w.price),
    ...(plan ? [plan.entry, plan.stopLoss, ...(plan.targets ?? []).map((t) => t.price)] : []),
  ].filter((p) => p != null && within(p));
  const lows = s.low.filter((v) => v != null);
  const highs = s.high.filter((v) => v != null);
  let min = Math.min(...lows, ...extra);
  let max = Math.max(...highs, ...extra);
  const pad = (max - min) * 0.06 || Math.abs(max) * 0.01 || 1;
  min -= pad; max += pad;
  const yOf = (v) => padT + priceH - ((v - min) / (max - min)) * priceH;
  const inRange = (p) => p >= min && p <= max;

  const dec = decimalsFor(last);
  const axisFmt = (v) => (Math.abs(last) >= 1000 ? fmt(v, 0) : fmt(v, dec));
  const up = cssVar('--up');
  const down = cssVar('--down');
  const accent = cssVar('--accent');

  // Lưới ngang + nhãn giá bên phải. Nhãn nào nằm sát một thẻ giá (HT/KC, giá hiện tại)
  // thì bỏ, nếu không chữ chồng lên thẻ.
  const tagYs = [
    yOf(last),
    ...[...near.support, ...near.resistance].filter((l) => inRange(l.price)).map((l) => yOf(l.price)),
  ];
  for (let k = 0; k <= 4; k++) {
    const v = min + ((max - min) * k) / 4;
    const y = yOf(v);
    svg.appendChild(mk('line', { x1: padL, y1: y, x2: W - padR, y2: y, class: 'grid-line' }));
    if (tagYs.every((ty) => Math.abs(ty - y) > 21)) {
      svg.appendChild(mk('text', { x: W - padR + 6, y: y + 4 }, axisFmt(v)));
    }
  }

  // Tường lệnh: dải mờ phía sau nến (nhãn vẽ ở danh sách nhãn bên dưới).
  const leftLabels = [];
  for (const w of walls) {
    if (!inRange(w.price)) continue;
    const y = yOf(w.price);
    const col = w.side === 'bid' ? up : down;
    svg.appendChild(mk('line', { x1: padL, y1: y, x2: W - padR, y2: y, stroke: col, 'stroke-width': 6, opacity: 0.22 }));
    leftLabels.push({
      y: y + 13, color: col,
      text: `Tường ${w.side === 'bid' ? 'mua' : 'bán'} ×${num(w.ratioToAvg, 1)}`,
    });
  }

  // Hỗ trợ / kháng cự gần giá: một DẢI màu (dày hơn khi được chạm nhiều lần) nằm sau nến,
  // một vạch ở giữa dải, nhãn "Kháng cự · chạm N lần" ở bên trái (SKILL.md bắt buộc nêu số lần chạm).
  // Thẻ giá ở trục phải gom vào `tags` rồi dàn lại ở cuối để không chồng lên thẻ giá hiện tại.
  const tags = [];
  for (const [kind, list] of [['support', near.support], ['resistance', near.resistance]]) {
    const col = kind === 'support' ? up : down;
    for (const lv of list) {
      if (!inRange(lv.price)) continue;
      const y = yOf(lv.price);
      const half = Math.max(4, Math.min(11, 3 + (lv.touches ?? 1) * 1.1));
      svg.appendChild(mk('rect', { x: padL, y: y - half, width: W - padR - padL, height: half * 2, fill: col, opacity: 0.12 }));
      svg.appendChild(mk('line', { x1: padL, y1: y, x2: W - padR, y2: y, stroke: col, 'stroke-width': 1.5, opacity: 0.9 }));
      tags.push({ y, fill: col, ink: '#fff', text: axisFmt(lv.price) });
      // Nhãn kháng cự nằm trên dải, nhãn hỗ trợ nằm dưới dải.
      leftLabels.push({
        y: kind === 'support' ? y + half + 12 : y - half - 4, color: col,
        text: `${kind === 'support' ? 'Hỗ trợ' : 'Kháng cự'} · chạm ${lv.touches} lần`,
      });
    }
  }

  // Nến
  const bodyW = Math.max(1.2, Math.min(9, step * 0.66));
  for (let i = 0; i < n; i++) {
    const o = s.open[i], c = s.close[i], h = s.high[i], l = s.low[i];
    if ([o, c, h, l].some((v) => v == null)) continue;
    const col = c >= o ? up : down;
    svg.appendChild(mk('line', { x1: xOf(i), y1: yOf(h), x2: xOf(i), y2: yOf(l), stroke: col, 'stroke-width': 1 }));
    svg.appendChild(mk('rect', {
      x: xOf(i) - bodyW / 2, y: yOf(Math.max(o, c)), width: bodyW,
      height: Math.max(1, Math.abs(yOf(o) - yOf(c))), fill: col, rx: Math.min(1.5, bodyW / 3),
    }));
  }

  // Kịch bản: hộp lãi/lỗ chiếu ra phía trước nến cuối.
  if (plan) {
    const clampY = (y) => Math.max(padT, Math.min(padT + priceH, y));
    const yEntry = yOf(plan.entry);
    const lastTp = plan.targets?.[plan.targets.length - 1];
    const box = (toPrice, color) => {
      if (toPrice == null) return;
      const y1 = clampY(yEntry);
      const y2 = clampY(yOf(toPrice));
      svg.appendChild(mk('rect', {
        x: zoneX, y: Math.min(y1, y2), width: zoneW, height: Math.abs(y2 - y1),
        fill: color, opacity: 0.14,
      }));
      svg.appendChild(mk('rect', {
        x: zoneX, y: Math.min(y1, y2), width: zoneW, height: Math.abs(y2 - y1),
        fill: 'none', stroke: color, 'stroke-width': 1, opacity: 0.6,
      }));
    };
    box(lastTp?.price, up);
    box(plan.stopLoss, down);

    svg.appendChild(mk('line', {
      x1: padL, y1: yEntry, x2: W - padR, y2: yEntry, stroke: accent, 'stroke-width': 1.3, 'stroke-dasharray': '2 4',
    }));

    const movePct = (p) => pct(((p - plan.entry) / plan.entry) * 100, 1);
    const labels = [];
    const add = (price, text, color) => {
      if (price == null) return;
      labels.push({ y: clampY(yOf(price)), text, color });
    };
    add(plan.entry, `${plan.side === 'long' ? 'LONG' : 'SHORT'} vào${small ? '' : ` ${fmt(plan.entry, dec)}`}`, accent);
    for (const t of plan.targets ?? []) {
      add(t.price, small ? `${t.label} ${movePct(t.price)}` : `${t.label} ${fmt(t.price, dec)} (${movePct(t.price)})`, up);
      const y = clampY(yOf(t.price));
      svg.appendChild(mk('line', { x1: zoneX, y1: y, x2: zoneX + zoneW, y2: y, stroke: up, 'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0.8 }));
    }
    add(plan.stopLoss, small ? `Cắt lỗ ${movePct(plan.stopLoss)}` : `Cắt lỗ ${fmt(plan.stopLoss, dec)} (${movePct(plan.stopLoss)})`, down);
    if (plan.stopLoss != null) {
      const y = clampY(yOf(plan.stopLoss));
      svg.appendChild(mk('line', { x1: zoneX, y1: y, x2: zoneX + zoneW, y2: y, stroke: down, 'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0.8 }));
    }
    const ys = spread(labels, 16, padT + 8, padT + priceH - 4);
    labels.forEach((lb, i) => {
      svg.appendChild(mk('text', {
        x: zoneX + 6, y: ys[i] + 4, class: 'series-label halo', fill: lb.color,
      }, lb.text));
    });
  }

  // Nhãn bên trái (hỗ trợ/kháng cự + tường lệnh), đã dàn để không đè nhau.
  const ly = spread(leftLabels, 14, padT + 10, padT + priceH - 4);
  leftLabels.forEach((lb, i) => {
    svg.appendChild(mk('text', { x: padL + 6, y: ly[i], class: 'series-label halo', fill: lb.color }, lb.text));
  });

  // Đường giá hiện tại; thẻ giá của nó đi cùng các thẻ hỗ trợ/kháng cự và được dàn
  // để hai thẻ gần nhau (giá chỉ cách mức vài chục điểm) không đè lên nhau.
  const yLast = yOf(last);
  svg.appendChild(mk('line', {
    x1: padL, y1: yLast, x2: W - padR, y2: yLast, stroke: accent, 'stroke-width': 1.2, 'stroke-dasharray': '3 3',
  }));
  tags.push({ y: yLast, fill: accent, ink: cssVar('--accent-ink'), text: axisFmt(last) });
  const tagY = spread(tags, 21, padT + 10, padT + priceH - 10);
  tags.forEach((tg, i) => {
    svg.appendChild(mk('rect', { x: W - padR + 2, y: tagY[i] - 10, width: padR - 4, height: 20, rx: 5, fill: tg.fill }));
    svg.appendChild(mk('text', { x: W - padR + 7, y: tagY[i] + 4, class: 'pill-text', fill: tg.ink }, tg.text));
  });

  // Khối lượng
  const volTop = padT + priceH + volGap;
  if (layers.volume) {
    const maxVol = Math.max(...s.volume.filter(Number.isFinite), 1);
    const vy = (v) => volTop + volH - (v / maxVol) * volH;
    svg.appendChild(mk('line', { x1: padL, y1: volTop + volH, x2: W - padR, y2: volTop + volH, class: 'axis-line' }));
    svg.appendChild(mk('text', { x: padL, y: volTop + 10 }, small ? 'Khối lượng' : 'Khối lượng (đường đứt = trung bình)'));
    for (let i = 0; i < n; i++) {
      const v = s.volume[i];
      if (!Number.isFinite(v)) continue;
      svg.appendChild(mk('rect', {
        x: xOf(i) - bodyW / 2, y: vy(v), width: bodyW, height: Math.max(0.6, volTop + volH - vy(v)),
        fill: s.close[i] >= s.open[i] ? up : down, opacity: 0.45, rx: Math.min(1.5, bodyW / 3),
      }));
    }
    const pts = [];
    for (let i = 0; i < n; i++) if (s.volumeAvg[i] != null) pts.push(`${xOf(i)},${vy(s.volumeAvg[i])}`);
    if (pts.length > 2) {
      svg.appendChild(mk('polyline', {
        points: pts.join(' '), fill: 'none', stroke: cssVar('--text-3'), 'stroke-width': 1.4, 'stroke-dasharray': '4 3',
      }));
    }
  }

  // Nhãn thời gian: mỗi nhãn rộng ~70px nên chỉ đặt bấy nhiêu mốc vừa với bề rộng vùng nến
  // (hộp kịch bản chiếm bớt chỗ). Nhãn đầu neo trái, nhãn cuối neo phải => không bao giờ chồng.
  const k = Math.max(2, Math.min(6, Math.floor(plotW / 95)));
  for (let t = 0; t < k; t++) {
    const i = Math.round((t * (n - 1)) / (k - 1));
    svg.appendChild(mk('text', {
      x: t === 0 ? padL : t === k - 1 ? xOf(n - 1) + bodyW / 2 : xOf(i),
      y: H - 6,
      'text-anchor': t === 0 ? 'start' : t === k - 1 ? 'end' : 'middle',
    }, timeLabel(s.time[i], snap.interval)));
  }

  attachCrosshair(svg, tip, {
    left: padL, step, count: n, xOf, top: padT, bottom: volTop + volH,
    html: (i) => {
      const chg = ((s.close[i] - s.open[i]) / s.open[i]) * 100;
      const share = s.volume[i] ? (s.cvdDelta[i] / s.volume[i]) * 100 : null;
      return `<div class="tt-time">${esc(timeLabel(s.time[i], snap.interval))}</div>`
        + ttRow('Mở', fmt(s.open[i], dec)) + ttRow('Cao', fmt(s.high[i], dec))
        + ttRow('Thấp', fmt(s.low[i], dec))
        + ttRow('Đóng', `<span class="${chg >= 0 ? 'up' : 'down'}">${fmt(s.close[i], dec)} (${pct(chg)})</span>`)
        + ttRow('Khối lượng', compact(s.volume[i]))
        + ttRow('Mua chủ động', share == null ? '—' : `${num(share, 1, { signed: true })}% KL`);
    },
  });
}

/* ---------- CVD luỹ tiến ---------- */

export function drawCvd(svg, tip, snap) {
  clear(svg);
  const s = snap.series;
  const vals = s.cvd.filter((v) => v != null);
  if (!vals.length) return;
  const H = 150;
  const W = setup(svg, H);
  const padL = 6, padR = 56, padT = 12, padB = 12;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = s.cvd.length;
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || Math.abs(hi) || 1;
  const step = plotW / Math.max(1, n - 1);
  const xOf = (i) => padL + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
  const yOf = (v) => padT + plotH - ((v - lo) / span) * plotH;
  const col = cssVar('--accent');

  for (const v of [lo, lo + span / 2, hi]) {
    svg.appendChild(mk('line', { x1: padL, y1: yOf(v), x2: W - padR, y2: yOf(v), class: 'grid-line' }));
    svg.appendChild(mk('text', { x: W - padR + 6, y: yOf(v) + 4 }, compact(v)));
  }
  const pts = [];
  for (let i = 0; i < n; i++) if (s.cvd[i] != null) pts.push(`${xOf(i)},${yOf(s.cvd[i])}`);
  if (pts.length > 1) {
    svg.appendChild(mk('polyline', {
      points: pts.join(' '), fill: 'none', stroke: col, 'stroke-width': 2, 'stroke-linejoin': 'round',
    }));
  }
  const lastIdx = s.cvd.map((v) => v != null).lastIndexOf(true);
  if (lastIdx >= 0) {
    svg.appendChild(mk('circle', {
      cx: xOf(lastIdx), cy: yOf(s.cvd[lastIdx]), r: 4.5, fill: col, stroke: cssVar('--surface'), 'stroke-width': 2,
    }));
  }

  attachCrosshair(svg, tip, {
    left: padL, step, count: n, xOf: (i) => xOf(i), top: padT, bottom: padT + plotH,
    html: (i) => (s.cvd[i] == null ? null
      : `<div class="tt-time">${esc(timeLabel(s.time[i], snap.interval))}</div>`
        + ttRow('CVD luỹ tiến', compact(s.cvd[i]))
        + ttRow('Độ dốc', s.cvdSlope[i] == null ? '—' : `${num(s.cvdSlope[i] * 100, 1, { signed: true })}% KL`)),
  });
}

/* ---------- Mua chủ động ròng mỗi nến ---------- */

export function drawFlow(svg, tip, snap) {
  clear(svg);
  const s = snap.series;
  const H = 120;
  const W = setup(svg, H);
  const padL = 6, padR = 56, padT = 8, padB = 8;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = s.cvdDelta.length;
  // Chuẩn hoá theo khối lượng từng nến để so được giữa nến to và nến nhỏ.
  const share = s.cvdDelta.map((d, i) => (d != null && s.volume[i] ? d / s.volume[i] : null));
  const extent = Math.max(...share.filter((v) => v != null).map(Math.abs), 0.05);
  const step = plotW / n;
  const xOf = (i) => padL + step * (i + 0.5);
  const yOf = (v) => padT + plotH / 2 - (v / extent) * (plotH / 2);
  const barW = Math.max(1, Math.min(7, step * 0.66));

  svg.appendChild(mk('line', { x1: padL, y1: yOf(0), x2: W - padR, y2: yOf(0), class: 'axis-line' }));
  for (let i = 0; i < n; i++) {
    const v = share[i];
    if (v == null) continue;
    svg.appendChild(mk('rect', {
      x: xOf(i) - barW / 2, y: v >= 0 ? yOf(v) : yOf(0), width: barW,
      height: Math.max(0.8, Math.abs(yOf(v) - yOf(0))),
      fill: v >= 0 ? cssVar('--up') : cssVar('--down'), opacity: 0.8, rx: Math.min(1.5, barW / 3),
    }));
  }
  svg.appendChild(mk('text', { x: W - padR + 6, y: yOf(extent) + 8 }, `+${num(extent * 100, 0)}%`));
  svg.appendChild(mk('text', { x: W - padR + 6, y: yOf(0) + 4 }, '0'));
  svg.appendChild(mk('text', { x: W - padR + 6, y: yOf(-extent) }, `−${num(extent * 100, 0)}%`));

  attachCrosshair(svg, tip, {
    left: padL, step, count: n, xOf, top: padT, bottom: padT + plotH,
    html: (i) => (share[i] == null ? null
      : `<div class="tt-time">${esc(timeLabel(s.time[i], snap.interval))}</div>`
        + ttRow('Mua chủ động ròng', `<span class="${share[i] >= 0 ? 'up' : 'down'}">${num(share[i] * 100, 1, { signed: true })}% KL</span>`)
        + ttRow('Delta', compact(s.cvdDelta[i]))
        + ttRow('Khối lượng', compact(s.volume[i]))),
  });
}
