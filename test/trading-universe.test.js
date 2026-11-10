import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { openCall } from '../src/data/open-calls.js';
import {
  assertAllowedTradeSymbol, automaticTradeTargets, isAllowedTradeSymbol, tradeSymbols,
} from '../src/data/trading-universe.js';

const strategy = JSON.parse(await readFile(new URL('../config/strategy.json', import.meta.url), 'utf8'));
const expected = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'XRPUSDT', 'SOLUSDT', 'TRXUSDT', 'HYPEUSDT',
  'DOGEUSDT', 'ADAUSDT', 'ZECUSDT', 'LINKUSDT', 'SUIUSDT', 'AAVEUSDT',
];

test('trade universe is the exact requested 13 USDT pairs', () => {
  assert.deepEqual(tradeSymbols(strategy), expected);
  assert.deepEqual(automaticTradeTargets(strategy), expected.map((symbol) => ({ symbol, interval: null })));
  assert.deepEqual(
    automaticTradeTargets(strategy, { futures: new Set(['BTCUSDT', 'HYPEUSDT']) }),
    [{ symbol: 'BTCUSDT', interval: null }, { symbol: 'HYPEUSDT', interval: null }],
  );
});

test('trade universe normalizes allowed tickers and rejects every other pair', () => {
  assert.equal(assertAllowedTradeSymbol('btc', strategy), 'BTCUSDT');
  assert.equal(assertAllowedTradeSymbol('HYPE/USDT', strategy), 'HYPEUSDT');
  assert.equal(isAllowedTradeSymbol('ETHBTC', strategy), false);
  assert.equal(isAllowedTradeSymbol('AVAX', strategy), false);
  assert.throws(() => assertAllowedTradeSymbol('AVAXUSDT', strategy), /không nằm trong danh sách/);
});

test('trade universe fails closed when the whitelist is missing or invalid', () => {
  assert.throws(() => tradeSymbols({ alerts: {} }), /Thiếu alerts\.tradeSymbols/);
  assert.throws(() => tradeSymbols(['ETHBTC']), /chỉ nhận cặp USDT/);
});

test('openCall cannot persist an out-of-universe trade even when called directly', async () => {
  await assert.rejects(
    () => openCall('AVAXUSDT', {
      interval: '4h', side: 'long', entry: 1, stopLoss: 0.9, targets: [], candleTime: Date.now(),
    }, { allowedSymbols: expected }),
    /không nằm trong danh sách/,
  );
});
