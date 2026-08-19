// Công cụ chuyển dữ liệu cũ vào PostgreSQL MỘT LẦN.
// Runtime không gọi file này và không fallback về JSON sau khi import.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  closeDatabase, ensureDatabase, getDocument, putDocument,
} from '../src/db.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const overwrite = process.argv.includes('--overwrite');

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson(relative) {
  const file = path.join(ROOT, relative);
  if (!await exists(file)) return null;
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function importDocument(key, value) {
  if (value == null) return { key, status: 'missing' };
  if (!overwrite && await getDocument(key) != null) return { key, status: 'kept' };
  await putDocument(key, value);
  return { key, status: 'imported' };
}

async function importModels() {
  const dir = path.join(ROOT, 'models');
  if (!await exists(dir)) return [];
  const rows = [];
  for (const file of await fs.readdir(dir)) {
    if (!file.endsWith('.json') || file === 'index.json') continue;
    const payload = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
    if (!payload?.symbol || !payload?.interval) continue;
    const key = `model:${String(payload.symbol).toUpperCase()}_${payload.interval}`;
    rows.push(await importDocument(key, payload));
  }
  return rows;
}

async function importLearningLogs() {
  const dir = path.join(ROOT, 'data', 'loss-learning');
  if (!await exists(dir)) return [];
  const files = await fs.readdir(dir);
  const dates = new Set(files.map((file) => /^(\d{4}-\d{2}-\d{2})\.(json|txt)$/.exec(file)?.[1]).filter(Boolean));
  const rows = [];
  for (const date of dates) {
    const jsonFile = path.join(dir, `${date}.json`);
    const textFile = path.join(dir, `${date}.txt`);
    const record = await exists(jsonFile) ? JSON.parse(await fs.readFile(jsonFile, 'utf8')) : null;
    const text = await exists(textFile) ? (await fs.readFile(textFile, 'utf8')).trim() : '';
    rows.push(await importDocument(`learning:loss:${date}`, { record, text }));
  }
  return rows;
}

try {
  await ensureDatabase();
  const promptFile = path.join(ROOT, 'config', 'prompt.md');
  const prompt = await exists(promptFile) ? { text: await fs.readFile(promptFile, 'utf8') } : null;
  const rows = [
    await importDocument('config:strategy', await readJson('config/strategy.json')),
    await importDocument('config:prompt', prompt),
    await importDocument('data:watchlist', await readJson('data/watchlist.json')),
    await importDocument('data:subscribers', await readJson('data/alert-chats.json')),
    await importDocument('data:open-calls', await readJson('data/open-calls.json')),
    await importDocument('data:monitor-state', await readJson('data/monitor-state.json')),
    await importDocument('data:auto-retune', await readJson('data/auto-retune.json')),
    ...await importModels(),
    ...await importLearningLogs(),
  ];
  for (const row of rows) console.log(`${row.status.padEnd(8)} ${row.key}`);
  console.log('Import hoàn tất. Runtime từ bây giờ chỉ dùng PostgreSQL.');
} finally {
  await closeDatabase();
}

// Repeatable migration chuẩn hóa các document vừa import sang schema trading.*.
await import('./migrate-db.js');
