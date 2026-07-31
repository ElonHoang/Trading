// Soạn nội dung tin nhắn Telegram từ snapshot của engine.analyze().
// Thuần hàm, không phụ thuộc grammy, nên test được riêng.
//
// Cấu trúc bám đúng mục "Cấu trúc khi call lệnh" trong CLAUDE.md.

import { fmt, pct, compact, decimalsFor } from '../chart/render.js';

export const CAPTION_LIMIT = 1024;   // giới hạn caption ảnh của Telegram
const HR = '━━━━━━━━━━━━━━━━━━';

// Telegram parse_mode HTML: chỉ 3 ký tự này cần escape.
export const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Caption cho ảnh chart theo đúng template trong CLAUDE.md.
 * `setup` và `projections` là tuỳ chọn — thiếu thì bỏ khối tương ứng.
 */
export function buildCaption(snap, { setup = null, projections = null } = {}) {
  const d = decimalsFor(snap.price.lastClose);
  const ind = snap.indicators;
  const der = snap.derivatives;
  const p = snap.positioning;
  const ob = snap.orderBook;
  const L = [];

  // ---- Đầu ----
  L.push(`🔥 <b>${esc(snap.symbol)}</b> | Khung ${esc(snap.interval)}`);
  L.push(`💰 Giá hiện tại: <b>${fmt(snap.price.lastClose, d)}</b>`
    + (snap.price.change24hPercent != null ? ` (${pct(snap.price.change24hPercent)})` : ''));

  const side = setup?.side ?? 'none';
  if (setup?.blocked) {
    L.push(`🚨 KHUYẾN NGHỊ: ⛔ <b>ĐỨNG NGOÀI</b> (Điểm: ${snap.combined.score}/100)`);
  } else if (side === 'long') {
    L.push(`🚨 KHUYẾN NGHỊ: 🟢 <b>LONG / MUA</b> (Điểm: ${snap.combined.score}/100)`);
  } else if (side === 'short') {
    L.push(`🚨 KHUYẾN NGHỊ: 🔴 <b>SHORT / BÁN</b> (Điểm: ${snap.combined.score}/100)`);
  } else {
    L.push(`🚨 KHUYẾN NGHỊ: ⚪ <b>CHỜ TÍN HIỆU</b> (Điểm: ${snap.combined.score}/100)`);
  }

  // ---- Chi tiết lệnh (chỉ khi thật sự có kèo) ----
  if (side !== 'none' && setup?.entry != null) {
    L.push(HR);
    L.push('🎯 <b>CHI TIẾT LỆNH</b>');
    L.push(`• Entry (Vào lệnh): ${fmt(setup.entry, d)}`);
    L.push(`• Stoploss (Cắt lỗ): ${fmt(setup.stopLoss, d)} (Rủi ro ${fmt(setup.riskPercent, 2)}%)`);
    const tps = setup.targets ?? [];
    if (tps.length) {
      L.push('• Take Profit (Chốt lời):');
      for (let i = 0; i < tps.length; i++) {
        const move = ((tps[i].price - setup.entry) / setup.entry) * 100;
        L.push(`   👉 TP ${i + 1}: ${fmt(tps[i].price, d)} (${pct(move)})`);
      }
    }
    if (setup.rrToTp1) L.push(`⚖️ Tỷ lệ R:R: ${fmt(setup.rrToTp1, 2)}`);
  }

  // ---- Dữ liệu thị trường ----
  L.push(HR);
  L.push('📊 <b>DỮ LIỆU THỊ TRƯỜNG</b>');
  const sup = snap.structure?.support?.[0];
  const res = snap.structure?.resistance?.[0];
  L.push(`• Hỗ trợ/Kháng cự : HT ${sup ? fmt(sup.price, d) : '—'} | KC ${res ? fmt(res.price, d) : '—'}`);
  L.push(`• Dòng tiền (CVD) : CVD ${ind.cvdSlope == null ? '—' : pct(ind.cvdSlope * 100, 1)}`
    + ` | Vol ${ind.volumeRatio == null ? '—' : `${fmt(ind.volumeRatio, 2)}x`}`
    + ` | Sổ lệnh ${ob ? pct(ob.imbalance * 100, 1) : '—'}`);
  L.push(`• Tâm lý đám đông : Funding ${der?.fundingRatePercent != null ? pct(der.fundingRatePercent, 4) : '—'}`
    + ` | OI ${der?.openInterestChangePct != null ? pct(der.openInterestChangePct) : '—'}`
    + ` | ${p?.longAccountPercent != null ? `${fmt(p.longAccountPercent, 1)}% Đang Long` : '—'}`);

  // ---- Lý do ----
  const reasons = (setup?.reasons ?? []).slice(0, 3);
  const cautions = (setup?.cautions ?? []).slice(0, 2);
  if (reasons.length || cautions.length || setup?.blockers?.length) {
    L.push(HR);
    L.push('💡 <b>LÝ DO VÀO LỆNH</b>');
    for (const b of setup?.blockers ?? []) L.push(`⛔ ${esc(b)}`);
    for (const r of reasons) L.push(`🔻 ${esc(r.text)}`);
    for (const c of cautions) L.push(`⚠️ ${esc(c.text)}`);
  }

  // ---- Kịch bản chờ ----
  // Template trong CLAUDE.md không có khối này khi ĐANG call lệnh. Nhưng lúc
  // chưa có kèo thì khối "CHI TIẾT LỆNH" trống, tin nhắn sẽ không có gì hành
  // động được — nên chỉ khi đó mới nêu hai mốc cần chờ.
  if (projections && side === 'none') {
    L.push(HR);
    L.push('⚠️ <b>MỐC CẦN CHỜ</b> (chờ nến đóng xác nhận)');
    const tpOf = (proj) => (proj.targets ?? []).slice(0, 2).map((t) => fmt(t.price, d)).join('/');
    L.push(`📈 Phá lên ${fmt(projections.up.entry, d)} → Long `
      + `(SL ${fmt(projections.up.stopLoss, d)} | TP ${tpOf(projections.up)})`);
    L.push(`📉 Thủng qua ${fmt(projections.down.entry, d)} → Short `
      + `(SL ${fmt(projections.down.stopLoss, d)} | TP ${tpOf(projections.down)})`);
  }

  return L.join('\n');
}

