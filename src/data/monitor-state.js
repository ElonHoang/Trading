// Trạng thái khử trùng lặp của monitor. Bản GitHub Actions lưu file này vào
// nhánh trạng thái riêng để lần chạy sau không bắn lại tín hiệu cùng một nến.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

const FILE = path.join(DATA_DIR, 'monitor-state.json');

export async function readMonitorState() {
  try {
    const parsed = JSON.parse(await readFile(FILE, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

export async function saveMonitorState(state) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
