import assert from 'node:assert/strict';
import test from 'node:test';

import { applyActiveTuning } from '../src/analysis/auto-retune.js';
import {
  buildReviewCandidates, compareDailyPerformance, formatDailyReview, runDailyReview, summarizeCalls,
} from '../src/analysis/daily-review.js';
import { recordDailyLossLog } from '../src/analysis/daily-loss-log.js';
import { checkCall } from '../src/data/open-calls.js';
import { evaluateEntryQuality } from '../src/analysis/entry-quality.js';
import { buildLearningRecord } from '../src/analysis/learning-log.js';
import { KINDS, replayStoppedCall, summarizePostMortem } from '../src/analysis/post-mortem.js';
import { buildLimitPlan } from '../src/analysis/setup.js';
import { buildCaption } from '../src/telegram/caption.js';

const now = Date.parse('2026-08-12T01:00:00.000Z');

function trade(date, status, { interval = '4h', side = 'long', index = 0 } = {}) {
  const entry = 100;
  return {
    id: `${date}-${status}-${index}`,
    symbol: 'BTCUSDT', interval, side, entry, stopLoss: 96,
    closedAt: `${date}T05:00:00.000Z`,
    targets: [{ label: 'TP1', price: 103 }, { label: 'TP2', price: 106 }],
    result: {
      status,
      hitTps: status === 'target' ? ['TP1', 'TP2'] : status === 'breakeven' ? ['TP1'] : [],
      lastPrice: status === 'target' ? 106 : status === 'breakeven' ? 100 : 96,
    },
    evidence: { score: 40, consensusPercent: 70, riskPercent: 4, cvdSlope: 0.05, volumeRatio: 1.2 },
  };
}

function day(date, losses, wins) {
  return [
    ...Array.from({ length: losses }, (_, index) => trade(date, 'stopped', { index })),
    ...Array.from({ length: wins }, (_, index) => trade(date, 'target', { index: losses + index })),
  ];
}

test('compareDailyPerformance detects a repeated multi-day SL problem in UTC+7', () => {
  const trades = [
    ...day('2026-08-08', 2, 1),
    ...day('2026-08-09', 1, 2),
    ...day('2026-08-10', 2, 1),
  ];
  const result = compareDailyPerformance(trades, {
    windowMode: 'calendar-day', dayOffsetHours: 7, dayOffsetDays: -1,
    comparisonDays: 7, minClosedTradesPerDay: 3, minBadDays: 2,
    targetLossRatePercent: 30,
  }, now);

  assert.equal(result.days.length, 7);
  assert.equal(result.days.at(-1).date, '2026-08-11');
  assert.equal(result.aggregate.closed, 9);
  assert.equal(result.badDays, 3);
  assert.equal(result.repeatedIssue, true);
  assert.equal(result.persistent.byInterval[0].key, '4h');
});

test('applyActiveTuning overlays persisted changes without mutating the base strategy', () => {
  const base = { risk: { slPercent: 4, takeProfitR: [0.75, 1.5] } };
  const effective = applyActiveTuning(base, {
    activeTuning: { changes: { 'risk.slPercent': 4.5 } },
  });
  assert.equal(effective.risk.slPercent, 4.5);
  assert.equal(base.risk.slPercent, 4);
});

test('entry quality rejects a wrong-structure, overextended entry at a range extreme', () => {
  const result = evaluateEntryQuality({
    side: 'long', interval: '4h', cvdSlope: 0.05, volumeRatio: 1.2,
    structureScore: -0.4, priceChange20Pct: 5, rangePosition50: 0.9,
  }, {
    enabled: true, minAbsCvdSlope: 0.03, minVolumeRatio: 1,
    requireStructureAgreement: true, maxDirectionalMove20Pct: 4,
    avoidRangeExtremes: true, maxLongRangePosition: 0.8,
  });
  assert.equal(result.met, false);
  assert.equal(result.structureMet, false);
  assert.equal(result.moveMet, false);
  assert.equal(result.rangeMet, false);
});

