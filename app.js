'use strict';

// ── Constants ──────────────────────────────────────────────────────────────────
// Preference tiers. Costs are derived at solve time from the student count so the
// objective is strictly lexicographic: first maximise primary placements, only
// then maximise secondary ones. See buildCostMatrix().
const TIER_PRIMARY   = 0;
const TIER_SECONDARY = 1;
const TIER_NONE      = 2;

const LEVEL_LABELS = {
  [TIER_PRIMARY]:   'עדיפות ראשונה',
  [TIER_SECONDARY]: 'עדיפות שניה',
  [TIER_NONE]:      'שיבוץ אקראי',
};

// ── Min-Cost Flow (SPFA Successive Shortest Paths) ────────────────────────────
// Forward edges are at even indices; their reverse is always index ^ 1.
class MCFGraph {
  constructor(n) {
    this.n     = n;
    this.adj   = Array.from({length: n}, () => []);
    this.edges = [];
  }

  addEdge(u, v, cap, cost) {
    const id = this.edges.length;
    this.edges.push({to: v, cap, cost, flow: 0});
    this.adj[u].push(id);
    this.edges.push({to: u, cap: 0, cost: -cost, flow: 0});
    this.adj[v].push(id + 1);
    return id;
  }

  // SPFA — handles negative residual edges correctly.
  _spfa(s, t) {
    const INF   = 1e15;
    const dist  = new Array(this.n).fill(INF);
    const inQ   = new Uint8Array(this.n);
    const prev  = new Int32Array(this.n).fill(-1);
    const prevE = new Int32Array(this.n).fill(-1);
    dist[s] = 0;
    const q  = [s];
    inQ[s]   = 1;
    let head = 0;
    while (head < q.length) {
      const u = q[head++];
      inQ[u]  = 0;
      for (const eid of this.adj[u]) {
        const e = this.edges[eid];
        if (e.cap > e.flow && dist[u] + e.cost < dist[e.to] - 1e-9) {
          dist[e.to]  = dist[u] + e.cost;
          prev[e.to]  = u;
          prevE[e.to] = eid;
          if (!inQ[e.to]) { q.push(e.to); inQ[e.to] = 1; }
        }
      }
    }
    return dist[t] < INF ? {dist, prev, prevE} : null;
  }

  // Pushes up to maxFlow units from s to t at minimum cost.
  minCostFlow(s, t, maxFlow) {
    let totalFlow = 0, totalCost = 0;
    while (totalFlow < maxFlow) {
      const sp = this._spfa(s, t);
      if (!sp) break;
      let push = maxFlow - totalFlow;
      let v = t;
      while (v !== s) { push = Math.min(push, this.edges[sp.prevE[v]].cap - this.edges[sp.prevE[v]].flow); v = sp.prev[v]; }
      v = t;
      while (v !== s) { const eid = sp.prevE[v]; this.edges[eid].flow += push; this.edges[eid ^ 1].flow -= push; v = sp.prev[v]; }
      totalFlow += push;
      totalCost += push * sp.dist[t];
    }
    return {flow: totalFlow, cost: totalCost};
  }
}

// ── State ──────────────────────────────────────────────────────────────────────
const rawFiles = {students: null, projects: null, prefs: null};  // array-of-arrays per file

const state = {
  students:  [],         // [{id, name}]
  projects:  [],         // [{name, capacity, lecturer}]
  prefs:     new Map(),  // id → {primary: string[], secondary: string[]}
  aliases:   new Map(),  // normalised form-text → project name (teacher-confirmed)
  ignored:   new Set(),  // normalised form-text the teacher chose to leave unmatched
  unmatched: [],         // [{text, count, suggestions: [{project, score}]}]
  warnings:  [],
  results:   [],         // [{id, name, project, lecturer, tier}]
  revealMode: false,
};

