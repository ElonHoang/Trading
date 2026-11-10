import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  normalizeBotConfig, parseBotConfigText, serializeBotConfig, applyBotConfig, describeBotConfig,
  BOT_CONFIG_LIMITS,
} from '../src/data/bot-config.js';
import { readBotConfig } from '../src/data/bot-config-file.js';
import { automaticTradeTargets } from '../src/data/trading-universe.js';

const baseStrategy = () => ({
  alerts: { tradeSymbols: ['BTCUSDT', 'ETHUSDT'], minAbsScore: 35, maxEntryDriftPercent: 1, requireFutures: true },
  risk: { slPercent: 4 },
});

test('cấu hình hợp lệ được chuẩn hoá: viết hoa, bỏ trùng, giữ thứ tự', () => {
  const { config, errors } = normalizeBotConfig({
    tradeSymbols: ['btcusdt', ' ETHUSDT ', 'BTCUSDT', '1000pepeusdt'],
    minAbsScore: 40,
    maxEntryDriftPercent: 1.5,
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(config, {
    tradeSymbols: ['BTCUSDT', 'ETHUSDT', '1000PEPEUSDT'], minAbsScore: 40, maxEntryDriftPercent: 1.5,
  });
});

test('null ở maxEntryDriftPercent nghĩa là tắt bộ lọc, khác với việc không có khoá', () => {
  assert.deepEqual(normalizeBotConfig({ maxEntryDriftPercent: null }).config, { maxEntryDriftPercent: null });
  assert.deepEqual(normalizeBotConfig({}).config, {});
  const applied = applyBotConfig(baseStrategy(), { maxEntryDriftPercent: null });
  assert.equal(applied.alerts.maxEntryDriftPercent, null);
  assert.equal(applyBotConfig(baseStrategy(), {}).alerts.maxEntryDriftPercent, 1);
});

test('tham số sai thì KHÔNG áp dụng và có lỗi; tham số đúng bên cạnh vẫn được giữ', () => {
  const { config, errors } = normalizeBotConfig({
    tradeSymbols: ['BTCUSDT', 'BTC', 'ETH/USDT', 5],
    minAbsScore: 5,
    maxEntryDriftPercent: 'nhiều',
  });
  assert.deepEqual(config, {}, 'không tham số nào hợp lệ');
  assert.equal(errors.length, 5);

  const mixed = normalizeBotConfig({ tradeSymbols: ['ETHUSDT'], minAbsScore: 500 });
  assert.deepEqual(mixed.config, { tradeSymbols: ['ETHUSDT'] });
  assert.equal(mixed.errors.length, 1);
});

test('giới hạn: danh sách rỗng, quá dài, điểm và độ trôi ngoài khoảng đều bị loại', () => {
  assert.equal(normalizeBotConfig({ tradeSymbols: [] }).errors.length, 1);
  const tooMany = Array.from({ length: BOT_CONFIG_LIMITS.maxSymbols + 1 }, (_, i) => `A${i}USDT`);
  assert.equal(normalizeBotConfig({ tradeSymbols: tooMany }).config.tradeSymbols, undefined);
  const { min, max } = BOT_CONFIG_LIMITS.minAbsScore;
  assert.equal(normalizeBotConfig({ minAbsScore: min }).config.minAbsScore, min);
  assert.equal(normalizeBotConfig({ minAbsScore: max }).config.minAbsScore, max);
  assert.equal(normalizeBotConfig({ minAbsScore: min - 1 }).config.minAbsScore, undefined);
  assert.equal(normalizeBotConfig({ minAbsScore: Number.NaN }).config.minAbsScore, undefined);
  assert.equal(normalizeBotConfig({ maxEntryDriftPercent: 0 }).config.maxEntryDriftPercent, undefined);
  assert.equal(normalizeBotConfig({ maxEntryDriftPercent: 11 }).config.maxEntryDriftPercent, undefined);
});

test('khoá lạ bị bỏ qua: không thể chỉnh rủi ro, ngưỡng MUA/BÁN hay bất cứ thứ gì ngoài ba tham số', () => {
  const { config } = normalizeBotConfig({
    risk: { slPercent: 0.1 }, thresholds: { buy: 1 }, 'alerts.requireFutures': false, __proto__: { x: 1 }, minAbsScore: 50,
  });
  assert.deepEqual(config, { minAbsScore: 50 });
  const applied = applyBotConfig(baseStrategy(), { risk: { slPercent: 0.1 }, minAbsScore: 50 });
  assert.equal(applied.risk.slPercent, 4);
  assert.equal(applied.alerts.requireFutures, true);
});

test('đầu vào không phải đối tượng hoặc JSON hỏng không làm ném lỗi', () => {
  for (const bad of [[], 'x', 42, true]) {
    const { config, errors } = normalizeBotConfig(bad);
    assert.deepEqual(config, {});
    assert.equal(errors.length, 1);
  }
  assert.deepEqual(normalizeBotConfig(null), { config: {}, errors: [] });
  assert.equal(parseBotConfigText('{ không phải json').errors.length, 1);
  assert.deepEqual(parseBotConfigText('{ không phải json').config, {});
});

test('applyBotConfig không sửa strategy gốc và chỉ đụng vào những khoá có trong cấu hình', () => {
  const strategy = baseStrategy();
  const frozen = JSON.stringify(strategy);
  const applied = applyBotConfig(strategy, { tradeSymbols: ['SOLUSDT'], minAbsScore: 45 });
  assert.equal(JSON.stringify(strategy), frozen, 'strategy gốc giữ nguyên');
  assert.deepEqual(applied.alerts.tradeSymbols, ['SOLUSDT']);
  assert.equal(applied.alerts.minAbsScore, 45);
  assert.equal(applied.alerts.maxEntryDriftPercent, 1, 'khoá không có trong cấu hình giữ giá trị của repo');
  assert.equal(applyBotConfig(strategy, {}), strategy, 'cấu hình rỗng trả về đúng đối tượng cũ');
});

test('danh sách mã từ web thật sự quyết định bot quét những mã nào', () => {
  const applied = applyBotConfig(baseStrategy(), { tradeSymbols: ['SOLUSDT', 'DOGEUSDT'] });
  assert.deepEqual(automaticTradeTargets(applied).map((t) => t.symbol), ['SOLUSDT', 'DOGEUSDT']);
  // lọc theo futures vẫn áp dụng lên danh sách mới
  assert.deepEqual(
    automaticTradeTargets(applied, { futures: new Set(['DOGEUSDT']) }).map((t) => t.symbol),
    ['DOGEUSDT'],
  );
});

test('serialize rồi parse lại ra đúng cấu hình, và serialize tự loại phần không hợp lệ', () => {
  const config = { tradeSymbols: ['BTCUSDT'], minAbsScore: 40, maxEntryDriftPercent: null };
  const text = serializeBotConfig(config);
  assert.ok(text.endsWith('\n'));
  assert.equal(JSON.parse(text).version, 1);
  assert.deepEqual(parseBotConfigText(text), { config, errors: [] });
  assert.deepEqual(JSON.parse(serializeBotConfig({ minAbsScore: 1, tradeSymbols: ['ETHUSDT'] })), { version: 1, tradeSymbols: ['ETHUSDT'] });
});

test('describeBotConfig mô tả đúng những gì đang chỉnh', () => {
  assert.equal(describeBotConfig({}), 'không có tham số nào');
  assert.equal(
    describeBotConfig({ tradeSymbols: ['A1USDT', 'B2USDT'], minAbsScore: 40, maxEntryDriftPercent: null }),
    '2 mã, điểm tối thiểu 40, không giới hạn độ trôi giá',
  );
});

test('readBotConfig: không có file, file đúng, file hỏng', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'botcfg-'));
  try {
    const file = path.join(dir, 'bot-config.json');
    assert.deepEqual(await readBotConfig({ file }), { found: false, config: {}, errors: [] });

    await writeFile(file, serializeBotConfig({ tradeSymbols: ['ETHUSDT'], minAbsScore: 42 }));
    const ok = await readBotConfig({ file });
    assert.equal(ok.found, true);
    assert.deepEqual(ok.config, { tradeSymbols: ['ETHUSDT'], minAbsScore: 42 });
    assert.deepEqual(ok.errors, []);

    await writeFile(file, '{"tradeSymbols": ["BTCUSDT"], "minAbsScore": ');
    const broken = await readBotConfig({ file });
    assert.equal(broken.found, true);
    assert.deepEqual(broken.config, {});
    assert.equal(broken.errors.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
