// Đọc data/bot-config.json (chỉ Node). Bản GitHub Actions khôi phục file này từ Trading-state
// trước mỗi lượt quét; không có file thì bot dùng đúng cấu hình trong repo.
//
// File này CHỈ ĐỌC: bot không bao giờ ghi lại nó. Nếu bot ghi, một lần lưu từ web diễn ra
// giữa lúc khôi phục và lúc lưu trạng thái sẽ bị lượt quét đang chạy ghi đè bằng bản cũ.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { parseBotConfigText } from './bot-config.js';

export const BOT_CONFIG_FILE = path.join(DATA_DIR, 'bot-config.json');

/** `{ found, config, errors }` — không ném lỗi vì file hỏng; lỗi đọc đĩa thật thì vẫn ném. */
export async function readBotConfig({ file = BOT_CONFIG_FILE } = {}) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { found: false, config: {}, errors: [] };
    throw error;
  }
  return { found: true, ...parseBotConfigText(text) };
}
