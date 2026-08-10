// Mổ xẻ từng kèo đã dính SL mà CHƯA chốt được TP1 — trả lời "sai ở đâu".
//
// Vì sao phần này phải chạy SAU chứ không phải ngay lúc dính SL: lúc kèo vừa
// chạm SL thì nến sau chưa tồn tại, nên câu hỏi quan trọng nhất chưa có dữ liệu
// để trả lời — giá bị quét rồi quay lại đúng hướng, hay đi thẳng ngược ngay từ
// đầu? Hai trường hợp đó đòi hai cách sửa NGƯỢC NHAU (nới SL / đừng vào lệnh),
// nên kết luận sớm là đoán mò. Ở đây chỉ nhận kèo đã có đủ nến sau đó.
//
// Thuần JS, không import gì — nến do bên gọi nạp và truyền vào.

export const KINDS = {
  swept: 'bi-quet',
  wrongWay: 'sai-huong',
  reversed: 'dao-chieu',
  unknown: 'chua-du-nen',
};

export const KIND_LABELS = {
  [KINDS.swept]: 'SL nằm trong vùng nhiễu — bị quét rồi giá đi đúng hướng',
  [KINDS.wrongWay]: 'sai hướng ngay từ đầu — giá không hề đi theo lệnh',
  [KINDS.reversed]: 'đi đúng một đoạn rồi đảo chiều thật',
  [KINDS.unknown]: 'chưa đủ nến sau SL để kết luận',
};

/**
 * Cửa dừng call gắn với BÁO CÁO TỔNG HỢP CUỐI NGÀY, không phải với từng lần dính
 * SL. Ý nghĩa: bản tổng hợp vừa hiện thì dành bấy nhiêu phút soi lại các kèo đã
 * thua trước khi mở kèo mới.
 *
 * Suy ra từ ĐỒNG HỒ chứ không lưu trạng thái, và đó là lý do chính chọn cách này:
 * bản rà soát chạy với `--no-write` để không thành nguồn ghi thứ hai vào trạng
 * thái dùng chung (nó sẽ đua với vòng quét), nên nó KHÔNG có đường nào ghi lại
 * "tôi vừa báo cáo xong". Mốc giờ thì cả hai bên cùng đọc được mà không ai phải ghi.
 *
 * `reviewAtUtc` phải khớp cron của Trading-runner/.github/workflows/daily-review.yml.
 */
export function inReviewPause(cfg = {}, now = Date.now()) {
  const off = { active: false, leftMs: 0, until: null };
  if (cfg.enabled === false) return off;
  const minutes = Number(cfg.pauseAfterReviewMinutes ?? 0);
  const parts = /^(\d{1,2}):(\d{2})$/.exec(String(cfg.reviewAtUtc ?? '').trim());
  if (!(minutes > 0) || !parts) return off;

  const start = Math.floor(now / 86400e3) * 86400e3
    + Number(parts[1]) * 3600e3 + Number(parts[2]) * 60e3;
  const end = start + minutes * 60e3;
  if (now < start || now >= end) return off;
  return { active: true, leftMs: end - now, until: new Date(end).toISOString() };
}

const round = (value, digits = 2) => (Number.isFinite(Number(value))
  ? Number(Number(value).toFixed(digits)) : null);

// `Number(null)` là 0 chứ không phải NaN, nên bản ghi thiếu giá sẽ lọt qua
// `Number.isFinite` và bị phát lại với entry = 0 — ra kết luận từ số bịa.
const num = (value) => (value == null || value === '' ? NaN : Number(value));

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Phát lại một kèo đã SL trên nến thật.
 *
 * Giữ đúng quy ước bảo thủ của backtest: một nến chạm cả SL và TP thì tính SL.
 * Vì vậy đoạn đi thuận lợi được đo trên các nến TRƯỚC nến chạm SL — nến chạm SL
 * có thể có bóng nến rất dài về phía có lợi, nhưng ta không biết thứ tự trong
 * nến nên không được phép tính nó là "suýt thắng".
 *
 * @returns { kind, mfeBeforeSlR, maxAdverseR, neededSlPercent, barsToSl,
 *            barsAfterSl, reachedTp1After, widerStopSaves }
 */
