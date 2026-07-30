// Bot Telegram. Chạy: npm run bot
//
// Lệnh:
//   /a BTC 4h          phân tích đầy đủ (chỉ báo + ML + Claude)
//   /q BTC 4h          phân tích nhanh, không gọi AI (miễn phí, ~2 giây)
//   /detail            xem chi tiết từng nhóm tín hiệu của lần phân tích gần nhất
//   /ask <câu hỏi>     hỏi thêm về lần phân tích gần nhất
//   /train BTC 4h      huấn luyện model ML cho cặp này
//   /models            danh sách model đã train
//   /backtest BTC 4h   kiểm chứng chiến lược trên lịch sử
//   /config            xem cấu hình
//   /set <khoá> <giá trị>   sửa cấu hình
//   /prompt            xem system prompt của AI
//   /setprompt <text>  thay system prompt
//   /watch BTC 4h      theo dõi & tự cảnh báo
//   /unwatch BTC 4h  |  /watchlist

import { Bot, GrammyError, HttpError } from 'grammy';
import { normalizeSymbol, INTERVAL_MS } from './data/binance.js';
import {
  loadStrategy, setStrategyValue, flattenStrategy, loadPrompt, savePrompt,
  loadWatchlist, saveWatchlist,
} from './config.js';
import { analyze } from './analysis/engine.js';
import { generateReport, askAbout, hasApiKey } from './llm/claude.js';
import { trainModel } from './ml/train.js';
import { backtest } from './backtest.js';
import { listModels, deleteModel, loadModel, saveModel } from './ml/model-store.js';
import {
  formatQuick, formatBreakdown, formatSummary, formatLevels,
  formatTrainResult, formatBacktest, splitMessage,
} from './format.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Thiếu TELEGRAM_BOT_TOKEN. Tạo file .env từ .env.example rồi chạy lại.');
  process.exit(1);
}

const ALLOWED = (process.env.TELEGRAM_ALLOWED_IDS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const DEFAULT_INTERVAL = process.env.DEFAULT_INTERVAL || '4h';

const bot = new Bot(token);

// Snapshot gần nhất theo từng chat, để /detail và /ask dùng lại (khỏi gọi API lần nữa)
const lastSnapshot = new Map();
// Chống chạy trùng lệnh nặng (train/backtest) trong cùng một chat
const busy = new Set();

// ---------- Middleware ----------

bot.use(async (ctx, next) => {
  if (ALLOWED.length) {
    const id = String(ctx.from?.id ?? '');
    if (!ALLOWED.includes(id)) {
      await ctx.reply(`Bạn không có quyền dùng bot này.\nID Telegram của bạn: ${id}\n`
        + 'Thêm ID này vào TELEGRAM_ALLOWED_IDS trong file .env để mở quyền.');
      return;
    }
  }
  await next();
});

// ---------- Tiện ích ----------

async function send(ctx, text) {
  for (const chunk of splitMessage(text)) {
    await ctx.reply(chunk, { link_preview_options: { is_disabled: true } });
  }
}

/** Phân tích tham số "BTC 4h" -> { symbol, interval } */
function parseArgs(text, fallbackInterval = DEFAULT_INTERVAL) {
  const parts = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) throw new Error('Thiếu mã token. Ví dụ: /a BTC 4h');
  let interval = fallbackInterval;
  let symbolPart = parts[0];
  if (parts[1]) {
    if (INTERVAL_MS[parts[1]]) interval = parts[1];
    else throw new Error(`Khung "${parts[1]}" không hợp lệ. Hợp lệ: ${Object.keys(INTERVAL_MS).join(', ')}`);
  }
  return { symbol: normalizeSymbol(symbolPart), interval, rest: parts.slice(2).join(' ') };
}

async function guard(ctx, key, fn) {
  const chat = String(ctx.chat.id);
  const lockKey = `${chat}:${key}`;
  if (busy.has(lockKey)) {
    await ctx.reply('Đang xử lý một yêu cầu cùng loại rồi, chờ nó xong đã nhé.');
    return;
  }
  busy.add(lockKey);
  try {
    await fn();
  } catch (err) {
    console.error(`[${key}]`, err);
    await ctx.reply(`❌ ${err.message || 'Lỗi không xác định'}`);
  } finally {
    busy.delete(lockKey);
  }
}

