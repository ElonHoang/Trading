// Bộ máy phân tích: chỉ báo -> điểm theo quy tắc -> kết hợp xác suất ML -> tín hiệu + mức giá.
// Đây là phần deterministic (không có LLM), luôn chạy được kể cả khi không có API key.

import {
  fetchKlines, fetchTicker24h, fetchDerivatives, fetchOrderBookImbalance,
} from '../data/binance.js';
import { computeIndicators, supportResistance, rsiDivergence } from '../indicators/index.js';
import { featureVector, FEATURE_NAMES } from '../features.js';
import { predictProba } from '../ml/gbdt.js';

const clamp = (v, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));

/** Chỉ giữ các nến đã đóng — nến đang chạy làm chỉ báo nhảy loạn. */
export function closedCandles(candles) {
  const out = candles.filter((c) => c.closed);
  return out.length ? out : candles.slice(0, -1);
}

// ---------------- Tính điểm theo quy tắc ----------------

/**
 * Mỗi nhóm trả về score trong [-1, 1] và lý do đọc được.
 * Trọng số lấy từ strategy.weights.
 * `i` = chỉ số nến đang đánh giá (mặc định: nến cuối). Backtest truyền index quá khứ.
 */
export function scoreSignals(candles, ind, strategy, extras = {}, i = candles.length - 1) {
  const c = candles[i];
  const t = strategy.thresholds;
  const groups = {};

  // --- Xu hướng: vị trí giá so với EMA và thứ tự EMA ---
  {
    const reasons = [];
    let s = 0;
    const ef = ind.emaFast[i], em = ind.emaMid[i], es = ind.emaSlow[i];
    if (ef != null && em != null) {
      if (ef > em) { s += 0.35; reasons.push(`EMA${ind.params.emaFast} nằm trên EMA${ind.params.emaMid}`); }
      else { s -= 0.35; reasons.push(`EMA${ind.params.emaFast} nằm dưới EMA${ind.params.emaMid}`); }
    }
    if (es != null) {
      if (c.close > es) { s += 0.3; reasons.push(`Giá trên EMA${ind.params.emaSlow} (xu hướng dài hạn tăng)`); }
      else { s -= 0.3; reasons.push(`Giá dưới EMA${ind.params.emaSlow} (xu hướng dài hạn giảm)`); }
    }
    if (ef != null && c.close > ef) s += 0.15; else if (ef != null) s -= 0.15;

    // ADX làm hệ số khuếch đại: xu hướng yếu thì giảm điểm
    const adxVal = ind.adx[i];
    if (adxVal != null) {
      if (adxVal < t.minAdxForTrend) {
        s *= 0.5;
        reasons.push(`ADX ${adxVal.toFixed(1)} < ${t.minAdxForTrend} → xu hướng yếu, thị trường đi ngang`);
      } else {
        reasons.push(`ADX ${adxVal.toFixed(1)} → xu hướng có lực`);
      }
      const di = (ind.plusDI[i] ?? 0) - (ind.minusDI[i] ?? 0);
      s += clamp(di / 40) * 0.2;
    }
    groups.trend = { score: clamp(s), reasons };
  }

  // --- Động lượng: RSI ---
  {
    const reasons = [];
    let s = 0;
    const r = ind.rsi[i];
    if (r != null) {
      s = clamp((r - 50) / 25);
      reasons.push(`RSI ${r.toFixed(1)}`);
      if (r > t.rsiOverbought) {
        s *= 0.4;
        reasons.push(`RSI trên ${t.rsiOverbought} → quá mua, rủi ro điều chỉnh`);
      } else if (r < t.rsiOversold) {
        s *= 0.4;
        reasons.push(`RSI dưới ${t.rsiOversold} → quá bán, có thể bật lên`);
      }
      const prev = ind.rsi[i - 5];
      if (prev != null) {
        const slope = r - prev;
        s += clamp(slope / 15) * 0.25;
        reasons.push(`RSI ${slope >= 0 ? 'tăng' : 'giảm'} ${Math.abs(slope).toFixed(1)} điểm trong 5 nến`);
      }
    }
    const div = extras.divergence;
    if (div) {
      s += div.type === 'bullish' ? 0.35 : -0.35;
      reasons.push(`Phân kỳ ${div.type === 'bullish' ? 'tăng' : 'giảm'}: ${div.detail}`);
    }
    groups.momentum = { score: clamp(s), reasons };
  }

  // --- MACD ---
  {
    const reasons = [];
    let s = 0;
    const h = ind.macdHist[i], hPrev = ind.macdHist[i - 1], line = ind.macdLine[i];
    if (h != null) {
      s += h > 0 ? 0.4 : -0.4;
      reasons.push(`MACD histogram ${h > 0 ? 'dương' : 'âm'}`);
      if (hPrev != null) {
        if (Math.sign(h) !== Math.sign(hPrev)) {
          s += h > 0 ? 0.35 : -0.35;
          reasons.push(`MACD vừa cắt ${h > 0 ? 'lên' : 'xuống'} (tín hiệu mới)`);
        } else {
          const expanding = Math.abs(h) > Math.abs(hPrev);
          s += (expanding ? 0.2 : -0.1) * Math.sign(h);
          reasons.push(`Histogram ${expanding ? 'đang mở rộng' : 'đang thu hẹp'}`);
        }
      }
      if (line != null) s += line > 0 ? 0.15 : -0.15;
    }
    groups.macd = { score: clamp(s), reasons };
  }

  // --- Cấu trúc thị trường: đỉnh/đáy, vị trí trong range, khoảng cách tới S/R ---
  {
    const reasons = [];
    let s = 0;
    const sr = extras.sr;
    const lookback = Math.min(50, i);
    let hh = -Infinity, ll = Infinity;
    for (let j = i - lookback + 1; j <= i; j++) {
      if (j < 0) continue;
      if (candles[j].high > hh) hh = candles[j].high;
      if (candles[j].low < ll) ll = candles[j].low;
    }
    const pos = hh > ll ? (c.close - ll) / (hh - ll) : 0.5;
    s += clamp((pos - 0.5) * 2) * 0.5;
    reasons.push(`Giá ở ${(pos * 100).toFixed(0)}% biên độ ${lookback} nến gần nhất`);

    if (sr) {
      const nearestRes = sr.resistance[0];
      const nearestSup = sr.support[0];
      if (nearestRes) {
        const d = ((nearestRes.price - c.close) / c.close) * 100;
        reasons.push(`Kháng cự gần nhất ${fmtNum(nearestRes.price)} (+${d.toFixed(2)}%, ${nearestRes.touches} lần chạm)`);
        if (d < 1) { s -= 0.25; reasons.push('Giá sát kháng cự → rủi ro bị chặn'); }
      }
      if (nearestSup) {
        const d = ((c.close - nearestSup.price) / c.close) * 100;
        reasons.push(`Hỗ trợ gần nhất ${fmtNum(nearestSup.price)} (-${d.toFixed(2)}%, ${nearestSup.touches} lần chạm)`);
        if (d < 1) { s += 0.2; reasons.push('Giá sát hỗ trợ → có thể bật lên'); }
      }
      // Breakout: đóng nến trên kháng cự cũ
      if (nearestRes && c.close > nearestRes.price) { s += 0.3; reasons.push('Đã phá kháng cự'); }
    }
    groups.structure = { score: clamp(s), reasons };
  }

  // --- Khối lượng ---
  {
    const reasons = [];
    let s = 0;
    const avg = ind.volumeAvg[i];
    if (avg) {
      const ratio = c.volume / avg;
      const dir = Math.sign(c.close - c.open) || 0;
      reasons.push(`Khối lượng ${ratio.toFixed(2)}x trung bình ${ind.params.volumeAvg} nến`);
      if (ratio >= t.volumeSpikeRatio) {
        s += dir * 0.6;
        reasons.push(`Khối lượng đột biến xác nhận nến ${dir > 0 ? 'tăng' : 'giảm'}`);
      } else if (ratio < 0.6) {
        reasons.push('Khối lượng thấp → tín hiệu giá kém tin cậy');
        s *= 0.5;
      } else {
        s += dir * 0.25 * ratio;
      }
    }
    const obvSlope = ind.obv[i] - ind.obv[i - 10];
    if (Number.isFinite(obvSlope)) {
      s += clamp(obvSlope / (avg ? avg * 10 : 1)) * 0.4;
      reasons.push(`OBV ${obvSlope >= 0 ? 'tăng' : 'giảm'} trong 10 nến (dòng tiền ${obvSlope >= 0 ? 'vào' : 'ra'})`);
    }
    groups.volume = { score: clamp(s), reasons };
  }

  // --- Hồi quy về trung bình (Bollinger) ---
  {
    const reasons = [];
    let s = 0;
    const up = ind.bbUpper[i], lo = ind.bbLower[i], mid = ind.bbMid[i];
    if (up != null && lo != null && up > lo) {
      const pb = (c.close - lo) / (up - lo);
      reasons.push(`%B Bollinger ${(pb * 100).toFixed(0)}%`);
      // Ngoài dải = căng quá -> nghiêng về hồi ngược
      if (pb > 1) { s -= 0.6; reasons.push('Giá đóng trên dải trên → căng, dễ hồi về'); }
      else if (pb < 0) { s += 0.6; reasons.push('Giá đóng dưới dải dưới → căng, dễ bật lên'); }
      else s -= clamp((pb - 0.5) * 2) * 0.35;

      const width = ((up - lo) / mid) * 100;
      reasons.push(`Độ rộng dải ${width.toFixed(2)}%`);
      let widthAvg = 0, n = 0;
      for (let j = Math.max(0, i - 49); j <= i; j++) {
        if (ind.bbUpper[j] != null && ind.bbMid[j]) {
          widthAvg += ((ind.bbUpper[j] - ind.bbLower[j]) / ind.bbMid[j]) * 100; n++;
        }
      }
      widthAvg = n ? widthAvg / n : width;
      if (width < widthAvg * 0.7) reasons.push('Dải Bollinger đang co hẹp → tích luỹ, chuẩn bị bùng nổ biến động');
    }
    groups.meanReversion = { score: clamp(s), reasons };
  }

  // --- Stochastic ---
  {
    const reasons = [];
    let s = 0;
    const k = ind.stochK[i], d = ind.stochD[i], kPrev = ind.stochK[i - 1], dPrev = ind.stochD[i - 1];
    if (k != null && d != null) {
      reasons.push(`Stochastic K ${k.toFixed(1)} / D ${d.toFixed(1)}`);
      s += clamp((k - 50) / 35) * 0.4;
      if (kPrev != null && dPrev != null) {
        if (kPrev <= dPrev && k > d) { s += 0.4; reasons.push('K vừa cắt lên D'); }
        if (kPrev >= dPrev && k < d) { s -= 0.4; reasons.push('K vừa cắt xuống D'); }
      }
      if (k > 80) { s *= 0.5; reasons.push('Vùng quá mua'); }
      if (k < 20) { s *= 0.5; reasons.push('Vùng quá bán'); }
    }
    groups.stochastic = { score: clamp(s), reasons };
  }

  // --- Phái sinh: funding + open interest + order book ---
  {
    const reasons = [];
    let s = 0;
    const d = extras.derivatives;
    if (d && d.fundingRate != null) {
      const fr = d.fundingRate;
      reasons.push(`Funding rate ${(fr * 100).toFixed(4)}%`);
      // Funding cực đoan = đám đông một chiều -> tín hiệu ngược
      if (fr > t.fundingExtreme) { s -= 0.5; reasons.push('Funding dương cao → long quá đông, rủi ro long squeeze'); }
      else if (fr < -t.fundingExtreme) { s += 0.5; reasons.push('Funding âm sâu → short quá đông, rủi ro short squeeze'); }
      else s += clamp(-fr / t.fundingExtreme) * 0.15;

      if (d.openInterestChangePct != null) {
        reasons.push(`Open interest ${d.openInterestChangePct >= 0 ? '+' : ''}${d.openInterestChangePct.toFixed(2)}% (14 kỳ)`);
        const priceUp = c.close > candles[Math.max(0, i - 14)].close;
        if (d.openInterestChangePct > 5 && priceUp) { s += 0.25; reasons.push('OI tăng cùng giá → dòng tiền mới vào long'); }
        if (d.openInterestChangePct > 5 && !priceUp) { s -= 0.25; reasons.push('OI tăng khi giá giảm → dòng tiền mới vào short'); }
      }
    } else {
      reasons.push('Không có dữ liệu phái sinh cho token này');
    }
    const ob = extras.orderBook;
    if (ob) {
      reasons.push(`Sổ lệnh lệch ${(ob.imbalance * 100).toFixed(1)}% về phía ${ob.imbalance > 0 ? 'mua' : 'bán'}`);
      s += clamp(ob.imbalance * 2) * 0.3;
    }
    groups.derivatives = { score: clamp(s), reasons };
  }

  // --- Tổng hợp có trọng số ---
  const weights = strategy.weights;
  let weighted = 0, totalWeight = 0;
  const breakdown = {};
  for (const [name, g] of Object.entries(groups)) {
    const w = Number(weights[name] ?? 0);
    if (!w) { breakdown[name] = { ...g, weight: 0, contribution: 0 }; continue; }
    weighted += g.score * w;
    totalWeight += w;
    breakdown[name] = { ...g, weight: w, contribution: g.score * w };
  }
  const ruleScore = totalWeight ? (weighted / totalWeight) * 100 : 0;
  for (const k of Object.keys(breakdown)) {
    breakdown[k].contributionPct = totalWeight
      ? (breakdown[k].contribution / totalWeight) * 100 : 0;
  }
  return { ruleScore, breakdown };
}

