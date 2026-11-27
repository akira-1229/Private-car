import { CarViewer } from './car.js';
import { PARTS, GENERAL, buildUrl, fetchSheet, fetchBook, interpret, parseCSV, rank, LEVEL_LABEL } from './sheet.js';
import { DEMO_CSV } from './demo.js';

const $ = (s) => document.querySelector(s);
const BUILD = document.querySelector('meta[name="app-build"]')?.content || '';
const SETTINGS_KEY = 'carapp.settings.v1';
const CACHE_KEY = 'carapp.cache.v1';
const DEFAULT_SHEET = 'https://docs.google.com/spreadsheets/d/1-BuCzgFYa1fTVGN5v-L4rzbnQeDGJk0MMLSlXrWCPR0/edit';
const DEFAULTS = {
  sheet: DEFAULT_SHEET, sheetName: '', interval: 5, carName: 'インサイト', bodyColor: '#05070b',
  plateRegion: '岐阜 303', plateKana: 'の', plateNumber: '55-10',
  // appearance (設定タブ)
  gasUrl: '', gasToken: '',
  brightness: 1, accent: '#4f8cff', panelStyle: 'glass', fontSize: 'm', autoRotate: true, rotateSpeed: 0.8, garage: true,
};

// ---------- storage (wrapped: private mode can throw) ----------
const store = {
  get(k, fb) { try { return JSON.parse(localStorage.getItem(k)) ?? fb; } catch { return fb; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};

// Settings may also be passed in the URL once (?sheet=...&name=...), handy for sharing to the iPhone.
function loadSettings() {
  const s = { ...DEFAULTS, ...store.get(SETTINGS_KEY, {}) };
  if (!s.sheet) s.sheet = DEFAULT_SHEET;
  // the scanned-model settings were retired: the built-in model is always shown
  let retired = false;
  for (const k of ['carModel', 'modelUrl', 'modelFlip']) if (k in s) { delete s[k]; retired = true; }
  // the old default black (#080c0b) looked grey-green: move it to the new deeper crystal black
  if (String(s.bodyColor).toLowerCase() === '#080c0b') { s.bodyColor = DEFAULTS.bodyColor; retired = true; }
  const q = new URLSearchParams(location.search);
  let changed = false;
  for (const [qk, sk] of [['sheet', 'sheet'], ['tab', 'sheetName'], ['name', 'carName'], ['color', 'bodyColor']]) {
    if (q.has(qk)) { s[sk] = q.get(qk); changed = true; }
  }
  if (retired && !changed) store.set(SETTINGS_KEY, s);
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
if (/[?&]debug\b/.test(location.search)) window.__viewer = viewer;
viewer.onInteract = () => $('#hint').classList.add('hide');
viewer.onPanel = (id, open, label) => {
  toast(`${label}を${open ? '開けました' : '閉めました'}`);
  // opening the hood shows the engine bay records; closing it puts them away again
  if (id === 'hood' && open) { viewer.select('engine'); openPart('engine'); }
  else if (id === 'hood' && currentView?.id === 'engine') closePanel();
};
let toastTimer = 0;
function toast(msg, ms = 1400) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

$('#carName').textContent = settings.carName || DEFAULTS.carName;

// ---------- files kept on this device (IndexedDB) ----------
const idb = {
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('carapp', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('files');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async run(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('files', mode);
      const req = fn(tx.objectStore('files'));
      tx.oncomplete = () => res(req?.result);
      tx.onerror = () => rej(tx.error);
    });
  },
  get: (k) => idb.run('readonly', (s) => s.get(k)).catch(() => null),
  set: (k, v) => idb.run('readwrite', (s) => s.put(v, k)),
  del: (k) => idb.run('readwrite', (s) => s.delete(k)).catch(() => {}),
};

// a 3D scan saved by an older version is no longer used: free the space
idb.del('model');

// ---------- data ----------
let lastTable = null;
function apply(table, source) {
  lastTable = table;
  data = interpret(mergePending(table));
  for (const r of data.rows) if (pendingKeys.size && pendingKeys.has(rowKey(data.headers, data.headers.map((h) => cellOf(r, h))))) r.pending = true;
  viewer.setLevels(data.levels);
  // feed the garage TV
  const fills = data.rows.filter((r) => r.kmL && (!data.stats.car || r.car === data.stats.car));
  const date = (r) => (r.sub || '').split(' ・ ')[0].replace(/\s*\(.\)/, '');
  const byKm = [...fills].sort((a, b) => b.kmL - a.kmL);
  const last = fills[fills.length - 1];
  viewer.garage?.userData.setTv?.({
    ...data.stats,
    lastKmL: last?.kmL, lastDate: last && date(last),
    best: byKm[0] && { kmL: byKm[0].kmL, date: date(byKm[0]) },
    worst: byKm.length && { kmL: byKm[byKm.length - 1].kmL, date: date(byKm[byKm.length - 1]) },
    perFill: data.stats.fills && data.stats.lastOdo && data.stats.firstOdo ? (data.stats.lastOdo - data.stats.firstOdo) / Math.max(1, data.stats.fills - 1) : null,
  });
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
    return { ok: true, demo: true };
  }
  loading = true;
  let result;
  $('#titleCard').classList.add('loading');
  try {
    const table = await fetchBook(url, { full: manual });
    apply(table, 'sheet');
    lastSync = new Date();
    store.set(CACHE_KEY, { url, table, at: lastSync.toISOString() });
    setTimeout(sendPending, 500);
    $('#errorBanner').hidden = true;
    result = { ok: true };
  } catch (e) {
    result = { ok: false, error: e.message || String(e) };
    const cache = store.get(CACHE_KEY, null);
    if (!data && cache && cache.url === url) {
      apply(cache.table, 'cache');
      lastSync = new Date(cache.at);
    }
    showError(`${e.message || e}${data ? '（前回取得したデータを表示中）' : ''}`);
    if (!data) apply(parseCSV(DEMO_CSV), 'demo');
  } finally {
    loading = false;
    $('#titleCard').classList.remove('loading');
    setStatus();
  }
  return result;
}

function showError(msg) {
  const el = $('#errorBanner');
  el.textContent = msg;
  el.hidden = false;
}

function setStatus() {
  $('#syncStatus').textContent = lastSync
    ? lastSync.toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '—';
}

function schedule() {
  clearInterval(timer);
  timer = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, Math.max(1, +settings.interval) * 60000);
}
// leaving the app closes every door / hood / trunk, so it always comes back with the car shut
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') viewer.closeAllPanels(); });
window.addEventListener('pageshow', () => viewer.closeAllPanels());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (!lastSync || Date.now() - lastSync > 60000)) refresh();
});