export function replayStoppedCall(trade, candles, {
  maxHoldBars = 96, widerSlMultiple = 1.5, minBarsAfterStop = 6, noFavorMoveR = 0.15,
} = {}) {
  const entry = num(trade.entry);
  const stop = num(trade.stopLoss);
  const tp1 = num(trade.targets?.[0]?.price);
  const openedAt = num(trade.openedAtCandle ?? Date.parse(trade.openedAt ?? ''));
  const base = { symbol: trade.symbol, interval: trade.interval, side: trade.side };

  // Kèo ghi trước khi bản ghi có entry/SL/TP thì không phát lại được — nói thẳng
  // ra thay vì suy ngược từ giá hiện tại rồi gán cho quyết định cũ.
  if (![entry, stop, tp1, openedAt].every(Number.isFinite)) {
    return { ...base, kind: KINDS.unknown, reason: 'bản ghi cũ không có entry/SL/TP' };
  }
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return { ...base, kind: KINDS.unknown, reason: 'khoảng SL bằng 0' };

  const isLong = trade.side === 'long';
  const after = candles.filter((c) => Number(c.openTime) > openedAt).slice(0, maxHoldBars);
  if (!after.length) return { ...base, kind: KINDS.unknown, reason: 'không còn nến của kèo này' };

  const favor = (c) => (isLong ? c.high - entry : entry - c.low);
  const adverse = (c) => (isLong ? entry - c.low : c.high - entry);
  const hitsStop = (c, level) => (isLong ? c.low <= level : c.high >= level);
  const hitsTp1 = (c) => (isLong ? c.high >= tp1 : c.low <= tp1);

  let slIndex = -1;
  let mfeBeforeSl = 0;
  let maxAdverse = 0;
  for (let i = 0; i < after.length; i++) {
    maxAdverse = Math.max(maxAdverse, adverse(after[i]));
    if (slIndex >= 0) continue;
    if (hitsStop(after[i], stop)) { slIndex = i; continue; }
    mfeBeforeSl = Math.max(mfeBeforeSl, favor(after[i]));
  }
  if (slIndex < 0) {
    return { ...base, kind: KINDS.unknown, reason: 'không khớp được nến chạm SL' };
  }

  // Giá có quay lại chạm TP1 trong phần còn lại của hạn giữ không?
  const rest = after.slice(slIndex + 1);
  const reachedTp1After = rest.some((c) => hitsTp1(c));

  // Phản chứng: giữ nguyên entry/TP, chỉ đẩy SL ra xa `widerSlMultiple` lần.
  const widerStop = isLong ? entry - risk * widerSlMultiple : entry + risk * widerSlMultiple;
  let widerStopSaves = false;
  for (const c of after) {
    if (hitsStop(c, widerStop)) break;      // nến chạm cả hai vẫn tính là SL
    if (hitsTp1(c)) { widerStopSaves = true; break; }
  }

  const barsAfterSl = rest.length;
  const mfeBeforeSlR = mfeBeforeSl / risk;
  const out = {
    ...base,
    mfeBeforeSlR: round(mfeBeforeSlR, 2),
    maxAdverseR: round(maxAdverse / risk, 2),
    // Khoảng SL cần rộng bao nhiêu % giá để không bị quét trong cả hạn giữ.
    neededSlPercent: round((maxAdverse / entry) * 100, 2),
    slPercent: round((risk / entry) * 100, 2),
    barsToSl: slIndex + 1,
    barsAfterSl,
    reachedTp1After,
    widerStopSaves,
  };

  // Chưa đủ nến sau SL thì chỉ kết luận khi đã có bằng chứng KHẲNG ĐỊNH (giá đã
  // quay lại chạm TP1). Không có bằng chứng đó thì để ngỏ, đừng đếm vội.
  if (barsAfterSl < minBarsAfterStop && !reachedTp1After && !widerStopSaves) {
    return { ...out, kind: KINDS.unknown, reason: `mới ${barsAfterSl} nến sau SL` };
  }
  if (widerStopSaves || reachedTp1After) return { ...out, kind: KINDS.swept };
  if (mfeBeforeSlR < noFavorMoveR) return { ...out, kind: KINDS.wrongWay };
  return { ...out, kind: KINDS.reversed };
}