function fmtNum(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (abs >= 1) return v.toFixed(3);
  if (abs >= 0.01) return v.toFixed(5);
  return v.toPrecision(4);
}
export { fmtNum };

export function labelForScore(score, t) {
  if (score >= t.strongBuy) return { label: 'MUA MẠNH', side: 'long', strength: 'strong' };
  if (score >= t.buy) return { label: 'MUA', side: 'long', strength: 'normal' };
  if (score <= t.strongSell) return { label: 'BÁN MẠNH', side: 'short', strength: 'strong' };
  if (score <= t.sell) return { label: 'BÁN', side: 'short', strength: 'normal' };
  return { label: 'TRUNG LẬP', side: 'none', strength: 'weak' };
}

// ---------------- Mức giá giao dịch ----------------

export function buildLevels(candles, ind, sr, signal, risk, i = candles.length - 1) {
  const price = candles[i].close;
  const atrVal = ind.atr[i] ?? price * 0.01;
  if (signal.side === 'none') {
    return { side: 'none', entry: price, atr: atrVal, note: 'Không có hướng rõ ràng — chờ tín hiệu.' };
  }
  const isLong = signal.side === 'long';
  let sl = isLong ? price - risk.slAtrMult * atrVal : price + risk.slAtrMult * atrVal;

  // Nếu có S/R gần hơn thì đặt SL ra ngoài mức đó một chút (an toàn hơn mức ATR thuần)
  if (risk.preferSrLevels) {
    const level = isLong ? sr.support[0] : sr.resistance[0];
    if (level) {
      const buffer = atrVal * 0.3;
      const candidate = isLong ? level.price - buffer : level.price + buffer;
      const dist = Math.abs(price - candidate);
      if (dist > atrVal * 0.5 && dist < atrVal * 3.5) sl = candidate;
    }
  }

  const r = Math.abs(price - sl);
  const targets = (risk.takeProfitR || [1, 2, 3]).map((mult, idx) => ({
    label: `TP${idx + 1}`,
    r: mult,
    price: isLong ? price + r * mult : price - r * mult,
  }));

  // Kèm mức S/R làm mục tiêu tham khảo
  const srTargets = (isLong ? sr.resistance : sr.support).slice(0, 3).map((l) => ({
    price: l.price,
    touches: l.touches,
    distancePct: ((l.price - price) / price) * 100,
  }));

  return {
    side: signal.side,
    entry: price,
    stopLoss: sl,
    riskPerUnit: r,
    riskPercent: (r / price) * 100,
    targets,
    srTargets,
    atr: atrVal,
    rrToTp1: targets.length ? Math.abs(targets[0].price - price) / r : null,
  };
}

