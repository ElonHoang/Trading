// Trạng thái khử trùng lặp của monitor. Bản GitHub Actions lưu file này vào
// nhánh trạng thái riêng để lần chạy sau không bắn lại tín hiệu cùng một nến.

import { getDocument, putDocument } from '../db.js';

const KEY = 'data:monitor-state';

export async function readMonitorState() {
  const parsed = await getDocument(KEY, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

export async function saveMonitorState(state) {
  return putDocument(KEY, state);
}
