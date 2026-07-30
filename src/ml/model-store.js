// Lưu / đọc model đã train. Mỗi cặp (symbol, interval) là một file JSON riêng.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MODELS_DIR = path.join(ROOT, 'models');

const key = (symbol, interval) => `${symbol.toUpperCase()}_${interval}`;
const filePath = (symbol, interval) => path.join(MODELS_DIR, `${key(symbol, interval)}.json`);

export async function saveModel(symbol, interval, payload) {
  await fs.mkdir(MODELS_DIR, { recursive: true });
  const file = filePath(symbol, interval);
  await fs.writeFile(file, JSON.stringify(payload), 'utf8');
  return file;
}

export async function loadModel(symbol, interval) {
  try {
    const raw = await fs.readFile(filePath(symbol, interval), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function listModels() {
  try {
    const files = await fs.readdir(MODELS_DIR);
    const out = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(await fs.readFile(path.join(MODELS_DIR, f), 'utf8'));
        out.push({
          file: f,
          symbol: raw.symbol,
          interval: raw.interval,
          trainedAt: raw.trainedAt,
          samples: raw.dataset?.samples,
          testAuc: raw.metrics?.test?.auc,
          testAccuracy: raw.metrics?.test?.accuracy,
        });
      } catch { /* bỏ qua file lỗi */ }
    }
    return out.sort((a, b) => String(b.trainedAt).localeCompare(String(a.trainedAt)));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

export async function deleteModel(symbol, interval) {
  try {
    await fs.unlink(filePath(symbol, interval));
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}