/** Gộp các bản phát lại thành một bức tranh, kèm hướng sửa mà số liệu chống đỡ. */
export function summarizePostMortem(rows) {
  const counts = Object.fromEntries(Object.values(KINDS).map((k) => [k, 0]));
  for (const row of rows) counts[row.kind] = (counts[row.kind] ?? 0) + 1;

  const decided = rows.filter((r) => r.kind !== KINDS.unknown);
  const swept = rows.filter((r) => r.kind === KINDS.swept);
  const wrongWay = rows.filter((r) => r.kind === KINDS.wrongWay);

  const share = (n) => (decided.length ? round((n / decided.length) * 100, 1) : null);
  const summary = {
    total: rows.length,
    decided: decided.length,
    counts,
    sweptSharePercent: share(swept.length),
    wrongWaySharePercent: share(wrongWay.length),
    // Đo trên chính các kèo bị quét: SL đang đặt bao nhiêu %, cần bao nhiêu %.
    medianSlPercent: round(median(swept.map((r) => r.slPercent)), 2),
    medianNeededSlPercent: round(median(swept.map((r) => r.neededSlPercent)), 2),
    medianBarsToSl: round(median(decided.map((r) => r.barsToSl)), 1),
    rows,
  };
  summary.verdict = verdictOf(summary);
  return summary;
}

/**
 * Kết luận CHỈ nêu hướng, không tự đổi cấu hình: mọi thay đổi vẫn phải qua
 * backtest chia theo thời gian của `daily-review` mới được đề xuất.
 *
 * Ba trường hợp tách bạch vì cách sửa ngược nhau, và một trong số đó là "không
 * có núm nào sửa được" — repo đã đo: siết điểm/đồng thuận/CVD làm tỉ lệ SL TĂNG.
 */
function verdictOf(summary) {
  if (summary.decided < 3) {
    return { id: 'khong-du-mau', text: 'Chưa đủ kèo kết luận được để rút ra hướng nào.' };
  }
  const swept = summary.sweptSharePercent ?? 0;
  const wrong = summary.wrongWaySharePercent ?? 0;
  if (swept >= 50) {
    return {
      id: 'noi-sl',
      text: `${swept}% số kèo thua là bị quét rồi giá đi đúng hướng — SL đang nằm trong vùng nhiễu. `
        + `Trung vị: đặt ${summary.medianSlPercent}%, cần ${summary.medianNeededSlPercent}%. `
        + 'Hướng sửa là NỚI SL, và nó phải qua backtest bên dưới mới được áp.',
    };
  }
  if (wrong >= 50) {
    return {
      id: 'sai-huong',
      text: `${wrong}% số kèo thua đi ngược ngay từ nến đầu — vấn đề nằm ở chỗ CHỌN LỆNH, `
        + 'không phải ở khoảng SL. Nới SL lúc này chỉ lỗ sâu hơn. Lưu ý: repo đã đo và siết '
        + 'điểm/đồng thuận/CVD làm tỉ lệ SL TĂNG, nên đây là phần hiện chưa có núm nào sửa được.',
    };
  }
  return {
    id: 'hon-hop',
    text: 'Nguyên nhân trộn lẫn, không nhóm nào quá bán — chưa có hướng sửa nào được số liệu chống đỡ rõ.',
  };
}

/**
 * Nạp nến rồi phát lại từng kèo. `fetchCandles(symbol, interval, limit)` được
 * tiêm vào để phần thuần tính toán ở trên vẫn thử được mà không cần mạng.
 */
export async function postMortemLosses(lostTrades, {
  fetchCandles, maxTrades = 12, candles = 400, onError = () => {}, ...opts
} = {}) {
  const picked = [...lostTrades].reverse().slice(0, Math.max(1, maxTrades));
  const rows = [];
  for (const trade of picked) {
    try {
      const bars = await fetchCandles(trade.symbol, trade.interval, candles);
      rows.push(replayStoppedCall(trade, bars, opts));
    } catch (error) {
      onError(`${trade.symbol} ${trade.interval}: ${error.message}`);
      rows.push({
        symbol: trade.symbol, interval: trade.interval, side: trade.side,
        kind: KINDS.unknown, reason: `không tải được nến: ${error.message}`,
      });
    }
  }
  return summarizePostMortem(rows);
}