// ── DOM refs ───────────────────────────────────────────────────────────────────
const studentsInput    = $('students-input');
const projectsFileIn   = $('projects-input');
const prefsInput       = $('prefs-input');
const studentsFileName = $('students-file-name');
const projectsFileName = $('projects-file-name');
const prefsFileName    = $('prefs-file-name');
const previewSection   = $('preview-section');
const configSection    = $('config-section');
const resultsSection   = $('results-section');
const validationErrors = $('validation-errors');
const previewTableCont = $('preview-table-container');
const unmatchedBox     = $('unmatched-box');
const unmatchedList    = $('unmatched-list');
const capSummary       = $('cap-summary');
const capacityWarning  = $('capacity-warning');
const runBtn           = $('run-btn');
const resultsCont      = $('results-container');
const downloadXlsxBtn  = $('download-xlsx-btn');
const downloadCsvBtn   = $('download-csv-btn');
const resetBtn         = $('reset-btn');

const CONFETTI_PIECES = ['🎉', '✨', '⭐', '💫', '🌟', '🎊', '🔬', '🧪', '🕊️'];

// ── Text normalisation ─────────────────────────────────────────────────────────
// Project names arrive from two different sources (the projects sheet and the
// Google Form) that differ in punctuation and stray spaces, so everything is
// compared through this filter rather than by raw equality.
function norm(s) {
  return String(s)
    .replace(/[֑-ׇ]/g, '')                  // nikud / cantillation
    .replace(/[־‐-―]/g, '-')           // maqaf & unicode dashes → '-'
    .replace(/[.,;:!?"'‘’“”]/g, ' ')
    .replace(/\s*-\s*/g, '-')                         // "ה- 16" ≡ "ה-16"
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Israeli IDs may carry a leading zero, so they stay strings throughout.
function normId(s) {
  const t = String(s).replace(/[\s'"\-]/g, '');
  const m = /^(\d+(?:\.\d+)?)e\+?(\d+)$/i.exec(t);   // guard against 3.2256e+8
  return m ? Number(t).toFixed(0) : t;
}

// IDs are never shown in full on screen — only in the downloaded file. Warnings
// about rows that have no name to show quote the last four digits instead.
const maskId = id => String(id).length > 4 ? `…${String(id).slice(-4)}` : String(id);

const tokensOf = s => norm(s).split(' ').filter(Boolean);

// ── Suggestion scoring (IDF-weighted cosine over tokens) ───────────────────────
// Plain string similarity is not safe here: it ranks
// "המאה ה-16, השליש האחרון. אליזבת הראשונה" closest to the 18th-century Marie
// Antoinette period, because the shared middle phrase outweighs everything else.
// Weighting tokens by rarity makes the distinctive words ("אליזבת") dominate.
function buildScorer(projectNames) {
  const df = new Map();
  projectNames.forEach(p => new Set(tokensOf(p)).forEach(t => df.set(t, (df.get(t) || 0) + 1)));
  const N   = projectNames.length;
  const idf = t => Math.log((N + 1) / ((df.get(t) || 0) + 1)) + 1;

  const vec = s => {
    const v = new Map();
    tokensOf(s).forEach(t => v.set(t, (v.get(t) || 0) + 1));
    return v;
  };
  const weight = v => Math.sqrt([...v].reduce((a, [t, c]) => a + idf(t) * c, 0));

  return (a, b) => {
    const va = vec(a), vb = vec(b);
    let inter = 0;
    va.forEach((c, t) => { if (vb.has(t)) inter += idf(t) * Math.min(c, vb.get(t)); });
    const d = weight(va) * weight(vb);
    return d ? inter / d : 0;
  };
}

// ── Column detection ───────────────────────────────────────────────────────────
// Files are hand-maintained, so columns are located by header text rather than
// by a fixed position.
// A pattern is either a substring (matched anywhere, for prefixes such as
// 'ראשונ') or a RegExp, used where a bare substring would over-match.
const hitRank = (cell, pats) => {
  const n = norm(cell);
  return n === '' ? -1 : pats.findIndex(p => p instanceof RegExp ? p.test(n) : n.includes(p));
};

const matchesAny = (cell, pats) => hitRank(cell, pats) !== -1;

function findHeaderRow(rows, patternGroups) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const hit = patternGroups.every(pats => rows[i].some(c => matchesAny(c, pats)));
    if (hit) return i;
  }
  return -1;
}

// Patterns are listed most-specific-first, and the column matching the most
// specific pattern wins. Picking the first matching column instead would tie
// "תעודת זהות" with the Google-Forms "חותמת זמן" timestamp, which also contains
// the loose "ת.ז" pattern.
function findCol(header, pats) {
  let best = -1, bestRank = Infinity;
  header.forEach((c, i) => {
    const rank = hitRank(c, pats);
    if (rank !== -1 && rank < bestRank) { bestRank = rank; best = i; }
  });
  return best;
}

const findCols = (header, pats) => header.map((c, i) => matchesAny(c, pats) ? i : -1).filter(i => i >= 0);

const COLS = {
  id:        ['תעודת זהות', 'תעודת-זהות', 'מספר זהות', 'מס זהות', /(^| )ת[- ]?ז( |$)/, /(^| )id( |$)/],
  name:      ['שם'],
  project:   ['תקופה', 'פרויקט', 'פרוייקט'],
  capacity:  ['כמות', 'קיבולת', 'מקומות', 'מספר סטודנטים'],
  lecturer:  ['מרצה', 'מנחה'],
  primary:   ['ראשונ'],
  secondary: ['שני'],
};

// ── Source-file parsing ────────────────────────────────────────────────────────
function parseStudents(rows) {
  const h = findHeaderRow(rows, [COLS.id, COLS.name]);
  if (h === -1) throw new Error('בקובץ הסטודנטים לא נמצאו עמודות "שם" ו-"תעודת זהות".');
  const header = rows[h];
  const idC    = findCol(header, COLS.id);
  const nameC  = header.findIndex((c, i) => i !== idC && matchesAny(c, COLS.name));
  if (nameC === -1) throw new Error('בקובץ הסטודנטים לא נמצאה עמודת "שם".');

  const out = [], seen = new Set();
  rows.slice(h + 1).forEach(r => {
    const id = normId(r[idC] || ''), name = (r[nameC] || '').trim();
    if (!id && !name) return;
    if (!id)        { state.warnings.push(`הסטודנט/ית "${name}" ללא תעודת זהות — השורה דולגה`); return; }
    if (seen.has(id)) { state.warnings.push(`תעודת זהות כפולה ברשימת הסטודנטים: ${id} — השורה דולגה`); return; }
    seen.add(id);
    out.push({id, name: name || id});
  });
  if (!out.length) throw new Error('לא נמצאו סטודנטים בקובץ.');
  return out;
}

function parseProjects(rows) {
  const h = findHeaderRow(rows, [COLS.project, COLS.capacity]);
  if (h === -1) throw new Error('בקובץ התקופות לא נמצאו עמודות "תקופה" ו-"כמות סטודנטים".');
  const header = rows[h];
  const nameC  = findCol(header, COLS.project);
  const capC   = findCol(header, COLS.capacity);
  const lecC   = findCol(header, COLS.lecturer);

  const out = [], seen = new Set();
  rows.slice(h + 1).forEach(r => {
    const name = (r[nameC] || '').trim();
    if (!name) return;
    const key = norm(name);
    if (seen.has(key)) { state.warnings.push(`תקופה כפולה בקובץ התקופות: "${name}" — השורה דולגה`); return; }
    seen.add(key);
    const capacity = Math.max(0, Math.round(Number(String(r[capC] ?? '').replace(/[^\d.]/g, '')) || 0));
    if (!capacity) state.warnings.push(`לתקופה "${name}" לא הוגדרה כמות סטודנטים — לא ישובצו אליה סטודנטים`);
    out.push({name, capacity, lecturer: lecC >= 0 ? (r[lecC] || '').trim() : ''});
  });
  if (!out.length) throw new Error('לא נמצאו תקופות בקובץ.');
  return out;
}

// Splits one Google-Forms cell that joined several period names with ", " —
// which cannot be split on the comma, because the names contain commas
// themselves. Longest names are matched first so a short name can never be
// consumed out of the middle of a longer one.
function splitChoices(cell, patterns) {
  let rest = norm(cell);
  if (!rest) return {found: [], leftovers: []};
  const found = [];
  for (const p of patterns) {
    const i = rest.indexOf(p.key);
    if (i === -1) continue;
    found.push(p.project);
    rest = `${rest.slice(0, i)}|${rest.slice(i + p.key.length)}`;
  }
  const leftovers = rest.split('|')
    .map(s => s.replace(/^[\s,.|]+|[\s,.|]+$/g, ''))
    .filter(Boolean);
  return {found, leftovers};
}

function parsePrefs(rows, patterns) {
  const h = findHeaderRow(rows, [COLS.id, COLS.primary]);
  if (h === -1) throw new Error('בקובץ ההעדפות לא נמצאו עמודות "תעודת זהות" ו-"עדיפות ראשונה".');
  const header = rows[h];
  const idC    = findCol(header, COLS.id);
  const priC   = findCol(header, COLS.primary);
  // The form was edited mid-collection, so there can be more than one
  // "second priority" column; responses live in whichever one is filled.
  const secCs  = findCols(header, COLS.secondary).filter(i => i !== priC && i !== idC);

  const prefs = new Map(), leftovers = [];
  rows.slice(h + 1).forEach(r => {
    const id = normId(r[idC] || '');
    if (!id) return;

    const pr = splitChoices(r[priC] || '', patterns);
    const se = {found: [], leftovers: []};
    secCs.forEach(c => {
      const part = splitChoices(r[c] || '', patterns);
      se.found.push(...part.found);
      se.leftovers.push(...part.leftovers);
    });
    leftovers.push(...pr.leftovers, ...se.leftovers);

    const primary = [...new Set(pr.found)];
    // A period named in both tiers counts as primary — the better of the two.
    const secondary = [...new Set(se.found)].filter(p => !primary.includes(p));

    if (prefs.has(id)) state.warnings.push(`ת.ז ${maskId(id)} הגישה את הטופס יותר מפעם אחת — נלקחה ההגשה האחרונה`);
    prefs.set(id, {primary, secondary});
  });

  return {prefs, leftovers};
}

// ── Build everything from the three loaded files ───────────────────────────────
function rebuild(scroll = true) {
  if (!rawFiles.students || !rawFiles.projects || !rawFiles.prefs) return;

  state.warnings = [];
  try {
    state.students = parseStudents(rawFiles.students);
    state.projects = parseProjects(rawFiles.projects);
  } catch (err) {
    showFatalError(err.message);
    return;
  }

  // Matchable patterns: real project names plus any teacher-confirmed aliases.
  const patterns = [
    ...state.projects.map(p => ({key: norm(p.name), project: p.name})),
    ...[...state.aliases].map(([key, project]) => ({key, project})),
  ].filter(p => p.key).sort((a, b) => b.key.length - a.key.length);

  let parsed;
  try {
    parsed = parsePrefs(rawFiles.prefs, patterns);
  } catch (err) {
    showFatalError(err.message);
    return;
  }
  state.prefs = parsed.prefs;

  // Cross-file checks.
  const known = new Set(state.students.map(s => s.id));
  [...state.prefs.keys()].filter(id => !known.has(id)).forEach(id => {
    state.warnings.push(`ת.ז ${maskId(id)} מופיעה בקובץ ההעדפות אך לא ברשימת הסטודנטים — ההעדפות שלה לא ישמשו בשיבוץ`);
  });

  const noPrefs = state.students.filter(s => {
    const p = state.prefs.get(s.id);
    return !p || (!p.primary.length && !p.secondary.length);
  });
  if (noPrefs.length) {
    state.warnings.push(noPrefs.length === 1
      ? `סטודנט/ית אחד/ת לא הגיש/ה העדפות (${noPrefs[0].name}) — ישובץ/תשובץ אקראית`
      : `${noPrefs.length} סטודנטים לא הגישו העדפות — ישובצו אקראית`);
  }

  const shortPrimary = state.students.filter(s => {
    const p = state.prefs.get(s.id);
    return p && p.primary.length > 0 && p.primary.length < 3;
  }).length;
  if (shortPrimary) state.warnings.push(`${shortPrimary} סטודנטים ציינו פחות מ-3 תקופות בעדיפות הראשונה`);

  buildUnmatched(parsed.leftovers);

  renderValidation();
  renderPreview();
  renderUnmatched();
  updateCapSummary();
  show(previewSection);
  show(configSection);
  if (scroll) previewSection.scrollIntoView({behavior: 'smooth'});
}

function buildUnmatched(leftovers) {
  const score  = buildScorer(state.projects.map(p => p.name));
  const counts = new Map();
  leftovers.forEach(t => counts.set(t, (counts.get(t) || 0) + 1));

  state.unmatched = [...counts].map(([text, count]) => ({
    text, count,
    suggestions: state.projects
      .map(p => ({project: p.name, score: score(text, p.name)}))
      .sort((a, b) => b.score - a.score),
  })).sort((a, b) => b.count - a.count);
}

// ── File inputs ────────────────────────────────────────────────────────────────
function wireFileInput(input, label, key) {
  input.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    label.textContent = file.name;
    hide(resultsSection);
    state.results = [];
    try {
      rawFiles[key] = await readTable(file);
      // A new source file invalidates aliases confirmed against the old one.
      if (key !== 'prefs') state.aliases.clear();
      rebuild();
    } catch (err) {
      showFatalError(err.message);
    }
  });
}

wireFileInput(studentsInput,  studentsFileName, 'students');
wireFileInput(projectsFileIn, projectsFileName, 'projects');
wireFileInput(prefsInput,     prefsFileName,    'prefs');

// ── Validation + preview rendering ─────────────────────────────────────────────
function renderValidation() {
  validationErrors.innerHTML = state.warnings.length
    ? `<div class="warning-box"><strong>אזהרות (${state.warnings.length}):</strong><ul>${
        state.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>`
    : '';
}

function renderPreview() {
  const capacity = state.projects.reduce((a, p) => a + p.capacity, 0);

  const projRows = state.projects.map(p => `<tr>
      <td>${esc(p.name)}</td>
      <td>${p.capacity}</td>
      <td>${esc(p.lecturer)}</td>
    </tr>`).join('');

  const studRows = state.students.map(s => {
    const p = state.prefs.get(s.id) || {primary: [], secondary: []};
    return `<tr>
      <td>${esc(s.name)}</td>
      <td>${p.primary.length ? p.primary.map(esc).join('<br>') : '<span class="dash">—</span>'}</td>
      <td>${p.secondary.length ? p.secondary.map(esc).join('<br>') : '<span class="dash">—</span>'}</td>
    </tr>`;
  }).join('');

  previewTableCont.innerHTML = `
    <p class="meta">
      <strong>${state.students.length}</strong> סטודנטים &bull;
      <strong>${state.projects.length}</strong> תקופות &bull;
      <strong>${capacity}</strong> מקומות בסך הכול
    </p>
    <h3 class="preview-heading">תקופות</h3>
    <div class="table-scroll">
      <table class="data-table">
        <thead><tr><th>תקופה</th><th>כמות סטודנטים</th><th>מרצה</th></tr></thead>
        <tbody>${projRows}</tbody>
      </table>
    </div>
    <h3 class="preview-heading">סטודנטים והעדפותיהם</h3>
    <div class="table-scroll">
      <table class="data-table">
        <thead><tr><th>שם</th><th>עדיפות ראשונה</th><th>עדיפות שניה</th></tr></thead>
        <tbody>${studRows}</tbody>
      </table>
    </div>`;
}

// ── Unmatched-choice confirmation ──────────────────────────────────────────────
function renderUnmatched() {
  if (!state.unmatched.length) { hide(unmatchedBox); return; }

  unmatchedList.innerHTML = state.unmatched.map((u, i) => {
    const skip = state.ignored.has(norm(u.text));
    const opts = u.suggestions.map((s, k) =>
      `<option value="${esc(s.project)}"${k === 0 && !skip ? ' selected' : ''}>${esc(s.project)}</option>`).join('');
    return `
      <div class="match-row">
        <div class="match-text">
          <span class="match-quote">${esc(u.text)}</span>
          <span class="col-hint">${u.count === 1 ? 'בחירה אחת' : `${u.count} בחירות`}</span>
        </div>
        <select class="match-select" data-idx="${i}">
          ${opts}
          <option value=""${skip ? ' selected' : ''}>— התעלמות מבחירה זו —</option>
        </select>
      </div>`;
  }).join('');
  show(unmatchedBox);
}

// Reads the dropdowns into state and re-parses. Called when the assignment runs,
// so a pre-selected suggestion the teacher is happy with needs no extra click.
function applyMatchSelections() {
  const selects = unmatchedList.querySelectorAll('.match-select');
  if (!selects.length) return;
  state.ignored.clear();
  selects.forEach(sel => {
    const key = norm(state.unmatched[Number(sel.dataset.idx)].text);
    if (sel.value) state.aliases.set(key, sel.value);
    else           state.ignored.add(key);
  });
  rebuild(false);
}

// ── Capacity summary ───────────────────────────────────────────────────────────
function updateCapSummary() {
  const n        = state.students.length;
  const capacity = state.projects.reduce((a, p) => a + p.capacity, 0);

  capSummary.innerHTML =
    `<strong>${capacity} מקומות</strong> ב-${state.projects.length} תקופות עבור <strong>${n} סטודנטים</strong>` +
    (capacity > n ? ` &bull; ${capacity - n} מקומות יישארו פנויים` : '');

  if (capacity < n) {
    capacityWarning.textContent =
      `⚠ סך המקומות (${capacity}) קטן ממספר הסטודנטים (${n}) — עדכנו את עמודת "כמות סטודנטים" בקובץ התקופות`;
    show(capacityWarning);
  } else if (state.ignored.size) {
    capacityWarning.textContent =
      `⚠ ${state.ignored.size === 1 ? 'בחירה אחת סומנה' : `${state.ignored.size} בחירות סומנו`} כ"התעלמות" ולא ייחשבו כהעדפה בשיבוץ`;
    show(capacityWarning);
  } else {
    hide(capacityWarning);
  }
}

// ── Run button ─────────────────────────────────────────────────────────────────
runBtn.addEventListener('click', () => {
  applyMatchSelections();

  const n        = state.students.length;
  const capacity = state.projects.reduce((a, p) => a + p.capacity, 0);

  if (!n)                 { alert('לא נטענו סטודנטים.'); return; }
  if (!state.projects.length) { alert('לא נטענו תקופות.'); return; }
  if (capacity < n) {
    alert(`לא ניתן לשבץ את כל ${n} הסטודנטים: סך המקומות בקובץ התקופות הוא ${capacity} בלבד.`);
    return;
  }
  if (state.unmatched.length &&
      !confirm(`${state.unmatched.length === 1 ? 'בחירה אחת נותרה' : `${state.unmatched.length} בחירות נותרו`} ללא התאמה ולא ייחשבו כהעדפה.\n\nלהמשיך בכל זאת?`)) return;

  runBtn.disabled  = true;
  runBtn.innerHTML = '<span class="btn-spinner"></span> מחשב את השיבוץ…';
  runBtn.classList.add('btn-running');

  setTimeout(() => {
    try {
      state.results        = solve();
      state.revealMode     = true;
      renderResults();
      show(resultsSection);
      resultsSection.scrollIntoView({behavior: 'smooth'});
      setTimeout(() => spawnConfetti(CONFETTI_PIECES), 450);
    } catch (err) {
      alert(`השיבוץ נכשל: ${err.message}`);
    } finally {
      runBtn.disabled  = false;
      runBtn.innerHTML = '🔬 הרצת השיבוץ';
      runBtn.classList.remove('btn-running');
      state.revealMode = false;
    }
  }, 30);
});

// ── Solver ─────────────────────────────────────────────────────────────────────
function tierOf(studentId, projectName) {
  const p = state.prefs.get(studentId);
  if (!p) return TIER_NONE;
  if (p.primary.includes(projectName))   return TIER_PRIMARY;
  if (p.secondary.includes(projectName)) return TIER_SECONDARY;
  return TIER_NONE;
}

// Tier costs 0 / A / A+1 with A = n+1 make the objective lexicographic: giving up
// one primary placement costs A, which exceeds the largest possible saving from
// every other student combined (at most n). The sub-unit jitter only breaks ties,
// so that the three unordered choices inside a tier — and the leftover places for
// students with no matching choice — are handed out at random rather than always
// favouring whichever period appears first in the file.
function buildCostMatrix() {
  const n      = state.students.length;
  const A      = n + 1;
  const TIER   = {[TIER_PRIMARY]: 0, [TIER_SECONDARY]: A, [TIER_NONE]: A + 1};
  const jitter = () => Math.random() / (2 * n + 2);
  return state.students.map(s =>
    state.projects.map(p => TIER[tierOf(s.id, p.name)] + jitter()));
}

function solve() {
  const n    = state.students.length;
  const m    = state.projects.length;
  const cost = buildCostMatrix();

  // Node layout: S=0, students 1..n, projects n+1..n+m, T=n+m+1
  const S = 0;
  const T = n + m + 1;
  const g = new MCFGraph(n + m + 2);

  for (let i = 0; i < n; i++) g.addEdge(S, i + 1, 1, 0);

  const eids = Array.from({length: n}, () => []);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m; j++)
      eids[i][j] = g.addEdge(i + 1, n + 1 + j, 1, cost[i][j]);

  for (let j = 0; j < m; j++) g.addEdge(n + 1 + j, T, state.projects[j].capacity, 0);

  const {flow} = g.minCostFlow(S, T, n);
  if (flow < n) throw new Error(`רק ${flow} מתוך ${n} הסטודנטים ניתנים לשיבוץ. הגדילו את "כמות סטודנטים" בקובץ התקופות.`);

  return state.students.map((s, i) => {
    for (let j = 0; j < m; j++) {
      if (g.edges[eids[i][j]].flow === 1) {
        const p = state.projects[j];
        return {id: s.id, name: s.name, project: p.name, lecturer: p.lecturer, tier: tierOf(s.id, p.name)};
      }
    }
    return {id: s.id, name: s.name, project: '', lecturer: '', tier: TIER_NONE};
  });
}

