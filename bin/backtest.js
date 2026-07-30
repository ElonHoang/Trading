// CLI backtest:  npm run backtest -- BTCUSDT 4h 3000

import { loadStrategy } from '../src/config.js';
import { backtest } from '../src/backtest.js';
import { loadModel } from '../src/ml/model-store.js';
import { normalizeSymbol } from '../src/data/binance.js';
import { fmtNum } from '../src/analysis/engine.js';

const [symbolArg, intervalArg = '4h', candlesArg] = process.argv.slice(2);
if (!symbolArg) {
  console.log('Cách dùng: npm run backtest -- <SYMBOL> [interval] [số nến]');
  process.exit(1);
}

const strategy = await loadStrategy();
try {
  const symbol = normalizeSymbol(symbolArg);
  const r = await backtest(symbol, intervalArg, strategy, {
    candles: candlesArg ? Number(candlesArg) : 3000,
    storedModel: await loadModel(symbol, intervalArg),
    onProgress: (m) => console.log(m),
  });

  console.log(`\n=== BACKTEST ${r.symbol} ${r.interval} ===`);
  console.log(`Giai đoạn: ${r.period.from.slice(0, 10)} → ${r.period.to.slice(0, 10)} (${r.period.candles} nến)`);
  console.log(`Cấu hình : phí ${r.settings.feePercent}%/chiều, giữ tối đa ${r.settings.maxHoldBars} nến, `
    + `thoát "${r.settings.exitStrategy}", `
    + `trọng số ML ${r.settings.mlWeight}${r.settings.usedModel ? '' : ' (chưa có model)'}`);
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
