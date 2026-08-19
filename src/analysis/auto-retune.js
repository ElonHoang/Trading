// Tự kiểm chứng sau chuỗi SL. Trạng thái và cấu hình được lưu trong PostgreSQL.

import { saveStrategy } from '../config.js';
import { getDocument, putDocument } from '../db.js';
import { fetchKlinesHistory, INTERVAL_MS } from '../data/binance.js';
import { closedCandles } from './engine.js';
import { backtest } from '../backtest.js';
import { entryMarketContext } from './entry-quality.js';

const STATE_KEY = 'data:auto-retune';

const GROUP_LABELS = {
  cvd: 'CVD',
  volume: 'Khối lượng',
  derivatives: 'Phái sinh',
  positioning: 'Định vị đám đông',
  structure: 'Hỗ trợ/kháng cự',
  orderBook: 'Sổ lệnh',
  historicalPattern: 'Mẫu hình lịch sử',
};

const clone = (value) => JSON.parse(JSON.stringify(value));
const round = (value, digits = 2) => Number(Number(value).toFixed(digits));

function emptyState() {
  return {
    trades: [], attempts: [], reviews: [], lossLogs: [], lossLogWeek: null, activeTuning: null,
    lastHandledTriggerId: null, lastAppliedAt: null, lastReviewAt: null,
  };
}

export async function readAutoRetuneState() {
  const parsed = await getDocument(STATE_KEY, emptyState());
  return {
    ...emptyState(),
    ...(parsed && typeof parsed === 'object' ? parsed : {}),
    trades: Array.isArray(parsed?.trades) ? parsed.trades : [],
    attempts: Array.isArray(parsed?.attempts) ? parsed.attempts : [],
    lossLogs: Array.isArray(parsed?.lossLogs) ? parsed.lossLogs : [],
    lossLogWeek: typeof parsed?.lossLogWeek === 'string' ? parsed.lossLogWeek : null,
  };
}

async function saveState(state) {
  return putDocument(STATE_KEY, state);
}

/** Rà soát định kỳ dùng chung document trạng thái này nên cần ghi được từ ngoài. */
export { saveState as saveAutoRetuneState };

/** Chỉ lưu số liệu tại thời điểm call để sau này không suy diễn từ dữ liệu tương lai. */
export function buildCallEvidence(snapshot, setup) {
  const groups = Object.fromEntries(Object.entries(snapshot.rules?.breakdown ?? {}).map(([name, group]) => [name, {
    score: group.score ?? null,
    contributionPct: group.contributionPct ?? null,
    skipped: Boolean(group.skipped),
  }]));
  const series = snapshot.series;
  const candles = series?.close?.map((close, i) => ({
    close, high: series.high?.[i], low: series.low?.[i],
  })) ?? [];
  const market = entryMarketContext(candles);
  return {
    side: setup.side,
    score: snapshot.combined?.score ?? null,
    consensusPercent: snapshot.rules?.consensus?.percent ?? null,
    riskPercent: setup.riskPercent ?? snapshot.levels?.riskPercent ?? null,
    cvdSlope: snapshot.indicators?.cvdSlope ?? null,
    volumeRatio: snapshot.indicators?.volumeRatio ?? null,
    priceChange20Pct: market.priceChange20Pct,
    rangePosition50: market.rangePosition50,
    groups,
  };
}

/**
 * Chỉ trạng thái 'stopped' mới tính là SL. Kèo 'breakeven' (đã chốt một phần ở
 * TP1 rồi về entry) làm ĐỨT chuỗi — nó không phải một lần vào lệnh sai, và tính
 * nó vào chuỗi sẽ kích hoạt siết cấu hình dựa trên những kèo thực ra có lãi.
 */
export function stopLossStreak(trades) {
  let streak = 0;
  for (let i = trades.length - 1; i >= 0; i--) {
    if (trades[i]?.result?.status !== 'stopped') break;
    streak++;
  }
  return streak;
}

