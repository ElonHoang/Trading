// Rà soát định kỳ (mặc định mỗi ngày): đo tỉ lệ thua trên các kèo ĐÃ CHỐT trong
// ngày, so sánh với các ngày trước, truy nguyên đặc điểm của lệnh thua, rồi kiểm
// chứng chỉnh cấu hình — mỗi thay đổi phải qua 75% train / 25% holdout và guard.
//
// Kèo đang mở KHÔNG bao giờ lọt vào đây: `recordClosedTrade` chỉ được gọi lúc kèo
// chạm SL/TP/hết hạn, nên `state.trades` chỉ chứa kèo đã có kết quả.
//
// Khác `auto-retune.js` ở hai điểm, và đó là lý do nó tồn tại riêng:
//  1. Kích hoạt theo THỜI GIAN, không theo chuỗi 3 SL liên tiếp.
//  2. W = đã chạm ít nhất TP1; L = chạm SL khi chưa chạm TP1.
//
// Điểm khác thứ ba đã hết: bộ candidate giờ DÙNG CHUNG (`buildRiskCandidates`).
// Trước đây auto-retune siết đúng những núm mà repo đã đo là làm xấu thêm, tức
// hai đường kích hoạt đề xuất hai chiều ngược nhau cho cùng một cấu hình.
//
// Chỉ chạy ở Node: đọc/ghi file trạng thái và tải dữ liệu lịch sử.

import { fetchKlines, fetchKlinesHistory } from '../data/binance.js';
import { saveStrategy } from '../config.js';
import { closedCandles } from './engine.js';
import { backtest } from '../backtest.js';
import {
  applyStrategyChanges, buildRiskCandidates, diagnoseSupportingGroups, saveAutoRetuneState,
} from './auto-retune.js';
import { KIND_LABELS, postMortemLosses } from './post-mortem.js';
// Quy tắc tính PnL một kèo nằm ở module lá vì tin đóng kèo trên Telegram cũng
// phải in ĐÚNG con số này — hai bên lệch nhau thì cùng một kèo có hai kết quả.
import { tradeReturnPercent } from './trade-pnl.js';

export { tradeReturnPercent };

const clone = (value) => JSON.parse(JSON.stringify(value));
const round = (value, digits = 2) => (Number.isFinite(Number(value)) ? Number(Number(value).toFixed(digits)) : null);

const LOST = 'stopped';
const BREAKEVEN = 'breakeven';

function reachedTp1(trade) {
  // TP được ghi theo thứ tự, nên chỉ cần có bất kỳ hitTps nào là TP1 đã qua.
  // Cách này còn đọc đúng các bản ghi cũ bị thiếu mảng `targets`.
  if ((trade.result?.hitTps ?? []).length > 0) return true;
  // Bản ghi `target` cũ có thể chưa lưu hitTps nhưng đã chạm TP cuối, nên chắc
  // chắn cũng đã đạt ít nhất TP1.
  return trade.result?.status === 'target';
}

const DAY_MS = 86400e3;

/**
 * Mốc bắt đầu cửa sổ thống kê. Ba chế độ, khai báo ở `dailyReview.windowMode`:
 *
 *  - `calendar-day` (mặc định): reset lúc 00:00 theo `dayOffsetHours` (VN = 7).
 *    Báo cáo chỉ gồm kèo chốt trong ngày đó, không cộng dồn. `dayOffsetDays`
 *    lùi ngày cần rà (0 = hôm nay, -1 = hôm qua) — cần khi job chạy sáng hôm sau,
 *    vì lúc đó "hôm nay" mới bắt đầu và gần như chưa có kèo nào chốt.
 *  - `rolling`: `windowHours` giờ gần nhất.
 *  - `all`: toàn bộ lịch sử đang lưu (tối đa `autoRetune.historyLimit` kèo).
 *
 * Trước đây chỉ có `all`, nên tiêu đề in "RÀ SOÁT 24H" trong khi con số là tổng
 * mọi kèo từng chốt kể từ lúc file trạng thái bắt đầu tích — đọc thành một ngày
 * bắn mấy chục kèo.
 */
export function reviewWindow(cfg = {}, now = Date.now()) {
  const mode = cfg.windowMode ?? 'calendar-day';
  if (mode === 'calendar-day') {
    const offset = Number(cfg.dayOffsetHours ?? 0) * 3600e3;
    const days = Math.min(0, Math.trunc(Number(cfg.dayOffsetDays ?? 0)) || 0);
    const sinceMs = (Math.floor((now + offset) / DAY_MS) + days) * DAY_MS - offset;
    const [y, m, d] = new Date(sinceMs + offset).toISOString().slice(0, 10).split('-');
    return {
      mode, sinceMs, untilMs: sinceMs + DAY_MS,
      since: new Date(sinceMs).toISOString(), label: `NGÀY ${d}/${m}/${y}`,
    };
  }
  const hours = Number(cfg.windowHours ?? 0);
  if (mode === 'rolling' && hours > 0) {
    const sinceMs = now - hours * 3600e3;
    return {
      mode, sinceMs, untilMs: null,
      since: new Date(sinceMs).toISOString(), label: `${hours}H GẦN NHẤT`,
    };
  }
  return { mode: 'all', sinceMs: null, untilMs: null, since: null, label: 'TOÀN BỘ LỊCH SỬ ĐANG LƯU' };
}

/**
 * Thống kê theo đúng cách người dùng yêu cầu:
 * - W: kèo đã chạm ít nhất TP1, bất kể sau đó target/breakeven/expired.
 * - L: kèo chạm SL khi chưa chạm TP1.
 * Mẫu số tỷ lệ là W + L; kèo hết hạn chưa TP1 không bị ép vào nhóm nào.
 */
export function summarizeCalls(trades, {
  sinceMs = null, untilMs = null, partialFraction = 0.5, feePercent = 0.06,
  capitalPerTradeUsd = 200,
} = {}) {
  const inWindow = sinceMs == null && untilMs == null
    ? [...trades]
    : trades.filter((t) => {
      const at = Date.parse(t.closedAt ?? '');
      if (!Number.isFinite(at)) return false;
      return (sinceMs == null || at >= sinceMs) && (untilMs == null || at < untilMs);
    });
  const by = (status) => inWindow.filter((t) => t.result?.status === status);
  const won = inWindow.filter(reachedTp1);
  const lost = inWindow.filter((t) => t.result?.status === LOST && !reachedTp1(t));
  const breakeven = by(BREAKEVEN);
  const expired = by('expired');
  const closed = inWindow.length;
  const rated = won.length + lost.length;

  // Lãi/lỗ từng kèo, rồi tổng của cả kỳ. Cộng thẳng % của từng kèo = giả định
  // MỌI KÈO VÀO CÙNG MỘT CỠ VỐN — đúng với kiểu kênh tín hiệu, và là cách duy
  // nhất tính được vì bot không biết ai vào bao nhiêu.
  const pnls = new Map(inWindow.map((t) => [t, tradeReturnPercent(t, { partialFraction, feePercent })]));
  const measured = inWindow.filter((t) => pnls.get(t) != null);

  const pnlPercent = measured.length
    ? round(measured.reduce((sum, t) => sum + (pnls.get(t) ?? 0), 0), 2) : null;
  return {
    closed,
    lost: lost.length,
    breakeven: breakeven.length,
    won: won.length,
    expired: expired.length,
    rated,
    unrated: closed - rated,
    win: won.length,
    loss: lost.length,
    pnlPercent,
    capitalPerTradeUsd,
    // Mỗi lệnh dùng cùng một lượng vốn, nên tổng tiền = tổng % × vốn/lệnh.
    pnlUsd: pnlPercent == null ? null : round(capitalPerTradeUsd * pnlPercent / 100, 2),
    // Kèo thiếu giá thoát (dữ liệu cũ) bị loại khỏi tổng PnL — nói ra để không
    // ai đọc nhầm là đã tính đủ.
    pnlFromTrades: measured.length,
    lossRatePercent: rated ? round((lost.length / rated) * 100, 1) : null,
    winRatePercent: rated ? round((won.length / rated) * 100, 1) : null,
    trades: inWindow,
    ratedTrades: [...won, ...lost],
    wonTrades: won,
    lostTrades: lost,
  };
}