// ---------- Lệnh ----------

const HELP = `🤖 BOT PHÂN TÍCH KỸ THUẬT AI

PHÂN TÍCH
/a <token> [khung]   Phân tích đầy đủ: chỉ báo + model ML + suy luận Claude
/q <token> [khung]   Phân tích nhanh, không gọi AI (miễn phí)
/detail              Chi tiết từng nhóm tín hiệu của lần phân tích gần nhất
/ask <câu hỏi>       Hỏi thêm về lần phân tích gần nhất
Ví dụ: /a btc 4h   ·   /q sol 1h   ·   /a eth

HUẤN LUYỆN AI
/train <token> [khung]   Train model học máy trên lịch sử giá token đó
/models                  Danh sách model đã train
/delmodel <token> [khung]  Xoá model
/backtest <token> [khung]  Kiểm chứng chiến lược trên lịch sử

CẤU HÌNH AI (phần "training/setting")
/config              Xem toàn bộ cấu hình
/set <khoá> <giá trị>  Sửa một khoá. Ví dụ: /set weights.trend 30
/prompt              Xem system prompt của Claude
/setprompt <nội dung>  Thay system prompt

CẢNH BÁO TỰ ĐỘNG
/watch <token> [khung]   Theo dõi, tự báo khi có tín hiệu mạnh
/unwatch <token> [khung]
/watchlist

Khung thời gian: ${Object.keys(INTERVAL_MS).join(' ')}
Mặc định: ${DEFAULT_INTERVAL}`;

bot.command(['start', 'help'], (ctx) => send(ctx, HELP));

bot.command(['a', 'analyze'], (ctx) => guard(ctx, 'analyze', async () => {
  const { symbol, interval } = parseArgs(ctx.match);
  const strategy = await loadStrategy();
  const status = await ctx.reply(`⏳ Đang lấy dữ liệu ${symbol} ${interval}...`);

  const snapshot = await analyze(symbol, interval, strategy, {
    storedModel: await loadModel(symbol, interval),
  });
  lastSnapshot.set(String(ctx.chat.id), snapshot);

  await send(ctx, formatSummary(snapshot) + '\n\n' + formatLevels(snapshot));

  if (!hasApiKey() || strategy.llm?.enabled === false) {
    await ctx.reply('(Phần suy luận AI bị tắt hoặc chưa có ANTHROPIC_API_KEY — dùng /detail để xem lý do chi tiết.)');
    return;
  }
  await ctx.api.editMessageText(status.chat.id, status.message_id, '🤖 Đang suy luận với Claude...');
  const report = await generateReport(snapshot, strategy);
  if (report.refusal) {
    await ctx.reply(`Claude từ chối trả lời: ${report.refusal}`);
  } else {
    await send(ctx, report.text);
    if (report.truncated) await ctx.reply('(Báo cáo bị cắt vì đạt giới hạn token — tăng llm.maxTokens nếu cần.)');
  }
  await ctx.api.deleteMessage(status.chat.id, status.message_id).catch(() => {});
}));

bot.command(['q', 'quick'], (ctx) => guard(ctx, 'analyze', async () => {
  const { symbol, interval } = parseArgs(ctx.match);
  const strategy = await loadStrategy();
  await ctx.reply(`⏳ ${symbol} ${interval}...`);
  const snapshot = await analyze(symbol, interval, strategy, {
    storedModel: await loadModel(symbol, interval),
  });
  lastSnapshot.set(String(ctx.chat.id), snapshot);
  await send(ctx, formatQuick(snapshot));
}));

bot.command('detail', async (ctx) => {
  const s = lastSnapshot.get(String(ctx.chat.id));
  if (!s) return ctx.reply('Chưa có phân tích nào. Chạy /a hoặc /q trước.');
  await send(ctx, `${s.symbol} ${s.interval}\n\n${formatBreakdown(s)}`);
});

