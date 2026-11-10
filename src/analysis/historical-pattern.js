// So khớp mẫu hình giá hiện tại với các đoạn đã xảy ra trong quá khứ.
// Module thuần JavaScript để chạy được ở cả Node lẫn browser.
//
// Mẫu hình không phải là dự báo độc lập: chỉ trả điểm khi các lần giống nhau
// trong quá khứ có diễn biến phía sau đủ đồng thuận theo một hướng.

const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const numberOr = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Lùi đúng theo tháng lịch UTC, kể cả cuối tháng (31/08 - 6 tháng = 28/02,
 * không bị Date#setUTCMonth tràn sang tháng kế tiếp).
 */
export function calendarMonthsAgo(now, months) {
  const d = new Date(now);
  const originalDay = d.getUTCDate();
  const count = Math.max(0, Math.trunc(numberOr(months, 0)));
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - count);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(originalDay, lastDay));
  return d.getTime();
}

/** Số nến cần tải để phủ tối đa số tháng cấu hình, cộng phần đệm cho so khớp. */
export function historicalPatternCandleCount(intervalMs, cfg = {}, now = Date.now()) {
  if (!intervalMs) return 0;
  const maxMonths = Math.max(1, Math.min(6, Math.trunc(numberOr(cfg.maxMonths, 6))));
  const lookback = Math.max(8, Math.trunc(numberOr(cfg.lookbackBars, 24)));
  const forward = Math.max(1, Math.trunc(numberOr(cfg.futureBars, 12)));
  return Math.ceil((now - calendarMonthsAgo(now, maxMonths)) / intervalMs) + lookback + forward + 2;
}

const finitePositive = (v) => Number.isFinite(v) && v > 0;

function validCandle(candle) {
  return candle
    && Number.isFinite(candle.openTime)
    && finitePositive(candle.open)
    && finitePositive(candle.high)
    && finitePositive(candle.low)
    && finitePositive(candle.close)
    && candle.high >= candle.low;
}

function validWindow(candles, start, bars) {
  if (start < 0 || start + bars > candles.length) return false;
  for (let i = start; i < start + bars; i++) {
    if (!validCandle(candles[i])) return false;
    if (i > start && candles[i].openTime <= candles[i - 1].openTime) return false;
  }
  return true;
}

function rangeOf(candles, start, bars) {
  let high = -Infinity;
  let low = Infinity;
  for (let i = start; i < start + bars; i++) {
    high = Math.max(high, candles[i].high);
    low = Math.min(low, candles[i].low);
  }
  return low > 0 && high >= low ? (high / low) - 1 : 0;
}

/** Tương quan của đường close đã chuẩn hoá theo giá mở đầu mỗi đoạn. */
function pathCorrelation(candles, aStart, bStart, bars) {
  const aBase = candles[aStart].close;
  const bBase = candles[bStart].close;
  if (!finitePositive(aBase) || !finitePositive(bBase)) return -1;

  let sumA = 0;
  let sumB = 0;
  for (let k = 0; k < bars; k++) {
    sumA += Math.log(candles[aStart + k].close / aBase);
    sumB += Math.log(candles[bStart + k].close / bBase);
  }
  const meanA = sumA / bars;
  const meanB = sumB / bars;

  let numerator = 0;
  let denomA = 0;
  let denomB = 0;
  for (let k = 0; k < bars; k++) {
    const da = Math.log(candles[aStart + k].close / aBase) - meanA;
    const db = Math.log(candles[bStart + k].close / bBase) - meanB;
    numerator += da * db;
    denomA += da * da;
    denomB += db * db;
  }
  const denom = Math.sqrt(denomA * denomB);
  // Đoạn giá phẳng không có hình dạng đủ rõ để dùng làm mẫu.
  return denom > 1e-12 ? clamp(numerator / denom, -1, 1) : -1;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = clamp(p) * (sorted.length - 1);
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + ((sorted[hi] - sorted[lo]) * (at - lo));
}

