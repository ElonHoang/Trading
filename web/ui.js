// Phần giao diện dùng chung cho dashboard (/) và trang realtime (/realtime/):
// giao diện sáng/tối, chú thích thuật ngữ, và các khối HTML (kết luận, thang điểm,
// "vì sao", thang giá). Hai trang gọi cùng hàm nên luôn hiện giống nhau.
//
// Mọi chuỗi động đều đi qua esc() trước khi chèn vào HTML.

import { fmt, pct, decimalsFor } from '../src/chart/render.js';

/* ---------- định dạng ---------- */

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/** Số kiểu vi-VN, có dấu +/− khi `signed`. Dùng dấu trừ thật (−) cho dễ đọc. */
export function num(v, digits = 1, { signed = false } = {}) {
  if (v == null || !Number.isFinite(v)) return '—';
  const r = Number(v.toFixed(digits));
  const body = Math.abs(r).toLocaleString('vi-VN', {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  });
  if (r < 0) return `−${body}`;
  return signed && r > 0 ? `+${body}` : body;
}

export const toneOf = (v) => (v == null || v === 0 ? '' : v > 0 ? 'up' : 'down');

/* ---------- giao diện sáng / tối ---------- */

const THEME_KEY = 'ta.theme';

export function storedTheme() {
  try { return localStorage.getItem(THEME_KEY) || ''; } catch { return ''; }
}

function applyTheme(mode) {
  if (mode) document.documentElement.setAttribute('data-theme', mode);
  else document.documentElement.removeAttribute('data-theme');
}

export function isDark() {
  const t = document.documentElement.getAttribute('data-theme');
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Áp giao diện đã lưu; gắn nút đổi sáng/tối. `onChange` chạy để vẽ lại biểu đồ. */
export function initTheme(button, onChange) {
  applyTheme(storedTheme());
  const label = () => {
    button.textContent = isDark() ? '☀' : '☾';
    const to = isDark() ? 'sáng' : 'tối';
    button.title = `Chuyển sang giao diện ${to}`;
    button.setAttribute('aria-label', `Chuyển sang giao diện ${to}`);
  };
  label();
  button.addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* chế độ riêng tư */ }
    label();
    onChange?.();
  });
  // Đang theo hệ thống thì đổi theo khi hệ thống đổi.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!storedTheme()) { label(); onChange?.(); }
  });
}

export const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * Màu cho bộ vẽ canvas dùng chung (src/chart/render.js). Phải là hex 6 ký tự vì
 * bộ vẽ nối thêm 2 ký tự alpha vào sau.
 */
export function chartColors() {
  const v = (n) => cssVar(n);
  return {
    up: v('--up'), down: v('--down'), support: v('--up'), resistance: v('--down'),
    stop: v('--down'), target: v('--up'),
    volAvg: v('--text-3'), cvd: v('--accent'), entry: v('--accent'), accent: v('--accent'),
    accentInk: v('--accent-ink'),
    grid: v('--line'), gridSoft: v('--line-strong'), text: v('--text-3'),
    bg: v('--surface'), crosshair: v('--text-3'),
  };
}

/* ---------- thuật ngữ có chú thích ---------- */