// ---------------- ML ----------------

/**
 * `stored` = payload model đã nạp sẵn (do phía gọi tự lấy: filesystem ở Node,
 * localStorage/fetch ở browser). Engine cố tình KHÔNG tự đọc đĩa để cùng một
 * file chạy được ở cả hai môi trường.
 */
function mlPrediction(symbol, interval, candles, ind, strategy, stored) {
  if (!strategy.ml?.enabled) return { available: false, reason: 'ML bị tắt trong cấu hình' };
  if (!stored) {
    return { available: false, reason: `Chưa có model cho ${symbol} ${interval} — hãy train trước.` };
  }
  const i = candles.length - 1;
  const fv = featureVector(candles, ind, i);
  if (!fv) return { available: false, reason: 'Không đủ dữ liệu lịch sử để tạo feature' };
  if (fv.length !== stored.model.nFeatures) {
    return { available: false, reason: 'Model cũ không khớp bộ feature hiện tại — hãy train lại' };
  }
  const prob = predictProba(stored.model, fv);
  const testAuc = stored.metrics?.test?.auc ?? null;
  const wfAuc = stored.metrics?.walkForward?.meanAuc ?? null;
  const minAuc = strategy.ml.minTestAuc ?? 0.52;

  // Độ tin cậy dựa trên CẢ holdout và walk-forward — một fold may mắn không đủ.
  let reliability = 'low';
  if (testAuc != null && wfAuc != null) {
    if (testAuc >= minAuc + 0.05 && wfAuc >= minAuc) reliability = 'high';
    else if (testAuc >= minAuc && wfAuc >= minAuc - 0.02) reliability = 'medium';
  } else if (testAuc != null && testAuc >= minAuc) {
    reliability = 'medium';
  }

  // Xác suất của model có thể bị "nén" quanh 0.5 (dữ liệu giá rất nhiễu).
  // Vì vậy so xác suất với phân phối của chính model trên holdout, thay vì
  // so với ngưỡng tuyệt đối. p80/p20 = 20% tín hiệu tăng/giảm mạnh nhất.
  const cal = stored.calibration;
  let percentile = null;
  let score;
  let confident = false;
  if (cal && cal.p80 > cal.p50 && cal.p50 > cal.p20) {
    const spread = Math.max(cal.p80 - cal.p50, cal.p50 - cal.p20);
    score = clamp((prob - cal.p50) / spread, -1.5, 1.5) / 1.5 * 100;
    confident = prob >= cal.p80 || prob <= cal.p20;
    percentile = prob >= cal.p95 ? '>95%'
      : prob >= cal.p80 ? '80-95%'
        : prob <= cal.p05 ? '<5%'
          : prob <= cal.p20 ? '5-20%' : '20-80%';
  } else {
    const margin = strategy.ml.confidenceMargin ?? 0.12;
    score = clamp((prob - 0.5) / 0.25, -1, 1) * 100;
    confident = Math.abs(prob - 0.5) >= margin;
  }

  return {
    available: true,
    probUp: prob,
    score,
    confident,
    percentile,
    calibration: cal,
    reliability,
    trainedAt: stored.trainedAt,
    horizon: stored.dataset?.horizon,
    labelMode: stored.dataset?.thresholdMode,
    metrics: stored.metrics,
    topFeatures: (stored.importance || []).slice(0, 6),
  };
}

