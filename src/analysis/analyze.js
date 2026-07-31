// Gộp dữ liệu Binance + chỉ báo thành một payload duy nhất cho UI.
// Phần tính toán nằm ở summary.js (thuần, không mạng) để browser dùng lại được.

import {
  fetchKlines, fetchTicker24h, fetchOrderBookImbalance, fetchDerivatives,
  normalizeSymbol, INTERVAL_MS,
} from '../data/binance.js';
import { computeAll } from './summary.js';

/**
 * Phân tích một mã. `limit` là số nến muốn lấy (binance.js tự kẹp trong 50..1000).
 * Các nguồn phụ (orderbook, phái sinh) lỗi thì trả null chứ không làm sập request.
 */
export async function analyze(symbolInput, interval = '4h', limit = 300) {
  const symbol = normalizeSymbol(symbolInput);
  if (!INTERVAL_MS[interval]) throw new Error(`Khung thời gian không hợp lệ: ${interval}`);

  const [candles, ticker, orderbook, derivatives] = await Promise.all([
    fetchKlines(symbol, interval, limit),
    fetchTicker24h(symbol).catch(() => null),
    fetchOrderBookImbalance(symbol),
    fetchDerivatives(symbol),
  ]);
  if (candles.length < 30) throw new Error(`Không đủ dữ liệu nến cho ${symbol}`);

  const { series, summary, levels } = computeAll(candles);

  return {
    symbol,
    interval,
    // Nến cuối có thể chưa đóng -> UI cần biết để ghi chú.
    lastCandleClosed: candles[candles.length - 1].closed,
    candles,
    ticker,
    orderbook,
    derivatives,
    series,
    levels,
    summary,
  };
}