// ── Results rendering ──────────────────────────────────────────────────────────
// One card per lecturer, listing that lecturer's periods in file order. Placement
// statistics are deliberately not shown here — the page may be projected for the
// students — and go into the exported xlsx instead (see resultStats).
function renderResults() {
  const {results, projects} = state;

  const byProject = new Map(projects.map(p => [p.name, []]));
  results.forEach(r => { if (byProject.has(r.project)) byProject.get(r.project).push(r); });

  const byLecturer = new Map();
  projects.forEach(p => {
    if (!byLecturer.has(p.lecturer)) byLecturer.set(p.lecturer, []);
    byLecturer.get(p.lecturer).push(p);
  });

  const cards = [...byLecturer].map(([lecturer, periods]) => {
    const items = periods.map(p => {
      const members = byProject.get(p.name);
      const students = members.length
        ? members.map(r => `<li>${esc(r.name)}</li>`).join(' ')
        : '<li class="empty-msg">לא שובצו סטודנטים</li>';
      return `<li class="lec-period"><span class="lec-period-name">${esc(p.name)}</span><ul class="lec-students">${students}</ul></li>`;
    }).join('');

    return `
      <div class="lec-card">
        <div class="lec-header">${lecturer ? `מרצה: ${esc(lecturer)}` : 'ללא מרצה'}</div>
        <ol class="lec-periods">${items}</ol>
      </div>`;
  }).join('');

  resultsCont.innerHTML = `<div class="lec-grid${state.revealMode ? ' lec-grid--reveal' : ''}">${cards}</div>`;
  if (state.revealMode) {
    resultsCont.querySelectorAll('.lec-card').forEach((el, i) => { el.style.animationDelay = `${i * 0.07}s`; });
  }
}

