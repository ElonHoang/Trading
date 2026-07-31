// Chuyển chỉ báo thành vector đặc trưng cho model ML.
// Nguyên tắc: mọi feature phải "dừng" (stationary) — tức là tỉ lệ/chuẩn hoá,
// KHÔNG dùng giá tuyệt đối, vì giá BTC năm 2020 và 2026 không cùng thang đo.

export const FEATURE_NAMES = [
  'ret1', 'ret3', 'ret5', 'ret10', 'ret20',
  'rsi', 'rsiSlope',
  'macdHistNorm', 'macdLineNorm', 'macdCrossAge',
  'emaFastRatio', 'emaMidRatio', 'emaSlowRatio', 'emaFastMidSpread',
  'bbPercentB', 'bbWidth',
  'atrPct', 'atrRatio',
  'adx', 'diSpread',
  'stochK', 'stochKD',
  'volZ', 'volRatio', 'obvSlope',
  'vwapRatio', 'rangePos', 'bodyRatio', 'upperWick', 'lowerWick',
  'hourOfDay', 'dayOfWeek',
];

const safeDiv = (a, b) => (b === 0 || b == null || a == null || !Number.isFinite(b) ? 0 : a / b);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fin = (v) => (Number.isFinite(v) ? v : 0);

/**
 * Vector đặc trưng tại nến index i (chỉ dùng dữ liệu <= i, không nhìn tương lai).
 * Trả về null nếu chưa đủ dữ liệu warm-up.
 */
export function featureVector(candles, ind, i) {
  if (i < 205) return null; // cần đủ cho EMA200 + slope
  const c = candles[i];
  const close = c.close;
  if (!close) return null;

  const need = [ind.rsi[i], ind.macdHist[i], ind.emaFast[i], ind.emaMid[i], ind.emaSlow[i],
    ind.bbUpper[i], ind.bbLower[i], ind.atr[i], ind.adx[i], ind.stochK[i], ind.volumeAvg[i]];
  if (need.some((v) => v == null)) return null;

  const ret = (n) => safeDiv(close - candles[i - n].close, candles[i - n].close) * 100;

  // MACD cross age: bao nhiêu nến kể từ lần histogram đổi dấu (chuẩn hoá về [-1,1])
  let crossAge = 0;
  const sgn = Math.sign(ind.macdHist[i]);
  for (let j = i - 1; j >= Math.max(0, i - 30); j--) {
    if (ind.macdHist[j] == null || Math.sign(ind.macdHist[j]) !== sgn) break;
    crossAge++;
  }

  const bbRange = ind.bbUpper[i] - ind.bbLower[i];
  const percentB = bbRange > 0 ? (close - ind.bbLower[i]) / bbRange : 0.5;

  // ATR hiện tại so với ATR trung bình 50 nến -> đo mở rộng/co hẹp biến động
  let atrAvg = 0, atrCount = 0;
  for (let j = i - 49; j <= i; j++) {
    if (j >= 0 && ind.atr[j] != null) { atrAvg += ind.atr[j]; atrCount++; }
  }
  atrAvg = atrCount ? atrAvg / atrCount : ind.atr[i];

  // Volume z-score trên 50 nến
  const volWin = [];
  for (let j = Math.max(0, i - 49); j <= i; j++) volWin.push(candles[j].volume);
  const volMean = volWin.reduce((a, b) => a + b, 0) / volWin.length;
  const volSd = Math.sqrt(volWin.reduce((s, v) => s + (v - volMean) ** 2, 0) / volWin.length);

  // OBV slope chuẩn hoá theo volume trung bình
  const obvSlope = safeDiv(ind.obv[i] - ind.obv[i - 10], Math.abs(volMean) * 10);

  // Vị trí giá trong range 50 nến
  let hh = -Infinity, ll = Infinity;
  for (let j = i - 49; j <= i; j++) {
    if (j < 0) continue;
    if (candles[j].high > hh) hh = candles[j].high;
    if (candles[j].low < ll) ll = candles[j].low;
  }
  const rangePos = hh > ll ? (close - ll) / (hh - ll) : 0.5;

  const barRange = c.high - c.low;
  const bodyRatio = safeDiv(c.close - c.open, barRange);
  const upperWick = safeDiv(c.high - Math.max(c.open, c.close), barRange);
  const lowerWick = safeDiv(Math.min(c.open, c.close) - c.low, barRange);

  const date = new Date(c.openTime);

  const v = [
    ret(1), ret(3), ret(5), ret(10), ret(20),
    ind.rsi[i] / 100,
    (ind.rsi[i] - (ind.rsi[i - 5] ?? ind.rsi[i])) / 100,
    safeDiv(ind.macdHist[i], close) * 1000,
    safeDiv(ind.macdLine[i], close) * 1000,
    clamp(crossAge / 30, 0, 1) * sgn,
    safeDiv(close - ind.emaFast[i], ind.emaFast[i]) * 100,
    safeDiv(close - ind.emaMid[i], ind.emaMid[i]) * 100,
    safeDiv(close - ind.emaSlow[i], ind.emaSlow[i]) * 100,
    safeDiv(ind.emaFast[i] - ind.emaMid[i], ind.emaMid[i]) * 100,
    clamp(percentB, -0.5, 1.5),
    safeDiv(bbRange, ind.bbMid[i]) * 100,
    safeDiv(ind.atr[i], close) * 100,
    safeDiv(ind.atr[i], atrAvg),
    ind.adx[i] / 100,
    safeDiv((ind.plusDI[i] ?? 0) - (ind.minusDI[i] ?? 0), 100),
    ind.stochK[i] / 100,
    safeDiv((ind.stochK[i] ?? 0) - (ind.stochD[i] ?? 0), 100),
    safeDiv(candles[i].volume - volMean, volSd),
    safeDiv(candles[i].volume, ind.volumeAvg[i]),
    obvSlope,
    ind.vwap[i] != null ? safeDiv(close - ind.vwap[i], ind.vwap[i]) * 100 : 0,
    rangePos,
    bodyRatio, upperWick, lowerWick,
    date.getUTCHours() / 24,
    date.getUTCDay() / 7,
  ];
  return v.map(fin);
}

/** Xây toàn bộ ma trận đặc trưng. Trả về { X, indices } */
export function buildFeatureMatrix(candles, ind) {
  const X = [];
  const indices = [];
  for (let i = 0; i < candles.length; i++) {
    const v = featureVector(candles, ind, i);
    if (v) { X.push(v); indices.push(i); }
  }
  return { X, indices };
}