// ---------- tab bar ----------
const TABS = {
  vehicle: () => openVehicle(),
  maint: () => {
    // open the hood, look into the engine bay and make it glow
    if (viewer.panels?.has('hood')) viewer.togglePanel('hood', true);
    viewer.focusOn('hood');
    viewer.select('engine');
    openPart('engine', { title: '点検整備', tab: 'maint' });
  },
  wash: () => { viewer.select('body'); openPart('body', { title: '洗車清掃', tab: 'wash' }); },
  settings: () => openSettings(),
};
let activeTab = null;
function setActiveTab(t) {
  activeTab = t;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
}
$('#tabbar').addEventListener('click', (e) => {
  const b = e.target.closest('.tab');
  if (!b) return;
  if (activeTab === b.dataset.tab && $('#panel').classList.contains('open')) { closePanel(); return; }
  viewer.select(null);
  TABS[b.dataset.tab]();
});
$('#titleCard').addEventListener('click', () => refresh({ manual: true }));

// ---------- panel ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function itemHTML(row, { showParts = false } = {}) {
  const kv = row.cells.map((c) => `<dt>${esc(c.label)}</dt><dd>${esc(c.value)}</dd>`).join('');
  const parts = showParts && row.parts.length
    ? `<p class="reason">${row.parts.map((id) => `<button class="part-link" data-part="${id}">${esc(PARTS[id].label)}</button>`).join(' ・ ')}</p>`
    : '';
  return `<article class="item">
    <div class="item-head"><span class="item-title">${esc(row.title)}</span><span class="badge ${row.level}">${row.level === 'none' && row.cost != null ? `¥${row.cost.toLocaleString()}` : LEVEL_LABEL[row.level]}</span></div>
    ${row.sub || row.pending ? `<p class="item-sub">${esc(row.sub || '')}${row.pending ? ' <span class="pend">スプレッドシート送信待ち</span>' : ''}</p>` : ''}
    ${row.reasons.length ? `<p class="reason">${esc(row.reasons.join(' ・ '))}</p>` : ''}
    <dl class="kv">${kv}</dl>${parts}
  </article>`;
}

function sortRows(rows) {
  // most urgent first, then newest first (the sheet is a chronological log)
  return [...rows].sort((a, b) => rank(b.level) - rank(a.level) || b.idx - a.idx);
}

// ---- records are shown one year at a time; swipe left/right (or ‹ ›) to change the year ----
let viewYear = null;
function yearsOf(rows) {
  const ys = [...new Set(rows.map((r) => r.year ?? null))];
  return ys.sort((a, b) => (b ?? -1) - (a ?? -1)); // newest first, "no date" last
}
function yearBlock(rows, { showParts = false, fuel = false } = {}) {
  const years = yearsOf(rows);
  if (!years.includes(viewYear)) viewYear = years[0] ?? null;
  const list = rows.filter((r) => (r.year ?? null) === viewYear);
  const i = years.indexOf(viewYear);
  const older = years[i + 1], newer = years[i - 1];
  const label = viewYear == null ? '日付なしの記録' : `${viewYear}年の記録`;
  const cost = list.reduce((s, r) => s + (r.cost || 0), 0);
  const legs = list.filter((r) => r.kmL);
  const yearKmL = legs.length ? legs.reduce((s, r) => s + r.leg, 0) / legs.reduce((s, r) => s + (r.legFuel || r.fuel), 0) : null;
  const facts = [`${list.length}件`];
  if (fuel) facts.push(`給油 ${list.filter((r) => r.fuel).length}回`);
  if (cost) facts.push(`合計 ¥${Math.round(cost).toLocaleString()}`);
  if (fuel && yearKmL) facts.push(`平均 ${yearKmL.toFixed(1)} km/L`);
  const dots = years.length > 1
    ? `<div class="yr-dots">${years.map((y) => `<span class="${y === viewYear ? 'on' : ''}"></span>`).join('')}</div>` : '';
  const bar = `<div class="year-bar">
      <button class="yr-btn" ${newer === undefined ? 'disabled' : ''} aria-label="新しい年">‹</button>
      <div class="yr-label"><b>${label}</b><small>${facts.join(' ・ ')}</small>${dots}</div>
      <button class="yr-btn" ${older === undefined ? 'disabled' : ''} aria-label="古い年">›</button>
    </div>`;
  return bar + sortRows(list).map((r) => itemHTML(r, { showParts })).join('');
}
function changeYear(dir) {
  const rows = currentRows();
  const years = yearsOf(rows);
  const i = years.indexOf(viewYear);
  const j = i + dir; // +1 = older, -1 = newer
  if (j < 0 || j >= years.length) return;
  viewYear = years[j];
  rerenderPanel();
}
function currentRows() {
  if (!currentView || !data) return [];
  if (currentView.type === 'part') return data.byPart[currentView.id] || [];
  if (currentView.type === 'general') return data.byPart.general;
  if (currentView.type === 'attention') return data.rows.filter((r) => r.level === 'bad' || r.level === 'warn');
  return data.rows;
}

