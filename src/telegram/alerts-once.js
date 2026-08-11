// One-shot alert runner for GitHub Actions. It sends monitor notifications and
// exits; unlike bot.js it never starts Telegram long polling.

import { Bot, InputFile } from 'grammy';

import { analyze } from '../analysis/engine.js';
import { buildContext } from '../analysis/context.js';
import { buildSetup, buildProjections, buildLimitPlan } from '../analysis/setup.js';
import { renderAnalysisPng } from '../chart/png.js';
import { loadStrategy } from '../config.js';
import { resolveSymbol, screenSymbols } from '../data/binance.js';
import { loadModel } from '../ml/model-store.js';
import { readWatchlist } from '../data/watchlist.js';
import { readMonitorState, saveMonitorState } from '../data/monitor-state.js';
import { setCallMessages } from '../data/open-calls.js';
import { buildCaption, buildTpUpdate, splitCaption } from './caption.js';
import { createMonitor } from './monitor.js';

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const chatIds = [...new Set(
  (process.env.TELEGRAM_ALERT_CHAT_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
)];

if (!token) {
  console.error('Thiếu TELEGRAM_BOT_TOKEN. Hãy thêm secret này trong GitHub Actions.');
  process.exit(1);
}
if (!chatIds.length) {
  console.error('Thiếu TELEGRAM_ALERT_CHAT_IDS (một hoặc nhiều chat ID, ngăn cách bằng dấu phẩy).');
  process.exit(1);
}

const bot = new Bot(token);
// 4h trước, rơi xuống 1h khi 4h chưa đủ điều kiện.
//
// Đo trên 7 cặp, chia 75% chọn / 25% mới hơn để xác nhận: 4h có lợi thế thật và
// giữ được ở đoạn giữ lại (win 56,6% · PF 1,29 · kỳ vọng +0,314%/lệnh). Cùng phép
// đo trên 1h/15m cho PF 0,64 và kỳ vọng ÂM, và win rate ở đó khớp gần đúng
// 1/(1+k) của bước giá ngẫu nhiên — tức không có lợi thế đo được.
//
// 15m đã bị bỏ khỏi danh sách vì vậy. 1h giữ lại làm phương án rơi theo yêu cầu,
// nhưng kèo sinh từ 1h KÉO win rate xuống dưới mục tiêu 70% — phần đóng góp của
// nó là điểm yếu đã biết, không phải phần đã kiểm chứng.
const CALL_INTERVALS = ['4h', '1h'];
const CANDLES = 300;

/**
 * GitHub runners bị huỷ sau mỗi lượt. Không cho auto-retune ghi strategy.json
 * rồi mất ở lượt sau; phần theo dõi/cảnh báo vẫn giữ nguyên.
 */
async function loadActionStrategy() {
  const strategy = await loadStrategy();
  return {
    ...strategy,
    autoRetune: { ...(strategy.autoRetune ?? {}), enabled: false },
  };
}

async function runAnalyze(symbolInput, interval, strategy) {
  const symbol = await resolveSymbol(symbolInput);
  const storedModel = await loadModel(symbol, interval).catch(() => null);
  return analyze(symbol, interval, strategy, {
    storedModel,
    includeSeries: true,
    seriesBars: CANDLES,
  });
}

async function evaluateOn(symbolInput, interval, strategy) {
  const snapshot = await runAnalyze(symbolInput, interval, strategy);
  const consensusPercent = strategy.thresholds?.consensusPercent ?? null;
  const dry = buildSetup(snapshot, null, { consensusPercent });
  const context = dry.side === 'none'
    ? null
    : await buildContext(snapshot.symbol).catch(() => null);
  return {
    snapshot,
    setup: context ? buildSetup(snapshot, context, { consensusPercent }) : dry,
    projections: buildProjections(snapshot, strategy.risk),
    limitPlan: buildLimitPlan(snapshot, strategy.risk),
  };
}

async function evaluateBestInterval(symbolInput, strategy) {
  const tried = [];
  for (const interval of CALL_INTERVALS) {
    try {
      const result = await evaluateOn(symbolInput, interval, strategy);
      if (result.setup.side !== 'none') return result;
      tried.push(result);
    } catch (error) {
      tried.push({ error });
    }
  }
  const usable = tried.filter((result) => result.snapshot);
  if (!usable.length) throw tried[0]?.error ?? new Error('Không phân tích được khung nào');
  usable.sort((a, b) => Math.abs(b.snapshot.combined.score) - Math.abs(a.snapshot.combined.score));
  return usable[0];
}

const monitor = createMonitor({
  loadStrategy: loadActionStrategy,
  stateStore: { load: readMonitorState, save: saveMonitorState },
  log: (message) => console.error(message),
  listTargets: async () => {
    const strategy = await loadActionStrategy();
    const cfg = strategy.alerts ?? {};
    const [screen, watch] = await Promise.all([
      screenSymbols({
        topVolume: cfg.scanTopVolume ?? 15,
        topMovers: cfg.scanTopMovers ?? 15,
        minQuoteVolumeUsd: cfg.scanMinQuoteVolumeUsd ?? 3e6,
        requireFutures: cfg.requireFutures !== false,
      }).catch(() => ({ symbols: [] })),
      readWatchlist(),
    ]);
    const symbols = [...new Set([...watch, ...screen.symbols])];
    return symbols.map((symbol) => ({ symbol, interval: null }));
  },
  evaluate: async ({ symbol, interval }) => {
    const strategy = await loadActionStrategy();
    return interval
      ? evaluateOn(symbol, interval, strategy)
      : evaluateBestInterval(symbol, strategy);
  },
  notify: async (payload) => {
    const send = async (fn) => {
      for (const chatId of chatIds) {
        await fn(chatId).catch((error) => console.error(`[monitor] gửi ${chatId} lỗi: ${error.message}`));
      }
    };

    // Báo cáo tự kiểm chứng sau 3 SL liên tiếp KHÔNG còn gửi vào chat: nó chỉ
    // sinh ra trên đường SL, mà chat giờ chỉ nhận ba mẫu tin (call kèo, chạm TP,
    // tổng hợp ngày). `monitor` ghi thẳng nó ra log của runner.

    if (payload.kind === 'progress' || payload.kind === 'tp') {
      const { call, hitTps } = payload;
      const strategy = await loadActionStrategy();
      const text = buildTpUpdate(call, hitTps, strategy.risk);
      return send((id) => bot.api.sendMessage(id, text, {
        parse_mode: 'HTML',
        ...(call.messages?.[id] ? { reply_to_message_id: call.messages[id] } : {}),
      }));
    }

    // `monitor` đã lọc trước: kèo chết trắng tay (SL/hết hạn mà chưa chạm TP nào)
    // không tới được đây. Còn lại là kèo chạm TP cuối, và kèo đã ăn ít nhất một
    // TP rồi mới quay đầu — loại sau vẫn phải báo vì người đọc đang giữ phần còn
    // lại của lệnh.
    if (payload.kind === 'closed') {
      const { call, result } = payload;
      const strategy = await loadActionStrategy();
      const reply = (id) => (call.messages?.[id]
        ? { reply_to_message_id: call.messages[id] } : {});

      if (result.status === 'target') {
        const text = `${buildTpUpdate(call, result.hitTps, strategy.risk)}\n`
          + `\n<i>Giữ ${result.bars} nến. Mã này được call lại từ nến sau.</i>`;
        return send((id) => bot.api.sendMessage(id, text, { parse_mode: 'HTML', ...reply(id) }));
      }

      // 'breakeven' = đã chốt một phần ở TP1 rồi giá quay về entry. Không phải SL:
      // gọi nó là SL sẽ báo sai kết quả và làm lệch cả chuỗi SL của auto-retune.
      const ICONS = { stopped: '🛑', breakeven: '🛡', expired: '⏱' };
      const LABELS = {
        stopped: 'CHẠM STOPLOSS',
        breakeven: 'VỀ HOÀ VỐN (SL đã kéo về entry sau TP1)',
        expired: 'HẾT HẠN GIỮ',
      };
      const icon = ICONS[result.status] ?? '⏱';
      const label = LABELS[result.status] ?? 'HẾT HẠN GIỮ';
      const change = result.lastPrice != null && call.entry
        ? ((result.lastPrice - call.entry) / call.entry) * 100 * (call.side === 'long' ? 1 : -1) : null;
      const text = `${icon} <b>${call.symbol} ${call.interval}</b> — ${label}\n`
        + `${call.side === 'long' ? 'LONG' : 'SHORT'} từ ${call.entry}`
        + (change != null ? ` · kết quả ${change >= 0 ? '+' : ''}${change.toFixed(2)}%` : '')
        + (result.hitTps.length ? ` · đã chạm ${result.hitTps.join(', ')}` : '')
        + `\nGiữ ${result.bars} nến. Mã này được call lại từ nến sau.`;
      return send((id) => bot.api.sendMessage(id, text, { parse_mode: 'HTML', ...reply(id) }));
    }

    const { snapshot, setup, projections, limitPlan, changedFrom } = payload;
    const photo = new InputFile(
      renderAnalysisPng(snapshot, { setup, limitPlan, projections }),
      `${snapshot.symbol}-${snapshot.interval}.png`,
    );
    const heading = changedFrom
      ? `🔔 ${changedFrom} → ${setup.signal}\n`
      : '🔔 KÈO MỚI\n';
    const { caption, rest } = splitCaption(heading + buildCaption(snapshot, { setup, limitPlan }));
    const messages = {};
    await send(async (id) => {
      const sent = await bot.api.sendPhoto(id, photo, { caption, parse_mode: 'HTML' });
      if (sent?.message_id) messages[id] = sent.message_id;
      if (rest) await bot.api.sendMessage(id, rest, { parse_mode: 'HTML' });
    });
    if (Object.keys(messages).length) {
      await setCallMessages(snapshot.symbol, messages).catch(() => {});
    }
  },
});

console.log(`Bắt đầu một lượt quét cảnh báo cho ${chatIds.length} chat.`);
await monitor.tick();
console.log('Đã hoàn tất lượt quét cảnh báo.');
