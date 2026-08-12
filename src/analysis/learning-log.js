// Nhật ký học từ kèo thua: giữ dữ liệu có cấu trúc để đối chiếu nguyên nhân và
// quyết định optimizer giữa các ngày, đồng thời có bản text đọc nhanh.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { DATA_DIR } from '../config.js';

const DEFAULT_DIR = path.join(DATA_DIR, 'loss-learning');

const compactLoss = (row) => ({
  tradeId: row.tradeId ?? null,
  symbol: row.symbol ?? null,
  interval: row.interval ?? null,
  side: row.side ?? null,
  cause: row.kind ?? null,
  reason: row.reason ?? null,
  barsToSl: row.barsToSl ?? null,
  barsAfterSl: row.barsAfterSl ?? null,
  mfeBeforeSlR: row.mfeBeforeSlR ?? null,
  maxAdverseR: row.maxAdverseR ?? null,
  slPercent: row.slPercent ?? null,
  neededSlPercent: row.neededSlPercent ?? null,
  reachedTp1After: row.reachedTp1After ?? null,
  widerStopSaves: row.widerStopSaves ?? null,
  entryEvidence: row.evidence ?? null,
});

export function buildLearningRecord(report, {
  strategy = {}, activeTuning = null, generatedAt = new Date().toISOString(),
} = {}) {
  const pm = report.postMortem ?? null;
  return {
    schemaVersion: 1,
    generatedAt,
    review: {
      status: report.status,
      window: report.window ?? null,
      summary: report.summary ?? null,
      comparison: report.comparison ?? null,
      market: report.market ?? null,
    },
    lossAnalysis: pm ? {
      total: pm.total ?? 0,
      decided: pm.decided ?? 0,
      counts: pm.counts ?? {},
      verdict: pm.verdict ?? null,
      sweptSharePercent: pm.sweptSharePercent ?? null,
      wrongWaySharePercent: pm.wrongWaySharePercent ?? null,
      reversedSharePercent: pm.reversedSharePercent ?? null,
      medianSlPercent: pm.medianSlPercent ?? null,
      medianNeededSlPercent: pm.medianNeededSlPercent ?? null,
      trades: (pm.rows ?? []).map(compactLoss),
      error: pm.error ?? null,
    } : null,
    candidates: (report.candidates ?? []).map((candidate) => ({
      id: candidate.id,
      label: candidate.label,
      changes: candidate.changes,
      because: candidate.because ?? null,
      improves: candidate.improves,
      guardOk: candidate.guardOk,
      passes: candidate.passes,
      holdout: candidate.holdout ?? null,
      guardHoldout: candidate.guardHoldout ?? null,
      byPair: candidate.byPair ?? [],
    })),
    decision: {
      selected: report.selected ?? null,
      activeTuning,
      cooldownUntil: report.nextTuneAt ?? null,
    },
    effectiveStrategy: {
      entryQuality: strategy.entryQuality ?? null,
      risk: strategy.risk ?? null,
      alerts: { minAbsScore: strategy.alerts?.minAbsScore ?? null },
      thresholds: {
        buy: strategy.thresholds?.buy ?? null,
        sell: strategy.thresholds?.sell ?? null,
        consensusPercent: strategy.thresholds?.consensusPercent ?? null,
      },
    },
  };
}

export async function writeLearningLog(report, {
  strategy = {}, activeTuning = null, text = '', outputDir = DEFAULT_DIR,
} = {}) {
  const record = buildLearningRecord(report, { strategy, activeTuning });
  const label = /^NGÀY\s+(\d{2})\/(\d{2})\/(\d{4})$/.exec(report.window?.label ?? '');
  // `window.since` là UTC (17:00 hôm trước khi dùng UTC+7), nên không thể cắt
  // thẳng YYYY-MM-DD để đặt tên file theo ngày người dùng nhìn thấy.
  const date = label
    ? `${label[3]}-${label[2]}-${label[1]}`
    : report.window?.since?.slice(0, 10) ?? record.generatedAt.slice(0, 10);
  await mkdir(outputDir, { recursive: true });
  const jsonFile = path.join(outputDir, `${date}.json`);
  const textFile = path.join(outputDir, `${date}.txt`);
  await Promise.all([
    writeFile(jsonFile, `${JSON.stringify(record, null, 2)}\n`, 'utf8'),
    writeFile(textFile, `${text.trim()}\n`, 'utf8'),
  ]);
  return { jsonFile, textFile, record };
}
