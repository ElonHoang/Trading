// Trang "Bot Telegram": xem trạng thái workflow quét, quét ngay, bật/tắt, và chỉnh cài đặt
// cảnh báo (danh sách mã, điểm tối thiểu, độ trôi giá). Mọi thứ đi qua GitHub API bằng token
// của người dùng (xem web/bot-api.js); không có máy chủ riêng nào ở giữa.
//
// Mọi chuỗi động đi qua esc() trước khi chèn vào HTML.

import { initTheme, esc } from './ui.js';
import {
  createGitHub, getToken, setToken, GITHUB,
  describeWorkflowState, describeRun, eventLabel, scheduleHealth, ago,
} from './bot-api.js';
import { normalizeBotConfig, BOT_CONFIG_LIMITS } from '../src/data/bot-config.js';
import { fetchFuturesSymbols } from '../src/data/binance.js';

const $ = (id) => document.getElementById(id);
const defaultsUrl = new URL('../config/strategy.json', import.meta.url).href;
const repoName = (full) => full.split('/')[1];

const S = {
  token: getToken(),
  gh: null,
  login: null,
  defaults: null,   // { tradeSymbols, minAbsScore, maxEntryDriftPercent } lấy từ config/strategy.json
  saved: null,      // { found, sha, config, errors, savedAt } — cài đặt đang nằm trong Trading-state
  form: null,       // { symbols: [], score: '35', drift: '1', noDrift: false, symbolDraft: '' }
  workflow: null,
  runs: null,
  loading: { status: true, settings: false },
  notes: { connect: null, status: null, settings: null },   // { kind: 'ok' | 'error', text }
  busy: new Set(),
  futures: undefined,   // Set các cặp có futures; null = không tải được; undefined = chưa thử
};

const note = (area, kind, text) => { S.notes[area] = text ? { kind, text } : null; };
const noteHTML = (area) => (S.notes[area]
  ? `<div class="banner ${S.notes[area].kind === 'error' ? 'error' : ''}" role="status" style="margin-top:14px">${esc(S.notes[area].text)}</div>`
  : '');

/* ---------- gọi GitHub có bắt lỗi ---------- */

async function act(name, area, fn) {
  if (S.busy.has(name)) return;
  S.busy.add(name);
  note(area, '', '');
  render();
  try {
    await fn();
  } catch (error) {
    note(area, 'error', error.message || String(error));
  } finally {
    S.busy.delete(name);
    render();
  }
}

const busy = (...names) => names.some((n) => S.busy.has(n));

/* ---------- cài đặt: mô hình biểu mẫu ---------- */

function effective(config) {
  const d = S.defaults;
  return {
    tradeSymbols: config.tradeSymbols ?? d.tradeSymbols,
    minAbsScore: config.minAbsScore ?? d.minAbsScore,
    maxEntryDriftPercent: 'maxEntryDriftPercent' in config ? config.maxEntryDriftPercent : d.maxEntryDriftPercent,
  };
}

function formFrom(values) {
  return {
    symbols: [...values.tradeSymbols],
    score: String(values.minAbsScore),
    drift: values.maxEntryDriftPercent === null ? String(S.defaults.maxEntryDriftPercent ?? 1) : String(values.maxEntryDriftPercent),
    noDrift: values.maxEntryDriftPercent === null,
    symbolDraft: '',
  };
}

const numberOf = (text) => (String(text).trim() === '' ? Number.NaN : Number(text));

function formValues() {
  const f = S.form;
  return {
    tradeSymbols: f.symbols,
    minAbsScore: numberOf(f.score),
    maxEntryDriftPercent: f.noDrift ? null : numberOf(f.drift),
  };
}

function formErrors() {
  const v = formValues();
  return {
    symbols: normalizeBotConfig({ tradeSymbols: v.tradeSymbols }).errors,
    score: normalizeBotConfig({ minAbsScore: v.minAbsScore }).errors,
    drift: normalizeBotConfig({ maxEntryDriftPercent: v.maxEntryDriftPercent }).errors,
  };
}

function sameValues(a, b) {
  return a.minAbsScore === b.minAbsScore
    && a.maxEntryDriftPercent === b.maxEntryDriftPercent
    && a.tradeSymbols.length === b.tradeSymbols.length
    && a.tradeSymbols.every((s, i) => s === b.tradeSymbols[i]);
}

