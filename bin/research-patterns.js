// Báo cáo nghiên cứu mẫu hình lịch sử cho whitelist trade.
//
// Chạy:
//   npm run research:patterns
//   npm run research:patterns -- BTC 4h
//   npm run research:patterns -- --interval 1h --json
//
// Đây là báo cáo đọc dữ liệu, không tạo kèo hay thay đổi cấu hình.

import { loadStrategy } from '../src/config.js';
import { fetchKlinesHistory, INTERVAL_MS } from '../src/data/binance.js';
import { closedCandles } from '../src/analysis/engine.js';
import {
  analyzeHistoricalPattern, historicalPatternCandleCount,
} from '../src/analysis/historical-pattern.js';
import { assertAllowedTradeSymbol, tradeSymbols } from '../src/data/trading-universe.js';

const args = process.argv.slice(2);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const flagsWithValue = new Set(['--interval', '--symbol']);
const positional = args.filter((arg, i) => (
  !arg.startsWith('--') && !flagsWithValue.has(args[i - 1])
));
const json = args.includes('--json');
const interval = valueOf('--interval') ?? positional[1] ?? '4h';
const symbolInput = valueOf('--symbol') ?? positional[0] ?? null;

if (!INTERVAL_MS[interval]) {
  console.error(`Khung "${interval}" không hợp lệ. Hợp lệ: ${Object.keys(INTERVAL_MS).join(', ')}`);
  process.exit(1);
}

const strategy = await loadStrategy();
const cfg = strategy.historicalPattern ?? {};
const symbols = symbolInput
  ? [assertAllowedTradeSymbol(symbolInput, strategy)]
  : tradeSymbols(strategy);
const candlesNeeded = historicalPatternCandleCount(INTERVAL_MS[interval], cfg);

async function inspect(symbol) {
  try {
    const candles = closedCandles(await fetchKlinesHistory(symbol, interval, candlesNeeded));
    const result = analyzeHistoricalPattern(candles, cfg);
    return {
      symbol,
      interval,
      candles: candles.length,
      market: candles[0]?.market ?? null,
      ...result,
    };
  } catch (error) {
    return {
      symbol,
      interval,
      candles: 0,
      market: null,
      available: false,
      score: 0,
      side: 'none',
      reasons: [`Không tải/đọc được dữ liệu: ${error.message}`],
    };
  }
}

// Tải tuần tự để báo cáo 13 token không làm burst request tới Binance.
const reports = [];
for (const symbol of symbols) reports.push(await inspect(symbol));

if (json) {
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    scope: 'alerts.tradeSymbols',
    interval,
    historyMonths: cfg.maxMonths ?? 6,
    candlesRequestedPerToken: candlesNeeded,
    reports,
  }, null, 2));
  process.exit(0);
}

console.log(`NGHIÊN CỨU MẪU HÌNH LỊCH SỬ · ${interval}`);
console.log(`Phạm vi: ${symbols.length} token trong alerts.tradeSymbols · quét mọi đoạn của tối đa ${cfg.maxMonths ?? 6} tháng gần đây.`);
console.log('So sánh theo OHLC log-tương đối; không so giá tuyệt đối. Đây là thống kê xác nhận, không phải lệnh giao dịch.');

for (const report of reports) {
  console.log(`\n${report.symbol} · ${report.candles} nến${report.market ? ` · ${report.market}` : ''}`);
  if (!report.available) {
    console.log(`  Chưa xác nhận: ${report.reasons?.[0] ?? 'không có mẫu đủ điều kiện'}`);
    if (report.rejected) console.log(`  Loại mẫu: ${JSON.stringify(report.rejected)}`);
    continue;
  }

  const direction = report.side === 'long' ? 'nghiêng TĂNG' : 'nghiêng GIẢM';
  console.log(`  ${report.matched} mẫu · giống TB ${report.avgSimilarity}% · sai số TB ${report.avgRelativePathError}% (P95 ${report.avgP95RelativePathError}%)`);
  console.log(`  ${report.avgBarsWithinRelativeTolerancePercent}% nến nằm trong tolerance · ${direction} sau ${report.futureBars} nến`);
  console.log(`  Diễn biến sau mẫu: TB ${report.avgForwardReturnPct >= 0 ? '+' : ''}${report.avgForwardReturnPct}% · trung vị ${report.medianForwardReturnPct >= 0 ? '+' : ''}${report.medianForwardReturnPct}% · kém nhất theo hướng ${report.worstForwardReturnPct >= 0 ? '+' : ''}${report.worstForwardReturnPct}% · tốt nhất ${report.bestForwardReturnPct >= 0 ? '+' : ''}${report.bestForwardReturnPct}% · đồng thuận ${report.agreementPercent}%`);
  for (const match of (report.matches ?? []).slice(0, 3)) {
    console.log(`   - ${match.at.slice(0, 10)}: giống ${match.similarity}% · sai số ${match.relativePathError}% · sau đó ${match.forwardReturnPct >= 0 ? '+' : ''}${match.forwardReturnPct}%`);
  }
}
