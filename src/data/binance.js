// Nguồn dữ liệu: Binance public REST API (không cần API key cho dữ liệu nến).
// Có fallback nhiều host vì api.binance.com bị chặn ở một số vùng.

const SPOT_HOSTS = [
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://data-api.binance.vision',
];

const FUTURES_HOSTS = ['https://fapi.binance.com'];
const isInvalidSymbolError = (error) => /code -1121|Invalid symbol/i.test(error?.message || '');

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

// Quote là stablecoin: gặp ở cuối thì gần như chắc chắn người dùng đã ghi cả cặp
// ("BTCUSDT"), vì rất ít token có tên kết thúc bằng USDT/USDC/...
const STABLE_QUOTES = ['USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD'];
// Quote là coin: nguy hiểm hơn vì NHIỀU TÊN TOKEN kết thúc bằng chúng —
// WBTC, WBETH, STETH, CBETH... Chỉ coi là cặp khi phần base còn lại đủ dài để
// là một mã thật (>= 3 ký tự): "ETHBTC" là cặp, còn "WBTC" là tên token.
const COIN_QUOTES = ['BTC', 'ETH', 'BNB'];
const MIN_BASE_LEN = 3;

/**
 * Chuẩn hoá input người dùng: "btc" -> "BTCUSDT", "eth/usdt" -> "ETHUSDT",
 * "wbtc" -> "WBTCUSDT" (không phải "WBTC"), "eth/btc" -> "ETHBTC".
 */
export function normalizeSymbol(input) {
  const s = String(input || '').trim().toUpperCase().replace(/[/\-_\s]/g, '');
  if (!s) throw new Error('Thiếu mã token');

  for (const q of STABLE_QUOTES) {
    if (s.length > q.length && s.endsWith(q)) return s;
  }
  for (const q of COIN_QUOTES) {
    if (s.length - q.length >= MIN_BASE_LEN && s.endsWith(q)) return s;
  }
  return `${s}USDT`;
}

// Danh sách cặp đang giao dịch, cache theo tiến trình. Đoán bằng heuristic không
// bao giờ đúng hết (WBTC là tên token, ETHBTC là cặp, BTCTRY là cặp fiat), nên
// khi có mạng thì đối chiếu danh sách thật.
let symbolInfo = null;   // Map<symbol, { baseAsset, quoteAsset, status }>
let symbolInfoAt = 0;
const SYMBOL_TTL_MS = 6 * 3600e3;

/** Toàn bộ symbol (kể cả đã ngừng giao dịch) kèm base/quote/status. */
export async function fetchSymbolInfo() {
  const now = Date.now();
  if (symbolInfo && now - symbolInfoAt < SYMBOL_TTL_MS) return symbolInfo;
  const j = await getJson(SPOT_HOSTS, '/api/v3/exchangeInfo');
  symbolInfo = new Map(j.symbols.map((s) => [s.symbol, {
    baseAsset: s.baseAsset, quoteAsset: s.quoteAsset, status: s.status,
  }]));
  symbolInfoAt = now;
  return symbolInfo;
}

export async function fetchTradingSymbols() {
  const info = await fetchSymbolInfo();
  return new Set([...info].filter(([, v]) => v.status === 'TRADING').map(([k]) => k));
}

/**
 * Tách token gốc khỏi cặp: "BTCUSDT" -> "BTC". Dùng danh sách thật của Binance
 * nên không phải đoán bằng cách cắt hậu tố.
 */
export async function baseAssetOf(symbol) {
  const info = await fetchSymbolInfo();
  return info.get(symbol)?.baseAsset ?? null;
}

/** Trạng thái cặp: TRADING, BREAK (đã ngừng/bị bỏ), HALT... */
export async function symbolStatusOf(symbol) {
  const info = await fetchSymbolInfo();
  return info.get(symbol)?.status ?? null;
}

