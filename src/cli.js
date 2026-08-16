// Chạy phân tích ngay trong terminal — tiện để test trước khi cắm vào Telegram.
//   npm run analyze -- BTC 4h
//   npm run analyze -- ETH 1h --no-ai      (chỉ chỉ báo + ML, không gọi Claude)

import { resolveSymbol, INTERVAL_MS } from './data/binance.js';
import { assertAllowedTradeSymbol } from './data/trading-universe.js';
import { loadStrategy } from './config.js';
import { loadModel } from './ml/model-store.js';
import { analyze } from './analysis/engine.js';
import { generateReport, hasApiKey } from './llm/claude.js';
import { formatQuick, formatBreakdown } from './format.js';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));
const [symbolArg, intervalArg = '4h'] = positional;

if (!symbolArg) {
  console.log('Cách dùng: npm run analyze -- <SYMBOL> [interval] [--no-ai] [--detail]');
  console.log(`Interval hợp lệ: ${Object.keys(INTERVAL_MS).join(', ')}`);
  process.exit(1);
}

const symbol = await resolveSymbol(symbolArg);
const strategy = await loadStrategy();
assertAllowedTradeSymbol(symbol, strategy);

try {
  console.log(`Đang phân tích ${symbol} ${intervalArg}...\n`);
  const snapshot = await analyze(symbol, intervalArg, strategy, {
    storedModel: await loadModel(symbol, intervalArg),
  });
  console.log(formatQuick(snapshot));

  if (flags.has('--detail')) {
    console.log('\n' + formatBreakdown(snapshot));
  }

  const wantAi = !flags.has('--no-ai') && strategy.llm?.enabled !== false;
  if (wantAi && hasApiKey()) {
    console.log('\n────────────────────────────────\n🤖 Đang hỏi Claude...\n');
    const report = await generateReport(snapshot, strategy);
    if (report.refusal) console.log('Claude từ chối trả lời:', report.refusal);
    else {
      console.log(report.text);
      console.log(`\n[${report.model} · ${report.usage.inputTokens} token vào / ${report.usage.outputTokens} token ra]`);
    }
  } else if (wantAi) {
    console.log('\n(Bỏ qua phần AI: chưa cấu hình ANTHROPIC_API_KEY)');
  }
} catch (err) {
  console.error('Lỗi:', err.message);
  process.exit(1);
}
