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

  // Tường lệnh không vẽ trên ảnh nữa (rối mắt) -> nêu ở đây, mỗi bên mức lớn nhất.
  const bidWall = (ob?.walls ?? []).find((w) => w.side === 'bid');
  const askWall = (ob?.walls ?? []).find((w) => w.side === 'ask');
  if (bidWall || askWall) {
    L.push(`• Tường lệnh : ${bidWall ? `MUA ${fmt(bidWall.price, d)} (${fmt(bidWall.ratioToAvg, 0)}x)` : '—'}`
      + ` | ${askWall ? `BÁN ${fmt(askWall.price, d)} (${fmt(askWall.ratioToAvg, 0)}x)` : '—'}`);
  }

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

/**
 * Tin cập nhật khi kèo chạm TP, theo mục "cấu trúc sau khi done tp call kèo"
 * trong README.md.
 *
 * @param call    kèo đang mở (từ data/open-calls.js)
 * @param hitTps  nhãn các TP vừa chạm trong lượt này, vd ['TP1']
 * @param snap    snapshot mới nhất, để nhận định dòng tiền còn thuận hay không
 * @param risk    strategy.risk — quyết định % chốt và đòn bẩy để quy đổi lợi nhuận
 */
export function buildTpUpdate(call, hitTps, snap = null, risk = {}) {
  const d = decimalsFor(call.entry);
  const isLong = call.side === 'long';
  const targets = call.targets ?? [];
  const lastLabel = hitTps[hitTps.length - 1];
  const tp = targets.find((t) => t.label === lastLabel);
  const idx = targets.findIndex((t) => t.label === lastLabel);
  const isFinal = idx === targets.length - 1;
  const nextTp = targets[idx + 1] ?? null;

  // Lợi nhuận tính trên giá TP vừa chạm, theo hướng lệnh.
  const spotPct = tp ? ((tp.price - call.entry) / call.entry) * 100 * (isLong ? 1 : -1) : null;
  const lev = risk.displayLeverage ?? 10;

  // % chốt lấy từ risk.partialFraction — cùng con số mà backtest dùng cho
  // chiến lược 'scaled', không phải số tự đặt ra.
  const partial = Math.round((risk.partialFraction ?? 0.5) * 100);

  const L = [];
  L.push(`🚀 <b>CẬP NHẬT: ${esc(call.symbol)} HIT ${isFinal ? 'TP FULL' : esc(lastLabel)}!</b>`);
  if (spotPct != null) {
    L.push(`💰 Lợi nhuận: ${pct(spotPct)} (Spot) | ${pct(spotPct * lev)} (Đòn bẩy ${lev}x)`);
  }

  L.push(HR);
  L.push('🎯 <b>CHI TIẾT CHỐT LỜI</b>');
  L.push(`• Entry đã gọi : ${fmt(call.entry, d)}`);
  L.push(`• Mốc TP vừa hit : ${tp ? fmt(tp.price, d) : '—'}`);
  L.push(`• Trạng thái lệnh : ${isFinal ? 'Chốt hết' : 'Đã chốt 1 phần, gồng tiếp'}`);

  L.push(HR);
  L.push('🛠 <b>HÀNH ĐỘNG TIẾP THEO</b>');
  if (isFinal) {
    L.push('✅ Chốt lời: Đóng 100% khối lượng còn lại tại đây.');
    L.push('🛡 Quản lý rủi ro: Lệnh đã đóng hết, không còn rủi ro.');
  } else {
    L.push(`✅ Chốt lời: Đóng ${idx === 0 ? partial : 50}% khối lượng lệnh tại đây.`);
    L.push(idx === 0
      ? '🛡 Quản lý rủi ro: Dời Stoploss về Entry (hoà vốn).'
      : `🛡 Quản lý rủi ro: Giữ Stoploss ở ${fmt(call.entry, d)} (entry).`);
    if (nextTp) L.push(`👀 Mục tiêu tiếp: ${esc(nextTp.label)} tại ${fmt(nextTp.price, d)}.`);
  }

  // Nhận định dựa trên dòng tiền hiện tại, không phải câu chữ cho có.
  const slope = snap?.indicators?.cvdSlope;
  if (slope != null) {
    const stillWith = isLong ? slope > 0 : slope < 0;
    L.push(HR);
    L.push('💡 <b>NHẬN ĐỊNH NGẮN</b>');
    L.push(stillWith
      ? `💬 CVD vẫn ${pct(slope * 100, 1)} cùng chiều lệnh — lực còn thuận, `
        + `${isFinal ? 'kèo đã chốt hết' : 'gồng phần còn lại được'}.`
      : `💬 CVD đã đảo sang ${pct(slope * 100, 1)} ngược chiều lệnh — `
        + `${isFinal ? 'chốt hết là hợp lý' : 'cân nhắc chốt sớm phần còn lại'}.`);
  }

  return L.join('\n');
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
