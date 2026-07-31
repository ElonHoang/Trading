// Backtest bộ quy tắc + (tuỳ chọn) model ML, có stoploss/take-profit thật.
// Chạy: npm run backtest -- BTCUSDT 4h
//
// Giả định (nói rõ để không tự lừa mình):
//  - Vào lệnh ở giá ĐÓNG của nến cho tín hiệu (không có look-ahead).
//  - Trong cùng một nến, nếu chạm cả SL và TP thì tính là SL (bảo thủ).
//  - Chỉ giữ một vị thế tại một thời điểm.
//  - Trừ phí + slippage mỗi chiều.

import { fetchKlinesHistory, normalizeSymbol, INTERVAL_MS } from './data/binance.js';
import { computeIndicators, supportResistance } from './indicators/index.js';
import { featureVector } from './features.js';
import { predictProba } from './ml/gbdt.js';
import { scoreSignals, labelForScore, buildLevels, closedCandles } from './analysis/engine.js';

const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));

/**
 * @param {object} opts
 *  candles      số nến lịch sử
 *  feePercent   phí mỗi chiều (%)
 *  maxHoldBars  tự đóng lệnh sau bao nhiêu nến
 *  storedModel  payload model ML đã nạp sẵn (null = chỉ chạy quy tắc)
 *  srEvery      tính lại vùng S/R sau mỗi bao nhiêu nến (tiết kiệm CPU)
 */
export async function backtest(symbolInput, interval, strategy, opts = {}) {
  const symbol = normalizeSymbol(symbolInput);
  if (!INTERVAL_MS[interval]) throw new Error(`Khung thời gian không hợp lệ: ${interval}`);
  const {
    candles: wantCandles = 3000,
    feePercent = 0.06,
    maxHoldBars = Math.max(12, (strategy.ml?.horizon ?? 6) * 4),
    storedModel = null,
    srEvery = 5,
    // 'scaled' = chốt 50% ở TP1 rồi kéo SL về entry, phần còn lại chạy tới TP2
    // (đúng như khuyến nghị mà tool xuất ra). 'tp1'/'tp2' = thoát toàn bộ ở một mức.
    exitStrategy = strategy.risk?.exitStrategy ?? 'scaled',
    partialFraction = strategy.risk?.partialFraction ?? 0.5,
    onProgress = () => {},
  } = opts;

  onProgress(`Đang tải ${wantCandles} nến ${symbol} ${interval}...`);
  const raw = await fetchKlinesHistory(symbol, interval, wantCandles);
  const candles = closedCandles(raw);
  if (candles.length < 400) throw new Error(`Chỉ tải được ${candles.length} nến — cần tối thiểu 400.`);

  const ind = computeIndicators(candles, strategy.indicators);
  const stored = storedModel;
  const mlWeight = stored && strategy.ml?.enabled ? (strategy.ml.weightVsRules ?? 0.4) : 0;

  const t = strategy.thresholds;
  const trades = [];
  let position = null;
  let skippedConsensus = 0;
  let srCache = null;
  let srCacheIndex = -999;

  onProgress(`Đang mô phỏng trên ${candles.length} nến${stored ? ' (có model ML)' : ' (chỉ quy tắc)'}...`);

  for (let i = 220; i < candles.length; i++) {
    const c = candles[i];

    // --- Quản lý vị thế đang mở ---
    if (position) {
      const isLong = position.side === 'long';
      const dir = isLong ? 1 : -1;
      const gainAt = (price) => ((price - position.entry) / position.entry) * 100 * dir;
      const hitSl = isLong ? c.low <= position.stopLoss : c.high >= position.stopLoss;
      const hitTp1 = isLong ? c.high >= position.tp1 : c.low <= position.tp1;
      const hitTp2 = isLong ? c.high >= position.tp2 : c.low <= position.tp2;

      let closed = null;

      if (hitSl) {
        // Bảo thủ: nếu trong cùng một nến chạm cả SL và TP thì tính là SL trước.
        closed = { price: position.stopLoss, reason: position.movedSl ? 'về entry (BE)' : 'stoploss' };
      } else if (exitStrategy === 'scaled') {
        if (!position.partialDone && hitTp1) {
          // Chốt 50% ở TP1 rồi kéo SL về entry.
          position.realizedPercent += (gainAt(position.tp1) - feePercent) * position.partialFraction;
          position.remaining = 1 - position.partialFraction;
          position.partialDone = true;
          position.movedSl = true;
          position.stopLoss = position.entry;
        }
        if (position.partialDone && hitTp2) {
          closed = { price: position.tp2, reason: 'take-profit TP2' };
        }
      } else {
        const target = exitStrategy === 'tp2' ? position.tp2 : position.tp1;
        const hit = exitStrategy === 'tp2' ? hitTp2 : hitTp1;
        if (hit) closed = { price: target, reason: `take-profit ${exitStrategy.toUpperCase()}` };
      }

      if (!closed && i - position.entryIndex >= maxHoldBars) {
        closed = { price: c.close, reason: 'hết thời gian giữ' };
      }

      if (closed) {
        const netRemaining = (gainAt(closed.price) - feePercent) * position.remaining;
        const net = position.realizedPercent + netRemaining - feePercent; // phí vào lệnh
        trades.push({
          side: position.side,
          entryTime: new Date(candles[position.entryIndex].openTime).toISOString(),
          exitTime: new Date(c.openTime).toISOString(),
          bars: i - position.entryIndex,
          entry: position.entry,
          exit: closed.price,
          stopLoss: position.stopLoss,
          tp1: position.tp1,
          tp2: position.tp2,
          partialTaken: position.partialDone,
          reason: closed.reason,
          netPercent: round(net, 3),
          score: position.score,
          mlProb: position.mlProb,
        });
        position = null;
      }
      if (position) continue; // vẫn đang giữ lệnh -> không tìm tín hiệu mới
    }

    // --- Tìm tín hiệu mới ---
    if (i - srCacheIndex >= srEvery) {
      srCache = supportResistance(candles.slice(Math.max(0, i - 200), i + 1));
      srCacheIndex = i;
    }
    const { ruleScore, consensus } = scoreSignals(candles, ind, strategy, { sr: srCache }, i);

    let mlProb = null;
    let score = ruleScore;
    if (mlWeight > 0) {
      const fv = featureVector(candles, ind, i);
      if (fv && fv.length === stored.model.nFeatures) {
        mlProb = predictProba(stored.model, fv);
        score = ruleScore * (1 - mlWeight) + (mlProb - 0.5) * 200 * mlWeight;
      }
    }

    const signal = labelForScore(score, t);
    if (signal.side === 'none') continue;

    // Cùng cổng đồng thuận với lúc chạy thật, nếu không backtest sẽ đo một luật
    // khác với luật thực tế bắn kèo.
    // LƯU Ý: ở đây chỉ có 3 nhóm có lịch sử (volume/cvd/structure) — chạy thật có
    // 6 nhóm, nên cùng một % sẽ nghiêm khắc hơn khi chạy thật.
    if (t.consensusPercent != null && consensus.percent < t.consensusPercent) {
      skippedConsensus++;
      continue;
    }

    const levels = buildLevels(candles, ind, srCache, signal, strategy.risk, i);
    if (!levels.stopLoss || !levels.targets?.length) continue;
    const riskPct = Math.abs(c.close - levels.stopLoss) / c.close * 100;
    if (riskPct < 0.1 || riskPct > 20) continue; // SL vô lý -> bỏ qua

    position = {
      side: signal.side,
      entry: c.close,
      entryIndex: i,
      stopLoss: levels.stopLoss,
      tp1: levels.targets[0].price,
      tp2: (levels.targets[1] ?? levels.targets[0]).price,
      remaining: 1,
      realizedPercent: 0,
      partialDone: false,
      movedSl: false,
      partialFraction,
      score: round(score, 1),
      mlProb: mlProb != null ? round(mlProb, 4) : null,
    };
  }

  // --- Thống kê ---
  const stats = summarize(trades, candles, feePercent);
  return {
    symbol,
    interval,
    period: {
      from: new Date(candles[0].openTime).toISOString(),
      to: new Date(candles[candles.length - 1].openTime).toISOString(),
      candles: candles.length,
    },
    settings: {
      feePercent, maxHoldBars, mlWeight, usedModel: Boolean(stored), srEvery,
      exitStrategy, partialFraction: exitStrategy === 'scaled' ? partialFraction : null,
      consensusPercent: t.consensusPercent ?? null,
      // Nói rõ số tín hiệu bị cổng đồng thuận loại — không im lặng cắt bớt.
      skippedByConsensus: skippedConsensus,
      consensusNote: t.consensusPercent != null
        ? 'Backtest chỉ có 3 nhóm có lịch sử (volume/cvd/structure); chạy thật có 6 nhóm nên cùng % sẽ nghiêm khắc hơn'
        : null,
    },
    stats,
    trades: trades.slice(-40),
    allTradeCount: trades.length,
  };
}