// Ticker toàn sàn: 1 request trả ~3.700 symbol với weight 80 — rẻ hơn rất nhiều
// so với gọi từng mã (mỗi mã 56 weight nếu phân tích đầy đủ). Dùng để sàng lọc
// trước, rồi mới đào sâu vào số ít mã đáng chú ý.
let tickerCache = null;
let tickerCacheAt = 0;
const TICKER_TTL_MS = 30e3;

export async function fetchAllTickers() {
  const now = Date.now();
  if (tickerCache && now - tickerCacheAt < TICKER_TTL_MS) return tickerCache;
  tickerCache = await getJson(SPOT_HOSTS, '/api/v3/ticker/24hr');
  tickerCacheAt = now;
  return tickerCache;
}

// Danh sách cặp có hợp đồng vĩnh cửu, cache cùng nhịp với danh sách spot. Chỉ
// những mã này mới có funding, open interest và định vị đám đông; mã không có
// futures chỉ còn 4/7 nhóm tín hiệu nên điểm và cổng đồng thuận không so sánh
// được với phần còn lại.
let futuresSymbols = null;
let futuresSymbolsAt = 0;

export async function fetchFuturesSymbols() {
  const now = Date.now();
  if (futuresSymbols && now - futuresSymbolsAt < SYMBOL_TTL_MS) return futuresSymbols;
  const j = await getJson(FUTURES_HOSTS, '/fapi/v1/exchangeInfo');
  futuresSymbols = new Set(j.symbols
    .filter((s) => s.status === 'TRADING' && s.contractType === 'PERPETUAL')
    .map((s) => s.symbol));
  futuresSymbolsAt = now;
  return futuresSymbols;
}

// Cặp stablecoin/stablecoin gần như không bao giờ có xu hướng — loại để không
// chiếm chỗ trong danh sách đào sâu.
const STABLE_BASES = new Set([
  'USDC', 'FDUSD', 'BUSD', 'TUSD', 'USDP', 'DAI', 'EUR', 'USD1', 'USDS',
  'AEUR', 'EURI', 'XUSD', 'PYUSD', 'RLUSD',
]);

/**
 * Sàng lọc rẻ: chọn các cặp USDT đáng phân tích sâu, gộp từ hai nhóm
 *  - thanh khoản cao nhất (majors, luôn cần theo)
 *  - biến động mạnh nhất mà vẫn đủ thanh khoản (altcoin đang chạy)
 *
 * Trả về mảng symbol, đã loại cặp không TRADING, cặp stablecoin, và (mặc định)
 * cặp không có futures.
 */
export async function screenSymbols({
  topVolume = 15,
  topMovers = 15,
  minQuoteVolumeUsd = 3e6,
  quote = 'USDT',
  requireFutures = true,
} = {}) {
  const [tickers, info, futures] = await Promise.all([
    fetchAllTickers(),
    fetchSymbolInfo(),
    // Mất mạng tới fapi thì bỏ qua bộ lọc chứ không làm hỏng cả vòng quét; phần
    // `futuresFiltered` bên dưới cho biết bộ lọc có thật sự được áp hay không.
    requireFutures ? fetchFuturesSymbols().catch(() => null) : null,
  ]);

  const rows = [];
  for (const t of tickers) {
    const meta = info.get(t.symbol);
    if (!meta || meta.status !== 'TRADING' || meta.quoteAsset !== quote) continue;
    if (STABLE_BASES.has(meta.baseAsset)) continue;
    if (futures && !futures.has(t.symbol)) continue;
    const quoteVolume = +t.quoteVolume;
    if (!(quoteVolume >= minQuoteVolumeUsd)) continue;
    rows.push({
      symbol: t.symbol,
      quoteVolume,
      changeAbs: Math.abs(+t.priceChangePercent),
    });
  }

  const byVolume = [...rows].sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, topVolume).map((r) => r.symbol);
  const byMovers = [...rows].sort((a, b) => b.changeAbs - a.changeAbs)
    .slice(0, topMovers).map((r) => r.symbol);

  return {
    symbols: [...new Set([...byVolume, ...byMovers])],
    scanned: rows.length,
    totalPairs: tickers.length,
    futuresFiltered: Boolean(futures),
  };
}