export async function recordClosedTrade({ call, result, snapshot, historyLimit = 200 }) {
  const state = await readAutoRetuneState();
  const candleStart = Date.parse(snapshot?.lastClosedCandleTime ?? '');
  const intervalMs = INTERVAL_MS[call.interval ?? snapshot?.interval];
  const fallbackClosedAt = Number.isFinite(candleStart) && Number.isFinite(intervalMs)
    ? new Date(candleStart + intervalMs - 1).toISOString()
    : (snapshot?.generatedAt ?? snapshot?.lastClosedCandleTime ?? new Date().toISOString());
  // Ưu tiên cây nến thật sự chạm SL/TP. Không dùng openTime của nến cuối vì
  // một nến 4H có thể mở trước 00:00 nhưng chỉ đóng vào ngày hôm sau.
  const closedAt = result?.closedAt ?? fallbackClosedAt;
  const trade = {
    id: `${call.symbol}|${call.interval}|${call.openedAtCandle}|${closedAt}|${result.status}`,
    symbol: call.symbol,
    interval: call.interval,
    side: call.side,
    openedAt: call.openedAt ?? null,
    closedAt,
    // Giá của kèo được chép vào đây để sau này PHÁT LẠI được trên nến thật.
    // Thiếu chúng thì bản mổ xẻ chỉ còn cách suy ngược từ giá hiện tại rồi gán
    // cho một quyết định đã cũ — đúng kiểu tự lừa mình mà repo tránh.
    entry: call.entry ?? null,
    stopLoss: call.stopLoss ?? null,
    targets: (call.targets ?? []).map((t) => ({ label: t.label, price: t.price })),
    openedAtCandle: call.openedAtCandle ?? null,
    result: {
      status: result.status,
      hitTps: result.hitTps ?? [],
      bars: result.bars ?? null,
      lastPrice: result.lastPrice ?? null,
    },
    evidence: call.evidence ?? null,
  };
  state.trades.push(trade);
  state.trades = state.trades.slice(-Math.max(20, Number(historyLimit) || 200));
  await saveState(state);
  return { state, trade, streak: stopLossStreak(state.trades) };
}

/**
 * Đây là mức liên quan, không phải kết luận nhân quả: nhóm nào đã ủng hộ cùng
 * hướng với lệnh trong nhiều SL liên tiếp thì cần bị xem xét chặt hơn.
 */
export function diagnoseSupportingGroups(trades) {
  const totals = new Map();
  for (const trade of trades) {
    const direction = trade.side === 'long' ? 1 : -1;
    for (const [group, evidence] of Object.entries(trade.evidence?.groups ?? {})) {
      const contribution = Number(evidence?.contributionPct);
      if (!Number.isFinite(contribution) || evidence?.skipped || contribution * direction <= 0) continue;
      const row = totals.get(group) ?? { group, count: 0, totalContribution: 0 };
      row.count++;
      row.totalContribution += Math.abs(contribution);
      totals.set(group, row);
    }
  }
  return [...totals.values()]
    .map((row) => ({
      ...row,
      label: GROUP_LABELS[row.group] ?? row.group,
      averageContribution: round(row.totalContribution / row.count),
    }))
    .sort((a, b) => (b.count - a.count) || (b.averageContribution - a.averageContribution));
}

function setPath(obj, pathString, value) {
  const parts = pathString.split('.');
  let node = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    node[parts[i]] ??= {};
    node = node[parts[i]];
  }
  node[parts.at(-1)] = value;
}

/**
 * Áp các thay đổi đã vượt backtest lên một bản sao của strategy. Bản override
 * nằm trong state bền vững, nên GitHub runner mới vẫn dùng được cấu hình đã học
 * ở lượt trước mà không cần sửa file trong checkout tạm.
 */
export function applyStrategyChanges(strategy, changes = {}) {
  const next = clone(strategy);
  for (const [pathString, value] of Object.entries(changes)) setPath(next, pathString, clone(value));
  return next;
}

export function applyActiveTuning(strategy, state = {}) {
  const changes = state.activeTuning?.changes;
  return changes && typeof changes === 'object'
    ? applyStrategyChanges(strategy, changes)
    : clone(strategy);
}

function candidate(strategy, id, label, changes) {
  const next = clone(strategy);
  for (const [pathString, value] of Object.entries(changes)) setPath(next, pathString, value);
  return { id, label, changes, strategy: next };
}