// Mỗi mục: [tên đầy đủ, giải thích bằng lời thường]. Định nghĩa bám theo
// .claude/skills/chi-bao/SKILL.md để không lệch với tài liệu của dự án.
const GLOSSARY = {
  score: ['Điểm tổng hợp', 'Gộp kết quả của nhiều nhóm chỉ báo thành một số từ −100 (nghiêng giảm rất mạnh) đến +100 (nghiêng tăng rất mạnh). Càng gần 0 càng chưa rõ hướng.'],
  cvd: ['CVD — dòng tiền chủ động', 'Hiệu số giữa khối lượng mua chủ động (bấm “mua ngay”) và bán chủ động (bấm “bán ngay”), cộng dồn theo thời gian. Đường đi lên = người mua đang chủ động hơn.'],
  taker: ['Mua chủ động ròng', 'Phần khối lượng của nến do người “mua ngay” tạo ra, trừ đi phần “bán ngay”, tính theo % khối lượng nến. Dương = mua chủ động nhiều hơn.'],
  volume: ['Khối lượng', 'Tổng lượng giao dịch trong một nến. Dùng để xác nhận: giá chạy mạnh mà khối lượng nhỏ thường kém đáng tin.'],
  support: ['Hỗ trợ (HT)', 'Vùng giá mà trước đây giá nhiều lần dừng giảm rồi bật lên. Số lần chạm càng nhiều, mức càng đáng tin.'],
  resistance: ['Kháng cự (KC)', 'Vùng giá mà trước đây giá nhiều lần bị chặn lại rồi quay xuống. Số lần chạm càng nhiều, mức càng đáng tin.'],
  touches: ['Số lần chạm', 'Giá đã chạm vùng này bao nhiêu lần trong lịch sử gần đây. Nhiều lần chạm = vùng được thị trường để ý.'],
  wall: ['Tường lệnh', 'Mức giá có lượng lệnh chờ mua (tường mua) hoặc chờ bán (tường bán) lớn bất thường trong sổ lệnh, có thể cản giá. Lưu ý: lệnh lớn có thể bị đặt rồi huỷ để đánh lừa, nên luôn đối chiếu với CVD và khối lượng.'],
  oi: ['Open Interest (OI)', 'Tổng số hợp đồng phái sinh đang mở. Giá và OI cùng tăng = tiền mới đang vào theo xu hướng; OI giảm = lực đang cạn.'],
  funding: ['Funding rate', 'Phí định kỳ giữa phe Long và phe Short. Dương cao = đám đông nghiêng về Long, quá cao thì dễ bị đạp xuống để thanh lý; âm sâu thì ngược lại.'],
  orderbook: ['Sổ lệnh lệch', 'Chênh lệch giữa tổng lệnh chờ mua và chờ bán gần giá hiện tại. Dương = nhiều lệnh chờ mua hơn.'],
  positioning: ['Định vị đám đông', 'Tỉ lệ tài khoản đang Long/Short và vị thế của nhóm trader lớn. Đám đông lệch quá mạnh về một phía thường là tín hiệu ngược.'],
  pattern: ['Mẫu hình lịch sử', 'Tìm những đoạn biểu đồ trong quá khứ có hình dạng giống hiện tại, rồi xem giá đã đi thế nào sau đó.'],
  derivatives: ['Phái sinh', 'Dữ liệu thị trường hợp đồng tương lai: Open Interest và funding rate.'],
  entry: ['Vào lệnh', 'Mức giá tham chiếu để mở lệnh, lấy từ giá đóng nến gần nhất.'],
  stop: ['Cắt lỗ (Stop loss)', 'Mức giá bạn tự thoát lệnh để giới hạn thua lỗ nếu giá đi ngược dự đoán.'],
  target: ['Chốt lời (TP)', 'Mức giá để chốt lãi. TP1 là mục tiêu gần nhất, TP2… xa hơn.'],
  r: ['Bội số R', '1R = số tiền bạn chấp nhận lỗ nếu chạm cắt lỗ. Mục tiêu 2R = lãi gấp đôi mức có thể lỗ.'],
  long: ['LONG', 'Đặt cược giá sẽ tăng (mua trước, bán sau).'],
  short: ['SHORT', 'Đặt cược giá sẽ giảm (bán trước, mua lại sau).'],
  interval: ['Khung nến', 'Mỗi cây nến thể hiện khoảng thời gian này: m = phút, h = giờ, d = ngày, w = tuần.'],
  ml: ['Mô hình học máy (ML)', 'Chương trình học từ dữ liệu quá khứ để ước tính xác suất giá tăng trong vài nến tới. Chỉ được tính vào điểm khi đủ độ tin cậy.'],
  auc: ['AUC', 'Thang đo khả năng mô hình phân biệt đúng cú tăng với cú giảm trên dữ liệu chưa từng thấy. 0,5 ≈ đoán bừa; càng gần 1 càng tốt.'],
  holdout: ['Kiểm thử holdout', 'Thử mô hình trên một phần dữ liệu được giữ riêng, không dùng khi huấn luyện.'],
  walkforward: ['Walk-forward', 'Thử mô hình theo từng đoạn thời gian nối tiếp nhau, giống cách dùng thật: học quá khứ, đoán tương lai.'],
  htf: ['Khung lớn hơn', 'Xu hướng ở khung thời gian lớn hơn. Tín hiệu đi ngược khung lớn thường yếu hơn.'],
  candle: ['Nến', 'Nến xanh = giá đóng cao hơn giá mở; nến đỏ = giá đóng thấp hơn giá mở. Râu nến là mức cao/thấp nhất trong nến.'],
};

