// Các chỉ báo kỹ thuật thuần hàm. Mọi hàm trả về mảng cùng độ dài với input;
// những điểm chưa đủ chu kỳ để tính thì là null (không phải 0, để chart bỏ qua).

/** Trung bình động đơn giản. */
export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Trung bình động lũy thừa. Điểm mồi là SMA của `period` giá trị đầu. */
export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsiFrom(avgGain, avgLoss) {
  // Không có nến giảm nào -> RSI 100. Cả hai bằng 0 (giá đi ngang tuyệt đối) -> 50.
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/** RSI dùng làm trơn Wilder, giống TradingView. */
export function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = rsiFrom(gain, loss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
    loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = rsiFrom(gain, loss);
  }
  return out;
}

/** MACD: đường nhanh - chậm, đường tín hiệu, histogram. */
export function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const line = values.map((_, i) =>
    emaFast[i] == null || emaSlow[i] == null ? null : emaFast[i] - emaSlow[i]);

  const signal = new Array(values.length).fill(null);
  const histogram = new Array(values.length).fill(null);
  // EMA của đường MACD chỉ tính trên đoạn đã có giá trị, rồi map trở lại vị trí gốc.
  const start = line.findIndex((v) => v !== null);
  if (start !== -1) {
    const sig = ema(line.slice(start), signalPeriod);
    for (let i = 0; i < sig.length; i++) {
      if (sig[i] == null) continue;
      signal[start + i] = sig[i];
      histogram[start + i] = line[start + i] - sig[i];
    }
  }
  return { line, signal, histogram };
}

/** Average True Range (làm trơn Wilder) - dùng để ước lượng biên độ / đặt stop. */
export function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;

  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose),
    );
  });

  let value = 0;
  for (let i = 1; i <= period; i++) value += tr[i];
  value /= period;
  out[period] = value;
  for (let i = period + 1; i < candles.length; i++) {
    value = (value * (period - 1) + tr[i]) / period;
    out[i] = value;
  }
  return out;
}

/** Bollinger Bands quanh SMA. */
export function bollinger(values, period = 20, mult = 2) {
  const middle = sma(values, period);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (values[j] - middle[i]) ** 2;
    const sd = Math.sqrt(variance / period);
    upper[i] = middle[i] + mult * sd;
    lower[i] = middle[i] - mult * sd;
  }
  return { middle, upper, lower };
}

/**
 * Điểm đảo chiều: nến có high (hoặc low) cực trị so với `window` nến mỗi bên.
 * Bỏ qua `window` nến đầu và cuối vì chưa xác nhận được cả hai phía.
 */
export function pivots(candles, window = 5) {
  const highs = [];
  const lows = [];
  for (let i = window; i < candles.length - window; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - window; j <= i + window; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ price: candles[i].high, time: candles[i].openTime });
    if (isLow) lows.push({ price: candles[i].low, time: candles[i].openTime });
  }
  return { highs, lows };
}

/** Kháng cự gần nhất phía trên và hỗ trợ gần nhất phía dưới giá hiện tại. */
export function nearestLevels(candles, price, { window = 5, count = 3 } = {}) {
  const { highs, lows } = pivots(candles, window);
  return {
    resistance: highs.filter((h) => h.price > price)
      .sort((a, b) => a.price - b.price).slice(0, count),
    support: lows.filter((l) => l.price < price)
      .sort((a, b) => b.price - a.price).slice(0, count),
  };
}