function openPart(id, { title, tab } = {}) {
  currentView = { type: 'part', id, title, tab };
  setActiveTab(tab || null);
  const rows = data?.byPart[id] || [];
  const lv = data?.levels[id] || 'none';
  $('#panelTitle').textContent = title || PARTS[id]?.label || id;
  $('#panelSub').innerHTML = rows.length
    ? `<span class="dot ${lv}"></span> ${LEVEL_LABEL[lv]} ・ 全${rows.length}件の記録`
    : '点検管理表に該当する記録がありません';
  $('#panelBody').innerHTML = rows.length
    ? yearBlock(rows, { fuel: id === 'fuel' })
    : `<p class="empty">「${esc(PARTS[id]?.label)}」に関する行が見つかりませんでした。<br>部位列に「${esc(PARTS[id]?.words[0])}」などの言葉を入れると表示されます。</p>`;
  showPanel();
}

function openList(type) {
  currentView = { type, id: type };
  setActiveTab(null);
  let rows, title;
  if (type === 'general') { rows = data.byPart.general; title = GENERAL.label; }
  else if (type === 'attention') { rows = data.rows.filter((r) => r.level === 'bad' || r.level === 'warn'); title = '要確認の項目'; }
  else { rows = data.rows; title = 'すべての記録'; }
  $('#panelTitle').textContent = title;
  $('#panelSub').textContent = `全${rows.length}件`;
  $('#panelBody').innerHTML = rows.length
    ? yearBlock(rows, { showParts: true })
    : '<p class="empty">要確認の項目はありません 👍</p>';
  showPanel();
}

function rerenderPanel() {
  if (currentView.type === 'part') openPart(currentView.id, currentView);
  else if (currentView.type === 'vehicle') openVehicle({ keepScroll: true });
  else if (currentView.type === 'settings' || currentView.type === 'add') return; // forms: don't rebuild under the user's fingers
  else openList(currentView.type);
}

$('#panelBody').addEventListener('click', (e) => {
  const yb = e.target.closest('.yr-btn');
  if (yb && !yb.disabled) { changeYear(yb.getAttribute('aria-label') === '古い年' ? 1 : -1); return; }
  const b = e.target.closest('[data-part]');
  if (!b) return;
  viewer.select(b.dataset.part);
  openPart(b.dataset.part);
});

function showPanel({ keepScroll = false } = {}) {
  $('#btnAdd').hidden = !(currentView && (currentView.type === 'part' || ['all', 'general', 'attention'].includes(currentView.type)));
  $('#btnSync').hidden = $('#btnAdd').hidden;
  $('#panel').classList.add('open');
  $('#panel').setAttribute('aria-hidden', 'false');
  if (!keepScroll) $('#panelBody').scrollTop = 0;
  requestAnimationFrame(() => viewer.setBottomInset($('#panel').offsetHeight));
}
function closePanel() {
  const wasMaint = currentView?.tab === 'maint';
  currentView = null;
  if (wasMaint && viewer.panels?.get('hood')?.target > 0.5) viewer.togglePanel('hood', false); // close the hood again
  setActiveTab(null);
  viewer.select(null);
  $('#panel').classList.remove('open');
  $('#panel').setAttribute('aria-hidden', 'true');
  viewer.setBottomInset(0);
}
$('#btnClosePanel').addEventListener('click', closePanel);

// swipe left / right on the records to change the year
(() => {
  let sx = null, sy = 0;
  const body = $('#panelBody');
  body.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  body.addEventListener('touchend', (e) => {
    if (sx == null) return;
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    sx = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) changeYear(dx < 0 ? 1 : -1); // older years lie to the right: swipe left = older
  });
})();

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

