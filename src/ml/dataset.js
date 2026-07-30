// Tạo dataset huấn luyện từ nến: features (quá khứ) -> label (tương lai).

import { computeIndicators } from '../indicators/index.js';
import { featureVector, FEATURE_NAMES } from '../features.js';

/**
 * Gán nhãn cho từng nến.
 *
 * thresholdMode:
 *  - 'triple-barrier' (khuyến nghị): đặt hai rào TP/SL cách entry `atrMult` lần ATR.
 *    Đi tới trước tối đa `horizon` nến xem rào nào bị chạm TRƯỚC.
 *    label 1 = rào trên chạm trước, 0 = rào dưới chạm trước, bỏ mẫu nếu không chạm rào nào.
 *    Nhãn này khớp đúng với cách tool sinh SL/TP, nên xác suất model trả về
 *    đọc được là "khả năng ăn TP trước khi ăn SL".
 *  - 'atr': label theo lợi nhuận sau đúng `horizon` nến, ngưỡng nhiễu = atrMult*ATR%*sqrt(horizon).
 *  - 'fixed': như trên nhưng ngưỡng cố định = thresholdPct (%).
 */
export function buildDataset(candles, opts = {}) {
  const {
    horizon = 6,
    thresholdMode = 'triple-barrier',
    atrMult = 1.0,
    thresholdPct = 1.5,
    indicatorParams = {},
  } = opts;

  const ind = computeIndicators(candles, indicatorParams);
  const X = [];
  const y = [];
  const meta = [];
  let skippedNeutral = 0;
  let skippedAmbiguous = 0;

  for (let i = 0; i < candles.length - horizon; i++) {
    const fv = featureVector(candles, ind, i);
    if (!fv) continue;
    const entry = candles[i].close;
    const atrVal = ind.atr[i];
    if (!atrVal) continue;

    if (thresholdMode === 'triple-barrier') {
      const dist = atrMult * atrVal;
      const upper = entry + dist;
      const lower = entry - dist;
      let label = null;
      let bars = 0;
      for (let j = i + 1; j <= i + horizon; j++) {
        const c = candles[j];
        const hitUp = c.high >= upper;
        const hitDown = c.low <= lower;
        bars = j - i;
        if (hitUp && hitDown) { label = 'ambiguous'; break; } // không biết rào nào trước
        if (hitUp) { label = 1; break; }
        if (hitDown) { label = 0; break; }
      }
      if (label === null) { skippedNeutral++; continue; }
      if (label === 'ambiguous') { skippedAmbiguous++; continue; }
      X.push(fv);
      y.push(label);
      meta.push({
        index: i,
        time: candles[i].openTime,
        bars,
        ret: label === 1 ? (dist / entry) * 100 : -(dist / entry) * 100,
        threshold: (dist / entry) * 100,
      });
      continue;
    }

    const exit = candles[i + horizon].close;
    const ret = ((exit - entry) / entry) * 100;
    let thr;
    if (thresholdMode === 'atr') {
      thr = atrMult * ((atrVal / entry) * 100) * Math.sqrt(horizon);
    } else {
      thr = thresholdPct;
    }
    thr = Math.max(thr, 0.2);
    if (Math.abs(ret) < thr) { skippedNeutral++; continue; }
    X.push(fv);
    y.push(ret > 0 ? 1 : 0);
    meta.push({ index: i, time: candles[i].openTime, bars: horizon, ret, threshold: thr });
  }

  return {
    X,
    y,
    meta,
    featureNames: FEATURE_NAMES,
    stats: {
      samples: X.length,
      skippedNeutral,
      skippedAmbiguous,
      positiveRate: y.length ? y.reduce((a, b) => a + b, 0) / y.length : 0,
      horizon,
      thresholdMode,
      atrMult,
    },
  };
}

/** Chia theo thời gian (KHÔNG shuffle — shuffle dữ liệu chuỗi thời gian là gian lận). */
export function timeSplit(dataset, trainRatio = 0.75) {
  const cut = Math.floor(dataset.X.length * trainRatio);
  return {
    train: { X: dataset.X.slice(0, cut), y: dataset.y.slice(0, cut), meta: dataset.meta.slice(0, cut) },
    test: { X: dataset.X.slice(cut), y: dataset.y.slice(cut), meta: dataset.meta.slice(cut) },
  };
}

/** Walk-forward: nhiều fold liên tiếp theo thời gian, mô phỏng cách dùng thực tế. */
export function walkForwardFolds(dataset, folds = 4, minTrain = 0.4) {
  const n = dataset.X.length;
  const out = [];
  const startTrain = Math.floor(n * minTrain);
  const step = Math.floor((n - startTrain) / folds);
  if (step < 30) return out;
  for (let k = 0; k < folds; k++) {
    const trainEnd = startTrain + k * step;
    const testEnd = k === folds - 1 ? n : trainEnd + step;
    out.push({
      train: { X: dataset.X.slice(0, trainEnd), y: dataset.y.slice(0, trainEnd) },
      test: {
        X: dataset.X.slice(trainEnd, testEnd),
        y: dataset.y.slice(trainEnd, testEnd),
        meta: dataset.meta.slice(trainEnd, testEnd),
      },
    });
  }
  return out;
}
