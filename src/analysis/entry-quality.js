// Cổng chất lượng trước khi cho phép vào lệnh. Dùng được ở browser và Node.
// Chỉ dùng dữ liệu có tại nến đóng hiện tại, không dùng dữ liệu tương lai.

export function entryMarketContext(candles, index = candles.length - 1) {
  if (!candles?.length || index < 0 || !candles[index]) {
    return { priceChange20Pct: null, rangePosition50: null };
  }
  const current = candles[index];
  const from = Math.max(0, index - 19);
  let high = -Infinity;
  let low = Infinity;
  for (let i = Math.max(0, index - 49); i <= index; i++) {
    high = Math.max(high, Number(candles[i].high));
    low = Math.min(low, Number(candles[i].low));
  }
  const priceChange20Pct = Number(candles[from].close)
    ? ((Number(current.close) - Number(candles[from].close)) / Number(candles[from].close)) * 100
    : null;
  const rangePosition50 = high > low ? (Number(current.close) - low) / (high - low) : 0.5;
  return { priceChange20Pct, rangePosition50 };
}

export function evaluateEntryQuality({
  side, interval = null, cvdSlope, volumeRatio, structureScore = null,
  priceChange20Pct = null, rangePosition50 = null,
}, cfg = {}) {
  const enabled = cfg.enabled === true;
  if (!enabled || side === 'none') {
    return { enabled, met: true, reasons: [] };
  }

  const minAbsCvdSlope = Math.max(0, Number(cfg.minAbsCvdSlope ?? 0.03));
  const minVolumeRatio = Math.max(0, Number(cfg.minVolumeRatio ?? 1));
  const expectedCvdDirection = side === 'long' ? 1 : -1;
  const cvdMet = Number.isFinite(cvdSlope)
    && (cvdSlope * expectedCvdDirection) >= minAbsCvdSlope;
  const volumeMet = Number.isFinite(volumeRatio) && volumeRatio >= minVolumeRatio;
  const reasons = [];
  if (!cvdMet) {
    reasons.push(`CVD chưa đủ mạnh/cùng hướng (cần độ dốc ≥ ${(minAbsCvdSlope * 100).toFixed(1)}%)`);
  }
  if (!volumeMet) {
    reasons.push(`Volume chưa đạt ${minVolumeRatio.toFixed(1)}x trung bình`);
  }
  const intervalMet = !Array.isArray(cfg.blockedIntervals) || !cfg.blockedIntervals.includes(interval);
  if (!intervalMet) reasons.push(`Khung ${interval} đang bị tạm chặn do lỗi lặp lại`);

  const direction = side === 'long' ? 1 : -1;
  const structureMet = cfg.requireStructureAgreement !== true
    || (Number.isFinite(structureScore) && structureScore * direction >= 0);
  if (!structureMet) reasons.push('Cấu trúc hỗ trợ/kháng cự đang ngược hướng vào lệnh');

  const maxMove = Number(cfg.maxDirectionalMove20Pct);
  const moveMet = !Number.isFinite(maxMove) || maxMove <= 0 || !Number.isFinite(priceChange20Pct)
    || priceChange20Pct * direction <= maxMove;
  if (!moveMet) reasons.push(`Giá đã đi quá ${maxMove}% theo hướng lệnh trong 20 nến`);

  const avoidExtremes = cfg.avoidRangeExtremes === true;
  const maxLong = Number(cfg.maxLongRangePosition ?? 0.8);
  const minShort = Number(cfg.minShortRangePosition ?? 0.2);
  const rangeMet = !avoidExtremes || !Number.isFinite(rangePosition50)
    || (side === 'long' ? rangePosition50 <= maxLong : rangePosition50 >= minShort);
  if (!rangeMet) reasons.push('Entry nằm quá sát cực trị bất lợi của vùng giá 50 nến');

  return {
    enabled,
    met: cvdMet && volumeMet && intervalMet && structureMet && moveMet && rangeMet,
    minAbsCvdSlope,
    minVolumeRatio,
    cvdMet,
    volumeMet,
    intervalMet,
    structureMet,
    moveMet,
    rangeMet,
    reasons,
  };
}