/** HTML của một thuật ngữ có chú thích (hiện khi rê chuột, chạm hoặc focus). */
export function term(key, label) {
  const g = GLOSSARY[key];
  if (!g) return esc(label ?? key);
  return `<span class="term" tabindex="0" role="button" data-term="${esc(key)}">${esc(label ?? g[0])}</span>`;
}

export function termText(key) { return GLOSSARY[key]?.[1] ?? ''; }

let tipEl = null;
let tipFor = null;

function hideTip() {
  tipEl?.classList.remove('on');
  tipFor = null;
}

function showTip(target) {
  const g = GLOSSARY[target.dataset.term];
  if (!g) return;
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.id = 'term-tip';
    tipEl.setAttribute('role', 'tooltip');
    document.body.appendChild(tipEl);
  }
  tipEl.innerHTML = `<b>${esc(g[0])}</b>${esc(g[1])}`;
  tipFor = target;
  // Đo rồi kẹp vào khung nhìn, để không bao giờ tràn mép màn hình điện thoại.
  tipEl.style.left = '0px';
  tipEl.style.top = '0px';
  const r = target.getBoundingClientRect();
  const w = tipEl.offsetWidth;
  const h = tipEl.offsetHeight;
  let left = r.left + r.width / 2 - w / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  let top = r.top - h - 8;
  if (top < 8) top = r.bottom + 8;
  tipEl.style.left = `${left}px`;
  tipEl.style.top = `${top}px`;
  tipEl.classList.add('on');
}

/** Gắn một lần cho cả trang (uỷ quyền sự kiện, nên nội dung vẽ lại vẫn hoạt động). */
export function initTerms() {
  const termOf = (e) => e.target.closest?.('.term');
  document.addEventListener('mouseover', (e) => { const t = termOf(e); if (t) showTip(t); });
  document.addEventListener('mouseout', (e) => { if (termOf(e)) hideTip(); });
  document.addEventListener('focusin', (e) => { const t = termOf(e); if (t) showTip(t); });
  document.addEventListener('focusout', (e) => { if (termOf(e)) hideTip(); });
  // Cảm ứng: chạm để mở, chạm chỗ khác để đóng.
  document.addEventListener('click', (e) => {
    const t = termOf(e);
    if (t) { if (tipFor === t && tipEl.classList.contains('on') && e.pointerType === 'touch') hideTip(); else showTip(t); } else hideTip();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); });
  window.addEventListener('scroll', hideTip, { passive: true });
}

/* ---------- nhãn nhóm tín hiệu ---------- */

export const GROUP_LABELS = {
  cvd: ['cvd', 'Dòng tiền chủ động (CVD)'],
  volume: ['volume', 'Khối lượng'],
  derivatives: ['derivatives', 'Phái sinh (OI + funding)'],
  positioning: ['positioning', 'Định vị đám đông'],
  structure: ['support', 'Hỗ trợ / kháng cự'],
  orderBook: ['orderbook', 'Sổ lệnh'],
  historicalPattern: ['pattern', 'Mẫu hình lịch sử'],
};

