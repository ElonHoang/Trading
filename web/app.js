// Dashboard chạy hoàn toàn trong browser — không cần server.
//
// Import trực tiếp các module lõi trong src/ (cùng code mà bot Telegram dùng):
// dữ liệu lấy thẳng từ Binance, chỉ báo và model ML tính tại máy người dùng,
// Claude gọi trực tiếp bằng API key của chính họ.

import { analyze } from '../src/analysis/engine.js';
import { normalizeSymbol, resolveSymbol, INTERVAL_MS } from '../src/data/binance.js';
import { assertAllowedTradeSymbol } from '../src/data/trading-universe.js';
import {
  loadStrategy, setStrategyValue, flattenStrategy, resetStrategy, overrideCount, isOverridden,
  loadPrompt, savePrompt, resetPrompt, promptIsCustom,
  getApiKey, setApiKey,
} from './store.js';
import { loadModel, saveModel, deleteModel, listModels } from './model-store.js';
import { generateReport, askAbout, testApiKey } from './claude.js';
import { fmt, compact } from '../src/chart/render.js';
import {
  initTheme, initTerms, cssVar, esc, num, term, verdictHTML, breakdownHTML, ladderHTML,
} from './ui.js';
import { drawPriceChart, drawCvd, drawFlow, priceLegendHTML } from './charts.js';

const $ = (id) => document.getElementById(id);

const state = {
  snapshot: null,
  strategy: null,
  symbol: null,
  interval: '4h',
  configLoaded: false,
  busy: false,
  worker: null,
  jobId: 0,
  abort: null,
  layers: { levels: true, plan: true, walls: false, volume: true },
};

// ---------- Tiện ích ----------

function fmtNum(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return fmt(v);
}

function fmtSigned(v, digits = 2) {
  return num(v, digits, { signed: true });
}

