// CLI train:  npm run train -- BTCUSDT 4h
// Phần I/O (đọc cấu hình, ghi model) nằm ở đây, không nằm trong module lõi.

import { loadStrategy } from '../src/config.js';
import { assertAllowedTradeSymbol } from '../src/data/trading-universe.js';
import { trainModel } from '../src/ml/train.js';
import { saveModel } from '../src/ml/model-store.js';

const [symbolArg, intervalArg = '4h'] = process.argv.slice(2);
if (!symbolArg) {
  console.log('Cách dùng: npm run train -- <SYMBOL> [interval]');
  console.log('Ví dụ:     npm run train -- BTCUSDT 4h');
  process.exit(1);
}

const strategy = await loadStrategy();
try {
  const symbol = assertAllowedTradeSymbol(symbolArg, strategy);
  const { payload, verdict } = await trainModel(symbol, intervalArg, strategy, (m) => console.log(m));
  const file = await saveModel(payload.symbol, payload.interval, payload);

  console.log('\n=== KẾT QUẢ ===');
  console.log('Model:', file);
  console.log('Dataset:', payload.dataset.samples, 'mẫu, tỉ lệ tăng',
    `${(payload.dataset.positiveRate * 100).toFixed(1)}%`);
  console.log('Train :', JSON.stringify(payload.metrics.train));
  console.log('Test  :', JSON.stringify(payload.metrics.test));
  console.log('Walk-forward mean AUC:', payload.metrics.walkForward.meanAuc);
  console.log('Tail  :', JSON.stringify(payload.metrics.tail));
  console.log('Mô phỏng:', JSON.stringify(payload.metrics.simulation));
  console.log('\nTop feature:');
  for (const f of payload.importance.slice(0, 10)) {
    console.log(`  ${f.feature.padEnd(18)} ${f.pct.toFixed(1)}%`);
  }
  console.log('\nĐánh giá:', verdict);
} catch (err) {
  console.error('Lỗi:', err.message);
  process.exit(1);
}
