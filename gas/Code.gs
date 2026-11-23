/**
 * マイカー点検アプリ → 点検管理表 への書き込み口（Google Apps Script）
 *
 * 使い方
 *  1. 点検管理表を開き「拡張機能」→「Apps Script」
 *  2. このファイルの中身をすべて貼り付け、下の TOKEN を好きな合言葉に変えて保存
 *  3. 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *       次のユーザーとして実行：自分 ／ アクセスできるユーザー：全員
 *  4. 表示された「ウェブアプリの URL」と合言葉を、アプリの 設定 → スプレッドシートへの書き込み に入れる
 *
 * アプリから {token, date:'2026-11-23', fields:{カテゴリ, 会社名, …}} が届くと、
 * その年のシート（なければ一番新しい年のシートをひな形に作成）の日付順の位置に1行追加します。
 */
const TOKEN = 'ここを合言葉に変える';

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    if (req.token !== TOKEN) return json({ ok: false, error: '合言葉が違います' });
    const [y, m, d] = String(req.date).split('-').map(Number);
    const date = new Date(y, m - 1, d);
    const sheet = yearSheet(String(y));
    const width = sheet.getLastColumn();
    const headers = sheet.getRange(1, 1, 1, width).getDisplayValues()[0];
    const row = headers.map((h) => (h === '日時' ? date : (req.fields && h in req.fields ? req.fields[h] : '')));

    // keep the sheet in date order: insert before the first row that is later than the new date
    const last = sheet.getLastRow();
    let at = last + 1;
    if (last > 1) {
      const dates = sheet.getRange(2, 1, last - 1, 1).getValues();
      for (let i = dates.length - 1; i >= 0; i--) {
        const v = dates[i][0];
        if (v instanceof Date && v.getTime() <= date.getTime()) { at = i + 3; break; }
        if (i === 0) at = 2;
      }
    }
    if (at <= last) sheet.insertRowBefore(at);
    const target = sheet.getRange(at, 1, 1, width);
    const model = at > 2 ? at - 1 : (at + 1 <= sheet.getLastRow() ? at + 1 : 0);
    if (model) sheet.getRange(model, 1, 1, width).copyTo(target, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    target.setValues([row]);
    return json({ ok: true, sheet: sheet.getName(), row: at });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

// the sheet for a year; a new year copies the newest year sheet (header and formats) and clears its rows
function yearSheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (sh) return sh;
  const years = ss.getSheets().filter((s) => /^\d{4}$/.test(s.getName())).sort((a, b) => b.getName() - a.getName());
  sh = years[0].copyTo(ss).setName(name);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).clearContent();
  ss.setActiveSheet(sh);
  ss.moveActiveSheet(1);
  return sh;
}

function doGet() {
  return json({ ok: true, message: 'マイカー点検アプリの書き込み口です' });
}

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
