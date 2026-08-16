// Chọn bộ lọc vào lệnh trên 75% lịch sử, rồi xác nhận trên 25% cuối không dùng để chọn.
// Chạy: npm run validate:filters -- BTC 4h 3000

import { loadStrategy } from '../src/config.js';
import { backtest } from '../src/backtest.js';
import { fetchKlinesHistory, normalizeSymbol } from '../src/data/binance.js';
import { assertAllowedTradeSymbol } from '../src/data/trading-universe.js';
import { closedCandles } from '../src/analysis/engine.js';

const [symbolArg, interval = '4h', candlesArg = '3000'] = process.argv.slice(2);
if (!symbolArg) {
  console.log('Cách dùng: npm run validate:filters -- <SYMBOL> [khung] [số nến]');
  process.exit(1);
}

const symbol = normalizeSymbol(symbolArg);
const strategy = await loadStrategy();
assertAllowedTradeSymbol(symbol, strategy);
// Nghiên cứu phải tách riêng cổng production đang bật, để baseline và từng
// candidate được đo công bằng trên cùng một luật gốc.
const researchStrategy = structuredClone(strategy);
researchStrategy.entryQuality = { ...researchStrategy.entryQuality, enabled: false };
const raw = closedCandles(await fetchKlinesHistory(symbol, interval, Number(candlesArg)));
const splitIndex = Math.floor(raw.length * 0.75);
const training = raw.slice(0, splitIndex);

const candidates = [
  { name: 'baseline', filter: null, proposedThresholds: null },
  ...[35, 40, 45].map((minAbsScore) => ({
    name: `|điểm| ≥ ${minAbsScore}`,
    filter: ({ score }) => Math.abs(score) >= minAbsScore,
    proposedThresholds: { buy: minAbsScore, sell: -minAbsScore },
  })),
  ...[35, 40].map((minAbsScore) => ({
    name: `|điểm| ≥ ${minAbsScore} + cấu trúc không ngược hướng`,
    filter: ({ side, score, diagnostics }) => {
      const structure = diagnostics.groupScores.structure ?? 0;
      return Math.abs(score) >= minAbsScore && (side === 'long' ? structure >= 0 : structure <= 0);
    },
    proposedThresholds: { buy: minAbsScore, sell: -minAbsScore, requireStructureAgreement: true },
  })),
  {
    name: 'CVD mạnh |độ dốc| ≥ 3%',
    filter: ({ diagnostics }) => Math.abs(diagnostics.cvdSlope) >= 0.03,
    proposedThresholds: { minAbsCvdSlope: 0.03 },
  },
  {
    name: 'volume ≥ 1x trung bình',
    filter: ({ diagnostics }) => diagnostics.volumeRatio >= 1,
    proposedThresholds: { minVolumeRatio: 1 },
  },
  {
    name: 'tránh nhịp đã đi quá xa 4% trong 20 nến',
    filter: ({ side, diagnostics }) => !(
      (side === 'long' && diagnostics.priceChange20Pct > 4)
      || (side === 'short' && diagnostics.priceChange20Pct < -4)
    ),
    proposedThresholds: { maxDirectionalMove20Pct: 4 },
  },
  {
    name: 'cấu trúc không ngược hướng',
    filter: ({ side, diagnostics }) => {
      const structure = diagnostics.groupScores.structure ?? 0;
      return side === 'long' ? structure >= 0 : structure <= 0;
    },
    proposedThresholds: { requireStructureAgreement: true },
  },
  {
    name: 'CVD mạnh + volume ≥ 1x',
    filter: ({ diagnostics }) => (
      Math.abs(diagnostics.cvdSlope) >= 0.03 && diagnostics.volumeRatio >= 1
    ),
    proposedThresholds: { minAbsCvdSlope: 0.03, minVolumeRatio: 1 },
  },
];

const compact = (result) => ({
  trades: result.stats.trades,
  winRatePercent: result.stats.winRatePercent,
  profitFactor: result.stats.profitFactor,
  expectancyPercent: result.stats.expectancyPercent,
  totalReturnPercent: result.stats.totalReturnPercent,
  maxDrawdownPercent: result.stats.maxDrawdownPercent,
  skippedByEntryFilter: result.settings.skippedByEntryFilter,
});

async function run(candlesData, startIndex, filter) {
  return backtest(symbol, interval, researchStrategy, {
    candles: candlesData.length,
    candlesData,
    startIndex,
    storedModel: null, // ML hiện không đạt minTestAuc, giống engine chạy thật.
    entryFilter: filter,
  });
}

const trainingResults = [];
for (const candidate of candidates) {
  const result = await run(training, 220, candidate.filter);
  trainingResults.push({ candidate, result, metrics: compact(result) });
}

const baselineTraining = trainingResults[0].metrics;
const eligible = trainingResults.slice(1).filter(({ metrics }) => (
  metrics.trades >= Math.max(12, Math.ceil(baselineTraining.trades * 0.5))
  && metrics.profitFactor != null
  && baselineTraining.profitFactor != null
  && metrics.profitFactor >= baselineTraining.profitFactor + 0.1
  && metrics.winRatePercent >= baselineTraining.winRatePercent + 5
));
eligible.sort((a, b) => (
  (b.metrics.profitFactor - a.metrics.profitFactor)
  || (b.metrics.expectancyPercent - a.metrics.expectancyPercent)
));
const selected = eligible[0] ?? null;

const validationBaseline = await run(raw, splitIndex, null);
const validationSelected = selected ? await run(raw, splitIndex, selected.candidate.filter) : null;
// Báo toàn bộ candidate trên đoạn giữ lại để kiểm tra một bộ lọc cố định có
// thực sự tổng quát sang cặp khác hay chỉ tình cờ được chọn ở train.
const validationCandidates = [];
for (const candidate of candidates.slice(1)) {
  const result = await run(raw, splitIndex, candidate.filter);
  validationCandidates.push({ candidate, metrics: compact(result) });
}
const validationPasses = selected && validationSelected.stats.trades >= 8
  && validationSelected.stats.profitFactor != null
  && validationBaseline.stats.profitFactor != null
  && validationSelected.stats.profitFactor >= validationBaseline.stats.profitFactor + 0.1
  && validationSelected.stats.winRatePercent >= validationBaseline.stats.winRatePercent + 3;

console.log(JSON.stringify({
  symbol,
  interval,
  period: {
    from: new Date(raw[0].openTime).toISOString(),
    to: new Date(raw[raw.length - 1].openTime).toISOString(),
    candles: raw.length,
    trainingCandles: training.length,
    validationCandles: raw.length - splitIndex,
  },
  training: trainingResults.map(({ candidate, metrics }) => ({
    name: candidate.name,
    proposedThresholds: candidate.proposedThresholds,
    ...metrics,
  })),
  selectedFromTraining: selected
    ? { name: selected.candidate.name, proposedThresholds: selected.candidate.proposedThresholds }
    : null,
  validation: {
    baseline: compact(validationBaseline),
    selected: validationSelected ? compact(validationSelected) : null,
    passes: Boolean(validationPasses),
    candidates: validationCandidates.map(({ candidate, metrics }) => ({
      name: candidate.name,
      proposedThresholds: candidate.proposedThresholds,
      ...metrics,
    })),
  },
}, null, 2));
