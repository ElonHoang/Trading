// Bot Telegram phân tích kỹ thuật. Dùng lại đúng tầng dữ liệu, chỉ báo và bộ vẽ
// chart của web UI -> số liệu trên bot và trên web luôn khớp nhau.
//
// Chạy: npm run bot   (token đọc từ biến môi trường TELEGRAM_BOT_TOKEN)

import { Bot, InputFile, InlineKeyboard } from 'grammy';

import { analyze } from '../analysis/engine.js';
import { renderAnalysisPng } from '../chart/png.js';
import { INTERVAL_MS, resolveSymbol, screenSymbols } from '../data/binance.js';
import { loadStrategy } from '../config.js';
import { loadModel } from '../ml/model-store.js';
import { readWatchlist, addSymbol, removeSymbol } from '../data/watchlist.js';
import { readSubscribers, addSubscriber, removeSubscriber } from '../data/subscribers.js';
import { createMonitor } from './monitor.js';
import { buildContext } from '../analysis/context.js';
import { buildSetup, buildProjections, buildLimitPlan } from '../analysis/setup.js';
import { buildCaption, buildClosedNote, buildQuoteMessage, splitCaption, buildTpUpdate } from './caption.js';
import { setCallMessages } from '../data/open-calls.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error(`Thiếu TELEGRAM_BOT_TOKEN.

Cách lấy token:
  1. Mở Telegram, chat với @BotFather
  2. Gửi /newbot rồi làm theo hướng dẫn
  3. Copy token dạng 123456789:AAF...

Sau đó tạo file .env ở gốc project (đã nằm trong .gitignore):
  TELEGRAM_BOT_TOKEN=123456789:AAF...

Rồi chạy lại: npm run bot`);
  process.exit(1);
}

// Khung dùng để CALL KÈO. Xét theo thứ tự này: 1h trước vì ít nhiễu hơn, chỉ
// rơi xuống 15m khi 1h chưa đủ điều kiện. Không dùng 4h để call nữa — nhưng vẫn
// xem được 4h/1d/1w bằng nút bấm hoặc /ta btc 4h.
// 4h trước, rơi xuống 1h. Lý do đầy đủ ở src/telegram/alerts-once.js — tóm lại:
// 4h là khung duy nhất có lợi thế giữ được trên đoạn dữ liệu giữ lại (PF 1,29),
// còn 1h/15m cho PF 0,64 và kỳ vọng âm. Hai file phải giữ cùng danh sách.
const CALL_INTERVALS = ['4h', '1h'];
const DEFAULT_INTERVAL = CALL_INTERVALS[0];
const CANDLES = 300;
// Các khung hay dùng, hiện thành hàng nút dưới ảnh chart.
const QUICK_INTERVALS = ['15m', '1h', '4h', '1d', '1w'];

// Chỉ những user id này được dùng lệnh GHI (/canhbao, /tatcanhbao, /add, /del).
// Mặc định FAIL-CLOSED: chưa khai báo thì chặn hết, vì bot có thể đang ở trong
// group và ai cũng sửa được watchlist dùng chung.
const OWNER_IDS = (process.env.TELEGRAM_OWNER_IDS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const bot = new Bot(token);

/**
 * Chặn lệnh ghi nếu không phải chủ bot. Trả false khi đã từ chối (phía gọi
 * dừng lại). Thông báo kèm luôn user id để chủ bot tự thêm vào .env.
 */
async function requireOwner(ctx) {
  const userId = String(ctx.from?.id ?? '');
  if (OWNER_IDS.includes(userId)) return true;

  if (!OWNER_IDS.length) {
    await ctx.reply(
      '🔒 Lệnh này chỉ dành cho chủ bot, nhưng <code>TELEGRAM_OWNER_IDS</code> đang trống '
      + 'nên tôi chặn tất cả cho an toàn.\n\n'
      + `User id của bạn: <code>${userId}</code>\n\n`
      + 'Thêm vào file <code>.env</code> rồi khởi động lại bot:\n'
      + `<code>TELEGRAM_OWNER_IDS=${userId}</code>`,
      { parse_mode: 'HTML' },
    );
  } else {
    await ctx.reply(`🔒 Chỉ chủ bot dùng được lệnh này. User id của bạn: <code>${userId}</code>`,
      { parse_mode: 'HTML' });
  }
  return false;
}

const HELP = `<b>Bot phân tích kỹ thuật crypto</b>
Dữ liệu từ REST công khai của Binance.

