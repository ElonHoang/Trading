// Danh sách chat Telegram đã bật cảnh báo tự động.
// File này chứa chat id (dữ liệu cá nhân) nên nằm trong .gitignore.

import { getDocument, updateDocument } from '../db.js';

const KEY = 'data:subscribers';

export async function readSubscribers() {
  const parsed = await getDocument(KEY, []);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

export async function addSubscriber(chatId) {
  const id = String(chatId);
  return updateDocument(KEY, [], (list) => {
    const safe = Array.isArray(list) ? list.map(String) : [];
    if (!safe.includes(id)) safe.push(id);
    return safe;
  });
}

export async function removeSubscriber(chatId) {
  const id = String(chatId);
  return updateDocument(KEY, [], (list) => (
    (Array.isArray(list) ? list : []).map(String).filter((x) => x !== id)
  ));
}
