// Chuyển chỉ báo thành vector đặc trưng cho model ML.
// Nguyên tắc: mọi feature phải "dừng" (stationary) — tức là tỉ lệ/chuẩn hoá,
// KHÔNG dùng giá tuyệt đối, vì giá BTC năm 2020 và 2026 không cùng thang đo.
//
// Bộ feature này chỉ dựng từ những gì còn lại sau khi hệ thống bỏ các chỉ báo giá
// thuần: volume, CVD, hành động giá thuần (returns + hình nến) và thời gian.
// Order book, OI và funding rate KHÔNG vào đây được: API chỉ trả giá trị hiện tại
// (OI có 14 kỳ 4h), không có chuỗi lịch sử theo từng nến để gán nhãn.

export const FEATURE_NAMES = [
  'ret1', 'ret3', 'ret5', 'ret10', 'ret20',
  'volZ', 'volRatio',
  'cvdDeltaNorm', 'cvdSlope', 'cvdSlopeChange',
  'rangePos', 'bodyRatio', 'upperWick', 'lowerWick',
  'hourOfDay', 'dayOfWeek',
];

/** Số nến warm-up tối thiểu: ret20, volumeAvg 20, cvdSlope 20 + 5 nến để so độ dốc. */
export const WARMUP = 60;

const safeDiv = (a, b) => (b === 0 || b == null || a == null || !Number.isFinite(b) ? 0 : a / b);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fin = (v) => (Number.isFinite(v) ? v : 0);

/**
 * Vector đặc trưng tại nến index i (chỉ dùng dữ liệu <= i, không nhìn tương lai).
 * Trả về null nếu chưa đủ dữ liệu warm-up.
 */
export function featureVector(candles, ind, i) {
  if (i < WARMUP) return null;
  const c = candles[i];
  const close = c.close;
  if (!close) return null;

  const need = [ind.volumeAvg[i], ind.cvd[i], ind.cvdDelta[i], ind.cvdSlope[i]];
  if (need.some((v) => v == null)) return null;

  const ret = (n) => safeDiv(close - candles[i - n].close, candles[i - n].close) * 100;

  // Volume z-score trên 50 nến
  const volWin = [];
  for (let j = Math.max(0, i - 49); j <= i; j++) volWin.push(candles[j].volume);
  const volMean = volWin.reduce((a, b) => a + b, 0) / volWin.length;
  const volSd = Math.sqrt(volWin.reduce((s, v) => s + (v - volMean) ** 2, 0) / volWin.length);

  // Delta của nến hiện tại so với chính volume nến đó -> [-1, 1]
  const cvdDeltaNorm = clamp(safeDiv(ind.cvdDelta[i], c.volume), -1, 1);

  // Độ dốc CVD đang mạnh lên hay yếu đi
  const slopePrev = ind.cvdSlope[i - 5];
  const cvdSlopeChange = slopePrev == null ? 0 : ind.cvdSlope[i] - slopePrev;

  // Vị trí giá trong range 50 nến
  let hh = -Infinity;
  let ll = Infinity;
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
    safeDiv(c.volume - volMean, volSd),
    safeDiv(c.volume, ind.volumeAvg[i]),
    cvdDeltaNorm,
    clamp(ind.cvdSlope[i], -1, 1),
    clamp(cvdSlopeChange, -2, 2),
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
