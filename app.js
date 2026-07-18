'use strict';

// ── Constants ──────────────────────────────────────────────────────────────────
const UNRANKED_COST = 99;
const RANK_LABELS   = ['', '1st', '2nd', '3rd', '4th', '5th'];

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
const state = {
  rawData:    [],    // [{name: string, prefs: string[]}]
  categories: [],    // sorted unique category names
  globalMin:  0,     // min students per group (applied to every category)
  globalMax:  3,     // max students per group (applied to every category)
  results:    [],    // [{student, category, rankAchieved, noMatch}]
  showRanks:  false,
  revealMode: false, // true during the "Run Assignment" reveal sequence
};

// ── DOM refs ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const csvInput         = $('csv-input');
const fileNameLabel    = $('file-name');
const sampleBtn        = $('sample-btn');
const previewSection   = $('preview-section');
const configSection    = $('config-section');
const resultsSection   = $('results-section');
const validationErrors = $('validation-errors');
const previewTableCont = $('preview-table-container');
const projectsInput    = $('projects-input');
const projectsCount    = $('projects-count');
const globalMinInput   = $('global-min');
const globalMaxInput   = $('global-max');
const capSummary       = $('cap-summary');
const capacityWarning  = $('capacity-warning');
const runBtn           = $('run-btn');
const revealToggle     = $('reveal-toggle');
const resultsCont      = $('results-container');
const summaryStats     = $('summary-stats');
const downloadBtn      = $('download-btn');
const resetBtn         = $('reset-btn');

// ── Utilities ──────────────────────────────────────────────────────────────────
const show = el => el.classList.remove('hidden');
const hide = el => el.classList.add('hidden');
const esc  = s  => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function downloadBlob(content, filename, mime) {
  const url = URL.createObjectURL(new Blob([content], {type: mime}));
  Object.assign(document.createElement('a'), {href: url, download: filename}).click();
  URL.revokeObjectURL(url);
}

// ── Sample CSV ─────────────────────────────────────────────────────────────────
sampleBtn.addEventListener('click', () => {
  const rows = [
    ['Name',  'Choice 1', 'Choice 2', 'Choice 3', 'Choice 4', 'Choice 5'],
    ['Alice',  'Math',    'Science',  'Art',       'History',  'Music'],
    ['Bob',    'Science', 'Math',     'History',   'Art',      'Music'],
    ['Carol',  'Art',     'Music',    'Math',      'Science',  'History'],
    ['Dave',   'History', 'Art',      'Science',   'Music',    'Math'],
    ['Eve',    'Music',   'History',  'Art',       'Math',     'Science'],
    ['Frank',  'Math',    'Art',      'Science',   'History',  'Music'],
    ['Grace',  'Science', 'Music',    'History',   'Math',     'Art'],
    ['Henry',  'Art',     'Science',  'Math',      'Music',    'History'],
    ['Iris',   'Music',   'Math',     'Science',   'Art',      'History'],
    ['James',  'History', 'Science',  'Art',       'Music',    'Math'],
    ['Karen',  'Math',    'History',  'Music',     'Art',      'Science'],
  ];
  downloadBlob(Papa.unparse(rows), 'sample_preferences.csv', 'text/csv');
});

// ── File upload ────────────────────────────────────────────────────────────────
csvInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  fileNameLabel.textContent = file.name;
  hide(resultsSection);
  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    complete: result => handleParsed(result),
    error: err => showFatalError(`CSV parse error: ${err.message}`),
  });
});

function handleParsed(parseResult) {
  const fields = parseResult.meta.fields || [];
  const raw    = parseResult.data;
  const errors = [];

  if (fields.length < 2) {
    showFatalError('CSV must have at least 2 columns: a name column then one or more preference columns.');
    return;
  }

  const nameField  = fields[0];
  const prefFields = fields.slice(1, 6);
  const seenNames  = new Set();

  const normalized = raw.map((row, idx) => {
    const rowNum = idx + 2;
    const name   = (row[nameField] || '').trim();
    const prefs  = prefFields.map(f => (row[f] || '').trim()).filter(Boolean);
    if (!name) { errors.push(`Row ${rowNum}: missing name — skipped`); return null; }
    if (seenNames.has(name.toLowerCase())) { errors.push(`Row ${rowNum}: duplicate name "${name}" — skipped`); return null; }
    seenNames.add(name.toLowerCase());
    if (prefs.length === 0) errors.push(`Row ${rowNum} (${name}): no preferences listed — will be auto-assigned to fill remaining slots`);
    return {name, prefs};
  }).filter(Boolean);

  const allCats = new Set();
  normalized.forEach(r => r.prefs.forEach(p => allCats.add(p)));

  if (allCats.size === 0) { showFatalError('No category names found. Ensure your CSV has preference columns after the name column.'); return; }
  if (normalized.length === 0) { showFatalError('No valid student rows found after parsing.'); return; }

  state.rawData    = normalized;
  state.categories = [...allCats].sort();
  state.results    = [];

  validationErrors.innerHTML = errors.length
    ? `<div class="warning-box"><strong>Warnings (${errors.length}):</strong><ul>${
        errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul></div>`
    : '';

  // Pre-fill the projects textarea with detected categories.
  // Teacher can add any projects that no student listed (e.g. Category 19, 20).
  projectsInput.value = state.categories.join('\n');

  renderPreview();
  updateCapSummary();
  show(previewSection);
  show(configSection);
  previewSection.scrollIntoView({behavior: 'smooth'});
}