/**
 * Đo sai số tương đối của từng nến sau khi chuẩn hoá mỗi đoạn theo close đầu.
 *
 * Sai số dùng log OHLC và chia cho biên độ lớn hơn của hai cửa sổ. Vì thế giá
 * BTC ở 100.000 và DOGE ở 0,10 vẫn được so theo hình dạng tương đối; một wick
 * lệch mạnh cũng không bị che đi bởi tương quan close cao.
 */
export function compareRelativePaths(
  candles,
  aStart,
  bStart,
  bars,
  { relativePathTolerance = 0.25 } = {},
) {
  if (!validWindow(candles, aStart, bars) || !validWindow(candles, bStart, bars)) return null;

  const aBase = candles[aStart].close;
  const bBase = candles[bStart].close;
  const fields = ['open', 'high', 'low', 'close'];
  const aValues = [];
  const bValues = [];
  const barErrors = [];

  for (let k = 0; k < bars; k++) {
    const a = candles[aStart + k];
    const b = candles[bStart + k];
    const errors = [];
    for (const field of fields) {
      const av = Math.log(a[field] / aBase);
      const bv = Math.log(b[field] / bBase);
      if (!Number.isFinite(av) || !Number.isFinite(bv)) return null;
      aValues.push(av);
      bValues.push(bv);
      errors.push(Math.abs(av - bv));
    }
    barErrors.push(errors.reduce((sum, value) => sum + value, 0) / errors.length);
  }

  const scale = Math.max(
    Math.max(...aValues) - Math.min(...aValues),
    Math.max(...bValues) - Math.min(...bValues),
  );
  if (!(scale > 1e-8) || !Number.isFinite(scale)) return null;

  const normalized = barErrors.map((value) => value / scale);
  const tolerance = Math.max(0.001, numberOr(relativePathTolerance, 0.25));
  return {
    relativePathError: normalized.reduce((sum, value) => sum + value, 0) / normalized.length,
    p95RelativePathError: percentile(normalized, 0.95),
    maxRelativePathError: Math.max(...normalized),
    barsWithinRelativeTolerance: normalized.filter((value) => value <= tolerance).length / normalized.length,
  };
}

function unavailable(reason, extra = {}) {
  return {
    available: false,
    score: 0,
    side: 'none',
    reasons: [reason],
    ...extra,
  };
}

const average = (values) => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length
  : null;

/**
 * So khớp đoạn `lookbackBars` mới nhất với lịch sử trước nó.
 *
 * `endIndex` giúp backtest đánh giá đúng tại nến i: mọi phần "phía sau" của
 * một mẫu cũ đều phải kết thúc trước đoạn hiện tại, nên không look-ahead.
 */
