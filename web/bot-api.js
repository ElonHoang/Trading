// Gọi GitHub API từ trình duyệt để:
//  (1) đọc/ghi cài đặt cảnh báo của bot (Trading-state/data/bot-config.json), và
//  (2) xem trạng thái và điều khiển workflow quét của Trading-runner (quét ngay, bật/tắt).
//
// Không thư viện ngoài, không bước build. `fetch` được truyền vào nên bài kiểm tra chạy được
// bằng bản giả; mọi chuỗi lỗi đã là tiếng Việt, sẵn để hiện lên trang.
//
// Token là fine-grained PAT do người dùng tự tạo, chỉ lưu ở localStorage của trình duyệt này
// và chỉ được gửi tới api.github.com.

import { parseBotConfigText, serializeBotConfig, BOT_CONFIG_PATH } from '../src/data/bot-config.js';

export const GITHUB = Object.freeze({
  api: 'https://api.github.com',
  stateRepo: 'ElonHoang/Trading-state',
  stateBranch: 'main',
  runnerRepo: 'ElonHoang/Trading-runner',
  runnerBranch: 'main',
  workflow: 'telegram-scan.yml',
});

/* ---------- token ---------- */

const TOKEN_KEY = 'ta.github.token';

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
    return true;
  } catch {
    return false; // chế độ riêng tư hoặc hết dung lượng
  }
}

/* ---------- base64 (nội dung file của Contents API) ---------- */