function fmtPct(v, digits = 1) {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${num(v * 100, digits)}%`;
}

function fmtTime(ms, interval) {
  const d = new Date(ms);
  if (/[dwM]$/.test(interval)) {
    return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: '2-digit' });
  }
  const date = d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
  return `${date} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

function setStatus(text, spinning = false) {
  const el = $('status');
  clear(el);
  if (spinning) {
    const sp = document.createElement('span');
    sp.className = 'spin';
    el.appendChild(sp);
  }
  el.appendChild(document.createTextNode(text ? ` ${text}` : ''));
}

function showBanner(message, kind = 'error') {
  const b = $('banner');
  b.className = `banner ${kind}`;
  b.textContent = message;
}
function hideBanner() { $('banner').className = 'banner hidden'; }

function chip(label, { color, kind } = {}) {
  const span = document.createElement('span');
  span.className = `chip${kind ? ` ${kind}` : ''}`;
  if (color) {
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = color;
    span.appendChild(sw);
  }
  span.appendChild(document.createTextNode(label));
  return span;
}

function legendItem(label, color, dashed = false) {
  const item = document.createElement('span');
  item.className = 'legend-item';
  const sw = document.createElement('span');
  sw.className = 'legend-swatch';
  sw.style.background = dashed
    ? `repeating-linear-gradient(90deg, ${color} 0 4px, transparent 4px 7px)`
    : color;
  item.append(sw, document.createTextNode(label));
  return item;
}

function renderCandleTable(snap) {
  const s = snap.series;
  const host = $('candle-table');
  clear(host);
  const table = document.createElement('table');
  const head = document.createElement('thead');
  head.innerHTML = '<tr><th>Thời gian</th><th class="num">Mở</th><th class="num">Cao</th>'
    + '<th class="num">Thấp</th><th class="num">Đóng</th><th class="num">%</th>'
    + '<th class="num">Mua CĐ</th></tr>';
  const body = document.createElement('tbody');
  for (let i = Math.max(0, s.close.length - 10); i < s.close.length; i++) {
    const chg = ((s.close[i] - s.open[i]) / s.open[i]) * 100;
    const tr = document.createElement('tr');
    for (const [text, cls] of [
      [fmtTime(s.time[i], snap.interval), ''],
      [fmtNum(s.open[i]), 'num'], [fmtNum(s.high[i]), 'num'],
      [fmtNum(s.low[i]), 'num'], [fmtNum(s.close[i]), 'num'],
      [`${fmtSigned(chg)}%`, `num ${chg >= 0 ? 'delta-up' : 'delta-down'}`],
      [s.volume[i] && s.cvdDelta[i] != null
        ? `${fmtSigned((s.cvdDelta[i] / s.volume[i]) * 100)}%` : '—',
      `num ${(s.cvdDelta[i] ?? 0) >= 0 ? 'delta-up' : 'delta-down'}`],
    ]) {
      const td = document.createElement('td');
      td.className = cls;
      td.textContent = text;
      tr.appendChild(td);
    }
    body.append(tr);
  }
  table.append(head, body);
  host.appendChild(table);
}

// ---------- Kết luận, mức giá, dòng tiền, model, số liệu ----------

function renderHero(snap) {
  const drift = ((snap.price.live - snap.price.lastClose) / snap.price.lastClose) * 100;
  const note = `Nến đã đóng gần nhất lúc ${fmtTime(Date.parse(snap.lastClosedCandleTime), snap.interval)}`
    + ` tại ${fmt(snap.price.lastClose)}`
    + (Math.abs(drift) >= 0.15 ? ` · giá đã chạy ${num(drift, 2, { signed: true })}% từ lúc đó` : '');
  $('verdict').innerHTML = verdictHTML(snap, {
    thresholds: state.strategy.thresholds,
    price: snap.price.live,
    change24h: snap.price.change24hPercent,
    note,
  });
}

function renderLevels(snap) {
  $('ladder').innerHTML = ladderHTML(snap, snap.price.live);
}

function renderBreakdown(snap) {
  $('breakdown').innerHTML = breakdownHTML(snap);
}

function renderFlowRead(snap) {
  const slope = snap.indicators.cvdSlope;
  const n = snap.indicatorParams?.cvdSlope ?? 20;
  let reading = 'Chưa đủ dữ liệu để kết luận.';
  if (slope != null) {
    reading = slope > 0
      ? `Trong ${n} nến gần nhất, người mua chủ động đang nhiều hơn người bán (${num(slope * 100, 1, { signed: true })}% khối lượng).`
      : slope < 0
        ? `Trong ${n} nến gần nhất, người bán chủ động đang nhiều hơn người mua (${num(slope * 100, 1, { signed: true })}% khối lượng).`
        : `Trong ${n} nến gần nhất, mua và bán chủ động đang cân bằng.`;
  }
  $('cvd-read').innerHTML = `${term('cvd', 'CVD')} đi lên = người mua đang chủ động hơn; đi xuống = người bán chủ động hơn. `
    + `<b>${esc(reading)}</b>`;

  const lg = $('osc-legend');
  clear(lg);
  lg.append(
    legendItem('CVD luỹ tiến', 'var(--accent)'),
    legendItem('Mua chủ động nhiều hơn', 'var(--up)'),
    legendItem('Bán chủ động nhiều hơn', 'var(--down)'),
  );
}

function kvHTML(rows) {
  return `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
}

function renderMl(snap) {
  const host = $('ml-body');
  const ml = snap.ml;
  if (!ml.available) {
    $('ml-sub').textContent = 'Chưa có model cho cặp này';
    host.innerHTML = `<p style="margin:0 0 10px">${esc(ml.reason)}</p>
      <button type="button" id="btn-ml-train">Train ngay trong trình duyệt</button>`;
    $('btn-ml-train').addEventListener('click', () => { switchTab('tab-train'); runTrain(); });
    return;
  }

  const relLabel = { high: 'cao', medium: 'trung bình', low: 'thấp' }[ml.reliability] || ml.reliability;
  const relKind = { high: 'ok', medium: 'warn', low: 'bad' }[ml.reliability] || '';
  const used = snap.combined.mlWeightUsed > 0;
  $('ml-sub').innerHTML = `${term('ml')} dự đoán xác suất giá tăng trong ${esc(ml.horizonCandles)} nến tới`;

  const rows = [
    [term('auc', 'AUC holdout'), esc(ml.testAuc ?? '—')],
    [term('auc', 'AUC walk-forward'), esc(ml.walkForwardAuc ?? '—')],
    ['Ngưỡng tăng mạnh', ml.thresholds ? `&gt; ${esc(ml.thresholds.bullishAbove)}` : '—'],
    ['Ngưỡng giảm mạnh', ml.thresholds ? `&lt; ${esc(ml.thresholds.bearishBelow)}` : '—'],
    ['Vị trí hiện tại so với lịch sử', esc(ml.percentileVsHistory ?? '—')],
  ];
  if (ml.tailAccuracy?.combinedAccuracy != null) {
    rows.push(['Đúng khi tự tin nhất', fmtPct(ml.tailAccuracy.combinedAccuracy)]);
  }
  rows.push(['Cách gán nhãn', esc(ml.labelMode ?? '—')]);
  rows.push(['Train lúc', esc(new Date(ml.trainedAt).toLocaleString('vi-VN'))]);

  const features = ml.topFeatures?.length
    ? `<details class="fold" style="margin-top:10px"><summary><span>Chỉ báo model dùng nhiều nhất</span></summary>
        <ul class="notes">${ml.topFeatures.map((f) => `<li>${esc(f.feature)} — ${num(f.pct, 1)}%</li>`).join('')}</ul></details>`
    : '';

  host.innerHTML = `
    <div style="display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; margin-bottom:8px">
      <span style="font-size:30px; font-weight:800; font-variant-numeric:tabular-nums; letter-spacing:-0.02em">${esc(ml.probUpPercent)}%</span>
      <span class="muted">khả năng tăng</span>
      <span class="chip ${relKind}">độ tin cậy ${esc(relLabel)}</span>
    </div>
    <p style="margin:0 0 10px; color:var(--text-2)">${used
      ? 'Con số này đã được tính vào điểm tổng hợp.'
      : 'Con số này chỉ để tham khảo, <b>chưa được tính vào điểm tổng hợp</b>'
        + (ml.reliability === 'low' ? ' vì model chưa đạt ngưỡng tin cậy.' : '.')}</p>
    <details class="fold"><summary><span>Chi tiết kỹ thuật</span></summary>
      <div class="fold-body">${kvHTML(rows)}</div></details>
    ${features}`;
}

function renderIndicators(snap) {
  const i = snap.indicators;
  const n = snap.indicatorParams?.cvdSlope ?? 20;
  const rows = [
    [term('volume'), `${compact(i.volume)} (${num(i.volumeRatio, 2)}× trung bình)`],
    [term('cvd', 'CVD luỹ tiến'), compact(i.cvd)],
    [term('taker', 'Mua chủ động nến này'),
      i.cvdDeltaShare == null ? '—' : `${num(i.cvdDeltaShare * 100, 1, { signed: true })}% khối lượng`],
    [`CVD ${n} nến`, i.cvdSlope == null ? '—' : `${num(i.cvdSlope * 100, 1, { signed: true })}% khối lượng cùng kỳ`],
  ];
  if (snap.derivatives?.fundingRate != null) {
    rows.push([term('funding'), `${num(snap.derivatives.fundingRatePercent, 4)}%`]);
    if (snap.derivatives.openInterestChangePct != null) {
      rows.push([term('oi', 'Open Interest'), `${num(snap.derivatives.openInterestChangePct, 2, { signed: true })}%`]);
    }
  }
  if (snap.orderBook) {
    rows.push([term('orderbook'), `${num(snap.orderBook.imbalance * 100, 1, { signed: true })}%`]);
    if (snap.orderBook.depthSpanPct != null) {
      rows.push(['Độ trải sổ lệnh', `±${num(snap.orderBook.depthSpanPct, 2)}%`]);
    }
    for (const w of snap.orderBook.walls ?? []) {
      rows.push([term('wall', `Tường ${w.side === 'bid' ? 'mua' : 'bán'}`),
        `${fmt(w.price)} (${num(w.distancePct, 2, { signed: true })}%, ${num(w.ratioToAvg, 1)}× TB)`]);
    }
  }
  if (snap.historicalPattern?.available) {
    const hp = snap.historicalPattern;
    rows.push([term('pattern'), `${esc(hp.matched)} mẫu, giống TB ${esc(hp.avgSimilarity)}%`]);
    rows.push(['Sai số chart tương đối',
      `TB ${esc(hp.avgRelativePathError)}% · P95 ${esc(hp.avgP95RelativePathError)}% · ${esc(hp.avgBarsWithinRelativeTolerancePercent)}% nến trong tolerance`]);
    rows.push(['Diễn biến sau mẫu',
      `${hp.side === 'long' ? 'Tăng' : 'Giảm'} TB ${num(hp.avgForwardReturnPct, 2, { signed: true })}% sau ${esc(hp.futureBars)} nến`]);
  }
  $('indicators-body').innerHTML = kvHTML(rows);
}

// ---------- Biểu đồ: lớp hiển thị, vẽ lại khi đổi cỡ / đổi giao diện ----------

const LAYERS_KEY = 'ta.layers';

function initLayers() {
  try {
    Object.assign(state.layers, JSON.parse(localStorage.getItem(LAYERS_KEY) || '{}'));
  } catch { /* chế độ riêng tư hoặc dữ liệu hỏng: dùng mặc định */ }
  for (const btn of document.querySelectorAll('#layers [data-layer]')) {
    const key = btn.dataset.layer;
    btn.setAttribute('aria-pressed', String(Boolean(state.layers[key])));
    btn.addEventListener('click', () => {
      state.layers[key] = !state.layers[key];
      btn.setAttribute('aria-pressed', String(state.layers[key]));
      try { localStorage.setItem(LAYERS_KEY, JSON.stringify(state.layers)); } catch { /* bỏ qua */ }
      if (state.snapshot) drawPriceArea(state.snapshot);
    });
  }
}

function drawPriceArea(snap) {
  const hasPlan = snap.levels && snap.levels.side !== 'none' && snap.levels.entry != null;
  drawPriceChart($('price-chart'), $('price-tip'), snap, state.layers);
  $('price-legend').innerHTML = priceLegendHTML(state.layers, hasPlan);
  $('price-chart-sub').textContent = `${snap.series.close.length} nến khung ${snap.interval} gần nhất · `
    + 'rê chuột hoặc chạm vào biểu đồ để xem từng nến';
}

function drawCharts(snap) {
  drawPriceArea(snap);
  drawCvd($('cvd-chart'), $('cvd-tip'), snap);
  drawFlow($('flow-chart'), $('flow-tip'), snap);
}

/** Biểu đồ phải vẽ lại theo bề rộng mới (xoay điện thoại, kéo cửa sổ). */
function watchChartWidth() {
  const widths = new Map();
  let queued = false;
  const ro = new ResizeObserver((entries) => {
    let changed = false;
    for (const e of entries) {
      const w = Math.round(e.contentRect.width);
      if (widths.has(e.target) && Math.abs(widths.get(e.target) - w) > 2) changed = true;
      widths.set(e.target, w);
    }
    if (!changed || queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; if (state.snapshot) drawCharts(state.snapshot); });
  });
  for (const id of ['price-wrap', 'cvd-wrap', 'flow-wrap']) ro.observe($(id));
}

// ---------- Điều phối ----------

function renderAll(snap) {
  state.snapshot = snap;
  $('analysis').classList.remove('hidden');   // phải hiện trước khi vẽ để đo được bề rộng biểu đồ
  renderHero(snap);
  drawCharts(snap);
  renderCandleTable(snap);
  renderBreakdown(snap);
  renderFlowRead(snap);
  renderLevels(snap);
  renderMl(snap);
  renderIndicators(snap);
  updateTargetLabel();
}

/**
 * Token đang chọn = ô nhập, luôn luôn. Không có fallback về BTC: nếu để trống
 * thì báo lỗi chứ không âm thầm phân tích một token khác.
 */
async function selectedSymbol() {
  const raw = $('symbol').value.trim();
  if (!raw) throw new Error('Nhập mã token trước đã (ví dụ BTC, ETH, SOL).');
  // Đối chiếu danh sách cặp thật của Binance thay vì đoán, để "wbtc" ra WBTCUSDT
  // còn "ethbtc" ra ETHBTC.
  const symbol = await resolveSymbol(raw);
  const strategy = state.strategy ?? await loadStrategy();
  assertAllowedTradeSymbol(symbol, strategy);
  return symbol;
}

/** Cho người dùng thấy train/backtest sẽ chạy trên token nào. */
function updateTargetLabel() {
  const el = $('train-target');
  if (!el) return;
  const raw = $('symbol').value.trim();
  if (!raw) {
    el.textContent = 'Chưa chọn token';
    return;
  }
  try {
    el.textContent = `Sẽ train: ${normalizeSymbol(raw)} ${$('interval').value}`;
  } catch {
    // Đang gõ dở, chưa thành mã hợp lệ.
    el.textContent = 'Chưa chọn token';
  }
}

async function runAnalyze() {
  if (state.busy) return;
  state.busy = true;
  hideBanner();
  const interval = $('interval').value;
  $('btn-analyze').disabled = true;
  setStatus('đang lấy dữ liệu Binance…', true);
  try {
    const symbol = await selectedSymbol();
    state.symbol = symbol;
    state.interval = interval;
    state.strategy = await loadStrategy();
    const snap = await analyze(symbol, interval, state.strategy, {
      includeSeries: true,
      seriesBars: 180,
      storedModel: await loadModel(symbol, interval),
    });
    renderAll(snap);
    setStatus(`cập nhật ${new Date().toLocaleTimeString('vi-VN')}`);
    const q = new URLSearchParams({ symbol, interval });
    history.replaceState(null, '', `?${q}`);
  } catch (err) {
    showBanner(err.message);
    setStatus('lỗi');
    if (!state.snapshot) {
      $('verdict').innerHTML = '<section class="card verdict" data-tone="flat"><div class="muted">'
        + 'Chưa có dữ liệu để hiển thị. Kiểm tra mã token rồi bấm “Phân tích”.</div></section>';
    }
  } finally {
    state.busy = false;
    $('btn-analyze').disabled = false;
  }
}

// ---------- Claude ----------

async function runAiReport() {
  if (!getApiKey()) {
    switchTab('tab-settings');
    showBanner('Chưa có API key của Claude. Nhập key ở tab "Cài đặt AI" — key chỉ lưu trong '
      + 'trình duyệt của bạn và chỉ gửi tới api.anthropic.com.', 'warn');
    return;
  }
  if (!state.snapshot) await runAnalyze();
  if (!state.snapshot) return;

  switchTab('tab-ai');
  const out = $('ai-report');
  out.textContent = '';
  const live = document.createElement('div');
  const waiting = document.createElement('div');
  waiting.className = 'small muted';
  waiting.innerHTML = '<span class="spin"></span> Claude đang đọc số liệu và suy luận…';
  out.append(waiting, live);

  $('btn-ai').disabled = true;
  setStatus('AI đang suy luận…', true);
  state.abort = new AbortController();
  try {
    const r = await generateReport(state.snapshot, state.strategy, {
      signal: state.abort.signal,
      onDelta: (_chunk, full) => {
        waiting.remove();
        live.textContent = full;
      },
    });
    waiting.remove();
    if (r.refusal) {
      live.textContent = `Claude từ chối trả lời: ${r.refusal}`;
    } else {
      live.textContent = r.text;
      const foot = document.createElement('div');
      foot.className = 'small muted';
      foot.style.marginTop = '12px';
      foot.textContent = `${r.model}`
        + (r.usage ? ` · ${r.usage.inputTokens} token vào / ${r.usage.outputTokens} token ra` : '')
        + (r.truncated ? ' · BỊ CẮT vì đạt giới hạn token (tăng llm.maxTokens ở tab Cấu hình)' : '');
      out.appendChild(foot);
    }
    setStatus('xong');
  } catch (err) {
    waiting.remove();
    live.textContent = err.name === 'AbortError' ? 'Đã huỷ.' : `Lỗi: ${err.message}`;
    setStatus('lỗi');
  } finally {
    $('btn-ai').disabled = false;
    state.abort = null;
  }
}

async function runAsk() {
  const q = $('ask-input').value.trim();
  if (!q) return;
  if (!state.snapshot) { showBanner('Hãy phân tích một token trước.', 'warn'); return; }
  if (!getApiKey()) { switchTab('tab-settings'); showBanner('Chưa có API key của Claude.', 'warn'); return; }

  const out = $('ai-report');
  out.textContent = '';
  const live = document.createElement('div');
  const waiting = document.createElement('div');
  waiting.className = 'small muted';
  waiting.innerHTML = '<span class="spin"></span> Đang suy nghĩ…';
  out.append(waiting, live);
  $('btn-ask').disabled = true;
  try {
    const r = await askAbout(state.snapshot, q, state.strategy, {
      onDelta: (_c, full) => { waiting.remove(); live.textContent = full; },
    });
    waiting.remove();
    live.textContent = r.refusal ? `Claude từ chối: ${r.refusal}` : r.text;
  } catch (err) {
    waiting.remove();
    live.textContent = `Lỗi: ${err.message}`;
  } finally {
    $('btn-ask').disabled = false;
  }
}

// ---------- Worker: train & backtest ----------

function getWorker() {
  if (!state.worker) {
    state.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  }
  return state.worker;
}

function runWorkerJob(kind, message, { logEl, resultEl, button, onDone }) {
  logEl.classList.remove('hidden');
  logEl.textContent = '';
  clear(resultEl);
  button.disabled = true;
  setStatus(`${kind} đang chạy…`, true);

  const id = ++state.jobId;
  const worker = getWorker();
  const appendLog = (msg) => {
    logEl.textContent += `${msg}\n`;
    logEl.scrollTop = logEl.scrollHeight;
  };

  const handler = (e) => {
    const d = e.data;
    if (d.id !== id) return;
    if (d.type === 'progress') { appendLog(d.message); return; }
    worker.removeEventListener('message', handler);
    button.disabled = false;
    if (d.type === 'done') {
      appendLog('— hoàn tất —');
      setStatus('xong');
      onDone(d.result);
    } else {
      appendLog(`LỖI: ${d.error}`);
      setStatus('lỗi');
    }
  };
  worker.addEventListener('message', handler);
  worker.addEventListener('error', (e) => {
    appendLog(`LỖI worker: ${e.message}`);
    button.disabled = false;
    setStatus('lỗi');
  }, { once: true });
  worker.postMessage({ ...message, id });
}

async function runTrain() {
  // Lấy từ ô nhập, KHÔNG lấy từ snapshot cũ: người dùng có thể đã đổi token mà
  // chưa bấm Phân tích, khi đó train phải theo token mới.
  let symbol;
  try {
    symbol = await selectedSymbol();
  } catch (err) {
    return showBanner(err.message);
  }
  const interval = $('interval').value;
  const strategy = state.strategy || await loadStrategy();
  runWorkerJob('Train', { job: 'train', symbol, interval, strategy }, {
    logEl: $('train-log'),
    resultEl: $('train-result'),
    button: $('btn-train'),
    onDone: ({ payload, verdict }) => {
      const saved = saveModel(payload.symbol, payload.interval, payload);
      renderTrainResult(payload, verdict, saved);
      loadModelsList();
      runAnalyze();
    },
  });
}

function renderTrainResult(p, verdict, saved) {
  const host = $('train-result');
  clear(host);
  const m = p.metrics;

  const head = document.createElement('div');
  head.className = 'banner';
  head.style.marginBottom = '12px';
  head.textContent = verdict;
  if (/TỐT/.test(verdict)) head.style.borderColor = cssVar('--good');
  else if (/KHÔNG ĐÁNG TIN|KÉM/.test(verdict)) head.classList.add('error');
  else head.classList.add('warn');
  host.appendChild(head);

  if (saved && !saved.ok) {
    const w = document.createElement('div');
    w.className = 'banner error';
    w.style.marginBottom = '12px';
    w.textContent = `${saved.error} — model vẫn dùng được cho phiên này nhưng sẽ mất khi tải lại trang.`;
    host.appendChild(w);
  }

  const grid = document.createElement('div');
  grid.className = 'grid-3';
  grid.append(
    statTile('AUC holdout', String(m.test?.auc ?? '—'), '0.5 = tung xu'),
    statTile('AUC walk-forward', String(m.walkForward?.meanAuc ?? '—'),
      `${m.walkForward?.folds?.length || 0} fold`),
    statTile('Đúng khi tự tin nhất',
      m.tail?.combinedAccuracy != null ? fmtPct(m.tail.combinedAccuracy) : '—',
      m.tail ? `trên ${m.tail.bullishSignals + m.tail.bearishSignals} lần` : ''),
  );
  host.appendChild(grid);

  const dl = document.createElement('dl');
  dl.className = 'kv';
  dl.style.marginTop = '12px';
  const rows = [
    ['Nến dùng để train', `${p.candleRange.count} (${p.candleRange.from.slice(0, 10)} → ${p.candleRange.to.slice(0, 10)})`],
    ['Mẫu học', `${p.dataset.samples} (bỏ ${p.dataset.skippedNeutral} mẫu nhiễu)`],
    ['Nhãn', `${p.dataset.thresholdMode}, horizon ${p.dataset.horizon} nến`],
    ['Cây giữ lại', `${p.model.trees.length} / ${m.earlyStopping?.maxTrees} (dừng sớm theo ${m.earlyStopping?.metric})`],
  ];
  if (m.simulation?.trades) {
    rows.push(['Mô phỏng (không SL)',
      `${m.simulation.trades} lệnh, thắng ${fmtPct(m.simulation.winRate)}, tổng ${m.simulation.totalReturnPercent}%`]);
  }
  if (saved?.ok) rows.push(['Đã lưu vào trình duyệt', `${(saved.bytes / 1024).toFixed(0)} KB`]);
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = String(v);
    dl.append(dt, dd);
  }
  host.appendChild(dl);

  if (p.importance?.length) {
    const det = document.createElement('details');
    det.style.marginTop = '10px';
    const sum = document.createElement('summary');
    sum.className = 'small muted';
    sum.style.cursor = 'pointer';
    sum.textContent = 'Top chỉ báo model dựa vào';
    const ul = document.createElement('ul');
    ul.className = 'notes';
    for (const f of p.importance.slice(0, 10)) {
      const li = document.createElement('li');
      li.textContent = `${f.feature} — ${f.pct.toFixed(1)}%`;
      ul.appendChild(li);
    }
    det.append(sum, ul);
    host.appendChild(det);
  }

  // Cho tải model về để commit vào repo (dùng chung cho mọi người mở trang)
  const dlBtn = document.createElement('button');
  dlBtn.textContent = 'Tải file model (.json)';
  dlBtn.style.marginTop = '12px';
  dlBtn.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(p)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${p.symbol}_${p.interval}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  host.appendChild(dlBtn);
  const hint = document.createElement('div');
  hint.className = 'small muted';
  hint.style.marginTop = '4px';
  hint.textContent = 'Đặt file này vào thư mục models/ trong repo và thêm vào models/index.json '
    + 'để mọi người mở trang đều dùng được model, không cần train lại.';
  host.appendChild(hint);
}

function statTile(title, value, sub, tone) {
  const d = document.createElement('div');
  d.className = 'card';
  d.style.padding = '10px 12px';
  const t = document.createElement('div');
  t.className = 'small muted';
  t.textContent = title;
  const v = document.createElement('div');
  v.style.cssText = 'font-size:22px; font-weight:660; font-variant-numeric:tabular-nums';
  if (tone) v.style.color = tone;
  v.textContent = value;
  d.append(t, v);
  if (sub) {
    const s = document.createElement('div');
    s.className = 'small muted';
    s.textContent = sub;
    d.appendChild(s);
  }
  return d;
}

async function runBacktest() {
  let symbol;
  try {
    symbol = await selectedSymbol();
  } catch (err) {
    return showBanner(err.message);
  }
  const interval = $('interval').value;
  const strategy = state.strategy || await loadStrategy();
  const candles = Number($('bt-candles').value) || 3000;
  runWorkerJob('Backtest', {
    job: 'backtest', symbol, interval, strategy, candles,
    storedModel: await loadModel(symbol, interval),
  }, {
    logEl: $('bt-log'),
    resultEl: $('bt-result'),
    button: $('btn-backtest'),
    onDone: (r) => renderBacktest(r),
  });
}

function renderBacktest(r) {
  const host = $('bt-result');
  clear(host);
  const st = r.stats;

  const head = document.createElement('p');
  head.className = 'small muted';
  head.style.margin = '0 0 10px';
  head.textContent = `${r.symbol} ${r.interval} · ${r.period.from.slice(0, 10)} → ${r.period.to.slice(0, 10)} `
    + `(${r.period.candles} nến) · phí ${r.settings.feePercent}%/chiều · `
    + `thoát "${r.settings.exitStrategy}" · ML ${r.settings.usedModel ? `bật (${r.settings.mlWeight})` : 'chưa có model'}`;
  host.appendChild(head);

  if (!st.trades) {
    const p = document.createElement('div');
    p.className = 'banner warn';
    p.textContent = st.note;
    host.appendChild(p);
    return;
  }

  const good = cssVar('--good-text'), bad = cssVar('--critical');
  const grid = document.createElement('div');
  grid.className = 'grid-3';
  grid.append(
    statTile('Tổng lợi nhuận', `${fmtSigned(st.totalReturnPercent)}%`,
      `mua & giữ ${fmtSigned(st.buyHoldReturnPercent)}%`,
      st.totalReturnPercent >= 0 ? good : bad),
    statTile('Profit factor', String(st.profitFactor ?? '—'),
      st.profitFactor >= 1 ? 'trên 1 = có lãi' : 'dưới 1 = lỗ',
      st.profitFactor >= 1 ? good : bad),
    statTile('Sụt giảm tối đa', `−${st.maxDrawdownPercent}%`, 'từ đỉnh vốn', bad),
  );
  host.appendChild(grid);

  const dl = document.createElement('dl');
  dl.className = 'kv';
  dl.style.marginTop = '12px';
  for (const [k, v] of [
    ['Số lệnh', `${st.trades} (long ${st.longTrades} / short ${st.shortTrades})`],
    ['Tỉ lệ thắng', `${st.winRatePercent}% (long ${st.longWinRate ?? '—'}% / short ${st.shortWinRate ?? '—'}%)`],
    ['Lãi TB khi thắng', `${st.avgWinPercent}%`],
    ['Lỗ TB khi thua', `${st.avgLossPercent}%`],
    ['Kỳ vọng mỗi lệnh', `${st.expectancyPercent}%`],
    ['Lý do đóng lệnh', Object.entries(st.exitReasons).map(([a, b]) => `${a}: ${b}`).join(' · ')],
  ]) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = String(v);
    dl.append(dt, dd);
  }
  host.appendChild(dl);

  if (st.trades < 40) {
    const warn = document.createElement('div');
    warn.className = 'banner warn';
    warn.style.marginTop = '10px';
    warn.textContent = `Chỉ có ${st.trades} lệnh — quá ít để kết luận. Số liệu này có thể chỉ là ngẫu nhiên.`;
    host.appendChild(warn);
  }

  const det = document.createElement('details');
  det.style.marginTop = '12px';
  const sum = document.createElement('summary');
  sum.className = 'small muted';
  sum.style.cursor = 'pointer';
  sum.textContent = `${r.trades.length} lệnh gần nhất (tổng ${r.allTradeCount})`;
  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>Vào lệnh</th><th>Hướng</th><th class="num">Entry</th>'
    + '<th class="num">Thoát</th><th class="num">Lãi/lỗ</th><th>Lý do</th></tr></thead>';
  const tb = document.createElement('tbody');
  for (const t of [...r.trades].reverse()) {
    const tr = document.createElement('tr');
    for (const [txt, cls] of [
      [t.entryTime.slice(0, 16).replace('T', ' '), ''],
      [t.side === 'long' ? 'Long' : 'Short', ''],
      [fmtNum(t.entry), 'num'], [fmtNum(t.exit), 'num'],
      [`${fmtSigned(t.netPercent)}%`, `num ${t.netPercent >= 0 ? 'delta-up' : 'delta-down'}`],
      [t.reason, 'small muted'],
    ]) {
      const td = document.createElement('td');
      td.className = cls;
      td.textContent = txt;
      tr.appendChild(td);
    }
    tb.appendChild(tr);
  }
  table.appendChild(tb);
  det.append(sum, table);
  host.appendChild(det);
}

// ---------- Cấu hình ----------

const CFG_GROUP_LABELS = {
  indicators: 'Tham số chỉ báo', weights: 'Trọng số tín hiệu', thresholds: 'Ngưỡng ra tín hiệu',
  ml: 'Model học máy', risk: 'Quản lý rủi ro', llm: 'Cách Claude suy luận',
  alerts: 'Cảnh báo (chỉ dùng cho bot Telegram)', analysis: 'Phạm vi phân tích',
};

async function loadConfigEditor() {
  const host = $('config-body');
  try {
    const strategy = await loadStrategy();
    const flat = flattenStrategy(strategy);
    state.configLoaded = true;
    clear(host);

    const bar = document.createElement('div');
    bar.className = 'controls';
    bar.style.marginBottom = '12px';
    const count = document.createElement('span');
    count.className = 'small muted';
    count.textContent = overrideCount()
      ? `${overrideCount()} khoá đã sửa khác mặc định`
      : 'Đang dùng toàn bộ giá trị mặc định';
    const reset = document.createElement('button');
    reset.textContent = 'Về mặc định';
    reset.addEventListener('click', () => {
      resetStrategy();
      state.configLoaded = false;
      loadConfigEditor();
      runAnalyze();
    });
    bar.append(count, reset);
    host.appendChild(bar);

    const groups = new Map();
    for (const item of flat) {
      const g = item.path.split('.')[0];
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(item);
    }
    for (const [g, items] of groups) {
      const box = document.createElement('div');
      box.className = 'cfg-group';
      const h = document.createElement('h3');
      h.textContent = CFG_GROUP_LABELS[g] || g;
      box.appendChild(h);
      if (strategy[g]?._note) {
        const note = document.createElement('p');
        note.className = 'cfg-note';
        note.textContent = strategy[g]._note;
        box.appendChild(note);
      }
      for (const item of items) box.appendChild(configRow(item));
      host.appendChild(box);
    }
  } catch (err) {
    host.textContent = `Không tải được cấu hình: ${err.message}`;
  }
}

function configRow(item) {
  const row = document.createElement('div');
  row.className = 'cfg-row';
  const label = document.createElement('label');
  label.textContent = item.path;
  label.htmlFor = `cfg-${item.path}`;
  if (isOverridden(item.path)) label.style.fontWeight = '650';

  let input;
  if (typeof item.value === 'boolean') {
    input = document.createElement('select');
    for (const v of ['true', 'false']) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = v === 'true' ? 'bật' : 'tắt';
      input.appendChild(o);
    }
    input.value = String(item.value);
  } else {
    input = document.createElement('input');
    input.type = typeof item.value === 'number' ? 'number' : 'text';
    if (input.type === 'number') input.step = 'any';
    input.value = Array.isArray(item.value) ? item.value.join(',') : String(item.value);
  }
  input.id = `cfg-${item.path}`;
  let original = input.value;

  const commit = async () => {
    if (input.value === original) return;
    try {
      await setStrategyValue(item.path, input.value);
      original = input.value;
      row.classList.remove('changed');
      label.style.fontWeight = isOverridden(item.path) ? '650' : '';
      setStatus(`đã lưu ${item.path}`);
      state.strategy = await loadStrategy();
      if (state.snapshot) runAnalyze();
    } catch (err) {
      showBanner(`Không lưu được ${item.path}: ${err.message}`);
      input.value = original;
      row.classList.remove('changed');
    }
  };

  input.addEventListener('input', () => row.classList.toggle('changed', input.value !== original));
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });

  row.append(label, input);
  return row;
}

// ---------- Prompt ----------

async function loadPromptEditor() {
  const text = await loadPrompt();
  $('prompt-text').value = text;
  $('prompt-status').textContent = `${text.length} ký tự`
    + (promptIsCustom() ? ' · đang dùng bản bạn sửa' : ' · đang dùng bản mặc định');
}

function savePromptEditor() {
  const text = $('prompt-text').value;
  if (text.trim().length < 50) {
    $('prompt-status').textContent = 'Prompt quá ngắn (cần ≥ 50 ký tự)';
    return;
  }
  $('prompt-status').textContent = savePrompt(text)
    ? `Đã lưu · ${text.length} ký tự`
    : 'Không lưu được (trình duyệt ở chế độ riêng tư?)';
}

// ---------- Danh sách model ----------

async function loadModelsList() {
  const host = $('models-list');
  try {
    const models = await listModels();
    clear(host);
    if (!models.length) { host.textContent = 'Chưa có model nào.'; return; }
    const table = document.createElement('table');
    table.innerHTML = '<thead><tr><th>Cặp</th><th class="num">AUC holdout</th>'
      + '<th class="num">AUC walk-fwd</th><th class="num">Mẫu</th><th>Nguồn</th><th>Train lúc</th><th></th></tr></thead>';
    const tb = document.createElement('tbody');
    for (const m of models) {
      const tr = document.createElement('tr');
      for (const [txt, cls] of [
        [`${m.symbol} ${m.interval}`, ''],
        [String(m.testAuc ?? '—'), 'num'],
        [String(m.walkForwardAuc ?? '—'), 'num'],
        [String(m.samples ?? '—'), 'num'],
        [m.source === 'local' ? 'bạn train' : 'trong repo', 'small muted'],
        [m.trainedAt ? new Date(m.trainedAt).toLocaleString('vi-VN') : '—', 'small muted'],
      ]) {
        const td = document.createElement('td');
        td.className = cls;
        td.textContent = txt;
        tr.appendChild(td);
      }
      const tdBtn = document.createElement('td');
      if (m.source === 'local') {
        const del = document.createElement('button');
        del.textContent = 'Xoá';
        del.style.padding = '2px 8px';
        del.addEventListener('click', () => {
          deleteModel(m.symbol, m.interval);
          loadModelsList();
          if (state.snapshot) runAnalyze();
        });
        tdBtn.appendChild(del);
      }
      tr.appendChild(tdBtn);
      tb.appendChild(tr);
    }
    table.appendChild(tb);
    host.appendChild(table);
  } catch (err) {
    host.textContent = err.message;
  }
}

// ---------- Cài đặt AI ----------

function initSettingsPanel() {
  const input = $('apikey-input');
  input.value = getApiKey();
  updateKeyStatus();

  $('btn-save-key').addEventListener('click', () => {
    const ok = setApiKey(input.value.trim());
    $('key-status').textContent = ok
      ? (input.value.trim() ? 'Đã lưu key vào trình duyệt này.' : 'Đã xoá key.')
      : 'Không lưu được (chế độ riêng tư?)';
    updateKeyStatus();
    hideBanner();
  });

  $('btn-test-key').addEventListener('click', async () => {
    const btn = $('btn-test-key');
    btn.disabled = true;
    $('key-status').textContent = 'Đang kiểm tra…';
    try {
      setApiKey(input.value.trim());
      const r = await testApiKey();
      $('key-status').textContent = `Key hoạt động — ${r.model} trả lời: "${r.reply}"`;
      updateKeyStatus();
    } catch (err) {
      $('key-status').textContent = `Lỗi: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });
}

