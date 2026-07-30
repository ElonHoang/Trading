// Gradient Boosted Decision Trees (kiểu XGBoost, Newton boosting, logistic loss)
// viết thuần JS — không cần Python. Dùng histogram bins nên train nhanh (vài giây
// cho ~5.000 nến x 32 feature x 300 cây).

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sigmoid = (z) => 1 / (1 + Math.exp(-clampZ(z)));
const clampZ = (z) => Math.max(-30, Math.min(30, z));

/** Chia mỗi feature thành các mốc cắt theo phân vị. */
function makeBins(X, nBins) {
  const n = X.length;
  const m = X[0].length;
  const cuts = [];
  const binned = [];
  for (let f = 0; f < m; f++) {
    const col = new Float64Array(n);
    for (let i = 0; i < n; i++) col[i] = X[i][f];
    const sorted = Array.from(col).sort((a, b) => a - b);
    const set = [];
    for (let b = 1; b < nBins; b++) {
      const q = sorted[Math.floor((b / nBins) * (n - 1))];
      if (!set.length || q > set[set.length - 1]) set.push(q);
    }
    cuts.push(set);
    const bins = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      let lo = 0, hi = set.length;
      const x = col[i];
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (x <= set[mid]) hi = mid; else lo = mid + 1;
      }
      bins[i] = lo;
    }
    binned.push(bins);
  }
  return { cuts, binned };
}

function buildTree(binned, cuts, grad, hess, rows, params, rng) {
  const { maxDepth, lambda, minChildWeight, gamma, colsample } = params;
  const m = binned.length;

  function node(idx, depth) {
    let G = 0, H = 0;
    for (const i of idx) { G += grad[i]; H += hess[i]; }
    const leaf = () => ({ v: -G / (H + lambda) });
    if (depth >= maxDepth || idx.length < 2 * minChildWeight) return leaf();

    const baseScore = (G * G) / (H + lambda);
    let best = null;

    const featOrder = [];
    for (let f = 0; f < m; f++) if (rng() < colsample) featOrder.push(f);
    if (!featOrder.length) featOrder.push(Math.floor(rng() * m));

    for (const f of featOrder) {
      const nb = cuts[f].length + 1;
      if (nb < 2) continue;
      const gh = new Float64Array(nb);
      const hh = new Float64Array(nb);
      const bins = binned[f];
      for (const i of idx) { gh[bins[i]] += grad[i]; hh[bins[i]] += hess[i]; }
      let gl = 0, hl = 0;
      for (let b = 0; b < nb - 1; b++) {
        gl += gh[b]; hl += hh[b];
        const gr = G - gl, hr = H - hl;
        if (hl < minChildWeight || hr < minChildWeight) continue;
        const gain = 0.5 * ((gl * gl) / (hl + lambda) + (gr * gr) / (hr + lambda) - baseScore) - gamma;
        if (gain > 0 && (!best || gain > best.gain)) best = { gain, f, bin: b, thr: cuts[f][b] };
      }
    }
    if (!best) return leaf();

    const leftIdx = [], rightIdx = [];
    const bins = binned[best.f];
    for (const i of idx) (bins[i] <= best.bin ? leftIdx : rightIdx).push(i);
    if (!leftIdx.length || !rightIdx.length) return leaf();

    return {
      f: best.f,
      thr: best.thr,
      L: node(leftIdx, depth + 1),
      R: node(rightIdx, depth + 1),
    };
  }
  return node(rows, 0);
}

function predictTree(tree, x) {
  let nd = tree;
  while (nd.v === undefined) nd = x[nd.f] <= nd.thr ? nd.L : nd.R;
  return nd.v;
}

/**
 * Train. X: number[][], y: 0/1[]
 *
 * Nếu truyền `valX`/`valY`, hàm sẽ dừng sớm khi log-loss trên tập validation
 * không cải thiện sau `earlyStoppingRounds` cây, rồi cắt bỏ các cây thừa.
 * Đây là cách chính để chống overfit — dữ liệu giá rất dễ bị học vẹt.
 *
 * Trả về model có thể JSON.stringify.
 */