// ── Preview table ──────────────────────────────────────────────────────────────
function renderPreview() {
  const maxCols = Math.max(...state.rawData.map(r => r.prefs.length), 1);
  const headers = ['Name', ...Array.from({length: maxCols}, (_, i) => `Choice ${i + 1}`)];
  const thead   = `<tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr>`;
  const tbody   = state.rawData.map(r => {
    const cells = [r.name, ...r.prefs, ...Array(maxCols - r.prefs.length).fill('')];
    return `<tr>${cells.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`;
  }).join('');

  previewTableCont.innerHTML = `
    <p class="meta">
      <strong>${state.rawData.length}</strong> students &bull;
      <strong>${state.categories.length}</strong> categories:
      <em>${state.categories.map(esc).join(', ')}</em>
    </p>
    <div class="table-scroll">
      <table class="data-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table>
    </div>`;
}

// ── Project list helpers ───────────────────────────────────────────────────────
// Parses the textarea into a deduped, non-empty list of project names.
function getProjects() {
  const seen = new Set();
  return projectsInput.value
    .split('\n')
    .map(s => s.trim())
    .filter(s => {
      if (!s || seen.has(s.toLowerCase())) return false;
      seen.add(s.toLowerCase());
      return true;
    });
}

// ── Global capacity summary ────────────────────────────────────────────────────
function updateCapSummary() {
  if (!state.rawData.length) return;
  const n        = state.rawData.length;
  const projects = getProjects();
  const m        = projects.length;
  const gMax     = Math.max(0, parseInt(globalMaxInput.value) || 0);
  const gMin     = Math.max(0, parseInt(globalMinInput.value) || 0);
  const totalMax = m * gMax;
  const totalMin = m * gMin;

  projectsCount.textContent = `${m} project${m !== 1 ? 's' : ''} defined`;

  capSummary.innerHTML =
    `${m} projects &times; max&nbsp;${gMax} = <strong>${totalMax} total slots</strong> for ${n} students` +
    (gMin > 0 ? ` &bull; min&nbsp;${gMin} per group = ${totalMin} seats minimum` : '');

  if (m === 0) {
    capacityWarning.textContent = '⚠ No projects defined — add at least one project above';
    show(capacityWarning);
  } else if (gMax < gMin) {
    capacityWarning.textContent = '⚠ Max must be ≥ Min';
    show(capacityWarning);
  } else if (totalMax < n) {
    capacityWarning.textContent =
      `⚠ Total max (${totalMax}) < students (${n}) — increase Max per group or add more projects`;
    show(capacityWarning);
  } else {
    hide(capacityWarning);
  }
}

projectsInput.addEventListener('input', updateCapSummary);
globalMinInput.addEventListener('input', updateCapSummary);
globalMaxInput.addEventListener('input', updateCapSummary);

// ── Run button ─────────────────────────────────────────────────────────────────
runBtn.addEventListener('click', () => {
  const gMin     = Math.max(0, parseInt(globalMinInput.value) || 0);
  const gMax     = Math.max(0, parseInt(globalMaxInput.value) || 0);
  const projects = getProjects();

  if (projects.length === 0) {
    alert('No projects defined. Add at least one project name in the Projects list.');
    return;
  }
  if (gMax < gMin) {
    alert('Max students per group must be ≥ Min students per group.');
    return;
  }

  const n        = state.rawData.length;
  const m        = projects.length;
  const totalMax = m * gMax;
  const totalMin = m * gMin;

  if (totalMax < n) {
    alert(`Cannot place all ${n} students: ${m} projects × max ${gMax} = only ${totalMax} slots.\n\nAdd more projects or increase "Max per group".`);
    return;
  }
  if (totalMin > n) {
    if (!confirm(`Total minimum (${m} projects × min ${gMin} = ${totalMin}) exceeds student count (${n}).\nThis may produce an infeasible assignment. Continue anyway?`)) return;
  }

  // The textarea is the authoritative project list — update state before solving.
  state.categories = projects;
  state.globalMin  = gMin;
  state.globalMax  = gMax;

  runBtn.disabled   = true;
  runBtn.innerHTML  = '<span class="btn-spinner"></span> Professor Pigeon is thinking…';
  runBtn.classList.add('btn-running');

  setTimeout(() => {
    try {
      state.results    = solve();
      state.showRanks  = false;
      state.revealMode = true;
      revealToggle.checked = false;
      renderResults();
      show(resultsSection);
      resultsSection.scrollIntoView({behavior: 'smooth'});
      setTimeout(spawnConfetti, 450);
    } catch (err) {
      alert(`Assignment failed: ${err.message}`);
    } finally {
      runBtn.disabled   = false;
      runBtn.innerHTML  = '🔬 Run Assignment';
      runBtn.classList.remove('btn-running');
      state.revealMode  = false;
    }
  }, 30);
});