function updateKeyStatus() {
  const has = Boolean(getApiKey());
  $('ai-key-chip').textContent = has ? 'Đã có API key' : 'Chưa có API key';
  $('ai-key-chip').className = `chip ${has ? 'ok' : 'warn'}`;
}

// ---------- Tabs & khởi động ----------

function switchTab(id) {
  for (const btn of document.querySelectorAll('[role="tab"]')) {
    const on = btn.id === id;
    btn.setAttribute('aria-selected', String(on));
    $(btn.dataset.panel).classList.toggle('hidden', !on);
  }
  if (id === 'tab-config' && !state.configLoaded) loadConfigEditor();
  if (id === 'tab-prompt' && !$('prompt-text').value) loadPromptEditor();
  if (id === 'tab-train') loadModelsList();
}

async function init() {
  initTheme($('btn-theme'), () => { if (state.snapshot) drawCharts(state.snapshot); });
  initTerms();
  initLayers();
  watchChartWidth();

  const sel = $('interval');
  for (const iv of Object.keys(INTERVAL_MS)) {
    const o = document.createElement('option');
    o.value = iv;
    o.textContent = iv;
    sel.appendChild(o);
  }

  try {
    state.strategy = await loadStrategy();
  } catch (err) {
    showBanner(`Không tải được cấu hình: ${err.message}`);
    return;
  }

  const params = new URLSearchParams(location.search);
  sel.value = params.get('interval') || '4h';
  if (params.get('symbol')) $('symbol').value = params.get('symbol');

  $('btn-analyze').addEventListener('click', runAnalyze);
  $('btn-ai').addEventListener('click', runAiReport);
  $('btn-ask').addEventListener('click', runAsk);
  $('btn-train').addEventListener('click', runTrain);
  $('btn-backtest').addEventListener('click', runBacktest);
  $('btn-save-prompt').addEventListener('click', savePromptEditor);
  $('btn-reset-prompt').addEventListener('click', () => { resetPrompt(); loadPromptEditor(); });
  $('symbol').addEventListener('keydown', (e) => { if (e.key === 'Enter') runAnalyze(); });
  $('ask-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') runAsk(); });
  $('interval').addEventListener('change', runAnalyze);
  // Nhãn "Sẽ train" phải theo ô nhập ngay khi gõ, để không train nhầm token.
  $('symbol').addEventListener('input', updateTargetLabel);
  $('interval').addEventListener('change', updateTargetLabel);
  updateTargetLabel();
  for (const btn of document.querySelectorAll('[role="tab"]')) {
    btn.addEventListener('click', () => switchTab(btn.id));
  }

  initSettingsPanel();
  await runAnalyze();
}

init();
