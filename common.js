'use strict';

// ── Shared DOM/utility helpers used by app.js ─────────────────────────────────
const $ = id => document.getElementById(id);

const show = el => el.classList.remove('hidden');
const hide = el => el.classList.add('hidden');
const esc  = s  => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Reads .xlsx/.xls/.csv into a plain array-of-arrays of trimmed strings.
// Cells come back formatted-as-displayed (raw: false) so ID numbers arrive as
// "322560392" rather than 3.22560392e+8.
function readTable(file) {
  return new Promise((resolve, reject) => {
    // CSV is read as UTF-8 text; SheetJS otherwise guesses CP1252 and mangles Hebrew.
    const isCsv  = /\.csv$/i.test(file.name);
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`לא ניתן לקרוא את הקובץ "${file.name}"`));
    reader.onload  = () => {
      try {
        const wb    = XLSX.read(reader.result, {type: isCsv ? 'string' : 'array', cellDates: true});
        const sheet = wb.Sheets[wb.SheetNames[0]];
        if (!sheet) throw new Error('הקובץ ריק');
        const rows = XLSX.utils.sheet_to_json(sheet, {header: 1, raw: false, defval: ''});
        resolve(rows.map(r => r.map(c => String(c ?? '').trim())));
      } catch (err) {
        reject(new Error(`שגיאה בקריאת "${file.name}": ${err.message}`));
      }
    };
    if (isCsv) reader.readAsText(file, 'UTF-8'); else reader.readAsArrayBuffer(file);
  });
}

function downloadBlob(content, filename, mime) {
  // BOM so Excel reads the Hebrew columns as UTF-8 instead of mojibake.
  const body = mime.startsWith('text/csv') ? '\uFEFF' + content : content;
  const url  = URL.createObjectURL(new Blob([body], {type: mime}));
  Object.assign(document.createElement('a'), {href: url, download: filename}).click();
  URL.revokeObjectURL(url);
}

function spawnConfetti(pieces) {
  for (let i = 0; i < 16; i++) {
    const el  = document.createElement('div');
    el.className = 'confetti-piece';
    el.textContent = pieces[Math.floor(Math.random() * pieces.length)];
    const delay = Math.random() * 0.7;
    const dur   = 1.8 + Math.random() * 1;
    el.style.cssText =
      `left:${3 + Math.random() * 94}vw;` +
      `animation-delay:${delay}s;` +
      `animation-duration:${dur}s;` +
      `font-size:${0.9 + Math.random() * 0.9}rem`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), (delay + dur + 0.2) * 1000);
  }
}
