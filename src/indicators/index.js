// Chỉ báo kỹ thuật thuần JS. Mọi hàm trả về mảng cùng độ dài với input,
// các phần tử chưa đủ dữ liệu là null (không phải 0) để tránh sai lệch khi tính toán.

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

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** EMA kiểu Wilder (dùng cho RSI/ATR/ADX). */
function rma(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]) / period;
    out[i] = prev;
  }
  return out;
}

export function rsi(closes, period = 14) {
  const gains = new Array(closes.length).fill(0);
  const losses = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains[i] = d > 0 ? d : 0;
    losses[i] = d < 0 ? -d : 0;
  }
  const ag = rma(gains.slice(1), period);
  const al = rma(losses.slice(1), period);
  const out = new Array(closes.length).fill(null);
  for (let i = 0; i < ag.length; i++) {
    if (ag[i] == null || al[i] == null) continue;
    out[i + 1] = al[i] === 0 ? 100 : 100 - 100 / (1 + ag[i] / al[i]);
  }
  return out;
}

export function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const line = closes.map((_, i) => (ef[i] == null || es[i] == null ? null : ef[i] - es[i]));
  const defined = line.filter((v) => v != null);
  const sig = ema(defined, signalPeriod);
  const offset = line.length - defined.length;
  const signal = new Array(closes.length).fill(null);
  for (let i = 0; i < sig.length; i++) signal[i + offset] = sig[i];
  const hist = closes.map((_, i) =>
    line[i] == null || signal[i] == null ? null : line[i] - signal[i]);
  return { line, signal, hist };
}

export function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const win = closes.slice(i - period + 1, i + 1);
    const m = mid[i];
    const variance = win.reduce((s, v) => s + (v - m) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
  }
  return { upper, mid, lower };
}

export function trueRange(candles) {
  const out = new Array(candles.length).fill(null);
  for (let i = 1; i < candles.length; i++) {
    const { high, low } = candles[i];
    const pc = candles[i - 1].close;
    out[i] = Math.max(high - low, Math.abs(high - pc), Math.abs(low - pc));
  }
  out[0] = candles[0].high - candles[0].low;
  return out;
}

export function atr(candles, period = 14) {
  const tr = trueRange(candles).map((v) => v ?? 0);
  const r = rma(tr.slice(1), period);
  const out = new Array(candles.length).fill(null);
  for (let i = 0; i < r.length; i++) out[i + 1] = r[i];
  return out;
}

export function adx(candles, period = 14) {
  const n = candles.length;
  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }
  const tr = trueRange(candles).map((v) => v ?? 0);
  const trR = rma(tr.slice(1), period);
  const pR = rma(plusDM.slice(1), period);
  const mR = rma(minusDM.slice(1), period);
  const plusDI = new Array(n).fill(null);
  const minusDI = new Array(n).fill(null);
  const dx = [];
  for (let i = 0; i < trR.length; i++) {
    if (trR[i] == null || !trR[i]) continue;
    const p = (pR[i] / trR[i]) * 100;
    const m = (mR[i] / trR[i]) * 100;
    plusDI[i + 1] = p;
    minusDI[i + 1] = m;
    dx.push(p + m === 0 ? 0 : (Math.abs(p - m) / (p + m)) * 100);
  }
  const adxR = rma(dx, period);
  const out = new Array(n).fill(null);
  const start = n - dx.length;
  for (let i = 0; i < adxR.length; i++) if (adxR[i] != null) out[start + i] = adxR[i];
  return { adx: out, plusDI, minusDI };
}

export function stochastic(candles, kPeriod = 14, dPeriod = 3) {
  const n = candles.length;
  const kRaw = new Array(n).fill(null);
  for (let i = kPeriod - 1; i < n; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (candles[j].high > hh) hh = candles[j].high;
      if (candles[j].low < ll) ll = candles[j].low;
    }
    kRaw[i] = hh === ll ? 50 : ((candles[i].close - ll) / (hh - ll)) * 100;
  }
  const defined = kRaw.filter((v) => v != null);
  const dSm = sma(defined, dPeriod);
  const d = new Array(n).fill(null);
  const offset = n - defined.length;
  for (let i = 0; i < dSm.length; i++) d[i + offset] = dSm[i];
  return { k: kRaw, d };
}

export function obv(candles) {
  const out = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const dir = Math.sign(candles[i].close - candles[i - 1].close);
    out[i] = out[i - 1] + dir * candles[i].volume;
  }
  return out;
}

/** VWAP luỹ tiến trên cửa sổ N nến (VWAP phiên không áp dụng cho crypto 24/7). */
export function rollingVwap(candles, period = 20) {
  const out = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    let pv = 0, v = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const tp = (candles[j].high + candles[j].low + candles[j].close) / 3;
      pv += tp * candles[j].volume;
      v += candles[j].volume;
    }
    out[i] = v > 0 ? pv / v : null;
  }
  return out;
}