const isDirty = () => Boolean(S.form && S.saved && S.defaults && !sameValues(formValues(), effective(S.saved.config)));
const hasErrors = () => Object.values(formErrors()).some((list) => list.length);

async function futuresSet() {
  if (S.futures === undefined) {
    S.futures = await fetchFuturesSymbols().catch(() => null);
  }
  return S.futures;
}

function symbolFrom(raw) {
  const cleaned = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!cleaned) return '';
  return cleaned.endsWith('USDT') ? cleaned : `${cleaned}USDT`;
}

async function addSymbol() {
  const f = S.form;
  const symbol = symbolFrom(f.symbolDraft);
  if (!symbol) return;
  const problem = normalizeBotConfig({ tradeSymbols: [symbol] }).errors[0];
  if (problem) { note('settings', 'error', problem); return render(); }
  if (f.symbols.includes(symbol)) { note('settings', 'error', `${symbol} đã có trong danh sách.`); return render(); }
  if (f.symbols.length >= BOT_CONFIG_LIMITS.maxSymbols) {
    note('settings', 'error', `Tối đa ${BOT_CONFIG_LIMITS.maxSymbols} mã.`);
    return render();
  }
  const futures = await futuresSet();
  if (futures && !futures.has(symbol)) {
    note('settings', 'error', `${symbol} không có hợp đồng futures trên Binance, bot sẽ bỏ qua mã này nên không thêm.`);
    return render();
  }
  f.symbols.push(symbol);
  f.symbolDraft = '';
  note('settings', '', '');
  render();
  $('sym-input')?.focus();
}

/* ---------- tải dữ liệu ---------- */

async function loadDefaults() {
  try {
    const strategy = await (await fetch(defaultsUrl)).json();
    const a = strategy.alerts ?? {};
    S.defaults = {
      tradeSymbols: a.tradeSymbols ?? [],
      minAbsScore: a.minAbsScore ?? 35,
      maxEntryDriftPercent: a.maxEntryDriftPercent ?? null,
    };
  } catch {
    S.defaults = null;
    note('settings', 'error', 'Không tải được cấu hình mặc định (config/strategy.json).');
  }
}

async function loadStatus() {
  S.loading.status = true;
  try {
    const [workflow, runs] = await Promise.all([S.gh.workflowInfo(), S.gh.recentRuns(20)]);
    S.workflow = workflow;
    S.runs = runs;
    note('status', '', '');
  } catch (error) {
    note('status', 'error', error.message);
  } finally {
    S.loading.status = false;
  }
}

async function loadAccountAndConfig() {
  if (!S.token) { S.login = null; S.saved = null; S.form = null; return; }
  S.loading.settings = true;
  try {
    S.login = (await S.gh.whoami()).login;
    note('connect', '', '');
  } catch (error) {
    S.login = null;
    note('connect', 'error', error.message);
    S.loading.settings = false;
    return;
  }
  try {
    const saved = await S.gh.readConfig();
    S.saved = { ...saved, savedAt: null };
    if (S.defaults) S.form = formFrom(effective(saved.config));
    if (saved.errors.length) note('settings', 'error', `Cài đặt đang lưu có phần không hợp lệ nên bot bỏ qua: ${saved.errors.join(' ')}`);
  } catch (error) {
    S.saved = null;
    S.form = null;
    note('settings', 'error', error.message);
  } finally {
    S.loading.settings = false;
  }
}

async function loadAll() {
  S.gh = createGitHub({ token: S.token });
  render();
  await Promise.all([loadDefaults(), loadStatus()]);
  render();
  await loadAccountAndConfig();
  render();
}

/* ---------- hành động ---------- */

async function connect(tokenText) {
  const token = tokenText.trim();
  if (!token) { note('connect', 'error', 'Dán token vào ô trên rồi bấm Lưu.'); return render(); }
  await act('connect', 'connect', async () => {
    const probe = createGitHub({ token });
    const { login } = await probe.whoami();            // ném lỗi nếu token sai
    if (!setToken(token)) throw new Error('Trình duyệt không cho lưu token (đang ở chế độ riêng tư?).');
    S.token = token;
    S.login = login;
    note('connect', 'ok', `Đã kết nối với tài khoản ${login}.`);
    await loadAll();
  });
}

