// Thu thập nhật ký kèo thua hằng ngày. Module này chỉ phát lại kèo SL để ghi
// nguyên nhân; không sinh candidate, không backtest và không sửa strategy.

import { fetchKlines } from '../data/binance.js';
import { saveAutoRetuneState } from './auto-retune.js';
import { reviewWindow } from './daily-review.js';
import { compactLoss } from './learning-log.js';
import { postMortemLosses } from './post-mortem.js';

function dateFromLabel(label, fallback) {
  const match = /^NGÀY\s+(\d{2})\/(\d{2})\/(\d{4})$/.exec(label ?? '');
  return match ? `${match[3]}-${match[2]}-${match[1]}` : fallback;
}

function weekKey(now, offsetHours = 7) {
  const dayMs = 86400e3;
  const shifted = now + Number(offsetHours) * 3600e3;
  const dayStart = Math.floor(shifted / dayMs) * dayMs;
  const dayOfWeek = new Date(dayStart).getUTCDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  return new Date(dayStart - daysSinceMonday * dayMs).toISOString().slice(0, 10);
}

export async function recordDailyLossLog({ strategy, state, now = Date.now(), deps = {} }) {
  const cfg = strategy.dailyReview ?? {};
  const learn = strategy.learning ?? {};
  const dayOffsetDays = Math.min(-1, Number(deps.dayOffsetDays ?? -1));
  const window = reviewWindow({
    ...cfg, windowMode: 'calendar-day', dayOffsetDays,
  }, now);
  const reviewTime = /^(\d{1,2}):(\d{2})$/.exec(String(learn.reviewAtUtc ?? ''));
  if (reviewTime && !deps.force) {
    const dayMs = 86400e3;
    const reviewMinutes = Number(reviewTime[1]) * 60 + Number(reviewTime[2]);
    let reviewAt = Math.floor(window.untilMs / dayMs) * dayMs + reviewMinutes * 60e3;
    if (reviewAt < window.untilMs) reviewAt += dayMs;
    if (now < reviewAt) return { status: 'too-early', log: null };
  }
  const date = dateFromLabel(window.label, new Date(window.sinceMs).toISOString().slice(0, 10));
  const currentWeek = weekKey(now, cfg.dayOffsetHours ?? 7);
  if (state.lossLogWeek !== currentWeek) {
    state.lossLogs = [];
    state.lossLogWeek = currentWeek;
  }
  const existing = (state.lossLogs ?? []).find((log) => log.date === date);
  if (!existing && deps.refreshExistingOnly) {
    return { status: 'not-recorded', log: null };
  }
  const hasUnknown = existing?.losses?.some((loss) => loss.cause === 'chua-du-nen');
  if (existing && !deps.force && !(deps.refreshUnknown && hasUnknown)) {
    return { status: 'already-logged', log: existing };
  }

  const losses = (state.trades ?? []).filter((trade) => {
    const closedAt = Date.parse(trade.closedAt ?? '');
    const hitTp = (trade.result?.hitTps ?? []).length > 0;
    return Number.isFinite(closedAt)
      && closedAt >= window.sinceMs && closedAt < window.untilMs
      && trade.result?.status === 'stopped' && !hitTp;
  });

  const inspect = deps.postMortemLosses ?? postMortemLosses;
  const analysis = await inspect(losses, {
    fetchCandles: deps.fetchRecentCandles ?? fetchKlines,
    maxTrades: Math.max(1, losses.length),
    candles: Number(learn.replayCandles ?? 400),
    maxHoldBars: Number(strategy.alerts?.maxHoldBars ?? 96),
    widerSlMultiple: Number(learn.widerSlMultiple ?? 1.5),
    minBarsAfterStop: Number(learn.minBarsAfterStop ?? 6),
    sweepRecoveryBars: Number(learn.sweepRecoveryBars ?? 6),
    noFavorMoveR: Number(learn.noFavorMoveR ?? 0.15),
  });

  const log = {
    date,
    generatedAt: new Date(now).toISOString(),
    window: { since: window.since, until: new Date(window.untilMs).toISOString() },
    totalLosses: losses.length,
    decided: analysis.decided ?? 0,
    counts: analysis.counts ?? {},
    verdict: analysis.verdict ?? null,
    losses: (analysis.rows ?? []).map(compactLoss),
  };

  const keep = Math.max(1, Math.min(7, Number(learn.dailyLossLogHistoryDays ?? 7)));
  state.lossLogs = [...(state.lossLogs ?? []).filter((item) => item.date !== date), log]
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .slice(-keep);
  const persist = deps.saveState ?? saveAutoRetuneState;
  await persist(state);
  return { status: existing ? 'refreshed' : 'logged', log };
}
