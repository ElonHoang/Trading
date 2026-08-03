// Trạng thái chống gửi trùng của vòng quét Telegram.
//
// File này được GitHub Actions đồng bộ với repo Trading-state private.  Không
// đưa vào source repo: trạng thái khác nhau theo từng môi trường chạy bot.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

const FILE = path.join(DATA_DIR, 'monitor-state.json');

export async function readMonitorState() {
  try {
    const value = JSON.parse(await readFile(FILE, 'utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') {
      throw new Error('monitor-state.json không hợp lệ');
    }
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

export async function saveMonitorState(state) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
