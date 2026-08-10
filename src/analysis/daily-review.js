// Rà soát định kỳ (mặc định mỗi ngày): đo tỉ lệ thua trên các kèo ĐÃ CHỐT trong
// ngày, truy nguyên đặc điểm của lệnh thua, rồi ĐỀ XUẤT chỉnh cấu hình — mỗi đề
// xuất đều phải qua backtest chia 75% chọn / 25% mới hơn xác nhận mới được nêu ra.
//
// Kèo đang mở KHÔNG bao giờ lọt vào đây: `recordClosedTrade` chỉ được gọi lúc kèo
// chạm SL/TP/hết hạn, nên `state.trades` chỉ chứa kèo đã có kết quả.
//
// Khác `auto-retune.js` ở ba điểm, và đó là lý do nó tồn tại riêng:
//  1. Kích hoạt theo THỜI GIAN, không theo chuỗi 3 SL liên tiếp.
//  2. Kèo 'breakeven' (chạm TP1 rồi SL kéo về entry) KHÔNG tính là thua.
//  3. Candidate sinh ra TỪ chẩn đoán và đi theo chiều đã đo được, thay vì luôn
//     siết chặt. Bộ candidate của auto-retune siết đúng những núm mà repo đã đo
//     là làm xấu thêm — xem bảng trong CLAUDE.md.
//
// Chỉ chạy ở Node: đọc/ghi file trạng thái và tải dữ liệu lịch sử.

import { fetchKlines, fetchKlinesHistory } from '../data/binance.js';
import { saveStrategy } from '../config.js';
import { closedCandles } from './engine.js';
import { backtest } from '../backtest.js';
import { diagnoseSupportingGroups, saveAutoRetuneState } from './auto-retune.js';
import { KIND_LABELS, postMortemLosses } from './post-mortem.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
const round = (value, digits = 2) => (Number.isFinite(Number(value)) ? Number(Number(value).toFixed(digits)) : null);

// 'stopped'  = chạm SL khi CHƯA chốt phần nào -> đây mới là lệnh thua thật.
// 'breakeven'= đã chốt 50% ở TP1, SL đã kéo về entry rồi mới quay lại -> có lãi
//              nhỏ, gọi là thua sẽ làm hỏng cả phép đo lẫn quyết định sau đó.
const LOST = 'stopped';
const BREAKEVEN = 'breakeven';

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
 * Thống kê theo đúng cách người dùng yêu cầu: lệnh thua là lệnh chạm SL mà chưa
 * chốt được TP1. Trả cả hai cách tính mẫu số vì "không tính kèo SL do đã done
 * TP1" có thể hiểu là bỏ khỏi tử số hoặc bỏ khỏi cả hai.
 */
