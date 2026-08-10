// Tự kiểm chứng sau chuỗi SL. Module này chỉ chạy ở Node vì lưu nhật ký local,
// tải dữ liệu lịch sử và có thể ghi lại strategy.json sau khi đã qua điều kiện an toàn.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, saveStrategy } from '../config.js';
import { fetchKlinesHistory } from '../data/binance.js';
import { closedCandles } from './engine.js';
import { backtest } from '../backtest.js';

const STATE_FILE = path.join(DATA_DIR, 'auto-retune.json');
const BACKUP_DIR = path.join(DATA_DIR, 'strategy-backups');

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
  return { trades: [], attempts: [], lastHandledTriggerId: null, lastAppliedAt: null };
}

export async function readAutoRetuneState() {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    return {
      ...emptyState(),
      ...(parsed && typeof parsed === 'object' ? parsed : {}),
      trades: Array.isArray(parsed?.trades) ? parsed.trades : [],
      attempts: Array.isArray(parsed?.attempts) ? parsed.attempts : [],
    };
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    throw error;
  }
}

async function saveState(state) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/** Rà soát định kỳ dùng chung file trạng thái này nên cần ghi được từ ngoài. */
export { saveState as saveAutoRetuneState };

/**
 * Cửa tạm dừng sau khi dính SL: KHÔNG mở kèo mới cho tới mốc này.
 *
 * Chỉ chặn việc MỞ kèo. Phần theo dõi kèo đang chạy — chạm TP, chạm SL, hết hạn
 * — vẫn phải làm bình thường; dừng nó lại thì kèo đang mở mất người canh, nguy
 * hiểm hơn hẳn cái mà cửa này định phòng.
 *
 * Trạng thái nằm chung `auto-retune.json` vì đó là file DUY NHẤT vừa được đồng
 * bộ về Trading-state vừa được vòng quét ghi. Thêm file mới sẽ không được runner
 * khôi phục và cửa sẽ mất sau mỗi lượt.
 */
export async function setLearningPause(minutes, { now = Date.now(), reason = null } = {}) {
  const span = Math.max(0, Number(minutes) || 0);
  if (!span) return null;
  const state = await readAutoRetuneState();
  const until = new Date(now + span * 60e3).toISOString();
  state.learning = { until, setAt: new Date(now).toISOString(), minutes: span, reason };
  await saveState(state);
  return state.learning;
}

export function learningPauseLeftMs(state, now = Date.now()) {
  const until = Date.parse(state?.learning?.until ?? '');
  return Number.isFinite(until) ? Math.max(0, until - now) : 0;
}

