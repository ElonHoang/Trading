// Vòng lặp theo dõi liên tục: gọi lại Binance theo chu kỳ, dựng lại kèo cho từng
// mã trong watchlist, và báo khi có kèo đáng vào.
//
// HAI NGUYÊN TẮC ĐỂ KHÔNG SPAM VÀ KHÔNG SAI:
//  1. Chỉ đánh giá lại khi có NẾN MỚI ĐÓNG. Chỉ báo tính trên nến đã đóng, nên
//     poll dày hơn nến cũng không ra kết quả mới — chỉ tốn request.
//  2. Chỉ báo khi tín hiệu ĐỔI so với lần báo trước (bật/tắt qua alerts.onlyOnSignalChange),
//     và khi |điểm| >= alerts.minAbsScore.

import { INTERVAL_MS } from '../data/binance.js';
import { readOpenCalls, openCall, closeCall, checkCall } from '../data/open-calls.js';
import {
  buildCallEvidence, recordClosedTrade, runAutoRetune, formatAutoRetuneReport,
} from '../analysis/auto-retune.js';

/** Dựng lại mảng nến từ series của snapshot để đối chiếu SL/TP. */
function candlesOf(snapshot) {
  const s = snapshot.series;
  if (!s?.close?.length) return [];
  return s.close.map((close, i) => ({
    openTime: s.time[i], high: s.high[i], low: s.low[i], close,
  }));
}

/**
 * @param deps.listTargets  () => Promise<[{ symbol, interval }]>
 * @param deps.evaluate     ({symbol, interval}) => Promise<{ snapshot, setup, projections }>
 * @param deps.notify       (payload) => Promise<void>
 * @param deps.loadStrategy () => Promise<strategy>
 * @param deps.log          (msg) => void
 * @param deps.stateStore   optional durable store for the de-duplication state
 */
