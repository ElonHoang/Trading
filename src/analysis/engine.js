// Bộ máy phân tích: chỉ báo -> điểm theo quy tắc -> kết hợp xác suất ML -> tín hiệu + mức giá.
// Đây là phần deterministic (không có LLM), luôn chạy được kể cả khi không có API key.

import {
  fetchKlines, fetchTicker24h, fetchDerivatives, fetchOrderBookImbalance, fetchPositioning,
} from '../data/binance.js';
import { computeIndicators, supportResistance } from '../indicators/index.js';
import { featureVector, FEATURE_NAMES } from '../features.js';
import { predictProba } from '../ml/gbdt.js';

const clamp = (v, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));

/** Số nến đã đóng tối thiểu để chấm điểm được (volumeAvg 20 + cvdSlope 20 + pivot). */
export const MIN_CANDLES = 30;

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

  // Biên độ 50 nến gần nhất — dùng chung cho volume climax và cấu trúc.
  const lookback = Math.min(50, i);
  let rangeHigh = -Infinity;
  let rangeLow = Infinity;
  for (let j = i - lookback + 1; j <= i; j++) {
    if (j < 0) continue;
    if (candles[j].high > rangeHigh) rangeHigh = candles[j].high;
    if (candles[j].low < rangeLow) rangeLow = candles[j].low;
  }
  const rangePos = rangeHigh > rangeLow ? (c.close - rangeLow) / (rangeHigh - rangeLow) : 0.5;

  // Giá đi ngang hay có hướng rõ? Dùng cho phân kỳ CVD kiểu gom hàng/phân phối.
  const cvdBack = ind.params.cvdSlope;
  const priceChgPct = ((c.close - candles[Math.max(0, i - cvdBack)].close)
    / candles[Math.max(0, i - cvdBack)].close) * 100;
  const sidewaysPct = t.sidewaysPercent ?? 1.5;
  const sideways = Math.abs(priceChgPct) < sidewaysPct;

  // --- Khối lượng: xác nhận, bẫy breakout, hay climax cạn lực ---
  {
    const reasons = [];
    let s = 0;
    const avg = ind.volumeAvg[i];
    const dir = Math.sign(c.close - c.open) || 0;
    if (avg) {
      const ratio = c.volume / avg;
      reasons.push(`Khối lượng ${ratio.toFixed(2)}x trung bình ${ind.params.volumeAvg} nến`);

      // Có phá vỡ mức S/R gần nhất trong nến này không?
      const sr = extras.sr;
      const brokeUp = sr?.resistance?.[0] && c.close > sr.resistance[0].price;
      const brokeDown = sr?.support?.[0] && c.close < sr.support[0].price;
      const breakout = brokeUp || brokeDown;

      if (ratio >= t.volumeSpikeRatio) {
        // Đột biến ở rìa biên độ = climax (panic sell / FOMO) -> cạn lực, KHÔNG xác nhận.
        const atTop = rangePos > 0.9;
        const atBottom = rangePos < 0.1;
        if (atBottom && dir < 0) {
          s += 0.5;
          reasons.push('Volume khổng lồ ở đáy biên độ với nến giảm → panic sell, thường là đáy tạm');
        } else if (atTop && dir > 0) {
          s -= 0.5;
          reasons.push('Volume khổng lồ ở đỉnh biên độ với nến tăng → FOMO tột độ, rủi ro tạo đỉnh');
        } else {
          s += dir * 0.7;
          reasons.push(`Khối lượng đột biến xác nhận nến ${dir > 0 ? 'tăng' : 'giảm'}`);
          if (breakout) {
            s += dir * 0.3;
            reasons.push(`Phá ${brokeUp ? 'kháng cự' : 'hỗ trợ'} kèm volume lớn → xu hướng mới là thật`);
          }
        }
      } else if (breakout) {
        // Phá mức mà không có dòng tiền -> bull trap / bear trap.
        s -= dir * 0.5;
        reasons.push(`Phá ${brokeUp ? 'kháng cự' : 'hỗ trợ'} nhưng volume chỉ ${ratio.toFixed(2)}x `
          + `→ nghi ${brokeUp ? 'bull trap' : 'bear trap'}, dễ quay đầu`);
      } else if (ratio < 0.6) {
        s += dir * 0.1;
        reasons.push('Khối lượng thấp → tín hiệu giá kém tin cậy');
      } else {
        s += dir * 0.3 * ratio;
      }
    } else {
      reasons.push('Chưa đủ nến để tính khối lượng trung bình');
    }
    groups.volume = { score: clamp(s), reasons, available: avg != null };
  }

  // --- CVD: ai đang chủ động, và có phân kỳ với giá hay không ---
  {
    const reasons = [];
    let s = 0;
    const slope = ind.cvdSlope[i];
    if (slope != null) {
      reasons.push(`CVD ${cvdBack} nến: ${slope >= 0 ? 'mua' : 'bán'} chủ động ròng `
        + `${(Math.abs(slope) * 100).toFixed(1)}% khối lượng cùng kỳ`);
      s += clamp(slope * 3) * 0.45;
      reasons.push(`Giá ${priceChgPct >= 0 ? '+' : ''}${priceChgPct.toFixed(2)}% cùng kỳ`);

      if (sideways) {
        // Trường hợp mạnh nhất: giá đứng yên nhưng dòng tiền một chiều rõ rệt.
        if (slope > 0.02) {
          s += 0.6;
          reasons.push('Giá đi ngang nhưng CVD tăng → có bên gom hàng âm thầm, thường bật tăng sau đó');
        } else if (slope < -0.02) {
          s -= 0.6;
          reasons.push('Giá đi ngang nhưng CVD giảm → đang bị phân phối, cảnh báo giá sập');
        } else {
          reasons.push('Giá đi ngang, CVD cũng cân bằng → chưa có bên nào chiếm ưu thế');
        }
      } else if ((priceChgPct > 0) === (slope > 0)) {
        s += priceChgPct > 0 ? 0.3 : -0.3;
        reasons.push(`Giá và CVD cùng chiều → dòng tiền xác nhận nhịp `
          + `${priceChgPct > 0 ? 'tăng' : 'giảm'}`);
      } else {
        s += priceChgPct > 0 ? -0.5 : 0.5;
        reasons.push(priceChgPct > 0
          ? 'Phân kỳ giảm: giá tăng nhưng CVD giảm → bên bán đang xả lên đầu phe mua'
          : 'Phân kỳ tăng: giá giảm nhưng CVD tăng → bên mua đang hấp thụ, có thể đảo chiều');
      }
    } else {
      reasons.push('Chưa đủ nến để tính độ dốc CVD');
    }
    const delta = ind.cvdDelta[i];
    if (delta != null && c.volume > 0) {
      const share = delta / c.volume;
      s += clamp(share) * 0.2;
      reasons.push(`Nến hiện tại: ${share >= 0 ? 'mua' : 'bán'} chủ động chiếm `
        + `${(Math.abs(share) * 100).toFixed(1)}% khối lượng`);
    }
    groups.cvd = { score: clamp(s), reasons, available: ind.cvdSlope[i] != null };
  }

  // --- Cấu trúc: vị trí trong biên độ + khoảng cách tới hỗ trợ/kháng cự ---
  {
    const reasons = [];
    let s = 0;
    const sr = extras.sr;
    s += clamp((rangePos - 0.5) * 2) * 0.5;
    reasons.push(`Giá ở ${(rangePos * 100).toFixed(0)}% biên độ ${lookback} nến gần nhất`);

    if (sr) {
      const nearestRes = sr.resistance[0];
      const nearestSup = sr.support[0];
      if (nearestRes) {
        const d = ((nearestRes.price - c.close) / c.close) * 100;
        reasons.push(`Kháng cự gần nhất ${fmtNum(nearestRes.price)} (+${d.toFixed(2)}%, `
          + `${nearestRes.touches} lần chạm)`);
        if (d < 1) { s -= 0.25; reasons.push('Giá sát kháng cự → rủi ro bị chặn'); }
      }
      if (nearestSup) {
        const d = ((c.close - nearestSup.price) / c.close) * 100;
        reasons.push(`Hỗ trợ gần nhất ${fmtNum(nearestSup.price)} (-${d.toFixed(2)}%, `
          + `${nearestSup.touches} lần chạm)`);
        if (d < 1) { s += 0.2; reasons.push('Giá sát hỗ trợ → có thể bật lên'); }
      }
      // Breakout: đóng nến trên kháng cự cũ
      if (nearestRes && c.close > nearestRes.price) { s += 0.3; reasons.push('Đã phá kháng cự'); }
    }
    groups.structure = { score: clamp(s), reasons, available: true };
  }

  // --- Phái sinh: funding rate + open interest ---
  {
    const reasons = [];
    let s = 0;
    const d = extras.derivatives;
    if (d && d.fundingRate != null) {
      const fr = d.fundingRate;
      reasons.push(`Funding rate ${(fr * 100).toFixed(4)}%`);
      // Funding cực đoan = đám đông một chiều -> tín hiệu ngược
      if (fr > t.fundingExtreme) {
        s -= 0.5;
        reasons.push('Funding dương cao → long quá đông, rủi ro long squeeze');
      } else if (fr < -t.fundingExtreme) {
        s += 0.5;
        reasons.push('Funding âm sâu → short quá đông, rủi ro short squeeze');
      } else {
        s += clamp(-fr / t.fundingExtreme) * 0.15;
      }

      if (d.openInterestChangePct != null) {
        // LƯU Ý: OI luôn lấy trên 14 kỳ 4h (~2,3 ngày), không theo khung đang phân tích.
        reasons.push(`Open interest ${d.openInterestChangePct >= 0 ? '+' : ''}`
          + `${d.openInterestChangePct.toFixed(2)}% (14 kỳ 4h ≈ 2,3 ngày)`);
        const priceUp = c.close > candles[Math.max(0, i - 14)].close;
        if (d.openInterestChangePct > 5 && priceUp) {
          s += 0.25;
          reasons.push('OI tăng cùng giá → tiền mới vào long, xu hướng có cơ sở');
        }
        if (d.openInterestChangePct > 5 && !priceUp) {
          s -= 0.25;
          reasons.push('OI tăng khi giá giảm → tiền mới vào short');
        }
        if (d.openInterestChangePct < -5 && priceUp) {
          s -= 0.15;
          reasons.push('OI giảm khi giá tăng → short đóng vị thế, nhịp tăng dễ hết đà');
        }
        if (d.openInterestChangePct < -5 && !priceUp) {
          s += 0.15;
          reasons.push('OI giảm khi giá giảm → long cắt lỗ, nhịp giảm đang cạn lực');
        }
      }
    } else {
      reasons.push('Không có hợp đồng futures cho token này');
    }
    groups.derivatives = { score: clamp(s), reasons, available: d?.fundingRate != null };
  }

  // --- Sổ lệnh: tường mua/bán + độ mỏng. Chỉ có giá trị ở khung rất ngắn,
  //     bị spoofing được, không backtest được -> phải đối chiếu CVD và volume.
  {
    const reasons = [];
    let s = 0;
    const ob = extras.orderBook;
    if (ob) {
      reasons.push(`Sổ lệnh lệch ${(ob.imbalance * 100).toFixed(1)}% về phía `
        + `${ob.imbalance > 0 ? 'mua' : 'bán'} (${ob.levels ?? '?'} mức)`);
      s += clamp(ob.imbalance * 2) * 0.5;

      for (const w of ob.walls ?? []) {
        const where = w.side === 'bid' ? 'dưới' : 'trên';
        reasons.push(`Tường ${w.side === 'bid' ? 'MUA' : 'BÁN'} tại ${fmtNum(w.price)} `
          + `(${w.distancePct >= 0 ? '+' : ''}${w.distancePct.toFixed(2)}%, `
          + `${w.ratioToAvg.toFixed(1)}x trung bình) → `
          + `${w.side === 'bid' ? 'hỗ trợ cứng phía ' : 'kháng cự mạnh phía '}${where}`);
        // Tường càng gần giá càng ảnh hưởng mạnh.
        const near = Math.abs(w.distancePct) < 1 ? 1 : 0.5;
        s += (w.side === 'bid' ? 0.2 : -0.2) * near;
      }
      if (ob.walls?.length) {
        reasons.push('Lưu ý: tường lệnh có thể là spoofing — chỉ tin nếu CVD và volume cùng hướng');
      }

      // Sổ lệnh mỏng: cùng số mức nhưng trải trên biên độ giá rộng -> dễ trượt giá.
      if (ob.depthSpanPct != null && ob.depthSpanPct > 2) {
        reasons.push(`Sổ lệnh mỏng: ${ob.levels} mức trải trên ±${ob.depthSpanPct.toFixed(2)}% `
          + '→ volume nhỏ cũng đủ làm giá trượt mạnh');
        s *= 0.6;
      }
    } else {
      reasons.push('Không lấy được sổ lệnh');
    }
    groups.orderBook = { score: clamp(s), reasons, available: !!ob };
  }

  // --- Định vị đám đông: tỉ lệ long/short tài khoản, top trader, taker ---
  //     Đám đông lệch một bên = bên đó đang có rủi ro bị thanh lý. Đây là dữ liệu
  //     thật có lịch sử, KHÔNG phải liquidity map theo mức giá (Binance không có).
  {
    const reasons = [];
    let s = 0;
    const p = extras.positioning;
    if (p) {
      if (p.longAccountRatio != null) {
        const longPct = p.longAccountRatio * 100;
        reasons.push(`${longPct.toFixed(1)}% tài khoản đang long (chu kỳ ${p.period})`);
        // Đám đông quá lệch -> tín hiệu ngược, giống funding cực đoan.
        const skew = p.longAccountRatio - 0.5;
        if (Math.abs(skew) > (t.crowdSkew ?? 0.12)) {
          s -= Math.sign(skew) * 0.5;
          reasons.push(skew > 0
            ? 'Đám đông dồn về long quá mức → rủi ro bị đạp xuống thanh lý long'
            : 'Đám đông dồn về short quá mức → rủi ro bị đẩy lên thanh lý short');
        } else {
          s -= skew * 1.2;
        }
      }
      if (p.longAccountChange != null && Math.abs(p.longAccountChange) > 0.03) {
        reasons.push(`Tỉ lệ long ${p.longAccountChange > 0 ? 'tăng' : 'giảm'} `
          + `${(Math.abs(p.longAccountChange) * 100).toFixed(1)} điểm % trong ${p.samples} kỳ`);
        s -= Math.sign(p.longAccountChange) * 0.15;
      }
      // Top trader lệch ngược đám đông là tín hiệu đáng chú ý.
      if (p.topLongRatio != null && p.longAccountRatio != null) {
        const gap = p.topLongRatio - p.longAccountRatio;
        reasons.push(`Top trader ${(p.topLongRatio * 100).toFixed(1)}% long `
          + `(lệch ${gap >= 0 ? '+' : ''}${(gap * 100).toFixed(1)} điểm % so với đám đông)`);
        if (Math.abs(gap) > 0.05) {
          s += Math.sign(gap) * 0.35;
          reasons.push(gap > 0
            ? 'Top trader long nhiều hơn đám đông → nghiêng tăng'
            : 'Top trader short nhiều hơn đám đông → nghiêng giảm');
        }
      }
      if (p.takerBuySellRatio != null) {
        reasons.push(`Taker mua/bán ${p.takerBuySellRatio.toFixed(3)}`);
        s += clamp((p.takerBuySellRatio - 1) * 2) * 0.25;
      }
    } else {
      reasons.push('Không có dữ liệu định vị (token không có hợp đồng futures)');
    }
    groups.positioning = { score: clamp(s), reasons, available: !!p };
  }

  // --- Tổng hợp có trọng số ---
  const weights = strategy.weights;
  let weighted = 0, totalWeight = 0;
  const breakdown = {};
  // Nhóm thiếu dữ liệu bị LOẠI khỏi phép chuẩn hoá, không tính là 0 điểm —
  // nếu tính là 0 thì điểm tổng bị pha loãng và gần như không bao giờ vượt ngưỡng
  // (đúng lỗi khiến backtest chỉ ra 9 lệnh: backtest không có derivatives/orderBook).
  for (const [name, g] of Object.entries(groups)) {
    const w = Number(weights[name] ?? 0);
    if (!w || g.available === false) {
      breakdown[name] = { ...g, weight: w, contribution: 0, skipped: g.available === false };
      continue;
    }
    weighted += g.score * w;
    totalWeight += w;
    breakdown[name] = { ...g, weight: w, contribution: g.score * w };
  }
  const ruleScore = totalWeight ? (weighted / totalWeight) * 100 : 0;
  for (const k of Object.keys(breakdown)) {
    breakdown[k].contributionPct = totalWeight
      ? (breakdown[k].contribution / totalWeight) * 100 : 0;
  }

  // Đồng thuận: bao nhiêu nhóm CÓ DỮ LIỆU thực sự cùng hướng với điểm tổng.
  // Khác hẳn ngưỡng điểm: |điểm| >= 35 có thể đến từ 2 nhóm mạnh + 4 nhóm trung
  // tính, tức chỉ 2/6 nhóm đồng thuận.
  //
  // CẢNH BÁO: số nhóm có dữ liệu khác nhau giữa chạy thật (6) và backtest (3) —
  // orderBook/derivatives/positioning không có lịch sử theo nến. Vì vậy cùng một
  // ngưỡng % sẽ nghiêm khắc hơn nhiều khi chạy thật.
  const dir = Math.sign(ruleScore);
  const active = Object.values(breakdown).filter((g) => g.weight > 0 && !g.skipped);
  const minGroupScore = strategy.thresholds?.consensusMinGroupScore ?? 0.15;
  const agree = dir === 0 ? 0 : active.filter(
    (g) => Math.sign(g.score) === dir && Math.abs(g.score) >= minGroupScore,
  ).length;

  return {
    ruleScore,
    breakdown,
    consensus: {
      direction: dir > 0 ? 'long' : dir < 0 ? 'short' : 'none',
      agree,
      activeGroups: active.length,
      percent: active.length ? (agree / active.length) * 100 : 0,
      // Tên các nhóm cùng hướng, để nêu lý do.
      agreeing: dir === 0 ? [] : Object.entries(breakdown)
        .filter(([, g]) => g.weight > 0 && !g.skipped
          && Math.sign(g.score) === dir && Math.abs(g.score) >= minGroupScore)
        .map(([name]) => name),
    },
  };
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
  // Không còn ATR trong hệ thống -> khoảng stop loss cơ sở tính theo % giá.
  const baseRisk = price * ((risk.slPercent ?? 2.5) / 100);
  if (signal.side === 'none') {
    return { side: 'none', entry: price, note: 'Không có hướng rõ ràng — chờ tín hiệu.' };
  }
  const isLong = signal.side === 'long';
  let sl = isLong ? price - baseRisk : price + baseRisk;

  // Nếu có S/R gần thì đặt SL ra ngoài mức đó một chút — cấu trúc đáng tin hơn % thuần.
  if (risk.preferSrLevels) {
    const level = isLong ? sr.support[0] : sr.resistance[0];
    if (level) {
      const buffer = baseRisk * 0.3;
      const candidate = isLong ? level.price - buffer : level.price + buffer;
      const dist = Math.abs(price - candidate);
      if (dist > baseRisk * 0.4 && dist < baseRisk * 2.5) sl = candidate;
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
    if (candles.length < MIN_CANDLES) return { interval: htf, note: 'Không đủ lịch sử khung lớn' };
    const ind = computeIndicators(candles, strategy.indicators);
    const sr = supportResistance(candles);
    const { ruleScore } = scoreSignals(candles, ind, strategy, { sr });
    const i = candles.length - 1;
    return {
      interval: htf,
      close: candles[i].close,
      ruleScore: round(ruleScore, 1),
      signal: labelForScore(ruleScore, strategy.thresholds).label,
      cvdSlope: round(ind.cvdSlope[i], 4),
      volumeRatio: round(candles[i].volume / (ind.volumeAvg[i] || 1), 2),
    };
  } catch (err) {
    return { interval: htf, error: err.message };
  }
}