// ---------------- Multi-timeframe ----------------

async function higherTimeframeContext(symbol, interval, strategy) {
  const map = strategy.analysis?.higherTimeframeMap || {};
  const htf = map[interval];
  if (!strategy.analysis?.multiTimeframe || !htf) return null;
  try {
    const raw = await fetchKlines(symbol, htf, 300);
    const candles = closedCandles(raw);
    if (candles.length < 210) return { interval: htf, note: 'Không đủ lịch sử khung lớn' };
    const ind = computeIndicators(candles, strategy.indicators);
    const sr = supportResistance(candles);
    const { ruleScore } = scoreSignals(candles, ind, strategy, { sr });
    const i = candles.length - 1;
    return {
      interval: htf,
      close: candles[i].close,
      ruleScore: round(ruleScore, 1),
      signal: labelForScore(ruleScore, strategy.thresholds).label,
      rsi: round(ind.rsi[i], 1),
      adx: round(ind.adx[i], 1),
      aboveEmaSlow: ind.emaSlow[i] != null ? candles[i].close > ind.emaSlow[i] : null,
      macdHist: round(ind.macdHist[i], 6),
    };
  } catch (err) {
    return { interval: htf, error: err.message };
  }
}

const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));

/**
 * Chuỗi dữ liệu để vẽ biểu đồ (chỉ lấy N nến cuối cho nhẹ payload).
 * Tách riêng khỏi snapshot phân tích vì chỉ giao diện web cần.
 */
