// Fetching and interpreting the 自動車点検管理表 spreadsheet.

// ---- Part definitions: which words in the sheet map to which 3D part ----
const TIRE_WORDS = ['タイヤ', 'ホイール', '空気圧', '溝', 'ブレーキ', 'パッド', 'ローテーション', 'スタッドレス', 'ナット', 'ハブ'];
const TIRE_EXCLUDE = ['ブレーキランプ', 'ブレーキライト', 'ブレーキフルード', 'ブレーキオイル', 'ブレーキ液'];

export const PARTS = {
  tire_fl: { label: '左前タイヤ', words: TIRE_WORDS, exclude: TIRE_EXCLUDE, pos: ['左前', '前左', 'フロント左', '左フロント', 'FL'] },
  tire_fr: { label: '右前タイヤ', words: TIRE_WORDS, exclude: TIRE_EXCLUDE, pos: ['右前', '前右', 'フロント右', '右フロント', 'FR'] },
  tire_rl: { label: '左後タイヤ', words: TIRE_WORDS, exclude: TIRE_EXCLUDE, pos: ['左後', '後左', 'リア左', 'リヤ左', '左リア', '左リヤ', 'RL'] },
  tire_rr: { label: '右後タイヤ', words: TIRE_WORDS, exclude: TIRE_EXCLUDE, pos: ['右後', '後右', 'リア右', 'リヤ右', '右リア', '右リヤ', 'RR'] },
  windshield: { label: 'フロントガラス', words: ['フロントガラス', 'ウインドシールド', 'ウィンドシールド', 'フロントウィンドウ', 'フロントウインドウ', '飛び石', 'ワイパー', 'ウォッシャー', 'ウオッシャー', '撥水'] },
  dashcam: { label: 'ドライブレコーダー', words: ['ドラレコ', 'ドライブレコーダー'] },
  rear_window: { label: 'リアガラス', words: ['リアガラス', 'リヤガラス', 'リアウィンドウ', 'リアウインドウ', 'リヤウィンドウ'] },
  side_window: { label: 'サイドガラス・窓', words: ['サイドガラス', 'ドアガラス', 'パワーウィンドウ', 'パワーウインドウ', '窓'] },
  body: { label: 'ボディ', words: ['ボディ', 'ボディー', '塗装', '外装', '洗車', 'コーティング', 'ワックス', 'キズ', '傷', 'へこみ', '凹み', 'ドア', 'バンパー', '車体', 'サビ', '錆', 'マフラー', '下回り'], exclude: ['ドアガラス', 'ドアミラー'] },
  engine: { label: 'エンジンルーム', words: ['エンジン', 'オイル', 'バッテリー', '冷却', 'クーラント', 'LLC', 'ラジエーター', 'ラジエータ', 'ベルト', 'エレメント', 'フィルター', 'プラグ', 'ATF', 'CVT', 'ブレーキフルード', 'ブレーキ液', 'ボンネット', 'ミッション'], exclude: ['シートベルト', 'エアコンフィルター'] },
  headlight: { label: 'ヘッドライト・前方灯火', words: ['ヘッドライト', 'ヘッドランプ', 'フォグ', 'ウインカー', 'ウィンカー', 'スモール', 'ライト', 'ランプ', 'バルブ'] , exclude: ['テールランプ', 'テールライト', 'テール', 'ブレーキランプ', 'ブレーキライト', 'バックランプ', 'リアランプ', 'リヤランプ', 'ナンバー灯', 'ルームランプ'] },
  taillight: { label: 'テールランプ・後方灯火', words: ['テール', 'ブレーキランプ', 'ブレーキライト', 'バックランプ', 'リアランプ', 'リヤランプ', 'ナンバー灯', 'ハザード'] },
  mirror: { label: 'ミラー', words: ['ミラー'] },
  fuel: { label: '給油履歴', words: ['給油', 'ガソリン', '燃料', 'レギュラー', 'ハイオク', '軽油', '燃費'] },
  interior: { label: '車内・装備', words: ['エアコン', '車内', '室内', 'シート', 'ベルト類', 'シートベルト', 'ホーン', 'クラクション', 'ルームランプ', 'ナビ', 'ETC', 'エアバッグ', 'ハンドル', 'メーター', '発炎筒', 'キー', 'スマートキー'] },
};
export const GENERAL = { id: 'general', label: '車両全般（車検・保険など）' };