export function summarizeCalls(trades, { sinceMs = null, untilMs = null } = {}) {
  const inWindow = sinceMs == null && untilMs == null
    ? [...trades]
    : trades.filter((t) => {
      const at = Date.parse(t.closedAt ?? '');
      if (!Number.isFinite(at)) return false;
      return (sinceMs == null || at >= sinceMs) && (untilMs == null || at < untilMs);
    });
  const by = (status) => inWindow.filter((t) => t.result?.status === status);
  const lost = by(LOST);
  const breakeven = by(BREAKEVEN);
  const won = by('target');
  const expired = by('expired');
  const closed = inWindow.length;
  const exBe = closed - breakeven.length;
  return {
    closed,
    lost: lost.length,
    breakeven: breakeven.length,
    won: won.length,
    expired: expired.length,
    lossRatePercent: closed ? round((lost.length / closed) * 100, 1) : null,
    // Bỏ hẳn kèo breakeven khỏi mẫu số.
    lossRateExcludingBreakevenPercent: exBe > 0 ? round((lost.length / exBe) * 100, 1) : null,
    winRatePercent: closed ? round((won.length / closed) * 100, 1) : null,
    trades: inWindow,
    lostTrades: lost,
  };
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
  const rest = summary.trades.filter((t) => t.result?.status !== LOST);
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
    const all = tally(summary.trades, pick);
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

/**
 * Candidate sinh TỪ chẩn đoán, và đi theo chiều đã đo được trên khung 4h:
 * nới SL + tắt bám cấu trúc làm giảm tỉ lệ SL, còn siết điểm/CVD/volume thì
 * không. Vẫn giữ mỗi candidate ở mức một bước nhỏ để không nhảy quá xa.
 */
export function buildReviewCandidates(strategy, cfg, diagnosis) {
  const risk = strategy.risk ?? {};
  const sl = Number(risk.slPercent ?? 4);
  const tp = Array.isArray(risk.takeProfitR) ? risk.takeProfitR : [0.75, 1.5, 2.25];
  const out = [];
  const add = (id, label, changes, because) => {
    const next = clone(strategy);
    for (const [pathString, value] of Object.entries(changes)) {
      const parts = pathString.split('.');
      let node = next;
      for (let i = 0; i < parts.length - 1; i++) { node[parts[i]] ??= {}; node = node[parts[i]]; }
      node[parts.at(-1)] = value;
    }
    out.push({ id, label, changes, because, strategy: next });
  };

  const widerSl = Math.min(Number(cfg.maxSlPercent ?? 6), round(sl + Number(cfg.slPercentStep ?? 0.5), 2));
  if (widerSl > sl) {
    add('wider-stop', `Nới khoảng SL ${sl}% → ${widerSl}%`, { 'risk.slPercent': widerSl },
      'Lệnh thua thường có khoảng SL hẹp hơn phần còn lại, tức SL nằm trong biên độ nhiễu.');
  }

  if (risk.preferSrLevels) {
    add('fixed-stop', 'Bỏ bám SL vào hỗ trợ/kháng cự', { 'risk.preferSrLevels': false },
      'Bám cấu trúc cho phép SL co xuống tới 0,4× mức cơ sở, làm khoảng SL thật hẹp hơn cấu hình.');
  }

  const tp1 = Number(tp[0] ?? 0.75);
  const nearerTp1 = Math.max(Number(cfg.minTp1R ?? 0.5), round(tp1 - Number(cfg.tp1Step ?? 0.25), 2));
  if (nearerTp1 < tp1) {
    const ratio = nearerTp1 / tp1;
    add('nearer-tp1', `Kéo TP gần lại (TP1 ${tp1}R → ${nearerTp1}R)`,
      { 'risk.takeProfitR': tp.map((r) => round(r * ratio, 3)) },
      'TP1 là mốc kéo SL về entry; TP1 gần hơn thì nhiều lệnh được bảo vệ sớm hơn.');
  }

  // Khung nào có tỉ lệ thua vượt trội thì nêu ra, nhưng KHÔNG backtest được qua
  // strategy.json (danh sách khung nằm trong code), nên chỉ báo cáo.
  const worstInterval = (diagnosis.byInterval ?? [])
    .filter((row) => row.total >= Math.max(4, Number(cfg.minTradesPerInterval ?? 5)))[0] ?? null;

  return { candidates: out, worstInterval };
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

export async function runDailyReview({ strategy, state, now = Date.now(), deps = {} }) {
  const cfg = strategy.dailyReview ?? {};
  const persist = deps.saveState ?? saveAutoRetuneState;
  const fetchCandles = deps.fetchCandles ?? fetchKlinesHistory;
  const runBacktest = deps.runBacktest ?? backtest;
  const save = deps.saveStrategy ?? saveStrategy;
  const force = Boolean(deps.force);

  const everyHours = Math.max(1, Number(cfg.everyHours ?? 24));
  const window = reviewWindow(cfg, now);
  const base = { enabled: cfg.enabled !== false, everyHours, window, at: new Date(now).toISOString() };
  if (!base.enabled) return { status: 'disabled', ...base };

  const lastAt = Date.parse(state.lastReviewAt ?? '');
  if (!force && Number.isFinite(lastAt) && now - lastAt < everyHours * 3600e3) {
    return {
      status: 'too-soon', ...base,
      nextAt: new Date(lastAt + everyHours * 3600e3).toISOString(),
    };
  }

  const summary = summarizeCalls(state.trades ?? [], { sinceMs: window.sinceMs, untilMs: window.untilMs });
  const minTrades = Math.max(3, Number(cfg.minClosedTrades ?? 10));
  const target = Number(cfg.targetLossRatePercent ?? 30);

  state.lastReviewAt = new Date(now).toISOString();

  // Mổ xẻ từng kèo SL trên nến thật. Chạy TRƯỚC cửa `minClosedTrades` vì nó chỉ
  // mô tả chuyện đã xảy ra — không đổi cấu hình nên không cần cỡ mẫu để an toàn,
  // và một ngày ít kèo vẫn đáng biết mình sai ở đâu. Hỏng mạng thì bỏ phần này,
  // không được làm chết cả bản rà soát.
  const learn = strategy.learning ?? {};
  base.postMortem = null;
  if (learn.enabled !== false && summary.lostTrades.length) {
    try {
      base.postMortem = await postMortemLosses(summary.lostTrades, {
        fetchCandles: deps.fetchRecentCandles ?? fetchKlines,
        maxTrades: Number(learn.maxTradesPerReview ?? 12),
        candles: Number(learn.replayCandles ?? 400),
        maxHoldBars: Number(strategy.alerts?.maxHoldBars ?? 96),
        widerSlMultiple: Number(learn.widerSlMultiple ?? 1.5),
        minBarsAfterStop: Number(learn.minBarsAfterStop ?? 6),
        noFavorMoveR: Number(learn.noFavorMoveR ?? 0.15),
      });
    } catch (error) {
      base.postMortem = { error: error.message };
    }
  }

  // Chưa đủ mẫu thì vẫn BÁO CÁO số của ngày, chỉ không đụng vào cấu hình. Cửa
  // sổ một ngày thường ít kèo hơn ngưỡng này, nên nếu bỏ luôn phần thống kê thì
  // phần lớn báo cáo sẽ trống rỗng.
  if (summary.closed < minTrades) {
    const report = {
      status: 'not-enough-data', ...base, target,
      summary: { ...summary, trades: undefined, lostTrades: undefined }, minClosedTrades: minTrades,
    };
    state.reviews = [...(state.reviews ?? []), { at: base.at, status: report.status, closed: summary.closed }].slice(-30);
    await persist(state);
    return report;
  }

  const diagnosis = diagnoseLosses(summary);
  const { candidates, worstInterval } = buildReviewCandidates(strategy, cfg, diagnosis);

  // Đạt mục tiêu rồi thì không đụng vào cấu hình — chỉnh khi đang ổn là cách
  // nhanh nhất để tối ưu theo nhiễu.
  if (summary.lossRatePercent != null && summary.lossRatePercent <= target) {
    const report = {
      status: 'on-target', ...base, target,
      summary: { ...summary, trades: undefined, lostTrades: undefined }, diagnosis, worstInterval,
    };
    state.reviews = [...(state.reviews ?? []), { at: base.at, status: report.status, lossRatePercent: summary.lossRatePercent }].slice(-30);
    await persist(state);
    return report;
  }

  // Đo trên chính các cặp/khung đã thua, không phải một rổ mã tuỳ chọn.
  const maxSymbols = Math.max(1, Number(cfg.maxSymbols ?? 3));
  const pairs = [];
  for (const trade of [...summary.lostTrades].reverse()) {
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

    const report = {
      status: selected ? (autoApply ? 'applied' : 'proposed') : 'no-safe-change',
      ...base, target, guardInterval,
      summary: { ...summary, trades: undefined, lostTrades: undefined },
      diagnosis, worstInterval,
      baselines,
      candidates: evaluated.map(({ strategy: unused, ...rest }) => rest),
      selected: selected ? {
        id: selected.id, label: selected.label, changes: selected.changes,
        because: selected.because, holdout: selected.holdout, guardHoldout: selected.guardHoldout,
      } : null,
      autoApply,
    };

    if (selected && autoApply) {
      await save(selected.strategy);
      state.lastAppliedAt = new Date(now).toISOString();
    }
    state.reviews = [...(state.reviews ?? []), {
      at: base.at, status: report.status, lossRatePercent: summary.lossRatePercent,
      selected: selected?.id ?? null,
    }].slice(-30);
    await persist(state);
    return report;
  } catch (error) {
    const report = {
      status: 'failed', ...base, target, error: error.message,
      summary: { ...summary, trades: undefined, lostTrades: undefined }, diagnosis, worstInterval,
    };
    state.reviews = [...(state.reviews ?? []), { at: base.at, status: report.status, error: error.message }].slice(-30);
    await persist(state);
    return report;
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

export function formatDailyReview(report) {
  const L = [];
  const s = report.summary;
  const pct = (v) => (v == null ? '—' : `${v}%`);

  if (report.status === 'disabled') return null;
  if (report.status === 'too-soon') return null;

  L.push(`📋 <b>RÀ SOÁT ${report.window?.label ?? `${report.everyHours}H`}</b>`);

  // Chỉ đếm kèo ĐÃ CHỐT trong kỳ; kèo còn chạy nằm ngoài mọi con số dưới đây.
  if (!s.closed) {
    L.push('Không có kèo nào chốt trong kỳ này — kèo đang mở chưa tính, chờ chạm SL/TP.');
    return L.join('\n');
  }

  L.push(`Đã đóng ${s.closed} kèo: 🎯 ${s.won} chạm TP · 🛑 ${s.lost} dính SL · 🛡 ${s.breakeven} về hoà vốn · ⏱ ${s.expired} hết hạn`);
  L.push(`<b>Tỉ lệ thua ${pct(s.lossRatePercent)}</b> (không tính ${s.breakeven} kèo đã chốt TP1 rồi mới về entry)`);
  if (s.lossRateExcludingBreakevenPercent != null && s.breakeven > 0) {
    L.push(`Nếu bỏ hẳn kèo hoà vốn khỏi mẫu số: ${pct(s.lossRateExcludingBreakevenPercent)}`);
  }
  L.push(`Thắng ${pct(s.winRatePercent)} · mục tiêu tỉ lệ thua ≤ ${report.target}%`);

  pushPostMortem(L, report);

  if (report.status === 'not-enough-data') {
    L.push('');
    L.push(`ℹ️ Mới ${s.closed} kèo đã đóng, cần tối thiểu ${report.minClosedTrades} mới đủ mẫu để `
      + 'đem đi backtest. Chỉ báo cáo, <b>không chỉnh gì</b>.');
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
    L.push('✅ Tỉ lệ thua đang trong mục tiêu — <b>không chỉnh gì</b>. Sửa cấu hình lúc đang ổn chỉ là tối ưu theo nhiễu.');
    return L.join('\n');
  }
  if (report.status === 'failed') {
    L.push(`⚠️ Không kiểm chứng được đề xuất: ${report.error}. Giữ nguyên cấu hình.`);
    return L.join('\n');
  }
  if (report.status === 'no-safe-change') {
    L.push('🧪 Đã backtest các phương án chỉnh (chia 75% chọn / 25% mới hơn xác nhận) nhưng <b>không phương án nào</b> vừa giảm tỉ lệ SL vừa giữ được kỳ vọng dương. Giữ nguyên cấu hình.');
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