/**
 * Giải mã input người dùng thành symbol Binance thật.
 * Thử theo thứ tự: nguyên văn (cặp đầy đủ như ETHBTC, BTCTRY), rồi +USDT
 * (tên token như WBTC), rồi phỏng đoán của normalizeSymbol.
 * Mất mạng thì lùi về heuristic thay vì làm sập phân tích.
 */
export async function resolveSymbol(input) {
  const raw = String(input || '').trim().toUpperCase().replace(/[/\-_\s]/g, '');
  if (!raw) throw new Error('Thiếu mã token');

  const [spot, futures] = await Promise.all([
    fetchTradingSymbols().catch(() => null),
    fetchFuturesSymbols().catch(() => null),
  ]);
  if (!spot && !futures) {
    return normalizeSymbol(input);
  }
  const set = new Set([...(spot ?? []), ...(futures ?? [])]);

  for (const candidate of [raw, `${raw}USDT`, normalizeSymbol(input)]) {
    if (set.has(candidate)) return candidate;
  }
  throw new Error(`Không tìm thấy cặp giao dịch nào cho "${raw}" trên Binance spot hoặc futures`);
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
      if (isInvalidSymbolError(err)) throw err;
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
function mapKlines(raw, { market, now = Date.now() } = {}) {
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
    market,
  }));
}

async function fetchKlinesFrom(hosts, endpoint, symbol, interval, limit, market) {
  if (!INTERVAL_MS[interval]) throw new Error(`Khung thời gian không hợp lệ: ${interval}`);
  const capped = Math.min(Math.max(limit, 50), 1000);
  const path = `${endpoint}?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${capped}`;
  return mapKlines(await getJson(hosts, path), { market });
}

/** Lấy nến perpetual futures trực tiếp, dùng khi một mã whitelist không có spot. */
export function fetchFuturesKlines(symbol, interval = '4h', limit = 500) {
  return fetchKlinesFrom(FUTURES_HOSTS, '/fapi/v1/klines', symbol, interval, limit, 'futures');
}

export async function fetchKlines(symbol, interval = '4h', limit = 500) {
  try {
    return await fetchKlinesFrom(SPOT_HOSTS, '/api/v3/klines', symbol, interval, limit, 'spot');
  } catch (error) {
    // Không pha trộn nguồn khi mạng spot gặp lỗi; chỉ chuyển sang futures nếu
    // Binance khẳng định cặp spot không tồn tại (ví dụ HYPEUSDT).
    if (!isInvalidSymbolError(error)) throw error;
    return fetchFuturesKlines(symbol, interval, limit);
  }
}

/** Lấy nhiều trang nến để có lịch sử dài (dùng cho training). */
async function fetchKlinesHistoryFrom(hosts, endpoint, symbol, interval, total, market) {
  const step = INTERVAL_MS[interval];
  if (!step) throw new Error(`Khung thời gian không hợp lệ: ${interval}`);
  const want = Math.min(Math.max(total, 200), 20000);
  const out = [];
  let endTime = Date.now();
  while (out.length < want) {
    const limit = Math.min(1000, want - out.length);
    const path = `${endpoint}?symbol=${encodeURIComponent(symbol)}&interval=${interval}` +
      `&limit=${limit}&endTime=${endTime}`;
    const raw = await getJson(hosts, path);
    if (!raw.length) break;
    const page = mapKlines(raw, { market });
    out.unshift(...page);
    endTime = page[0].openTime - 1;
    if (page.length < limit) break;
  }
  const now = Date.now();
  for (const c of out) c.closed = c.closeTime < now;
  return out;
}