export function fitGBDT(X, y, options = {}) {
  const p = {
    nTrees: options.nTrees ?? 400,
    maxDepth: options.maxDepth ?? 3,
    learningRate: options.learningRate ?? 0.05,
    lambda: options.lambda ?? 3.0,
    gamma: options.gamma ?? 0.0,
    minChildWeight: options.minChildWeight ?? 15,
    subsample: options.subsample ?? 0.7,
    colsample: options.colsample ?? 0.7,
    nBins: options.nBins ?? 32,
    seed: options.seed ?? 42,
  };
  // metric: 'auc' (mặc định) hay 'logloss'.
  // Dữ liệu giá rất nhiễu — dừng theo log-loss thường ngắt ở 1-2 cây vì log-loss
  // phạt sai lệch hiệu chuẩn, trong khi ta chỉ cần model XẾP HẠNG đúng hướng.
  const { valX, valY, earlyStoppingRounds = 40, metric = 'auc' } = options;
  const n = X.length;
  if (!n) throw new Error('Không có dữ liệu để train');
  const rng = mulberry32(p.seed);
  const { cuts, binned } = makeBins(X, p.nBins);

  const posRate = y.reduce((a, b) => a + b, 0) / n;
  const base = Math.log(Math.max(1e-6, posRate) / Math.max(1e-6, 1 - posRate));

  const pred = new Float64Array(n).fill(base);
  const grad = new Float64Array(n);
  const hess = new Float64Array(n);
  const trees = [];

  const useVal = Array.isArray(valX) && valX.length > 0 && Array.isArray(valY);
  const valPred = useVal ? new Float64Array(valX.length).fill(base) : null;
  const higherIsBetter = metric === 'auc';
  let bestScore = higherIsBetter ? -Infinity : Infinity;
  let bestIteration = p.nTrees;
  let sinceBest = 0;
  const history = [];

  for (let t = 0; t < p.nTrees; t++) {
    for (let i = 0; i < n; i++) {
      const pr = sigmoid(pred[i]);
      grad[i] = pr - y[i];
      hess[i] = Math.max(pr * (1 - pr), 1e-6);
    }
    const rows = [];
    for (let i = 0; i < n; i++) if (rng() < p.subsample) rows.push(i);
    if (rows.length < 20) for (let i = 0; i < n; i++) rows.push(i);

    const tree = buildTree(binned, cuts, grad, hess, rows, p, rng);
    trees.push(tree);
    for (let i = 0; i < n; i++) pred[i] += p.learningRate * predictTree(tree, X[i]);

    if (useVal) {
      let loss = 0;
      for (let i = 0; i < valX.length; i++) {
        valPred[i] += p.learningRate * predictTree(tree, valX[i]);
        const pr = Math.min(1 - 1e-9, Math.max(1e-9, sigmoid(valPred[i])));
        loss += valY[i] ? -Math.log(pr) : -Math.log(1 - pr);
      }
      loss /= valX.length;
      const score = higherIsBetter ? auc(valY, Array.from(valPred)) : loss;
      history.push(Number(score.toFixed(5)));
      const improved = higherIsBetter ? score > bestScore + 1e-5 : score < bestScore - 1e-5;
      if (improved) {
        bestScore = score;
        bestIteration = t + 1;
        sinceBest = 0;
      } else if (++sinceBest >= earlyStoppingRounds) {
        break;
      }
    }
  }

  const kept = useVal ? trees.slice(0, Math.max(1, bestIteration)) : trees;

  return {
    type: 'gbdt',
    base,
    learningRate: p.learningRate,
    trees: kept,
    params: p,
    nFeatures: X[0].length,
    bestIteration: useVal ? bestIteration : trees.length,
    valMetric: useVal ? metric : null,
    valScore: useVal ? Number(bestScore.toFixed(5)) : null,
    valHistoryTail: useVal ? history.slice(-10) : null,
  };
}