test('wrong-way post-mortem creates evidence-based entry candidates instead of widening SL', () => {
  const strategy = {
    risk: { slPercent: 4, takeProfitR: [0.75, 1.5], preferSrLevels: false },
    entryQuality: {
      enabled: true, minAbsCvdSlope: 0.03, minVolumeRatio: 1,
      requireStructureAgreement: false, avoidRangeExtremes: false,
    },
  };
  const row = (index) => ({
    kind: 'sai-huong', side: 'long', tradeId: `loss-${index}`,
    evidence: {
      cvdSlope: 0.035, volumeRatio: 1.05, priceChange20Pct: 5, rangePosition50: 0.9,
      groups: { structure: { score: -0.4 } },
    },
  });
  const result = buildReviewCandidates(strategy, {
    minEntryCauseSamples: 3, entryCauseSharePercent: 60,
  }, { byInterval: [] }, {
    verdict: { id: 'sai-huong' }, rows: [row(1), row(2), row(3)],
  });
  const ids = result.candidates.map((candidate) => candidate.id);
  assert.equal(ids.includes('wider-stop'), false);
  assert.equal(ids.includes('entry-structure-agreement'), true);
  assert.equal(ids.includes('entry-no-chasing'), true);
  assert.equal(ids.includes('entry-avoid-range-extremes'), true);
});

test('swept-loss post-mortem keeps the full wider-stop ladder', () => {
  const result = buildReviewCandidates({
    risk: { slPercent: 4, takeProfitR: [0.75, 1.5], preferSrLevels: false },
  }, {
    slPercentStep: 0.5, maxSlPercent: 6,
  }, { byInterval: [] }, {
    verdict: { id: 'noi-sl' }, rows: [],
  });
  assert.deepEqual(result.candidates.map((candidate) => candidate.changes['risk.slPercent']), [4.5, 5, 5.5, 6]);
});

test('post-mortem does not call a much later TP1 recovery a stop sweep', () => {
  const trade = {
    id: 'late-recovery', symbol: 'TESTUSDT', interval: '1h', side: 'long',
    entry: 100, stopLoss: 96, targets: [{ price: 103 }], openedAtCandle: 0,
  };
  const candle = (openTime, low, high) => ({ openTime, low, high });
  const candles = [
    candle(1, 95, 100),
    ...Array.from({ length: 7 }, (_, i) => candle(i + 2, 94, 99)),
    candle(9, 98, 104),
  ];

  const result = replayStoppedCall(trade, candles, {
    sweepRecoveryBars: 6, minBarsAfterStop: 6, widerSlMultiple: 1.5,
  });

  assert.equal(result.reachedTp1After, true);
  assert.equal(result.barsToTp1AfterSl, 8);
  assert.equal(result.reachedTp1Soon, false);
  assert.equal(result.widerStopSaves, false);
  assert.equal(result.kind, KINDS.wrongWay);
});

test('post-mortem requires a strict majority before choosing one fix direction', () => {
  const rows = [
    { kind: KINDS.swept, slPercent: 4, neededSlPercent: 6, barsToSl: 1 },
    { kind: KINDS.swept, slPercent: 4, neededSlPercent: 6, barsToSl: 2 },
    { kind: KINDS.wrongWay, barsToSl: 1 },
    { kind: KINDS.reversed, barsToSl: 3 },
  ];

  assert.equal(summarizePostMortem(rows).verdict.id, 'hon-hop');
});

test('daily loss logger persists only yesterday pre-TP1 stops without training', async () => {
  const yesterdayLoss = trade('2026-08-11', 'stopped', { index: 1 });
  const state = {
    trades: [
      yesterdayLoss,
      trade('2026-08-11', 'target', { index: 2 }),
      trade('2026-08-10', 'stopped', { index: 3 }),
    ],
    lossLogs: [],
  };
  let persisted = null;
  const result = await recordDailyLossLog({
    strategy: {
      dailyReview: { dayOffsetHours: 7 },
      alerts: { maxHoldBars: 96 },
      learning: { dailyLossLogHistoryDays: 90 },
    },
    state,
    now,
    deps: {
      postMortemLosses: async (losses) => {
        assert.deepEqual(losses.map((item) => item.id), [yesterdayLoss.id]);
        return {
          decided: 1,
          counts: { 'sai-huong': 1 },
          verdict: { id: 'sai-huong', text: 'Sai hướng.' },
          rows: [{ ...yesterdayLoss, tradeId: yesterdayLoss.id, kind: 'sai-huong', barsToSl: 2 }],
        };
      },
      saveState: async (next) => { persisted = structuredClone(next); },
    },
  });

  assert.equal(result.status, 'logged');
  assert.equal(result.log.date, '2026-08-11');
  assert.equal(result.log.totalLosses, 1);
  assert.equal(result.log.losses[0].cause, 'sai-huong');
  assert.equal(persisted.lossLogs.length, 1);
  assert.equal(persisted.lossLogWeek, '2026-08-10');
  assert.equal(persisted.activeTuning, undefined);
});