/**
 * Caption dài hơn giới hạn của Telegram thì phải tách: ảnh giữ phần đầu (kèo),
 * phần còn lại gửi thành tin riêng. Cắt theo DÒNG chứ không cắt giữa dòng, và
 * không cắt giữa thẻ HTML — nếu không Telegram từ chối cả tin.
 */
export function splitCaption(text, limit = CAPTION_LIMIT) {
  if (text.length <= limit) return { caption: text, rest: null };
  const lines = text.split('\n');
  const head = [];
  let used = 0;
  for (const line of lines) {
    // +1 cho ký tự newline
    if (used + line.length + 1 > limit - 20) break;
    head.push(line);
    used += line.length + 1;
  }
  const rest = lines.slice(head.length).join('\n');
  return {
    caption: `${head.join('\n')}\n<i>(xem tiếp bên dưới)</i>`,
    rest: rest.trim() || null,
  };
}

/** Tin nhắn giá nhanh cho /gia. */
export function buildQuoteMessage(snap) {
  const d = decimalsFor(snap.price.lastClose);
  const chg = snap.price.change24hPercent != null
    ? `  ${pct(snap.price.change24hPercent)} (24h)` : '';
  const ind = snap.indicators;
  return `<b>${esc(snap.symbol)}</b> · ${esc(snap.interval)}  ${fmt(snap.price.lastClose, d)}${chg}\n`
    + `${esc(snap.combined.signal)} (${snap.combined.score}/100) · `
    + `CVD ${ind.cvdSlope == null ? '—' : pct(ind.cvdSlope * 100, 1)} · `
    + `Vol ${ind.volumeRatio == null ? '—' : `${fmt(ind.volumeRatio, 2)}×`}`;
}