export function fetchFuturesKlinesHistory(symbol, interval = '4h', total = 3000) {
  return fetchKlinesHistoryFrom(FUTURES_HOSTS, '/fapi/v1/klines', symbol, interval, total, 'futures');
}

export async function fetchKlinesHistory(symbol, interval = '4h', total = 3000) {
  try {
    return await fetchKlinesHistoryFrom(SPOT_HOSTS, '/api/v3/klines', symbol, interval, total, 'spot');
  } catch (error) {
    if (!isInvalidSymbolError(error)) throw error;
    return fetchFuturesKlinesHistory(symbol, interval, total);
  }
}

/** Giá & thống kê 24h. */
export async function fetchTicker24h(symbol) {
  let j;
  try {
    j = await getJson(SPOT_HOSTS, `/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`);
  } catch (error) {
    if (!isInvalidSymbolError(error)) throw error;
    j = await getJson(FUTURES_HOSTS, `/fapi/v1/ticker/24hr?symbol=${encodeURIComponent(symbol)}`);
  }
  return {
    lastPrice: +j.lastPrice,
    priceChangePercent: +j.priceChangePercent,
    highPrice: +j.highPrice,
    lowPrice: +j.lowPrice,
    volume: +j.volume,
    quoteVolume: +j.quoteVolume,
  };
}

/**
 * Độ sâu sổ lệnh: tỉ lệ mua/bán, tường lệnh và độ mỏng.
 *
 * "Tường" = một mức giá có giá trị lệnh chờ lớn bất thường so với trung bình các
 * mức còn lại cùng phía (mặc định >= 4 lần). Tường mua phía dưới là hỗ trợ cứng,
 * tường bán phía trên là kháng cự.
 *
 * CẢNH BÁO: sổ lệnh bị spoofing được — đặt lệnh lớn để dọa rồi huỷ trước khi khớp.
 * Luôn đối chiếu với CVD và volume. Không có lịch sử nên không backtest được.
 */
export async function fetchOrderBookImbalance(symbol, limit = 1000, wallMult = 4) {
  try {
    let j;
    try {
      j = await getJson(SPOT_HOSTS, `/api/v3/depth?symbol=${encodeURIComponent(symbol)}&limit=${limit}`);
    } catch (error) {
      if (!isInvalidSymbolError(error)) throw error;
      j = await getJson(FUTURES_HOSTS, `/fapi/v1/depth?symbol=${encodeURIComponent(symbol)}&limit=${limit}`);
    }
    const value = ([p, q]) => +p * +q;
    const bid = j.bids.reduce((s, lv) => s + value(lv), 0);
    const ask = j.asks.reduce((s, lv) => s + value(lv), 0);
    if (!(bid + ask)) return null;

    const mid = (+j.bids[0][0] + +j.asks[0][0]) / 2;
    const findWalls = (levels, side, total) => {
      const avg = total / levels.length;
      const candidates = levels
        .map((lv) => ({ price: +lv[0], value: value(lv) }))
        .filter((lv) => lv.value >= avg * wallMult)
        .sort((a, b) => b.value - a.value);

      // Các mức sát nhau thuộc cùng một tường -> chỉ giữ mức lớn nhất mỗi cụm,
      // nếu không sẽ báo 5-6 "tường" thực chất là một.
      const kept = [];
      for (const lv of candidates) {
        if (kept.some((k) => Math.abs(lv.price - k.price) / mid * 100 < 0.1)) continue;
        kept.push(lv);
        if (kept.length === 3) break;
      }
      return kept.map((lv) => ({
        side,
        price: lv.price,
        value: lv.value,
        ratioToAvg: lv.value / avg,
        distancePct: ((lv.price - mid) / mid) * 100,
      }));
    };

    // Độ mỏng: khoảng cách giá phủ bởi `limit` mức. Cùng số mức mà trải rộng hơn
    // nghĩa là sổ lệnh loãng -> volume nhỏ cũng đủ làm giá trượt mạnh.
    const bidSpanPct = ((mid - +j.bids[j.bids.length - 1][0]) / mid) * 100;
    const askSpanPct = ((+j.asks[j.asks.length - 1][0] - mid) / mid) * 100;

    return {
      bidValue: bid,
      askValue: ask,
      imbalance: (bid - ask) / (bid + ask),
      midPrice: mid,
      spreadPct: ((+j.asks[0][0] - +j.bids[0][0]) / mid) * 100,
      walls: [...findWalls(j.bids, 'bid', bid), ...findWalls(j.asks, 'ask', ask)],
      depthSpanPct: (bidSpanPct + askSpanPct) / 2,
      levels: j.bids.length + j.asks.length,
    };
  } catch {
    return null;
  }
}

