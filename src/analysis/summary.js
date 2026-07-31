// Lớp tính toán thuần: chỉ nhận mảng nến, không gọi mạng.
// Dùng chung cho server (analyze.js) và cho browser qua /lib/summary.js,
// nhờ vậy khi WebSocket đẩy nến mới, client tính lại chỉ báo bằng đúng code của server.

import { sma, rsi, macd, atr, bollinger, nearestLevels } from './indicators.js';

const last = (arr) => (arr.length ? arr[arr.length - 1] : null);

/** Nhãn tiếng Việt cho vùng RSI. */
export function rsiZone(value) {
  if (value == null) return null;
  if (value >= 70) return 'quá mua';
  if (value >= 55) return 'nghiêng mua';
  if (value > 45) return 'trung tính';
  if (value > 30) return 'nghiêng bán';
  return 'quá bán';
}

/** Xu hướng suy ra từ vị trí giá so với MA50/MA200. */
export function trendOf(price, ma50, ma200) {
  if (ma50 == null || ma200 == null) return { label: 'chưa đủ dữ liệu', bias: 'neutral' };
  const above50 = price > ma50;
  const golden = ma50 > ma200;
  if (golden && above50) return { label: 'tăng (MA50 trên MA200, giá trên MA50)', bias: 'up' };
  if (!golden && !above50) return { label: 'giảm (MA50 dưới MA200, giá dưới MA50)', bias: 'down' };
  if (golden) return { label: 'tăng nhưng đang điều chỉnh dưới MA50', bias: 'neutral' };
  return { label: 'giảm nhưng đang hồi trên MA50', bias: 'neutral' };
}

export function computeSeries(candles) {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const macdData = macd(closes);
  const bb = bollinger(closes, 20, 2);
  return {
    ma50: sma(closes, 50),
    ma200: sma(closes, 200),
    rsi: rsi(closes, 14),
    atr: atr(candles, 14),
    volMa20: sma(volumes, 20),
    macd: macdData.line,
    macdSignal: macdData.signal,
    macdHistogram: macdData.histogram,
    bbUpper: bb.upper,
    bbLower: bb.lower,
  };
}

export function buildSummary(candles, series) {
  const price = last(candles).close;
  const atrNow = last(series.atr);
  const volNow = last(candles).volume;
  const volAvg = last(series.volMa20);
  const ma50 = last(series.ma50);
  const ma200 = last(series.ma200);
  const rsiNow = last(series.rsi);

  return {
    price,
    ma50,
    ma200,
    rsi: rsiNow,
    rsiZone: rsiZone(rsiNow),
    macd: last(series.macd),
    macdSignal: last(series.macdSignal),
    macdHistogram: last(series.macdHistogram),
    atr: atrNow,
    // ATR quy ra % giá cho dễ so sánh giữa các mã.
    atrPercent: atrNow != null && price ? (atrNow / price) * 100 : null,
    bbUpper: last(series.bbUpper),
    bbLower: last(series.bbLower),
    volume: volNow,
    volumeVsAvg: volAvg ? volNow / volAvg : null,
    trend: trendOf(price, ma50, ma200),
  };
}

/** Tính trọn bộ series + summary + mức hỗ trợ/kháng cự từ mảng nến. */
export function computeAll(candles) {
  const series = computeSeries(candles);
  return {
    series,
    summary: buildSummary(candles, series),
    levels: nearestLevels(candles, last(candles).close),
  };
}