export const groupName = (key) => GROUP_LABELS[key]?.[1] ?? key;
const groupTerm = (key) => (GROUP_LABELS[key] ? term(GROUP_LABELS[key][0], GROUP_LABELS[key][1]) : esc(key));

/* ---------- kết luận ---------- */

// Câu giải thích bằng lời thường cho từng mức tín hiệu của engine.
const VERDICTS = {
  'MUA MẠNH': { tone: 'up', icon: '▲▲', text: 'Hầu hết các nhóm chỉ báo cùng nghiêng về tăng.' },
  MUA: { tone: 'up', icon: '▲', text: 'Các chỉ báo đang nghiêng về tăng.' },
  'TRUNG LẬP': { tone: 'flat', icon: '■', text: 'Chưa có hướng rõ ràng — tín hiệu chưa đủ mạnh để vào lệnh.' },
  BÁN: { tone: 'down', icon: '▼', text: 'Các chỉ báo đang nghiêng về giảm.' },
  'BÁN MẠNH': { tone: 'down', icon: '▼▼', text: 'Hầu hết các nhóm chỉ báo cùng nghiêng về giảm.' },
};

export const verdictFor = (signal) => VERDICTS[signal] ?? VERDICTS['TRUNG LẬP'];

/** Thang điểm −100…+100 chia vùng theo ngưỡng của chiến lược, kim chỉ điểm hiện tại. */
export function meterHTML(score, t) {
  const th = { strongBuy: 50, buy: 30, sell: -30, strongSell: -50, ...(t ?? {}) };
  const w = (a, b) => ((b - a) / 200) * 100;
  const pos = Math.max(0, Math.min(100, ((score + 100) / 200) * 100));
  const at = (v) => ((v + 100) / 200) * 100;
  return `
    <div class="meter" role="img" aria-label="Điểm ${num(score, 1, { signed: true })} trên thang từ −100 đến +100">
      <i class="z-down2" style="width:${w(-100, th.strongSell)}%"></i>
      <i class="z-down1" style="width:${w(th.strongSell, th.sell)}%"></i>
      <i class="z-flat" style="width:${w(th.sell, th.buy)}%"></i>
      <i class="z-up1" style="width:${w(th.buy, th.strongBuy)}%"></i>
      <i class="z-up2" style="width:${w(th.strongBuy, 100)}%"></i>
      <span class="meter-pin" style="left:${pos}%"></span>
    </div>
    <div class="meter-scale" aria-hidden="true">
      <span style="left:0">Giảm mạnh</span>
      <span class="opt" style="left:${at((th.strongSell + th.sell) / 2)}%">Bán</span>
      <span style="left:${at(0)}%">Trung lập</span>
      <span class="opt" style="left:${at((th.buy + th.strongBuy) / 2)}%">Mua</span>
      <span style="left:100%">Tăng mạnh</span>
    </div>`;
}

/** Tối đa `n` nhóm đóng góp nhiều nhất vào điểm, kèm chiều tăng/giảm. */
export function topReasons(snap, n = 3) {
  return Object.entries(snap.rules?.breakdown ?? {})
    .filter(([, v]) => v.weight > 0 && Math.abs(v.contributionPct) >= 0.5)
    .sort((a, b) => Math.abs(b[1].contributionPct) - Math.abs(a[1].contributionPct))
    .slice(0, n)
    .map(([key, v]) => ({ key, value: v.contributionPct }));
}

