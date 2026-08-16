// Phân tích đặc điểm vào lệnh của các lệnh bị stoploss trong backtest.
// Chạy: npm run diagnose:sl -- BTC 4h 3000

import { loadStrategy } from '../src/config.js';
import { backtest } from '../src/backtest.js';
import { loadModel } from '../src/ml/model-store.js';
import { normalizeSymbol } from '../src/data/binance.js';
import { assertAllowedTradeSymbol } from '../src/data/trading-universe.js';

const [symbolArg, interval = '4h', candlesArg = '3000'] = process.argv.slice(2);
if (!symbolArg) {
  console.log('Cách dùng: npm run diagnose:sl -- <SYMBOL> [khung] [số nến]');
  process.exit(1);
}

const mean = (rows, pick) => (rows.length
  ? Number((rows.reduce((sum, row) => sum + (Number(pick(row)) || 0), 0) / rows.length).toFixed(3))
  : null);

function summarize(rows) {
  const groupKeys = ['cvd', 'volume', 'structure', 'historicalPattern'];
  return {
    count: rows.length,
    long: rows.filter((t) => t.side === 'long').length,
    short: rows.filter((t) => t.side === 'short').length,
    averageScore: mean(rows, (t) => t.entryDiagnostics.combinedScore),
    averageConsensusPercent: mean(rows, (t) => t.entryDiagnostics.consensusPercent),
    averageVolumeRatio: mean(rows, (t) => t.entryDiagnostics.volumeRatio),
    averageCvdSlope: mean(rows, (t) => t.entryDiagnostics.cvdSlope),
    averagePriceChange20Pct: mean(rows, (t) => t.entryDiagnostics.priceChange20Pct),
    averageRangePosition50: mean(rows, (t) => t.entryDiagnostics.rangePosition50),
    groupScores: Object.fromEntries(groupKeys.map((key) => [
      key,
      mean(rows, (t) => t.entryDiagnostics.groupScores[key]),
    ])),
    flags: {
      lowVolumeBelow0_8: rows.filter((t) => t.entryDiagnostics.volumeRatio < 0.8).length,
      cvdAgainstEntry: rows.filter((t) => (
        (t.side === 'long' && t.entryDiagnostics.cvdSlope < 0)
        || (t.side === 'short' && t.entryDiagnostics.cvdSlope > 0)
      )).length,
      entryAtOppositeRangeExtreme: rows.filter((t) => (
        (t.side === 'long' && t.entryDiagnostics.rangePosition50 > 0.8)
        || (t.side === 'short' && t.entryDiagnostics.rangePosition50 < 0.2)
      )).length,
    },
  };
}

const strategy = await loadStrategy();
const symbol = normalizeSymbol(symbolArg);
assertAllowedTradeSymbol(symbol, strategy);
const result = await backtest(symbol, interval, strategy, {
  candles: Number(candlesArg),
  storedModel: await loadModel(symbol, interval),
  includeAllTrades: true,
  onProgress: (message) => console.log(message),
});

const stopLosses = result.trades.filter((trade) => trade.reason === 'stoploss');
const profitable = result.trades.filter((trade) => trade.netPercent > 0);

console.log(JSON.stringify({
  period: result.period,
  settings: result.settings,
  allTrades: summarize(result.trades),
  stopLosses: summarize(stopLosses),
  profitableTrades: summarize(profitable),
  stopLossEntries: stopLosses.map((trade) => ({
    entryTime: trade.entryTime,
    side: trade.side,
    netPercent: trade.netPercent,
    score: trade.score,
    diagnostics: trade.entryDiagnostics,
  })),
}, null, 2));
