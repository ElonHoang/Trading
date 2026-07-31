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
import { buildSetup, buildProjections } from '../analysis/setup.js';
import { buildCaption, buildQuoteMessage } from './caption.js';

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

const DEFAULT_INTERVAL = '4h';
const CANDLES = 300;
// Các khung hay dùng, hiện thành hàng nút dưới ảnh chart.
const QUICK_INTERVALS = ['15m', '1h', '4h', '1d', '1w'];

const bot = new Bot(token);

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
  return { symbol: parts[0], interval: parts[1] || DEFAULT_INTERVAL };
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

async function sendAnalysis(ctx, symbolInput, interval, { edit = false } = {}) {
  const payload = await runAnalyze(symbolInput, interval);
  const strategy = await loadStrategy();
  // Kĩ năng 2 là lớp phụ: lỗi mạng không được làm mất phần kỹ thuật.
  const context = await buildContext(payload.symbol).catch(() => null);
  const setup = buildSetup(payload, context, {
    consensusPercent: strategy.thresholds?.consensusPercent ?? null,
  });
  const projections = buildProjections(payload, strategy.risk);

  const photo = new InputFile(
    renderAnalysisPng(payload, { setup }),
    `${payload.symbol}-${payload.interval}.png`,
  );
  const caption = buildCaption(payload, { setup, projections });
  const reply_markup = intervalKeyboard(payload.symbol, payload.interval);

  if (edit) {
    // Sửa ảnh tại chỗ khi bấm nút đổi khung. Telegram từ chối nếu nội dung y
    // nguyên hoặc tin quá cũ -> gửi tin mới thay vì để lỗi nổi lên.
    try {
      await ctx.editMessageMedia(
        { type: 'photo', media: photo, caption, parse_mode: 'HTML' },
        { reply_markup },
      );
      return;
    } catch { /* rơi xuống nhánh gửi mới */ }
  }
  await ctx.replyWithPhoto(photo, { caption, parse_mode: 'HTML', reply_markup });
}

bot.command(['start', 'help'], (ctx) => ctx.reply(HELP, { parse_mode: 'HTML' }));

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
  try {
    const list = await addSymbol(ctx.match);
    await ctx.reply(`Đã lưu. Danh sách: ${list.join(', ')}`);
  } catch (err) {
    await ctx.reply(`Không thêm được: ${err.message}`);
  }
});

bot.command('del', async (ctx) => {
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
  const list = await addSubscriber(ctx.chat.id);
  const strategy = await loadStrategy();
  const watch = await readWatchlist();
  await ctx.reply(
    `🔔 Đã bật cảnh báo tự động cho chat này (${list.length} chat đang bật).\n`
    + `Quét mỗi ${Math.max(30, strategy.alerts?.pollSeconds ?? 60)} giây, `
    + `chỉ đánh giá lại khi có nến mới đóng.\n`
    + `Báo khi |điểm| ≥ ${strategy.alerts?.minAbsScore ?? 35} hoặc khi bối cảnh phủ quyết.\n`
    + `Đang theo dõi ${watch.length} mã (khung ${DEFAULT_INTERVAL}) — thêm bằng /add.\n`
    + 'Tắt bằng /tatcanhbao.',
  );
});

bot.command('tatcanhbao', async (ctx) => {
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
      }).catch(() => ({ symbols: [] })),
      readWatchlist(),
    ]);
    // Mã người dùng tự thêm luôn được theo, kể cả khi không qua sàng lọc.
    const symbols = [...new Set([...watch, ...screen.symbols])];
    return symbols.map((symbol) => ({ symbol, interval: DEFAULT_INTERVAL }));
  },
  evaluate: async ({ symbol, interval }) => {
    const snapshot = await runAnalyze(symbol, interval);
    const strategy = await loadStrategy();
    const consensusPercent = strategy.thresholds?.consensusPercent ?? null;

    // Chỉ gọi Kĩ năng 2 khi kỹ thuật ĐÃ ra kèo. CoinGecko free chỉ cho vài chục
    // request/phút — gọi cho cả 25 mã mỗi lượt sẽ bị 429 và bối cảnh âm thầm rỗng.
    const dry = buildSetup(snapshot, null, { consensusPercent });
    const context = dry.side === 'none'
      ? null
      : await buildContext(snapshot.symbol).catch(() => null);

    return {
      snapshot,
      setup: context ? buildSetup(snapshot, context, { consensusPercent }) : dry,
      projections: buildProjections(snapshot, strategy.risk),
    };
  },
  notify: async ({ snapshot, setup, projections, changedFrom }) => {
    const chats = await readSubscribers();
    if (!chats.length) return;
    const photo = new InputFile(
      renderAnalysisPng(snapshot, { setup }),
      `${snapshot.symbol}-${snapshot.interval}.png`,
    );
    const head = changedFrom
      ? `🔔 <b>${snapshot.symbol} ${snapshot.interval}</b>: ${changedFrom} → ${setup.signal}\n`
      : `🔔 <b>${snapshot.symbol} ${snapshot.interval}</b>: ${setup.signal}\n`;
    const caption = head + buildCaption(snapshot, { setup, projections });
    for (const chatId of chats) {
      await bot.api.sendPhoto(chatId, photo, {
        caption: caption.length > 1024 ? `${caption.slice(0, 1000)}\n<i>(đã cắt)</i>` : caption,
        parse_mode: 'HTML',
      }).catch((err) => console.error(`[monitor] gửi ${chatId} lỗi:`, err.message));
    }
  },
});

bot.catch((err) => {
  // Lỗi một update không được làm chết cả bot.
  console.error('Lỗi xử lý update:', err.error?.message ?? err.message);
});

await bot.api.setMyCommands([
  { command: 'ta', description: 'Chart + kèo + lý do (vd: /ta btc 4h)' },
  { command: 'gia', description: 'Giá nhanh (vd: /gia eth)' },
  { command: 'canhbao', description: 'Bật theo dõi liên tục, tự báo khi có kèo' },
  { command: 'tatcanhbao', description: 'Tắt theo dõi liên tục' },
  { command: 'list', description: 'Danh sách theo dõi' },
  { command: 'add', description: 'Thêm mã vào danh sách' },
  { command: 'del', description: 'Bỏ mã khỏi danh sách' },
  { command: 'help', description: 'Hướng dẫn' },
]);

const strategy0 = await loadStrategy();
const poll = monitor.start(strategy0.alerts?.pollSeconds ?? 60);

const me = await bot.api.getMe();
console.log(`Bot @${me.username} đã sẵn sàng. Ctrl+C để dừng.`);
console.log(`Theo dõi liên tục: quét mỗi ${poll}s, chỉ đánh giá lại khi có nến mới đóng.`);
console.log('Bật cảnh báo trong Telegram bằng /canhbao.');

process.once('SIGINT', () => { monitor.stop(); bot.stop(); });
process.once('SIGTERM', () => { monitor.stop(); bot.stop(); });
bot.start();
