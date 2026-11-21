import { CarViewer } from './car.js';
import { PARTS, GENERAL, buildUrl, fetchSheet, interpret, parseCSV, rank, LEVEL_LABEL } from './sheet.js';
import { DEMO_CSV } from './demo.js';

const $ = (s) => document.querySelector(s);
const SETTINGS_KEY = 'carapp.settings.v1';
const CACHE_KEY = 'carapp.cache.v1';
const DEFAULTS = { sheet: '', sheetName: '', interval: 5, carName: 'インサイト', bodyColor: '#080c0b', plateRegion: '岐阜 303', plateKana: '', plateNumber: '55-10' };

// ---------- storage (wrapped: private mode can throw) ----------
const store = {
  get(k, fb) { try { return JSON.parse(localStorage.getItem(k)) ?? fb; } catch { return fb; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};

// Settings may also be passed in the URL once (?sheet=...&name=...), handy for sharing to the iPhone.
function loadSettings() {
  const s = { ...DEFAULTS, ...store.get(SETTINGS_KEY, {}) };
  const q = new URLSearchParams(location.search);
  let changed = false;
  for (const [qk, sk] of [['sheet', 'sheet'], ['tab', 'sheetName'], ['name', 'carName'], ['color', 'bodyColor']]) {
    if (q.has(qk)) { s[sk] = q.get(qk); changed = true; }
  }
  if (changed) {
    store.set(SETTINGS_KEY, s);
    history.replaceState(null, '', location.pathname);
  }
  return s;
}

let settings = loadSettings();
function plateOf(st) {
  return { region: st.plateRegion, kana: st.plateKana, number: st.plateNumber };
}
let data = null; // interpret() result
let currentView = null; // { type: 'part'|'general'|'attention', id }
let timer = null;
let lastSync = null;
let loading = false;

const viewer = new CarViewer($('#viewer'), {
  bodyColor: settings.bodyColor,
  plate: plateOf(settings),
  onSelect: (id) => (id ? openPart(id) : closePanel()),
});
viewer.onInteract = () => $('#hint').classList.add('hide');

$('#carName').textContent = settings.carName || DEFAULTS.carName;

// ---------- data ----------
function apply(table, source) {
  data = interpret(table);
  viewer.setLevels(data.levels);
  renderSummary();
  if (currentView) rerenderPanel();
  $('#demoBanner').hidden = source !== 'demo';
}

async function refresh({ manual = false } = {}) {
  if (loading) return;
  const url = buildUrl(settings.sheet, settings.sheetName);
  if (!url) {
    apply(parseCSV(DEMO_CSV), 'demo');
    lastSync = new Date();
    setStatus();
    return;
  }
  loading = true;
  $('#btnRefresh').classList.add('spinning');
  try {
    const table = await fetchSheet(url);
    apply(table, 'sheet');
    lastSync = new Date();
    store.set(CACHE_KEY, { url, table, at: lastSync.toISOString() });
    $('#errorBanner').hidden = true;
  } catch (e) {
    const cache = store.get(CACHE_KEY, null);
    if (!data && cache && cache.url === url) {
      apply(cache.table, 'cache');
      lastSync = new Date(cache.at);
    }
    showError(`${e.message || e}${data ? '（前回取得したデータを表示中）' : ''}`);
    if (!data) apply(parseCSV(DEMO_CSV), 'demo');
  } finally {
    loading = false;
    $('#btnRefresh').classList.remove('spinning');
    setStatus();
  }
}

function showError(msg) {
  const el = $('#errorBanner');
  el.textContent = msg;
  el.hidden = false;
}

function setStatus() {
  const n = data ? data.rows.length : 0;
  const t = lastSync ? lastSync.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
  $('#syncStatus').textContent = `${n}件 ・ ${t} 更新（${settings.interval}分毎）`;
}

function schedule() {
  clearInterval(timer);
  timer = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, Math.max(1, +settings.interval) * 60000);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (!lastSync || Date.now() - lastSync > 60000)) refresh();
});

// ---------- summary chips ----------
function renderSummary() {
  const nav = $('#summary');
  const bad = data.rows.filter((r) => r.level === 'bad').length;
  const warn = data.rows.filter((r) => r.level === 'warn').length;
  const chips = [];
  if (bad || warn) {
    chips.push(`<button class="chip" data-view="attention"><span class="dot ${bad ? 'bad' : 'warn'}"></span>要確認 <b>${bad + warn}</b>件</button>`);
  } else {
    chips.push(`<button class="chip" data-view="attention"><span class="dot ok"></span>すべて良好</button>`);
  }
  if (data.byPart.general.length) {
    chips.push(`<button class="chip" data-view="general"><span class="dot ${data.levels.general}"></span>車両全般 <b>${data.byPart.general.length}</b></button>`);
  }
  chips.push(`<button class="chip" data-view="all">すべての項目 <b>${data.rows.length}</b></button>`);
  nav.innerHTML = chips.join('');
}
$('#summary').addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]');
  if (!b) return;
  viewer.select(null);
  openList(b.dataset.view);
});