function disconnect() {
  setToken('');
  S.token = '';
  S.login = null;
  S.saved = null;
  S.form = null;
  S.gh = createGitHub({ token: '' });
  note('connect', 'ok', 'Đã xoá token khỏi trình duyệt này.');
  note('settings', '', '');
  render();
}

/** "10/11 14:22": ngày/tháng rồi giờ, theo giờ máy người xem (tự ghép vì định dạng vi-VN của trình duyệt dùng dấu gạch ngang). */
const dayTime = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const clock = (iso) => new Date(iso).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });

async function runNow() {
  await act('run', 'status', async () => {
    await S.gh.dispatch();
    note('status', 'ok', 'Đã gửi yêu cầu quét. GitHub sẽ bắt đầu chạy trong vài giây; bấm “Tải lại” để xem kết quả.');
    setTimeout(async () => { await loadStatus(); render(); }, 8000);
  });
}

async function toggleBot() {
  const turnOn = !describeWorkflowState(S.workflow?.state).on;
  if (!turnOn && !confirm('Tắt bot? Bot sẽ ngừng quét và ngừng báo vào Telegram cho tới khi bạn bật lại.')) return;
  await act('toggle', 'status', async () => {
    await S.gh.setEnabled(turnOn);
    await loadStatus();
    note('status', 'ok', turnOn ? 'Đã bật lại bot.' : 'Đã tắt bot.');
  });
}

async function saveSettings() {
  if (hasErrors() || !isDirty()) return;
  const { config } = normalizeBotConfig(formValues());
  await act('save', 'settings', async () => {
    try {
      const result = await S.gh.saveConfig(config, S.saved.sha);
      S.saved = { found: true, sha: result.sha, config, errors: [], savedAt: result.savedAt };
      S.form = formFrom(effective(config));
      note('settings', 'ok', `Đã lưu${result.savedAt ? ` lúc ${clock(result.savedAt)}` : ''}. Bot dùng cài đặt này từ lượt quét kế tiếp; bấm “Quét ngay” ở trên nếu muốn áp dụng liền.`);
    } catch (error) {
      if (error.kind === 'conflict') {
        // Lấy bản mới nhất (đúng sha cho lần lưu sau) nhưng giữ nguyên những gì người dùng đang sửa.
        const mine = S.form;
        await loadAccountAndConfig();
        if (mine) S.form = mine;
      }
      throw error;
    }
  });
}

async function resetSettings() {
  if (!S.saved?.found) return;
  if (!confirm('Về mặc định? Cài đặt đã lưu sẽ bị xoá và bot dùng lại cấu hình trong repo.')) return;
  await act('reset', 'settings', async () => {
    await S.gh.deleteConfig(S.saved.sha);
    S.saved = { found: false, sha: null, config: {}, errors: [], savedAt: null };
    S.form = formFrom(effective({}));
    note('settings', 'ok', 'Đã xoá cài đặt tuỳ chỉnh. Bot dùng lại cấu hình mặc định từ lượt quét kế tiếp.');
  });
}

/* ---------- dựng giao diện ---------- */

const spinner = '<span class="spin" aria-hidden="true"></span> ';

