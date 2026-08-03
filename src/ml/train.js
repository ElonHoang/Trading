// Huấn luyện model cho một cặp (symbol, interval).
//
// Module này KHÔNG ghi đĩa và không import gì của Node — nhờ vậy chạy được cả
// trong Node (bot, CLI) lẫn trong browser (Web Worker).
// Phía gọi tự quyết định lưu payload trả về ở đâu.
//
// CLI nằm ở bin/train.js

import { fetchKlinesHistory, normalizeSymbol, INTERVAL_MS } from '../data/binance.js';
import { buildDataset, timeSplit, walkForwardFolds } from './dataset.js';
import {
  fitGBDT, predictProbaBatch, accuracy, auc, logLoss, confidentAccuracy,
  featureImportance, probCalibration,
} from './gbdt.js';
import { closedCandles } from '../analysis/engine.js';

const round = (v, d = 4) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));

function evaluate(model, X, y, margin = 0.12) {
  if (!X.length) return null;
  const probs = predictProbaBatch(model, X);
  const conf = confidentAccuracy(y, probs, margin);
  return {
    samples: X.length,
    positiveRate: round(y.reduce((a, b) => a + b, 0) / y.length),
    accuracy: round(accuracy(y, probs)),
    auc: round(auc(y, probs)),
    logLoss: round(logLoss(y, probs)),
    confidentAccuracy: round(conf.accuracy),
    confidentCoverage: round(conf.coverage),
    confidentSamples: conf.n,
  };
}

/**
 * Độ chính xác ở hai đầu phân phối xác suất (top/bottom 20% theo calibration).
 * Đây là con số quan trọng nhất: nó nói "khi model tự tin nhất thì nó đúng bao nhiêu %".
 */
function tailAccuracy(yTrue, probs, cal) {
  if (!cal) return null;
  let upOk = 0, upN = 0, downOk = 0, downN = 0;
  for (let i = 0; i < probs.length; i++) {
    if (probs[i] >= cal.p80) { upN++; if (yTrue[i] === 1) upOk++; }
    else if (probs[i] <= cal.p20) { downN++; if (yTrue[i] === 0) downOk++; }
  }
  const n = upN + downN;
  return {
    bullishSignals: upN,
    bullishAccuracy: upN ? round(upOk / upN) : null,
    bearishSignals: downN,
    bearishAccuracy: downN ? round(downOk / downN) : null,
    combinedAccuracy: n ? round((upOk + downOk) / n) : null,
    coverage: probs.length ? round(n / probs.length) : null,
  };
}

/**
 * Mô phỏng giao dịch trên tập test: vào lệnh khi xác suất nằm ở hai đầu phân phối.
 * Cố tình thô — chỉ để biết tín hiệu có giá trị dương hay không, không phải backtest thật
 * (backtest có SL/TP nằm ở src/backtest.js).
 */
function simulate(model, test, horizon, cal, feePercent = 0.1) {
  if (!test.meta?.length || !cal) return null;
  const probs = predictProbaBatch(model, test.X);
  let trades = 0, wins = 0, equity = 100;
  let freeAfterIndex = -1; // chỉ số nến mà vị thế trước đã đóng
  let skippedOverlap = 0;

  for (let i = 0; i < probs.length; i++) {
    const p = probs[i];
    const long = p >= cal.p80;
    const short = p <= cal.p20;
    if (!long && !short) continue;

    // KHÔNG cộng dồn các lệnh chồng lấn nhau — nếu không con số lợi nhuận sẽ ảo,
    // vì cùng một đoạn giá bị tính nhiều lần.
    const barIndex = test.meta[i].index;
    if (barIndex <= freeAfterIndex) { skippedOverlap++; continue; }
    freeAfterIndex = barIndex + (test.meta[i].bars ?? horizon);

    const net = (long ? test.meta[i].ret : -test.meta[i].ret) - feePercent * 2;
    trades++;
    if (net > 0) wins++;
    equity *= 1 + net / 100;
  }
  return {
    trades,
    skippedOverlap,
    winRate: trades ? round(wins / trades) : null,
    totalReturnPercent: round(equity - 100, 2),
    avgReturnPerTrade: trades ? round((equity / 100) ** (1 / trades) * 100 - 100, 3) : null,
    note: `Vào lệnh khi xác suất >= ${cal.p80} (long) hoặc <= ${cal.p20} (short), `
      + `giữ tối đa ${horizon} nến, phí ${feePercent}%/chiều, không stoploss, `
      + 'không mở lệnh mới khi lệnh cũ chưa đóng (vốn kép).',
  };
}

