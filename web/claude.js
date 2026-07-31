// Gọi Claude trực tiếp từ browser.
//
// Vì trang này là tĩnh (GitHub Pages) nên không có backend để giữ key; API key do
// người dùng tự nhập, nằm trong localStorage của chính họ và chỉ được gửi tới
// api.anthropic.com. Anthropic yêu cầu header `anthropic-dangerous-direct-browser-access`
// để bật CORS cho trường hợp này.
//
// Dùng fetch thay vì @anthropic-ai/sdk vì không có bước build/bundler — không thể
// import package npm trực tiếp trong browser. Bản Node (src/llm/claude.js) vẫn
// dùng SDK chính thức.

import { loadPrompt, getApiKey } from './store.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

/** Bỏ những phần không cần cho suy luận để tiết kiệm token. */
function toPromptPayload(snapshot) {
  const s = structuredClone(snapshot);
  delete s.featureNames;
  delete s.series; // chuỗi vẽ biểu đồ: rất dài và vô ích cho lý luận
  if (s.ml?.topFeatures) {
    s.ml.topFeatures = s.ml.topFeatures.map((f) => `${f.feature} (${f.pct.toFixed(1)}%)`);
  }
  return s;
}

function buildUserContent(snapshot, extraQuestion) {
  return [
    `Phân tích token ${snapshot.symbol} trên khung thời gian ${snapshot.interval}.`,
    extraQuestion ? `\nYêu cầu thêm từ người dùng: ${extraQuestion}` : '',
    '\nDữ liệu (JSON):\n```json',
    JSON.stringify(toPromptPayload(snapshot), null, 1),
    '```',
    '\nGhi chú về dữ liệu:',
    '- `rules.score` và `combined.score` nằm trong thang -100 (rất giảm) đến +100 (rất tăng).',
    '- `ml.probUp` là xác suất giá tăng vượt ngưỡng biến động sau `ml.horizonCandles` nến, do model gradient boosting train trên chính token này dự đoán.',
    '- `ml.testAuc` là AUC trên tập kiểm tra out-of-sample: 0.5 = vô dụng, >0.58 = khá tốt cho dữ liệu giá.',
    '- `levels` là mức giá sinh từ % rủi ro và vùng hỗ trợ/kháng cự, bạn có thể điều chỉnh và giải thích lý do nếu thấy chưa hợp lý.',
    '- `conflicts` là các xung đột tín hiệu mà hệ thống đã tự phát hiện — bắt buộc phải đề cập nếu không rỗng.',
  ].filter(Boolean).join('\n');
}

async function readError(res) {
  let detail = `HTTP ${res.status}`;
  try {
    const j = await res.json();
    if (j.error?.message) detail = j.error.message;
  } catch { /* body không phải JSON */ }
  if (res.status === 401) return 'API key không hợp lệ hoặc đã bị thu hồi.';
  if (res.status === 429) return 'Bị giới hạn tốc độ (rate limit). Chờ một chút rồi thử lại.';
  if (res.status === 400 && /credit|billing/i.test(detail)) return `Vấn đề thanh toán: ${detail}`;
  return detail;
}

/**
 * Gọi Claude ở chế độ streaming, gọi onDelta(text) mỗi khi có chữ mới.
 * Trả về { text, refusal, usage, model, truncated }.
 */
async function streamMessage({ system, userContent, cfg, onDelta, signal }) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('Chưa nhập API key của Claude. Mở tab "Cài đặt AI" để nhập.');
  }

  const res = await fetch(API_URL, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: cfg.model || 'claude-opus-5',
      max_tokens: cfg.maxTokens || 6000,
      stream: true,
      thinking: { type: 'adaptive' },
      output_config: { effort: cfg.effort || 'high' },
      system,
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  if (!res.ok) throw new Error(await readError(res));
  if (!res.body) throw new Error('Trình duyệt không hỗ trợ đọc stream.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let stopReason = null;
  let stopDetails = null;
  let usage = null;
  let model = cfg.model;
  let thinkingActive = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE: các khối cách nhau bằng dòng trống
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      let ev;
      try { ev = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }

      switch (ev.type) {
        case 'message_start':
          model = ev.message?.model || model;
          usage = ev.message?.usage || usage;
          break;
        case 'content_block_start':
          thinkingActive = ev.content_block?.type === 'thinking';
          break;
        case 'content_block_delta':
          if (ev.delta?.type === 'text_delta' && !thinkingActive) {
            text += ev.delta.text;
            onDelta?.(ev.delta.text, text);
          }
          break;
        case 'content_block_stop':
          thinkingActive = false;
          break;
        case 'message_delta':
          stopReason = ev.delta?.stop_reason ?? stopReason;
          stopDetails = ev.delta?.stop_details ?? stopDetails;
          if (ev.usage) usage = { ...usage, ...ev.usage };
          break;
        case 'error':
          throw new Error(ev.error?.message || 'Lỗi từ API');
        default:
          break;
      }
    }
  }

  if (stopReason === 'refusal') {
    return {
      text: null,
      refusal: stopDetails?.explanation || 'Yêu cầu bị bộ lọc an toàn từ chối.',
      model,
      usage,
    };
  }

  return {
    text: text.trim(),
    model,
    usage: usage && {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheRead: usage.cache_read_input_tokens,
    },
    truncated: stopReason === 'max_tokens',
  };
}

/** Báo cáo phân tích đầy đủ theo system prompt trong config/prompt.md. */
export async function generateReport(snapshot, strategy, { onDelta, signal, question } = {}) {
  const system = await loadPrompt();
  return streamMessage({
    system,
    userContent: buildUserContent(snapshot, question),
    cfg: strategy.llm || {},
    onDelta,
    signal,
  });
}

/** Hỏi đáp tự do trên snapshot đã có. */
export async function askAbout(snapshot, question, strategy, { onDelta, signal } = {}) {
  const cfg = strategy.llm || {};
  return streamMessage({
    system: 'Bạn là chuyên gia phân tích kỹ thuật crypto. Trả lời ngắn gọn bằng tiếng Việt, '
      + 'chỉ dựa trên dữ liệu JSON được cung cấp, không bịa thêm dữ liệu ngoài. '
      + 'Không dùng markdown heading hay bảng.',
    userContent: `Dữ liệu phân tích ${snapshot.symbol} ${snapshot.interval}:\n\`\`\`json\n`
      + `${JSON.stringify(toPromptPayload(snapshot), null, 1)}\n\`\`\`\n\nCâu hỏi: ${question}`,
    cfg: { ...cfg, maxTokens: Math.min(cfg.maxTokens || 6000, 3000) },
    onDelta,
    signal,
  });
}

/** Kiểm tra key có dùng được không (gọi 1 request cực nhỏ). */
export async function testApiKey() {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('Chưa nhập API key.');
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-opus-5',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Trả lời đúng một chữ: OK' }],
    }),
  });
  if (!res.ok) throw new Error(await readError(res));
  const j = await res.json();
  const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return { ok: true, model: j.model, reply: text };
}
