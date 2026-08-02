// So khớp mẫu hình giá hiện tại với các đoạn đã xảy ra trong quá khứ.
// Module thuần JavaScript để chạy được ở cả Node lẫn browser.
//
// Mẫu hình không phải là dự báo độc lập: chỉ trả điểm khi các lần giống nhau
// trong quá khứ có diễn biến phía sau đủ đồng thuận theo một hướng.

const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

function monthsAgo(now, months) {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.getTime();
}

/** Số nến cần tải để phủ tối đa số tháng cấu hình, cộng phần đệm cho so khớp. */
export function historicalPatternCandleCount(intervalMs, cfg = {}, now = Date.now()) {
  if (!intervalMs) return 0;
  const maxMonths = Math.max(1, Math.min(6, Math.trunc(cfg.maxMonths ?? 6)));
  const lookback = Math.max(8, Math.trunc(cfg.lookbackBars ?? 24));
  const forward = Math.max(1, Math.trunc(cfg.futureBars ?? 12));
  return Math.ceil((now - monthsAgo(now, maxMonths)) / intervalMs) + lookback + forward + 2;
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
  if (!(aBase > 0) || !(bBase > 0)) return -1;

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

function unavailable(reason, extra = {}) {
  return {
    available: false,
    score: 0,
    side: 'none',
    reasons: [reason],
    ...extra,
  };
}

/**
 * So khớp đoạn `lookbackBars` mới nhất với lịch sử trước nó.
 *
 * `endIndex` giúp backtest đánh giá đúng tại nến i: mọi phần "phía sau" của
 * một mẫu cũ đều phải kết thúc trước đoạn hiện tại, nên không look-ahead.
 */
export function analyzeHistoricalPattern(candles, cfg = {}, { endIndex = candles.length - 1 } = {}) {
  if (cfg.enabled === false) return unavailable('So khớp mẫu hình lịch sử đang tắt');

  const lookbackBars = Math.max(8, Math.trunc(cfg.lookbackBars ?? 24));
  const futureBars = Math.max(1, Math.trunc(cfg.futureBars ?? 12));
  const maxMonths = Math.max(1, Math.min(6, Math.trunc(cfg.maxMonths ?? 6)));
  const requiredHistoryMonths = Math.max(
    1,
    Math.min(maxMonths, Math.trunc(cfg.requiredHistoryMonths ?? maxMonths)),
  );
  const minSimilarity = clamp(Number(cfg.minSimilarity ?? 0.82));
  const topMatches = Math.max(1, Math.min(10, Math.trunc(cfg.topMatches ?? 5)));
  const minMatches = Math.max(1, Math.min(topMatches, Math.trunc(cfg.minMatches ?? 3)));
  const minAgreement = clamp(Number(cfg.minDirectionalAgreement ?? 0.6));
  const minMovePct = Math.max(0.01, Number(cfg.minForwardMovePct ?? 0.75));
  const candidateStep = Math.max(1, Math.trunc(cfg.candidateStepBars ?? 3));
  const currentStart = endIndex - lookbackBars + 1;

  if (currentStart < lookbackBars + futureBars) {
    return unavailable(`Chưa đủ nến để so mẫu ${lookbackBars} nến và kiểm tra ${futureBars} nến sau đó`);
  }

  const asOf = candles[endIndex]?.closeTime ?? candles[endIndex]?.openTime ?? Date.now();
  const cutoff = monthsAgo(asOf, maxMonths);
  const requiredFrom = monthsAgo(asOf, requiredHistoryMonths);
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
  let compared = 0;
  for (let end = lookbackBars - 1; end + futureBars < currentStart; end += candidateStep) {
    const start = end - lookbackBars + 1;
    if (candles[start].openTime < dataFrom) continue;
    compared++;

    const correlation = pathCorrelation(candles, start, currentStart, lookbackBars);
    const pastRange = rangeOf(candles, start, lookbackBars);
    const amplitudeSimilarity = pastRange > 1e-6
      ? Math.min(pastRange, currentRange) / Math.max(pastRange, currentRange) : 0;
    // Hình dạng đường giá quan trọng hơn một chút, nhưng biên độ vẫn phải gần nhau.
    const similarity = clamp((((correlation + 1) / 2) * 0.7) + (amplitudeSimilarity * 0.3));
    if (similarity < minSimilarity) continue;

    const futureReturnPct = ((candles[end + futureBars].close / candles[end].close) - 1) * 100;
    candidates.push({
      start,
      end,
      similarity,
      correlation,
      amplitudeSimilarity,
      futureReturnPct,
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
    searchedFrom: new Date(dataFrom).toISOString(),
    searchedTo: new Date(asOf).toISOString(),
    coverageDays: Number(coverageDays.toFixed(1)),
    requiredHistoryMonths,
    lookbackBars,
    futureBars,
    compared,
    matched: matches.length,
    currentRangePct: currentRange * 100,
    minSimilarity,
    matches: matches.map((m) => ({
      at: new Date(candles[m.end].openTime).toISOString(),
      similarity: Number((m.similarity * 100).toFixed(1)),
      correlation: Number(m.correlation.toFixed(3)),
      amplitudeSimilarity: Number((m.amplitudeSimilarity * 100).toFixed(1)),
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
  const avgSimilarity = matches.reduce((sum, m) => sum + m.similarity, 0) / matches.length;

  if (side === 'none' || agreement < minAgreement || Math.abs(avgForwardReturnPct) < minMovePct) {
    return unavailable(
      `Có ${matches.length} mẫu giống nhưng diễn biến ${futureBars} nến sau không đủ đồng thuận — không cộng điểm`,
      {
        ...base,
        avgSimilarity: Number((avgSimilarity * 100).toFixed(1)),
        avgForwardReturnPct: Number(avgForwardReturnPct.toFixed(2)),
        agreementPercent: Number((agreement * 100).toFixed(1)),
      },
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
      `${matches.length} mẫu giá/biên độ tương tự trong ${coverageDays.toFixed(0)} ngày dữ liệu (tối đa ${maxMonths} tháng; giống TB ${(avgSimilarity * 100).toFixed(0)}%)`,
      `${agreeing}/${matches.length} mẫu sau ${futureBars} nến đi ${direction}; trung bình ${avgForwardReturnPct >= 0 ? '+' : ''}${avgForwardReturnPct.toFixed(2)}%`,
    ],
    ...base,
    avgSimilarity: Number((avgSimilarity * 100).toFixed(1)),
    avgForwardReturnPct: Number(avgForwardReturnPct.toFixed(2)),
    agreementPercent: Number((agreement * 100).toFixed(1)),
  };
}