/**
 * Tìm các đỉnh/đáy swing (pivot) để dựng vùng hỗ trợ/kháng cự.
 * left/right = số nến hai bên phải thấp/cao hơn.
 */
export function pivots(candles, left = 3, right = 3) {
  const highs = [];
  const lows = [];
  for (let i = left; i < candles.length - right; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: candles[i].high, time: candles[i].openTime });
    if (isLow) lows.push({ index: i, price: candles[i].low, time: candles[i].openTime });
  }
  return { highs, lows };
}

/** Gom pivot thành vùng S/R (các mức gần nhau trong tolerance% được nhập lại). */
export function supportResistance(candles, { left = 3, right = 3, tolerancePct = 0.6, maxLevels = 6 } = {}) {
  const { highs, lows } = pivots(candles, left, right);
  const price = candles[candles.length - 1].close;
  const cluster = (points) => {
    const sorted = [...points].sort((a, b) => a.price - b.price);
    const groups = [];
    for (const p of sorted) {
      const g = groups[groups.length - 1];
      if (g && Math.abs(p.price - g.price) / g.price * 100 <= tolerancePct) {
        g.touches += 1;
        g.price = (g.price * (g.touches - 1) + p.price) / g.touches;
        g.lastIndex = Math.max(g.lastIndex, p.index);
      } else {
        groups.push({ price: p.price, touches: 1, lastIndex: p.index });
      }
    }
    return groups;
  };
  const all = [...cluster(highs), ...cluster(lows)];
  const resistance = all
    .filter((l) => l.price > price)
    .sort((a, b) => a.price - b.price)
    .slice(0, maxLevels);
  const support = all
    .filter((l) => l.price < price)
    .sort((a, b) => b.price - a.price)
    .slice(0, maxLevels);
  return { support, resistance };
}

/** Kiểm tra phân kỳ RSI trên N nến gần nhất. */
export function rsiDivergence(candles, rsiVals, lookback = 40) {
  const n = candles.length;
  if (n < lookback + 5) return null;
  const slice = candles.slice(n - lookback);
  const rSlice = rsiVals.slice(n - lookback);
  const { highs, lows } = pivots(slice, 2, 2);
  const last2 = (arr) => (arr.length >= 2 ? arr.slice(-2) : null);

  const hh = last2(highs);
  if (hh && rSlice[hh[0].index] != null && rSlice[hh[1].index] != null) {
    if (hh[1].price > hh[0].price && rSlice[hh[1].index] < rSlice[hh[0].index]) {
      return { type: 'bearish', detail: 'Giá tạo đỉnh cao hơn nhưng RSI tạo đỉnh thấp hơn' };
    }
  }
  const ll = last2(lows);
  if (ll && rSlice[ll[0].index] != null && rSlice[ll[1].index] != null) {
    if (ll[1].price < ll[0].price && rSlice[ll[1].index] > rSlice[ll[0].index]) {
      return { type: 'bullish', detail: 'Giá tạo đáy thấp hơn nhưng RSI tạo đáy cao hơn' };
    }
  }
  return null;
}

/** Tính toàn bộ chỉ báo một lượt. */
export function computeIndicators(candles, cfg = {}) {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const p = {
    emaFast: cfg.emaFast ?? 20,
    emaMid: cfg.emaMid ?? 50,
    emaSlow: cfg.emaSlow ?? 200,
    rsi: cfg.rsi ?? 14,
    macdFast: cfg.macdFast ?? 12,
    macdSlow: cfg.macdSlow ?? 26,
    macdSignal: cfg.macdSignal ?? 9,
    bbPeriod: cfg.bbPeriod ?? 20,
    bbMult: cfg.bbMult ?? 2,
    atr: cfg.atr ?? 14,
    adx: cfg.adx ?? 14,
    stochK: cfg.stochK ?? 14,
    stochD: cfg.stochD ?? 3,
    vwap: cfg.vwap ?? 20,
    volumeAvg: cfg.volumeAvg ?? 20,
  };
  const m = macd(closes, p.macdFast, p.macdSlow, p.macdSignal);
  const bb = bollinger(closes, p.bbPeriod, p.bbMult);
  const a = adx(candles, p.adx);
  const st = stochastic(candles, p.stochK, p.stochD);
  return {
    params: p,
    closes,
    emaFast: ema(closes, p.emaFast),
    emaMid: ema(closes, p.emaMid),
    emaSlow: ema(closes, p.emaSlow),
    rsi: rsi(closes, p.rsi),
    macdLine: m.line,
    macdSignal: m.signal,
    macdHist: m.hist,
    bbUpper: bb.upper,
    bbMid: bb.mid,
    bbLower: bb.lower,
    atr: atr(candles, p.atr),
    adx: a.adx,
    plusDI: a.plusDI,
    minusDI: a.minusDI,
    stochK: st.k,
    stochD: st.d,
    obv: obv(candles),
    vwap: rollingVwap(candles, p.vwap),
    volumeAvg: sma(volumes, p.volumeAvg),
  };
}