/**
 * Phân vị xác suất trên tập holdout. Dùng để định nghĩa "tự tin" một cách
 * tương đối: nếu model chỉ dao động 0.48-0.52 thì 0.52 ĐÃ là tín hiệu mạnh
 * của model đó, không thể so với ngưỡng tuyệt đối 0.62.
 */
export function probCalibration(probs) {
  if (!probs.length) return null;
  const sorted = [...probs].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
  const mean = probs.reduce((a, b) => a + b, 0) / probs.length;
  const std = Math.sqrt(probs.reduce((s, v) => s + (v - mean) ** 2, 0) / probs.length);
  return {
    n: probs.length,
    p05: round5(q(0.05)), p20: round5(q(0.20)), p50: round5(q(0.50)),
    p80: round5(q(0.80)), p95: round5(q(0.95)),
    mean: round5(mean), std: round5(std),
  };
}
const round5 = (v) => Number(v.toFixed(5));

/** Xác suất lớp 1 cho một vector. */
export function predictProba(model, x) {
  let z = model.base;
  for (const tree of model.trees) z += model.learningRate * predictTree(tree, x);
  return sigmoid(z);
}

export function predictProbaBatch(model, X) {
  return X.map((x) => predictProba(model, x));
}

/** Độ quan trọng feature = tổng số lần được dùng để chia (weight importance). */
export function featureImportance(model, names) {
  const counts = new Array(model.nFeatures).fill(0);
  const walk = (nd) => {
    if (nd.v !== undefined) return;
    counts[nd.f]++;
    walk(nd.L); walk(nd.R);
  };
  for (const t of model.trees) walk(t);
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  return counts
    .map((c, i) => ({ feature: names?.[i] ?? `f${i}`, count: c, pct: (c / total) * 100 }))
    .sort((a, b) => b.count - a.count);
}

// ---- Metrics ----

export function logLoss(yTrue, probs) {
  let s = 0;
  for (let i = 0; i < yTrue.length; i++) {
    const p = Math.min(1 - 1e-9, Math.max(1e-9, probs[i]));
    s += yTrue[i] ? -Math.log(p) : -Math.log(1 - p);
  }
  return s / yTrue.length;
}

export function accuracy(yTrue, probs, threshold = 0.5) {
  let ok = 0;
  for (let i = 0; i < yTrue.length; i++) if ((probs[i] >= threshold ? 1 : 0) === yTrue[i]) ok++;
  return ok / yTrue.length;
}

/** AUC bằng thống kê Mann–Whitney (xử lý cả giá trị bằng nhau). */
export function auc(yTrue, probs) {
  const pairs = probs.map((p, i) => ({ p, y: yTrue[i] })).sort((a, b) => a.p - b.p);
  let i = 0;
  const ranks = new Array(pairs.length);
  while (i < pairs.length) {
    let j = i;
    while (j + 1 < pairs.length && pairs[j + 1].p === pairs[i].p) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = avgRank;
    i = j + 1;
  }
  let sumPosRank = 0, nPos = 0, nNeg = 0;
  for (let k = 0; k < pairs.length; k++) {
    if (pairs[k].y === 1) { sumPosRank += ranks[k]; nPos++; } else nNeg++;
  }
  if (!nPos || !nNeg) return 0.5;
  return (sumPosRank - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

/** Độ chính xác chỉ trên các dự đoán "tự tin" (prob xa 0.5) — quan trọng khi giao dịch. */
export function confidentAccuracy(yTrue, probs, margin = 0.15) {
  let ok = 0, total = 0;
  for (let i = 0; i < yTrue.length; i++) {
    if (Math.abs(probs[i] - 0.5) < margin) continue;
    total++;
    if ((probs[i] >= 0.5 ? 1 : 0) === yTrue[i]) ok++;
  }
  return { accuracy: total ? ok / total : null, coverage: total / yTrue.length, n: total };
}
