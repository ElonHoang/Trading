// Lưu / đọc model đã train. Mỗi cặp (symbol, interval) là một file JSON riêng.

import { deleteDocument, getDocument, listDocuments, putDocument } from '../db.js';

const key = (symbol, interval) => `${symbol.toUpperCase()}_${interval}`;
const documentKey = (symbol, interval) => `model:${key(symbol, interval)}`;

export async function saveModel(symbol, interval, payload) {
  const dbKey = documentKey(symbol, interval);
  await putDocument(dbKey, payload);
  return `database:${dbKey}`;
}

export async function loadModel(symbol, interval) {
  return getDocument(documentKey(symbol, interval), null);
}

export async function listModels() {
  const out = (await listDocuments('model:')).map(({ key: dbKey, value: raw }) => ({
    file: `database:${dbKey}`,
    symbol: raw.symbol,
    interval: raw.interval,
    trainedAt: raw.trainedAt,
    samples: raw.dataset?.samples,
    testAuc: raw.metrics?.test?.auc,
    testAccuracy: raw.metrics?.test?.accuracy,
  }));
  return out.sort((a, b) => String(b.trainedAt).localeCompare(String(a.trainedAt)));
}

export async function deleteModel(symbol, interval) {
  return deleteDocument(documentKey(symbol, interval));
}