function buildSeries(candles, ind, bars = 180) {
  const from = Math.max(0, candles.length - bars);
  const window = candles.slice(from);
  // `pick` nhận mảng đầy đủ (cùng độ dài với candles) rồi tự cắt.
  const pick = (arr, d = 6) => arr.slice(from).map((v) => round(v, d));
  const ohlc = (key, d = 6) => window.map((c) => round(c[key], d));
  return {
    bars: window.length,
    time: window.map((c) => c.openTime),
    open: ohlc('open'),
    high: ohlc('high'),
    low: ohlc('low'),
    close: ohlc('close'),
    volume: ohlc('volume', 2),
    emaFast: pick(ind.emaFast),
    emaMid: pick(ind.emaMid),
    emaSlow: pick(ind.emaSlow),
    bbUpper: pick(ind.bbUpper),
    bbLower: pick(ind.bbLower),
    rsi: pick(ind.rsi, 2),
    macdLine: pick(ind.macdLine),
    macdSignal: pick(ind.macdSignal),
    macdHist: pick(ind.macdHist),
    volumeAvg: pick(ind.volumeAvg, 2),
  };
}

// ---------------- API chính ----------------

/**
 * Phân tích đầy đủ (không gọi LLM). Trả về snapshot dùng được cho Telegram, web và Claude.
 *
 * opts:
 *   storedModel   payload model ML đã nạp sẵn (null = không dùng ML)
 *   candles       số nến nạp về
 *   includeSeries kèm chuỗi dữ liệu để vẽ biểu đồ
 *   seriesBars    số nến trong chuỗi vẽ
 */