function renderConnect() {
  const el = $('card-connect');
  const guide = `
    <details class="fold" ${S.token ? '' : 'open'} style="margin-top:6px">
      <summary><span>Cách tạo token <small>(khoảng 1 phút)</small></span></summary>
      <div class="fold-body">
        <ol class="steps">
          <li>Mở <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHub → Settings → Fine-grained tokens → Generate new token</a>, đặt tên tuỳ ý và chọn hạn dùng (ví dụ 90 ngày).</li>
          <li>Ở <b>Repository access</b> chọn <b>Only select repositories</b>, rồi chọn <b>${esc(repoName(GITHUB.stateRepo))}</b> và <b>${esc(repoName(GITHUB.runnerRepo))}</b>.</li>
          <li>Ở <b>Repository permissions</b> đặt <b>Contents: Read and write</b> và <b>Actions: Read and write</b>. <b>Không</b> cấp quyền Workflows.</li>
          <li>Bấm <b>Generate token</b>, sao chép chuỗi bắt đầu bằng <code>github_pat_</code> và dán vào ô trên.</li>
        </ol>
        <p class="hint">Token chỉ lưu trong trình duyệt này và chỉ được gửi tới <code>api.github.com</code>. Ai dùng được trình duyệt này thì dùng được token, nên chỉ cấp đúng hai repo trên và đặt hạn dùng.</p>
      </div>
    </details>`;

  if (S.token) {
    el.innerHTML = `
      <h2>Kết nối GitHub</h2>
      <p class="sub">${S.login
        ? `Đã kết nối với tài khoản <b>${esc(S.login)}</b>. Token lưu trong trình duyệt này.`
        : 'Đã có token trong trình duyệt này nhưng chưa kiểm tra được.'}</p>
      <div class="btn-row" style="margin-top:0">
        <button type="button" id="btn-recheck" ${busy('connect') ? 'disabled' : ''}>Kiểm tra lại</button>
        <button type="button" id="btn-disconnect">Xoá token</button>
      </div>
      ${noteHTML('connect')}
      ${guide}`;
    return;
  }
  el.innerHTML = `
    <h2>Kết nối GitHub</h2>
    <p class="sub">Cần một token để lưu cài đặt và điều khiển bot. Xem trạng thái bot thì không cần.</p>
    <div class="inline-row">
      <input type="password" id="token-input" placeholder="github_pat_…" autocomplete="off" spellcheck="false" aria-label="Token GitHub">
      <button type="button" class="primary" id="btn-connect" ${busy('connect') ? 'disabled' : ''}>${busy('connect') ? `${spinner}Đang kiểm tra…` : 'Lưu token'}</button>
    </div>
    ${noteHTML('connect')}
    ${guide}`;
}

function runRow(run) {
  const result = describeRun(run);
  const at = Date.parse(run.createdAt);
  return `
    <li>
      <span class="run-time"><b>${esc(dayTime(at))}</b>
        <span class="muted">· ${esc(ago(Date.now() - at))}</span></span>
      <span class="run-kind muted">${esc(eventLabel(run.event))}</span>
      <span class="pill ${result.tone}">${esc(result.label)}</span>
      <a href="${esc(run.url)}" target="_blank" rel="noopener">Xem</a>
    </li>`;
}

function renderStatus() {
  const el = $('card-status');
  const needToken = S.token ? '' : 'disabled title="Cần token ở phần Kết nối GitHub"';
  if (!S.workflow) {
    el.innerHTML = `
      <h2>Trạng thái bot</h2>
      <p class="sub">Bot chạy trên GitHub Actions (${esc(repoName(GITHUB.runnerRepo))}) và nhắn vào Telegram khi có kèo.</p>
      ${S.loading.status ? `<div class="muted">${spinner}Đang tải…</div>` : ''}
      ${noteHTML('status')}
      <div class="btn-row"><button type="button" id="btn-reload">Tải lại</button></div>`;
    return;
  }
  const st = describeWorkflowState(S.workflow.state);
  const health = scheduleHealth(S.runs ?? []);
  const last = health.lastAt
    ? `Lần chạy theo lịch gần nhất: ${ago(health.sinceMs)}`
    : 'Chưa thấy lần chạy theo lịch nào trong lịch sử gần đây';
  const warn = st.on && health.stale
    ? `<div class="callout" role="note"><b aria-hidden="true">⚠</b><div>GitHub chưa chạy bot theo lịch ${health.lastAt ? `trong ${ago(health.sinceMs).replace(' trước', '')}` : 'gần đây'}.
        Thiết kế là 5 phút một lần, nhưng GitHub hay chạy thưa hơn nhiều. Bấm <b>Quét ngay</b> để quét một lượt.</div></div>`
    : '';
  const off = st.on ? '' : `<div class="callout" role="note"><b aria-hidden="true">⚠</b><div>Bot đang tắt: sẽ không quét và không báo gì vào Telegram cho tới khi bạn bật lại.</div></div>`;

  el.innerHTML = `
    <h2>Trạng thái bot</h2>
    <p class="sub">Bot chạy trên GitHub Actions (${esc(repoName(GITHUB.runnerRepo))}) và nhắn vào Telegram khi có kèo.</p>
    <div class="bot-head">
      <span class="pill state-pill ${st.tone}">${st.on ? '●' : '○'} ${esc(st.label)}</span>
      <span class="muted">${esc(last)}</span>
    </div>
    ${warn}${off}
    <ul class="runs" aria-label="Các lần chạy gần đây">${(S.runs ?? []).slice(0, 5).map(runRow).join('') || '<li class="muted">Chưa có lần chạy nào.</li>'}</ul>
    <div class="btn-row">
      <button type="button" class="primary" id="btn-run" ${needToken || (!st.on || busy('run')) ? 'disabled' : ''} ${!st.on ? 'title="Bật bot trước"' : ''}>${busy('run') ? `${spinner}Đang gửi…` : 'Quét ngay'}</button>
      <button type="button" id="btn-toggle" ${needToken || busy('toggle') ? 'disabled' : ''}>${busy('toggle') ? `${spinner}Đang xử lý…` : st.on ? 'Tắt bot' : 'Bật lại bot'}</button>
      <button type="button" id="btn-reload" ${S.loading.status ? 'disabled' : ''}>${S.loading.status ? `${spinner}Đang tải…` : 'Tải lại'}</button>
    </div>
    ${S.token ? '' : '<p class="hint">Quét ngay và bật/tắt cần token ở phần “Kết nối GitHub”.</p>'}
    ${noteHTML('status')}`;
}

