import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createGitHub, GitHubError, GITHUB, toBase64, fromBase64,
  describeRun, describeWorkflowState, eventLabel, scheduleHealth, ago,
} from '../web/bot-api.js';
import { parseBotConfigText } from '../src/data/bot-config.js';

/** fetch giả: ghi lại mọi yêu cầu, trả lời theo `routes` ("METHOD /đường-dẫn" -> {status, body, headers}). */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const path = url.replace(GITHUB.api, '').split('?')[0];
    const key = `${init.method ?? 'GET'} ${path}`;
    calls.push({ key, url, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const route = routes[key];
    if (!route) throw new Error(`chưa giả lập: ${key}`);
    if (route instanceof Error) throw route;
    const { status = 200, body, headers = {} } = route;
    return new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status, headers });
  };
  return { impl, calls };
}

const STATE_FILE = `GET /repos/${GITHUB.stateRepo}/contents/data/bot-config.json`;
const PUT_FILE = `PUT /repos/${GITHUB.stateRepo}/contents/data/bot-config.json`;
const WF = `/repos/${GITHUB.runnerRepo}/actions/workflows/${GITHUB.workflow}`;

test('base64: tiếng Việt và ký tự đặc biệt đi qua lại không đổi, kể cả khi GitHub xuống dòng giữa chuỗi', () => {
  const text = '{"ghiChu": "Đồng đô-la ₫ — thử 🚀"}\n';
  assert.equal(fromBase64(toBase64(text)), text);
  const b64 = toBase64(text);
  assert.equal(fromBase64(`${b64.slice(0, 10)}\n${b64.slice(10)}\n`), text);
});