// ---------- panel ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function itemHTML(row, { showParts = false } = {}) {
  const kv = row.cells.map((c) => `<dt>${esc(c.label)}</dt><dd>${esc(c.value)}</dd>`).join('');
  const parts = showParts && row.parts.length
    ? `<p class="reason">${row.parts.map((id) => `<button class="part-link" data-part="${id}">${esc(PARTS[id].label)}</button>`).join(' ・ ')}</p>`
    : '';
  return `<article class="item">
    <div class="item-head"><span class="item-title">${esc(row.title)}</span><span class="badge ${row.level}">${LEVEL_LABEL[row.level]}</span></div>
    ${row.reasons.length ? `<p class="reason">${esc(row.reasons.join(' ・ '))}</p>` : ''}
    <dl class="kv">${kv}</dl>${parts}
  </article>`;
}

function sortRows(rows) {
  return [...rows].sort((a, b) => rank(b.level) - rank(a.level));
}

function openPart(id) {
  currentView = { type: 'part', id };
  const rows = data?.byPart[id] || [];
  const lv = data?.levels[id] || 'none';
  $('#panelTitle').textContent = PARTS[id]?.label || id;
  $('#panelSub').innerHTML = rows.length
    ? `<span class="dot ${lv}"></span> ${LEVEL_LABEL[lv]} ・ ${rows.length}件の記録`
    : '点検管理表に該当する記録がありません';
  $('#panelBody').innerHTML = rows.length
    ? sortRows(rows).map((r) => itemHTML(r)).join('')
    : `<p class="empty">「${esc(PARTS[id]?.label)}」に関する行が見つかりませんでした。<br>部位列に「${esc(PARTS[id]?.words[0])}」などの言葉を入れると表示されます。</p>`;
  showPanel();
}

function openList(type) {
  currentView = { type, id: type };
  let rows, title;
  if (type === 'general') { rows = data.byPart.general; title = GENERAL.label; }
  else if (type === 'attention') { rows = data.rows.filter((r) => r.level === 'bad' || r.level === 'warn'); title = '要確認の項目'; }
  else { rows = data.rows; title = 'すべての項目'; }
  $('#panelTitle').textContent = title;
  $('#panelSub').textContent = `${rows.length}件`;
  $('#panelBody').innerHTML = rows.length
    ? sortRows(rows).map((r) => itemHTML(r, { showParts: true })).join('')
    : '<p class="empty">要確認の項目はありません 👍</p>';
  showPanel();
}

function rerenderPanel() {
  if (currentView.type === 'part') openPart(currentView.id);
  else openList(currentView.type);
}

$('#panelBody').addEventListener('click', (e) => {
  const b = e.target.closest('[data-part]');
  if (!b) return;
  viewer.select(b.dataset.part);
  openPart(b.dataset.part);
});

function showPanel() {
  $('#panel').classList.add('open');
  $('#panel').setAttribute('aria-hidden', 'false');
  $('#panelBody').scrollTop = 0;
  requestAnimationFrame(() => viewer.setBottomInset($('#panel').offsetHeight));
}
function closePanel() {
  currentView = null;
  viewer.select(null);
  $('#panel').classList.remove('open');
  $('#panel').setAttribute('aria-hidden', 'true');
  viewer.setBottomInset(0);
}
$('#btnClosePanel').addEventListener('click', closePanel);

// swipe down on the sheet header to close
(() => {
  let y0 = null;
  const head = $('#panel');
  head.addEventListener('touchstart', (e) => { if (!e.target.closest('.panel-body')) y0 = e.touches[0].clientY; }, { passive: true });
  head.addEventListener('touchend', (e) => {
    if (y0 != null && e.changedTouches[0].clientY - y0 > 60) closePanel();
    y0 = null;
  });
})();

// ---------- settings ----------
const dlg = $('#settings');
const form = $('#settingsForm');
function openSettings() {
  for (const [k, v] of Object.entries(settings)) if (form.elements[k]) form.elements[k].value = v;
  dlg.showModal();
}
$('#btnSettings').addEventListener('click', openSettings);
$('#btnOpenSettings2').addEventListener('click', openSettings);
dlg.addEventListener('close', () => {
  if (dlg.returnValue !== 'save') return;
  const fd = new FormData(form);
  settings = { ...settings, ...Object.fromEntries(fd.entries()) };
  settings.interval = +settings.interval || 5;
  store.set(SETTINGS_KEY, settings);
  $('#carName').textContent = settings.carName || DEFAULTS.carName;
  viewer.setBodyColor(settings.bodyColor);
  viewer.setPlate(plateOf(settings));
  data = null;
  $('#errorBanner').hidden = true;
  schedule();
  refresh({ manual: true });
});

$('#btnRefresh').addEventListener('click', () => refresh({ manual: true }));

// ---------- start ----------
refresh();
schedule();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