function chip(symbol) {
  return `<span class="wl-item static"><span>${esc(symbol)}</span><button type="button" data-del="${esc(symbol)}" title="Bỏ ${esc(symbol)}" aria-label="Bỏ ${esc(symbol)}">×</button></span>`;
}

function renderSettings() {
  const el = $('card-settings');
  const head = `
    <h2>Cài đặt cảnh báo</h2>
    <p class="sub">Áp dụng từ lượt quét kế tiếp. Chưa chỉnh gì thì bot dùng cấu hình mặc định trong repo.</p>`;

  if (!S.token) {
    el.innerHTML = `${head}<p class="muted" style="margin:0">Kết nối GitHub ở trên để xem và chỉnh cài đặt.</p>${noteHTML('settings')}`;
    return;
  }
  if (!S.defaults || !S.saved || !S.form) {
    el.innerHTML = `${head}${S.loading.settings ? `<div class="muted">${spinner}Đang tải…</div>` : ''}${noteHTML('settings')}`;
    return;
  }

  const f = S.form;
  const d = S.defaults;
  const stateLine = S.saved.found
    ? '<span class="pill">Đang dùng cài đặt từ web</span>'
    : '<span class="pill">Đang dùng mặc định của bot</span>';
  const driftDefault = d.maxEntryDriftPercent === null ? 'không giới hạn' : `${d.maxEntryDriftPercent}%`;

  el.innerHTML = `
    ${head}
    <div style="margin-bottom:6px">${stateLine}</div>

    <div class="field-block">
      <span class="field-label">Mã được quét <span class="muted">(${f.symbols.length}/${BOT_CONFIG_LIMITS.maxSymbols})</span></span>
      <div class="wl" id="symbols" style="flex-wrap:wrap">${f.symbols.map(chip).join('') || '<span class="muted">Chưa có mã nào.</span>'}</div>
      <div class="inline-row" style="margin-top:10px">
        <input type="text" id="sym-input" value="${esc(f.symbolDraft)}" placeholder="VD: SOL hoặc SOLUSDT" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Thêm mã">
        <button type="button" id="sym-add">Thêm</button>
      </div>
      <p class="hint">Chỉ mã có hợp đồng futures trên Binance mới được quét. Mặc định của bot: ${d.tradeSymbols.length} mã.</p>
      <p class="field-error" id="err-symbols"></p>
    </div>

    <div class="field-block">
      <label class="field-label" for="in-score">Điểm tối thiểu để báo (${BOT_CONFIG_LIMITS.minAbsScore.min}–${BOT_CONFIG_LIMITS.minAbsScore.max})</label>
      <input type="number" id="in-score" value="${esc(f.score)}" min="${BOT_CONFIG_LIMITS.minAbsScore.min}" max="${BOT_CONFIG_LIMITS.minAbsScore.max}" step="1" inputmode="numeric">
      <p class="hint">Bot chỉ báo khi |điểm tổng hợp| đạt mức này. Cao hơn là ít tin hơn, thấp hơn là nhiều tin hơn. Mặc định: ${esc(d.minAbsScore)}.</p>
      <p class="field-error" id="err-score"></p>
    </div>

    <div class="field-block">
      <label class="field-label" for="in-drift">Độ trôi giá tối đa khi vào lệnh (%)</label>
      <div class="inline-row">
        <input type="number" id="in-drift" value="${esc(f.drift)}" min="${BOT_CONFIG_LIMITS.maxEntryDriftPercent.min}" max="${BOT_CONFIG_LIMITS.maxEntryDriftPercent.max}" step="0.1" inputmode="decimal" ${f.noDrift ? 'disabled' : ''}>
        <label class="check"><input type="checkbox" id="in-nodrift" ${f.noDrift ? 'checked' : ''}> Không giới hạn</label>
      </div>
      <p class="hint">Bỏ qua kèo nếu giá đã chạy xa hơn mức này so với giá ghi trong tin. Mặc định: ${esc(driftDefault)}.</p>
      <p class="field-error" id="err-drift"></p>
    </div>

    <div class="btn-row">
      <button type="button" class="primary" id="btn-save">${busy('save') ? `${spinner}Đang lưu…` : 'Lưu cài đặt'}</button>
      <button type="button" id="btn-reset" ${S.saved.found && !busy('reset') ? '' : 'disabled'}>${busy('reset') ? `${spinner}Đang xoá…` : 'Về mặc định của bot'}</button>
    </div>
    <p class="hint" id="save-hint"></p>
    ${noteHTML('settings')}`;
  refreshSettingsMeta();
}