export function createMonitor({
  listTargets, evaluate, notify, loadStrategy, log = () => {}, stateStore = null,
}) {
  const state = new Map();   // `${symbol}|${interval}` -> { lastCandleTime, lastSignal }
  let timer = null;
  let running = false;
  let stateLoaded = false;

  async function loadState() {
    if (stateLoaded) return;
    try {
      const saved = await stateStore?.load?.();
      if (saved && typeof saved === 'object') {
        for (const [key, value] of Object.entries(saved)) {
          if (typeof key === 'string' && value && typeof value === 'object') {
            state.set(key, {
              lastCandleTime: value.lastCandleTime ?? null,
              lastSignal: value.lastSignal ?? null,
            });
          }
        }
      }
    } catch (error) {
      log(`[monitor] không nạp được trạng thái: ${error.message}`);
    } finally {
      stateLoaded = true;
    }
  }

  async function saveState() {
    if (!stateStore?.save) return;
    try {
      await stateStore.save(Object.fromEntries(state));
    } catch (error) {
      log(`[monitor] không lưu được trạng thái: ${error.message}`);
    }
  }

  async function tick() {
    // Không cho hai lượt chồng nhau: một lượt chậm (nhiều mã) sẽ kéo dài quá chu kỳ.
    if (running) return;
    running = true;
    try {
      await loadState();
      const strategy = await loadStrategy();
      const cfg = strategy.alerts ?? {};
      const minAbs = cfg.minAbsScore ?? 35;
      const onlyOnChange = cfg.onlyOnSignalChange !== false;
      const maxDrift = cfg.maxEntryDriftPercent ?? null;

      const maxHoldBars = cfg.maxHoldBars ?? 96;
      const targets = await listTargets();
      const open = await readOpenCalls();

      for (const target of targets) {
        const key = `${target.symbol}|${target.interval ?? 'auto'}`;
        const prev = state.get(key) ?? {};
        try {
          const { snapshot, setup, projections } = await evaluate(target);
          const candleTime = Date.parse(snapshot.lastClosedCandleTime);
          const existing = open[snapshot.symbol];

          // --- Kèo đang mở: theo dõi tới khi chốt, KHÔNG call lại token này ---
          if (existing) {
            const result = await checkCall(existing, candlesOf(snapshot), { maxHoldBars });
            if (result.status === 'open') {
              // Chạm TP trung gian thì báo tiến độ, nhưng kèo vẫn mở.
              const newTps = result.hitTps.filter((t) => !(existing.tpHit ?? []).includes(t));
              if (newTps.length) {
                await notify({ kind: 'progress', call: existing, hitTps: newTps, snapshot });
              }
              continue;
            }
            await closeCall(snapshot.symbol);
            delete open[snapshot.symbol];
            let recorded = null;
            try {
              recorded = await recordClosedTrade({
                call: existing,
                result,
                snapshot,
                historyLimit: strategy.autoRetune?.historyLimit ?? 200,
              });
            } catch (error) {
              // Nhật ký tự học hỏng không được phép làm mất việc chốt kèo hay
              // chặn vòng quét chính; lần sau bot vẫn tiếp tục thu thập lại.
              log(`[monitor] không lưu được kết quả kèo ${snapshot.symbol}: ${error.message}`);
            }
            await notify({ kind: 'closed', call: existing, result, snapshot });
            if (result.status === 'stopped' && recorded) {
              try {
                const retune = await runAutoRetune({ strategy, state: recorded.state });
                const text = formatAutoRetuneReport(retune);
                if (text) await notify({ kind: 'auto-retune', report: retune, text });
              } catch (error) {
                log(`[monitor] tự kiểm chứng sau SL lỗi: ${error.message}`);
              }
            }
            // Vừa chốt xong thì chờ nến sau mới xét kèo mới, tránh vào lại ngay.
            state.set(key, { lastCandleTime: candleTime, lastSignal: null });
            continue;
          }

          // Nến chưa đóng thêm -> không có gì mới để nói.
          if (prev.lastCandleTime === candleTime) continue;

          const score = snapshot.combined.score;
          const signal = setup.signal;
          const changed = signal !== prev.lastSignal;

          state.set(key, { lastCandleTime: candleTime, lastSignal: signal });

          // CHỈ báo khi có kèo thật. Không bắn "đứng ngoài" hay "chờ tín hiệu" —
          // điểm cao mà bị bối cảnh phủ quyết hoặc chưa đủ đồng thuận thì không
          // phải một kèo, báo ra chỉ là nhiễu.
          if (setup.side === 'none') continue;
          if (Math.abs(score) < minAbs) continue;
          if (onlyOnChange && !changed) continue;

          // Entry, SL và TP đều neo vào giá ĐÓNG của nến đã đóng, còn vòng quét
          // thật cách nhau hàng giờ. Giá đã trôi xa thì người vào theo giá thị
          // trường có khoảng cách tới SL khác hẳn con số in trong tin, nên kèo
          // không còn là kèo đã được chấm điểm nữa — bỏ, chờ nến sau.
          if (maxDrift != null && snapshot.price?.live != null && setup.entry) {
            const drift = ((snapshot.price.live - setup.entry) / setup.entry) * 100;
            if (Math.abs(drift) > maxDrift) {
              log(`[monitor] bỏ ${snapshot.symbol} ${snapshot.interval}: giá đã lệch `
                + `${drift > 0 ? '+' : ''}${drift.toFixed(2)}% khỏi entry (tối đa ${maxDrift}%)`);
              continue;
            }
          }

          await openCall(snapshot.symbol, {
            interval: snapshot.interval,
            side: setup.side,
            entry: setup.entry,
            stopLoss: setup.stopLoss,
            targets: setup.targets,
            candleTime,
            evidence: buildCallEvidence(snapshot, setup),
          });
          open[snapshot.symbol] = { symbol: snapshot.symbol };

          await notify({
            kind: 'call',
            target, snapshot, setup, projections,
            changedFrom: prev.lastSignal ?? null,
            interval: snapshot.interval,
          });
        } catch (err) {
          log(`[monitor] ${key}: ${err.message}`);
        }
      }
    } catch (err) {
      log(`[monitor] lượt quét lỗi: ${err.message}`);
    } finally {
      await saveState();
      running = false;
    }
  }

  return {
    /** Chu kỳ poll bị kẹp tối thiểu 30s để không bị Binance rate-limit. */
    start(pollSeconds = 300) {
      const ms = Math.max(30, pollSeconds) * 1000;
      timer = setInterval(() => { tick().catch(() => {}); }, ms);
      // Chạy ngay một lượt để nạp trạng thái ban đầu.
      tick().catch(() => {});
      return ms / 1000;
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
    tick,
    /** Chu kỳ nến, dùng để chọn pollSeconds hợp lý cho khung đang theo dõi. */
    intervalMs: (interval) => INTERVAL_MS[interval] ?? null,
  };
}