test('daily loss logger clears the previous week on Monday in Vietnam', async () => {
  const monday = Date.parse('2026-08-17T03:00:00.000Z');
  const state = {
    trades: [trade('2026-08-16', 'stopped', { index: 1 })],
    lossLogWeek: '2026-08-10',
    lossLogs: [{ date: '2026-08-15', totalLosses: 2, losses: [] }],
  };
  let persisted = null;
  await recordDailyLossLog({
    strategy: {
      dailyReview: { dayOffsetHours: 7 },
      learning: { dailyLossLogHistoryDays: 7 },
    },
    state,
    now: monday,
    deps: {
      force: true,
      postMortemLosses: async (losses) => ({
        decided: losses.length, counts: { 'sai-huong': losses.length },
        verdict: { id: 'khong-du-mau' },
        rows: losses.map((item) => ({ ...item, tradeId: item.id, kind: 'sai-huong' })),
      }),
      saveState: async (next) => { persisted = structuredClone(next); },
    },
  });

  assert.equal(persisted.lossLogWeek, '2026-08-17');
  assert.deepEqual(persisted.lossLogs.map((log) => log.date), ['2026-08-16']);
});

test('review-only mode never runs backtest or changes tuning', async () => {
  const state = { trades: day('2026-08-11', 1, 1), attempts: [], reviews: [] };
  let backtests = 0;
  let persisted = null;
  const report = await runDailyReview({
    strategy: {
      risk: { partialFraction: 0.5 },
      alerts: { maxHoldBars: 96 },
      learning: { enabled: true },
      dailyReview: {
        enabled: true, windowMode: 'calendar-day', dayOffsetHours: 7, dayOffsetDays: -1,
        comparisonDays: 7, targetLossRatePercent: 30,
      },
    },
    state,
    now,
    deps: {
      force: true,
      skipTraining: true,
      fetchRecentCandles: async () => [],
      postMortemLosses: async () => ({
        total: 1, decided: 1, counts: { 'sai-huong': 1 },
        verdict: { id: 'sai-huong' }, rows: [],
      }),
      runBacktest: async () => { backtests++; throw new Error('must not run'); },
      saveState: async (next) => { persisted = structuredClone(next); },
    },
  });

  assert.equal(report.status, 'review-only');
  assert.equal(backtests, 0);
  assert.equal(persisted.activeTuning, undefined);
});

test('daily overview is isolated to one Vietnam calendar day', async () => {
  const state = {
    trades: [
      { ...trade('2026-08-10', 'target', { index: 1 }), closedAt: '2026-08-10T16:59:59.999Z' },
      { ...trade('2026-08-10', 'target', { index: 2 }), closedAt: '2026-08-10T17:00:00.000Z' },
      { ...trade('2026-08-11', 'stopped', { index: 3 }), closedAt: '2026-08-11T16:59:59.999Z' },
      { ...trade('2026-08-11', 'target', { index: 4 }), closedAt: '2026-08-11T17:00:00.000Z' },
    ],
    attempts: [], reviews: [],
  };
  const strategy = {
    risk: { partialFraction: 0.5 },
    alerts: { maxHoldBars: 96 },
    learning: { enabled: false },
    dailyReview: {
      enabled: true,
      // Dù cấu hình cũ có giá trị khác, phần Overview vẫn phải là một ngày.
      windowMode: 'all', dayOffsetHours: 7, dayOffsetDays: -1,
    },
  };
  const deps = {
    force: true, skipTraining: true,
    fetchRecentCandles: async () => [],
    saveState: async () => {},
  };

  const report = await runDailyReview({ strategy, state, now, deps });
  assert.equal(report.window.mode, 'calendar-day');
  assert.equal(report.window.since, '2026-08-10T17:00:00.000Z');
  assert.equal(report.window.untilMs, Date.parse('2026-08-11T17:00:00.000Z'));
  assert.deepEqual([report.summary.closed, report.summary.win, report.summary.loss], [2, 1, 1]);
  assert.equal(report.comparison.aggregate.closed, 3);
  assert.match(formatDailyReview(report), /Tổng số lệnh: <b>2<\/b>/);
  assert.match(formatDailyReview(report), /Tỉ lệ W\/L: <b>1 W - 1 L<\/b>/);

  const nextDay = await runDailyReview({
    strategy, state, now: Date.parse('2026-08-13T01:00:00.000Z'), deps,
  });
  assert.deepEqual([nextDay.summary.closed, nextDay.summary.win, nextDay.summary.loss], [1, 1, 0]);
});

