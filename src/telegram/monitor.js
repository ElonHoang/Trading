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
 */
export function createMonitor({
  listTargets, evaluate, notify, loadStrategy, log = () => {}, initialState = {},
}) {
  // `${symbol}|${interval}` -> { lastCandleTime, lastSignal }
  // Với GitHub Actions, initialState được nạp từ repo trạng thái private để
  // lần chạy mới không coi lại cùng một cây nến là tín hiệu mới.
  const state = new Map(Object.entries(initialState ?? {}));
  let timer = null;
  let running = false;

  async function tick() {
    // Không cho hai lượt chồng nhau: một lượt chậm (nhiều mã) sẽ kéo dài quá chu kỳ.
    if (running) return;
    running = true;
    try {
      const strategy = await loadStrategy();
      const cfg = strategy.alerts ?? {};
      const minAbs = cfg.minAbsScore ?? 35;
      const onlyOnChange = cfg.onlyOnSignalChange !== false;

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
            await notify({ kind: 'closed', call: existing, result, snapshot });
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

          await openCall(snapshot.symbol, {
            interval: snapshot.interval,
            side: setup.side,
            entry: setup.entry,
            stopLoss: setup.stopLoss,
            targets: setup.targets,
            candleTime,
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
      running = false;
    }
  }

  return {
    /** Chu kỳ poll bị kẹp tối thiểu 30s để không bị Binance rate-limit. */
    start(pollSeconds = 60) {
      const ms = Math.max(30, pollSeconds) * 1000;
      timer = setInterval(() => { tick().catch(() => {}); }, ms);
      // Chạy ngay một lượt để nạp trạng thái ban đầu.
      tick().catch(() => {});
      return ms / 1000;
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
    tick,
    snapshotState: () => Object.fromEntries(state),
    /** Chu kỳ nến, dùng để chọn pollSeconds hợp lý cho khung đang theo dõi. */
    intervalMs: (interval) => INTERVAL_MS[interval] ?? null,
  };
}
