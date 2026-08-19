// Rà soát định kỳ tỉ lệ thua và đề xuất chỉnh cấu hình.
// Chạy:  npm run review:daily
//        npm run review:daily -- --force            bỏ qua cửa 24h
//        npm run review:daily -- --yesterday        rà ngày hôm qua (mặc định)
//        npm run review:daily -- --today            rà ngày đang chạy
//        npm run review:daily -- --telegram         gửi báo cáo vào chat cảnh báo
//        npm run review:daily -- --no-write          không ghi lại trạng thái
//        npm run review:daily -- --no-train          chỉ báo cáo, không backtest
//        npm run review:daily -- --json             in nguyên báo cáo dạng JSON
//        npm run learn:losses                        học + lưu log JSON/TXT mỗi ngày

import { loadStrategy } from '../src/config.js';
import { applyActiveTuning, readAutoRetuneState } from '../src/analysis/auto-retune.js';
import { runDailyReview, formatDailyReview } from '../src/analysis/daily-review.js';
import { writeLearningLog } from '../src/analysis/learning-log.js';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};

const baseStrategy = await loadStrategy();
if (valueOf('--state')) {
  throw new Error('--state đã bị xoá: trạng thái runtime chỉ được đọc từ PostgreSQL.');
}

// Ghi đè tại chỗ, không lưu xuống đĩa: chỉ đổi cửa sổ của lượt chạy này.
// Mặc định trong strategy.json là -1 (hôm qua) cho khớp cron 08:07 giờ VN của
// runner; --today để xem ngày đang chạy khi gọi tay giữa ngày.
const state = await readAutoRetuneState();

const strategy = applyActiveTuning(baseStrategy, state);
const dayOffset = has('--yesterday') ? -1 : (has('--today') ? 0 : null);
if (dayOffset != null) {
  strategy.dailyReview = { ...strategy.dailyReview, windowMode: 'calendar-day', dayOffsetDays: dayOffset };
}

// Chế độ chỉ đọc không được báo "đã áp dụng": state sau tiến trình sẽ bị bỏ.
if (has('--no-write')) {
  strategy.dailyReview = { ...strategy.dailyReview, autoApply: false, runtimeApply: false };
}

// Đọc từ file chỉ định thì không ghi ngược lại — tránh sửa nhầm bản sao lấy từ
// repo trạng thái. Chỉ ghi khi dùng đúng file trạng thái cục bộ.
const deps = {
  force: has('--force'),
  skipTraining: has('--no-train') || (has('--telegram') && has('--no-write')),
};
if (has('--no-write')) deps.saveState = async () => {};

const report = await runDailyReview({ strategy, state, deps });
const formatted = formatDailyReview(report);

if (has('--log-learning')) {
  const plain = formatted
    ? formatted.replace(/<\/?b>/g, '').replace(/<\/?code>/g, '`').replace(/<\/?i>/g, '')
    : `Không có báo cáo. Trạng thái: ${report.status}.`;
  const logged = await writeLearningLog(report, {
    strategy,
    activeTuning: state.activeTuning ?? null,
    text: plain,
  });
  console.error(`Đã lưu nhật ký học:\n- ${logged.jsonFile}\n- ${logged.textFile}`);
}

if (has('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const text = formatted;
  if (text) {
    console.log(text.replace(/<\/?b>/g, '').replace(/<\/?code>/g, '`'));
  } else if (report.status === 'too-soon') {
    console.log(`Chưa tới hạn rà soát. Lượt tiếp theo: ${report.nextAt}. Dùng --force để chạy ngay.`);
  } else if (report.status === 'disabled') {
    console.log('dailyReview.enabled = false trong strategy của database.');
  }
}

if (has('--telegram')) {
  const text = formatted;
  if (!text) {
    console.error('Không có gì để gửi (chưa tới hạn hoặc đã tắt).');
  } else {
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
    const chatIds = [...new Set((process.env.TELEGRAM_ALERT_CHAT_IDS ?? '')
      .split(',').map((v) => v.trim()).filter(Boolean))];
    if (!token || !chatIds.length) {
      console.error('Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_ALERT_CHAT_IDS — bỏ qua phần gửi.');
      process.exit(1);
    }
    const { Bot } = await import('grammy');
    const bot = new Bot(token);
    let delivered = 0;
    for (const chatId of chatIds) {
      try {
        await bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' });
        delivered++;
      } catch (error) {
        console.error(`Gửi ${chatId} lỗi: ${error.message}`);
      }
    }
    console.error(`Đã gửi báo cáo tới ${delivered}/${chatIds.length} chat.`);
    // Hỏng hết mà job vẫn xanh thì lượt chạy trông như thành công trong khi
    // không ai nhận được gì — đúng lúc cần biết nhất thì lại không biết.
    if (!delivered) process.exit(1);
  }
}