// ── Solver (min-cost flow with lower-bound transformation) ─────────────────────
function buildCostMatrix() {
  return state.rawData.map(student =>
    state.categories.map(cat => {
      const rank = student.prefs.indexOf(cat);
      return rank === -1 ? UNRANKED_COST : rank + 1;
    })
  );
}

function solve() {
  const students = state.rawData;
  const cats     = state.categories;
  const n        = students.length;
  const m        = cats.length;
  const cost     = buildCostMatrix();
  const gMin     = state.globalMin;
  const gMax     = state.globalMax;

  // Node layout: S=0, students 1..n, cats n+1..n+m, T=n+m+1, SS=n+m+2, TT=n+m+3
  // Lower-bound transformation enforces per-category min and max simultaneously.
  const S  = 0;
  const T  = n + m + 1;
  const SS = n + m + 2;
  const TT = n + m + 3;
  const g  = new MCFGraph(n + m + 4);

  const excess = new Array(n + m + 4).fill(0);

  // S→student (mandatory, lo=hi=1): removed from graph, adjust excess only
  for (let i = 0; i < n; i++) { excess[i + 1] += 1; excess[S] -= 1; }

  // student→category (lo=0, hi=1)
  const catEids = Array.from({length: n}, () => []);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m; j++)
      catEids[i][j] = g.addEdge(i + 1, n + 1 + j, 1, cost[i][j]);

  // category→T (lo=gMin, hi=gMax)
  for (let j = 0; j < m; j++) {
    if (gMax > gMin) g.addEdge(n + 1 + j, T, gMax - gMin, 0);
    excess[n + 1 + j] -= gMin;
    excess[T]         += gMin;
  }

  // Return edge completes the circulation
  g.addEdge(T, S, n, 0);

  // SS/TT edges from excess
  let totalPositive = 0;
  for (let v = 0; v <= T; v++) {
    if (excess[v] > 0)      { g.addEdge(SS, v, excess[v], 0); totalPositive += excess[v]; }
    else if (excess[v] < 0) { g.addEdge(v, TT, -excess[v], 0); }
  }

  const result = g.minCostFlow(SS, TT, totalPositive);

  if (result.flow < totalPositive) {
    if (gMin > 0) {
      throw new Error(
        `No feasible assignment with min ${gMin} per group. ` +
        `Try reducing "Min students per group" or increasing "Max students per group".`
      );
    }
    const placed = result.flow - m * gMin;
    throw new Error(`Only ${placed} of ${n} students could be placed. Increase "Max students per group".`);
  }

  return students.map((student, i) => {
    for (let j = 0; j < m; j++) {
      if (g.edges[catEids[i][j]].flow === 1) {
        const c = cost[i][j];
        return {student: student.name, category: cats[j], rankAchieved: c === UNRANKED_COST ? null : c, noMatch: c === UNRANKED_COST};
      }
    }
    return {student: student.name, category: null, rankAchieved: null, noMatch: true};
  });
}

// ── Results rendering ──────────────────────────────────────────────────────────
revealToggle.addEventListener('change', () => {
  state.showRanks = revealToggle.checked;
  if (state.results.length) renderResults();
});

function rankBadge(rankAchieved, noMatch) {
  if (noMatch || rankAchieved === null)
    return '<span class="badge badge-warn">No preference matched</span>';
  const label = RANK_LABELS[rankAchieved] || `${rankAchieved}th`;
  const cls   = rankAchieved === 1 ? 'badge-top1' : rankAchieved <= 2 ? 'badge-top2' : 'badge-rank';
  return `<span class="badge ${cls}">${label} choice</span>`;
}

