// Thông báo delist / list của Binance.
//
// CẢNH BÁO VỀ NGUỒN: endpoint CMS dưới đây KHÔNG phải API chính thức của Binance
// (không có trong tài liệu API). Hiện nó hoạt động và không cần key, nhưng Binance
// có thể đổi hoặc chặn bất cứ lúc nào. Vì vậy luôn kèm nguồn chính thức làm chỗ
// dựa: trạng thái symbol trong exchangeInfo (TRADING / BREAK / HALT).
//
// Binance không có RSS thông báo dùng được (endpoint /announcement/rss trả 202 rỗng).

import { fetchSymbolInfo, symbolStatusOf } from './binance.js';

const CMS = 'https://www.binance.com/bapi/composite/v1/public/cms/article/list/query';
const CATALOG = { delisting: 161, listing: 48 };

const TTL_MS = 30 * 60e3;
const cache = new Map();

// Binance CMS trả HTTP 400 nếu pageSize > 20 — kẹp lại, nếu không toàn bộ
// phần thông báo im lặng trả rỗng.
const MAX_PAGE_SIZE = 20;

async function fetchCatalog(catalogId, requested = MAX_PAGE_SIZE) {
  const pageSize = Math.min(Math.max(1, requested), MAX_PAGE_SIZE);
  const key = `cat:${catalogId}:${pageSize}`;
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < TTL_MS) return hit.value;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  try {
    const res = await fetch(`${CMS}?type=1&catalogId=${catalogId}&pageNo=1&pageSize=${pageSize}`, {
      signal: ac.signal,
      headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
    });
    if (!res.ok) throw new Error(`Binance CMS HTTP ${res.status}`);
    const j = await res.json();
    const articles = j?.data?.catalogs?.[0]?.articles ?? j?.data?.articles ?? [];
    const value = articles.map((a) => ({
      title: a.title ?? '',
      code: a.code ?? null,
      releaseAt: a.releaseDate ?? null,
      url: a.code ? `https://www.binance.com/en/support/announcement/${a.code}` : null,
    }));
    cache.set(key, { at: now, value });
    return value;
  } finally {
    clearTimeout(timer);
  }
}

/** Danh sách thông báo delist gần nhất. Trả [] nếu endpoint không dùng được. */
export async function fetchDelistAnnouncements(pageSize = 20) {
  return fetchCatalog(CATALOG.delisting, pageSize).catch(() => []);
}

export async function fetchListingAnnouncements(pageSize = 20) {
  return fetchCatalog(CATALOG.listing, pageSize).catch(() => []);
}

// Ticker xuất hiện trong tiêu đề: chuỗi in hoa 2-10 ký tự. Loại các từ tiếng Anh
// hay viết hoa trong tiêu đề thông báo để không báo động sai.
const TITLE_NOISE = new Set([
  'BINANCE', 'WILL', 'AND', 'THE', 'FOR', 'USDT', 'USDC', 'BUSD', 'FDUSD', 'USD',
  'SPOT', 'MARGIN', 'FUTURES', 'PERPETUAL', 'CONTRACT', 'CONTRACTS', 'TRADING',
  'PAIRS', 'PAIR', 'REMOVAL', 'REMOVE', 'DELIST', 'DELISTING', 'NOTICE', 'UPDATE',
  'ADD', 'ADDS', 'NEW', 'ON', 'OF', 'TO', 'AT', 'IN', 'ISOLATED', 'CROSS',
  'CONVERSION', 'REGARDING', 'SERVICES', 'BOTS', 'EARN', 'API', 'VIP', 'M', 'U',
]);

function tickersInTitle(title) {
  return [...new Set(
    (title.match(/\b[A-Z0-9]{2,10}\b/g) ?? []).filter((w) => !TITLE_NOISE.has(w) && !/^\d+$/.test(w)),
  )];
}

/**
 * Rủi ro delist của một token.
 *
 * Hai nguồn độc lập:
 *  1. status của cặp trong exchangeInfo (CHÍNH THỨC). BREAK/HALT = đã ngừng.
 *  2. tiêu đề thông báo delist gần nhất có nhắc tới ticker (KHÔNG CHÍNH THỨC).
 *
 * Nguồn 2 chỉ đọc được tiêu đề, không đọc nội dung bài, nên thông báo dạng
 * "Notice of Removal of Spot Trading Pairs - <ngày>" (không liệt kê token trong
 * tiêu đề) sẽ KHÔNG khớp được token nào — trả về trong `unparsedNotices` để
 * người dùng tự mở xem, thay vì im lặng bỏ qua.
 */
export async function fetchDelistRisk(symbol, baseAsset) {
  const ticker = String(baseAsset || '').toUpperCase();
  const [status, notices] = await Promise.all([
    symbolStatusOf(symbol).catch(() => null),
    fetchDelistAnnouncements(30),
  ]);

  const matched = [];
  const unparsedNotices = [];
  for (const n of notices) {
    const tickers = tickersInTitle(n.title);
    if (ticker && tickers.includes(ticker)) matched.push(n);
    else if (!tickers.length) unparsedNotices.push(n);
  }

  return {
    // Nguồn chính thức, đáng tin nhất.
    symbolStatus: status,
    statusIsTrading: status === 'TRADING',
    // Nguồn không chính thức.
    announcementsChecked: notices.length,
    matchedAnnouncements: matched.slice(0, 5),
    unparsedNotices: unparsedNotices.slice(0, 3),
    sourceAvailable: notices.length > 0,
  };
}

/** Các cặp vừa chuyển sang BREAK/HALT — dùng để quét cả watchlist. */
export async function findNonTradingPairs(symbols) {
  const info = await fetchSymbolInfo();
  return symbols
    .map((s) => ({ symbol: s, status: info.get(s)?.status ?? 'KHÔNG TỒN TẠI' }))
    .filter((x) => x.status !== 'TRADING');
}