const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));

/**
 * Làm tròn GIÁ theo độ lớn, không dùng số thập phân cố định: BTC ~60.000 và
 * SHIB ~0,0000047 khác thang tới 10 chữ số. Dùng cố định 6 chữ số thập phân sẽ
 * làm mọi mức giá của SHIB bẹt về cùng một con số.
 */
const roundPrice = (v) => {
  if (v == null || !Number.isFinite(v)) return null;
  const a = Math.abs(v);
  const d = a === 0 ? 2 : a < 0.001 ? 10 : a < 1 ? 8 : a < 100 ? 6 : 4;
  return Number(v.toFixed(d));
};

/**
 * Chuỗi dữ liệu để vẽ biểu đồ (chỉ lấy N nến cuối cho nhẹ payload).
 * Tách riêng khỏi snapshot phân tích vì chỉ giao diện web cần.
 */
function buildSeries(candles, ind, bars = 180) {
  const from = Math.max(0, candles.length - bars);
  const window = candles.slice(from);
  // `pick` nhận mảng đầy đủ (cùng độ dài với candles) rồi tự cắt.
  const pick = (arr, d = null) => arr.slice(from).map((v) => (d == null ? roundPrice(v) : round(v, d)));
  const ohlc = (key, d = null) => window.map((c) => (d == null ? roundPrice(c[key]) : round(c[key], d)));
  return {
    bars: window.length,
    time: window.map((c) => c.openTime),
    open: ohlc('open'),
    high: ohlc('high'),
    low: ohlc('low'),
    close: ohlc('close'),
    volume: ohlc('volume', 2),
    volumeAvg: pick(ind.volumeAvg, 2),
    cvd: pick(ind.cvd, 2),
    cvdDelta: pick(ind.cvdDelta, 2),
    cvdSlope: pick(ind.cvdSlope, 4),
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

  const [raw, ticker, derivatives, orderBook, positioning] = await Promise.all([
    fetchKlines(symbol, interval, nCandles),
    fetchTicker24h(symbol).catch(() => null),
    fetchDerivatives(symbol),
    fetchOrderBookImbalance(symbol),
    fetchPositioning(symbol, interval),
  ]);

  const candles = closedCandles(raw);
  // Phần chấm điểm chỉ cần volumeAvg (20) + cvdSlope (20) + pivot (7) -> ~30 nến.
  // ML cần nhiều hơn (features.WARMUP) nhưng nó tự báo thiếu dữ liệu, không chặn
  // cả phân tích — nhờ vậy token mới list vẫn xem được.
  if (candles.length < MIN_CANDLES) {
    throw new Error(`Chỉ có ${candles.length} nến đã đóng — cần tối thiểu ${MIN_CANDLES} nến cho khung ${interval}. Thử khung nhỏ hơn.`);
  }
  const livePrice = raw[raw.length - 1].close;

  const ind = computeIndicators(candles, strategy.indicators);
  const sr = supportResistance(candles);

  const { ruleScore, breakdown, consensus } = scoreSignals(candles, ind, strategy, {
    sr, derivatives, orderBook, positioning,
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
  // Phân kỳ giá vs CVD là cảnh báo xung đột quan trọng nhất còn lại sau khi bỏ ADX.
  {
    const iLast = candles.length - 1;
    const back = ind.params.cvdSlope;
    const slope = ind.cvdSlope[iLast];
    if (slope != null) {
      const priceUp = candles[iLast].close > candles[Math.max(0, iLast - back)].close;
      if (priceUp !== (slope > 0)) {
        conflicts.push(priceUp
          ? `Giá tăng ${back} nến qua nhưng CVD ròng là bán — nhịp tăng thiếu dòng tiền xác nhận`
          : `Giá giảm ${back} nến qua nhưng CVD ròng là mua — có bên hấp thụ, cẩn thận đảo chiều`);
      }
    }
  }
  {
    const iLast = candles.length - 1;
    const ratio = candles[iLast].volume / (ind.volumeAvg[iLast] || 1);
    if (ratio < 0.6) {
      conflicts.push(`Khối lượng chỉ ${ratio.toFixed(2)}x trung bình — tín hiệu giá kém tin cậy`);
    }
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
      volume: round(candles[i].volume, 2),
      volumeAvg: round(ind.volumeAvg[i], 2),
      volumeRatio: round(candles[i].volume / (ind.volumeAvg[i] || 1), 2),
      cvd: round(ind.cvd[i], 2),
      cvdDelta: round(ind.cvdDelta[i], 2),
      // Tỉ lệ mua chủ động trong chính nến cuối, [-1, 1]
      cvdDeltaShare: candles[i].volume
        ? round(ind.cvdDelta[i] / candles[i].volume, 4) : null,
      // Mua/bán chủ động ròng trên cvdSlope nến, chuẩn hoá theo volume cùng kỳ
      cvdSlope: round(ind.cvdSlope[i], 4),
    },
    structure: {
      support: sr.support.map((l) => ({
        price: roundPrice(l.price), touches: l.touches,
        distancePct: round(((l.price - candles[i].close) / candles[i].close) * 100, 2),
      })),
      resistance: sr.resistance.map((l) => ({
        price: roundPrice(l.price), touches: l.touches,
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
    orderBook: orderBook
      ? {
        imbalance: round(orderBook.imbalance, 4),
        bidValue: round(orderBook.bidValue, 2),
        askValue: round(orderBook.askValue, 2),
        spreadPct: round(orderBook.spreadPct, 4),
        depthSpanPct: round(orderBook.depthSpanPct, 3),
        levels: orderBook.levels,
        walls: (orderBook.walls ?? []).map((w) => ({
          side: w.side,
          price: roundPrice(w.price),
          value: round(w.value, 2),
          ratioToAvg: round(w.ratioToAvg, 2),
          distancePct: round(w.distancePct, 3),
        })),
      }
      : null,
    positioning: positioning
      ? {
        period: positioning.period,
        samples: positioning.samples,
        longAccountPercent: round((positioning.longAccountRatio ?? 0) * 100, 2),
        longShortRatio: round(positioning.longShortRatio, 3),
        longAccountChangePoints: round((positioning.longAccountChange ?? 0) * 100, 2),
        topLongPercent: round((positioning.topLongRatio ?? 0) * 100, 2),
        topLongShortRatio: round(positioning.topLongShortRatio, 3),
        takerBuySellRatio: round(positioning.takerBuySellRatio, 3),
      }
      : null,
    rules: {
      score: round(ruleScore, 1),
      consensus: {
        direction: consensus.direction,
        agree: consensus.agree,
        activeGroups: consensus.activeGroups,
        percent: round(consensus.percent, 1),
        agreeing: consensus.agreeing,
      },
      breakdown: Object.fromEntries(Object.entries(breakdown).map(([k, v]) => [k, {
        score: round(v.score, 3),
        weight: v.weight,
        contributionPct: round(v.contributionPct, 2),
        skipped: !!v.skipped,
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
      entry: roundPrice(levels.entry),
      stopLoss: roundPrice(levels.stopLoss),
      riskPercent: round(levels.riskPercent, 2),
      targets: levels.targets?.map((t) => ({ label: t.label, r: t.r, price: roundPrice(t.price) })),
      srTargets: levels.srTargets?.map((t) => ({
        price: roundPrice(t.price), touches: t.touches, distancePct: round(t.distancePct, 2),
      })),
      note: levels.note,
    },
    higherTimeframe: htf,
    conflicts,
    featureNames: FEATURE_NAMES,
    ...(opts.includeSeries ? { series: buildSeries(candles, ind, opts.seriesBars ?? 180) } : {}),
  };
}
