// Danh sách theo dõi lưu ở data/watchlist.json. Dùng chung cho web server và bot.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSymbol } from './binance.js';
import { loadStrategy } from '../config.js';
import { assertAllowedTradeSymbol } from './trading-universe.js';

const FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'watchlist.json',
);

export async function readWatchlist() {
  try {
    const parsed = JSON.parse(await readFile(FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // File chưa có hoặc JSON hỏng -> coi như danh sách rỗng.
    return [];
  }
}

async function save(list) {
  await writeFile(FILE, `${JSON.stringify(list, null, 2)}\n`);
  return list;
}

/** Thêm mã (đã chuẩn hoá). Trả về danh sách mới; thêm trùng thì không đổi gì. */
export async function addSymbol(input) {
  const strategy = await loadStrategy();
  const symbol = assertAllowedTradeSymbol(normalizeSymbol(input), strategy);
  const list = await readWatchlist();
  if (list.includes(symbol)) return list;
  list.push(symbol);
  return save(list);
}

export async function removeSymbol(input) {
  const symbol = String(input || '').trim().toUpperCase();
  const list = await readWatchlist();
  const next = list.filter((s) => s !== symbol);
  return next.length === list.length ? list : save(next);
}