// Placement statistics for the exported file: [label, count, percent of students].
function resultStats() {
  const {results, projects} = state;
  const n   = results.length;
  const pct = k => n ? Math.round(k / n * 100) : 0;
  const count   = tier => results.filter(r => r.tier === tier).length;
  const primary = count(TIER_PRIMARY);
  const second  = count(TIER_SECONDARY);
  const random  = count(TIER_NONE);
  const empty   = projects.filter(p => !results.some(r => r.project === p.name)).length;

  return [
    ['מדד', 'מספר', 'אחוז'],
    ['סה"כ סטודנטים', n, ''],
    ['קיבלו עדיפות ראשונה', primary, `${pct(primary)}%`],
    ['קיבלו עדיפות שניה', second, `${pct(second)}%`],
    ['קיבלו אחת מהבחירות שלהם', primary + second, `${pct(primary + second)}%`],
    ['שובצו אקראית', random, `${pct(random)}%`],
    ['תקופות ללא סטודנטים', empty, ''],
  ];
}

// ── Export ─────────────────────────────────────────────────────────────────────
const EXPORT_HEADER = ['ID', 'שם', 'תקופה שהוקצתה', 'מרצה', 'רמת העדפה'];

function exportRows(results = state.results) {
  return [EXPORT_HEADER, ...results.map(r =>
    [r.id, r.name, r.project, r.lecturer, LEVEL_LABELS[r.tier]])];
}

