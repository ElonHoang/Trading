// Nguồn dữ liệu: Binance public REST API (không cần API key cho dữ liệu nến).
// Có fallback nhiều host vì api.binance.com bị chặn ở một số vùng.

const SPOT_HOSTS = [
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://data-api.binance.vision',
];

const FUTURES_HOSTS = ['https://fapi.binance.com'];

export const INTERVALS = [
  '1m', '3m', '5m', '15m', '30m',
  '1h', '2h', '4h', '6h', '8h', '12h',
  '1d', '3d', '1w', '1M',
];

export const INTERVAL_MS = {
  '1m': 60e3, '3m': 180e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3,
  '1h': 3600e3, '2h': 7200e3, '4h': 14400e3, '6h': 21600e3, '8h': 28800e3,
  '12h': 43200e3, '1d': 86400e3, '3d': 259200e3, '1w': 604800e3, '1M': 2592000e3,
};

/** Chuẩn hoá input người dùng: "btc" -> "BTCUSDT", "eth/usdt" -> "ETHUSDT" */
export function normalizeSymbol(input) {
  let s = String(input || '').trim().toUpperCase().replace(/[\/\-_\s]/g, '');
  if (!s) throw new Error('Thiếu mã token');
  // Chỉ coi là đã có quote khi còn phần base phía trước ("BTCUSDT" có, "BTC" thì không).
  const quotes = ['USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD', 'BTC', 'ETH', 'BNB'];
  const hasQuote = quotes.some((q) => s.length > q.length && s.endsWith(q));
  if (!hasQuote) s += 'USDT';
  return s;
}

async function getJson(hosts, path, { timeoutMs = 15000 } = {}) {
  let lastErr;
  for (const host of hosts) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(host + path, {
        signal: ac.signal,
        headers: { 'User-Agent': 'ta-ai-bot/1.0' },
      });
      const text = await res.text();
      if (!res.ok) {
        // Lỗi nghiệp vụ (mã token sai...) thì không cần thử host khác.
        let msg = `HTTP ${res.status}`;
        try {
          const j = JSON.parse(text);
          if (j.msg) msg = `${j.msg} (code ${j.code})`;
        } catch { /* body không phải JSON */ }
        if (res.status === 400) throw new Error(msg);
        throw new Error(`${host}: ${msg}`);
      }
      return JSON.parse(text);
    } catch (err) {
      lastErr = err;
      if (/code -1121|Invalid symbol/i.test(err.message)) throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Không lấy được dữ liệu từ Binance: ${lastErr?.message || 'unknown'}`);
}

/**
 * Lấy nến. Trả về mảng { openTime, open, high, low, close, volume, closeTime, trades, closed }
 * Nến cuối cùng có thể chưa đóng -> đánh dấu closed=false.
 */
export async function fetchKlines(symbol, interval = '4h', limit = 500) {
  if (!INTERVAL_MS[interval]) throw new Error(`Khung thời gian không hợp lệ: ${interval}`);
  const capped = Math.min(Math.max(limit, 50), 1000);
  const path = `/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${capped}`;
  const raw = await getJson(SPOT_HOSTS, path);
  const now = Date.now();
  return raw.map((k) => ({
    openTime: k[0],
    open: +k[1],
    high: +k[2],
    low: +k[3],
    close: +k[4],
    volume: +k[5],
    closeTime: k[6],
    quoteVolume: +k[7],
    trades: +k[8],
    takerBuyVolume: +k[9],
    closed: k[6] < now,
  }));
}

/** Lấy nhiều trang nến để có lịch sử dài (dùng cho training). */
export async function fetchKlinesHistory(symbol, interval = '4h', total = 3000) {
  const step = INTERVAL_MS[interval];
  if (!step) throw new Error(`Khung thời gian không hợp lệ: ${interval}`);
  const want = Math.min(Math.max(total, 200), 20000);
  const out = [];
  let endTime = Date.now();
  while (out.length < want) {
    const limit = Math.min(1000, want - out.length);
    const path = `/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}` +
      `&limit=${limit}&endTime=${endTime}`;
    const raw = await getJson(SPOT_HOSTS, path);
    if (!raw.length) break;
    const page = raw.map((k) => ({
      openTime: k[0],
      open: +k[1],
      high: +k[2],
      low: +k[3],
      close: +k[4],
      volume: +k[5],
      closeTime: k[6],
      quoteVolume: +k[7],
      trades: +k[8],
      takerBuyVolume: +k[9],
      closed: true,
    }));
    out.unshift(...page);
    endTime = page[0].openTime - 1;
    if (page.length < limit) break;
  }
  const now = Date.now();
  for (const c of out) c.closed = c.closeTime < now;
  return out;
}

/** Giá & thống kê 24h. */
export async function fetchTicker24h(symbol) {
  const j = await getJson(SPOT_HOSTS, `/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`);
  return {
    lastPrice: +j.lastPrice,
    priceChangePercent: +j.priceChangePercent,
    highPrice: +j.highPrice,
    lowPrice: +j.lowPrice,
    volume: +j.volume,
    quoteVolume: +j.quoteVolume,
  };
}

/** Độ sâu sổ lệnh -> tỉ lệ mua/bán gần giá hiện tại. */
export async function fetchOrderBookImbalance(symbol, limit = 100) {
  try {
    const j = await getJson(SPOT_HOSTS, `/api/v3/depth?symbol=${encodeURIComponent(symbol)}&limit=${limit}`);
    const bid = j.bids.reduce((s, [p, q]) => s + +p * +q, 0);
    const ask = j.asks.reduce((s, [p, q]) => s + +p * +q, 0);
    if (!(bid + ask)) return null;
    return { bidValue: bid, askValue: ask, imbalance: (bid - ask) / (bid + ask) };
  } catch {
    return null;
  }
}

/**
 * Dữ liệu phái sinh (funding rate, open interest). Nhiều token không có hợp đồng
 * futures -> trả null thay vì lỗi.
 */
export async function fetchDerivatives(symbol) {
  try {
    const [premium, oiHist] = await Promise.all([
      getJson(FUTURES_HOSTS, `/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`),
      getJson(FUTURES_HOSTS, `/futures/data/openInterestHist?symbol=${encodeURIComponent(symbol)}&period=4h&limit=14`)
        .catch(() => null),
    ]);
    const oi = Array.isArray(oiHist) && oiHist.length ? oiHist : null;
    let oiChangePct = null;
    if (oi && oi.length > 1) {
      const first = +oi[0].sumOpenInterest;
      const last = +oi[oi.length - 1].sumOpenInterest;
      if (first > 0) oiChangePct = ((last - first) / first) * 100;
    }
    return {
      fundingRate: premium?.lastFundingRate != null ? +premium.lastFundingRate : null,
      markPrice: premium?.markPrice != null ? +premium.markPrice : null,
      openInterest: oi ? +oi[oi.length - 1].sumOpenInterest : null,
      openInterestChangePct: oiChangePct,
    };
  } catch {
    return null;
  }
}
