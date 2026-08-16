import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeHistoricalPattern,
  calendarMonthsAgo,
  compareRelativePaths,
  historicalPatternCandleCount,
} from '../src/analysis/historical-pattern.js';

const DAY = 86400e3;

function candle(openTime, close, { open = close, high = close * 1.004, low = close * 0.996 } = {}) {
  return {
    openTime,
    closeTime: openTime + DAY - 1,
    open,
    high,
    low,
    close,
    volume: 100,
    closed: true,
  };
}

function windowAt(start, base, ratios) {
  return ratios.map((ratio, index) => {
    const close = base * ratio;
    return candle(start + (index * DAY), close, {
      open: close * 0.998,
      high: close * 1.006,
      low: close * 0.994,
    });
  });
}

function appendPattern(target, start, base, ratios, forward = [1.02, 1.04]) {
  const pattern = windowAt(start, base, ratios);
  target.push(...pattern);
  const finalClose = pattern.at(-1).close;
  forward.forEach((ratio, index) => target.push(candle(
    start + ((ratios.length + index) * DAY),
    finalClose * ratio,
  )));
}

const exactCfg = {
  enabled: true,
  maxMonths: 2,
  requiredHistoryMonths: 1,
  lookbackBars: 8,
  futureBars: 2,
  minSimilarity: 0.8,
  minPathCorrelation: 0.9,
  minAmplitudeSimilarity: 0.9,
  maxRelativePathError: 0.05,
  maxRelativePathP95Error: 0.1,
  relativePathTolerance: 0.05,
  minBarsWithinRelativeTolerance: 0.9,
  topMatches: 3,
  minMatches: 3,
  minDirectionalAgreement: 0.6,
  minForwardMovePct: 0.1,
  candidateStepBars: 1,
};

function matchingHistory(forwards = [[1.02, 1.04], [1.02, 1.04], [1.02, 1.04]]) {
  const ratios = [1, 1.01, 0.99, 1.03, 1.02, 1.05, 1.04, 1.06];
  const start = Date.UTC(2026, 0, 1);
  const candles = [];
  appendPattern(candles, start, 100, ratios, forwards[0]);
  appendPattern(candles, start + (10 * DAY), 800, ratios, forwards[1]);
  appendPattern(candles, start + (20 * DAY), 12000, ratios, forwards[2]);
  candles.push(...windowAt(start + (30 * DAY), 2, ratios));
  return candles;
}

test('calendarMonthsAgo handles the end of a month without date overflow', () => {
  const august31 = Date.UTC(2026, 7, 31, 12);
  assert.equal(calendarMonthsAgo(august31, 6), Date.UTC(2026, 1, 28, 12));
});

test('relative chart comparison is invariant to absolute price scale', () => {
  const ratios = [1, 1.01, 0.99, 1.03, 1.02, 1.05, 1.04, 1.06];
  const candles = [
    ...windowAt(Date.UTC(2026, 0, 1), 100, ratios),
    ...windowAt(Date.UTC(2026, 0, 20), 10000, ratios),
  ];
  const metrics = compareRelativePaths(candles, 0, ratios.length, ratios.length, {
    relativePathTolerance: 0.01,
  });
  assert.ok(metrics);
  assert.ok(metrics.relativePathError < 1e-12);
  assert.ok(metrics.p95RelativePathError < 1e-12);
  assert.equal(metrics.barsWithinRelativeTolerance, 1);
});

test('relative path error rejects a deceptively correlated but differently sized move', () => {
  const length = 12;
  const fast = Array.from({ length }, (_, i) => 1.02 ** i);
  const slow = Array.from({ length }, (_, i) => 1.01 ** i);
  const candles = [
    ...windowAt(Date.UTC(2026, 0, 1), 100, fast),
    ...windowAt(Date.UTC(2026, 0, 20), 1000, slow),
  ];
  const metrics = compareRelativePaths(candles, 0, length, length, {
    relativePathTolerance: 0.25,
  });
  assert.ok(metrics);
  assert.ok(metrics.relativePathError > 0.2);
  assert.ok(metrics.p95RelativePathError > 0.4);
  assert.ok(metrics.barsWithinRelativeTolerance < 0.75);
});