export function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function fromBase64(b64) {
  const binary = atob(String(b64).replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/* ---------- lỗi ---------- */

export class GitHubError extends Error {
  constructor(message, { status = 0, kind = 'error' } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.kind = kind;
  }
}

function clock(unixSeconds) {
  return new Date(Number(unixSeconds) * 1000).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
}

function errorFromResponse(res, data, what) {
  const status = res.status;
  const apiMessage = typeof data?.message === 'string' ? data.message : '';
  if (status === 401) {
    return new GitHubError('Token không hợp lệ hoặc đã hết hạn. Tạo token mới rồi dán lại ở bước 1.', { status, kind: 'auth' });
  }
  if (status === 403 || status === 429) {
    if (res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = res.headers.get('x-ratelimit-reset');
      return new GitHubError(`Đã hết lượt gọi GitHub.${reset ? ` Thử lại sau ${clock(reset)}.` : ' Thử lại sau ít phút.'}`, { status, kind: 'rate' });
    }
    return new GitHubError(
      'Token chưa đủ quyền. Cần Contents và Actions (Read and write) cho cả Trading-state và Trading-runner.',
      { status, kind: 'permission' },
    );
  }
  if (status === 404) {
    return new GitHubError(`Không thấy ${what}. Kiểm tra token đã được cấp cho repo này chưa.`, { status, kind: 'notfound' });
  }
  if (status === 409 || status === 422) {
    return new GitHubError(
      `Dữ liệu vừa bị thay đổi ở nơi khác hoặc GitHub từ chối yêu cầu${apiMessage ? ` (${apiMessage})` : ''}. Tải lại rồi thử lại.`,
      { status, kind: 'conflict' },
    );
  }
  return new GitHubError(`GitHub trả lỗi ${status}${apiMessage ? `: ${apiMessage}` : ''}.`, { status, kind: 'error' });
}

/* ---------- máy khách ---------- */

export function createGitHub({ token = '', fetchImpl = (...args) => fetch(...args), repos = GITHUB } = {}) {
  async function call(method, path, { body, what = 'dữ liệu', allow404 = false } = {}) {
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let res;
    try {
      res = await fetchImpl(`${repos.api}${path}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new GitHubError('Không kết nối được tới GitHub. Kiểm tra mạng rồi thử lại.', { kind: 'network' });
    }
    if (res.status === 204) return null;
    if (res.status === 404 && allow404) return undefined;

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* phản hồi không phải JSON */ }
    if (!res.ok) throw errorFromResponse(res, data, what);
    return data;
  }

  const stateFile = `/repos/${repos.stateRepo}/contents/${BOT_CONFIG_PATH}`;
  const workflow = `/repos/${repos.runnerRepo}/actions/workflows/${repos.workflow}`;

  return {
    hasToken: Boolean(token),

    /** Kiểm tra token còn dùng được và cho biết tài khoản. */
    async whoami() {
      const user = await call('GET', '/user', { what: 'tài khoản' });
      return { login: user.login };
    },

    /**
     * Đọc cài đặt đã lưu. GitHub trả 404 cả khi file chưa có lẫn khi token không được cấp
     * cho repo, nên gặp 404 thì hỏi thêm chính repo để phân biệt hai trường hợp.
     */
    async readConfig() {
      const data = await call('GET', `${stateFile}?ref=${repos.stateBranch}`, { allow404: true, what: `file cài đặt trong ${repos.stateRepo}` });
      if (data === undefined) {
        await call('GET', `/repos/${repos.stateRepo}`, { what: `repo ${repos.stateRepo}` });
        return { found: false, sha: null, config: {}, errors: [] };
      }
      return { found: true, sha: data.sha, ...parseBotConfigText(fromBase64(data.content ?? '')) };
    },

    /** Ghi cài đặt (tạo mới nếu `sha` rỗng, ghi đè nếu có). Trả về sha mới. */
    async saveConfig(config, sha) {
      const result = await call('PUT', stateFile, {
        what: `repo ${repos.stateRepo}`,
        body: {
          message: 'chore: update bot config from web',
          content: toBase64(serializeBotConfig(config)),
          branch: repos.stateBranch,
          ...(sha ? { sha } : {}),
        },
      });
      return { sha: result.content.sha, savedAt: result.commit?.committer?.date ?? result.commit?.author?.date ?? null };
    },

    /** Xoá file cài đặt để bot quay về cấu hình trong repo. */
    async deleteConfig(sha) {
      await call('DELETE', stateFile, {
        what: `repo ${repos.stateRepo}`,
        body: { message: 'chore: reset bot config from web', sha, branch: repos.stateBranch },
      });
    },

    /** Trạng thái workflow quét (repo công khai nên đọc được cả khi chưa có token). */
    async workflowInfo() {
      const w = await call('GET', workflow, { what: `workflow trong ${repos.runnerRepo}` });
      return { state: w.state, name: w.name, url: w.html_url };
    },

    async recentRuns(limit = 20) {
      const data = await call('GET', `${workflow}/runs?per_page=${limit}`, { what: `lịch sử chạy của ${repos.runnerRepo}` });
      return (data.workflow_runs ?? []).map((r) => ({
        id: r.id, event: r.event, status: r.status, conclusion: r.conclusion,
        createdAt: r.created_at, url: r.html_url,
      }));
    },

    /** Quét ngay: GitHub bắt đầu một lượt chạy mới trong vài giây. */
    async dispatch() {
      await call('POST', `${workflow}/dispatches`, { what: `workflow trong ${repos.runnerRepo}`, body: { ref: repos.runnerBranch } });
    },

    async setEnabled(enabled) {
      await call('PUT', `${workflow}/${enabled ? 'enable' : 'disable'}`, { what: `workflow trong ${repos.runnerRepo}` });
    },
  };
}

/* ---------- diễn giải dữ liệu để hiện lên trang ---------- */

const WORKFLOW_STATES = {
  active: { label: 'Đang bật', tone: 'up', on: true },
  disabled_manually: { label: 'Đã tắt', tone: 'down', on: false },
  disabled_inactivity: { label: 'Bị GitHub tắt vì lâu không hoạt động', tone: 'down', on: false },
  disabled_fork: { label: 'Đã tắt (bản fork)', tone: 'down', on: false },
};

export function describeWorkflowState(state) {
  return WORKFLOW_STATES[state] ?? { label: String(state ?? 'Không rõ'), tone: '', on: false };
}

export function eventLabel(event) {
  return { schedule: 'Theo lịch', workflow_dispatch: 'Chạy tay', push: 'Do cập nhật mã' }[event] ?? event;
}

export function describeRun(run) {
  if (run.status !== 'completed') {
    return { label: run.status === 'queued' || run.status === 'waiting' ? 'Đang chờ' : 'Đang chạy', tone: '' };
  }
  return {
    success: { label: 'Thành công', tone: 'up' },
    failure: { label: 'Lỗi', tone: 'down' },
    timed_out: { label: 'Quá thời gian', tone: 'down' },
    cancelled: { label: 'Đã huỷ', tone: '' },
    skipped: { label: 'Bỏ qua', tone: '' },
  }[run.conclusion] ?? { label: String(run.conclusion ?? 'Không rõ'), tone: '' };
}

/** "vừa xong", "5 phút trước", "3 giờ trước", "2 ngày trước". */
export function ago(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return 'vừa xong';
  if (minutes < 60) return `${minutes} phút trước`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} giờ trước`;
  return `${Math.round(hours / 24)} ngày trước`;
}

/**
 * GitHub chạy lịch rất thưa trên repo công khai (thiết kế là mỗi 5 phút, thực tế có khi
 * vài tiếng). Cho người dùng biết lần chạy theo lịch gần nhất là khi nào để họ quyết định
 * có bấm "Quét ngay" hay không.
 */
export function scheduleHealth(runs, now = Date.now(), { staleHours = 4 } = {}) {
  const last = runs.find((r) => r.event === 'schedule');
  if (!last) return { lastAt: null, sinceMs: null, stale: true };
  const lastAt = Date.parse(last.createdAt);
  const sinceMs = now - lastAt;
  return { lastAt, sinceMs, stale: sinceMs > staleHours * 3_600_000 };
}