/**
 * So sánh các ngày đã khép lại trên cùng múi giờ với báo cáo. Việc tinh chỉnh
 * chỉ được kích hoạt khi lỗi lặp lại qua nhiều ngày, không dựa vào một ngày xấu
 * đơn lẻ. Ngày không có kèo vẫn được giữ trong chuỗi để không che giấu khoảng
 * trống dữ liệu.
 */
export function compareDailyPerformance(trades, cfg = {}, now = Date.now(), pnlOptions = {}) {
  const lookbackDays = Math.max(2, Math.min(30, Number(cfg.comparisonDays ?? 7)));
  const target = Number(cfg.targetLossRatePercent ?? 30);
  const minTradesPerDay = Math.max(1, Number(cfg.minClosedTradesPerDay ?? 3));
  const minBadDays = Math.max(2, Number(cfg.minBadDays ?? 2));
  const offset = Number(cfg.dayOffsetHours ?? 0) * 3600e3;
  const reviewed = reviewWindow({ ...cfg, windowMode: 'calendar-day' }, now);
  const endMs = reviewed.untilMs;
  const days = [];

  for (let index = lookbackDays - 1; index >= 0; index--) {
    const sinceMs = endMs - (index + 1) * DAY_MS;
    const untilMs = sinceMs + DAY_MS;
    const summary = summarizeCalls(trades, { ...pnlOptions, sinceMs, untilMs });
    const date = new Date(sinceMs + offset).toISOString().slice(0, 10);
    days.push({
      date, sinceMs, untilMs,
      ...summary,
      bad: summary.rated >= minTradesPerDay
        && summary.lossRatePercent != null
        && summary.lossRatePercent > target,
    });
  }

  let previous = null;
  for (const day of days) {
    day.lossRateDelta = previous?.lossRatePercent != null && day.lossRatePercent != null
      ? round(day.lossRatePercent - previous.lossRatePercent, 1) : null;
    day.pnlDelta = previous?.pnlPercent != null && day.pnlPercent != null
      ? round(day.pnlPercent - previous.pnlPercent, 2) : null;
    if (day.rated) previous = day;
  }

  const sinceMs = endMs - lookbackDays * DAY_MS;
  const aggregate = summarizeCalls(trades, { ...pnlOptions, sinceMs, untilMs: endMs });
  const eligibleDays = days.filter((day) => day.rated >= minTradesPerDay).length;
  const badDays = days.filter((day) => day.bad).length;

  const repeatedBy = (key) => {
    const totals = new Map();
    for (const day of days) {
      const dayTotals = tally(day.ratedTrades, (trade) => trade[key]);
      const dayLost = tally(day.lostTrades, (trade) => trade[key]);
      for (const [value, total] of dayTotals) {
        const lost = dayLost.get(value) ?? 0;
        const row = totals.get(value) ?? { key: value, total: 0, lost: 0, observedDays: 0, badDays: 0 };
        row.total += total;
        row.lost += lost;
        row.observedDays++;
        if (total >= 2 && (lost / total) * 100 > target) row.badDays++;
        totals.set(value, row);
      }
    }
    return [...totals.values()]
      .map((row) => ({ ...row, lossRatePercent: round((row.lost / row.total) * 100, 1) }))
      .filter((row) => row.badDays >= minBadDays)
      .sort((a, b) => (b.badDays - a.badDays) || (b.lossRatePercent - a.lossRatePercent));
  };

  return {
    lookbackDays, target, minTradesPerDay, minBadDays, eligibleDays, badDays,
    repeatedIssue: badDays >= minBadDays,
    days,
    aggregate,
    persistent: { byInterval: repeatedBy('interval'), bySide: repeatedBy('side') },
  };
}

function compactComparison(comparison) {
  const compact = ({
    trades: unusedTrades, ratedTrades: unusedRated, wonTrades: unusedWon,
    lostTrades: unusedLost, ...summary
  }) => summary;
  return {
    ...comparison,
    days: comparison.days.map(compact),
    aggregate: compact(comparison.aggregate),
  };
}

function compactCallSummary({
  trades: unusedTrades, ratedTrades: unusedRated, wonTrades: unusedWon,
  lostTrades: unusedLost, ...summary
}) {
  return summary;
}

const NUMERIC_FIELDS = [
  { key: 'score', label: 'điểm tín hiệu', abs: true, pick: (e) => e?.score },
  { key: 'consensusPercent', label: 'đồng thuận %', abs: false, pick: (e) => e?.consensusPercent },
  { key: 'riskPercent', label: 'khoảng SL %', abs: false, pick: (e) => e?.riskPercent },
  { key: 'cvdSlope', label: 'độ dốc CVD', abs: true, pick: (e) => e?.cvdSlope },
  { key: 'volumeRatio', label: 'volume/TB', abs: false, pick: (e) => e?.volumeRatio },
];

const mean = (values) => (values.length
  ? values.reduce((sum, v) => sum + v, 0) / values.length : null);