test('an empty daily overview does not discard historical errors for backtest review', async () => {
  const state = {
    trades: [
      ...day('2026-08-09', 3, 0),
      ...day('2026-08-10', 3, 0),
      { ...trade('2026-08-11', 'expired', { index: 99 }), closedAt: '2026-08-11T05:00:00.000Z' },
    ],
    attempts: [], reviews: [],
  };
  const report = await runDailyReview({
    strategy: {
      risk: { partialFraction: 0.5 },
      alerts: { maxHoldBars: 96 },
      learning: { enabled: false },
      dailyReview: {
        enabled: true, windowMode: 'all', dayOffsetHours: 7, dayOffsetDays: -1,
        comparisonDays: 7, minClosedTradesPerDay: 3, minBadDays: 2,
        minClosedTrades: 3, targetLossRatePercent: 30,
      },
    },
    state,
    now,
    deps: {
      force: true,
      fetchRecentCandles: async () => [],
      saveState: async () => {},
    },
  });

  assert.equal(report.summary.rated, 0);
  assert.equal(report.comparison.aggregate.rated, 6);
  assert.equal(report.status, 'no-supported-change');
});

test('a closed 4h call uses the terminal candle end for its daily timestamp', async () => {
  const openedAt = Date.parse('2026-08-11T12:00:00.000Z');
  const terminalOpen = Date.parse('2026-08-11T16:00:00.000Z');
  const result = await checkCall({
    symbol: 'BTCUSDT', interval: '4h', side: 'long', entry: 100, stopLoss: 96,
    targets: [{ label: 'TP1', price: 103 }], openedAtCandle: openedAt,
  }, [
    { openTime: openedAt, high: 101, low: 99, close: 100 },
    { openTime: terminalOpen, high: 101, low: 95, close: 96 },
  ]);

  assert.equal(result.status, 'stopped');
  assert.equal(result.closedAt, '2026-08-11T19:59:59.999Z');
});

test('runDailyReview backtests and persists a safe fix from repeated daily losses', async () => {
  const trades = [
    ...day('2026-08-08', 2, 1),
    ...day('2026-08-09', 2, 1),
    ...day('2026-08-10', 2, 2),
    ...day('2026-08-11', 2, 1),
  ];
  const strategy = {
    risk: { slPercent: 4, takeProfitR: [0.5], preferSrLevels: false, partialFraction: 0.5 },
    alerts: { maxHoldBars: 96 }, learning: { enabled: true },
    dailyReview: {
      enabled: true, windowMode: 'calendar-day', dayOffsetHours: 7, dayOffsetDays: -1,
      comparisonDays: 7, minClosedTradesPerDay: 3, minBadDays: 2,
      minClosedTrades: 10, targetLossRatePercent: 30,
      minTradesPerSegment: 5, minSlRateDropPercent: 2, minProfitFactor: 1.05,
      guardSymbols: ['BTCUSDT'], guardInterval: '4h', backtestCandles: 600,
      trainingRatio: 0.75, runtimeApply: true, autoApply: false,
      slPercentStep: 0.5, maxSlPercent: 6, minTp1R: 0.5,
    },
  };
  const state = { trades, attempts: [], reviews: [] };
  const candles = Array.from({ length: 600 }, (_, index) => ({
    openTime: index * 14400e3, open: 100, high: 101, low: 99, close: 100, volume: 1, closed: true,
  }));
  let persisted = null;
  const report = await runDailyReview({
    strategy, state, now,
    deps: {
      force: true,
      fetchCandles: async () => candles,
      fetchRecentCandles: async () => candles.slice(-10),
      postMortemLosses: async () => ({
        total: 3, decided: 3, counts: { 'bi-quet': 3 },
        verdict: { id: 'noi-sl', text: 'SL nằm trong nhiễu.' }, rows: [],
      }),
      runBacktest: async (symbol, interval, tested) => {
        const improved = tested.risk.slPercent > 4;
        return { stats: {
          trades: 20,
          exitReasons: { stoploss: improved ? 6 : 10 },
          winRatePercent: improved ? 70 : 50,
          profitFactor: improved ? 1.3 : 1.1,
          expectancyPercent: improved ? 0.2 : 0.1,
          maxDrawdownPercent: improved ? 8 : 12,
        } };
      },
      saveState: async (next) => { persisted = structuredClone(next); },
      saveStrategy: async () => { throw new Error('runtime apply must not write strategy.json'); },
    },
  });

  assert.equal(report.status, 'applied');
  assert.equal(report.selected.id, 'wider-stop');
  assert.equal(persisted.activeTuning.changes['risk.slPercent'], 4.5);
});