// Ba endpoint định vị đám đông này CÓ lịch sử (khác order book), nên backtest được.
// Chu kỳ hợp lệ do Binance quy định, không phải mọi khung của app đều có.
const POSITION_PERIODS = ['5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d'];

/** Khung của app -> chu kỳ gần nhất mà endpoint định vị hỗ trợ. */
export function positioningPeriod(interval) {
  if (POSITION_PERIODS.includes(interval)) return interval;
  if (['1m', '3m'].includes(interval)) return '5m';
  return '1d';   // 3d, 1w, 1M
}

/**
 * Định vị đám đông: tỉ lệ tài khoản long/short, vị thế của top trader, và tỉ lệ
 * khối lượng taker mua/bán. Cho biết đám đông đang lệch bên nào — tức là bên nào
 * đang có rủi ro bị thanh lý.
 *
 * LƯU Ý: đây KHÔNG phải liquidity map / heatmap thanh lý. Binance public API
 * không cung cấp bản đồ thanh lý theo mức giá (endpoint allForceOrders đã bị bỏ),
 * chỉ có luồng WebSocket sự kiện thanh lý trực tiếp, không có lịch sử.
 */
export async function fetchPositioning(symbol, interval = '4h', limit = 30) {
  const period = positioningPeriod(interval);
  const q = `symbol=${encodeURIComponent(symbol)}&period=${period}&limit=${limit}`;
  const get = (path) => getJson(FUTURES_HOSTS, `${path}?${q}`).catch(() => null);

  const [accounts, topPositions, taker] = await Promise.all([
    get('/futures/data/globalLongShortAccountRatio'),
    get('/futures/data/topLongShortPositionRatio'),
    get('/futures/data/takerlongshortRatio'),
  ]);
  if (!accounts?.length && !topPositions?.length && !taker?.length) return null;

  const last = (arr) => (Array.isArray(arr) && arr.length ? arr[arr.length - 1] : null);
  const first = (arr) => (Array.isArray(arr) && arr.length ? arr[0] : null);

  const a = last(accounts);
  const t = last(topPositions);
  const k = last(taker);
  const aFirst = first(accounts);

  return {
    period,
    samples: accounts?.length ?? 0,
    // Tỉ lệ tài khoản đang long (0..1). >0,5 = đám đông nghiêng long.
    longAccountRatio: a ? +a.longAccount : null,
    longShortRatio: a ? +a.longShortRatio : null,
    // Thay đổi tỉ lệ long trong cả cửa sổ -> đám đông đang dồn thêm về bên nào.
    longAccountChange: a && aFirst ? +a.longAccount - +aFirst.longAccount : null,
    // Top trader thường ngược đám đông; lệch giữa hai nhóm là tín hiệu đáng chú ý.
    topLongRatio: t ? +t.longAccount : null,
    topLongShortRatio: t ? +t.longShortRatio : null,
    // >1 = taker mua áp đảo trong kỳ gần nhất.
    takerBuySellRatio: k ? +k.buySellRatio : null,
  };
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