function tally(trades, pick) {
  const counts = new Map();
  for (const t of trades) {
    const key = pick(t);
    if (key == null) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * So lệnh THUA với phần còn lại trên từng đặc điểm ghi lại lúc vào lệnh. Đây là
 * mức liên quan, KHÔNG phải nhân quả — nó chỉ nói nên đem cái gì đi backtest.
 */
export function diagnoseLosses(summary) {
  const lost = summary.lostTrades;
  const rest = summary.wonTrades;
  const numeric = [];
  for (const field of NUMERIC_FIELDS) {
    const take = (rows) => rows
      .map((t) => Number(field.pick(t.evidence)))
      .filter((v) => Number.isFinite(v))
      .map((v) => (field.abs ? Math.abs(v) : v));
    const a = take(lost);
    const b = take(rest);
    if (a.length < 3 || b.length < 3) continue;
    const mLost = mean(a);
    const mRest = mean(b);
    numeric.push({
      key: field.key,
      label: field.label,
      lost: round(mLost, 3),
      rest: round(mRest, 3),
      deltaPercent: mRest ? round(((mLost - mRest) / Math.abs(mRest)) * 100, 1) : null,
      samples: { lost: a.length, rest: b.length },
    });
  }
  numeric.sort((x, y) => Math.abs(y.deltaPercent ?? 0) - Math.abs(x.deltaPercent ?? 0));

  const rateBy = (pick) => {
    const all = tally(summary.ratedTrades, pick);
    const bad = tally(lost, pick);
    return [...all.entries()]
      .map(([key, total]) => ({
        key, total, lost: bad.get(key) ?? 0,
        lossRatePercent: round(((bad.get(key) ?? 0) / total) * 100, 1),
      }))
      .sort((a, b) => (b.lossRatePercent - a.lossRatePercent) || (b.total - a.total));
  };

  return {
    numeric,
    byInterval: rateBy((t) => t.interval),
    bySide: rateBy((t) => t.side),
    bySymbol: rateBy((t) => t.symbol).slice(0, 8),
    supportingGroups: diagnoseSupportingGroups(lost),
  };
}

/** Candidate điều kiện vào lệnh chỉ sinh khi post-mortem kết luận sai hướng. */
export function buildEntryCandidates(strategy, cfg = {}, postMortem = null) {
  if (postMortem?.verdict?.id !== 'sai-huong') return [];
  const wrong = (postMortem.rows ?? []).filter((row) => row.kind === 'sai-huong');
  const minSamples = Math.max(3, Number(cfg.minEntryCauseSamples ?? 3));
  const causeShare = Number(cfg.entryCauseSharePercent ?? 60);
  if (wrong.length < minSamples) return [];

  const quality = strategy.entryQuality ?? {};
  const out = [];
  const valueOf = (value) => (value == null || value === '' ? null : Number(value));
  const add = (id, label, changes, because) => out.push({
    id, label, changes, because, kind: 'entry',
    strategy: applyStrategyChanges(strategy, changes),
  });
  const supported = (pick) => {
    const values = wrong.map(pick).filter((value) => value != null);
    const hits = values.filter(Boolean).length;
    return values.length >= minSamples && (hits / values.length) * 100 >= causeShare;
  };

  if (quality.requireStructureAgreement !== true && supported((row) => {
    const score = valueOf(row.evidence?.groups?.structure?.score);
    if (!Number.isFinite(score)) return null;
    return score * (row.side === 'long' ? 1 : -1) < 0;
  })) {
    add('entry-structure-agreement', 'Chỉ vào khi cấu trúc cùng hướng',
      { 'entryQuality.requireStructureAgreement': true },
      'Phần lớn kèo sai hướng được vào khi nhóm hỗ trợ/kháng cự đang chống lại hướng lệnh.');
  }

  const currentMove = Number(quality.maxDirectionalMove20Pct);
  const proposedMove = Number.isFinite(currentMove) && currentMove > 0
    ? Math.max(2, Number((currentMove - 0.5).toFixed(2)))
    : Number(cfg.entryMaxMove20Pct ?? 4);
  if (proposedMove > 0 && supported((row) => {
    const move = valueOf(row.evidence?.priceChange20Pct);
    if (!Number.isFinite(move)) return null;
    return move * (row.side === 'long' ? 1 : -1) > proposedMove;
  })) {
    add('entry-no-chasing', `Không đuổi nhịp đã đi quá ${proposedMove}%/20 nến`,
      { 'entryQuality.maxDirectionalMove20Pct': proposedMove },
      'Phần lớn kèo sai hướng xuất hiện sau khi giá đã đi quá xa theo hướng vào lệnh.');
  }

  const maxLong = quality.avoidRangeExtremes === true
    ? Math.max(0.6, Number((Number(quality.maxLongRangePosition ?? 0.8) - 0.05).toFixed(2))) : 0.8;
  const minShort = quality.avoidRangeExtremes === true
    ? Math.min(0.4, Number((Number(quality.minShortRangePosition ?? 0.2) + 0.05).toFixed(2))) : 0.2;
  if (supported((row) => {
    const pos = valueOf(row.evidence?.rangePosition50);
    if (!Number.isFinite(pos)) return null;
    return row.side === 'long' ? pos > maxLong : pos < minShort;
  })) {
    add('entry-avoid-range-extremes', 'Tránh entry sát cực trị vùng giá 50 nến', {
      'entryQuality.avoidRangeExtremes': true,
      'entryQuality.maxLongRangePosition': maxLong,
      'entryQuality.minShortRangePosition': minShort,
    }, 'Phần lớn kèo sai hướng mua gần đỉnh vùng hoặc bán gần đáy vùng 50 nến.');
  }

  // Hai candidate này từng làm xấu kết quả khi bật đại trà. Chỉ sinh khi chính
  // nhóm sai hướng hiện tại tập trung sát ngưỡng, và vẫn phải vượt holdout/guard.
  const nextCvd = Number((Number(quality.minAbsCvdSlope ?? 0.03) + Number(cfg.entryCvdStep ?? 0.01)).toFixed(3));
  if (supported((row) => {
    const cvd = valueOf(row.evidence?.cvdSlope);
    return Number.isFinite(cvd) ? cvd * (row.side === 'long' ? 1 : -1) < nextCvd : null;
  })) {
    add('entry-stronger-cvd', `Tăng xác nhận CVD lên ${(nextCvd * 100).toFixed(1)}%`,
      { 'entryQuality.minAbsCvdSlope': nextCvd },
      'Phần lớn kèo sai hướng chỉ vừa đủ qua ngưỡng CVD hiện tại.');
  }

  const nextVolume = Number((Number(quality.minVolumeRatio ?? 1) + Number(cfg.entryVolumeStep ?? 0.1)).toFixed(2));
  if (supported((row) => {
    const volume = valueOf(row.evidence?.volumeRatio);
    return Number.isFinite(volume) ? volume < nextVolume : null;
  })) {
    add('entry-stronger-volume', `Tăng xác nhận volume lên ${nextVolume}x`,
      { 'entryQuality.minVolumeRatio': nextVolume },
      'Phần lớn kèo sai hướng chỉ vừa đủ qua ngưỡng volume hiện tại.');
  }
  return out;
}

export function buildReviewCandidates(strategy, cfg, diagnosis, postMortem = null) {
  // Ánh xạ một-một nguyên nhân -> nhóm sửa. Hỗn hợp/chưa đủ mẫu không sinh gì.
  const causeId = postMortem?.verdict?.id ?? null;
  const risk = buildRiskCandidates(strategy, cfg);
  const out = causeId === 'sai-huong'
    ? buildEntryCandidates(strategy, cfg, postMortem)
    : causeId === 'noi-sl'
      ? risk.filter((item) => item.id === 'fixed-stop' || item.id.startsWith('wider-stop'))
      : causeId === 'dao-chieu'
        ? risk.filter((item) => item.id === 'nearer-tp1')
        : [];

  // Khung nào có tỉ lệ thua vượt trội thì nêu ra, nhưng KHÔNG backtest được qua
  // strategy.json (danh sách khung nằm trong code), nên chỉ báo cáo.
  const worstInterval = (diagnosis.byInterval ?? [])
    .filter((row) => row.total >= Math.max(4, Number(cfg.minTradesPerInterval ?? 5)))[0] ?? null;

  return { candidates: out, worstInterval, cause: postMortem?.verdict ?? null };
}

function metricsOf(result) {
  const s = result.stats ?? {};
  const trades = Number(s.trades ?? 0);
  const stopped = Number(s.exitReasons?.stoploss ?? 0);
  return {
    trades,
    slRatePercent: trades ? round((stopped / trades) * 100, 1) : null,
    winRatePercent: Number.isFinite(s.winRatePercent) ? s.winRatePercent : null,
    profitFactor: Number.isFinite(s.profitFactor) ? s.profitFactor : null,
    expectancyPercent: Number.isFinite(s.expectancyPercent) ? s.expectancyPercent : null,
    maxDrawdownPercent: Number.isFinite(s.maxDrawdownPercent) ? s.maxDrawdownPercent : null,
  };
}

/**
 * Hai điều kiện tách bạch, vì chúng trả lời hai câu hỏi khác nhau.
 *
 * `passesImprovement` chạy trên chính các cặp/khung đã thua: candidate phải GIẢM
 * tỉ lệ SL mà không làm tiền xấu đi. Ở đây KHÔNG đòi kỳ vọng dương tuyệt đối —
 * các cặp vừa thua thường nằm ở khung vốn đã âm (1h), nên đòi như vậy thì không
 * candidate nào đạt được và cả cơ chế thành vô dụng. Khung hỏng là vấn đề của
 * khung, không phải thứ mà chỉnh tham số rủi ro sửa được; báo cáo nêu riêng.
 */
function passesImprovement(baseline, proposed, cfg) {
  const minTrades = Math.max(5, Number(cfg.minTradesPerSegment ?? 8));
  if (proposed.trades < minTrades) return false;
  if (![proposed.profitFactor, proposed.expectancyPercent, proposed.slRatePercent].every(Number.isFinite)) return false;
  if (![baseline.slRatePercent, baseline.expectancyPercent, baseline.profitFactor].every(Number.isFinite)) return false;
  return proposed.slRatePercent <= baseline.slRatePercent - Number(cfg.minSlRateDropPercent ?? 2)
    && proposed.expectancyPercent >= baseline.expectancyPercent
    && proposed.profitFactor >= baseline.profitFactor;
}

/**
 * `passesGuard` chạy trên bộ mã chuẩn ở khung ĐÃ ĐƯỢC KIỂM CHỨNG (4h). Cấu hình
 * là toàn cục, nên một thay đổi sinh ra từ vài kèo thua ở khung yếu không được
 * phép làm hỏng phần đang chạy tốt. Ở đây mới đòi kỳ vọng dương tuyệt đối.
 */
function passesGuard(baseline, proposed, cfg) {
  const minTrades = Math.max(5, Number(cfg.minTradesPerSegment ?? 8));
  if (proposed.trades < minTrades) return false;
  if (![proposed.profitFactor, proposed.expectancyPercent].every(Number.isFinite)) return false;
  const tolerance = Number(cfg.guardExpectancyTolerance ?? 0.02);
  return proposed.expectancyPercent > 0
    && proposed.profitFactor >= Number(cfg.minProfitFactor ?? 1.05)
    && proposed.expectancyPercent >= (baseline.expectancyPercent ?? 0) - tolerance;
}

const avg = (rows, key) => (rows.length
  ? round(rows.reduce((sum, r) => sum + (Number(r[key]) || 0), 0) / rows.length, 3) : null);

/**
 * Dòng "Thị trường chung" của mẫu tin, đo bằng chính giá BTC trong ĐÚNG cửa sổ
 * đang rà soát — không phải cảm nhận, cũng không phải giá lúc chạy báo cáo.
 *
 * Chỉ ba nhãn vì chỉ đo được đúng một thứ: biên độ ròng của kỳ. Dưới
 * `marketTrendPercent` thì gọi là Sideway. Đây là mô tả bối cảnh cho người đọc,
 * KHÔNG cộng điểm và không đổi quyết định nào — trộn nó vào phần chấm điểm sẽ
 * phá đúng ranh giới mà repo giữ giữa "đo được" và "kể chuyện".
 *
 * Lỗi mạng thì trả `{ error }`: bản rà soát không được chết vì một dòng phụ.
 */
export async function readMarketTrend(cfg = {}, window = {}, {
  fetchCandles = fetchKlines, now = Date.now(),
} = {}) {
  const symbol = cfg.marketSymbol ?? 'BTCUSDT';
  const interval = cfg.marketInterval ?? '4h';
  const threshold = Math.abs(Number(cfg.marketTrendPercent ?? 2));
  try {
    const candles = closedCandles(await fetchCandles(symbol, interval, 200));
    const until = window.untilMs ?? now;
    const since = window.sinceMs ?? until - DAY_MS;
    const inWindow = candles.filter((c) => c.openTime >= since && c.openTime < until);
    // Cửa sổ 'rolling'/'all' hoặc kỳ mới mở chưa đủ nến: lùi về 6 nến cuối (=24h
    // ở khung 4h) để vẫn nói được điều gì đó, và ghi lại số nến đã dùng.
    const used = inWindow.length >= 2 ? inWindow : candles.slice(-6);
    if (used.length < 2) return { symbol, interval, error: 'không đủ nến' };
    const first = used[0];
    const last = used[used.length - 1];
    const changePercent = round(((last.close - first.open) / first.open) * 100, 2);
    return {
      symbol,
      interval,
      bars: used.length,
      changePercent,
      inWindow: inWindow.length >= 2,
      label: changePercent >= threshold ? 'Uptrend'
        : changePercent <= -threshold ? 'Downtrend' : 'Sideway',
    };
  } catch (error) {
    return { symbol, interval, error: error.message };
  }
}

export async function runDailyReview({ strategy, state, now = Date.now(), deps = {} }) {
  const cfg = strategy.dailyReview ?? {};
  const persist = deps.saveState ?? saveAutoRetuneState;
  const fetchCandles = deps.fetchCandles ?? fetchKlinesHistory;
  const runBacktest = deps.runBacktest ?? backtest;
  const inspectLosses = deps.postMortemLosses ?? postMortemLosses;
  const save = deps.saveStrategy ?? saveStrategy;
  const force = Boolean(deps.force);

  const everyHours = Math.max(1, Number(cfg.everyHours ?? 24));
  const window = reviewWindow(cfg, now);
  const activeTuning = state.activeTuning?.changes ? {
    source: state.activeTuning.source ?? null,
    appliedAt: state.activeTuning.appliedAt ?? null,
    changes: state.activeTuning.changes,
  } : null;
  const base = {
    enabled: cfg.enabled !== false, everyHours, window,
    at: new Date(now).toISOString(), activeTuning,
  };
  if (!base.enabled) return { status: 'disabled', ...base };

  const lastAt = Date.parse(state.lastReviewAt ?? '');
  if (!force && Number.isFinite(lastAt) && now - lastAt < everyHours * 3600e3) {
    return {
      status: 'too-soon', ...base,
      nextAt: new Date(lastAt + everyHours * 3600e3).toISOString(),
    };
  }

  const summary = summarizeCalls(state.trades ?? [], {
    sinceMs: window.sinceMs,
    untilMs: window.untilMs,
    // Cùng cách thoát lệnh mà tin nhắn đã dặn và backtest đang đo, không phải
    // một quy ước riêng cho báo cáo.
    partialFraction: Number(strategy.risk?.partialFraction ?? 0.5),
    feePercent: Number(cfg.feePercent ?? 0.06),
    capitalPerTradeUsd: Number(cfg.assumedCapitalPerTradeUsd ?? 200),
  });
  const comparison = compareDailyPerformance(state.trades ?? [], cfg, now, {
    partialFraction: Number(strategy.risk?.partialFraction ?? 0.5),
    feePercent: Number(cfg.feePercent ?? 0.06),
    capitalPerTradeUsd: Number(cfg.assumedCapitalPerTradeUsd ?? 200),
  });
  base.comparison = compactComparison(comparison);
  const minTrades = Math.max(3, Number(cfg.minClosedTrades ?? 10));
  const target = Number(cfg.targetLossRatePercent ?? 30);

  state.lastReviewAt = new Date(now).toISOString();

  // Bối cảnh thị trường của kỳ. Đặt trước mọi nhánh return để báo cáo nào cũng
  // có dòng này, kể cả bản "chưa đủ mẫu".
  base.market = await readMarketTrend(cfg, window, {
    fetchCandles: deps.fetchRecentCandles ?? fetchKlines,
    now,
  });

  // Kết quả tự kiểm chứng sau chuỗi SL (auto-retune) ĐI NHỜ báo cáo này. Nó chạy
  // ở vòng quét — nơi không có đường ra Telegram nào ngoài ba mẫu tin — nên nếu
  // không nhắc lại ở đây thì cả cơ chế chỉ nằm trong log của runner. Hai bên đọc
  // chung `data/auto-retune.json` nên không cần thêm nguồn trạng thái nào.
  const attempts = Array.isArray(state.attempts) ? state.attempts : [];
  const freshFrom = window.sinceMs ?? now - 7 * DAY_MS;
  const lastAttempt = [...attempts].reverse().find((a) => (
    ['applied', 'proposed', 'no-safe-change'].includes(a.status)
    && Date.parse(a.at ?? '') >= freshFrom
  )) ?? null;
  base.retune = lastAttempt ? {
    at: lastAttempt.at,
    status: lastAttempt.status,
    streak: lastAttempt.streak ?? null,
    selected: lastAttempt.selected ?? null,
    guardInterval: lastAttempt.guardInterval ?? null,
  } : null;

  // Mổ xẻ từng kèo SL trên nến thật. Chạy TRƯỚC cửa `minClosedTrades` vì nó chỉ
  // mô tả chuyện đã xảy ra — không đổi cấu hình nên không cần cỡ mẫu để an toàn,
  // và một ngày ít kèo vẫn đáng biết mình sai ở đâu. Hỏng mạng thì bỏ phần này,
  // không được làm chết cả bản rà soát.
  const learn = strategy.learning ?? {};
  base.postMortem = null;
  if (learn.enabled !== false && comparison.aggregate.lostTrades.length) {
    try {
      base.postMortem = await inspectLosses(comparison.aggregate.lostTrades, {
        fetchCandles: deps.fetchRecentCandles ?? fetchKlines,
        maxTrades: Number(learn.maxTradesPerReview ?? 12),
        candles: Number(learn.replayCandles ?? 400),
        maxHoldBars: Number(strategy.alerts?.maxHoldBars ?? 96),
        widerSlMultiple: Number(learn.widerSlMultiple ?? 1.5),
        minBarsAfterStop: Number(learn.minBarsAfterStop ?? 6),
        sweepRecoveryBars: Number(learn.sweepRecoveryBars ?? 6),
        noFavorMoveR: Number(learn.noFavorMoveR ?? 0.15),
      });
    } catch (error) {
      base.postMortem = { error: error.message };
    }
  }

  // Job production chỉ cần báo cáo và ghi nhận nguyên nhân. Training/backtest
  // được người dùng chủ động chạy local, nên dừng trước mọi candidate và thay đổi.
  if (deps.skipTraining) {
    const diagnosis = comparison.aggregate.rated
      ? diagnoseLosses(comparison.aggregate) : null;
    const report = {
      status: 'review-only', ...base, target,
      summary: compactCallSummary(summary), diagnosis,
    };
    state.reviews = [...(state.reviews ?? []), {
      at: base.at, status: report.status, closed: summary.closed, rated: summary.rated,
      lossRatePercent: summary.lossRatePercent, pnlPercent: summary.pnlPercent,
    }].slice(-30);
    await persist(state);
    return report;
  }

  // Phần quyết định dùng mẫu GỘP nhiều ngày. Một ngày thường có ít kèo, nên chờ
  // đủ 10 lệnh trong riêng ngày đó khiến vòng tự học gần như không bao giờ chạy.
  // Ngược lại, vẫn bắt buộc lỗi phải xuất hiện ở nhiều ngày để tránh tối ưu theo
  // một phiên bất thường.
  const decisionSummary = comparison.aggregate;
  if (decisionSummary.rated < minTrades) {
    const report = {
      status: 'not-enough-data', ...base, target,
      summary: compactCallSummary(summary), minClosedTrades: minTrades,
    };
    state.reviews = [...(state.reviews ?? []), {
      at: base.at, status: report.status, closed: summary.closed,
      lossRatePercent: summary.lossRatePercent, pnlPercent: summary.pnlPercent,
    }].slice(-30);
    await persist(state);
    return report;
  }

  // Không có W/L mới trong ngày đang rà thì chỉ hiển thị chuỗi so sánh. Kèo hết
  // hạn trắng tay vẫn nằm trong tổng số/PnL nhưng không đủ để kích hoạt optimizer.
  if (!summary.rated) {
    const report = {
      status: 'no-new-data', ...base, target,
      summary: compactCallSummary(summary), minClosedTrades: minTrades,
    };
    state.reviews = [...(state.reviews ?? []), {
      at: base.at, status: report.status, closed: summary.closed,
      rated: 0, lossRatePercent: null, pnlPercent: summary.pnlPercent,
    }].slice(-30);
    await persist(state);
    return report;
  }

  const diagnosis = diagnoseLosses(decisionSummary);
  const { candidates, worstInterval } = buildReviewCandidates(strategy, cfg, diagnosis, base.postMortem);

  // Đạt mục tiêu trên toàn chuỗi so sánh rồi thì không đụng vào cấu hình.
  if (decisionSummary.lossRatePercent != null && decisionSummary.lossRatePercent <= target) {
    const report = {
      status: 'on-target', ...base, target,
      summary: compactCallSummary(summary), diagnosis, worstInterval,
    };
    state.reviews = [...(state.reviews ?? []), {
      at: base.at, status: report.status, closed: summary.closed,
      lossRatePercent: summary.lossRatePercent, pnlPercent: summary.pnlPercent,
    }].slice(-30);
    await persist(state);
    return report;
  }

  if (!comparison.repeatedIssue) {
    const report = {
      status: 'monitoring-pattern', ...base, target,
      summary: compactCallSummary(summary), diagnosis, worstInterval,
    };
    state.reviews = [...(state.reviews ?? []), {
      at: base.at, status: report.status, closed: summary.closed,
      lossRatePercent: summary.lossRatePercent, pnlPercent: summary.pnlPercent,
    }].slice(-30);
    await persist(state);
    return report;
  }


  const cooldownHours = Math.max(0, Number(cfg.cooldownHours ?? 168));
  const lastAppliedAt = Date.parse(state.lastAppliedAt ?? '');
  if (Number.isFinite(lastAppliedAt) && now - lastAppliedAt < cooldownHours * 3600e3) {
    const report = {
      status: 'cooldown', ...base, target,
      nextTuneAt: new Date(lastAppliedAt + cooldownHours * 3600e3).toISOString(),
      summary: compactCallSummary(summary), diagnosis, worstInterval,
    };
    state.reviews = [...(state.reviews ?? []), {
      at: base.at, status: report.status, closed: summary.closed,
      lossRatePercent: summary.lossRatePercent, pnlPercent: summary.pnlPercent,
    }].slice(-30);
    await persist(state);
    return report;
  }

  if (!candidates.length) {
    const report = {
      status: 'no-supported-change', ...base, target,
      cause: base.postMortem?.verdict ?? null,
      summary: compactCallSummary(summary), diagnosis, worstInterval,
    };
    state.reviews = [...(state.reviews ?? []), {
      at: base.at, status: report.status, closed: summary.closed,
      lossRatePercent: summary.lossRatePercent, pnlPercent: summary.pnlPercent,
    }].slice(-30);
    await persist(state);
    return report;
  }

  // Đo trên chính các cặp/khung đã thua, không phải một rổ mã tuỳ chọn.
  const maxSymbols = Math.max(1, Number(cfg.maxSymbols ?? 3));
  const pairs = [];
  for (const trade of [...decisionSummary.lostTrades].reverse()) {
    const key = `${trade.symbol}|${trade.interval}`;
    if (!pairs.some((p) => p.key === key)) pairs.push({ key, symbol: trade.symbol, interval: trade.interval });
    if (pairs.length >= maxSymbols) break;
  }

  // Bộ mã canh gác: khung đã kiểm chứng, luôn đo dù kèo thua xảy ra ở đâu.
  const guardInterval = cfg.guardInterval ?? '4h';
  const guardPairs = (cfg.guardSymbols ?? ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'])
    .map((symbol) => ({ key: `guard:${symbol}|${guardInterval}`, symbol, interval: guardInterval, guard: true }));

  try {
    const wantCandles = Math.max(600, Number(cfg.backtestCandles ?? 3000));
    const prepared = [];
    for (const pair of [...pairs, ...guardPairs]) {
      const raw = closedCandles(await fetchCandles(pair.symbol, pair.interval, wantCandles));
      const splitIndex = Math.floor(raw.length * Number(cfg.trainingRatio ?? 0.75));
      if (raw.length < 500 || splitIndex <= 220 || raw.length - splitIndex < 120) {
        throw new Error(`${pair.symbol} ${pair.interval} không đủ nến để kiểm chứng`);
      }
      prepared.push({ ...pair, raw, splitIndex });
    }

    const seg = async (pair, strat, which) => metricsOf(await runBacktest(pair.symbol, pair.interval, strat, {
      candles: which === 'train' ? pair.splitIndex : pair.raw.length,
      candlesData: which === 'train' ? pair.raw.slice(0, pair.splitIndex) : pair.raw,
      startIndex: which === 'train' ? 220 : pair.splitIndex,
      storedModel: null,
    }));

    const baselines = [];
    for (const pair of prepared) {
      baselines.push({ key: pair.key, train: await seg(pair, strategy, 'train'), holdout: await seg(pair, strategy, 'holdout') });
    }

    const evaluated = [];
    for (const item of candidates) {
      const byPair = [];
      for (const pair of prepared) {
        const bl = baselines.find((b) => b.key === pair.key);
        const train = await seg(pair, item.strategy, 'train');
        const holdout = await seg(pair, item.strategy, 'holdout');
        const check = pair.guard ? passesGuard : passesImprovement;
        byPair.push({
          key: pair.key, guard: Boolean(pair.guard), train, holdout,
          passes: check(bl.train, train, cfg) && check(bl.holdout, holdout, cfg),
        });
      }
      const lossPairs = byPair.filter((r) => !r.guard);
      const guardRows = byPair.filter((r) => r.guard);
      evaluated.push({
        id: item.id, label: item.label, changes: item.changes, because: item.because,
        strategy: item.strategy,
        byPair: byPair.map(({ key, guard, train, holdout, passes: p }) => ({ key, guard, train, holdout, passes: p })),
        improves: lossPairs.every((r) => r.passes),
        guardOk: guardRows.every((r) => r.passes),
        passes: byPair.every((r) => r.passes),
        holdout: {
          slRatePercent: avg(lossPairs.map((r) => r.holdout), 'slRatePercent'),
          profitFactor: avg(lossPairs.map((r) => r.holdout), 'profitFactor'),
          expectancyPercent: avg(lossPairs.map((r) => r.holdout), 'expectancyPercent'),
        },
        guardHoldout: {
          slRatePercent: avg(guardRows.map((r) => r.holdout), 'slRatePercent'),
          profitFactor: avg(guardRows.map((r) => r.holdout), 'profitFactor'),
          expectancyPercent: avg(guardRows.map((r) => r.holdout), 'expectancyPercent'),
        },
      });
    }

    const accepted = evaluated.filter((e) => e.passes).sort((a, b) => (
      (a.holdout.slRatePercent - b.holdout.slRatePercent)
      || (b.holdout.expectancyPercent - a.holdout.expectancyPercent)
    ));
    const selected = accepted[0] ?? null;
    const autoApply = cfg.autoApply === true;
    const runtimeApply = cfg.runtimeApply === true;
    const applied = Boolean(selected && (autoApply || runtimeApply));

    const report = {
      status: selected ? (applied ? 'applied' : 'proposed') : 'no-safe-change',
      ...base, target, guardInterval,
      summary: compactCallSummary(summary),
      diagnosis, worstInterval,
      baselines,
      candidates: evaluated.map(({ strategy: unused, ...rest }) => rest),
      selected: selected ? {
        id: selected.id, label: selected.label, changes: selected.changes,
        because: selected.because, holdout: selected.holdout, guardHoldout: selected.guardHoldout,
      } : null,
      autoApply, runtimeApply,
    };

    if (applied) {
      state.activeTuning = {
        source: 'daily-comparison', appliedAt: new Date(now).toISOString(),
        changes: { ...(state.activeTuning?.changes ?? {}), ...selected.changes },
        selectedId: selected.id,
        comparisonDays: comparison.lookbackDays,
      };
      state.lastAppliedAt = new Date(now).toISOString();
      if (autoApply) await save(selected.strategy);
    }
    state.reviews = [...(state.reviews ?? []), {
      at: base.at, status: report.status, closed: summary.closed,
      lossRatePercent: summary.lossRatePercent, pnlPercent: summary.pnlPercent,
      selected: selected?.id ?? null,
    }].slice(-30);
    await persist(state);
    return report;
  } catch (error) {
    const report = {
      status: 'failed', ...base, target, error: error.message,
      summary: compactCallSummary(summary), diagnosis, worstInterval,
    };
    state.reviews = [...(state.reviews ?? []), { at: base.at, status: report.status, error: error.message }].slice(-30);
    await persist(state);
    return report;
  }
}

/**
 * Kết quả của `auto-retune` (kích hoạt theo chuỗi SL, chạy ở vòng quét) được
 * nhắc lại ở đây vì đó là đường duy nhất nó tới được người đọc.
 */
function pushRetune(L, report) {
  const rt = report.retune;
  if (!rt) return;
  L.push('');
  const when = rt.at ? rt.at.slice(0, 16).replace('T', ' ') : '';
  L.push(`🧪 <b>TỰ KIỂM CHỨNG SAU ${rt.streak ?? '?'} SL LIÊN TIẾP</b> (vòng quét, ${when} UTC)`);
  if (rt.status === 'no-safe-change' || !rt.selected) {
    L.push('   · Không phương án nào vừa cải thiện các cặp vừa thua vừa giữ được bộ canh gác — giữ nguyên cấu hình.');
    return;
  }
  const v = rt.selected.validation ?? {};
  const g = rt.selected.guardValidation ?? {};
  L.push(`   · ${rt.status === 'applied' ? 'ĐÃ ÁP DỤNG' : 'ĐỀ XUẤT'}: ${rt.selected.label}`);
  if (rt.selected.because) L.push(`   · Lý do: ${rt.selected.because}`);
  L.push(`   · Cặp vừa thua: PF ${v.profitFactor} · drawdown ${v.maxDrawdownPercent}% · ${v.trades} lệnh`);
  L.push(`   · Canh gác ${rt.guardInterval ?? '4h'}: PF ${g.profitFactor} · kỳ vọng ${g.expectancyPercent}%/lệnh`);
  L.push(`   · Thay đổi: ${Object.entries(rt.selected.changes ?? {}).map(([k, val]) => `${k} = ${JSON.stringify(val)}`).join(' · ')}`);
  if (rt.status !== 'applied') {
    L.push('   · <b>Chưa tự ghi</b> — sửa <code>config/strategy.json</code> rồi commit để áp dụng.');
  }
}

/** Phần "sai ở đâu": đếm theo nguyên nhân, rồi một câu kết luận về hướng sửa. */
function pushPostMortem(L, report) {
  const pm = report.postMortem;
  if (!pm) return;
  L.push('');
  if (pm.error) {
    L.push(`🧠 <b>HỌC LẠI TỪ KÈO DÍNH SL</b> — không phát lại được: ${pm.error}`);
    return;
  }
  L.push(`🧠 <b>HỌC LẠI TỪ ${pm.total} KÈO DÍNH SL</b> (chưa chốt được TP1)`);
  for (const [kind, count] of Object.entries(pm.counts)) {
    if (count) L.push(`   · ${KIND_LABELS[kind]}: ${count}`);
  }
  if (pm.medianNeededSlPercent != null) {
    L.push(`   · Trên các kèo bị quét: SL đang đặt ${pm.medianSlPercent}%, `
      + `cần ${pm.medianNeededSlPercent}% mới không bị quét (trung vị)`);
  }
  if (pm.medianBarsToSl != null) L.push(`   · Trung vị ${pm.medianBarsToSl} nến là dính SL`);
  if (pm.verdict) L.push(`   → ${pm.verdict.text}`);
}

function pushDailyComparison(L, report) {
  const c = report.comparison;
  if (!c?.days?.length) return;
  const pct = (value) => (value == null ? '—' : `${String(value).replace('.', ',')}%`);
  L.push('');
  L.push(`📊 <b>SO SÁNH ${c.lookbackDays} NGÀY</b>`);
  for (const day of c.days) {
    const label = day.date.split('-').reverse().slice(0, 2).join('/');
    const delta = day.lossRateDelta == null ? ''
      : ` · ΔSL ${day.lossRateDelta > 0 ? '+' : ''}${pct(day.lossRateDelta)}`;
    L.push(`   · ${label}: ${day.rated} kèo W/L (${day.closed} đã đóng) · `
      + `SL ${pct(day.lossRatePercent)} · PnL ${pct(day.pnlPercent)}${delta}`);
  }
  L.push(`   → Gộp ${c.aggregate.rated} kèo W/L: SL ${pct(c.aggregate.lossRatePercent)} · `
    + `PnL ${pct(c.aggregate.pnlPercent)} · ${c.badDays}/${c.eligibleDays} ngày đủ mẫu vượt mục tiêu`);
  const repeated = [
    ...(c.persistent?.byInterval ?? []).slice(0, 2).map((row) => `khung ${row.key} (${row.badDays} ngày)`),
    ...(c.persistent?.bySide ?? []).slice(0, 1).map((row) => `${row.key} (${row.badDays} ngày)`),
  ];
  if (repeated.length) L.push(`   → Lỗi lặp lại: ${repeated.join(' · ')}`);
}

function pushActiveTuning(L, report) {
  const tuning = report.activeTuning;
  if (!tuning?.changes) return;
  const changes = Object.entries(tuning.changes)
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(' · ');
  const at = tuning.appliedAt ? tuning.appliedAt.slice(0, 16).replace('T', ' ') : 'không rõ thời điểm';
  L.push(`⚙️ <b>CẤU HÌNH TỰ SỬA ĐANG CHẠY</b>: ${changes} (${at} UTC)`);
}

export function formatDailyReview(report) {
  const L = [];
  const s = report.summary;
  const pct = (v) => (v == null ? '—' : `${v}%`);
  // Số trong tin dùng dấu phẩy thập phân như mọi tin nhắn khác.
  const vi = (v) => String(v).replace('.', ',');

  if (report.status === 'disabled') return null;
  if (report.status === 'too-soon') return null;

  // ---- Khối tổng quan, theo form người dùng định nghĩa trong CLAUDE.md ----
  const capital = Number(s.capitalPerTradeUsd ?? 200);
  const pnl = s.pnlPercent;
  const pnlUsd = s.pnlUsd;
  const pnlText = pnl == null || pnlUsd == null
    ? '—'
    : `${pnlUsd >= 0 ? '🟢 +' : '🔴 '}${vi(pnlUsd.toFixed(2))}$ `
      + `(${pnl >= 0 ? '+' : ''}${vi(pnl.toFixed(2))}%)`;

  L.push('🌟 <b>Tổng Quan Hiệu Suất</b>');
  L.push(`Tổng số lệnh: <b>${s.closed}</b>`);
  L.push('<i>Không bao gồm các kèo đang mở.</i>');
  L.push('');
  L.push(`Tỉ lệ W/L: <b>${s.win ?? s.won} W - ${s.loss ?? s.lost} L</b>`);
  L.push('Win (W): Kèo đã chạm ít nhất TP1.');
  L.push('Loss (L): Kèo chạm SL khi chưa chạm TP1.');
  L.push('');
  L.push(`Tổng Lợi nhuận (PnL): <b>${s.closed ? pnlText : '0,00$ (+0,00%)'}</b>`);
  L.push(`Điều kiện tính toán: Giả định vốn vào mọi lệnh bằng nhau (${vi(capital)}$) và chưa nhân đòn bẩy. Đã trừ phí sàn cho mỗi lần thoát lệnh.`);

  // Chỉ đếm kèo ĐÃ CHỐT trong kỳ; kèo còn chạy nằm ngoài mọi con số dưới đây.
  if (!s.closed) {
    L.push('');
    L.push(`Không có kèo nào chốt trong ${report.window?.label ?? 'kỳ này'} — kèo đang mở `
      + 'chưa tính, chờ chạm SL/TP.');
    pushDailyComparison(L, report);
    pushActiveTuning(L, report);
    pushRetune(L, report);
    return L.join('\n');
  }

  pushDailyComparison(L, report);
  pushActiveTuning(L, report);

  L.push('');
  L.push(`📋 <b>RÀ SOÁT ${report.window?.label ?? `${report.everyHours}H`}</b> — chỉ tính kèo đã chốt, `
    + 'kèo đang mở chưa vào sổ');
  L.push(`Đã đóng ${s.closed} kèo: ✅ ${s.won} đã chạm TP1+ · 🛑 ${s.lost} chạm SL trước TP1`
    + ` · ⏱ ${s.unrated} chưa TP1 và không chạm SL`);
  L.push(`<b>Tỉ lệ thắng ${pct(s.winRatePercent)} · tỷ lệ thua ${pct(s.lossRatePercent)}</b> `
    + `(mẫu số ${s.rated} kèo W + L)`);
  if (pnl != null && s.pnlFromTrades != null && s.pnlFromTrades < s.closed) {
    L.push(`⚠️ Chỉ cộng được PnL của ${s.pnlFromTrades}/${s.closed} kèo; số còn lại thiếu giá thoát trong nhật ký.`);
  }
  L.push(`Mục tiêu tỉ lệ thua ≤ ${report.target}%`);

  pushPostMortem(L, report);
  pushRetune(L, report);

  if (report.status === 'not-enough-data') {
    L.push('');
    L.push(`ℹ️ Chuỗi so sánh mới có ${report.comparison?.aggregate?.rated ?? s.rated} kèo W/L, `
      + `cần tối thiểu ${report.minClosedTrades} mới đủ mẫu để đem đi backtest. Chỉ báo cáo, <b>không chỉnh gì</b>.`);
    return L.join('\n');
  }

  const d = report.diagnosis;
  if (d?.numeric?.length) {
    L.push('');
    L.push('🔍 <b>LỆNH THUA KHÁC LỆNH CÒN LẠI Ở ĐÂU</b>');
    for (const row of d.numeric.slice(0, 4)) {
      const arrow = row.deltaPercent > 0 ? 'cao hơn' : 'thấp hơn';
      L.push(`   · ${row.label}: ${row.lost} so với ${row.rest} — ${arrow} ${Math.abs(row.deltaPercent ?? 0)}%`);
    }
  }
  if (d?.byInterval?.length > 1) {
    L.push(`   · Theo khung: ${d.byInterval.map((r) => `${r.key} ${r.lossRatePercent}% (${r.lost}/${r.total})`).join(' · ')}`);
  }
  if (d?.bySide?.length > 1) {
    L.push(`   · Theo hướng: ${d.bySide.map((r) => `${r.key} ${r.lossRatePercent}% (${r.lost}/${r.total})`).join(' · ')}`);
  }
  if (d?.supportingGroups?.length) {
    L.push(`   · Nhóm hay ủng hộ lệnh thua: ${d.supportingGroups.slice(0, 3).map((g) => `${g.label} (${g.count})`).join(' · ')}`);
  }

  L.push('');
  if (report.status === 'on-target') {
    L.push('✅ Tỉ lệ thua gộp nhiều ngày đang trong mục tiêu — <b>không chỉnh gì</b>.');
    return L.join('\n');
  }
  if (report.status === 'monitoring-pattern') {
    L.push(`⏳ Tỉ lệ SL gộp đang cao nhưng lỗi mới xuất hiện ở ${report.comparison?.badDays ?? 0} ngày đủ mẫu; `
      + `cần ít nhất ${report.comparison?.minBadDays ?? 2} ngày để xác nhận lỗi lặp lại. Chưa chỉnh cấu hình.`);
    return L.join('\n');
  }
  if (report.status === 'cooldown') {
    L.push(`⏳ Lỗi đã lặp lại nhưng đang trong thời gian chờ sau lần tự sửa trước. `
      + `Lần kiểm tra chỉnh tiếp theo: ${report.nextTuneAt}.`);
    return L.join('\n');
  }
  if (report.status === 'no-supported-change') {
    L.push(`🧠 Tỉ lệ SL đang cao nhưng nguyên nhân ${report.cause?.id ?? 'chưa xác định'} chưa hỗ trợ `
      + 'một điều chỉnh cụ thể. Giữ nguyên cấu hình thay vì thử tham số không liên quan.');
    return L.join('\n');
  }
  if (report.status === 'review-only') {
    L.push('📝 Chỉ ghi nhận kèo thua và nguyên nhân. Không training, không backtest, không sửa cấu hình.');
    return L.join('\n');
  }
  if (report.status === 'failed') {
    L.push(`⚠️ Không kiểm chứng được đề xuất: ${report.error}. Giữ nguyên cấu hình.`);
    return L.join('\n');
  }
  if (report.status === 'no-safe-change') {
    L.push('🧪 Đã backtest các phương án chỉnh điều kiện vào lệnh/rủi ro (75% chọn / 25% mới hơn xác nhận) nhưng <b>không phương án nào</b> vừa giảm tỉ lệ SL vừa giữ được kỳ vọng dương. Giữ nguyên cấu hình.');
    if ((report.candidates ?? []).length) {
      for (const c of report.candidates) {
        const reasons = [];
        if (!c.improves) reasons.push('không giảm đủ tỉ lệ SL trên các cặp vừa thua');
        if (!c.guardOk) reasons.push(`làm xấu phần đang chạy tốt (khung ${report.guardInterval ?? '4h'}: kỳ vọng ${c.guardHoldout.expectancyPercent}%)`);
        const why = reasons.join('; ');
        L.push(`   · ${c.label}: SL ${pct(c.holdout.slRatePercent)}, PF ${c.holdout.profitFactor}, `
          + `kỳ vọng ${c.holdout.expectancyPercent}% → ${why}`);
      }
    }
  } else {
    const sel = report.selected;
    const verb = report.status === 'applied' ? 'ĐÃ ÁP DỤNG' : 'ĐỀ XUẤT';
    L.push(`🧪 <b>${verb}: ${sel.label}</b>`);
    L.push(`   Lý do: ${sel.because}`);
    L.push(`   Trên các cặp vừa thua (đoạn giữ lại): tỉ lệ SL ${pct(sel.holdout.slRatePercent)}, PF ${sel.holdout.profitFactor}, kỳ vọng ${sel.holdout.expectancyPercent}%/lệnh`);
    L.push(`   Trên bộ canh gác khung 4h: PF ${sel.guardHoldout.profitFactor}, kỳ vọng ${sel.guardHoldout.expectancyPercent}%/lệnh — không làm xấu phần đang chạy tốt`);
    L.push(`   Thay đổi: ${Object.entries(sel.changes).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(' · ')}`);
    if (report.status === 'proposed') {
      L.push('   ⚠️ <b>Chưa tự ghi</b> — bot chạy trên runner tạm, ghi cấu hình sẽ mất ở lượt sau. Sửa <code>config/strategy.json</code> rồi commit để áp dụng.');
    } else if (!report.autoApply && report.runtimeApply) {
      L.push('   ✅ Thay đổi đã lưu trong state và có hiệu lực từ lượt quét sau.');
    }
  }

  if (report.worstInterval && report.worstInterval.lossRatePercent > report.target) {
    L.push('');
    L.push(`📌 Khung <b>${report.worstInterval.key}</b> đang thua ${report.worstInterval.lossRatePercent}% `
      + `(${report.worstInterval.lost}/${report.worstInterval.total}). Danh sách khung nằm trong code `
      + '(<code>CALL_INTERVALS</code>), không sửa được qua cấu hình — cần quyết định thủ công.');
  }
  return L.join('\n');
}