/ta &lt;mã&gt; [khung] — chart + chỉ báo
   ví dụ: /ta btc   ·   /ta eth 1h   ·   /ta sol 1d
/gia &lt;mã&gt; — giá nhanh, không kèm ảnh
/list — danh sách theo dõi
/add &lt;mã&gt; — thêm vào danh sách
/del &lt;mã&gt; — bỏ khỏi danh sách

Khung hợp lệ: ${Object.keys(INTERVAL_MS).join(', ')}
Mặc định ${DEFAULT_INTERVAL}. Mã không cần ghi USDT (btc = BTCUSDT).`;

function intervalKeyboard(symbol, current) {
  const kb = new InlineKeyboard();
  for (const iv of QUICK_INTERVALS) {
    kb.text(iv === current ? `• ${iv}` : iv, `ta:${symbol}:${iv}`);
  }
  return kb;
}

/** Tách "btc 1h" thành { symbol, interval }; thiếu khung thì dùng mặc định. */
function parseArgs(text) {
  const parts = String(text || '').trim().split(/\s+/).filter(Boolean);
  // interval = null -> bot tu chon khung theo CALL_INTERVALS.
  return { symbol: parts[0], interval: parts[1] ?? null };
}

/** Gọi engine dùng chung: cùng số liệu với CLI, bot AI và dashboard. */
async function runAnalyze(symbolInput, interval) {
  const symbol = await resolveSymbol(symbolInput);
  const strategy = await loadStrategy();
  const storedModel = await loadModel(symbol, interval).catch(() => null);
  return analyze(symbol, interval, strategy, {
    storedModel, includeSeries: true, seriesBars: CANDLES,
  });
}

/**
 * Dựng kèo trên một khung cụ thể. Kĩ năng 2 là lớp phụ nên lỗi mạng của nó
 * không được làm mất phần kỹ thuật.
 */
async function evaluateOn(symbolInput, interval, strategy) {
  const snapshot = await runAnalyze(symbolInput, interval);
  const consensusPercent = strategy.thresholds?.consensusPercent ?? null;
  // Chạy khan trước để biết có kèo hay không — chỉ gọi Kĩ năng 2 khi cần, vì
  // CoinGecko giới hạn vài chục request/phút.
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

/**
 * Chọn khung để call kèo: xét lần lượt CALL_INTERVALS, lấy khung ĐẦU TIÊN ra
 * được kèo thật. Không khung nào đủ điều kiện thì trả về khung có |điểm| cao
 * nhất để vẫn báo cáo số liệu thay vì im lặng.
 */
async function evaluateBestInterval(symbolInput, strategy) {
  const tried = [];
  for (const iv of CALL_INTERVALS) {
    try {
      const r = await evaluateOn(symbolInput, iv, strategy);
      if (r.setup.side !== 'none') return { ...r, triedIntervals: CALL_INTERVALS };
      tried.push(r);
    } catch (err) {
      // Khung nhỏ có thể thiếu nến với token mới list -> thử khung tiếp theo.
      tried.push({ error: err });
    }
  }
  const usable = tried.filter((r) => r.snapshot);
  if (!usable.length) throw tried[0]?.error ?? new Error('Không phân tích được khung nào');
  usable.sort((a, b) => Math.abs(b.snapshot.combined.score) - Math.abs(a.snapshot.combined.score));
  return { ...usable[0], triedIntervals: CALL_INTERVALS };
}

async function sendAnalysis(ctx, symbolInput, interval, { edit = false } = {}) {
  const strategy = await loadStrategy();
  // interval = null -> tự chọn khung theo CALL_INTERVALS.
  const { snapshot: payload, setup, projections, limitPlan } = interval
    ? await evaluateOn(symbolInput, interval, strategy)
    : await evaluateBestInterval(symbolInput, strategy);

  const photo = new InputFile(
    renderAnalysisPng(payload, { setup, limitPlan, projections }),
    `${payload.symbol}-${payload.interval}.png`,
  );
  // Template đầy đủ có thể vượt 1024 ký tự -> tách phần dư sang tin nhắn riêng
  // thay vì cắt mất kịch bản chờ.
  const { caption, rest } = splitCaption(buildCaption(payload, { setup, limitPlan }));
  const reply_markup = intervalKeyboard(payload.symbol, payload.interval);

  if (edit) {
    // Sửa ảnh tại chỗ khi bấm nút đổi khung. Telegram từ chối nếu nội dung y
    // nguyên hoặc tin quá cũ -> gửi tin mới thay vì để lỗi nổi lên.
    try {
      await ctx.editMessageMedia(
        { type: 'photo', media: photo, caption, parse_mode: 'HTML' },
        { reply_markup },
      );
      if (rest) await ctx.reply(rest, { parse_mode: 'HTML' });
      return;
    } catch { /* rơi xuống nhánh gửi mới */ }
  }
  await ctx.replyWithPhoto(photo, { caption, parse_mode: 'HTML', reply_markup });
  if (rest) await ctx.reply(rest, { parse_mode: 'HTML' });
}

bot.command(['start', 'help'], (ctx) => ctx.reply(HELP, { parse_mode: 'HTML' }));

// Ai cũng xem được id của mình — cần để chủ bot lấy id đưa vào TELEGRAM_OWNER_IDS.
bot.command('id', (ctx) => ctx.reply(
  `User id: <code>${ctx.from?.id}</code>\nChat id: <code>${ctx.chat?.id}</code>`
  + `\nQuyền lệnh ghi: ${OWNER_IDS.includes(String(ctx.from?.id)) ? '✅ có' : '❌ không'}`,
  { parse_mode: 'HTML' },
));

bot.command('ta', async (ctx) => {
  const { symbol, interval } = parseArgs(ctx.match);
  if (!symbol) {
    return ctx.reply('Thiếu mã. Ví dụ: <code>/ta btc 4h</code>', { parse_mode: 'HTML' });
  }
  await ctx.replyWithChatAction('upload_photo');
  try {
    await sendAnalysis(ctx, symbol, interval);
  } catch (err) {
    await ctx.reply(`Không phân tích được: ${err.message}`);
  }
});

bot.command('gia', async (ctx) => {
  const { symbol, interval } = parseArgs(ctx.match);
  if (!symbol) {
    return ctx.reply('Thiếu mã. Ví dụ: <code>/gia btc</code>', { parse_mode: 'HTML' });
  }
  await ctx.replyWithChatAction('typing');
  try {
    const payload = await runAnalyze(symbol, interval);
    await ctx.reply(buildQuoteMessage(payload), { parse_mode: 'HTML' });
  } catch (err) {
    await ctx.reply(`Không lấy được giá: ${err.message}`);
  }
});

bot.command('list', async (ctx) => {
  const list = await readWatchlist();
  if (!list.length) return ctx.reply('Danh sách theo dõi đang rỗng. Thêm bằng /add btc');
  await ctx.reply(`Đang theo dõi:\n${list.map((s) => `· ${s}`).join('\n')}`);
});

bot.command('add', async (ctx) => {
  if (!await requireOwner(ctx)) return;
  try {
    const list = await addSymbol(ctx.match);
    await ctx.reply(`Đã lưu. Danh sách: ${list.join(', ')}`);
  } catch (err) {
    await ctx.reply(`Không thêm được: ${err.message}`);
  }
});

bot.command('del', async (ctx) => {
  if (!await requireOwner(ctx)) return;
  const list = await removeSymbol(ctx.match);
  await ctx.reply(list.length ? `Còn lại: ${list.join(', ')}` : 'Danh sách đã rỗng.');
});

// Bấm nút đổi khung thời gian dưới ảnh chart.
bot.callbackQuery(/^ta:([A-Z0-9]+):(\S+)$/, async (ctx) => {
  const [, symbol, interval] = ctx.match;
  await ctx.answerCallbackQuery(`Đang tải ${symbol} ${interval}…`);
  try {
    await sendAnalysis(ctx, symbol, interval, { edit: true });
  } catch (err) {
    await ctx.reply(`Không phân tích được: ${err.message}`);
  }
});

/* ---------- theo dõi liên tục ---------- */

bot.command('canhbao', async (ctx) => {
  if (!await requireOwner(ctx)) return;
  const list = await addSubscriber(ctx.chat.id);
  const strategy = await loadStrategy();
  const watch = await readWatchlist();
  const pollSeconds = Math.max(30, strategy.alerts?.pollSeconds ?? 300);
  const pollLabel = pollSeconds % 60 === 0 ? `${pollSeconds / 60} phút` : `${pollSeconds} giây`;
  await ctx.reply(
    `🔔 Đã bật cảnh báo tự động cho chat này (${list.length} chat đang bật).\n`
    + `Quét mỗi ${pollLabel}, `
    + `chỉ đánh giá lại khi có nến mới đóng.\n`
    + `Báo khi |điểm| ≥ ${strategy.alerts?.minAbsScore ?? 35} hoặc khi bối cảnh phủ quyết.\n`
    + `Đang theo dõi ${watch.length} mã (khung ${DEFAULT_INTERVAL}) — thêm bằng /add.\n`
    + 'Tắt bằng /tatcanhbao.',
  );
});

bot.command('tatcanhbao', async (ctx) => {
  if (!await requireOwner(ctx)) return;
  await removeSubscriber(ctx.chat.id);
  await ctx.reply('🔕 Đã tắt cảnh báo tự động cho chat này.');
});

const monitor = createMonitor({
  loadStrategy,
  log: (m) => console.error(m),
  listTargets: async () => {
    const chats = await readSubscribers();
    // Không có ai bật cảnh báo thì khỏi gọi Binance.
    if (!chats.length) return [];

    const strategy = await loadStrategy();
    const cfg = strategy.alerts ?? {};
    // Sàng lọc rẻ: 1 request lấy ticker toàn sàn (80 weight) rồi chọn ra ít mã
    // đáng đào sâu. Gọi analyze cho cả 479 cặp sẽ tốn ~26.800 weight/lượt,
    // vượt xa giới hạn 6.000/phút của Binance.
    const [screen, watch] = await Promise.all([
      screenSymbols({
        topVolume: cfg.scanTopVolume ?? 15,
        topMovers: cfg.scanTopMovers ?? 15,
        minQuoteVolumeUsd: cfg.scanMinQuoteVolumeUsd ?? 3e6,
        requireFutures: cfg.requireFutures !== false,
      }).catch(() => ({ symbols: [] })),
      readWatchlist(),
    ]);
    // Mã người dùng tự thêm luôn được theo, kể cả khi không qua sàng lọc.
    const symbols = [...new Set([...watch, ...screen.symbols])];
    // interval = null -> monitor tu chon khung theo CALL_INTERVALS.
    return symbols.map((symbol) => ({ symbol, interval: null }));
  },
  evaluate: async ({ symbol, interval }) => {
    const strategy = await loadStrategy();
    // Kĩ năng 2 chỉ được gọi khi kỹ thuật đã ra kèo (xem evaluateOn) — CoinGecko
    // giới hạn vài chục request/phút, gọi cho cả 24 mã mỗi lượt sẽ bị 429.
    return interval
      ? evaluateOn(symbol, interval, strategy)
      : evaluateBestInterval(symbol, strategy);
  },
  notify: async (payload) => {
    const chats = await readSubscribers();
    if (!chats.length) return;
    const send = async (fn) => {
      for (const chatId of chats) {
        await fn(chatId).catch((err) => console.error(`[monitor] gửi ${chatId} lỗi:`, err.message));
      }
    };

    // Báo cáo tự kiểm chứng sau 3 SL liên tiếp KHÔNG còn gửi vào chat: nó chỉ
    // sinh ra trên đường SL, mà chat giờ chỉ nhận ba mẫu tin (call kèo, chạm TP,
    // tổng hợp ngày). `monitor` ghi thẳng nó ra log của tiến trình.

    // --- Chạm TP: theo template "cấu trúc sau khi done tp call kèo" ---
    if (payload.kind === 'progress' || payload.kind === 'tp') {
      const { call, hitTps } = payload;
      const strategy = await loadStrategy();
      const txt = buildTpUpdate(call, hitTps, strategy.risk);
      return send((id) => bot.api.sendMessage(id, txt, {
        parse_mode: 'HTML',
        // Trích dẫn lại kèo gốc nếu còn lưu được message id.
        ...(call.messages?.[id] ? { reply_to_message_id: call.messages[id] } : {}),
      }));
    }

    // --- Kèo đã chốt ---
    //
    // `monitor` đã lọc trước: kèo chết trắng tay (SL/hết hạn mà chưa chạm TP nào)
    // không tới được đây. Còn lại là kèo chạm TP cuối, và kèo đã ăn ít nhất một
    // TP rồi mới quay đầu — loại sau vẫn phải báo vì người đọc đang giữ phần còn
    // lại của lệnh.
    if (payload.kind === 'closed') {
      const { call, result } = payload;
      const strategy = await loadStrategy();
      const reply = (id) => (call.messages?.[id]
        ? { reply_to_message_id: call.messages[id] } : {});

      // Chốt vì chạm TP cuối -> dùng đúng template cập nhật TP.
      if (result.status === 'target') {
        const txt = buildTpUpdate(call, result.hitTps, strategy.risk);
        return send((id) => bot.api.sendMessage(id, txt, { parse_mode: 'HTML', ...reply(id) }));
      }

      const txt = buildClosedNote(call, result, {
        risk: strategy.risk,
        feePercent: strategy.dailyReview?.feePercent,
      });
      return send((id) => bot.api.sendMessage(id, txt, { parse_mode: 'HTML', ...reply(id) }));
    }

    // --- Call kèo mới ---
    const { snapshot, setup, projections, limitPlan, changedFrom } = payload;
    const photo = new InputFile(
      renderAnalysisPng(snapshot, { setup, limitPlan, projections }),
      `${snapshot.symbol}-${snapshot.interval}.png`,
    );
    const head = changedFrom
      ? `🔔 ${changedFrom} → ${setup.signal}\n`
      : '🔔 KÈO MỚI\n';
    const { caption, rest } = splitCaption(head + buildCaption(snapshot, { setup, limitPlan }));
    // Giữ message id để tin cập nhật TP sau này reply vào đúng kèo gốc.
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

bot.catch((err) => {
  // Lỗi một update không được làm chết cả bot.
  console.error('Lỗi xử lý update:', err.error?.message ?? err.message);
});

await bot.api.setMyCommands([
  { command: 'ta', description: 'Call kèo, tự chọn khung 1h/15m (vd: /ta btc)' },
  { command: 'id', description: 'Xem user id và quyền của bạn' },
  { command: 'gia', description: 'Giá nhanh (vd: /gia eth)' },
  { command: 'canhbao', description: 'Bật theo dõi liên tục, tự báo khi có kèo' },
  { command: 'tatcanhbao', description: 'Tắt theo dõi liên tục' },
  { command: 'list', description: 'Danh sách theo dõi' },
  { command: 'add', description: 'Thêm mã vào danh sách' },
  { command: 'del', description: 'Bỏ mã khỏi danh sách' },
  { command: 'help', description: 'Hướng dẫn' },
]);

const strategy0 = await loadStrategy();
const poll = monitor.start(strategy0.alerts?.pollSeconds ?? 300);

const me = await bot.api.getMe();
console.log(`Bot @${me.username} đã sẵn sàng. Ctrl+C để dừng.`);
console.log(`Theo dõi liên tục: quét mỗi ${poll}s, chỉ đánh giá lại khi có nến mới đóng.`);
console.log('Bật cảnh báo trong Telegram bằng /canhbao.');

process.once('SIGINT', () => { monitor.stop(); bot.stop(); });
process.once('SIGTERM', () => { monitor.stop(); bot.stop(); });
bot.start();