// ---------- 車両情報 tab: details, due dates and documents (車検証・自賠責 …) ----------
const VEHICLE_KEY = 'carapp.vehicle.v1';
const VEHICLE_DEFAULT = { model: 'ZE4', grade: 'EX・BLACK STYLE', color: 'クリスタルブラック・パール', shaken: '', jibai: '', nini: '' };
const DOCS = [
  ['shaken', '車検証'],
  ['jibai', '自賠責保険証明書'],
  ['nini', '任意保険証券'],
  ['recycle', 'リサイクル券'],
  ['other', 'その他の書類'],
];
const DUES = [['shaken', '車検満了日'], ['jibai', '自賠責保険 満了日'], ['nini', '任意保険 満了日']];
let docUrls = [];
let docCache = null; // { slotId: [files] } — shown immediately, refreshed from IndexedDB in the background
function vehicle() { return { ...VEHICLE_DEFAULT, ...store.get(VEHICLE_KEY, {}) }; }
function daysLeft(iso) {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00`);
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((d - t) / 86400000);
}
function openVehicle({ keepScroll = false } = {}) {
  currentView = { type: 'vehicle', id: 'vehicle' };
  setActiveTab('vehicle');
  const v = vehicle();
  const st = data?.stats || {};
  const year = new Date().getFullYear();
  const yearCost = (data?.rows || []).filter((r) => r.year === year && (!st.car || r.car === st.car)).reduce((s, r) => s + (r.cost || 0), 0);
  $('#panelTitle').textContent = '車両情報';
  $('#panelSub').textContent = `${settings.carName} ・ ${settings.plateRegion} ${settings.plateKana} ${settings.plateNumber}`;
  docUrls.forEach((u) => URL.revokeObjectURL(u));
  docUrls = [];
  const docs = DOCS.map(([id]) => docCache?.[id] || []);
  const due = DUES.map(([k, label]) => {
    const n = daysLeft(v[k]);
    const cls = n == null ? '' : n < 0 ? 'bad' : n <= 60 ? 'warn' : 'ok';
    const txt = n == null ? '未設定' : n < 0 ? `${-n}日 過ぎています` : `あと ${n}日`;
    return `<label class="due"><span>${label}</span><input type="date" data-vehicle="${k}" value="${esc(v[k])}"><b class="badge ${cls}">${txt}</b></label>`;
  }).join('');
  const docHTML = DOCS.map(([id, label], i) => {
    const files = docs[i].map((f, j) => {
      const url = URL.createObjectURL(f.blob);
      docUrls.push(url);
      const thumb = f.type?.startsWith('image/') ? `<img src="${url}" alt="">` : '<span class="pdf">PDF</span>';
      return `<div class="doc-file"><button class="doc-thumb" data-open="${id}:${j}">${thumb}</button>
        <small>${esc(f.name)}</small><button class="doc-del" data-del="${id}:${j}" aria-label="削除">✕</button></div>`;
    }).join('');
    return `<div class="doc-slot"><div class="doc-head"><b>${label}</b>
        <label class="doc-add">＋ 追加<input type="file" accept="image/*,application/pdf" data-add="${id}" multiple hidden></label></div>
        <div class="doc-files">${files || `<p class="doc-empty">${docCache ? '写真またはPDFを追加できます' : '読み込み中…'}</p>`}</div></div>`;
  }).join('');
  $('#panelBody').innerHTML = `
    <section class="card">
      <h3>車両</h3>
      <dl class="kv">
        <dt>車名</dt><dd>${esc(settings.carName)}</dd>
        <dt>型式</dt><dd><input class="inline" data-vehicle="model" value="${esc(v.model)}"></dd>
        <dt>グレード</dt><dd><input class="inline" data-vehicle="grade" value="${esc(v.grade)}"></dd>
        <dt>ボディ色</dt><dd><input class="inline" data-vehicle="color" value="${esc(v.color)}"></dd>
        <dt>ナンバー</dt><dd>${esc(`${settings.plateRegion} ${settings.plateKana} ${settings.plateNumber}`)}</dd>
      </dl>
    </section>
    <section class="card stats">
      <div><small>平均燃費</small><b>${st.avgKmL ? st.avgKmL.toFixed(1) : '--'}</b><span>km/L</span></div>
      <div><small>走行距離</small><b>${st.lastOdo ? st.lastOdo.toLocaleString() : '--'}</b><span>km</span></div>
      <div><small>${year}年の費用</small><b>${yearCost ? `¥${Math.round(yearCost).toLocaleString()}` : '--'}</b><span>記録分</span></div>
    </section>
    <section class="card"><h3>期限</h3>${due}</section>
    <section class="card"><h3>書類</h3>${docHTML}
      <p class="note">書類はこの iPhone の中にだけ保存されます（他の端末やスプレッドシートには送られません）。</p></section>`;
  showPanel({ keepScroll });
  if (!docCache) loadDocs().then(() => { if (currentView?.type === 'vehicle') openVehicle({ keepScroll: true }); });
}
async function loadDocs() {
  const lists = await Promise.all(DOCS.map(async ([id]) => (await idb.get(`doc:${id}`)) || []));
  docCache = Object.fromEntries(DOCS.map(([id], i) => [id, lists[i]]));
}
async function saveDocs(id, list) {
  docCache = { ...(docCache || {}), [id]: list };
  openVehicle({ keepScroll: true });
  await idb.set(`doc:${id}`, list).catch((err) => showError(`保存できませんでした: ${err.message || err}`));
}

// ---------- 設定 tab ----------
const ACCENTS = [['#4f8cff', 'ブルー'], ['#34c77b', 'グリーン'], ['#f5a524', 'オレンジ'], ['#a970ff', 'パープル'], ['#ff5a6a', 'レッド'], ['#c9ced6', 'シルバー']];
function openSettings() {
  currentView = { type: 'settings', id: 'settings' };
  setActiveTab('settings');
  const s = settings;
  const opt = (name, list) => list.map(([v, l]) => `<button class="seg ${String(s[name]) === String(v) ? 'on' : ''}" data-pref="${name}" data-value="${v}">${l}</button>`).join('');
  const t = lastSync ? lastSync.toLocaleString('ja-JP') : '—';
  $('#panelTitle').textContent = '設定';
  $('#panelSub').textContent = `バージョン ${BUILD.startsWith('__') ? '開発版' : BUILD}`;
  $('#panelBody').innerHTML = `
    <section class="card"><h3>表示</h3>
      <label class="row">画面の明るさ <output>${Math.round(s.brightness * 100)}%</output>
        <input type="range" min="0.5" max="1.6" step="0.05" value="${s.brightness}" data-pref="brightness"></label>
      <div class="row">テーマカラー<div class="swatches">${ACCENTS.map(([c, l]) => `<button class="swatch ${s.accent === c ? 'on' : ''}" style="--c:${c}" data-pref="accent" data-value="${c}" aria-label="${l}"></button>`).join('')}</div></div>
      <div class="row">パネルのスタイル<div class="segs">${opt('panelStyle', [['glass', 'ガラス'], ['solid', 'ソリッド'], ['light', 'ライト']])}</div></div>
      <div class="row">文字の大きさ<div class="segs">${opt('fontSize', [['s', '小'], ['m', '標準'], ['l', '大']])}</div></div>
    </section>
    <section class="card"><h3>3D</h3>
      <label class="row">自動で回転 <input type="checkbox" class="switch" data-pref="autoRotate" ${s.autoRotate ? 'checked' : ''}></label>
      <label class="row">回転の速さ <output>${s.rotateSpeed}</output>
        <input type="range" min="0.2" max="3" step="0.1" value="${s.rotateSpeed}" data-pref="rotateSpeed"></label>
      <label class="row">ガレージを表示 <input type="checkbox" class="switch" data-pref="garage" ${s.garage ? 'checked' : ''}></label>
    </section>
    <section class="card"><h3>車</h3>
      <label class="field">車の名前<input data-pref="carName" value="${esc(s.carName)}"></label>
      <div class="row3">
        <label class="field">ナンバー（地名・分類番号）<input data-pref="plateRegion" value="${esc(s.plateRegion)}"></label>
        <label class="field">ひらがな<input data-pref="plateKana" maxlength="1" value="${esc(s.plateKana)}"></label>
        <label class="field">番号<input data-pref="plateNumber" value="${esc(s.plateNumber)}"></label>
      </div>
      <label class="row">ボディカラー <input type="color" data-pref="bodyColor" value="${esc(s.bodyColor)}"></label>
    </section>
    <section class="card"><h3>データ</h3>
      <label class="field">スプレッドシートの URL<input type="url" id="setSheet" value="${esc(s.sheet)}" autocomplete="off"></label>
      <label class="field">シート名（空欄なら年ごとのシートを全部読み込み）<input id="setSheetName" value="${esc(s.sheetName)}"></label>
      <div class="row">自動更新<div class="segs">${opt('interval', [[1, '1分'], [5, '5分'], [15, '15分'], [60, '60分']])}</div></div>
      <div class="row-btns">
        <button class="btn primary" data-action="saveSheet">保存して読み込み</button>
        <button class="btn" data-action="refresh">今すぐ更新</button>
      </div>
      <p class="note">最終更新：${esc(t)}</p>
    </section>
    <section class="card"><h3>スプレッドシートへの書き込み</h3>
      <label class="field">Apps Script ウェブアプリの URL<input type="url" id="setGasUrl" value="${esc(s.gasUrl)}" placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off"></label>
      <label class="field">合言葉（Apps Script の TOKEN と同じもの）<input id="setGasToken" value="${esc(s.gasToken)}" autocomplete="off"></label>
      <div class="row-btns"><button class="btn primary" data-action="saveGas">保存</button><button class="btn" data-action="copyGas">スクリプトをコピー</button></div>
      <p class="note">＋ボタンで追加した記録をスプレッドシートにも書き込むための設定です。<br>
      ① 点検管理表で「拡張機能 → Apps Script」を開く ② コピーしたスクリプトを貼り付け、TOKEN を合言葉に変えて保存
      ③「デプロイ → 新しいデプロイ → ウェブアプリ」（実行ユーザー：自分／アクセス：全員）④ 出てきた URL と合言葉をここに入れて保存
      ${pending().length ? `<br>送信待ち：${pending().filter((p) => !p.sent).length}件` : ''}</p>
    </section>`;
  showPanel();
}

function saveSettings() { store.set(SETTINGS_KEY, settings); }
function applyPrefs() {
  const root = document.documentElement;
  root.style.setProperty('--accent', settings.accent);
  root.dataset.panel = settings.panelStyle;
  root.dataset.font = settings.fontSize;
  viewer.setPrefs({ brightness: +settings.brightness, autoRotate: !!settings.autoRotate, rotateSpeed: +settings.rotateSpeed, garage: !!settings.garage });
  $('#carName').textContent = settings.carName || DEFAULTS.carName;
}

// one set of delegated handlers serves the vehicle and settings panels
$('#panelBody').addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.pref && el.type === 'range') {
    settings[el.dataset.pref] = +el.value;
    const out = el.parentElement.querySelector('output');
    if (out) out.textContent = el.dataset.pref === 'brightness' ? `${Math.round(el.value * 100)}%` : el.value;
    saveSettings(); applyPrefs();
  }
});
$('#panelBody').addEventListener('change', async (e) => {
  const el = e.target;
  if (el.dataset.vehicle) {
    const v = vehicle(); v[el.dataset.vehicle] = el.value; store.set(VEHICLE_KEY, v);
    if (el.type === 'date') openVehicle({ keepScroll: true });
    return;
  }
  if (el.dataset.add) {
    if (!docCache) await loadDocs();
    const list = [...(docCache[el.dataset.add] || [])];
    for (const f of el.files) list.push({ name: f.name, type: f.type, blob: f, at: Date.now() });
    await saveDocs(el.dataset.add, list);
    return;
  }
  if (!el.dataset.pref) return;
  const k = el.dataset.pref;
  if (el.type === 'checkbox') settings[k] = el.checked;
  else if (el.type !== 'range') settings[k] = el.value;
  saveSettings();
  applyPrefs();
  if (k === 'bodyColor') viewer.setBodyColor(settings.bodyColor);
  if (k.startsWith('plate')) viewer.setPlate(plateOf(settings));
});
$('#panelBody').addEventListener('click', async (e) => {
  const seg = e.target.closest('[data-pref][data-value]');
  if (seg) {
    const k = seg.dataset.pref;
    settings[k] = k === 'interval' ? +seg.dataset.value : seg.dataset.value;
    saveSettings(); applyPrefs();
    if (k === 'interval') schedule();
    seg.parentElement.querySelectorAll('[data-pref]').forEach((b) => b.classList.toggle('on', b === seg));
    return;
  }
  const act = e.target.closest('[data-action]')?.dataset.action;
  if (act === 'cancelAdd') { const back = currentView?.back; if (back?.type === 'part') openPart(back.id, back); else openList(back?.type || 'all'); return; }
  if (act === 'refresh') { await refresh({ manual: true }); openSettings(); }
  if (act === 'saveSheet') {
    settings.sheet = $('#setSheet').value.trim() || DEFAULT_SHEET;
    settings.sheetName = $('#setSheetName').value.trim();
    saveSettings(); data = null; $('#errorBanner').hidden = true;
    await refresh({ manual: true }); openSettings();
  }
  if (act === 'saveGas') {
    settings.gasUrl = $('#setGasUrl').value.trim();
    settings.gasToken = $('#setGasToken').value.trim();
    saveSettings(); toast('保存しました'); sendPending();
  }
  if (act === 'copyGas') {
    try {
      const code = await (await fetch('gas/Code.gs', { cache: 'no-cache' })).text();
      await navigator.clipboard.writeText(code);
      toast('スクリプトをコピーしました');
    } catch { window.open('gas/Code.gs', '_blank'); }
  }
  const open = e.target.closest('[data-open]')?.dataset.open;
  if (open) {
    const [id, j] = open.split(':');
    const f = (docCache?.[id] || [])[+j];
    if (!f) return;
    const url = URL.createObjectURL(f.blob);
    if (f.type?.startsWith('image/')) { $('#docImg').src = url; $('#docViewer').hidden = false; }
    else window.open(url, '_blank');
  }
  const del = e.target.closest('[data-del]')?.dataset.del;
  if (del && confirm('この書類を削除しますか？')) {
    const [id, j] = del.split(':');
    const list = [...(docCache?.[id] || [])];
    list.splice(+j, 1);
    await saveDocs(id, list);
  }
});
$('#docClose').addEventListener('click', () => { $('#docViewer').hidden = true; });
$('#btnOpenSettings2').addEventListener('click', () => openSettings());
applyPrefs();

// ---------- ＋ 記録を追加 (form → app + spreadsheet) ----------
// The new row is shown in the app at once (kept as "pending" on this device) and sent to the
// Apps Script web app (gas/Code.gs), which inserts it into that year's sheet. Once a later refresh
// brings the row back from the sheet, the pending copy is dropped.
const PENDING_KEY = 'carapp.pending.v1';
const CATS = ['給油', '点検・整備', '洗車・清掃', 'タイヤ交換・その他'];
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const digits = (v) => String(v ?? '').replace(/[^0-9.]/g, '');
const rowKey = (header, r) => {
  const g = (h) => r[header.indexOf(h)] ?? '';
  const dm = String(g('日時')).match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  return [dm ? `${+dm[1]}-${+dm[2]}-${+dm[3]}` : g('日時'), g('カテゴリ'), digits(g('料金')), digits(g('距離')), digits(g('給油量'))].join('|');
};
function pending() { return store.get(PENDING_KEY, []); }
function mergePending(table) {
  if (!table?.length) return table;
  const header = table[0];
  const have = new Set(table.slice(1).map((r) => rowKey(header, r)));
  const list = pending();
  const left = list.filter((p) => !have.has(p.key)); // rows the sheet now has are confirmed
  if (left.length !== list.length) store.set(PENDING_KEY, left);
  pendingKeys = new Set(left.map((p) => p.key));
  return left.length ? [header, ...table.slice(1), ...left.map((p) => header.map((h) => p.cells[h] ?? ''))] : table;
}
let pendingKeys = new Set();

function defaultCategory(id) {
  if (id === 'fuel') return '給油';
  if (id === 'body') return '洗車・清掃';
  if (id?.startsWith('tire_')) return 'タイヤ交換・その他';
  return '点検・整備';
}
function suggest(field, filter = () => true) {
  const count = new Map();
  for (const r of data?.rows || []) {
    if (!filter(r)) continue;
    const v = r.cells.find((c) => c.label === field)?.value;
    if (v && !/^[-－]$/.test(v)) count.set(v, (count.get(v) || 0) + 1 + r.idx / 1e4); // frequent and recent first
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v).slice(0, 30);
}
const cellOf = (r, f) => r?.cells.find((c) => c.label === f)?.value || '';

function openAddForm() {
  const back = currentView;
  const cat = defaultCategory(back?.id);
  currentView = { type: 'add', id: 'add', back };
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const st = data?.stats || {};
  const last = (c) => [...(data?.rows || [])].reverse().find((r) => cellOf(r, 'カテゴリ') === c && (!st.car || r.car === st.car));
  const lf = last(cat);
  const dl = (id, list) => `<datalist id="${id}">${list.map((v) => `<option value="${esc(v)}">`).join('')}</datalist>`;
  $('#panelTitle').textContent = '記録を追加';
  $('#panelSub').textContent = 'アプリとスプレッドシートに追加します';
  $('#btnAdd').hidden = true;
  $('#btnSync').hidden = true;
  $('#panelBody').innerHTML = `
    <form id="addForm" class="card add-form" autocomplete="off">
      <div class="row2">
        <label class="field">日付<input type="date" name="date" required value="${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}"></label>
        <label class="field">時間<input type="time" name="time" value="${pad(now.getHours())}:${pad(now.getMinutes())}"></label>
      </div>
      <div class="field">カテゴリ<div class="segs wrap">${CATS.map((c) => `<button type="button" class="seg ${c === cat ? 'on' : ''}" data-cat="${c}">${c}</button>`).join('')}</div></div>
      <input type="hidden" name="カテゴリ" value="${cat}">
      <label class="field">会社名<input name="会社名" list="dlCompany" value="${esc(cellOf(lf, '会社名'))}" placeholder="例：出光"></label>
      <label class="field">店舗名<input name="店舗名" list="dlShop" value="${esc(cellOf(lf, '店舗名'))}" placeholder="例：セルフうずら"></label>
      <div class="fuel-only row3b">
        <label class="field">単価（円/L）<input type="number" inputmode="decimal" step="0.1" name="単価" value="${esc(digits(cellOf(last('給油'), '単価')))}"></label>
        <label class="field">給油量（L）<input type="number" inputmode="decimal" step="0.01" name="給油量" placeholder="20.00"></label>
      </div>
      <label class="field">料金（円）<input type="number" inputmode="numeric" name="料金" placeholder="${cat === '給油' ? '単価×給油量で自動入力' : '例：3800'}"></label>
      <label class="field">距離（km・メーターの数字）<input type="number" inputmode="numeric" name="距離" placeholder="${st.lastOdo ? `前回 ${st.lastOdo.toLocaleString()}` : '例：47500'}"></label>
      <label class="field">担当者<input name="担当者" list="dlStaff" placeholder="-"></label>
      <label class="field">使用車<input name="使用車" list="dlCar" value="${esc(st.car || '')}"></label>
      <label class="field">特記事項<textarea name="特記事項" rows="3" list="dlNote" placeholder="-"></textarea></label>
      <div class="chips-suggest" id="noteSuggest"></div>
      ${dl('dlCompany', suggest('会社名', (r) => cellOf(r, 'カテゴリ') === cat))}
      <datalist id="dlShop"></datalist>
      ${dl('dlStaff', suggest('担当者'))}
      ${dl('dlCar', suggest('使用車'))}
      <div class="row-btns">
        <button type="button" class="btn ghost" data-action="cancelAdd">キャンセル</button>
        <button type="submit" class="btn primary">追加する</button>
      </div>
      ${settings.gasUrl ? '' : '<p class="note">⚠ スプレッドシートへの書き込み先が未設定です（設定 → スプレッドシートへの書き込み）。アプリには追加され、設定後に送信されます。</p>'}
    </form>`;
  const f = $('#addForm');
  const sync = () => {
    const c = f.elements['カテゴリ'].value;
    f.querySelectorAll('.fuel-only').forEach((el) => { el.hidden = c !== '給油'; });
    const company = f.elements['会社名'].value;
    $('#dlShop').innerHTML = suggest('店舗名', (r) => !company || cellOf(r, '会社名') === company).map((v) => `<option value="${esc(v)}">`).join('');
    $('#noteSuggest').innerHTML = suggest('特記事項', (r) => cellOf(r, 'カテゴリ') === c).slice(0, 6)
      .map((v) => `<button type="button" class="chip-s" data-note="${esc(v)}">${esc(v.length > 18 ? `${v.slice(0, 18)}…` : v)}</button>`).join('');
  };
  sync();
  f.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (b) {
      f.elements['カテゴリ'].value = b.dataset.cat;
      f.querySelectorAll('[data-cat]').forEach((x) => x.classList.toggle('on', x === b));
      // the shop you used last time for this category, unless you already typed one
      const lc = last(b.dataset.cat);
      if (!touched.has('会社名')) f.elements['会社名'].value = cellOf(lc, '会社名');
      if (!touched.has('店舗名')) f.elements['店舗名'].value = cellOf(lc, '店舗名');
      $('#dlCompany').innerHTML = suggest('会社名', (r) => cellOf(r, 'カテゴリ') === b.dataset.cat).map((v) => `<option value="${esc(v)}">`).join('');
      sync();
    }
    const n = e.target.closest('[data-note]');
    if (n) f.elements['特記事項'].value = n.dataset.note;
  });
  const touched = new Set();
  f.addEventListener('input', (e) => {
    touched.add(e.target.name);
    if (e.target.name === '会社名') sync();
    if (e.target.name === '単価' || e.target.name === '給油量') {
      const p = +f.elements['単価'].value, l = +f.elements['給油量'].value;
      if (p && l) f.elements['料金'].value = Math.round(p * l);
    }
  });
  f.addEventListener('submit', (e) => { e.preventDefault(); submitRecord(f); });
  showPanel();
}

async function submitRecord(f) {
  const v = (n) => (f.elements[n]?.value ?? '').trim();
  const cat = v('カテゴリ');
  const [y, m, d] = v('date').split('-').map(Number);
  const wd = WD[new Date(y, m - 1, d).getDay()];
  const [hh, mm] = (v('time') || '00:00').split(':');
  const num = (n) => (v(n) === '' ? '' : Number(v(n)));
  const fuel = cat === '給油';
  // values for the sheet (numbers stay numbers so the sheet's formats apply)
  const fields = {
    カテゴリ: cat, 会社名: v('会社名') || '-', 店舗名: v('店舗名') || '-', 時間: `${+hh} : ${mm}`, 担当者: v('担当者') || '-',
    料金: num('料金'), 単価: fuel ? num('単価') : '', 給油量: fuel ? num('給油量') : '', 距離: num('距離'),
    使用車: v('使用車'), 特記事項: v('特記事項') || '-',
  };
  // the same row as the app reads it back from the sheet
  const cells = {
    日時: `${y}年${m}月${d}日  (${wd})`, ...fields,
    料金: fields.料金 === '' ? '' : `¥${fields.料金.toLocaleString()}`,
    単価: fields.単価 === '' ? '' : fields.単価.toFixed(1),
    給油量: fields.給油量 === '' ? '' : fields.給油量.toFixed(2),
    距離: fields.距離 === '' ? '' : `${fields.距離.toLocaleString()}km`,
  };
  const header = lastTable?.[0] || Object.keys(cells);
  const item = { key: rowKey(header, header.map((h) => cells[h] ?? '')), cells, payload: { date: v('date'), fields }, sent: false, at: Date.now() };
  store.set(PENDING_KEY, [...pending(), item]);
  apply(lastTable || [header], 'sheet');
  // back to the list the form was opened from, on the year of the new record
  viewYear = y;
  const back = currentView?.back;
  if (back?.type === 'part') openPart(back.id, back); else openList(back?.type || 'all');
  toast('追加しました');
  sendPending();
}

let sending = false;
// fromSync: called by the ↻ button, which does its own re-read and reporting
async function sendPending({ fromSync = false } = {}) {
  if (sending || !settings.gasUrl) return { ok: 0 };
  const list = pending().filter((p) => !p.sent);
  if (!list.length) return { ok: 0 };
  sending = true;
  let ok = 0, error = '';
  try {
    for (const p of list) {
      const res = await fetch(settings.gasUrl, { method: 'POST', body: JSON.stringify({ token: settings.gasToken, ...p.payload }) });
      const j = await res.json().catch(() => ({}));
      if (!j.ok) throw new Error(j.error || `HTTP ${res.status}`);
      store.set(PENDING_KEY, pending().map((x) => (x.key === p.key ? { ...x, sent: true } : x)));
      ok++;
    }
  } catch (e) {
    error = e.message || String(e);
    showError(`スプレッドシートに書き込めませんでした（${e.message || e}）。アプリには残してあり、あとで自動で再送します。`);
  } finally {
    sending = false;
  }
  if (fromSync) return { ok, error };
  if (ok) { toast(`スプレッドシートに ${ok}件 追加しました`); refresh({ manual: true }); }
  return { ok, error };
}
$('#btnAdd').addEventListener('click', openAddForm);

// ---------- ↻ sync: send pending → re-read the sheet → report whether both sides match ----------
const until = async (cond, ms = 30000) => { for (const t = Date.now(); cond() && Date.now() - t < ms;) await new Promise((r) => setTimeout(r, 100)); };
async function syncNow() {
  const btn = $('#btnSync');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add('spinning');
  btn.setAttribute('aria-busy', 'true');
  let msg;
  try {
    await until(() => sending); // an automatic send may already be running
    const sent = await sendPending({ fromSync: true });
    await until(() => loading); // let a running refresh finish, then read again ourselves
    const r = (await refresh({ manual: true })) || { ok: false, error: '読み込み中のため確認できませんでした' };
    const left = pending();
    const unsent = left.filter((p) => !p.sent).length;
    const waiting = left.length - unsent; // sent, but not in the sheet yet
    const sentMsg = sent.ok ? `${sent.ok}件送信、` : '';
    if (!r.ok) {
      msg = `⚠ シートを読み直せませんでした（${r.error}）${left.length ? `。送信待ち ${left.length}件` : ''}`;
    } else if (r.demo) {
      msg = '⚠ スプレッドシートが未設定です（デモ表示中）。設定 → スプレッドシートを入力してください';
    } else if (!left.length) {
      msg = `✓ ${sentMsg}同期しました（シートと一致）・記録 ${data?.rows?.length ?? 0}件`;
    } else {
      const why = !settings.gasUrl ? '設定 → スプレッドシートへの書き込みが未入力です'
        : unsent ? `送信に失敗しました${sent.error ? `（${sent.error}）` : ''}。通信状態を確認してもう一度お試しください`
        : 'シートへの反映待ちです。少し待ってからもう一度お試しください';
      msg = `⚠ ${sentMsg}送信待ちが${left.length}件残っています${waiting && unsent ? `（未送信${unsent}・反映待ち${waiting}）` : ''}。${why}`;
    }
  } catch (e) {
    msg = `⚠ 同期できませんでした（${e.message || e}）`;
  } finally {
    btn.disabled = false;
    btn.classList.remove('spinning');
    btn.removeAttribute('aria-busy');
  }
  toast(msg, msg.startsWith('✓') ? 4500 : 8000);
}
$('#btnSync').addEventListener('click', syncNow);

// ---------- update notice ----------
// index.html carries the build number stamped at deploy time; version.json always has the latest one.
async function checkUpdate() {
  if (!BUILD || BUILD.startsWith('__')) return; // local copy without a build number
  try {
    const r = await fetch(`version.json?ts=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return;
    const { build } = await r.json();
    $('#updateBanner').hidden = !build || build === BUILD;
  } catch { /* offline */ }
}
$('#updateBanner').addEventListener('click', async () => {
  $('#updateBanner').textContent = '更新しています…';
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations()) || [];
    await Promise.all(regs.map((r) => r.update().catch(() => {})));
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch { /* ignore */ }
  location.reload();
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkUpdate(); });
setInterval(checkUpdate, 10 * 60000);

// ---------- start ----------
refresh();
schedule();
checkUpdate();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
