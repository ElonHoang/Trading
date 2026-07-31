// Soạn nội dung tin nhắn Telegram từ snapshot của engine.analyze().
// Thuần hàm, không phụ thuộc grammy, nên test được riêng.

import { fmt, pct, compact, decimalsFor } from '../chart/render.js';

export const CAPTION_LIMIT = 1024;   // giới hạn caption ảnh của Telegram

// Telegram parse_mode HTML: chỉ 3 ký tự này cần escape.
export const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function levelLine(list, price, d) {
  if (!list?.length) return '—';
  return list.slice(0, 3)
    .map((lv) => `${fmt(lv.price, d)} (${pct(lv.distancePct)}, ${lv.touches}x)`)
    .join(' · ');
}

/**
 * Caption cho ảnh chart, cắt bớt nếu vượt giới hạn của Telegram.
 * `setup` và `projections` là tuỳ chọn — thiếu thì caption vẫn đủ dùng.
 */
export function buildCaption(snap, { setup = null, projections = null } = {}) {
  const d = decimalsFor(snap.price.lastClose);
  const ind = snap.indicators;
  const lines = [];

  lines.push(`<b>${esc(snap.symbol)}</b> · ${esc(snap.interval)}`);
  lines.push(`<b>${fmt(snap.price.lastClose, d)}</b>`
    + (snap.price.change24hPercent != null ? `  ${pct(snap.price.change24hPercent)} (24h)` : ''));
  lines.push('');
  lines.push(`<b>${esc(snap.combined.signal)}</b>  điểm ${snap.combined.score}/100`
    + (snap.ml?.available ? ` · ML ${snap.ml.probUpPercent}% tăng` : ''));
  lines.push('');

  // Chỉ báo gộp thành 2 dòng để chừa chỗ cho kèo và phép chiếu — caption Telegram
  // chỉ có 1024 ký tự, trước đây phần phép chiếu bị cắt mất.
  const flow = [
    ind.volumeRatio != null ? `KL ${fmt(ind.volumeRatio, 2)}×` : null,
    ind.cvdSlope != null ? `CVD ${pct(ind.cvdSlope * 100, 1)}` : null,
    ind.cvdDeltaShare != null ? `nến ${pct(ind.cvdDeltaShare * 100, 1)}` : null,
  ].filter(Boolean);
  if (flow.length) lines.push(flow.join(' · '));

  const der = snap.derivatives;
  const p = snap.positioning;
  const deriv = [
    der?.fundingRate != null ? `funding ${pct(der.fundingRatePercent, 4)}` : null,
    der?.openInterestChangePct != null ? `OI ${pct(der.openInterestChangePct)}` : null,
    p?.longAccountPercent != null ? `${fmt(p.longAccountPercent, 1)}% long` : null,
    snap.orderBook ? `sổ lệnh ${pct(snap.orderBook.imbalance * 100, 1)}` : null,
  ].filter(Boolean);
  lines.push(deriv.length ? deriv.join(' · ') : 'Không có hợp đồng futures');

  const nearRes = snap.structure?.resistance?.[0];
  const nearSup = snap.structure?.support?.[0];
  if (nearRes || nearSup) {
    lines.push(`KC ${nearRes ? `${fmt(nearRes.price, d)} (${nearRes.touches}x)` : '—'}`
      + ` · HT ${nearSup ? `${fmt(nearSup.price, d)} (${nearSup.touches}x)` : '—'}`);
  }

  // Kèo hiện tại + lý do ngắn gọn (Kĩ năng 1 + 2)
  if (setup) {
    lines.push('');
    if (setup.blocked) {
      lines.push(`⛔ <b>ĐỨNG NGOÀI</b> — ${esc(setup.blockers[0] ?? 'bối cảnh phủ quyết')}`);
    } else if (setup.side === 'none') {
      lines.push(`⚪ <b>ĐỨNG NGOÀI</b> — ${esc(setup.note ?? 'chờ tín hiệu')}`);
    } else {
      lines.push(`${setup.side === 'long' ? '🟢' : '🔴'} <b>${setup.side === 'long' ? 'LONG' : 'SHORT'}</b>`
        + `  entry ${fmt(setup.entry, d)} · SL ${fmt(setup.stopLoss, d)} (−${fmt(setup.riskPercent, 2)}%)`);
      const tps = (setup.targets ?? []).map((tp) => `${tp.label} ${fmt(tp.price, d)}`).join(' · ');
      if (tps) lines.push(`   ${tps}${setup.rrToTp1 ? `  ·  R:R ${fmt(setup.rrToTp1, 2)}` : ''}`);
    }
    for (const r of (setup.reasons ?? []).slice(0, 3)) {
      lines.push(`   ✅ ${esc(r.text.slice(0, 110))}`);
    }
    for (const c of (setup.cautions ?? []).slice(0, 2)) {
      lines.push(`   ⚠️ ${esc(c.text.slice(0, 110))}`);
    }
  } else if (snap.conflicts?.length) {
    lines.push('');
    lines.push(`⚠️ ${esc(snap.conflicts[0])}`);
  }

  // Phép chiếu hai chiều — chờ xác nhận, khác với kèo vào ngay ở trên.
  if (projections) {
    lines.push('');
    lines.push('<b>PHÉP CHIẾU</b> (chờ nến đóng xác nhận)');
    for (const proj of [projections.up, projections.down]) {
      const star = projections.primary === proj.direction ? '★' : '·';
      lines.push(`${star} ${esc(proj.label)}: qua ${fmt(proj.entry, d)} → `
        + `SL ${fmt(proj.stopLoss, d)} · TP ${(proj.targets ?? []).map((tp) => fmt(tp.price, d)).join('/')}`
        + (proj.rrToStructure ? ` · R:R ${fmt(proj.rrToStructure, 2)}` : ''));
    }
  }

  const text = lines.join('\n');
  // Cắt phải chừa chỗ cho thẻ đóng, nếu không HTML sẽ hỏng và Telegram từ chối.
  return text.length > CAPTION_LIMIT
    ? `${text.slice(0, CAPTION_LIMIT - 24)}\n<i>(đã cắt)</i>`
    : text;
}

/** Tin nhắn giá nhanh cho /gia. */
export function buildQuoteMessage(snap) {
  const d = decimalsFor(snap.price.lastClose);
  const chg = snap.price.change24hPercent != null
    ? `  ${pct(snap.price.change24hPercent)} (24h)` : '';
  const ind = snap.indicators;
  return `<b>${esc(snap.symbol)}</b>  ${fmt(snap.price.lastClose, d)}${chg}\n`
    + `${esc(snap.combined.signal)} (${snap.combined.score}/100) · `
    + `CVD ${ind.cvdSlope == null ? '—' : pct(ind.cvdSlope * 100, 1)} · `
    + `KL ${ind.volumeRatio == null ? '—' : `${fmt(ind.volumeRatio, 2)}×`}`;
}