function renderResults() {
  const {results, categories, globalMin, globalMax, showRanks} = state;

  const byCat = {};
  categories.forEach(c => { byCat[c] = []; });
  results.forEach(r => { if (r.category) byCat[r.category].push(r); });

  const placed    = results.filter(r => r.category !== null).length;
  const noMatch   = results.filter(r => r.noMatch).length;
  const autoAssigned = results.filter(r => r.noPrefs).length;
  const top1      = results.filter(r => r.rankAchieved === 1).length;
  const top2      = results.filter(r => r.rankAchieved !== null && r.rankAchieved <= 2).length;
  const emptyCats = categories.filter(c => byCat[c].length === 0).length;
  const belowMin  = globalMin > 0 ? categories.filter(c => byCat[c].length < globalMin) : [];
  const pct       = k => placed ? Math.round(k / placed * 100) : 0;

  const warnChips = [
    noMatch   ? `${noMatch} student${noMatch > 1 ? 's' : ''} with no matched preference` : '',
    emptyCats ? `${emptyCats} empty categor${emptyCats > 1 ? 'ies' : 'y'}` : '',
    ...belowMin.map(c => `${esc(c)}: ${byCat[c].length} placed (min ${globalMin})`),
  ].filter(Boolean);

  summaryStats.innerHTML = `
    <div class="stats-row">
      <div class="stat-chip">${placed} / ${results.length} placed</div>
      <div class="stat-chip">${pct(top1)}% got 1st choice</div>
      <div class="stat-chip">${pct(top2)}% got top-2 choice</div>
      ${warnChips.map(w => `<div class="stat-chip stat-chip-warn">${w}</div>`).join('')}
    </div>`;

  const cards = categories.map(cat => {
    const members = byCat[cat];
    const full    = members.length >= globalMax;
    const empty   = members.length === 0;

    const bodyRows = members.length
      ? members.map(r => `<tr>
          <td>${esc(r.student)}</td>
          ${showRanks ? `<td>${rankBadge(r.rankAchieved, r.noMatch)}</td>` : ''}
        </tr>`).join('')
      : `<tr><td colspan="${showRanks ? 2 : 1}" class="empty-msg">No students assigned</td></tr>`;

    return `
      <div class="cat-card${empty ? ' cat-empty' : ''}">
        <div class="cat-header">
          <span class="cat-title">${esc(cat)}</span>
          <span class="cat-count${full ? ' at-cap' : ''}">${members.length}&thinsp;/&thinsp;${globalMax}</span>
        </div>
        <table class="data-table inner-table">
          <thead><tr><th>Student</th>${showRanks ? '<th>Preference</th>' : ''}</tr></thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>`;
  }).join('');

  const revealClass = state.revealMode ? ' cat-grid--reveal' : '';
  resultsCont.innerHTML = `<div class="cat-grid${revealClass}">${cards}</div>`;
  if (state.revealMode) {
    resultsCont.querySelectorAll('.cat-card').forEach((el, i) => {
      el.style.animationDelay = `${i * 0.07}s`;
    });
  }
}

// ── Download results ───────────────────────────────────────────────────────────
downloadBtn.addEventListener('click', () => {
  const rows = [['Student', 'Assigned Category', 'Preference Rank']];
  state.results.forEach(r => {
    const rank = r.noMatch               ? 'No match'
               : r.rankAchieved !== null ? `${RANK_LABELS[r.rankAchieved] || r.rankAchieved} choice`
               : '';
    rows.push([r.student, r.category || 'Unassigned', rank]);
  });
  downloadBlob(Papa.unparse(rows), 'group_assignments.csv', 'text/csv');
});

// ── Reset ──────────────────────────────────────────────────────────────────────
resetBtn.addEventListener('click', () => {
  Object.assign(state, {rawData: [], categories: [], globalMin: 0, globalMax: 3, results: [], showRanks: false, revealMode: false});
  revealToggle.checked       = false;
  csvInput.value             = '';
  fileNameLabel.textContent  = 'No file selected';
  projectsInput.value        = '';
  projectsCount.textContent  = '';
  globalMinInput.value       = '0';
  globalMaxInput.value       = '3';
  validationErrors.innerHTML = '';
  previewTableCont.innerHTML = '';
  capSummary.innerHTML       = '';
  hide(previewSection);
  hide(configSection);
  hide(resultsSection);
  hide(capacityWarning);
  window.scrollTo({top: 0, behavior: 'smooth'});
});

// ── Confetti burst ─────────────────────────────────────────────────────────────
function spawnConfetti() {
  const pieces = ['🎉', '✨', '⭐', '💫', '🌟', '🎊', '🔬', '🧪', '🕊️'];
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

// ── Fatal error helper ─────────────────────────────────────────────────────────
function showFatalError(msg) {
  validationErrors.innerHTML = `<div class="error-box">${esc(msg)}</div>`;
  previewTableCont.innerHTML = '';
  show(previewSection);
  hide(configSection);
}