/** Cập nhật lỗi từng ô và nút Lưu mà KHÔNG dựng lại cả thẻ (để ô đang gõ giữ được con trỏ). */
function refreshSettingsMeta() {
  if (!S.form || !$('btn-save')) return;
  const errors = formErrors();
  for (const key of ['symbols', 'score', 'drift']) {
    const node = $(`err-${key}`);
    if (node) node.textContent = errors[key].join(' ');
  }
  const dirty = isDirty();
  const invalid = hasErrors();
  $('btn-save').disabled = !dirty || invalid || busy('save', 'reset');
  const hint = $('save-hint');
  if (hint) hint.textContent = invalid ? 'Sửa các ô báo lỗi để lưu được.' : dirty ? 'Có thay đổi chưa lưu.' : '';
}

function render() {
  $('page').classList.toggle('no-token', !S.token);
  renderConnect();
  renderStatus();
  renderSettings();
}

/* ---------- sự kiện (uỷ quyền, nên nội dung dựng lại vẫn hoạt động) ---------- */

document.addEventListener('click', (e) => {
  const id = e.target.closest('button')?.id;
  const del = e.target.closest('[data-del]')?.dataset.del;
  if (del && S.form) {
    S.form.symbols = S.form.symbols.filter((s) => s !== del);
    note('settings', '', '');
    return render();
  }
  switch (id) {
    case 'btn-connect': return connect($('token-input').value);
    case 'btn-recheck': return loadAll();
    case 'btn-disconnect': return disconnect();
    case 'btn-run': return runNow();
    case 'btn-toggle': return toggleBot();
    case 'btn-reload': return act('reload', 'status', async () => { await loadStatus(); });
    case 'sym-add': return addSymbol();
    case 'btn-save': return saveSettings();
    case 'btn-reset': return resetSettings();
    default: return undefined;
  }
});

document.addEventListener('input', (e) => {
  if (!S.form) return;
  if (e.target.id === 'sym-input') S.form.symbolDraft = e.target.value;
  else if (e.target.id === 'in-score') S.form.score = e.target.value;
  else if (e.target.id === 'in-drift') S.form.drift = e.target.value;
  else return;
  refreshSettingsMeta();
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'in-nodrift' && S.form) {
    S.form.noDrift = e.target.checked;
    $('in-drift').disabled = S.form.noDrift;
    refreshSettingsMeta();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'sym-input') { e.preventDefault(); addSymbol(); }
  else if (e.target.id === 'token-input') { e.preventDefault(); connect(e.target.value); }
});

initTheme($('btn-theme'));
loadAll();
