// Kho model phía browser.
//
// Hai nguồn:
//  1. Model đóng gói sẵn trong repo (models/*.json, liệt kê trong models/index.json)
//     — dùng ngay khi mở trang, không cần train.
//  2. Model người dùng tự train — lưu localStorage, ưu tiên hơn bản đóng gói.

const LS_PREFIX = 'ta.model.';
const url = (rel) => new URL(rel, import.meta.url).href;

const key = (symbol, interval) => `${String(symbol).toUpperCase()}_${interval}`;

let manifest = null;

async function getManifest() {
  if (manifest) return manifest;
  try {
    const res = await fetch(url('../models/index.json'), { cache: 'no-cache' });
    manifest = res.ok ? await res.json() : [];
  } catch {
    manifest = [];
  }
  if (!Array.isArray(manifest)) manifest = [];
  return manifest;
}

function localKeys() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(LS_PREFIX)) out.push(k.slice(LS_PREFIX.length));
    }
  } catch { /* riêng tư */ }
  return out;
}

export async function loadModel(symbol, interval) {
  const k = key(symbol, interval);
  try {
    const raw = localStorage.getItem(LS_PREFIX + k);
    if (raw) return JSON.parse(raw);
  } catch { /* bỏ qua, thử bản đóng gói */ }

  const list = await getManifest();
  if (!list.some((m) => key(m.symbol, m.interval) === k)) return null;
  try {
    const res = await fetch(url(`../models/${k}.json`), { cache: 'no-cache' });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export function saveModel(symbol, interval, payload) {
  const k = LS_PREFIX + key(symbol, interval);
  const json = JSON.stringify(payload);
  try {
    localStorage.setItem(k, json);
    return { ok: true, bytes: json.length };
  } catch (err) {
    // Hết dung lượng: xoá model cũ nhất rồi thử lại một lần.
    const existing = localKeys();
    if (existing.length > 1) {
      let oldest = null;
      for (const e of existing) {
        try {
          const p = JSON.parse(localStorage.getItem(LS_PREFIX + e));
          if (!oldest || String(p.trainedAt) < oldest.at) oldest = { k: e, at: String(p.trainedAt) };
        } catch { /* bỏ qua bản lỗi */ }
      }
      if (oldest) {
        try {
          localStorage.removeItem(LS_PREFIX + oldest.k);
          localStorage.setItem(k, json);
          return { ok: true, bytes: json.length, evicted: oldest.k };
        } catch { /* vẫn không đủ */ }
      }
    }
    return { ok: false, error: `Không lưu được model vào localStorage: ${err.name}` };
  }
}

export function deleteModel(symbol, interval) {
  try {
    const k = LS_PREFIX + key(symbol, interval);
    const had = localStorage.getItem(k) != null;
    localStorage.removeItem(k);
    return had;
  } catch {
    return false;
  }
}

/** Model đóng gói + model tự train, gộp lại (bản tự train ghi đè bản đóng gói). */
export async function listModels() {
  const out = new Map();
  for (const m of await getManifest()) {
    out.set(key(m.symbol, m.interval), { ...m, source: 'repo' });
  }
  for (const k of localKeys()) {
    try {
      const p = JSON.parse(localStorage.getItem(LS_PREFIX + k));
      out.set(k, {
        symbol: p.symbol,
        interval: p.interval,
        trainedAt: p.trainedAt,
        samples: p.dataset?.samples,
        testAuc: p.metrics?.test?.auc,
        testAccuracy: p.metrics?.test?.accuracy,
        walkForwardAuc: p.metrics?.walkForward?.meanAuc,
        source: 'local',
      });
    } catch { /* bỏ qua bản lỗi */ }
  }
  return [...out.values()].sort((a, b) => String(b.trainedAt).localeCompare(String(a.trainedAt)));
}
