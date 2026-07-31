// Lưu cấu hình phía browser.
//
// Mặc định đọc từ config/strategy.json trong repo; những gì người dùng sửa được
// lưu riêng thành map "đường dẫn → giá trị" trong localStorage. Nhờ vậy khi repo
// cập nhật mặc định mới, thay đổi của người dùng vẫn còn, và reset rất gọn.

const OVERRIDES_KEY = 'ta.strategy.overrides';
const PROMPT_KEY = 'ta.prompt';
const APIKEY_KEY = 'ta.anthropicKey';

const url = (rel) => new URL(rel, import.meta.url).href;

let defaults = null;
let defaultPrompt = null;

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false; // chế độ riêng tư hoặc hết dung lượng
  }
}

async function getDefaults() {
  if (defaults) return defaults;
  const res = await fetch(url('../config/strategy.json'), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Không tải được config/strategy.json (HTTP ${res.status})`);
  defaults = await res.json();
  return defaults;
}

function setPath(obj, pathStr, value) {
  const parts = pathStr.split('.');
  let node = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) return false;
    node = node[parts[i]];
  }
  const leaf = parts[parts.length - 1];
  if (!(leaf in node)) return false;
  node[leaf] = value;
  return true;
}

function getPath(obj, pathStr) {
  return pathStr.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

/** Cấu hình đang dùng = mặc định + phần người dùng đã sửa. */
export async function loadStrategy() {
  const base = structuredClone(await getDefaults());
  const overrides = readJson(OVERRIDES_KEY, {});
  for (const [p, v] of Object.entries(overrides)) setPath(base, p, v);
  return base;
}

/** Ép giá trị người dùng nhập về đúng kiểu của giá trị mặc định. */
export async function setStrategyValue(pathStr, rawValue) {
  const base = await getDefaults();
  const current = getPath(base, pathStr);
  if (current === undefined) throw new Error(`Không có khoá "${pathStr}"`);

  let value = rawValue;
  if (typeof current === 'number') {
    value = Number(rawValue);
    if (!Number.isFinite(value)) throw new Error(`"${rawValue}" không phải là số`);
  } else if (typeof current === 'boolean') {
    const s = String(rawValue).toLowerCase();
    if (!['true', 'false', '1', '0'].includes(s)) throw new Error(`"${rawValue}" không phải true/false`);
    value = s === 'true' || s === '1';
  } else if (Array.isArray(current)) {
    value = String(rawValue).split(',').map((v) => {
      const n = Number(v.trim());
      return Number.isFinite(n) ? n : v.trim();
    });
  }

  const overrides = readJson(OVERRIDES_KEY, {});
  const strategyNow = await loadStrategy();
  const old = getPath(strategyNow, pathStr);

  // Trùng mặc định thì xoá override cho gọn.
  if (JSON.stringify(value) === JSON.stringify(current)) delete overrides[pathStr];
  else overrides[pathStr] = value;

  if (!writeJson(OVERRIDES_KEY, overrides)) {
    throw new Error('Không lưu được vào localStorage (trình duyệt đang ở chế độ riêng tư?)');
  }
  return { path: pathStr, old, value };
}

export function resetStrategy() {
  try { localStorage.removeItem(OVERRIDES_KEY); } catch { /* bỏ qua */ }
}

export function overrideCount() {
  return Object.keys(readJson(OVERRIDES_KEY, {})).length;
}

export function isOverridden(pathStr) {
  return pathStr in readJson(OVERRIDES_KEY, {});
}

/** Danh sách khoá phẳng để dựng bộ sửa cấu hình (bỏ khoá _note). */
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

// ---------- System prompt ----------

export async function loadPrompt() {
  const saved = localStorage.getItem?.(PROMPT_KEY);
  if (saved) return saved;
  if (defaultPrompt == null) {
    const res = await fetch(url('../config/prompt.md'), { cache: 'no-cache' });
    defaultPrompt = res.ok ? await res.text() : '';
  }
  return defaultPrompt;
}

export function savePrompt(text) {
  try {
    localStorage.setItem(PROMPT_KEY, text);
    return true;
  } catch {
    return false;
  }
}

export function resetPrompt() {
  try { localStorage.removeItem(PROMPT_KEY); } catch { /* bỏ qua */ }
}

export function promptIsCustom() {
  try { return Boolean(localStorage.getItem(PROMPT_KEY)); } catch { return false; }
}

// ---------- API key Claude ----------
// Key chỉ nằm trong localStorage của chính trình duyệt bạn và chỉ được gửi tới
// api.anthropic.com. Trang này là tĩnh, không có backend nào nhận key.

export function getApiKey() {
  try { return localStorage.getItem(APIKEY_KEY) || ''; } catch { return ''; }
}

export function setApiKey(key) {
  try {
    if (key) localStorage.setItem(APIKEY_KEY, key);
    else localStorage.removeItem(APIKEY_KEY);
    return true;
  } catch {
    return false;
  }
}
