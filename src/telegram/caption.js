// Soạn nội dung tin nhắn Telegram từ snapshot của engine.analyze().
// Thuần hàm, không phụ thuộc grammy, nên test được riêng.
//
// Cấu trúc bám đúng mục "Cấu trúc khi call lệnh" trong CLAUDE.md.

import { fmt, pct, decimalsFor } from '../chart/render.js';
import { tradeReturnPercent, tookPartialAtTp1 } from '../analysis/trade-pnl.js';

export const CAPTION_LIMIT = 1024;   // giới hạn caption ảnh của Telegram
const HR = '━━━━━━━━━━━━━━━━━━';

// Telegram parse_mode HTML: chỉ 3 ký tự này cần escape.
export const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Caption cho ảnh chart theo đúng template trong CLAUDE.md.
 * `setup` và `limitPlan` là tuỳ chọn — thiếu thì bỏ khối tương ứng.
 */
export function buildCaption(snap, { setup = null, limitPlan = null } = {}) {
  const d = decimalsFor(snap.price.lastClose);
  const L = [];

  // ---- Đầu ----
  L.push(`🔥 <b>${esc(snap.symbol)}</b> | Khung ${esc(snap.interval)}`);
  L.push(`💰 Giá hiện tại: <b>${fmt(snap.price.lastClose, d)}</b>`
    + (snap.price.change24hPercent != null ? ` (${pct(snap.price.change24hPercent)})` : ''));

  // Ba trạng thái, không hơn: LONG, SHORT, LIMIT. "ĐỨNG NGOÀI" và "CHỜ TÍN HIỆU"
  // đã bị bỏ khỏi mẫu — chưa vào được ngay thì là lệnh chờ, kèm giá ở khối bên dưới.
  //
  // Điểm cũng không in nữa; nó vẫn là thứ quyết định có call hay không
  // (alerts.minAbsScore).
  const side = setup?.side ?? 'none';
  if (side === 'long') {
    L.push('🚨 KHUYẾN NGHỊ: 🟢 <b>LONG / MUA</b>');
  } else if (side === 'short') {
    L.push('🚨 KHUYẾN NGHỊ: 🔴 <b>SHORT / BÁN</b>');
  } else {
    L.push('🚨 KHUYẾN NGHỊ: 🟡 <b>LIMIT</b>');
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

  // Khối "DỮ LIỆU THỊ TRƯỜNG" (S/R, CVD/volume/sổ lệnh, funding/OI/định vị,
  // tường lệnh) đã bị bỏ khỏi mẫu trong CLAUDE.md theo yêu cầu. Các số đó vẫn
  // được chấm điểm và vẫn dùng để tính entry/SL/TP — chỉ là không in ra nữa.

  // Khối "💡 LÝ DO VÀO LỆNH" đã bị bỏ khỏi mẫu trong CLAUDE.md, kéo theo cả ba
  // loại dòng của nó: lý do 🔻, cảnh báo ⚠️ và dòng ⛔ giải thích vì sao kèo bị
  // chặn. `setup.reasons`, `cautions`, `blockers` vẫn được dựng và vẫn đi vào
  // `evidence` của kèo để rà soát sau này — chỉ là không in ra tin nhắn nữa.
  //
  // Cảnh báo bối cảnh mức 'critical' KHÔNG lọt ra ngoài vì mất khối này: chúng
  // phủ quyết luôn setup, nên tin trở thành LIMIT và không có kèo nào để vào.

  // ---- Lệnh chờ ----
  // KHUYẾN NGHỊ đã là LIMIT thì phải kèm giá, không thì lời khuyên rỗng: khối
  // "CHI TIẾT LỆNH" ở trên trống khi chưa vào được ngay.
  //
  // Đây là lệnh LIMIT THẬT — một vùng giá chờ khớp, buy limit dưới giá và sell
  // limit trên giá. Trước đây khối này in mốc PHÁ VỠ ("phá lên X → Long"), tức
  // là lệnh stop chứ không phải limit, và cũng không nói đặt sẵn ở đâu.
  //
  // NGOẠI LỆ khi bối cảnh cơ bản PHỦ QUYẾT (delist, tin xấu nghiêm trọng): không
  // in mức nào. Đặt lệnh chờ vào đúng tình huống mà phủ quyết dựng lên để tránh
  // là ngược nghĩa của phủ quyết. Lý do vẫn hiện ở khối ⛔ bên trên.
  if (limitPlan?.orders?.length && side === 'none' && !setup?.vetoed) {
    L.push(HR);
    L.push('🎯 <b>LỆNH CHỜ (LIMIT)</b> — đặt tại Entry LIMIT bên dưới, KHÔNG vào giá hiện tại');
    for (const o of limitPlan.orders) {
      const icon = o.direction === 'long' ? '🟢' : '🔴';
      L.push(`${icon} <b>${esc(o.label)}</b>`);
      L.push(`   • Entry LIMIT (giá đặt lệnh): <b>${fmt(o.entry, d)}</b>`
        + ` (${pct(o.distancePercent)} so với giá hiện tại)`);
      L.push(`   • Vùng khớp tham khảo: ${fmt(o.zone.low, d)} – ${fmt(o.zone.high, d)}`);
      L.push(`   • SL ${fmt(o.stopLoss, d)} (rủi ro ${fmt(o.riskPercent, 2)}%)`
        + ` · TP ${o.targets.map((t) => fmt(t.price, d)).join(' / ')}`);
      // Mức neo in lại qua fmt() để cùng cách viết số với các giá khác trong
      // tin; `o.basis` là bản chữ cho CLI, ở đây không dùng.
      L.push(o.fromStructure
        ? `   • Neo vào ${o.direction === 'long' ? 'hỗ trợ' : 'kháng cự'} `
          + `${fmt(o.anchor, d)} (${o.anchorTouches} lần chạm)`
        : `   • Neo: ${esc(o.basis)}`);
      L.push(`   • Huỷ nếu nến đóng ${o.direction === 'long' ? 'dưới' : 'trên'} `
        + `${fmt(o.stopLoss, d)}, hoặc chưa khớp sau ${o.expiryBars} nến`);
    }
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
 * Không nhận snapshot nữa: từ khi mẫu bỏ khối "NHẬN ĐỊNH NGẮN", mọi thứ in ra
 * đều lấy từ chính kèo và `risk`, nên tin cập nhật không còn phụ thuộc số liệu
 * thị trường mới.
 *
 * @param call    kèo đang mở (từ data/open-calls.js)
 * @param hitTps  nhãn các TP vừa chạm trong lượt này, vd ['TP1']
 * @param risk    strategy.risk — quyết định % chốt và đòn bẩy để quy đổi lợi nhuận
 */
export function buildTpUpdate(call, hitTps, risk = {}) {
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

  // Khối "NHẬN ĐỊNH NGẮN" (CVD còn thuận hay đã đảo) đã bị bỏ khỏi mẫu trong
  // README.md theo yêu cầu.

  return L.join('\n');
}

// 'breakeven' = đã chốt một phần ở TP1 rồi giá quay về entry. Không phải SL: gọi
// nó là SL sẽ báo sai kết quả và làm lệch cả chuỗi SL của auto-retune.
const CLOSED_ICONS = { stopped: '🛑', breakeven: '🛡', expired: '⏱' };
const CLOSED_LABELS = {
  stopped: 'CHẠM STOPLOSS',
  breakeven: 'VỀ HOÀ VỐN (SL đã kéo về entry sau TP1)',
  expired: 'HẾT HẠN GIỮ',
};

/**
 * Tin đóng kèo cho các trạng thái KHÔNG phải `target` (chạm TP cuối thì dùng
 * `buildTpUpdate`): dính SL, về hoà vốn sau TP1, hoặc hết hạn giữ.
 *
 * Dòng `kết quả` là lãi/lỗ THẬT của cả kèo, dùng chung `tradeReturnPercent()`
 * với bản tổng hợp cuối ngày. Trước đây chỗ này lấy thẳng
 * `(giá thoát − entry) / entry`, nên kèo `breakeven` luôn in ra +0,00%: giá thoát
 * CHÍNH LÀ entry, còn phần đã chốt ở TP1 thì không được cộng vào. Con số đó vừa
 * mâu thuẫn với tin TP1 đã gửi ("chốt một phần, dời SL về entry"), vừa lệch với
 * PnL mà báo cáo ngày cộng cho cùng kèo đó.
 *
 * @param call        kèo đang mở (từ data/open-calls.js)
 * @param result      kết quả checkCall()
 * @param risk        strategy.risk — `partialFraction` quyết định phần đã chốt ở TP1
 * @param feePercent  phí MỖI LẦN thoát, lấy từ dailyReview.feePercent
 */
export function buildClosedNote(call, result, { risk = {}, feePercent = 0.06 } = {}) {
  const d = decimalsFor(call.entry);
  const partialFraction = Number(risk.partialFraction ?? 0.5);
  const trade = { ...call, result };
  const pnl = tradeReturnPercent(trade, { partialFraction, feePercent });
  const tookPartial = tookPartialAtTp1(trade);
  const tp1 = (call.targets ?? [])[0];
  const hitTps = result.hitTps ?? [];

  const L = [];
  L.push(`${CLOSED_ICONS[result.status] ?? '⏱'} <b>${esc(call.symbol)} ${esc(call.interval)}</b>`
    + ` — ${CLOSED_LABELS[result.status] ?? 'HẾT HẠN GIỮ'}`);
  L.push(`${call.side === 'long' ? 'LONG' : 'SHORT'} từ ${fmt(call.entry, d)}`
    + (pnl != null ? ` · kết quả ${pct(pnl)}` : '')
    + (hitTps.length ? ` · đã chạm ${esc(hitTps.join(', '))}` : ''));
  // Nói rõ con số gồm những gì, vì với `breakeven` thì phần lãi nằm HẾT ở lần
  // chốt TP1 — không kể ra thì người đọc không đối chiếu được với tin TP1 cũ.
  if (tookPartial && pnl != null) {
    L.push(`<i>Gồm ${Math.round(partialFraction * 100)}% đã chốt ở ${esc(tp1.label)}`
      + ` (${fmt(tp1.price, d)}), phần còn lại thoát ở ${fmt(result.lastPrice, d)}.</i>`);
  }
  // Không in "Giữ N nến / được call lại từ nến sau": đó là sổ sách nội bộ của
  // vòng quét, người đọc không làm gì được với nó.
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