/**
 * @param {(msg:string)=>void} [onProgress]
 */
export async function trainModel(symbolInput, interval, strategy, onProgress = () => {}) {
  const symbol = normalizeSymbol(symbolInput);
  if (!INTERVAL_MS[interval]) throw new Error(`Khung thời gian không hợp lệ: ${interval}`);
  const mlCfg = strategy.ml || {};

  onProgress(`Đang tải lịch sử giá ${symbol} ${interval}...`);
  const raw = await fetchKlinesHistory(symbol, interval, mlCfg.trainCandles ?? 5000);
  const candles = closedCandles(raw);
  if (candles.length < 600) {
    throw new Error(`Chỉ tải được ${candles.length} nến — cần tối thiểu 600 nến để train. Hãy thử khung nhỏ hơn.`);
  }
  onProgress(`Đã tải ${candles.length} nến (${new Date(candles[0].openTime).toISOString().slice(0, 10)} → ${new Date(candles[candles.length - 1].openTime).toISOString().slice(0, 10)}). Đang tạo dataset...`);

  const dataset = buildDataset(candles, {
    horizon: mlCfg.horizon ?? 12,
    thresholdMode: mlCfg.thresholdMode ?? 'triple-barrier',
    thresholdPct: mlCfg.thresholdPct ?? 1.5,
    indicatorParams: strategy.indicators,
  });
  if (dataset.X.length < 300) {
    throw new Error(`Chỉ có ${dataset.X.length} mẫu sau khi gán nhãn — quá ít. Giảm ml.thresholdPct hoặc tăng ml.trainCandles.`);
  }

  const params = {
    nTrees: mlCfg.nTrees ?? 400,
    maxDepth: mlCfg.maxDepth ?? 3,
    learningRate: mlCfg.learningRate ?? 0.05,
    lambda: mlCfg.lambda ?? 3.0,
    minChildWeight: mlCfg.minChildWeight ?? 15,
    subsample: mlCfg.subsample ?? 0.7,
    colsample: mlCfg.colsample ?? 0.7,
    earlyStoppingRounds: mlCfg.earlyStoppingRounds ?? 40,
  };

  /** Tách 15% cuối của tập train làm validation cho early stopping. */
  const withEarlyStopping = (trX, trY, seed) => {
    const cut = Math.floor(trX.length * 0.85);
    if (cut < 60 || trX.length - cut < 20) return fitGBDT(trX, trY, { ...params, seed });
    return fitGBDT(trX.slice(0, cut), trY.slice(0, cut), {
      ...params,
      seed,
      valX: trX.slice(cut),
      valY: trY.slice(cut),
      metric: mlCfg.earlyStoppingMetric ?? 'auc',
    });
  };

  onProgress(`${dataset.X.length} mẫu, tỉ lệ tăng ${(dataset.stats.positiveRate * 100).toFixed(1)}%. Đang chạy walk-forward...`);

  // Walk-forward: đánh giá trung thực hơn 1 lần split
  const folds = walkForwardFolds(dataset, 4, 0.4);
  const foldResults = [];
  for (let k = 0; k < folds.length; k++) {
    const f = folds[k];
    const m = withEarlyStopping(f.train.X, f.train.y, 100 + k);
    const ev = evaluate(m, f.test.X, f.test.y);
    if (ev) foldResults.push({ fold: k + 1, trainSamples: f.train.X.length, trees: m.trees.length, ...ev });
    onProgress(`Fold ${k + 1}/${folds.length}: AUC ${ev?.auc ?? '—'}, accuracy ${ev?.accuracy ?? '—'} (${m.trees.length} cây)`);
  }
  const meanAuc = foldResults.length
    ? round(foldResults.reduce((s, f) => s + (f.auc ?? 0.5), 0) / foldResults.length) : null;

  // Model đánh giá: train trên phần đầu, giữ phần cuối làm holdout để báo cáo
  const { train, test } = timeSplit(dataset, mlCfg.trainRatio ?? 0.75);
  onProgress(`Đang train model đánh giá (${train.X.length} mẫu train / ${test.X.length} mẫu test)...`);
  const model = withEarlyStopping(train.X, train.y, 42);
  onProgress(`Early stopping chọn ${model.trees.length} cây (trên tối đa ${params.nTrees}).`);

  const testProbs = predictProbaBatch(model, test.X);
  const calibration = probCalibration(testProbs);

  const metrics = {
    train: evaluate(model, train.X, train.y),
    test: evaluate(model, test.X, test.y),
    tail: tailAccuracy(test.y, testProbs, calibration),
    walkForward: { folds: foldResults, meanAuc },
    simulation: simulate(model, test, mlCfg.horizon ?? 12, calibration),
    earlyStopping: {
      metric: model.valMetric,
      bestScore: model.valScore,
      treesKept: model.trees.length,
      maxTrees: params.nTrees,
    },
  };
  const importance = featureImportance(model, dataset.featureNames);

  // Model production: train lại trên toàn bộ dữ liệu (nhiều dữ liệu hơn = tốt hơn),
  // dùng đúng số cây mà early stopping đã chọn ở trên để không overfit lại.
  // Metrics báo cáo vẫn là của holdout -> không tự lừa mình.
  onProgress(`Đang train lại trên toàn bộ ${dataset.X.length} mẫu với ${model.trees.length} cây...`);
  const finalModel = fitGBDT(dataset.X, dataset.y, {
    ...params,
    nTrees: model.trees.length,
    seed: 7,
  });

  const payload = {
    symbol,
    interval,
    trainedAt: new Date().toISOString(),
    candleRange: {
      from: new Date(candles[0].openTime).toISOString(),
      to: new Date(candles[candles.length - 1].openTime).toISOString(),
      count: candles.length,
    },
    dataset: { ...dataset.stats, featureNames: dataset.featureNames },
    hyperParams: params,
    metrics,
    calibration,
    importance,
    model: finalModel,
  };
  const verdict = (() => {
    const a = metrics.test?.auc;
    const wf = meanAuc;
    const minAuc = mlCfg.minTestAuc ?? 0.52;
    if (a == null) return 'Không đánh giá được.';
    if (wf != null && wf < 0.5 && a >= minAuc) {
      return `KHÔNG ĐÁNG TIN — holdout trông đẹp (AUC ${a}) nhưng walk-forward chỉ ${wf} `
        + '(dưới mức ngẫu nhiên). Đây là dấu hiệu ăn may trên một đoạn dữ liệu. Hệ thống sẽ không dùng ML.';
    }
    if (a < 0.5) return 'KÉM — model dự đoán tệ hơn ngẫu nhiên trên dữ liệu mới. Đừng tin xác suất ML.';
    if (a < minAuc) return `YẾU — AUC ${a} dưới ngưỡng ${minAuc}, hệ thống sẽ không dùng ML để ra quyết định.`;
    if (a < 0.56) return `TẠM ĐƯỢC — có tín hiệu nhưng yếu (AUC ${a}, walk-forward ${wf}). Dùng như một phiếu tham khảo, đừng vào lệnh chỉ vì nó.`;
    return `TỐT — có tín hiệu rõ trên dữ liệu out-of-sample (AUC ${a}, walk-forward ${wf}).`;
  })();

  return { payload, verdict };
}