function planHTML(levels, price) {
  if (!levels || levels.side === 'none' || levels.entry == null) return '';
  const d = decimalsFor(levels.entry);
  const move = (p) => ((p - levels.entry) / levels.entry) * 100;
  const isLong = levels.side === 'long';
  const tiles = [
    `<div class="tile"><span>${term('entry')}</span><b>${fmt(levels.entry, d)}</b></div>`,
  ];
  if (levels.stopLoss != null) {
    tiles.push(`<div class="tile down"><span>${term('stop')}</span><b>${fmt(levels.stopLoss, d)}</b>`
      + `<small>${pct(move(levels.stopLoss), 1)}</small></div>`);
  }
  for (const t of levels.targets ?? []) {
    tiles.push(`<div class="tile up"><span>${esc(t.label)}${t.r != null ? ` · ${num(t.r, 1)}R` : ''}</span>`
      + `<b>${fmt(t.price, d)}</b><small>${pct(move(t.price), 1)}</small></div>`);
  }
  return `
    <div class="plan">
      <div class="plan-title">Kịch bản ${term(isLong ? 'long' : 'short')}
        <small>mức tham chiếu tính từ giá đóng nến · ${term('r', 'R là gì?')}</small></div>
      <div class="plan-tiles">${tiles.join('')}</div>
    </div>`;
}

/**
 * Khối kết luận: nhãn lớn + một câu giải thích, giá, thang điểm, ba lý do chính,
 * kịch bản (nếu có) và cảnh báo mâu thuẫn.
 * `price`/`change24h` do trang truyền vào vì trang realtime có giá chạy theo từng tick.
 */
export function verdictHTML(snap, { thresholds, price, change24h, note = '' }) {
  const v = verdictFor(snap.combined.signal);
  const d = decimalsFor(price);
  const reasons = topReasons(snap, 3).map((r) => {
    const tone = toneOf(r.value);
    const arrow = tone === 'up' ? '▲' : tone === 'down' ? '▼' : '';
    return `<span class="pill ${tone}">${arrow} ${esc(groupName(r.key))} ${num(r.value, 1, { signed: true })}</span>`;
  }).join('');
  const conflicts = (snap.conflicts ?? []).length
    ? `<div class="callout" role="note"><b aria-hidden="true">⚠</b><ul>${snap.conflicts.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>`
    : '';
  const h = snap.higherTimeframe;
  const htfTone = h ? { up: 'up', down: 'down' }[verdictFor(h.signal).tone] ?? '' : '';
  const htf = h && typeof h.ruleScore === 'number'
    ? `<span class="pill ${htfTone}">${term('htf')} ${esc(h.interval)}: ${esc(h.signal)}</span>` : '';
  const mlNote = snap.ml?.available && !(snap.combined.mlWeightUsed > 0)
    ? '<span class="pill">ML chỉ để tham khảo — chưa tính vào điểm</span>' : '';

  return `
    <section class="card verdict" data-tone="${v.tone}" aria-label="Kết luận phân tích">
      <div>
        <div class="verdict-kicker">${esc(snap.symbol)} · ${term('interval', `khung ${snap.interval}`)}</div>
        <div class="verdict-signal"><span class="verdict-icon" aria-hidden="true">${v.icon}</span><span>${esc(snap.combined.signal)}</span></div>
        <p class="verdict-sentence">${esc(v.text)}</p>
        <div class="verdict-price">
          <span class="price" id="bigPrice">${fmt(price, d)}</span>
          ${change24h != null ? `<span class="delta ${toneOf(change24h)}" id="bigDelta">${pct(change24h)} / 24h</span>` : '<span class="delta" id="bigDelta"></span>'}
        </div>
        ${note ? `<div class="verdict-note">${esc(note)}</div>` : ''}
      </div>
      <div>
        <div class="meter-head">${term('score')} <strong>${num(snap.combined.score, 1, { signed: true })}</strong><span>/ 100</span></div>
        ${meterHTML(snap.combined.score, thresholds)}
        <div class="why"><span class="why-title">Điểm chính đến từ:</span>${reasons || '<span class="muted">chưa có nhóm nào nổi bật</span>'}${htf}${mlNote}</div>
      </div>
      ${planHTML(snap.levels, price)}
      ${conflicts}
    </section>`;
}

/* ---------- vì sao ra kết luận: đóng góp từng nhóm ---------- */