export async function analyze(symbolInput, interval, strategy, opts = {}) {
  const symbol = symbolInput;
  const nCandles = opts.candles ?? strategy.analysis?.candles ?? 400;

  const [raw, ticker, derivatives, orderBook] = await Promise.all([
    fetchKlines(symbol, interval, nCandles),
    fetchTicker24h(symbol).catch(() => null),
    fetchDerivatives(symbol),
    fetchOrderBookImbalance(symbol),
  ]);

  const candles = closedCandles(raw);
  if (candles.length < 210) {
    throw new Error(`Chỉ có ${candles.length} nến đã đóng — cần tối thiểu 210 nến cho khung ${interval}. Thử khung nhỏ hơn.`);
  }
  const livePrice = raw[raw.length - 1].close;

  const ind = computeIndicators(candles, strategy.indicators);
  const sr = supportResistance(candles);
  const divergence = rsiDivergence(candles, ind.rsi);

  const { ruleScore, breakdown } = scoreSignals(candles, ind, strategy, {
    sr, divergence, derivatives, orderBook,
  });

  const ml = mlPrediction(symbol, interval, candles, ind, strategy, opts.storedModel);

  // Kết hợp: quy tắc + ML
  const mlWeight = ml.available && ml.reliability !== 'low' ? (strategy.ml.weightVsRules ?? 0.4) : 0;
  const combinedScore = ml.available && mlWeight > 0
    ? ruleScore * (1 - mlWeight) + ml.score * mlWeight
    : ruleScore;

  const signal = labelForScore(combinedScore, strategy.thresholds);
  const levels = buildLevels(candles, ind, sr, signal, strategy.risk);
  const htf = await higherTimeframeContext(symbol, interval, strategy);

  // Cảnh báo xung đột khung lớn
  const conflicts = [];
  if (htf && typeof htf.ruleScore === 'number') {
    if (signal.side === 'long' && htf.ruleScore < strategy.thresholds.sell) {
      conflicts.push(`Tín hiệu MUA ở ${interval} nhưng khung ${htf.interval} đang giảm (${htf.ruleScore})`);
    }
    if (signal.side === 'short' && htf.ruleScore > strategy.thresholds.buy) {
      conflicts.push(`Tín hiệu BÁN ở ${interval} nhưng khung ${htf.interval} đang tăng (${htf.ruleScore})`);
    }
  }
  if (ind.adx[candles.length - 1] != null && ind.adx[candles.length - 1] < strategy.thresholds.minAdxForTrend) {
    conflicts.push('ADX thấp: thị trường đi ngang, tín hiệu theo xu hướng dễ sai');
  }
  if (ml.available && ml.confident) {
    const mlSide = ml.probUp > 0.5 ? 'long' : 'short';
    if (signal.side !== 'none' && mlSide !== signal.side) {
      conflicts.push(`Model ML nghiêng về ${mlSide === 'long' ? 'TĂNG' : 'GIẢM'} (${(ml.probUp * 100).toFixed(1)}%) — ngược với tín hiệu quy tắc`);
    }
  }

  const i = candles.length - 1;
  return {
    symbol,
    interval,
    generatedAt: new Date().toISOString(),
    lastClosedCandleTime: new Date(candles[i].openTime).toISOString(),
    price: {
      lastClose: candles[i].close,
      live: livePrice,
      change24hPercent: ticker?.priceChangePercent ?? null,
      high24h: ticker?.highPrice ?? null,
      low24h: ticker?.lowPrice ?? null,
      quoteVolume24h: ticker?.quoteVolume ?? null,
    },
    indicatorParams: ind.params,
    indicators: {
      emaFast: round(ind.emaFast[i], 6),
      emaMid: round(ind.emaMid[i], 6),
      emaSlow: round(ind.emaSlow[i], 6),
      rsi: round(ind.rsi[i], 2),
      rsi5BarsAgo: round(ind.rsi[i - 5], 2),
      macdLine: round(ind.macdLine[i], 6),
      macdSignal: round(ind.macdSignal[i], 6),
      macdHist: round(ind.macdHist[i], 6),
      macdHistPrev: round(ind.macdHist[i - 1], 6),
      bbUpper: round(ind.bbUpper[i], 6),
      bbMid: round(ind.bbMid[i], 6),
      bbLower: round(ind.bbLower[i], 6),
      atr: round(ind.atr[i], 6),
      atrPercent: round((ind.atr[i] / candles[i].close) * 100, 2),
      adx: round(ind.adx[i], 2),
      plusDI: round(ind.plusDI[i], 2),
      minusDI: round(ind.minusDI[i], 2),
      stochK: round(ind.stochK[i], 2),
      stochD: round(ind.stochD[i], 2),
      vwap: round(ind.vwap[i], 6),
      volume: round(candles[i].volume, 2),
      volumeAvg: round(ind.volumeAvg[i], 2),
      volumeRatio: round(candles[i].volume / (ind.volumeAvg[i] || 1), 2),
    },
    divergence,
    structure: {
      support: sr.support.map((l) => ({
        price: round(l.price, 6), touches: l.touches,
        distancePct: round(((l.price - candles[i].close) / candles[i].close) * 100, 2),
      })),
      resistance: sr.resistance.map((l) => ({
        price: round(l.price, 6), touches: l.touches,
        distancePct: round(((l.price - candles[i].close) / candles[i].close) * 100, 2),
      })),
    },
    derivatives: derivatives
      ? {
        fundingRate: derivatives.fundingRate,
        fundingRatePercent: derivatives.fundingRate != null ? round(derivatives.fundingRate * 100, 5) : null,
        openInterest: derivatives.openInterest,
        openInterestChangePct: round(derivatives.openInterestChangePct, 2),
      }
      : null,
    orderBook: orderBook ? { imbalance: round(orderBook.imbalance, 4) } : null,
    rules: {
      score: round(ruleScore, 1),
      breakdown: Object.fromEntries(Object.entries(breakdown).map(([k, v]) => [k, {
        score: round(v.score, 3),
        weight: v.weight,
        contributionPct: round(v.contributionPct, 2),
        reasons: v.reasons,
      }])),
    },
    ml: ml.available
      ? {
        available: true,
        probUp: round(ml.probUp, 4),
        probUpPercent: round(ml.probUp * 100, 2),
        percentileVsHistory: ml.percentile,
        score: round(ml.score, 1),
        confident: ml.confident,
        reliability: ml.reliability,
        horizonCandles: ml.horizon,
        labelMode: ml.labelMode,
        trainedAt: ml.trainedAt,
        testAuc: round(ml.metrics?.test?.auc, 4),
        walkForwardAuc: round(ml.metrics?.walkForward?.meanAuc, 4),
        tailAccuracy: ml.metrics?.tail,
        thresholds: ml.calibration
          ? { bullishAbove: ml.calibration.p80, bearishBelow: ml.calibration.p20, median: ml.calibration.p50 }
          : null,
        topFeatures: ml.topFeatures,
      }
      : { available: false, reason: ml.reason },
    combined: {
      score: round(combinedScore, 1),
      mlWeightUsed: mlWeight,
      signal: signal.label,
      side: signal.side,
      strength: signal.strength,
    },
    levels: {
      side: levels.side,
      entry: round(levels.entry, 6),
      stopLoss: round(levels.stopLoss, 6),
      riskPercent: round(levels.riskPercent, 2),
      targets: levels.targets?.map((t) => ({ label: t.label, r: t.r, price: round(t.price, 6) })),
      srTargets: levels.srTargets?.map((t) => ({
        price: round(t.price, 6), touches: t.touches, distancePct: round(t.distancePct, 2),
      })),
      note: levels.note,
    },
    higherTimeframe: htf,
    conflicts,
    featureNames: FEATURE_NAMES,
    ...(opts.includeSeries ? { series: buildSeries(candles, ind, opts.seriesBars ?? 180) } : {}),
  };
}
