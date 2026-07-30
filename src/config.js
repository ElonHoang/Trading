// Đọc/ghi cấu hình chiến lược. Đây là lớp "setting/training" cho AI:
// mọi thay đổi trọng số, ngưỡng, tham số model đều đi qua đây.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_DIR = path.join(ROOT, 'config');
export const STRATEGY_FILE = path.join(CONFIG_DIR, 'strategy.json');
export const PROMPT_FILE = path.join(CONFIG_DIR, 'prompt.md');
export const DATA_DIR = path.join(ROOT, 'data');

let cache = null;
let cacheMtime = 0;

/** Đọc strategy.json (tự nạp lại khi file thay đổi trên đĩa). */
export async function loadStrategy() {
  const stat = await fs.stat(STRATEGY_FILE);
  if (cache && stat.mtimeMs === cacheMtime) return cache;
  const raw = await fs.readFile(STRATEGY_FILE, 'utf8');
  cache = JSON.parse(raw);
  cacheMtime = stat.mtimeMs;
  return cache;
}

export async function saveStrategy(obj) {
  await fs.writeFile(STRATEGY_FILE, JSON.stringify(obj, null, 2), 'utf8');
  cache = obj;
  cacheMtime = (await fs.stat(STRATEGY_FILE)).mtimeMs;
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
  return fs.readFile(PROMPT_FILE, 'utf8');
}

export async function savePrompt(text) {
  await fs.writeFile(PROMPT_FILE, text, 'utf8');
}

// ---- Lưu watchlist ----

const WATCH_FILE = path.join(DATA_DIR, 'watchlist.json');

export async function loadWatchlist() {
  try {
    return JSON.parse(await fs.readFile(WATCH_FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

export async function saveWatchlist(list) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(WATCH_FILE, JSON.stringify(list, null, 2), 'utf8');
}
