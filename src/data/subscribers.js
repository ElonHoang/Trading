// Danh sách chat Telegram đã bật cảnh báo tự động.
// File này chứa chat id (dữ liệu cá nhân) nên nằm trong .gitignore.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const FILE = path.join(DIR, 'alert-chats.json');

export async function readSubscribers() {
  try {
    const parsed = JSON.parse(await readFile(FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

async function save(list) {
  await mkdir(DIR, { recursive: true });
  await writeFile(FILE, `${JSON.stringify(list, null, 2)}\n`);
  return list;
}

export async function addSubscriber(chatId) {
  const id = String(chatId);
  const list = await readSubscribers();
  if (list.includes(id)) return list;
  list.push(id);
  return save(list);
}

export async function removeSubscriber(chatId) {
  const id = String(chatId);
  const list = await readSubscribers();
  const next = list.filter((x) => x !== id);
  return next.length === list.length ? list : save(next);
}
