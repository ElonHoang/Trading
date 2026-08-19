// Đọc/ghi cấu hình chiến lược. Đây là lớp "setting/training" cho AI:
// mọi thay đổi trọng số, ngưỡng, tham số model đều đi qua đây.

import { getDocument, putDocument, requireDocument } from './db.js';

const STRATEGY_KEY = 'config:strategy';
const PROMPT_KEY = 'config:prompt';
const WATCHLIST_KEY = 'data:watchlist';

/** Database là nguồn cấu hình duy nhất. */
export async function loadStrategy() {
  return requireDocument(STRATEGY_KEY, 'cấu hình strategy');
}

export async function saveStrategy(obj) {
  return putDocument(STRATEGY_KEY, obj);
}

/**
 * Đặt một giá trị theo đường dẫn dạng "weights.trend" hoặc "ml.nTrees".
 * Chỉ cho phép ghi vào khoá đã tồn tại -> tránh gõ sai tạo ra khoá rác.
 */
export async function setStrategyValue(pathStr, rawValue) {
  const strategy = JSON.parse(JSON.stringify(await loadStrategy()));
  const parts = pathStr.split('.').filter(Boolean);
  if (!parts.length) throw new Error('Đường dẫn trống');

  let node = strategy;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) {
      throw new Error(`Không tìm thấy nhóm cấu hình "${parts.slice(0, i + 1).join('.')}"`);
    }
    node = node[parts[i]];
  }
  const leaf = parts[parts.length - 1];
  if (!(leaf in node)) {
    throw new Error(`Không có khoá "${pathStr}". Dùng /config để xem danh sách khoá hợp lệ.`);
  }

  const current = node[leaf];
  let value = rawValue;
  if (typeof current === 'number') {
    value = Number(rawValue);
    if (!Number.isFinite(value)) throw new Error(`"${rawValue}" không phải là số`);
  } else if (typeof current === 'boolean') {
    const s = String(rawValue).toLowerCase();
    if (!['true', 'false', '1', '0', 'on', 'off'].includes(s)) {
      throw new Error(`"${rawValue}" không phải true/false`);
    }
    value = ['true', '1', 'on'].includes(s);
  } else if (Array.isArray(current)) {
    value = String(rawValue).split(',').map((v) => {
      const n = Number(v.trim());
      return Number.isFinite(n) ? n : v.trim();
    });
  }

  const old = node[leaf];
  node[leaf] = value;
  await saveStrategy(strategy);
  return { path: pathStr, old, value };
}

/** Danh sách khoá có thể sửa (bỏ các khoá _note). */
export function flattenStrategy(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('_')) continue;
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...flattenStrategy(v, p));
    else out.push({ path: p, value: v });
  }
  return out;
}

export async function loadPrompt() {
  const row = await requireDocument(PROMPT_KEY, 'system prompt');
  return typeof row === 'string' ? row : row.text;
}

export async function savePrompt(text) {
  return putDocument(PROMPT_KEY, { text });
}

// ---- Lưu watchlist ----

export async function loadWatchlist() {
  const list = await getDocument(WATCHLIST_KEY, []);
  return Array.isArray(list) ? list : [];
}

export async function saveWatchlist(list) {
  return putDocument(WATCHLIST_KEY, list);
}