test('matcher does not accept a high-correlation path when its relative error is too large', () => {
  const length = 8;
  const fast = Array.from({ length }, (_, i) => 1.02 ** i);
  const slow = Array.from({ length }, (_, i) => 1.01 ** i);
  const start = Date.UTC(2026, 0, 1);
  const past = windowAt(start, 100, fast);
  const future = [1.02, 1.04].map((ratio, index) => candle(
    start + ((length + index) * DAY),
    past.at(-1).close * ratio,
  ));
  // Đủ một tháng lịch sử, nhưng chỉ có một mẫu cũ: correlation của close rất
  // cao còn sai lệch tích luỹ của OHLC lại vượt cổng tương đối.
  const current = windowAt(start + (32 * DAY), 1000, slow);
  const result = analyzeHistoricalPattern([...past, ...future, ...current], {
    ...exactCfg,
    maxMonths: 2,
    requiredHistoryMonths: 1,
    topMatches: 1,
    minMatches: 1,
  });

  assert.equal(result.available, false);
  assert.equal(result.matched, 0);
  assert.ok(result.rejected.relativePathError > 0);
  assert.ok(result.rejected.p95RelativePathError > 0);
});

test('matcher accepts three exact relative OHLC analogs and reports their dispersion', () => {
  const result = analyzeHistoricalPattern(matchingHistory(), exactCfg);
  assert.equal(result.available, true);
  assert.equal(result.matched, 3);
  assert.equal(result.side, 'long');
  assert.equal(result.avgRelativePathError, 0);
  assert.equal(result.avgBarsWithinRelativeTolerancePercent, 100);
  assert.ok(result.avgForwardReturnPct > 0);
  assert.equal(result.worstForwardReturnPct > 0, true);
  assert.equal(result.matches.every((match) => match.relativePathError === 0), true);
});

test('worst and best forward outcomes are interpreted in the matched direction', () => {
  const result = analyzeHistoricalPattern(matchingHistory([
    [0.99, 0.98], [0.97, 0.96], [0.95, 0.94],
  ]), exactCfg);
  assert.equal(result.available, true);
  assert.equal(result.side, 'short');
  assert.equal(result.worstForwardReturnPct, -2);
  assert.equal(result.bestForwardReturnPct, -6);
});

test('matcher has no look-ahead beyond the specified current candle', () => {
  const candles = matchingHistory();
  const endIndex = candles.length - 1;
  const before = analyzeHistoricalPattern(candles, exactCfg, { endIndex });
  const later = [
    ...candles,
    candle(candles.at(-1).openTime + DAY, 1000000),
    candle(candles.at(-1).openTime + (2 * DAY), 0.001),
  ];
  const after = analyzeHistoricalPattern(later, exactCfg, { endIndex });
  assert.deepEqual(after, before);
});

test('matcher fails closed for insufficient history, invalid current data, and old-only candidates', () => {
  const candles = matchingHistory();
  const tooShort = analyzeHistoricalPattern(candles, { ...exactCfg, requiredHistoryMonths: 2 });
  assert.equal(tooShort.available, false);
  assert.match(tooShort.reasons[0], /cần đủ 2 tháng/);

  const invalid = matchingHistory();
  invalid.at(-1).close = 0;
  const invalidResult = analyzeHistoricalPattern(invalid, exactCfg);
  assert.equal(invalidResult.available, false);
  assert.match(invalidResult.reasons[0], /không hợp lệ/);

  const oldOnlyCandles = matchingHistory();
  // Dời riêng cửa sổ hiện tại sang tháng sau: ba mẫu giống hệt đều nằm trước
  // cutoff một tháng, còn phần lịch sử vẫn đủ dài để matcher thực sự phải lọc.
  for (let index = 30; index < oldOnlyCandles.length; index++) {
    oldOnlyCandles[index].openTime += 22 * DAY;
    oldOnlyCandles[index].closeTime += 22 * DAY;
  }
  const oldOnly = analyzeHistoricalPattern(oldOnlyCandles, {
    ...exactCfg,
    maxMonths: 1,
    requiredHistoryMonths: 1,
  });
  assert.equal(oldOnly.available, false);
  assert.equal(oldOnly.matched, 0);
});

test('historical candle count reserves more history at shorter timeframes', () => {
  const now = Date.UTC(2026, 7, 13);
  const fourHour = historicalPatternCandleCount(4 * 3600e3, { maxMonths: 6 }, now);
  const oneHour = historicalPatternCandleCount(3600e3, { maxMonths: 6 }, now);
  assert.ok(oneHour > fourHour * 3);
  assert.ok(fourHour > 1000);
});
