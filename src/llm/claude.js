// Tầng suy luận: đưa snapshot đã tính sẵn cho Claude để nó diễn giải, cân nhắc
// tín hiệu xung đột và viết báo cáo. Claude KHÔNG tự tính chỉ báo — code tính,
// Claude lý luận trên số liệu.

import Anthropic from '@anthropic-ai/sdk';
import { loadPrompt } from '../config.js';

let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

export function hasApiKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

/** Gọn snapshot lại để giảm token mà vẫn giữ đủ thông tin cho suy luận. */
function toPromptPayload(snapshot) {
  const s = structuredClone(snapshot);
  delete s.featureNames;
  if (s.ml?.topFeatures) {
    s.ml.topFeatures = s.ml.topFeatures.map((f) => `${f.feature} (${f.pct.toFixed(1)}%)`);
  }
  return s;
}

/**
 * Sinh báo cáo phân tích. Trả về { text, usage, model, refusal? }
 */
export async function generateReport(snapshot, strategy, extra = {}) {
  if (!hasApiKey()) {
    throw new Error('Chưa cấu hình ANTHROPIC_API_KEY — dùng /quick để xem phân tích không cần AI.');
  }
  const cfg = strategy.llm || {};
  const systemPrompt = await loadPrompt();

  const userContent = [
    `Phân tích token ${snapshot.symbol} trên khung thời gian ${snapshot.interval}.`,
    extra.question ? `\nYêu cầu thêm từ người dùng: ${extra.question}` : '',
    '\nDữ liệu (JSON):\n```json',
    JSON.stringify(toPromptPayload(snapshot), null, 1),
    '```',
    '\nGhi chú về dữ liệu:',
    '- `rules.score` và `combined.score` nằm trong thang -100 (rất giảm) đến +100 (rất tăng).',
    '- `ml.probUp` là xác suất giá tăng vượt ngưỡng biến động sau `ml.horizonCandles` nến, do model gradient boosting train trên chính token này dự đoán.',
    '- `ml.testAuc` là AUC trên tập kiểm tra out-of-sample: 0.5 = vô dụng, >0.58 = khá tốt cho dữ liệu giá.',
    '- `historicalPattern` chỉ là xác nhận phụ khi `available: true`: nó nêu các đoạn giá/biên độ tương tự trong tối đa 6 tháng và diễn biến sau các đoạn đó; không diễn giải là xác suất chắc chắn.',
    '- `levels` là mức giá do công thức ATR/S-R sinh ra, bạn có thể điều chỉnh và giải thích lý do nếu thấy chưa hợp lý.',
    '- `conflicts` là các xung đột tín hiệu mà hệ thống đã tự phát hiện — bắt buộc phải đề cập nếu không rỗng.',
  ].filter(Boolean).join('\n');

  const stream = getClient().messages.stream({
    model: cfg.model || 'claude-opus-5',
    max_tokens: cfg.maxTokens || 6000,
    thinking: { type: 'adaptive' },
    output_config: { effort: cfg.effort || 'high' },
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  });

  const message = await stream.finalMessage();

  if (message.stop_reason === 'refusal') {
    return {
      text: null,
      refusal: message.stop_details?.explanation || 'Yêu cầu bị từ chối bởi bộ lọc an toàn.',
      model: message.model,
      usage: message.usage,
    };
  }

  const text = message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  return {
    text,
    model: message.model,
    usage: {
      inputTokens: message.usage?.input_tokens,
      outputTokens: message.usage?.output_tokens,
      cacheRead: message.usage?.cache_read_input_tokens,
    },
    truncated: message.stop_reason === 'max_tokens',
  };
}

/**
 * Hỏi đáp tự do về một snapshot đã có (dùng cho câu hỏi tiếp theo trong Telegram).
 */
export async function askAbout(snapshot, question, strategy) {
  if (!hasApiKey()) throw new Error('Chưa cấu hình ANTHROPIC_API_KEY');
  const cfg = strategy.llm || {};
  const stream = getClient().messages.stream({
    model: cfg.model || 'claude-opus-5',
    max_tokens: Math.min(cfg.maxTokens || 6000, 3000),
    thinking: { type: 'adaptive' },
    output_config: { effort: cfg.effort || 'high' },
    system: 'Bạn là chuyên gia phân tích kỹ thuật crypto. Trả lời ngắn gọn bằng tiếng Việt, '
      + 'chỉ dựa trên dữ liệu JSON được cung cấp, không bịa thêm dữ liệu ngoài. '
      + 'Không dùng markdown heading hay bảng.',
    messages: [{
      role: 'user',
      content: `Dữ liệu phân tích ${snapshot.symbol} ${snapshot.interval}:\n\`\`\`json\n`
        + `${JSON.stringify(toPromptPayload(snapshot), null, 1)}\n\`\`\`\n\nCâu hỏi: ${question}`,
    }],
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === 'refusal') {
    return { text: null, refusal: message.stop_details?.explanation || 'Bị từ chối bởi bộ lọc an toàn.' };
  }
  return {
    text: message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(),
    usage: message.usage,
  };
}
