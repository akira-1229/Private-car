import { CarViewer } from './car.js';
import { PARTS, GENERAL, buildUrl, fetchSheet, interpret, parseCSV, rank, LEVEL_LABEL } from './sheet.js';
import { DEMO_CSV } from './demo.js';

const $ = (s) => document.querySelector(s);
const SETTINGS_KEY = 'carapp.settings.v1';
const CACHE_KEY = 'carapp.cache.v1';
const DEFAULT_SHEET = 'https://docs.google.com/spreadsheets/d/1-BuCzgFYa1fTVGN5v-L4rzbnQeDGJk0MMLSlXrWCPR0/edit';
const DEFAULTS = { sheet: DEFAULT_SHEET, sheetName: '', interval: 5, carName: 'インサイト', bodyColor: '#080c0b', plateRegion: '岐阜 303', plateKana: 'の', plateNumber: '55-10', modelUrl: '', modelFlip: false };

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
  renderSummary();
  // feed the garage TV
  const fills = data.rows.filter((r) => r.kmL);
  const date = (r) => (r.sub || '').split(' ・ ')[0].replace(/\s*\(.\)/, '');
  const byKm = [...fills].sort((a, b) => b.kmL - a.kmL);
  const last = fills[fills.length - 1];
  viewer.garage?.userData.setTv?.({
    ...data.stats,
    lastKmL: last?.kmL, lastDate: last && date(last),
    best: byKm[0] && { kmL: byKm[0].kmL, date: date(byKm[0]) },
    worst: byKm.length && { kmL: byKm[byKm.length - 1].kmL, date: date(byKm[byKm.length - 1]) },
    perFill: fills.length ? fills.reduce((s, r) => s + r.leg, 0) / fills.length : null,
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
// leaving the app closes every door / hood / trunk, so it always comes back with the car shut
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') viewer.closeAllPanels(); });
window.addEventListener('pageshow', () => viewer.closeAllPanels());
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
  } else if (data.rows.some((r) => r.level === 'ok')) {
    chips.push(`<button class="chip" data-view="attention"><span class="dot ok"></span>すべて良好</button>`);
  }
  if (data.byPart.general.length) {
    chips.push(`<button class="chip" data-view="general"><span class="dot ${data.levels.general}"></span>車両全般 <b>${data.byPart.general.length}</b></button>`);
  }
  const st = data.stats || {};
  if (st.avgKmL) chips.push(`<button class="chip" data-part="fuel">⛽ 平均燃費 <b>${st.avgKmL.toFixed(1)}</b> km/L</button>`);
  if (st.lastOdo) chips.push(`<button class="chip" data-view="all">🛣️ <b>${st.lastOdo.toLocaleString()}</b> km</button>`);
  chips.push(`<button class="chip" data-view="all">すべての記録 <b>${data.rows.length}</b></button>`);
  // AirTag: Apple offers no API for Find My, so open the 探す app's 持ち物 tab directly
  chips.push(`<a class="chip" href="findmy://items">📍 車の現在地（探す）</a>`);
  nav.innerHTML = chips.join('');
}
$('#summary').addEventListener('click', (e) => {
  const p = e.target.closest('[data-part]');
  if (p) { viewer.select(p.dataset.part); openPart(p.dataset.part); return; }
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
  const yearKmL = legs.length ? legs.reduce((s, r) => s + r.leg, 0) / legs.reduce((s, r) => s + r.fuel, 0) : null;
  const facts = [`${list.length}件`];
  if (fuel) facts.push(`給油 ${list.filter((r) => r.fuel).length}回`);
  if (cost) facts.push(`合計 ¥${Math.round(cost).toLocaleString()}`);
  if (fuel && yearKmL) facts.push(`平均 ${yearKmL.toFixed(1)} km/L`);
  const dots = years.length > 1
    ? `<div class="yr-dots">${[...years].reverse().map((y) => `<span class="${y === viewYear ? 'on' : ''}"></span>`).join('')}</div>` : '';
  const bar = `<div class="year-bar">
      <button class="yr-btn" data-year="${older ?? ''}" ${older === undefined ? 'disabled' : ''} aria-label="前の年">‹</button>
      <div class="yr-label"><b>${label}</b><small>${facts.join(' ・ ')}</small>${dots}</div>
      <button class="yr-btn" data-year="${newer ?? ''}" ${newer === undefined ? 'disabled' : ''} aria-label="次の年">›</button>
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

function openPart(id) {
  currentView = { type: 'part', id };
  const rows = data?.byPart[id] || [];
  const lv = data?.levels[id] || 'none';
  $('#panelTitle').textContent = PARTS[id]?.label || id;
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
  if (currentView.type === 'part') openPart(currentView.id);
  else openList(currentView.type);
}

$('#panelBody').addEventListener('click', (e) => {
  const yb = e.target.closest('.yr-btn');
  if (yb && !yb.disabled) { changeYear(yb.getAttribute('aria-label') === '前の年' ? 1 : -1); return; }
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

// swipe left / right on the records to change the year
(() => {
  let sx = null, sy = 0;
  const body = $('#panelBody');
  body.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  body.addEventListener('touchend', (e) => {
    if (sx == null) return;
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    sx = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) changeYear(dx > 0 ? 1 : -1); // swipe right = older year
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

// ---------- settings ----------
const dlg = $('#settings');
const form = $('#settingsForm');
function openSettings() {
  for (const [k, v] of Object.entries(settings)) {
    const el = form.elements[k];
    if (!el || el.type === 'file') continue;
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
  }
  form.elements.modelFile.value = '';
  $('#modelInfo').textContent = modelLabel ? `表示中: ${modelLabel}` : '未設定（標準モデルを表示中）';
  dlg.showModal();
}
$('#btnSettings').addEventListener('click', openSettings);
$('#btnOpenSettings2').addEventListener('click', openSettings);
dlg.addEventListener('close', () => {
  if (dlg.returnValue !== 'save') return;
  const fd = new FormData(form);
  const file = form.elements.modelFile.files[0];
  fd.delete('modelFile');
  const prevModel = `${settings.modelUrl}|${settings.modelFlip}`;
  settings = { ...settings, ...Object.fromEntries(fd.entries()) };
  settings.modelFlip = form.elements.modelFlip.checked;
  settings.interval = +settings.interval || 5;
  store.set(SETTINGS_KEY, settings);
  $('#carName').textContent = settings.carName || DEFAULTS.carName;
  viewer.setBodyColor(settings.bodyColor);
  viewer.setPlate(plateOf(settings));
  if (file) idb.set('model', { name: file.name, blob: file }).then(loadModel).catch((e) => showError(`保存できませんでした: ${e.message || e}`));
  else if (prevModel !== `${settings.modelUrl}|${settings.modelFlip}`) loadModel();
  data = null;
  $('#errorBanner').hidden = true;
  schedule();
  refresh({ manual: true });
});

form.elements.modelFile.addEventListener('change', () => {
  const f = form.elements.modelFile.files[0];
  if (f) $('#modelInfo').textContent = `選択中: ${f.name}（${mb(f.size)}）→「保存して読み込み」で反映`;
});
$('#btnClearModel').addEventListener('click', async () => {
  await idb.del('model');
  settings.modelUrl = '';
  form.elements.modelUrl.value = '';
  store.set(SETTINGS_KEY, settings);
  modelLabel = '';
  viewer.clearModel();
  $('#modelInfo').textContent = '未設定（標準モデルを表示中）';
});

$('#btnRefresh').addEventListener('click', () => refresh({ manual: true }));

// ---------- update notice ----------
// index.html carries the build number stamped at deploy time; version.json always has the latest one.
const BUILD = document.querySelector('meta[name="app-build"]')?.content || '';
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