function resultsSheet(results) {
  const ws = XLSX.utils.aoa_to_sheet(exportRows(results));
  // IDs are text: without this Excel drops any leading zero and re-formats them.
  results.forEach((r, i) => {
    const cell = ws[XLSX.utils.encode_cell({r: i + 1, c: 0})];
    if (cell) { cell.t = 's'; cell.v = String(r.id); }
  });
  ws['!cols'] = [{wch: 12}, {wch: 22}, {wch: 48}, {wch: 12}, {wch: 16}];
  return ws;
}

// Excel sheet names: at most 31 characters, none of []:*?/\, and unique.
function sheetName(raw, taken) {
  const base = raw.replace(/[\[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'ללא מרצה';
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base.slice(0, 28)} ${i}`;
  taken.add(name);
  return name;
}

downloadCsvBtn.addEventListener('click', () => {
  if (!state.results.length) return;
  downloadBlob(Papa.unparse(exportRows()), 'שיבוץ_תקופות.csv', 'text/csv');
});

downloadXlsxBtn.addEventListener('click', () => {
  if (!state.results.length) return;
  const wb = XLSX.utils.book_new();
  wb.Workbook = {Views: [{RTL: true}]};
  const taken = new Set();

  // One sheet with everyone, then one per lecturer (rows grouped by period).
  XLSX.utils.book_append_sheet(wb, resultsSheet(state.results), sheetName('שיבוץ', taken));
  const order = new Map(state.projects.map((p, i) => [p.name, i]));
  [...new Set(state.projects.map(p => p.lecturer))].forEach(lecturer => {
    const rows = state.results
      .filter(r => r.lecturer === lecturer)
      .sort((a, b) => order.get(a.project) - order.get(b.project));
    XLSX.utils.book_append_sheet(wb, resultsSheet(rows), sheetName(lecturer, taken));
  });

  const stats = XLSX.utils.aoa_to_sheet(resultStats());
  stats['!cols'] = [{wch: 28}, {wch: 10}, {wch: 10}];
  XLSX.utils.book_append_sheet(wb, stats, sheetName('סטטיסטיקה', taken));
  XLSX.writeFile(wb, 'שיבוץ_תקופות.xlsx');
});

// ── Reset ──────────────────────────────────────────────────────────────────────
resetBtn.addEventListener('click', () => {
  Object.assign(rawFiles, {students: null, projects: null, prefs: null});
  Object.assign(state, {
    students: [], projects: [], prefs: new Map(), aliases: new Map(), ignored: new Set(),
    unmatched: [], warnings: [], results: [], revealMode: false,
  });
  [studentsInput, projectsFileIn, prefsInput].forEach(i => { i.value = ''; });
  [studentsFileName, projectsFileName, prefsFileName].forEach(l => { l.textContent = 'לא נבחר קובץ'; });
  validationErrors.innerHTML = '';
  previewTableCont.innerHTML = '';
  unmatchedList.innerHTML    = '';
  capSummary.innerHTML       = '';
  hide(unmatchedBox);
  hide(previewSection);
  hide(configSection);
  hide(resultsSection);
  hide(capacityWarning);
  window.scrollTo({top: 0, behavior: 'smooth'});
});

// ── Fatal error helper ─────────────────────────────────────────────────────────
function showFatalError(msg) {
  validationErrors.innerHTML = `<div class="error-box">${esc(msg)}</div>`;
  previewTableCont.innerHTML = '';
  show(previewSection);
  hide(configSection);
  hide(resultsSection);
}
