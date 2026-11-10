// Cài đặt cảnh báo do người dùng chỉnh từ trang web (bot.html), lưu ở
// Trading-state/data/bot-config.json và được runner khôi phục mỗi lượt quét.
//
// Module THUẦN (không import node:*) để web và bot dùng CHUNG một bộ kiểm tra: web báo
// lỗi ngay khi nhập, bot kiểm lại lần nữa vì file có thể bị sửa ở nơi khác.
//
// Nguyên tắc an toàn:
//  - chỉ ba tham số được phép chỉnh; mọi khoá khác bị bỏ qua;
//  - tham số nào sai thì KHÔNG áp dụng (bot dùng mặc định của repo) và lỗi được báo lại,
//    thay vì làm hỏng cả lượt quét;
//  - các tham số rủi ro (SL/TP, ngưỡng MUA/BÁN, cổng đồng thuận…) cố ý không có ở đây.

export const BOT_CONFIG_PATH = 'data/bot-config.json';

export const BOT_CONFIG_LIMITS = Object.freeze({
  maxSymbols: 30,
  minAbsScore: Object.freeze({ min: 20, max: 90 }),
  maxEntryDriftPercent: Object.freeze({ min: 0.2, max: 10 }),
});

// Cặp USDT như BTCUSDT hay 1000PEPEUSDT; bot còn đối chiếu với danh sách futures thật.
const SYMBOL_RE = /^[A-Z0-9]{1,15}USDT$/;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function checkNumber(value, { min, max }, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${label} phải là một số.`;
  if (value < min || value > max) return `${label} phải nằm trong khoảng ${min}–${max}.`;
  return null;
}

/**
 * Kiểm tra và chuẩn hoá một cấu hình thô. Không bao giờ ném lỗi.
 * Trả về `config` chỉ chứa những tham số HỢP LỆ, và `errors` liệt kê những gì đã bị bỏ.
 */
export function normalizeBotConfig(raw) {
  const config = {};
  const errors = [];
  if (raw == null) return { config, errors };
  if (!isPlainObject(raw)) return { config, errors: ['Cấu hình phải là một đối tượng JSON.'] };

  if (raw.tradeSymbols !== undefined) {
    const problems = [];
    const list = [];
    if (!Array.isArray(raw.tradeSymbols)) {
      problems.push('Danh sách mã phải là một mảng.');
    } else {
      const seen = new Set();
      for (const item of raw.tradeSymbols) {
        const symbol = String(item ?? '').trim().toUpperCase();
        if (!SYMBOL_RE.test(symbol)) {
          problems.push(`Mã "${String(item ?? '').slice(0, 24)}" không hợp lệ (cần dạng BTCUSDT).`);
        } else if (!seen.has(symbol)) {
          seen.add(symbol);
          list.push(symbol);
        }
      }
      if (!list.length && !problems.length) problems.push('Danh sách mã đang trống: bot cần ít nhất một mã.');
      if (list.length > BOT_CONFIG_LIMITS.maxSymbols) {
        problems.push(`Tối đa ${BOT_CONFIG_LIMITS.maxSymbols} mã (đang có ${list.length}).`);
      }
    }
    if (problems.length) errors.push(...problems);
    else config.tradeSymbols = list;
  }

  if (raw.minAbsScore !== undefined) {
    const problem = checkNumber(raw.minAbsScore, BOT_CONFIG_LIMITS.minAbsScore, 'Điểm tối thiểu');
    if (problem) errors.push(problem);
    else config.minAbsScore = raw.minAbsScore;
  }

  // null = tắt bộ lọc độ trôi giá (monitor.js hiểu null là không giới hạn).
  if (raw.maxEntryDriftPercent !== undefined) {
    if (raw.maxEntryDriftPercent === null) {
      config.maxEntryDriftPercent = null;
    } else {
      const problem = checkNumber(raw.maxEntryDriftPercent, BOT_CONFIG_LIMITS.maxEntryDriftPercent, 'Độ trôi giá tối đa');
      if (problem) errors.push(problem);
      else config.maxEntryDriftPercent = raw.maxEntryDriftPercent;
    }
  }

  return { config, errors };
}

/** Đọc từ văn bản JSON (nội dung file). JSON hỏng -> cấu hình rỗng kèm một lỗi. */
export function parseBotConfigText(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { config: {}, errors: ['File cấu hình không phải JSON hợp lệ.'] };
  }
  return normalizeBotConfig(raw);
}

/** Nội dung file để ghi đi: chỉ những tham số hợp lệ, kèm số phiên bản. */
export function serializeBotConfig(config) {
  const { config: clean } = normalizeBotConfig(config);
  return `${JSON.stringify({ version: 1, ...clean }, null, 2)}\n`;
}

/**
 * Trả về BẢN SAO của strategy với phần `alerts` đã ghi đè bằng cấu hình của người dùng.
 * Không sửa strategy gốc, và chỉ chạm vào những khoá thật sự có trong `config`.
 */
export function applyBotConfig(strategy, config) {
  const { config: clean } = normalizeBotConfig(config);
  if (!Object.keys(clean).length) return strategy;
  return { ...strategy, alerts: { ...(strategy.alerts ?? {}), ...clean } };
}

/** Một dòng tóm tắt để ghi log hoặc hiện lên web. */
export function describeBotConfig(config) {
  const parts = [];
  if (config.tradeSymbols) parts.push(`${config.tradeSymbols.length} mã`);
  if ('minAbsScore' in config) parts.push(`điểm tối thiểu ${config.minAbsScore}`);
  if ('maxEntryDriftPercent' in config) {
    parts.push(config.maxEntryDriftPercent === null ? 'không giới hạn độ trôi giá' : `độ trôi giá tối đa ${config.maxEntryDriftPercent}%`);
  }
  return parts.join(', ') || 'không có tham số nào';
}
