// Danh sách mã được phép tạo kèo. Nguồn cấu hình là alerts.tradeSymbols
// trong strategy của database để có thể mở rộng có chủ đích sau này.

import { normalizeSymbol } from './binance.js';

/**
 * Chuẩn hoá danh sách cấu hình thành các cặp USDT, loại mã trùng và fail-closed
 * nếu cấu hình thiếu/hỏng. `source` có thể là strategy hoặc mảng symbol.
 */
export function tradeSymbols(source) {
  const configured = Array.isArray(source) ? source : source?.alerts?.tradeSymbols;
  if (!Array.isArray(configured) || !configured.length) {
    throw new Error('Thiếu alerts.tradeSymbols: bot không được phép tạo kèo khi chưa có whitelist.');
  }

  const symbols = [];
  const seen = new Set();
  for (const item of configured) {
    const raw = String(item ?? '').trim();
    if (!raw) throw new Error('alerts.tradeSymbols không được chứa mã trống.');
    const symbol = normalizeSymbol(raw);
    if (!symbol.endsWith('USDT')) {
      throw new Error(`alerts.tradeSymbols chỉ nhận cặp USDT, nhận được "${raw}".`);
    }
    if (!seen.has(symbol)) {
      seen.add(symbol);
      symbols.push(symbol);
    }
  }
  return symbols;
}

/** Trả về symbol đã chuẩn hoá, hoặc dừng ngay nếu nó nằm ngoài whitelist. */
export function assertAllowedTradeSymbol(symbolInput, source) {
  const symbol = normalizeSymbol(symbolInput);
  const allowed = tradeSymbols(source);
  if (!allowed.includes(symbol)) {
    throw new Error(`${symbol} không nằm trong danh sách token được phép giao dịch.`);
  }
  return symbol;
}

/** Kiểm tra không ném lỗi, tiện cho việc bỏ qua dữ liệu watchlist cũ. */
export function isAllowedTradeSymbol(symbolInput, source) {
  try {
    const symbol = normalizeSymbol(symbolInput);
    return tradeSymbols(source).includes(symbol);
  } catch {
    return false;
  }
}

/** Toàn bộ các mã phải được quét cho kèo mới; không phụ thuộc top-volume/movers. */
export function automaticTradeTargets(strategy, { futures = null } = {}) {
  const symbols = tradeSymbols(strategy);
  const usable = futures instanceof Set ? symbols.filter((symbol) => futures.has(symbol)) : symbols;
  return usable.map((symbol) => ({ symbol, interval: null }));
}