/** Chỉ lưu số liệu tại thời điểm call để sau này không suy diễn từ dữ liệu tương lai. */
export function buildCallEvidence(snapshot, setup) {
  const groups = Object.fromEntries(Object.entries(snapshot.rules?.breakdown ?? {}).map(([name, group]) => [name, {
    score: group.score ?? null,
    contributionPct: group.contributionPct ?? null,
    skipped: Boolean(group.skipped),
  }]));
  return {
    side: setup.side,
    score: snapshot.combined?.score ?? null,
    consensusPercent: snapshot.rules?.consensus?.percent ?? null,
    riskPercent: setup.riskPercent ?? snapshot.levels?.riskPercent ?? null,
    cvdSlope: snapshot.indicators?.cvdSlope ?? null,
    volumeRatio: snapshot.indicators?.volumeRatio ?? null,
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
  const closedAt = snapshot?.lastClosedCandleTime ?? new Date().toISOString();
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

function candidate(strategy, id, label, changes) {
  const next = clone(strategy);
  for (const [pathString, value] of Object.entries(changes)) setPath(next, pathString, value);
  return { id, label, changes, strategy: next };
}

export function buildRetuneCandidates(strategy, cfg) {
  const quality = strategy.entryQuality ?? {};
  const risk = strategy.risk ?? {};
  const thresholds = strategy.thresholds ?? {};
  const cvd = Number(quality.minAbsCvdSlope ?? 0.03);
  const volume = Number(quality.minVolumeRatio ?? 1);
  const score = Number(thresholds.buy ?? 30);
  const sl = Number(risk.slPercent ?? 2.5);
  const stricterCvd = Math.min(Number(cfg.maxCvdSlope ?? 0.06), cvd + Number(cfg.cvdStep ?? 0.01));
  const stricterVolume = Math.min(Number(cfg.maxVolumeRatio ?? 1.3), volume + Number(cfg.volumeStep ?? 0.1));
  const stricterScore = score + Number(cfg.scoreStep ?? 5);
  const tighterSl = Math.max(Number(cfg.minSlPercent ?? 1.5), sl - Number(cfg.slPercentStep ?? 0.25));

  const all = [
    candidate(strategy, 'flow-confirmation', 'Siết xác nhận CVD và volume', {
      'entryQuality.minAbsCvdSlope': stricterCvd,
      'entryQuality.minVolumeRatio': stricterVolume,
    }),
    candidate(strategy, 'score-threshold', 'Chỉ nhận tín hiệu điểm cao hơn', {
      'thresholds.buy': stricterScore,
      'thresholds.sell': -stricterScore,
    }),
    candidate(strategy, 'flow-and-score', 'Siết đồng thời dòng tiền và điểm tín hiệu', {
      'entryQuality.minAbsCvdSlope': stricterCvd,
      'entryQuality.minVolumeRatio': stricterVolume,
      'thresholds.buy': stricterScore,
      'thresholds.sell': -stricterScore,
    }),
    candidate(strategy, 'smaller-stop', 'Giảm khoảng SL cơ sở', {
      'risk.slPercent': tighterSl,
    }),
  ];
  return all.filter((item) => Object.entries(item.changes)
    .some(([pathString, value]) => {
      const current = pathString.split('.').reduce((node, key) => node?.[key], strategy);
      return current !== value;
    }));
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
  await mkdir(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(BACKUP_DIR, `${stamp}.json`);
  await writeFile(file, `${JSON.stringify({ strategy, report }, null, 2)}\n`, 'utf8');
  return file;
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

  try {
    const candlesByPair = [];
    const wantCandles = Math.max(600, Number(cfg.backtestCandles ?? 3000));
    for (const pair of pairs) {
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
        byPair.push({
          key: pair.key,
          train,
          validation,
          passes: passesRiskCheck(baseline.train, train, cfg) && passesRiskCheck(baseline.validation, validation, cfg),
        });
      }
      evaluated.push({
        id: item.id,
        label: item.label,
        changes: item.changes,
        strategy: item.strategy,
        byPair,
        passes: byPair.every((row) => row.passes),
        validation: averageMetrics(byPair.map((row) => row.validation)),
      });
    }

    const accepted = evaluated.filter((item) => item.passes).sort((a, b) => (
      (a.validation.maxDrawdownPercent - b.validation.maxDrawdownPercent)
      || (b.validation.profitFactor - a.validation.profitFactor)
      || (b.validation.expectancyPercent - a.validation.expectancyPercent)
    ));
    const selected = accepted[0] ?? null;
    const report = {
      status: selected ? 'applied' : 'no-safe-change',
      ...reportBase,
      suspectedGroups: suspects,
      pairs: baselineByPair,
      candidates: evaluated.map(({ strategy: unused, ...item }) => item),
      selected: selected ? {
        id: selected.id,
        label: selected.label,
        changes: selected.changes,
        validation: selected.validation,
      } : null,
    };
    if (selected) {
      report.backupFile = await saveBackup(strategy, report);
      await save(selected.strategy);
      state.lastAppliedAt = new Date().toISOString();
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
  if (report.status === 'applied') {
    const v = report.selected.validation;
    return `${title}\nNhóm cần xem xét: ${groups || 'chưa đủ dữ liệu nhóm'}.\n`
      + `Đã áp dụng: ${report.selected.label}.\n`
      + `Kiểm chứng mới nhất: PF ${v.profitFactor}, drawdown ${v.maxDrawdownPercent}%, ${v.trades} lệnh.\n`
      + 'Cấu hình cũ đã được sao lưu cục bộ trước khi thay đổi.';
  }
  if (report.status === 'no-safe-change') {
    return `${title}\nNhóm cần xem xét: ${groups || 'chưa đủ dữ liệu nhóm'}.\n`
      + 'Đã kiểm chứng các cấu hình nghiêm ngặt hơn nhưng chưa có cấu hình nào vừa dương vừa giảm drawdown. Giữ nguyên để tránh tối ưu theo nhiễu.';
  }
  if (report.status === 'cooldown') {
    return `${title}\nĐang trong thời gian chờ sau lần tinh chỉnh trước; bot chỉ ghi nhận thêm dữ liệu, chưa sửa tiếp.`;
  }
  if (report.status === 'failed') {
    return `${title}\nKhông thể hoàn tất kiểm chứng: ${report.error}. Giữ nguyên cấu hình.`;
  }
  return null;
}
