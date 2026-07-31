// Bot Telegram phân tích kỹ thuật. Dùng lại đúng tầng dữ liệu, chỉ báo và bộ vẽ
// chart của web UI -> số liệu trên bot và trên web luôn khớp nhau.
//
// Chạy: npm run bot   (token đọc từ biến môi trường TELEGRAM_BOT_TOKEN)

import { Bot, InputFile, InlineKeyboard } from 'grammy';

import { analyze } from '../analysis/analyze.js';
import { renderAnalysisPng } from '../chart/png.js';
import { INTERVAL_MS } from '../data/binance.js';
import { readWatchlist, addSymbol, removeSymbol } from '../data/watchlist.js';
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

async function sendAnalysis(ctx, symbolInput, interval, { edit = false } = {}) {
  const payload = await analyze(symbolInput, interval, CANDLES);
  const photo = new InputFile(
    renderAnalysisPng(payload),
    `${payload.symbol}-${payload.interval}.png`,
  );
  const caption = buildCaption(payload);
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
    const payload = await analyze(symbol, interval, CANDLES);
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

bot.catch((err) => {
  // Lỗi một update không được làm chết cả bot.
  console.error('Lỗi xử lý update:', err.error?.message ?? err.message);
});

await bot.api.setMyCommands([
  { command: 'ta', description: 'Chart + chỉ báo (vd: /ta btc 4h)' },
  { command: 'gia', description: 'Giá nhanh (vd: /gia eth)' },
  { command: 'list', description: 'Danh sách theo dõi' },
  { command: 'add', description: 'Thêm mã vào danh sách' },
  { command: 'del', description: 'Bỏ mã khỏi danh sách' },
  { command: 'help', description: 'Hướng dẫn' },
]);

const me = await bot.api.getMe();
console.log(`Bot @${me.username} đã sẵn sàng. Ctrl+C để dừng.`);
bot.start();