test('mọi yêu cầu có header đúng và token chỉ gửi khi có', async () => {
  const { impl, calls } = fakeFetch({ 'GET /user': { body: { login: 'ElonHoang' } } });
  await createGitHub({ token: 'github_pat_x', fetchImpl: impl }).whoami();
  assert.equal(calls[0].headers.Authorization, 'Bearer github_pat_x');
  assert.equal(calls[0].headers.Accept, 'application/vnd.github+json');
  assert.equal(calls[0].headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.equal(calls[0].headers['Content-Type'], undefined, 'GET không có Content-Type');

  const anon = fakeFetch({ [`GET ${WF}`]: { body: { state: 'active', name: 'Scan', html_url: 'u' } } });
  await createGitHub({ fetchImpl: anon.impl }).workflowInfo();
  assert.equal(anon.calls[0].headers.Authorization, undefined);
});

test('readConfig: có file -> đọc và kiểm tra nội dung; file hỏng -> báo lỗi chứ không ném', async () => {
  const content = toBase64('{"version":1,"tradeSymbols":["btcusdt"],"minAbsScore":40}');
  const { impl } = fakeFetch({ [STATE_FILE]: { body: { sha: 'abc123', content } } });
  const got = await createGitHub({ token: 't', fetchImpl: impl }).readConfig();
  assert.equal(got.found, true);
  assert.equal(got.sha, 'abc123');
  assert.deepEqual(got.config, { tradeSymbols: ['BTCUSDT'], minAbsScore: 40 });

  const broken = fakeFetch({ [STATE_FILE]: { body: { sha: 's', content: toBase64('{ hỏng') } } });
  const r = await createGitHub({ token: 't', fetchImpl: broken.impl }).readConfig();
  assert.equal(r.found, true);
  assert.deepEqual(r.config, {});
  assert.equal(r.errors.length, 1);
});

test('readConfig: 404 mà repo vẫn truy cập được = chưa có file; 404 cả repo = token chưa được cấp quyền', async () => {
  const missing = fakeFetch({
    [STATE_FILE]: { status: 404, body: { message: 'Not Found' } },
    [`GET /repos/${GITHUB.stateRepo}`]: { body: { full_name: GITHUB.stateRepo } },
  });
  assert.deepEqual(await createGitHub({ token: 't', fetchImpl: missing.impl }).readConfig(), {
    found: false, sha: null, config: {}, errors: [],
  });

  const noAccess = fakeFetch({
    [STATE_FILE]: { status: 404, body: {} },
    [`GET /repos/${GITHUB.stateRepo}`]: { status: 404, body: {} },
  });
  await assert.rejects(createGitHub({ token: 't', fetchImpl: noAccess.impl }).readConfig(), (e) => {
    assert.ok(e instanceof GitHubError);
    assert.equal(e.kind, 'notfound');
    assert.match(e.message, /token đã được cấp/);
    return true;
  });
});

test('saveConfig: ghi đúng nội dung đã chuẩn hoá, kèm sha khi ghi đè, và trả sha mới', async () => {
  const { impl, calls } = fakeFetch({
    [PUT_FILE]: { status: 200, body: { content: { sha: 'new-sha' }, commit: { committer: { date: '2026-11-10T08:00:00Z' } } } },
  });
  const gh = createGitHub({ token: 't', fetchImpl: impl });
  const saved = await gh.saveConfig({ tradeSymbols: ['ethusdt', 'BAD'], minAbsScore: 42, rogue: 1 }, 'old-sha');
  assert.deepEqual(saved, { sha: 'new-sha', savedAt: '2026-11-10T08:00:00Z' });

  const sent = calls[0].body;
  assert.equal(sent.sha, 'old-sha');
  assert.equal(sent.branch, GITHUB.stateBranch);
  assert.match(sent.message, /bot config/);
  // phần ghi đi đã bị lọc: mã sai và khoá lạ không lọt vào repo
  assert.deepEqual(parseBotConfigText(fromBase64(sent.content)), { config: { minAbsScore: 42 }, errors: [] });
  assert.ok(!fromBase64(sent.content).includes('rogue'));

  await gh.saveConfig({ minAbsScore: 40 }, null);
  assert.equal('sha' in calls[1].body, false, 'tạo mới thì không gửi sha');
});

test('deleteConfig gửi sha và nhánh đúng', async () => {
  const { impl, calls } = fakeFetch({ [`DELETE /repos/${GITHUB.stateRepo}/contents/data/bot-config.json`]: { status: 200, body: {} } });
  await createGitHub({ token: 't', fetchImpl: impl }).deleteConfig('sha9');
  assert.deepEqual(calls[0].body, { message: 'chore: reset bot config from web', sha: 'sha9', branch: GITHUB.stateBranch });
});

test('quét ngay và bật/tắt đi đúng địa chỉ của workflow', async () => {
  const { impl, calls } = fakeFetch({
    [`POST ${WF}/dispatches`]: { status: 204 },
    [`PUT ${WF}/disable`]: { status: 204 },
    [`PUT ${WF}/enable`]: { status: 204 },
  });
  const gh = createGitHub({ token: 't', fetchImpl: impl });
  await gh.dispatch();
  await gh.setEnabled(false);
  await gh.setEnabled(true);
  assert.deepEqual(calls.map((c) => c.key), [`POST ${WF}/dispatches`, `PUT ${WF}/disable`, `PUT ${WF}/enable`]);
  assert.deepEqual(calls[0].body, { ref: 'main' });
  assert.equal(calls[1].body, undefined);
});

test('recentRuns rút gọn dữ liệu cần dùng', async () => {
  const { impl } = fakeFetch({
    [`GET ${WF}/runs`]: { body: { workflow_runs: [
      { id: 7, event: 'schedule', status: 'completed', conclusion: 'success', created_at: '2026-11-10T03:00:00Z', html_url: 'https://x/7', extra: 'bỏ' },
    ] } },
  });
  assert.deepEqual(await createGitHub({ fetchImpl: impl }).recentRuns(5), [
    { id: 7, event: 'schedule', status: 'completed', conclusion: 'success', createdAt: '2026-11-10T03:00:00Z', url: 'https://x/7' },
  ]);
});

test('lỗi từ GitHub được dịch ra câu tiếng Việt có thể hành động', async () => {
  const kindOf = async (route) => {
    const { impl } = fakeFetch({ 'GET /user': route });
    try { await createGitHub({ token: 't', fetchImpl: impl }).whoami(); } catch (e) { return e; }
    return null;
  };
  const a = await kindOf({ status: 401, body: { message: 'Bad credentials' } });
  assert.equal(a.kind, 'auth');
  assert.match(a.message, /hết hạn/);

  const p = await kindOf({ status: 403, body: { message: 'Resource not accessible by personal access token' } });
  assert.equal(p.kind, 'permission');
  assert.match(p.message, /Contents và Actions/);

  const r = await kindOf({ status: 403, body: { message: 'rate limit' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' } });
  assert.equal(r.kind, 'rate');
  assert.match(r.message, /hết lượt gọi/);

  const c = await kindOf({ status: 422, body: { message: 'sha wasn\'t supplied' } });
  assert.equal(c.kind, 'conflict');
  assert.match(c.message, /Tải lại/);

  const n = await kindOf(new Error('mất mạng'));
  assert.equal(n.kind, 'network');

  const other = await kindOf({ status: 500, body: { message: 'oops' } });
  assert.equal(other.kind, 'error');
  assert.match(other.message, /500/);
});

test('diễn giải trạng thái workflow và kết quả chạy', () => {
  assert.deepEqual(describeWorkflowState('active'), { label: 'Đang bật', tone: 'up', on: true });
  assert.equal(describeWorkflowState('disabled_inactivity').on, false);
  assert.equal(describeWorkflowState('disabled_manually').tone, 'down');
  assert.equal(describeWorkflowState('lạ').on, false);

  assert.deepEqual(describeRun({ status: 'completed', conclusion: 'success' }), { label: 'Thành công', tone: 'up' });
  assert.deepEqual(describeRun({ status: 'completed', conclusion: 'failure' }), { label: 'Lỗi', tone: 'down' });
  assert.equal(describeRun({ status: 'in_progress', conclusion: null }).label, 'Đang chạy');
  assert.equal(describeRun({ status: 'queued', conclusion: null }).label, 'Đang chờ');
  assert.equal(eventLabel('schedule'), 'Theo lịch');
  assert.equal(eventLabel('workflow_dispatch'), 'Chạy tay');
});

test('scheduleHealth cho biết lịch có đang chạy thưa bất thường không', () => {
  const now = Date.parse('2026-11-10T08:00:00Z');
  const run = (event, at) => ({ event, createdAt: at });
  const fresh = scheduleHealth([run('workflow_dispatch', '2026-11-10T07:50:00Z'), run('schedule', '2026-11-10T06:00:00Z')], now);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.sinceMs, 2 * 3_600_000);

  const old = scheduleHealth([run('schedule', '2026-11-10T02:00:00Z')], now);
  assert.equal(old.stale, true);
  assert.deepEqual(scheduleHealth([run('workflow_dispatch', '2026-11-10T07:59:00Z')], now), { lastAt: null, sinceMs: null, stale: true });
});

test('ago: cách nói thời gian trôi qua', () => {
  assert.equal(ago(20_000), 'vừa xong');
  assert.equal(ago(5 * 60_000), '5 phút trước');
  assert.equal(ago(3 * 3_600_000), '3 giờ trước');
  assert.equal(ago(72 * 3_600_000), '3 ngày trước');
});