bot.command('ask', (ctx) => guard(ctx, 'ask', async () => {
  const question = String(ctx.match || '').trim();
  if (!question) return ctx.reply('Cách dùng: /ask nếu phá 45000 thì mục tiêu tiếp theo là bao nhiêu?');
  const s = lastSnapshot.get(String(ctx.chat.id));
  if (!s) return ctx.reply('Chưa có phân tích nào. Chạy /a hoặc /q trước.');
  const strategy = await loadStrategy();
  await ctx.reply('🤖 Đang suy nghĩ...');
  const r = await askAbout(s, question, strategy);
  if (r.refusal) return ctx.reply(`Claude từ chối: ${r.refusal}`);
  await send(ctx, r.text);
}));

bot.command('train', (ctx) => guard(ctx, 'train', async () => {
  const { symbol, interval } = parseArgs(ctx.match);
  const strategy = await loadStrategy();
  const status = await ctx.reply(`🎓 Bắt đầu train ${symbol} ${interval}...`);
  let lastText = '';
  const onProgress = async (msg) => {
    if (msg === lastText) return;
    lastText = msg;
    await ctx.api.editMessageText(status.chat.id, status.message_id, `🎓 ${symbol} ${interval}\n${msg}`)
      .catch(() => {});
  };
  const { payload, verdict } = await trainModel(symbol, interval, strategy, onProgress);
  await saveModel(payload.symbol, payload.interval, payload);
  await ctx.api.deleteMessage(status.chat.id, status.message_id).catch(() => {});
  await send(ctx, formatTrainResult(payload, verdict));
}));

bot.command('models', async (ctx) => {
  const models = await listModels();
  if (!models.length) return ctx.reply('Chưa có model nào. Dùng /train BTC 4h để tạo model đầu tiên.');
  const L = ['🧠 MODEL ĐÃ TRAIN'];
  for (const m of models) {
    L.push(`\n${m.symbol} ${m.interval}`);
    L.push(`  train lúc: ${String(m.trainedAt).replace('T', ' ').slice(0, 16)} UTC`);
    L.push(`  ${m.samples} mẫu · AUC ${m.testAuc ?? '—'} · accuracy ${m.testAccuracy != null ? (m.testAccuracy * 100).toFixed(1) + '%' : '—'}`);
  }
  await send(ctx, L.join('\n'));
});

bot.command('delmodel', (ctx) => guard(ctx, 'delmodel', async () => {
  const { symbol, interval } = parseArgs(ctx.match);
  const ok = await deleteModel(symbol, interval);
  await ctx.reply(ok ? `Đã xoá model ${symbol} ${interval}.` : `Không tìm thấy model ${symbol} ${interval}.`);
}));

bot.command('backtest', (ctx) => guard(ctx, 'backtest', async () => {
  const { symbol, interval, rest } = parseArgs(ctx.match);
  const strategy = await loadStrategy();
  const nCandles = Number(rest) || 3000;
  const status = await ctx.reply(`📉 Backtest ${symbol} ${interval}...`);
  const r = await backtest(symbol, interval, strategy, {
    candles: nCandles,
    storedModel: await loadModel(symbol, interval),
    onProgress: (m) => ctx.api.editMessageText(status.chat.id, status.message_id, `📉 ${m}`).catch(() => {}),
  });
  await ctx.api.deleteMessage(status.chat.id, status.message_id).catch(() => {});
  await send(ctx, formatBacktest(r));
}));

bot.command('config', async (ctx) => {
  const strategy = await loadStrategy();
  const flat = flattenStrategy(strategy);
  const L = ['⚙️ CẤU HÌNH (dùng /set <khoá> <giá trị> để sửa)', ''];
  let group = '';
  for (const { path, value } of flat) {
    const g = path.split('.')[0];
    if (g !== group) { L.push(`── ${g} ──`); group = g; }
    L.push(`${path} = ${Array.isArray(value) ? value.join(',') : value}`);
  }
  L.push('', 'Ví dụ:');
  L.push('/set weights.trend 30          (tăng trọng số xu hướng)');
  L.push('/set ml.weightVsRules 0.6      (tin model ML nhiều hơn)');
  L.push('/set thresholds.buy 25         (khắt khe hơn khi ra tín hiệu mua)');
  L.push('/set risk.slAtrMult 2          (stoploss xa hơn)');
  L.push('/set llm.effort max            (Claude suy luận sâu hơn, tốn token hơn)');
  await send(ctx, L.join('\n'));
});