const HEADER_RX = {
  part: /部位|箇所|場所|パーツ|部品|カテゴリ|分類|区分/,
  item: /項目|内容|点検内容|名称/,
  status: /状態|結果|判定|ステータス|状況|評価/,
  next: /次回|期限|予定|交換時期|満了/,
  last: /前回|実施日|点検日|最終|交換日|実施/,
  note: /備考|メモ|コメント|詳細|特記|事項/,
  date: /日時|日付|年月日|^日$/,
  shop: /会社|店舗|店名|業者|ショップ|場所名/,
  cost: /料金|金額|費用|代金|価格/,
  fuel: /給油量|数量|リットル|リッター|ℓ/,
  odo: /距離|走行|ODO|オドメーター/i,
  car: /使用車|車両|車種/,
};
const EMPTY = /^[-－−ー―]+$/;
const num = (v) => {
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const BAD_WORDS = ['要交換', '不良', 'NG', '×', '✕', '異常', '要修理', '期限切れ', '故障', '交換必要', '危険'];
const WARN_WORDS = ['要注意', '注意', '△', '要点検', 'そろそろ', '近い', '摩耗', '劣化', '要確認', '様子見'];
const OK_WORDS = ['良好', 'OK', '○', '◯', '〇', '正常', '問題なし', '異常なし', '済', '交換済', '完了', 'A'];

// ---------------- Fetching ----------------
export function buildUrl(input, sheetName) {
  const raw = (input || '').trim();
  if (!raw) return null;
  // Already a CSV / JSON endpoint (published CSV, gviz, Apps Script web app, any other URL)
  if (/output=csv|tqx=out:csv|format=csv|script\.google(usercontent)?\.com/.test(raw)) return raw;
  if (/^https?:/.test(raw) && !/docs\.google\.com\/spreadsheets/.test(raw)) return raw;
  const m = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  const id = m ? m[1] : raw;
  const gid = (raw.match(/[#&?]gid=(\d+)/) || [])[1];
  // JSON keeps real date values (with the year) next to the formatted text
  let url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/gviz/tq?tqx=out:json`;
  if (sheetName) url += `&sheet=${encodeURIComponent(sheetName)}`;
  else if (gid) url += `&gid=${gid}`;
  return url;
}

// The 点検管理表 keeps one sheet (tab) per year ("2026", "2025", ...). When the URL points at the whole
// spreadsheet, every year sheet is read and joined oldest -> newest. A year without a sheet makes gviz
// fall back to the first tab, so a sheet only counts when its dates really are in that year.
const BOOK_KEY = 'carapp.book.v1';
export async function fetchBook(url, { full = false } = {}) {
  if (!/\/gviz\/tq/.test(url) || /[?&](sheet|gid)=/.test(url)) return fetchSheet(url);
  let cache = null;
  try { cache = JSON.parse(localStorage.getItem(BOOK_KEY)); } catch { /* none */ }
  if (cache?.url !== url) cache = null;
  const thisYear = new Date().getFullYear();
  const yearSheet = async (y) => {
    const t = await fetchSheet(`${url}&sheet=${y}`);
    const ok = t.slice(1).some((r) => (r[0] || '').startsWith(`${y}年`));
    return ok ? t : null;
  };
  const tables = { ...(cache?.tables || {}) };
  const fresh = cache && !full && Date.now() - cache.at < 24 * 3600e3;
  if (fresh) {
    // routine refresh: only this year and last year can still change
    for (const y of [thisYear + 1, thisYear, thisYear - 1]) {
      const t = await yearSheet(y).catch(() => undefined);
      if (t) tables[y] = t; else if (t === null && y === thisYear + 1) delete tables[y];
    }
  } else {
    // discover the year sheets, newest first, six at a time, until a whole batch is empty
    for (let top = thisYear + 1, found = false; top > thisYear - 60; top -= 6) {
      const ys = Array.from({ length: 6 }, (_, i) => top - i);
      const got = await Promise.all(ys.map((y) => yearSheet(y)));
      got.forEach((t, i) => { if (t) tables[ys[i]] = t; else delete tables[ys[i]]; });
      if (got.some(Boolean)) found = true; else if (found) break;
    }
  }
  const years = Object.keys(tables).map(Number).sort((a, b) => a - b);
  if (!years.length) return fetchSheet(url); // not a per-year workbook
  try { localStorage.setItem(BOOK_KEY, JSON.stringify({ url, at: fresh ? cache.at : Date.now(), tables })); } catch { /* full */ }
  const header = tables[years[years.length - 1]][0];
  return [header, ...years.flatMap((y) => tables[y].slice(1))];
}

export async function fetchSheet(url) {
  const sep = url.includes('?') ? '&' : '?';
  let res;
  try {
    res = await fetch(`${url}${sep}_ts=${Date.now()}`, { cache: 'no-store', redirect: 'follow' });
  } catch {
    throw new Error('スプレッドシートを読み取れませんでした。共有設定を「リンクを知っている全員（閲覧者）」にしてください（電波がない場合も表示されます）。');
  }
  if (!res.ok) throw new Error(`取得に失敗しました（HTTP ${res.status}）`);
  const text = await res.text();
  const trimmed = text.trim();
  if (/^<(!doctype|html)/i.test(trimmed)) {
    throw new Error('シートを読み取れませんでした。共有設定を「リンクを知っている全員」にするか、「ウェブに公開」してください。');
  }
  if (trimmed.startsWith('/*O_o*/') || trimmed.startsWith('google.visualization')) return gvizToTable(trimmed);
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return jsonToTable(JSON.parse(trimmed));
  return parseCSV(text);
}

// Google Visualization (gviz) JSON -> rows of display strings; dates get their year added if the format hides it
export function gvizToTable(text) {
  const json = JSON.parse(text.slice(text.indexOf('(') + 1, text.lastIndexOf(')')));
  if (json.status === 'error') throw new Error('スプレッドシートを読み取れませんでした。共有設定を確認してください。');
  const { cols, rows } = json.table;
  const cell = (c, col) => {
    if (!c || c.v == null) return c?.f ?? '';
    let f = c.f ?? String(c.v);
    if ((col.type === 'date' || col.type === 'datetime') && typeof c.v === 'string') {
      const m = c.v.match(/Date\((\d{4}),(\d+),(\d+)/);
      if (m && !/\d{4}/.test(f)) f = `${m[1]}年${f}`;
    }
    return f;
  };
  const body = rows.map((r) => cols.map((col, i) => cell(r.c[i], col)));
  const header = cols.map((c) => c.label || '');
  return header.some(Boolean) ? [header, ...body] : body;
}

function jsonToTable(json) {
  const data = Array.isArray(json) ? json : json.values || json.rows || json.data || [];
  if (!data.length) return [];
  if (Array.isArray(data[0])) return data.map((r) => r.map((c) => (c == null ? '' : String(c))));
  const headers = [...new Set(data.flatMap((o) => Object.keys(o)))];
  return [headers, ...data.map((o) => headers.map((h) => (o[h] == null ? '' : String(o[h]))))];
}

export function parseCSV(text) {
  text = text.replace(/^\ufeff/, '');
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ---------------- Interpreting ----------------
export function interpret(table, today = new Date()) {
  const clean = table.map((r) => r.map((c) => (c || '').trim()));
  // header row = first row (in the first 10) that looks like a header
  let hi = clean.slice(0, 10).findIndex((r) => r.some((c) => HEADER_RX.part.test(c) || HEADER_RX.item.test(c) || HEADER_RX.status.test(c)));
  if (hi < 0) hi = 0;
  const headers = (clean[hi] || []).map((h, i) => h || `列${i + 1}`);
  const col = {};
  for (const [k, rx] of Object.entries(HEADER_RX)) {
    col[k] = headers.findIndex((h) => rx.test(h));
  }
  // avoid "次回点検日" being taken as "last" and "点検内容" etc.
  if (col.last >= 0 && col.last === col.next) col.last = headers.findIndex((h, i) => i !== col.next && HEADER_RX.last.test(h));

  const rows = [];
  for (const r of clean.slice(hi + 1)) {
    if (!r.some((c) => c)) continue;
    const cells = headers.map((label, i) => ({ label, value: r[i] || '' })).filter((c) => c.value && !EMPTY.test(c.value)).map((c) => ({ ...c, value: c.value.replace(/[ \t]{2,}/g, ' ') }));
    const get = (k) => (col[k] >= 0 ? r[col[k]] || '' : '');
    const all = r.join(' ');
    // parts named in the 部位/カテゴリ, 項目 and 備考/特記事項 columns (or the whole row if none of them exist)
    const fields = ['part', 'item', 'note'].filter((k) => col[k] >= 0).map(get).filter((v) => v && !EMPTY.test(v));
    const parts = col.part >= 0 || col.item >= 0 || col.note >= 0
      ? [...new Set(fields.flatMap((f) => matchParts(f)))]
      : matchParts(all);
    const shop = [col.shop >= 0 ? headers.map((h, i) => (HEADER_RX.shop.test(h) ? r[i] : '')).filter((v) => v && !EMPTY.test(v)).join(' ') : ''][0];
    const title = [get('part'), get('item')].filter(Boolean).join(' / ') || r.find(Boolean) || '(無題)';
    const sub = [get('date').replace(/\s+/g, ' '), shop].filter(Boolean).join(' ・ ');
    const { level, reasons } = evaluate(get('status'), col.status >= 0, all, get('next'), today);
    // year of the record: from the date column, else from any cell that looks like a date
    const ym = (get('date').match(/(\d{4})\s*[年/.-]/) || all.match(/(20\d{2}|19\d{2})\s*[年/.-]\s*\d{1,2}/) || [])[1];
    rows.push({ idx: rows.length, year: ym ? +ym : null, title, sub, cells, level, reasons, parts, next: get('next'), status: get('status'),
      fuel: num(get('fuel')), odo: num(get('odo')), cost: num(get('cost')), car: get('car') });
  }

  // fuel economy between fill-ups (rows are a chronological log)
  const stats = { fills: 0, avgKmL: null, lastOdo: null, firstOdo: null, totalCost: 0, fuelCost: 0 };
  // the log spans several cars (and loan cars): economy is worked out per car, the summary is for the current car
  const isLoan = (car) => /代車/.test(car || '');
  const current = [...rows].reverse().find((r) => r.car && !isLoan(r.car))?.car || null;
  stats.car = current;
  // economy = distance between two fill-ups that both have an odometer reading, divided by all the fuel put in
  // since the earlier one (fill-ups in between often have no odometer entry)
  const st = {};
  let dist = 0, litres = 0;
  for (const row of rows) {
    if (current && row.car && row.car !== current && !isLoan(row.car)) row.sub = [row.sub, row.car].filter(Boolean).join(' ・ ');
    else if (isLoan(row.car)) row.sub = [row.sub, '代車'].filter(Boolean).join(' ・ ');
    const mine = !current || row.car === current;
    if (!mine) row.level = 'none'; // warnings only matter for the car you drive now
    if (mine && row.odo) {
      stats.lastOdo = Math.max(stats.lastOdo || 0, row.odo);
      stats.firstOdo = Math.min(stats.firstOdo ?? Infinity, row.odo);
    }
    if (!row.fuel || isLoan(row.car)) continue;
    if (mine) { stats.fills++; if (row.cost) stats.fuelCost += row.cost; }
    const c = (st[row.car || '-'] ||= { odo: null, litres: 0 });
    c.litres += row.fuel;
    if (!row.odo) continue;
    if (c.odo != null && row.odo > c.odo) {
      const leg = row.odo - c.odo;
      const kmL = leg / c.litres;
      if (kmL > 4 && kmL < 60) {
        row.kmL = kmL;
        row.leg = leg;
        row.legFuel = c.litres;
        row.reasons.unshift(`燃費 ${kmL.toFixed(1)} km/L（前回距離を記録した給油から ${leg.toLocaleString()} km）`);
        if (mine) { dist += leg; litres += c.litres; }
      }
    }
    c.odo = row.odo;
    c.litres = 0;
  }
  for (const row of rows) if (row.cost && (!current || row.car === current)) stats.totalCost += row.cost;
  if (litres > 0) stats.avgKmL = dist / litres;

  const byPart = {};
  const levels = {};
  for (const id of [...Object.keys(PARTS), GENERAL.id]) byPart[id] = [];
  for (const row of rows) {
    const ids = row.parts.length ? row.parts : [GENERAL.id];
    for (const id of ids) byPart[id].push(row);
  }
  for (const [id, list] of Object.entries(byPart)) levels[id] = worst(list.map((r) => r.level));
  return { headers, rows, byPart, levels, stats };
}

function includesAny(text, words) {
  return words.some((w) => text.includes(w));
}

export function matchParts(text) {
  const t = text.normalize('NFKC').replace(/リヤ/g, 'リア');
  const ids = [];
  for (const [id, p] of Object.entries(PARTS)) {
    if (!includesAny(t, p.words)) continue;
    if (p.exclude && includesAny(t, p.exclude) && !includesAny(t.replace(new RegExp([...p.exclude].sort((a, b) => b.length - a.length).join('|'), 'g'), ''), p.words)) continue;
    ids.push(id);
  }
  // tires: narrow down by position words if present
  const tires = ids.filter((id) => id.startsWith('tire_'));
  if (tires.length) {
    const specific = tires.filter((id) => includesAny(t, PARTS[id].pos));
    let keep = specific;
    if (!specific.length) {
      const front = /前|フロント/.test(t), rear = /後|リア/.test(t);
      const left = /左/.test(t), right = /右/.test(t);
      keep = tires.filter((id) => {
        const f = id[5] === 'f', l = id[6] === 'l';
        if ((front && !rear && !f) || (rear && !front && f)) return false;
        if ((left && !right && !l) || (right && !left && l)) return false;
        return true;
      });
    }
    return ids.filter((id) => !id.startsWith('tire_') || keep.includes(id));
  }
  return ids;
}

function evaluate(statusText, hasStatusCol, allText, nextText, today) {
  const reasons = [];
  let level = 'none';
  const s = (hasStatusCol ? statusText : allText).normalize('NFKC');
  const bump = (lv) => { if (rank(lv) > rank(level)) level = lv; };
  if (includesAny(s, BAD_WORDS) || (hasStatusCol && /交換/.test(s) && !/済/.test(s))) bump('bad');
  else if (includesAny(s, WARN_WORDS)) bump('warn');
  else if (hasStatusCol ? includesAny(s, OK_WORDS) : includesAny(s, OK_WORDS.filter((w) => w !== 'A'))) bump('ok');

  const d = parseDate(nextText, today);
  if (d) {
    const days = Math.floor((d - startOfDay(today)) / 86400000);
    if (days < 0) { bump('bad'); reasons.push(`期限を${-days}日過ぎています`); }
    else if (days <= 30) { bump('warn'); reasons.push(days === 0 ? '本日が期限です' : `期限まであと${days}日`); }
    else { if (level === 'none') level = 'ok'; reasons.push(`期限まであと${days}日`); }
  }
  return { level, reasons };
}

export function parseDate(text, today = new Date()) {
  if (!text) return null;
  const t = text.normalize('NFKC');
  let m = t.match(/(\d{4})\s*[\/\-.年]\s*(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = t.match(/(\d{4})\s*[\/\-.年]\s*(\d{1,2})\s*月?/);
  if (m) return new Date(+m[1], +m[2], 0); // end of month
  m = t.match(/^(\d{1,2})\s*[\/月]\s*(\d{1,2})/);
  if (m) {
    let d = new Date(today.getFullYear(), +m[1] - 1, +m[2]);
    return d;
  }
  // gviz may output Date(2026,4,1)
  m = t.match(/Date\((\d{4}),(\d{1,2}),(\d{1,2})/);
  if (m) return new Date(+m[1], +m[2], +m[3]);
  return null;
}

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const rank = (lv) => ({ none: 0, ok: 1, warn: 2, bad: 3 }[lv] ?? 0);
export const worst = (lvs) => lvs.reduce((a, b) => (rank(b) > rank(a) ? b : a), 'none');
export const LEVEL_LABEL = { bad: '要対応', warn: '要注意', ok: '良好', none: '情報' };