export function analyzeHistoricalPattern(candles, cfg = {}, { endIndex = candles.length - 1 } = {}) {
  if (cfg.enabled === false) return unavailable('So khớp mẫu hình lịch sử đang tắt');

  const lookbackBars = Math.max(8, Math.trunc(numberOr(cfg.lookbackBars, 24)));
  const futureBars = Math.max(1, Math.trunc(numberOr(cfg.futureBars, 12)));
  const maxMonths = Math.max(1, Math.min(6, Math.trunc(numberOr(cfg.maxMonths, 6))));
  const requiredHistoryMonths = Math.max(
    1,
    Math.min(maxMonths, Math.trunc(numberOr(cfg.requiredHistoryMonths, maxMonths))),
  );
  const minSimilarity = clamp(numberOr(cfg.minSimilarity, 0.82));
  const minPathCorrelation = clamp(numberOr(cfg.minPathCorrelation, 0.85), 0, 1);
  const minAmplitudeSimilarity = clamp(numberOr(cfg.minAmplitudeSimilarity, 0.7));
  const maxRelativePathError = Math.max(0.001, numberOr(cfg.maxRelativePathError, 0.2));
  const maxRelativePathP95Error = Math.max(
    maxRelativePathError,
    numberOr(cfg.maxRelativePathP95Error, 0.45),
  );
  const relativePathTolerance = Math.max(0.001, numberOr(cfg.relativePathTolerance, 0.25));
  const minBarsWithinRelativeTolerance = clamp(
    numberOr(cfg.minBarsWithinRelativeTolerance, 0.75),
  );
  const topMatches = Math.max(1, Math.min(10, Math.trunc(numberOr(cfg.topMatches, 5))));
  const minMatches = Math.max(1, Math.min(topMatches, Math.trunc(numberOr(cfg.minMatches, 3))));
  const minAgreement = clamp(numberOr(cfg.minDirectionalAgreement, 0.6));
  const minMovePct = Math.max(0.01, numberOr(cfg.minForwardMovePct, 0.75));
  const candidateStep = Math.max(1, Math.trunc(numberOr(cfg.candidateStepBars, 3)));
  const currentStart = endIndex - lookbackBars + 1;

  if (!Number.isInteger(endIndex) || endIndex >= candles.length || currentStart < lookbackBars + futureBars) {
    return unavailable(`Chưa đủ nến để so mẫu ${lookbackBars} nến và kiểm tra ${futureBars} nến sau đó`);
  }
  if (!validWindow(candles, currentStart, lookbackBars)) {
    return unavailable('Dữ liệu nến hiện tại không hợp lệ hoặc không liên tục — không dùng mẫu hình lịch sử');
  }

  const asOf = candles[endIndex]?.closeTime ?? candles[endIndex]?.openTime ?? Date.now();
  const cutoff = calendarMonthsAgo(asOf, maxMonths);
  const requiredFrom = calendarMonthsAgo(asOf, requiredHistoryMonths);
  const oldestCandleTime = candles[0]?.openTime ?? asOf;
  if (oldestCandleTime > requiredFrom) {
    const availableDays = Math.max(0, (asOf - oldestCandleTime) / 86400e3);
    return unavailable(
      `Chỉ có ${availableDays.toFixed(0)} ngày lịch sử, cần đủ ${requiredHistoryMonths} tháng — không dùng mẫu hình lịch sử`,
      {
        requiredHistoryMonths,
        availableHistoryDays: Number(availableDays.toFixed(1)),
      },
    );
  }
  const dataFrom = Math.max(cutoff, candles[0]?.openTime ?? cutoff);
  const coverageDays = Math.max(0, (asOf - dataFrom) / 86400e3);
  const currentRange = rangeOf(candles, currentStart, lookbackBars);
  if (currentRange < 1e-6) {
    return unavailable('Biên độ hiện tại quá hẹp, không đủ hình dạng để so với lịch sử');
  }

  const candidates = [];
  const rejected = {
    invalid: 0,
    correlation: 0,
    amplitude: 0,
    relativePathError: 0,
    p95RelativePathError: 0,
    toleranceCoverage: 0,
    similarity: 0,
  };
  let compared = 0;
  for (let end = lookbackBars - 1; end + futureBars < currentStart; end += candidateStep) {
    const start = end - lookbackBars + 1;
    if (!candles[start] || !Number.isFinite(candles[start].openTime)) {
      rejected.invalid++;
      continue;
    }
    if (candles[start].openTime < dataFrom) continue;
    compared++;

    const metrics = compareRelativePaths(candles, start, currentStart, lookbackBars, {
      relativePathTolerance,
    });
    if (!metrics) {
      rejected.invalid++;
      continue;
    }
    const correlation = pathCorrelation(candles, start, currentStart, lookbackBars);
    const pastRange = rangeOf(candles, start, lookbackBars);
    const amplitudeSimilarity = pastRange > 1e-6
      ? Math.min(pastRange, currentRange) / Math.max(pastRange, currentRange) : 0;
    // Giữ composite score để xếp hạng, nhưng tất cả cổng bên dưới đều là cổng
    // cứng. Nhờ vậy correlation cao không che được đường giá lệch xa.
    const similarity = clamp((((correlation + 1) / 2) * 0.7) + (amplitudeSimilarity * 0.3));

    let passes = true;
    if (correlation < minPathCorrelation) { rejected.correlation++; passes = false; }
    if (amplitudeSimilarity < minAmplitudeSimilarity) { rejected.amplitude++; passes = false; }
    if (metrics.relativePathError > maxRelativePathError) {
      rejected.relativePathError++;
      passes = false;
    }
    if (metrics.p95RelativePathError > maxRelativePathP95Error) {
      rejected.p95RelativePathError++;
      passes = false;
    }
    if (metrics.barsWithinRelativeTolerance < minBarsWithinRelativeTolerance) {
      rejected.toleranceCoverage++;
      passes = false;
    }
    if (similarity < minSimilarity) { rejected.similarity++; passes = false; }
    if (!passes) continue;

    const futureReturnPct = ((candles[end + futureBars].close / candles[end].close) - 1) * 100;
    if (!Number.isFinite(futureReturnPct)) {
      rejected.invalid++;
      continue;
    }
    candidates.push({
      start,
      end,
      similarity,
      correlation,
      amplitudeSimilarity,
      futureReturnPct,
      ...metrics,
    });
  }

  candidates.sort((a, b) => b.similarity - a.similarity);
  // Không lấy nhiều cửa sổ chồng lên nhau; chúng không phải các quan sát độc lập.
  const separation = Math.max(lookbackBars + futureBars, candidateStep);
  const matches = [];
  for (const candidate of candidates) {
    if (matches.every((m) => Math.abs(m.end - candidate.end) >= separation)) {
      matches.push(candidate);
      if (matches.length >= topMatches) break;
    }
  }

  const base = {
    referenceMode: 'rolling-history',
    normalization: 'log-OHLC-relative-to-first-close',
    searchedFrom: new Date(dataFrom).toISOString(),
    searchedTo: new Date(asOf).toISOString(),
    coverageDays: Number(coverageDays.toFixed(1)),
    requiredHistoryMonths,
    lookbackBars,
    futureBars,
    compared,
    rejected,
    matched: matches.length,
    currentRangePct: currentRange * 100,
    minSimilarity,
    minPathCorrelation,
    minAmplitudeSimilarity,
    maxRelativePathError,
    maxRelativePathP95Error,
    relativePathTolerance,
    minBarsWithinRelativeTolerance,
    matches: matches.map((m) => ({
      at: new Date(candles[m.end].openTime).toISOString(),
      similarity: Number((m.similarity * 100).toFixed(1)),
      correlation: Number(m.correlation.toFixed(3)),
      amplitudeSimilarity: Number((m.amplitudeSimilarity * 100).toFixed(1)),
      relativePathError: Number((m.relativePathError * 100).toFixed(1)),
      p95RelativePathError: Number((m.p95RelativePathError * 100).toFixed(1)),
      maxRelativePathError: Number((m.maxRelativePathError * 100).toFixed(1)),
      barsWithinRelativeTolerancePercent: Number((m.barsWithinRelativeTolerance * 100).toFixed(1)),
      forwardReturnPct: Number(m.futureReturnPct.toFixed(2)),
    })),
  };

  if (matches.length < minMatches) {
    return unavailable(
      `Chỉ tìm thấy ${matches.length}/${minMatches} mẫu đủ giống trong ${coverageDays.toFixed(0)} ngày dữ liệu (tối đa ${maxMonths} tháng) — không cộng điểm`,
      base,
    );
  }

  const totalWeight = matches.reduce((sum, m) => sum + m.similarity, 0);
  const avgForwardReturnPct = matches.reduce((sum, m) => (
    sum + (m.futureReturnPct * m.similarity)
  ), 0) / totalWeight;
  const side = avgForwardReturnPct > 0 ? 'long' : avgForwardReturnPct < 0 ? 'short' : 'none';
  const agreeing = matches.filter((m) => (
    side === 'long' ? m.futureReturnPct > 0 : m.futureReturnPct < 0
  )).length;
  const agreement = agreeing / matches.length;
  const avgSimilarity = average(matches.map((m) => m.similarity));
  const avgRelativePathError = average(matches.map((m) => m.relativePathError));
  const avgP95RelativePathError = average(matches.map((m) => m.p95RelativePathError));
  const avgBarsWithinRelativeTolerance = average(matches.map((m) => m.barsWithinRelativeTolerance));
  const forwardReturns = matches.map((m) => m.futureReturnPct);
  const forwardReturnStdDev = Math.sqrt(average(forwardReturns.map((value) => (
    (value - avgForwardReturnPct) ** 2
  ))));
  // "Tốt/xấu" được tính theo hướng mẫu, không theo dấu biến động giá thuần.
  // Với mẫu short, giá tăng là kết quả bất lợi; giá giảm sâu là kết quả thuận lợi.
  const worstForwardReturnPct = side === 'short'
    ? Math.max(...forwardReturns)
    : Math.min(...forwardReturns);
  const bestForwardReturnPct = side === 'short'
    ? Math.min(...forwardReturns)
    : Math.max(...forwardReturns);

  const summary = {
    ...base,
    avgSimilarity: Number((avgSimilarity * 100).toFixed(1)),
    avgRelativePathError: Number((avgRelativePathError * 100).toFixed(1)),
    avgP95RelativePathError: Number((avgP95RelativePathError * 100).toFixed(1)),
    avgBarsWithinRelativeTolerancePercent: Number((avgBarsWithinRelativeTolerance * 100).toFixed(1)),
    avgForwardReturnPct: Number(avgForwardReturnPct.toFixed(2)),
    medianForwardReturnPct: Number(percentile(forwardReturns, 0.5).toFixed(2)),
    worstForwardReturnPct: Number(worstForwardReturnPct.toFixed(2)),
    bestForwardReturnPct: Number(bestForwardReturnPct.toFixed(2)),
    forwardReturnStdDev: Number(forwardReturnStdDev.toFixed(2)),
    agreementPercent: Number((agreement * 100).toFixed(1)),
  };

  if (side === 'none' || agreement < minAgreement || Math.abs(avgForwardReturnPct) < minMovePct) {
    return unavailable(
      `Có ${matches.length} mẫu giống nhưng diễn biến ${futureBars} nến sau không đủ đồng thuận — không cộng điểm`,
      summary,
    );
  }

  // Điểm được chuẩn hoá [-1, 1]. Mẫu ít hơn topMatches bị giảm sức mạnh,
  // để 3 quan sát không có ảnh hưởng ngang với 5 quan sát độc lập.
  const strength = clamp(
    avgSimilarity
      * agreement
      * clamp(Math.abs(avgForwardReturnPct) / minMovePct)
      * (matches.length / topMatches),
  );
  const score = (side === 'long' ? 1 : -1) * strength;
  const direction = side === 'long' ? 'tăng' : 'giảm';

  return {
    available: true,
    score,
    side,
    reasons: [
      `${matches.length} mẫu OHLC tương tự trong ${coverageDays.toFixed(0)} ngày dữ liệu (giống TB ${(avgSimilarity * 100).toFixed(0)}%; sai số tương đối TB ${(avgRelativePathError * 100).toFixed(0)}%)`,
      `${agreeing}/${matches.length} mẫu sau ${futureBars} nến đi ${direction}; trung bình ${avgForwardReturnPct >= 0 ? '+' : ''}${avgForwardReturnPct.toFixed(2)}%`,
    ],
    ...summary,
  };
}
