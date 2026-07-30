// Sinh models/index.json — danh mục model đóng gói trong repo.
// Browser không liệt kê được thư mục nên cần file manifest này.
// Chạy: npm run models:index   (chạy lại mỗi khi thêm/xoá model trong models/)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS_DIR = path.join(ROOT, 'models');
const INDEX_FILE = path.join(MODELS_DIR, 'index.json');

let files = [];
try {
  files = await fs.readdir(MODELS_DIR);
} catch {
  console.log('Chưa có thư mục models/ — bỏ qua.');
  process.exit(0);
}

const entries = [];
for (const f of files) {
  if (!f.endsWith('.json') || f === 'index.json') continue;
  const full = path.join(MODELS_DIR, f);
  try {
    const p = JSON.parse(await fs.readFile(full, 'utf8'));
    if (!p.symbol || !p.interval || !p.model) {
      console.warn(`  bỏ qua ${f}: không phải payload model hợp lệ`);
      continue;
    }
    const expected = `${p.symbol.toUpperCase()}_${p.interval}.json`;
    if (f !== expected) {
      console.warn(`  ⚠️  ${f} nên đổi tên thành ${expected} để browser tìm được`);
    }
    entries.push({
      symbol: p.symbol,
      interval: p.interval,
      trainedAt: p.trainedAt,
      samples: p.dataset?.samples ?? null,
      horizon: p.dataset?.horizon ?? null,
      labelMode: p.dataset?.thresholdMode ?? null,
      testAuc: p.metrics?.test?.auc ?? null,
      testAccuracy: p.metrics?.test?.accuracy ?? null,
      walkForwardAuc: p.metrics?.walkForward?.meanAuc ?? null,
      trees: p.model?.trees?.length ?? null,
      sizeKB: Math.round((await fs.stat(full)).size / 1024),
    });
  } catch (err) {
    console.warn(`  bỏ qua ${f}: ${err.message}`);
  }
}

entries.sort((a, b) => `${a.symbol}${a.interval}`.localeCompare(`${b.symbol}${b.interval}`));
await fs.writeFile(INDEX_FILE, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');

console.log(`Đã ghi models/index.json với ${entries.length} model:`);
for (const e of entries) {
  console.log(`  ${e.symbol} ${e.interval}  AUC ${e.testAuc ?? '—'} / wf ${e.walkForwardAuc ?? '—'}  ${e.sizeKB}KB`);
}
