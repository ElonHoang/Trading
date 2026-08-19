// Kèo đang mở được lưu trong PostgreSQL.
//
// Mục đích: một token đã được call thì KHÔNG call lại cho tới khi kèo đó chốt —
// chạm SL, chạm TP cuối, hoặc quá hạn giữ. Không có phần này thì mỗi nến đóng lại
// bắn một kèo mới cho cùng token.
//
// Phải lưu bền vững vì bot restart thường xuyên; giữ trong RAM sẽ mất trạng thái.

import { INTERVAL_MS } from './binance.js';
import { getDocument, updateDocument } from '../db.js';
import { assertAllowedTradeSymbol } from './trading-universe.js';

const KEY = 'data:open-calls';

/** Mỗi symbol chỉ có tối đa một kèo mở. */
export async function readOpenCalls() {
  const parsed = await getDocument(KEY, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

export async function openCall(symbol, {
  interval, side, entry, stopLoss, targets, candleTime, evidence = null,
}, { allowedSymbols } = {}) {
  const allowedSymbol = assertAllowedTradeSymbol(symbol, allowedSymbols);
  return updateDocument(KEY, {}, (map) => {
    map[allowedSymbol] = {
      symbol: allowedSymbol,
      interval,
      side,
      entry,
      stopLoss,
      targets: (targets ?? []).map((t) => ({ label: t.label, price: t.price })),
      openedAtCandle: candleTime,
      openedAt: new Date(candleTime).toISOString(),
      tpHit: [],
      // Bằng chứng được chụp đúng lúc call để phân tích chuỗi SL sau này, không
      // dùng số liệu mới hơn rồi gán ngược cho quyết định cũ.
      evidence,
    };
    return map;
  });
}

/**
 * Lưu message_id của tin nhắn call gốc theo từng chat, để tin cập nhật TP có thể
 * reply vào đúng kèo đó ("trích dẫn lại kèo gốc").
 */
export async function setCallMessages(symbol, messages) {
  return updateDocument(KEY, {}, (map) => {
    if (map[symbol]) map[symbol].messages = messages;
    return map;
  });
}

export async function closeCall(symbol) {
  return updateDocument(KEY, {}, (map) => {
    delete map[symbol];
    return map;
  });
}

async function updateCall(symbol, patch) {
  return updateDocument(KEY, {}, (map) => {
    if (map[symbol]) map[symbol] = { ...map[symbol], ...patch };
    return map;
  });
}

function closedAtCandleEnd(candle, interval) {
  const openTime = Number(candle?.openTime);
  const intervalMs = INTERVAL_MS[interval];
  if (!Number.isFinite(openTime) || !Number.isFinite(intervalMs)) return null;
  // Binance biểu diễn thời điểm đóng bằng mili-giây cuối cùng của cây nến.
  return new Date(openTime + intervalMs - 1).toISOString();
}

/**
 * Đối chiếu kèo đang mở với các nến ĐÃ ĐÓNG xuất hiện sau khi mở kèo.
 *
 * Quy ước bảo thủ giống backtest: nếu một nến chạm CẢ SL và TP thì tính là SL —
 * không biết cái nào xảy ra trước trong nến, giả định xấu cho mình.
 *
 * CHẠM TP1 -> KÉO SL VỀ ENTRY. Đây là luật `exitStrategy: 'scaled'` mà
 * `src/backtest.js` dùng để kiểm chứng chiến lược, và cũng đúng hướng dẫn đã gửi
 * cho người dùng trong tin cập nhật TP ("Dời Stoploss về Entry"). Trước đây phần
 * theo dõi giữ nguyên SL gốc nên một kèo đã đủ TP1 rồi quay đầu vẫn bị ghi là SL
 * đầy đủ — sổ sách nội bộ khác cả backtest lẫn tin đã gửi đi.
 *
 * Vì vậy có thêm trạng thái `breakeven`: thoát ở entry sau khi đã chốt một phần
 * ở TP1. Nó KHÁC `stopped` và không được tính vào chuỗi SL của auto-retune.
 *
 * @returns { status: 'open'|'stopped'|'breakeven'|'target'|'expired',
 *            hitTps, lastPrice, bars, slMovedToEntry, closedAt? }
 */
export async function checkCall(call, candles, { maxHoldBars = 96 } = {}) {
  const isLong = call.side === 'long';
  const after = candles.filter((c) => c.openTime > call.openedAtCandle);
  const targets = call.targets ?? [];
  const firstTp = targets[0];
  const finalTp = targets[targets.length - 1];
  const known = [...(call.tpHit ?? [])];

  // SL-về-entry HẸP HƠN SL gốc, nên không được suy `movedSl` từ `tpHit` đã lưu:
  // làm vậy sẽ áp stop entry cho cả những nến TRƯỚC khi TP1 thật sự chạm và sinh
  // ra lần chạm BE giả. Thứ tự phải được phát lại từ nến mở kèo.
  const replayable = candles.length > 0 && candles[0].openTime <= call.openedAtCandle;
  const hitTps = replayable ? [] : [...known];
  let movedSl = Boolean(firstTp && !replayable && hitTps.includes(firstTp.label));
  let stop = movedSl ? call.entry : call.stopLoss;

  // Cửa sổ nến có thể đã trượt qua lúc mở kèo (bot chỉ nạp một số nến gần nhất);
  // khi đó không phát lại được thứ tự, đành lấy `tpHit` đã lưu làm căn cứ.
  const merge = () => [...new Set([...known, ...hitTps])];

  for (const c of after) {
    const hitSl = isLong ? c.low <= stop : c.high >= stop;
    if (hitSl) {
      return {
        status: movedSl ? 'breakeven' : 'stopped',
        hitTps: merge(),
        lastPrice: stop,
        bars: after.length,
        slMovedToEntry: movedSl,
        closedAt: closedAtCandleEnd(c, call.interval),
      };
    }
    for (const tp of targets) {
      if (hitTps.includes(tp.label)) continue;
      const hit = isLong ? c.high >= tp.price : c.low <= tp.price;
      if (hit) hitTps.push(tp.label);
    }
    // Kéo SL về entry ngay trong nến chạm TP1; từ nến sau trở đi stop là entry.
    if (!movedSl && firstTp && hitTps.includes(firstTp.label)) {
      movedSl = true;
      stop = call.entry;
    }
    if (finalTp && hitTps.includes(finalTp.label)) {
      return {
        status: 'target',
        hitTps: merge(),
        lastPrice: finalTp.price,
        bars: after.length,
        slMovedToEntry: movedSl,
        closedAt: closedAtCandleEnd(c, call.interval),
      };
    }
  }

  const merged = merge();

  // Hết hạn giữ: nếu không có mốc này thì một kèo lửng lơ sẽ chặn token mãi mãi.
  if (after.length >= maxHoldBars) {
    const expiryCandle = after[maxHoldBars - 1];
    return {
      status: 'expired',
      hitTps: merged,
      lastPrice: candles[candles.length - 1]?.close ?? null,
      bars: after.length,
      slMovedToEntry: movedSl,
      closedAt: closedAtCandleEnd(expiryCandle, call.interval),
    };
  }

  if (merged.length !== known.length || movedSl !== Boolean(call.slMovedToEntry)) {
    // `slMovedToEntry` chỉ để hiển thị và tra lại về sau; `stopLoss` gốc được giữ
    // nguyên để lần quét sau còn phát lại được thứ tự nến.
    await updateCall(call.symbol, { tpHit: merged, slMovedToEntry: movedSl });
  }
  return {
    status: 'open',
    hitTps: merged,
    lastPrice: candles[candles.length - 1]?.close ?? null,
    bars: after.length,
    slMovedToEntry: movedSl,
  };
}