/**
 * Bộ phương án chỉnh, đi theo CHIỀU ĐÃ ĐO ĐƯỢC: nới SL, bỏ bám cấu trúc, kéo TP1
 * gần lại. Dùng chung cho `auto-retune` (kích hoạt theo chuỗi SL) và
 * `daily-review` (kích hoạt theo lịch) để hai đường không trôi khỏi nhau.
 *
 * Bộ CŨ của auto-retune đã bị xoá, không phải rút gọn: nó siết `thresholds.buy`,
 * `entryQuality` (CVD + volume) và giảm `slPercent`. Bảng đo trong CLAUDE.md cho
 * thấy cả ba đều làm TỈ LỆ SL TĂNG và PF sập (siết điểm ≥ 35: SL 49,0% → 53,3%,
 * PF 0,45 → 0,33), còn `slPercent` thì phải NỚI mới giảm SL thật. Giữ chúng lại
 * nghĩa là cơ chế "tự sửa sau chuỗi SL" có quyền làm hệ thống xấu đi — đúng thứ
 * bản năng mà repo đã kiểm chứng là sai.
 */
export function buildRiskCandidates(strategy, cfg = {}) {
  const risk = strategy.risk ?? {};
  const sl = Number(risk.slPercent ?? 4);
  const tp = Array.isArray(risk.takeProfitR) ? risk.takeProfitR : [0.75, 1.5, 2.25];
  const out = [];
  const add = (id, label, changes, because) => {
    const built = candidate(strategy, id, label, changes);
    out.push({ ...built, because });
  };

  // Thử cả một thang nhỏ tới trần cấu hình. Chỉ thử đúng một bước 0,5% khiến
  // optimizer kết luận "không có phương án" dù post-mortem đo rằng nhiễu rộng
  // hơn nhiều; ngược lại nhảy thẳng tới trần sẽ không tìm được mức thấp nhất đủ
  // hiệu quả. Mọi nấc vẫn phải qua train/holdout và guard như nhau.
  const step = Math.max(0.1, Number(cfg.slPercentStep ?? 0.5));
  const maxSl = Math.max(sl, Number(cfg.maxSlPercent ?? 6));
  for (let next = sl + step, index = 0; next <= maxSl + 1e-9; next += step, index++) {
    const widerSl = round(Math.min(next, maxSl), 2);
    add(index === 0 ? 'wider-stop' : `wider-stop-${String(widerSl).replace('.', '-')}`,
      `Nới khoảng SL ${sl}% → ${widerSl}%`, { 'risk.slPercent': widerSl },
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

  return out;
}

/**
 * Bộ candidate cho auto-retune, cộng thêm SÀN CỨNG `minSlPercent`: không phương
 * án nào được phép kéo `risk.slPercent` xuống dưới mức đã đo là tốt. Gói
 * `slPercent 4 · takeProfitR [0,75; 1,5; 2,25] · preferSrLevels false` là một
 * khối không tách rời (xem CLAUDE.md), và cơ chế tự chỉnh không được phép xoá nó.
 */
export function buildRetuneCandidates(strategy, cfg = {}) {
  const current = Number(strategy.risk?.slPercent);
  const floor = Number(cfg.minSlPercent ?? 3);
  // Nếu cấu hình đang chạy vốn đã thấp hơn sàn thì lấy chính nó làm mốc: sàn
  // dùng để chặn việc SIẾT XUỐNG, không phải để khoá luôn cả phương án nới lên.
  const limit = Number.isFinite(current) ? Math.min(floor, current) : floor;
  return buildRiskCandidates(strategy, cfg).filter((item) => {
    const sl = Number(item.strategy.risk?.slPercent);
    return !Number.isFinite(sl) || sl >= limit;
  });
}

function metrics(result) {
  const s = result.stats ?? {};
  return {
    trades: Number(s.trades ?? 0),
    profitFactor: Number.isFinite(s.profitFactor) ? s.profitFactor : null,
    expectancyPercent: Number.isFinite(s.expectancyPercent) ? s.expectancyPercent : null,
    maxDrawdownPercent: Number.isFinite(s.maxDrawdownPercent) ? s.maxDrawdownPercent : null,
    totalReturnPercent: Number.isFinite(s.totalReturnPercent) ? s.totalReturnPercent : null,
  };
}

/**
 * Cổng thứ hai, chạy trên BỘ MÃ CANH GÁC ở khung đã kiểm chứng (4h). Cấu hình là
 * toàn cục: một thay đổi sinh ra từ 3 lệnh thua — thường ở khung yếu — không được
 * phép làm hỏng phần đang chạy tốt. Ở đây đòi kỳ vọng DƯƠNG TUYỆT ĐỐI, khác
 * `passesRiskCheck` vốn chỉ đòi tốt hơn chính nó.
 *
 * Trước đây auto-retune không có cổng này; nó chỉ đo trên đúng các cặp vừa thua,
 * nên một phương án cứu được 3 lệnh đó vẫn có thể kéo cả hệ thống xuống.
 */
function passesGuardCheck(baseline, proposed, cfg) {
  const minTrades = Math.max(5, Number(cfg.minTradesPerSegment ?? 8));
  if (proposed.trades < minTrades) return false;
  if (![proposed.profitFactor, proposed.expectancyPercent].every(Number.isFinite)) return false;
  const tolerance = Number(cfg.guardExpectancyTolerance ?? 0.02);
  return proposed.expectancyPercent > 0
    && proposed.profitFactor >= Number(cfg.minProfitFactor ?? 1.05)
    && proposed.expectancyPercent >= (baseline.expectancyPercent ?? 0) - tolerance;
}

function passesRiskCheck(baseline, proposed, cfg) {
  const minTrades = Math.max(5, Number(cfg.minTradesPerSegment ?? 8));
  const minPf = Number(cfg.minProfitFactor ?? 1.05);
  const reduceBy = Number(cfg.minDrawdownReductionPercent ?? 10) / 100;
  if (proposed.trades < minTrades || !Number.isFinite(proposed.profitFactor)
    || !Number.isFinite(proposed.expectancyPercent) || !Number.isFinite(proposed.maxDrawdownPercent)
    || !Number.isFinite(baseline.maxDrawdownPercent)) return false;
  return proposed.profitFactor >= minPf
    && proposed.expectancyPercent > 0
    && proposed.maxDrawdownPercent <= baseline.maxDrawdownPercent * (1 - reduceBy);
}

function averageMetrics(rows) {
  const mean = (key) => rows.length
    ? round(rows.reduce((sum, row) => sum + (Number(row[key]) || 0), 0) / rows.length) : null;
  return {
    trades: rows.reduce((sum, row) => sum + row.trades, 0),
    profitFactor: mean('profitFactor'),
    expectancyPercent: mean('expectancyPercent'),
    maxDrawdownPercent: mean('maxDrawdownPercent'),
    totalReturnPercent: mean('totalReturnPercent'),
  };
}

async function runSegment(runBacktest, symbol, interval, strategy, candlesData, startIndex) {
  const result = await runBacktest(symbol, interval, strategy, {
    candles: candlesData.length,
    candlesData,
    startIndex,
    storedModel: null,
  });
  return metrics(result);
}

async function backupStrategy(strategy, report) {
  const stamp = new Date().toISOString();
  const key = `backup:strategy:${stamp}`;
  await putDocument(key, { strategy, report });
  return `database:${key}`;
}

/**
 * Chạy 75% dữ liệu cũ để đo và 25% mới hơn để xác nhận. Chỉ tự ghi cấu hình khi
 * candidate vượt cả hai phần của MỌI cặp vừa chạm SL, nhờ vậy không tối ưu theo 3 lệnh.
 */
export async function runAutoRetune({ strategy, state, deps = {} }) {
  const cfg = strategy.autoRetune ?? {};
  const persist = deps.saveState ?? saveState;
  const enabled = cfg.enabled === true;
  const streak = stopLossStreak(state.trades);
  const requiredStreak = Math.max(3, Number(cfg.stopLossStreak ?? 3));
  const latest = state.trades.at(-1);
  const reportBase = { enabled, streak, requiredStreak, triggerTradeId: latest?.id ?? null };
  if (!enabled || streak < requiredStreak || !latest) return { status: 'not-triggered', ...reportBase };
  if (state.lastHandledTriggerId === latest.id) return { status: 'already-handled', ...reportBase };

  state.lastHandledTriggerId = latest.id;
  const cooldownHours = Math.max(0, Number(cfg.cooldownHours ?? 168));
  const lastAppliedAt = Date.parse(state.lastAppliedAt ?? '');
  if (Number.isFinite(lastAppliedAt) && Date.now() - lastAppliedAt < cooldownHours * 3600e3) {
    const report = { status: 'cooldown', ...reportBase, suspectedGroups: diagnoseSupportingGroups(state.trades.slice(-streak)) };
    state.attempts.push({ at: new Date().toISOString(), ...report });
    state.attempts = state.attempts.slice(-30);
    await persist(state);
    return report;
  }

  const fetchCandles = deps.fetchCandles ?? fetchKlinesHistory;
  const runBacktest = deps.runBacktest ?? backtest;
  const save = deps.saveStrategy ?? saveStrategy;
  const saveBackup = deps.backupStrategy ?? backupStrategy;
  const suspects = diagnoseSupportingGroups(state.trades.slice(-streak));
  const maxSymbols = Math.max(1, Number(cfg.maxSymbols ?? 3));
  const pairs = [];
  for (const trade of state.trades.slice(-streak).reverse()) {
    const key = `${trade.symbol}|${trade.interval}`;
    if (!pairs.some((pair) => pair.key === key)) pairs.push({ key, symbol: trade.symbol, interval: trade.interval });
    if (pairs.length >= maxSymbols) break;
  }

  // Bộ canh gác: luôn đo, dù chuỗi SL xảy ra ở mã/khung nào.
  const guardInterval = cfg.guardInterval ?? '4h';
  const guardPairs = (cfg.guardSymbols ?? ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'])
    .map((symbol) => ({ key: `guard:${symbol}|${guardInterval}`, symbol, interval: guardInterval, guard: true }));

  try {
    const candlesByPair = [];
    const wantCandles = Math.max(600, Number(cfg.backtestCandles ?? 3000));
    for (const pair of [...pairs, ...guardPairs]) {
      const raw = closedCandles(await fetchCandles(pair.symbol, pair.interval, wantCandles));
      const splitIndex = Math.floor(raw.length * Number(cfg.trainingRatio ?? 0.75));
      if (raw.length < 500 || splitIndex <= 220 || raw.length - splitIndex < 120) {
        throw new Error(`${pair.symbol} ${pair.interval} không đủ nến để kiểm chứng`);
      }
      candlesByPair.push({ ...pair, raw, splitIndex });
    }

    const candidates = buildRetuneCandidates(strategy, cfg);
    const baselineByPair = [];
    for (const pair of candlesByPair) {
      baselineByPair.push({
        key: pair.key,
        train: await runSegment(runBacktest, pair.symbol, pair.interval, strategy, pair.raw.slice(0, pair.splitIndex), 220),
        validation: await runSegment(runBacktest, pair.symbol, pair.interval, strategy, pair.raw, pair.splitIndex),
      });
    }

    const evaluated = [];
    for (const item of candidates) {
      const byPair = [];
      for (const pair of candlesByPair) {
        const baseline = baselineByPair.find((row) => row.key === pair.key);
        const train = await runSegment(runBacktest, pair.symbol, pair.interval, item.strategy, pair.raw.slice(0, pair.splitIndex), 220);
        const validation = await runSegment(runBacktest, pair.symbol, pair.interval, item.strategy, pair.raw, pair.splitIndex);
        const check = pair.guard ? passesGuardCheck : passesRiskCheck;
        byPair.push({
          key: pair.key,
          guard: Boolean(pair.guard),
          train,
          validation,
          passes: check(baseline.train, train, cfg) && check(baseline.validation, validation, cfg),
        });
      }
      const lossRows = byPair.filter((row) => !row.guard);
      const guardRows = byPair.filter((row) => row.guard);
      evaluated.push({
        id: item.id,
        label: item.label,
        changes: item.changes,
        because: item.because ?? null,
        strategy: item.strategy,
        byPair,
        improves: lossRows.every((row) => row.passes),
        guardOk: guardRows.every((row) => row.passes),
        passes: byPair.every((row) => row.passes),
        // Đo tiền trên các cặp VỪA THUA; bộ canh gác chỉ là cổng chặn, gộp trung
        // bình chung sẽ làm loãng đúng phần cần nhìn.
        validation: averageMetrics(lossRows.map((row) => row.validation)),
        guardValidation: averageMetrics(guardRows.map((row) => row.validation)),
      });
    }

    const accepted = evaluated.filter((item) => item.passes).sort((a, b) => (
      (a.validation.maxDrawdownPercent - b.validation.maxDrawdownPercent)
      || (b.validation.profitFactor - a.validation.profitFactor)
      || (b.validation.expectancyPercent - a.validation.expectancyPercent)
    ));
    const selected = accepted[0] ?? null;
    // `autoApply` mặc định TẮT, giống dailyReview và vì cùng một lý do: runner
    // GitHub bị huỷ sau mỗi lượt nên cấu hình tự ghi sẽ mất ở lượt sau, và một
    // thay đổi âm thầm không ai duyệt thì lượt sau không truy lại được. Tắt nó
    // cho phép BẬT cả cơ chế ở production mà không có đường ghi lén.
    const autoApply = cfg.autoApply === true;
    const runtimeApply = cfg.runtimeApply === true;
    const applied = Boolean(selected && (autoApply || runtimeApply));
    const report = {
      status: selected ? (applied ? 'applied' : 'proposed') : 'no-safe-change',
      ...reportBase,
      autoApply, runtimeApply,
      guardInterval,
      suspectedGroups: suspects,
      pairs: baselineByPair,
      candidates: evaluated.map(({ strategy: unused, ...item }) => item),
      selected: selected ? {
        id: selected.id,
        label: selected.label,
        changes: selected.changes,
        because: selected.because ?? null,
        validation: selected.validation,
        guardValidation: selected.guardValidation,
      } : null,
    };
    if (applied) {
      state.activeTuning = {
        source: 'stop-loss-streak', appliedAt: new Date().toISOString(),
        changes: { ...(state.activeTuning?.changes ?? {}), ...selected.changes },
        selectedId: selected.id,
      };
      state.lastAppliedAt = new Date().toISOString();
      if (autoApply) {
        report.backupFile = await saveBackup(strategy, report);
        await save(selected.strategy);
      }
    }
    state.attempts.push({ at: new Date().toISOString(), ...report });
    state.attempts = state.attempts.slice(-30);
    await persist(state);
    return report;
  } catch (error) {
    const report = { status: 'failed', ...reportBase, suspectedGroups: suspects, error: error.message };
    state.attempts.push({ at: new Date().toISOString(), ...report });
    state.attempts = state.attempts.slice(-30);
    await persist(state);
    return report;
  }
}

export function formatAutoRetuneReport(report) {
  const title = `🧪 TỰ KIỂM CHỨNG SAU ${report.streak} SL LIÊN TIẾP`;
  const groups = (report.suspectedGroups ?? []).slice(0, 3)
    .map((group) => `${group.label} (${group.count} kèo, đóng góp TB ${group.averageContribution} điểm)`)
    .join(' · ');
  if (report.status === 'applied' || report.status === 'proposed') {
    const v = report.selected.validation;
    const g = report.selected.guardValidation ?? {};
    const verb = report.status === 'applied' ? 'Đã áp dụng' : 'ĐỀ XUẤT (chưa tự ghi)';
    return `${title}\nNhóm cần xem xét: ${groups || 'chưa đủ dữ liệu nhóm'}.\n`
      + `${verb}: ${report.selected.label}.\n`
      + (report.selected.because ? `Lý do: ${report.selected.because}\n` : '')
      + `Trên các cặp vừa thua: PF ${v.profitFactor}, drawdown ${v.maxDrawdownPercent}%, ${v.trades} lệnh.\n`
      + `Trên bộ canh gác khung ${report.guardInterval ?? '4h'}: PF ${g.profitFactor}, `
      + `kỳ vọng ${g.expectancyPercent}%/lệnh.\n`
      + `Thay đổi: ${Object.entries(report.selected.changes).map(([k, val]) => `${k} = ${JSON.stringify(val)}`).join(' · ')}\n`
      + (report.status === 'applied'
        ? (report.backupFile
          ? 'Cấu hình cũ đã được sao lưu trong database trước khi thay đổi.'
          : 'Thay đổi đã được lưu vào state và sẽ có hiệu lực từ lượt quét sau.')
        : 'Dùng lệnh quản trị cấu hình để áp dụng đề xuất vào database.');
  }
  if (report.status === 'no-safe-change') {
    return `${title}\nNhóm cần xem xét: ${groups || 'chưa đủ dữ liệu nhóm'}.\n`
      + 'Đã kiểm chứng các phương án nới SL / bỏ bám cấu trúc / kéo TP1 gần lại nhưng chưa phương án nào '
      + 'vừa cải thiện các cặp vừa thua vừa giữ được bộ canh gác. Giữ nguyên để tránh tối ưu theo nhiễu.';
  }
  if (report.status === 'cooldown') {
    return `${title}\nĐang trong thời gian chờ sau lần tinh chỉnh trước; bot chỉ ghi nhận thêm dữ liệu, chưa sửa tiếp.`;
  }
  if (report.status === 'failed') {
    return `${title}\nKhông thể hoàn tất kiểm chứng: ${report.error}. Giữ nguyên cấu hình.`;
  }
  return null;
}