test('runDailyReview applies an entry gate when replay says losses were wrong-way', async () => {
  const trades = [
    ...day('2026-08-08', 2, 1), ...day('2026-08-09', 2, 1),
    ...day('2026-08-10', 2, 1), ...day('2026-08-11', 2, 1),
  ];
  const wrongRows = trades.filter((item) => item.result.status === 'stopped').slice(0, 3).map((item) => ({
    kind: 'sai-huong', side: item.side, tradeId: item.id,
    evidence: { groups: { structure: { score: -0.5 } } },
  }));
  const strategy = {
    risk: { slPercent: 4, takeProfitR: [0.75], preferSrLevels: false, partialFraction: 0.5 },
    entryQuality: {
      enabled: true, minAbsCvdSlope: 0.03, minVolumeRatio: 1,
      requireStructureAgreement: false, avoidRangeExtremes: false,
    },
    alerts: { maxHoldBars: 96 }, learning: { enabled: true },
    dailyReview: {
      enabled: true, windowMode: 'calendar-day', dayOffsetHours: 7, dayOffsetDays: -1,
      comparisonDays: 7, minClosedTradesPerDay: 3, minBadDays: 2, minClosedTrades: 10,
      targetLossRatePercent: 30, minTradesPerSegment: 5, minSlRateDropPercent: 2,
      minProfitFactor: 1.05, guardSymbols: ['BTCUSDT'], guardInterval: '4h',
      backtestCandles: 600, trainingRatio: 0.75, runtimeApply: true, autoApply: false,
      minEntryCauseSamples: 3, entryCauseSharePercent: 60,
    },
  };
  const candles = Array.from({ length: 600 }, (_, index) => ({
    openTime: index * 14400e3, open: 100, high: 101, low: 99, close: 100, volume: 1, closed: true,
  }));
  let persisted = null;
  const report = await runDailyReview({
    strategy, state: { trades, attempts: [], reviews: [] }, now,
    deps: {
      force: true,
      fetchCandles: async () => candles,
      fetchRecentCandles: async () => candles.slice(-10),
      postMortemLosses: async () => ({
        total: wrongRows.length, decided: wrongRows.length,
        counts: { 'sai-huong': wrongRows.length },
        verdict: { id: 'sai-huong', text: 'Sai hướng.' }, rows: wrongRows,
      }),
      runBacktest: async (symbol, interval, tested) => {
        const improved = tested.entryQuality.requireStructureAgreement === true;
        return { stats: {
          trades: 20, exitReasons: { stoploss: improved ? 5 : 10 },
          winRatePercent: improved ? 75 : 50, profitFactor: improved ? 1.4 : 1.1,
          expectancyPercent: improved ? 0.25 : 0.1, maxDrawdownPercent: improved ? 7 : 12,
        } };
      },
      saveState: async (next) => { persisted = structuredClone(next); },
    },
  });

  assert.equal(report.status, 'applied');
  assert.equal(report.selected.id, 'entry-structure-agreement');
  assert.equal(persisted.activeTuning.changes['entryQuality.requireStructureAgreement'], true);
  assert.equal(persisted.activeTuning.changes['risk.slPercent'], undefined);
});