bot.command('set', (ctx) => guard(ctx, 'set', async () => {
  const parts = String(ctx.match || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    return ctx.reply('Cách dùng: /set <khoá> <giá trị>\nVí dụ: /set weights.trend 30\nXem danh sách khoá: /config');
  }
  const [key, ...valueParts] = parts;
  const r = await setStrategyValue(key, valueParts.join(' '));
  await ctx.reply(`✅ ${r.path}: ${Array.isArray(r.old) ? r.old.join(',') : r.old} → ${Array.isArray(r.value) ? r.value.join(',') : r.value}\n`
    + 'Áp dụng ngay cho lần phân tích tiếp theo.'
    + (key.startsWith('ml.') && !['ml.enabled', 'ml.weightVsRules', 'ml.minTestAuc', 'ml.confidenceMargin'].includes(key)
      ? '\n⚠️ Khoá này ảnh hưởng tới cách train — cần /train lại để có hiệu lực.' : ''));
}));

bot.command('prompt', async (ctx) => {
  const p = await loadPrompt();
  await send(ctx, `📝 SYSTEM PROMPT HIỆN TẠI\n(${p.length} ký tự)\n\n${p}`);
});

bot.command('setprompt', (ctx) => guard(ctx, 'setprompt', async () => {
  const text = String(ctx.match || '').trim();
  if (text.length < 50) {
    return ctx.reply('System prompt quá ngắn (cần >= 50 ký tự). Gửi: /setprompt <nội dung đầy đủ>\n'
      + 'Xem bản hiện tại bằng /prompt rồi sửa lại và gửi toàn bộ.');
  }
  await savePrompt(text);
  await ctx.reply(`✅ Đã cập nhật system prompt (${text.length} ký tự).`);
}));

// ---------- Watchlist & cảnh báo ----------

bot.command('watch', (ctx) => guard(ctx, 'watch', async () => {
  const { symbol, interval } = parseArgs(ctx.match);
  const list = await loadWatchlist();
  const chatId = String(ctx.chat.id);
  if (list.some((w) => w.chatId === chatId && w.symbol === symbol && w.interval === interval)) {
    return ctx.reply(`${symbol} ${interval} đã có trong danh sách theo dõi.`);
  }
  list.push({ chatId, symbol, interval, lastCandleTime: null, lastSignal: null, addedAt: new Date().toISOString() });
  await saveWatchlist(list);
  const strategy = await loadStrategy();
  await ctx.reply(`👁 Đang theo dõi ${symbol} ${interval}. Sẽ báo khi |điểm| >= ${strategy.alerts.minAbsScore}.`);
}));

bot.command('unwatch', (ctx) => guard(ctx, 'watch', async () => {
  const { symbol, interval } = parseArgs(ctx.match);
  const chatId = String(ctx.chat.id);
  const list = await loadWatchlist();
  const next = list.filter((w) => !(w.chatId === chatId && w.symbol === symbol && w.interval === interval));
  await saveWatchlist(next);
  await ctx.reply(next.length === list.length
    ? `${symbol} ${interval} không có trong danh sách.`
    : `Đã bỏ theo dõi ${symbol} ${interval}.`);
}));

bot.command('watchlist', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const list = (await loadWatchlist()).filter((w) => w.chatId === chatId);
  if (!list.length) return ctx.reply('Danh sách theo dõi trống. Thêm bằng /watch BTC 4h');
  const strategy = await loadStrategy();
  const L = [`👁 ĐANG THEO DÕI (ngưỡng báo: |điểm| >= ${strategy.alerts.minAbsScore})`];
  for (const w of list) {
    L.push(`· ${w.symbol} ${w.interval}` + (w.lastSignal ? `  — lần cuối: ${w.lastSignal}` : ''));
  }
  await send(ctx, L.join('\n'));
});