function summarize(trades, candles, feePercent) {
  if (!trades.length) {
    return { trades: 0, note: 'Không có lệnh nào — ngưỡng tín hiệu có thể quá cao. Thử giảm thresholds.buy / thresholds.sell.' };
  }
  const nets = trades.map((t) => t.netPercent);
  const wins = nets.filter((v) => v > 0);
  const losses = nets.filter((v) => v <= 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));

  // Vốn hoá kép (mỗi lệnh dùng toàn bộ vốn — chỉ để so sánh tương đối)
  let equity = 100;
  let peak = 100;
  let maxDd = 0;
  const curve = [];
  for (const t of trades) {
    equity *= 1 + t.netPercent / 100;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, ((peak - equity) / peak) * 100);
    curve.push(round(equity, 2));
  }

  const buyHold = ((candles[candles.length - 1].close - candles[220].close) / candles[220].close) * 100;
  const mean = nets.reduce((a, b) => a + b, 0) / nets.length;
  const sd = Math.sqrt(nets.reduce((s, v) => s + (v - mean) ** 2, 0) / nets.length);

  const byReason = {};
  for (const t of trades) byReason[t.reason] = (byReason[t.reason] || 0) + 1;

  const longs = trades.filter((t) => t.side === 'long');
  const shorts = trades.filter((t) => t.side === 'short');
  const wr = (arr) => (arr.length ? round((arr.filter((t) => t.netPercent > 0).length / arr.length) * 100, 1) : null);

  return {
    trades: trades.length,
    winRatePercent: round((wins.length / trades.length) * 100, 1),
    avgWinPercent: wins.length ? round(grossWin / wins.length, 3) : null,
    avgLossPercent: losses.length ? round(-grossLoss / losses.length, 3) : null,
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 2) : null,
    expectancyPercent: round(mean, 3),
    stdDevPercent: round(sd, 3),
    sharpeLike: sd > 0 ? round(mean / sd, 3) : null,
    finalEquity: round(equity, 2),
    totalReturnPercent: round(equity - 100, 2),
    maxDrawdownPercent: round(maxDd, 2),
    buyHoldReturnPercent: round(buyHold, 2),
    beatBuyHold: equity - 100 > buyHold,
    longTrades: longs.length,
    longWinRate: wr(longs),
    shortTrades: shorts.length,
    shortWinRate: wr(shorts),
    exitReasons: byReason,
    feePercentPerSide: feePercent,
    equityCurveTail: curve.slice(-30),
  };
}

