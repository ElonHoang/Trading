// Kèo đang mở, lưu ở data/open-calls.json (đã gitignore vì là trạng thái riêng
// của từng máy).
//
// Mục đích: một token đã được call thì KHÔNG call lại cho tới khi kèo đó chốt —
// chạm SL, chạm TP cuối, hoặc quá hạn giữ. Không có phần này thì mỗi nến đóng lại
// bắn một kèo mới cho cùng token.
//
// Phải ghi ra đĩa vì bot restart thường xuyên; giữ trong RAM sẽ mất trạng thái
// và call lại toàn bộ.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const FILE = path.join(DIR, 'open-calls.json');

/** Mỗi symbol chỉ có tối đa một kèo mở. */
export async function readOpenCalls() {
  try {
    const parsed = JSON.parse(await readFile(FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function save(map) {
  await mkdir(DIR, { recursive: true });
  await writeFile(FILE, `${JSON.stringify(map, null, 2)}\n`);
  return map;
}

export async function openCall(symbol, { interval, side, entry, stopLoss, targets, candleTime }) {
  const map = await readOpenCalls();
  map[symbol] = {
    symbol,
    interval,
    side,
    entry,
    stopLoss,
    targets: (targets ?? []).map((t) => ({ label: t.label, price: t.price })),
    openedAtCandle: candleTime,
    openedAt: new Date(candleTime).toISOString(),
    tpHit: [],
  };
  return save(map);
}

export async function closeCall(symbol) {
  const map = await readOpenCalls();
  if (!(symbol in map)) return map;
  delete map[symbol];
  return save(map);
}

async function updateCall(symbol, patch) {
  const map = await readOpenCalls();
  if (!map[symbol]) return map;
  map[symbol] = { ...map[symbol], ...patch };
  return save(map);
}

/**
 * Đối chiếu kèo đang mở với các nến ĐÃ ĐÓNG xuất hiện sau khi mở kèo.
 *
 * Quy ước bảo thủ giống backtest: nếu một nến chạm CẢ SL và TP thì tính là SL —
 * không biết cái nào xảy ra trước trong nến, giả định xấu cho mình.
 *
 * @returns { status: 'open'|'stopped'|'target'|'expired', hitTps, lastPrice }
 */
export async function checkCall(call, candles, { maxHoldBars = 96 } = {}) {
  const isLong = call.side === 'long';
  const after = candles.filter((c) => c.openTime > call.openedAtCandle);
  const hitTps = [...(call.tpHit ?? [])];
  const finalTp = call.targets?.[call.targets.length - 1];

  for (const c of after) {
    const hitSl = isLong ? c.low <= call.stopLoss : c.high >= call.stopLoss;
    if (hitSl) {
      return { status: 'stopped', hitTps, lastPrice: call.stopLoss, bars: after.length };
    }
    for (const tp of call.targets ?? []) {
      if (hitTps.includes(tp.label)) continue;
      const hit = isLong ? c.high >= tp.price : c.low <= tp.price;
      if (hit) hitTps.push(tp.label);
    }
    if (finalTp && hitTps.includes(finalTp.label)) {
      return { status: 'target', hitTps, lastPrice: finalTp.price, bars: after.length };
    }
  }

  // Hết hạn giữ: nếu không có mốc này thì một kèo lửng lơ sẽ chặn token mãi mãi.
  if (after.length >= maxHoldBars) {
    return {
      status: 'expired',
      hitTps,
      lastPrice: candles[candles.length - 1]?.close ?? null,
      bars: after.length,
    };
  }

  if (hitTps.length !== (call.tpHit ?? []).length) {
    await updateCall(call.symbol, { tpHit: hitTps });
  }
  return {
    status: 'open',
    hitTps,
    lastPrice: candles[candles.length - 1]?.close ?? null,
    bars: after.length,
  };
}