/** Vòng lặp kiểm tra watchlist: chỉ chạy khi có nến mới đóng. */
async function checkAlerts() {
  let list;
  try {
    list = await loadWatchlist();
  } catch (err) {
    console.error('[alerts] không đọc được watchlist:', err.message);
    return;
  }
  if (!list.length) return;

  let strategy;
  try {
    strategy = await loadStrategy();
  } catch (err) {
    console.error('[alerts] không đọc được strategy:', err.message);
    return;
  }
  const cfg = strategy.alerts || {};
  let changed = false;

  for (const w of list) {
    try {
      const snapshot = await analyze(w.symbol, w.interval, strategy, {
        candles: 300,
        storedModel: await loadModel(w.symbol, w.interval),
      });
      if (snapshot.lastClosedCandleTime === w.lastCandleTime) continue; // chưa có nến mới
      w.lastCandleTime = snapshot.lastClosedCandleTime;
      changed = true;

      const score = snapshot.combined.score;
      const signal = snapshot.combined.signal;
      if (Math.abs(score) < (cfg.minAbsScore ?? 35)) { w.lastSignal = signal; continue; }
      if (cfg.onlyOnSignalChange && signal === w.lastSignal) continue;
      w.lastSignal = signal;

      const text = `🔔 CẢNH BÁO ${w.symbol} ${w.interval}\n\n`
        + formatSummary(snapshot) + '\n\n' + formatLevels(snapshot)
        + '\n\nDùng /a ' + w.symbol + ' ' + w.interval + ' để xem phân tích đầy đủ.';
      for (const chunk of splitMessage(text)) {
        await bot.api.sendMessage(w.chatId, chunk, { link_preview_options: { is_disabled: true } });
      }
    } catch (err) {
      console.error(`[alerts] ${w.symbol} ${w.interval}:`, err.message);
    }
  }
  if (changed) await saveWatchlist(list).catch((e) => console.error('[alerts] lưu watchlist lỗi:', e.message));
}

// ---------- Xử lý lỗi & khởi động ----------

bot.catch((err) => {
  const e = err.error;
  if (e instanceof GrammyError) console.error('Lỗi Telegram API:', e.description);
  else if (e instanceof HttpError) console.error('Không kết nối được Telegram:', e);
  else console.error('Lỗi không xử lý:', e);
});

const strategy0 = await loadStrategy();
const pollSeconds = Math.max(30, strategy0.alerts?.pollSeconds ?? 60);
const alertTimer = setInterval(() => { checkAlerts().catch(console.error); }, pollSeconds * 1000);

await bot.api.setMyCommands([
  { command: 'a', description: 'Phân tích đầy đủ (có AI)' },
  { command: 'q', description: 'Phân tích nhanh (không AI)' },
  { command: 'detail', description: 'Chi tiết tín hiệu lần gần nhất' },
  { command: 'ask', description: 'Hỏi thêm về phân tích gần nhất' },
  { command: 'train', description: 'Train model ML cho một cặp' },
  { command: 'models', description: 'Danh sách model đã train' },
  { command: 'backtest', description: 'Kiểm chứng chiến lược trên lịch sử' },
  { command: 'config', description: 'Xem cấu hình AI' },
  { command: 'set', description: 'Sửa cấu hình AI' },
  { command: 'prompt', description: 'Xem system prompt' },
  { command: 'watch', description: 'Theo dõi & cảnh báo tự động' },
  { command: 'watchlist', description: 'Danh sách đang theo dõi' },
  { command: 'help', description: 'Hướng dẫn' },
]).catch(() => {});

process.once('SIGINT', () => { clearInterval(alertTimer); bot.stop(); });
process.once('SIGTERM', () => { clearInterval(alertTimer); bot.stop(); });

console.log('Bot đang chạy. Kiểm tra cảnh báo mỗi', pollSeconds, 'giây.');
console.log(hasApiKey() ? 'Claude: đã có API key.' : 'Claude: CHƯA có API key — chỉ /q hoạt động.');
console.log(ALLOWED.length ? `Chỉ cho phép ID: ${ALLOWED.join(', ')}` : '⚠️ Chưa giới hạn người dùng (TELEGRAM_ALLOWED_IDS trống) — ai có link bot cũng dùng được.');
bot.start();
