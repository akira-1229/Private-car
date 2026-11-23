import { CarViewer } from './car.js';
import { PARTS, GENERAL, buildUrl, fetchSheet, fetchBook, interpret, parseCSV, rank, LEVEL_LABEL } from './sheet.js';
import { DEMO_CSV } from './demo.js';

const $ = (s) => document.querySelector(s);
const BUILD = document.querySelector('meta[name="app-build"]')?.content || '';
const SETTINGS_KEY = 'carapp.settings.v1';
const CACHE_KEY = 'carapp.cache.v1';
const DEFAULT_SHEET = 'https://docs.google.com/spreadsheets/d/1-BuCzgFYa1fTVGN5v-L4rzbnQeDGJk0MMLSlXrWCPR0/edit';
const DEFAULTS = {
  sheet: DEFAULT_SHEET, sheetName: '', interval: 5, carName: 'インサイト', bodyColor: '#080c0b',
  plateRegion: '岐阜 303', plateKana: 'の', plateNumber: '55-10', modelUrl: '', modelFlip: false,
  // appearance (設定タブ)
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
if (/[?&]debug\b/.test(location.search)) window.__viewer = viewer;
viewer.onInteract = () => $('#hint').classList.add('hide');
viewer.onPanel = (id, open, label) => {
  toast(`${label}を${open ? '開けました' : '閉めました'}`);
  // opening the hood shows the engine bay records; closing it puts them away again
  if (id === 'hood' && open) { viewer.select('engine'); openPart('engine'); }
  else if (id === 'hood' && currentView?.id === 'engine') closePanel();
};
let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1400);
}

$('#carName').textContent = settings.carName || DEFAULTS.carName;

// ---------- scanned 3D model (kept in IndexedDB on this device) ----------
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

let modelLabel = '';
async function loadModel() {
  let src = null;
  const saved = await idb.get('model');
  if (saved?.blob) { src = await saved.blob.arrayBuffer(); modelLabel = `${saved.name}（${mb(saved.blob.size)}・この端末に保存）`; }
  else if (settings.modelUrl) { src = settings.modelUrl; modelLabel = settings.modelUrl; }
  else {
    // a scan committed to the repository: models/car.json (Gaussian splat + alignment) or models/car.glb
    try {
      const r = await fetch('models/car.json', { cache: 'no-store' });
      if (r.ok) {
        const cfg = await r.json();
        $('#hint').textContent = '実車スキャンを読み込み中…';
        try {
          if (cfg.parts) await viewer.loadSplatParts('models/', cfg);
          else await viewer.loadSplat(`models/${cfg.file}`, cfg.matrix);
          modelLabel = `models/${cfg.file}（実車スキャン）`;
        } catch (e) {
          showError(`実車スキャンを表示できませんでした（${e.message || e}）`);
        } finally {
          $('#hint').textContent = 'ドラッグで回転 ・ タップで記録 ・ ダブルタップでドア開閉';
        }
        return;
      }
      const g = await fetch('models/car.glb', { method: 'HEAD', cache: 'no-store' });
      if (g.ok) { src = 'models/car.glb'; modelLabel = 'models/car.glb（リポジトリ内）'; }
    } catch { /* none */ }
  }
  if (!src) { viewer.clearModel(); modelLabel = ''; return; }
  $('#hint').textContent = '3Dモデルを読み込み中…';
  try {
    await viewer.loadModel(src, { flip: !!settings.modelFlip });
  } catch (e) {
    viewer.clearModel();
    showError(`3Dモデルを読み込めませんでした（${e.message || e}）。.glb 形式か確認してください。`);
    modelLabel = '';
  } finally {
    $('#hint').textContent = 'ドラッグで回転 ・ タップで記録 ・ ダブルタップでドア開閉';
  }
}
const mb = (n) => `${(n / 1048576).toFixed(1)}MB`;

// ---------- data ----------
function apply(table, source) {
  data = interpret(table);
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
    return;
  }
  loading = true;
  $('#titleCard').classList.add('loading');
  try {
    const table = await fetchBook(url, { full: manual });
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
    $('#titleCard').classList.remove('loading');
    setStatus();
  }
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
    ${row.sub ? `<p class="item-sub">${esc(row.sub)}</p>` : ''}
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
  else if (currentView.type === 'settings') return; // a form: don't rebuild under the user's fingers
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
      <label class="row">ボディカラー（標準モデル） <input type="color" data-pref="bodyColor" value="${esc(s.bodyColor)}"></label>
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
    <section class="card"><h3>3Dモデル</h3>
      <p class="note">${esc(modelLabel ? `表示中: ${modelLabel}` : '標準モデルを表示中')}</p>
      <label class="btn file">.glb ファイルを選ぶ<input type="file" id="setModelFile" accept=".glb,model/gltf-binary,application/octet-stream" hidden></label>
      <label class="row">前後を反転 <input type="checkbox" class="switch" data-pref="modelFlip" ${s.modelFlip ? 'checked' : ''}></label>
      <button class="btn ghost" data-action="clearModel">追加したモデルを外す</button>
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
  if (el.id === 'setModelFile' && el.files[0]) {
    const f = el.files[0];
    await idb.set('model', { name: f.name, blob: f }).catch((err) => showError(`保存できませんでした: ${err.message || err}`));
    await loadModel();
    openSettings();
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
  if (k === 'modelFlip') loadModel();
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
  if (act === 'refresh') { await refresh({ manual: true }); openSettings(); }
  if (act === 'saveSheet') {
    settings.sheet = $('#setSheet').value.trim() || DEFAULT_SHEET;
    settings.sheetName = $('#setSheetName').value.trim();
    saveSettings(); data = null; $('#errorBanner').hidden = true;
    await refresh({ manual: true }); openSettings();
  }
  if (act === 'clearModel') {
    await idb.del('model'); settings.modelUrl = ''; saveSettings(); modelLabel = '';
    await loadModel(); openSettings();
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
loadModel();
checkUpdate();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
