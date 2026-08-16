import assert from 'node:assert/strict';
import test from 'node:test';

let moduleSerial = 0;

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function invalidSymbol() {
  return jsonResponse({ code: -1121, msg: 'Invalid symbol.' }, 400);
}

function kline(openTime) {
  return [
    openTime, '100', '105', '95', '102', '10', openTime + 3_599_999,
    '1020', 12, '6', '612', '0',
  ];
}

async function freshBinanceModule() {
  moduleSerial++;
  const url = new URL('../src/data/binance.js', import.meta.url);
  return import(`${url.href}?futures-fallback-test=${moduleSerial}`);
}

async function withMockFetch(mock, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('resolveSymbol accepts a whitelist token that exists only on Binance Futures', { concurrency: false }, async () => {
  await withMockFetch(async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'fapi.binance.com' && parsed.pathname === '/fapi/v1/exchangeInfo') {
      return jsonResponse({
        symbols: [{ symbol: 'HYPEUSDT', status: 'TRADING', contractType: 'PERPETUAL' }],
      });
    }
    if (parsed.pathname === '/api/v3/exchangeInfo') {
      return jsonResponse({
        symbols: [{ symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING' }],
      });
    }
    throw new Error(`Unexpected URL ${url}`);
  }, async () => {
    const { resolveSymbol } = await freshBinanceModule();
    assert.equal(await resolveSymbol('HYPE'), 'HYPEUSDT');
  });
});

test('fetchKlines falls back to Futures only after a confirmed missing spot symbol', { concurrency: false }, async () => {
  const urls = [];
  await withMockFetch(async (url) => {
    urls.push(url);
    const parsed = new URL(url);
    if (parsed.pathname === '/api/v3/klines') return invalidSymbol();
    if (parsed.pathname === '/fapi/v1/klines') return jsonResponse([kline(1_000)]);
    throw new Error(`Unexpected URL ${url}`);
  }, async () => {
    const { fetchKlines } = await freshBinanceModule();
    const candles = await fetchKlines('HYPEUSDT', '1h', 50);
    assert.equal(candles.length, 1);
    assert.equal(candles[0].market, 'futures');
    assert.ok(urls.some((url) => new URL(url).pathname === '/fapi/v1/klines'));
  });
});

test('fetchKlinesHistory keeps all paginated candles on Futures after spot rejects the symbol', { concurrency: false }, async () => {
  const urls = [];
  await withMockFetch(async (url) => {
    urls.push(url);
    const parsed = new URL(url);
    if (parsed.pathname === '/api/v3/klines') return invalidSymbol();
    if (parsed.pathname !== '/fapi/v1/klines') throw new Error(`Unexpected URL ${url}`);

    const limit = Number(parsed.searchParams.get('limit'));
    const endTime = Number(parsed.searchParams.get('endTime'));
    const start = limit === 1000 ? 1_000 : 800;
    const raw = Array.from({ length: limit }, (_, i) => kline(start + i));
    // `endTime` chỉ để xác nhận trang sau thật sự đi lùi; fixture được tạo theo
    // đúng thứ tự thời gian mà endpoint trả về.
    if (limit === 200) assert.ok(endTime < 1_000);
    return jsonResponse(raw);
  }, async () => {
    const { fetchKlinesHistory } = await freshBinanceModule();
    const candles = await fetchKlinesHistory('HYPEUSDT', '1h', 1200);
    assert.equal(candles.length, 1200);
    assert.equal(candles[0].openTime, 800);
    assert.equal(candles.at(-1).openTime, 1_999);
    assert.equal(candles.every((c) => c.market === 'futures'), true);
    assert.equal(urls.filter((url) => new URL(url).pathname === '/api/v3/klines').length, 1);
    assert.equal(urls.filter((url) => new URL(url).pathname === '/fapi/v1/klines').length, 2);
  });
});

test('a spot transport failure does not silently switch the market to Futures', { concurrency: false }, async () => {
  const urls = [];
  await withMockFetch(async (url) => {
    urls.push(url);
    return jsonResponse({ code: -1000, msg: 'Internal error' }, 500);
  }, async () => {
    const { fetchKlines } = await freshBinanceModule();
    await assert.rejects(() => fetchKlines('BTCUSDT', '1h', 50));
    assert.equal(urls.some((url) => new URL(url).hostname === 'fapi.binance.com'), false);
  });
});
