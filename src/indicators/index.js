// Repo này cố ý CHỈ dùng các chỉ báo trong .claude/skills/chi-bao/SKILL.md:
// order book, volume, OI, funding rate, CVD, hỗ trợ/kháng cự.
//
// Các chỉ báo giá thuần — EMA, RSI, MACD, Bollinger, ATR, ADX, Stochastic, VWAP,
// OBV, phân kỳ RSI — đã được xoá khỏi hệ thống theo yêu cầu. Lấy lại từ git
// commit 2155bd4 nếu cần.
//
// Order book, OI và funding rate không nằm ở đây vì chúng là ảnh chụp từ API,
// không phải chuỗi theo nến — xem fetchOrderBookImbalance / fetchDerivatives
// trong src/data/binance.js.
//
// Mọi hàm trả về mảng cùng độ dài với input, các phần tử chưa đủ dữ liệu là null
// (không phải 0) để tránh sai lệch khi tính toán.

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

/**
 * Cumulative Volume Delta, xấp xỉ từ nến: mỗi nến Binance cho biết khối lượng
 * bên taker mua (`takerBuyVolume`), nên taker bán = volume - takerBuyVolume và
 * delta = 2*takerBuyVolume - volume.
 *
 * LƯU Ý: đây là CVD theo nến, KHÔNG phải CVD tick-by-tick từ luồng giao dịch.
 * Nó cho biết bên nào chủ động hơn trong cả nến, không thấy được thứ tự khớp
 * bên trong nến. Nến nào thiếu `takerBuyVolume` thì delta là null và không được
 * cộng vào tổng luỹ tiến.
 */
export function cvd(candles) {
  const delta = new Array(candles.length).fill(null);
  const cumulative = new Array(candles.length).fill(null);
  let run = 0;
  let seen = false;
  for (let i = 0; i < candles.length; i++) {
    const buy = candles[i].takerBuyVolume;
    if (buy == null || Number.isNaN(buy)) {
      cumulative[i] = seen ? run : null;
      continue;
    }
    const d = 2 * buy - candles[i].volume;
    delta[i] = d;
    run += d;
    seen = true;
    cumulative[i] = run;
  }
  return { delta, cumulative };
}

/**
 * Độ dốc CVD chuẩn hoá: (CVD[i] - CVD[i-period]) chia cho tổng volume cùng kỳ.
 * Chuẩn hoá để so được giữa các token và các giai đoạn có thanh khoản khác nhau.
 * Kết quả nằm trong [-1, 1]: +1 = toàn bộ volume kỳ đó là mua chủ động.
 */
export function cvdSlope(candles, cumulative, period = 20) {
  const out = new Array(candles.length).fill(null);
  for (let i = period; i < candles.length; i++) {
    if (cumulative[i] == null || cumulative[i - period] == null) continue;
    let vol = 0;
    for (let j = i - period + 1; j <= i; j++) vol += candles[j].volume;
    if (vol <= 0) continue;
    out[i] = (cumulative[i] - cumulative[i - period]) / vol;
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
    let isHigh = true;
    let isLow = true;
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

/** Tính toàn bộ chỉ báo một lượt. */
export function computeIndicators(candles, cfg = {}) {
  const volumes = candles.map((c) => c.volume);
  const p = {
    volumeAvg: cfg.volumeAvg ?? 20,
    cvdSlope: cfg.cvdSlope ?? 20,
  };
  const cv = cvd(candles);
  return {
    params: p,
    closes: candles.map((c) => c.close),
    volumes,
    volumeAvg: sma(volumes, p.volumeAvg),
    cvdDelta: cv.delta,
    cvd: cv.cumulative,
    cvdSlope: cvdSlope(candles, cv.cumulative, p.cvdSlope),
  };
}