export function breakdownHTML(snap) {
  const entries = Object.entries(snap.rules?.breakdown ?? {})
    .filter(([, v]) => v.weight > 0)
    .sort((a, b) => Math.abs(b[1].contributionPct) - Math.abs(a[1].contributionPct));
  if (!entries.length) return '<p class="muted">Chưa có nhóm tín hiệu nào.</p>';
  const maxAbs = Math.max(...entries.map(([, v]) => Math.abs(v.contributionPct)), 8);

  const rows = entries.map(([key, v]) => {
    const val = v.contributionPct;
    const tone = toneOf(val);
    const w = (Math.abs(val) / maxAbs) * 50;
    const bar = val >= 0 ? `left:50%;width:${w}%` : `left:${50 - w}%;width:${w}%`;
    const reasons = (v.reasons ?? []).map((r) => `<li>${esc(r)}</li>`).join('');
    return `
      <li><details class="why-row">
        <summary>
          <span class="why-name">${groupTerm(key)}</span>
          <span class="dbar" aria-hidden="true"><i class="${tone}" style="${bar}"></i></span>
          <span class="why-val ${tone}">${num(val, 1, { signed: true })}</span>
        </summary>
        <ul class="why-reasons">${reasons || '<li>Không có ghi chú.</li>'}</ul>
      </details></li>`;
  }).join('');

  return `
    <div class="why-scale" aria-hidden="true"><span>◀ nghiêng giảm</span><span>nghiêng tăng ▶</span></div>
    <ul class="why-list">${rows}</ul>`;
}

/* ---------- thang giá: kháng cự / giá hiện tại / hỗ trợ ---------- */

/**
 * Chọn tối đa `perSide` mức gần giá nhất mỗi phía. Hai mức cách nhau dưới `minGapPct`
 * thì chỉ giữ mức đã được chạm nhiều hơn — nếu không chúng chồng lên nhau trên chart.
 */
export function nearestLevels(structure, price, { perSide = 2, minGapPct = 0.8 } = {}) {
  const pick = (list, above) => {
    const sorted = (list ?? [])
      .filter((l) => (above ? l.price > price : l.price < price))
      .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price));
    const out = [];
    for (const l of sorted) {
      const near = out.find((o) => Math.abs(o.price - l.price) / price * 100 < minGapPct);
      if (near) { if ((l.touches ?? 0) > (near.touches ?? 0)) out[out.indexOf(near)] = l; continue; }
      if (out.length < perSide) out.push(l);
    }
    return out;
  };
  return { support: pick(structure?.support, false), resistance: pick(structure?.resistance, true) };
}

export function ladderHTML(snap, price) {
  const d = decimalsFor(price);
  const near = nearestLevels(snap.structure, price, { perSide: 3, minGapPct: 0.3 });
  const row = (cls, l) => `
    <li class="${cls}">
      <span class="lv-price">${fmt(l.price, d)}</span>
      <span class="lv-dist">${pct(((l.price - price) / price) * 100, 1)}</span>
      <span class="lv-touch">${l.touches} lần chạm</span>
    </li>`;
  const none = (txt) => `<li class="empty">${txt}</li>`;
  return `
    <div class="ladder-label">${term('resistance', 'KHÁNG CỰ')} — giá thường bị chặn ở đây</div>
    <ul class="ladder">
      ${near.resistance.length ? [...near.resistance].reverse().map((l) => row('res', l)).join('') : none('Không có mức nào gần phía trên')}
    </ul>
    <ul class="ladder"><li class="now"><span class="lv-price">${fmt(price, d)}</span><span class="lv-dist">giá hiện tại</span><span class="lv-touch"></span></li></ul>
    <div class="ladder-label">${term('support', 'HỖ TRỢ')} — giá thường bật lên ở đây</div>
    <ul class="ladder">
      ${near.support.length ? near.support.map((l) => row('sup', l)).join('') : none('Không có mức nào gần phía dưới')}
    </ul>`;
}
