// Danh sách theo dõi lưu trong PostgreSQL, dùng chung cho web server và bot.

import { normalizeSymbol } from './binance.js';
import { loadStrategy } from '../config.js';
import { getDocument, updateDocument } from '../db.js';
import { assertAllowedTradeSymbol } from './trading-universe.js';

const KEY = 'data:watchlist';

export async function readWatchlist() {
  const parsed = await getDocument(KEY, []);
  return Array.isArray(parsed) ? parsed : [];
}

/** Thêm mã (đã chuẩn hoá). Trả về danh sách mới; thêm trùng thì không đổi gì. */
export async function addSymbol(input) {
  const strategy = await loadStrategy();
  const symbol = assertAllowedTradeSymbol(normalizeSymbol(input), strategy);
  return updateDocument(KEY, [], (list) => {
    const safe = Array.isArray(list) ? list : [];
    if (!safe.includes(symbol)) safe.push(symbol);
    return safe;
  });
}

export async function removeSymbol(input) {
  const symbol = String(input || '').trim().toUpperCase();
  return updateDocument(KEY, [], (list) => (
    (Array.isArray(list) ? list : []).filter((s) => s !== symbol)
  ));
}
