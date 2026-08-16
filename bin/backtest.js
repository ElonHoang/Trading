// CLI backtest:  npm run backtest -- BTCUSDT 4h 3000

import { loadStrategy } from '../src/config.js';
import { backtest } from '../src/backtest.js';
import { loadModel } from '../src/ml/model-store.js';
import { normalizeSymbol } from '../src/data/binance.js';
import { assertAllowedTradeSymbol } from '../src/data/trading-universe.js';
import { fmtNum } from '../src/analysis/engine.js';
import { applyActiveTuning, readAutoRetuneState } from '../src/analysis/auto-retune.js';

const [symbolArg, intervalArg = '4h', candlesArg] = process.argv.slice(2);
if (!symbolArg) {
  console.log('Cách dùng: npm run backtest -- <SYMBOL> [interval] [số nến]');
  process.exit(1);
}

const state = await readAutoRetuneState();
const strategy = applyActiveTuning(await loadStrategy(), state);
try {
  const symbol = normalizeSymbol(symbolArg);
  assertAllowedTradeSymbol(symbol, strategy);
  const r = await backtest(symbol, intervalArg, strategy, {
    candles: candlesArg ? Number(candlesArg) : 3000,
    storedModel: await loadModel(symbol, intervalArg),
    onProgress: (m) => console.log(m),
  });

  console.log(`\n=== BACKTEST ${r.symbol} ${r.interval} ===`);
  console.log(`Giai đoạn: ${r.period.from.slice(0, 10)} → ${r.period.to.slice(0, 10)} (${r.period.candles} nến)`);
  if (r.settings.historicalPatternWarmupApplied) {
    console.log(`Mẫu lịch sử: dùng ${r.period.warmupCandles} nến warm-up; đánh giá thực tế ${r.settings.effectiveEvaluationCandles}/${r.settings.requestedEvaluationCandles} nến`
      + (r.settings.historicalPatternHistoryLimitedByApi ? ' (bị giới hạn 20.000 nến API)' : ''));
  }
  console.log(`Cấu hình : phí ${r.settings.feePercent}%/chiều, giữ tối đa ${r.settings.maxHoldBars} nến, `
    + `thoát "${r.settings.exitStrategy}", `
    + `trọng số ML ${r.settings.mlWeight}${r.settings.usedModel ? '' : ' (chưa có model)'}`);
  if (state.activeTuning?.changes) {
    console.log(`Tự sửa   : ${Object.entries(state.activeTuning.changes)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' · ')}`);
  }
  console.log('');
  for (const [k, v] of Object.entries(r.stats)) {
    if (k === 'equityCurveTail') continue;
    console.log(`  ${k.padEnd(24)} ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  }
  console.log('\n5 lệnh gần nhất:');
  for (const t of r.trades.slice(-5)) {
    console.log(`  ${t.entryTime.slice(0, 16)} ${t.side.padEnd(5)} `
      + `${fmtNum(t.entry)} → ${fmtNum(t.exit)}  ${String(t.netPercent).padStart(7)}%  ${t.reason}`);
  }
} catch (err) {
  console.error('Lỗi:', err.message);
  process.exit(1);
}