test('learning log keeps per-trade cause, evidence, candidates and active tuning', () => {
  const record = buildLearningRecord({
    status: 'applied',
    window: { since: '2026-08-11T00:00:00.000Z' },
    summary: { closed: 4, lost: 2 },
    postMortem: {
      total: 1, decided: 1, counts: { 'sai-huong': 1 },
      verdict: { id: 'sai-huong' },
      rows: [{
        tradeId: 'loss-1', symbol: 'BTCUSDT', interval: '4h', side: 'long',
        kind: 'sai-huong', barsToSl: 2, evidence: { cvdSlope: 0.035 },
      }],
    },
    candidates: [{
      id: 'entry-structure-agreement', changes: { 'entryQuality.requireStructureAgreement': true },
      passes: true,
    }],
    selected: { id: 'entry-structure-agreement' },
  }, {
    activeTuning: { changes: { 'entryQuality.requireStructureAgreement': true } },
    strategy: { entryQuality: { enabled: true }, risk: { slPercent: 4 } },
    generatedAt: '2026-08-12T01:00:00.000Z',
  });

  assert.equal(record.lossAnalysis.trades[0].cause, 'sai-huong');
  assert.equal(record.lossAnalysis.trades[0].entryEvidence.cvdSlope, 0.035);
  assert.equal(record.candidates[0].passes, true);
  assert.equal(record.decision.activeTuning.changes['entryQuality.requireStructureAgreement'], true);
});

test('limit order uses the anchored limit price, not the zone midpoint or current price', () => {
  const snapshot = {
    symbol: 'BTCUSDT', interval: '4h',
    price: { lastClose: 100, change24hPercent: 1 },
    combined: { score: 20 },
    structure: {
      support: [{ price: 99.5, touches: 3 }],
      resistance: [{ price: 103, touches: 2 }],
    },
  };
  const plan = buildLimitPlan(snapshot, {
    slPercent: 4, takeProfitR: [0.75, 1.5],
    limitOrder: {
      minDistancePercent: 0.5, maxDistancePercent: 4,
      zoneWidthR: 0.3, maxZoneFractionOfDistance: 0.5,
      fallbackPullbackPercent: 1.5, minLeanScore: 10, expiryBars: 6,
    },
  });
  const order = plan.orders[0];
  assert.equal(order.direction, 'long');
  assert.equal(order.entry, 99.5);
  assert.notEqual(order.entry, (order.zone.low + order.zone.high) / 2);
  assert.ok(order.entry < snapshot.price.lastClose);
  assert.equal(Number(order.riskPercent.toFixed(6)), 4);

  const caption = buildCaption(snapshot, {
    setup: { side: 'none', vetoed: false }, limitPlan: plan,
  });
  assert.match(caption, /Entry LIMIT \(giá đặt lệnh\): <b>99,50<\/b>/);
  assert.match(caption, /KHÔNG vào giá hiện tại/);
});

test('daily summary counts TP1+ as wins and pre-TP1 stops as losses', () => {
  const trades = [
    trade('2026-08-11', 'target', { index: 1 }),
    trade('2026-08-11', 'stopped', { index: 2 }),
    trade('2026-08-11', 'breakeven', { index: 3 }),
    trade('2026-08-11', 'expired', { index: 4 }),
    {
      ...trade('2026-08-11', 'expired', { index: 5 }),
      result: { status: 'expired', hitTps: ['TP1'], lastPrice: 102 },
    },
  ];
  const summary = summarizeCalls(trades, { capitalPerTradeUsd: 200 });
  assert.deepEqual([summary.win, summary.loss], [3, 1]);
  assert.equal(summary.closed, 5);
  assert.equal(summary.rated, 4);
  assert.equal(summary.unrated, 1);
  assert.equal(summary.expired, 2);
  assert.equal(summary.winRatePercent, 75);
  assert.equal(summary.lossRatePercent, 25);
  assert.equal(summary.pnlUsd, Number((summary.pnlPercent * 2).toFixed(2)));

  const text = formatDailyReview({
    status: 'on-target', summary, target: 30,
    window: { label: 'NGÀY 11/08/2026' }, comparison: null,
  });
  assert.match(text, /📅 <b>NGÀY 11\/08\/2026<\/b>/);
  assert.match(text, /🌟 <b>Tổng Quan Hiệu Suất<\/b>/);
  assert.match(text, /Tổng số lệnh: <b>5<\/b>/);
  assert.match(text, /Tỉ lệ W\/L: <b>3 W - 1 L<\/b>/);
  assert.match(text, /Giả định vốn vào mọi lệnh bằng nhau \(200\$\)/);
  assert.doesNotMatch(text, /Tỉ lệ thắng 75% · tỷ lệ thua 25%/);
  assert.doesNotMatch(text, /RÀ SOÁT/);
  assert.doesNotMatch(text, /Mục tiêu tỉ lệ thua/);
});
