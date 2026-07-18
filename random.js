'use strict';

// ── State ──────────────────────────────────────────────────────────────────────
const state = {
  students:   [],    // string[]
  categories: [],    // string[] (project names, deduped)
  globalMin:  0,
  globalMax:  3,
  results:    [],    // [{student, category}]
  revealMode: false,
};

// ── DOM refs ───────────────────────────────────────────────────────────────────
const sampleFillBtn    = $('sample-fill-btn');
const studentsInput    = $('students-input');
const studentsCount    = $('students-count');
const projectsInput    = $('projects-input');
const projectsCount    = $('projects-count');
const globalMinInput   = $('global-min');
const globalMaxInput   = $('global-max');
const capSummary       = $('cap-summary');
const capacityWarning  = $('capacity-warning');
const runBtn           = $('run-btn');
const resultsSection   = $('results-section');
const resultsCont      = $('results-container');
const summaryStats     = $('summary-stats');
const downloadBtn      = $('download-btn');
const resetBtn         = $('reset-btn');

const CONFETTI_PIECES = ['🎉', '✨', '⭐', '💫', '🌟', '🎊', '🎲', '🕊️'];

// ── Utilities ──────────────────────────────────────────────────────────────────
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Parses a textarea into a list of trimmed, non-empty lines. Optionally dedupes.
function getLines(textarea, dedupe) {
  const seen = new Set();
  return textarea.value
    .split('\n')
    .map(s => s.trim())
    .filter(s => {
      if (!s) return false;
      if (dedupe) {
        if (seen.has(s.toLowerCase())) return false;
        seen.add(s.toLowerCase());
      }
      return true;
    });
}

// ── Sample data ────────────────────────────────────────────────────────────────
sampleFillBtn.addEventListener('click', () => {
  studentsInput.value = Array.from({length: 60}, (_, i) => `Student ${i + 1}`).join('\n');
  projectsInput.value = Array.from({length: 20}, (_, i) => `Project ${i + 1}`).join('\n');
  updateCapSummary();
});

// ── Capacity summary ───────────────────────────────────────────────────────────
function updateCapSummary() {
  const students = getLines(studentsInput, false);
  const projects = getLines(projectsInput, true);
  const n        = students.length;
  const m        = projects.length;
  const gMax     = Math.max(0, parseInt(globalMaxInput.value) || 0);
  const gMin     = Math.max(0, parseInt(globalMinInput.value) || 0);
  const totalMax = m * gMax;
  const totalMin = m * gMin;

  studentsCount.textContent = `${n} student${n !== 1 ? 's' : ''} defined`;
  projectsCount.textContent = `${m} project${m !== 1 ? 's' : ''} defined`;

  capSummary.innerHTML = n === 0 || m === 0
    ? ''
    : `${m} projects &times; max&nbsp;${gMax} = <strong>${totalMax} total slots</strong> for ${n} students` +
      (gMin > 0 ? ` &bull; min&nbsp;${gMin} per group = ${totalMin} seats minimum` : '');

  if (n === 0 || m === 0) {
    hide(capacityWarning);
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

studentsInput.addEventListener('input', updateCapSummary);
projectsInput.addEventListener('input', updateCapSummary);
globalMinInput.addEventListener('input', updateCapSummary);
globalMaxInput.addEventListener('input', updateCapSummary);

// ── Run button ─────────────────────────────────────────────────────────────────
runBtn.addEventListener('click', () => {
  const students = getLines(studentsInput, false);
  const projects = getLines(projectsInput, true);
  const gMin     = Math.max(0, parseInt(globalMinInput.value) || 0);
  const gMax     = Math.max(0, parseInt(globalMaxInput.value) || 0);

  if (students.length === 0) { alert('No students defined. Add at least one student name.'); return; }
  if (projects.length === 0) { alert('No projects defined. Add at least one project name.'); return; }
  if (gMax < gMin) { alert('Max students per group must be ≥ Min students per group.'); return; }

  const n        = students.length;
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

  state.students   = students;
  state.categories = projects;
  state.globalMin  = gMin;
  state.globalMax  = gMax;

  runBtn.disabled  = true;
  runBtn.innerHTML = '<span class="btn-spinner"></span> Professor Pigeon is shuffling…';
  runBtn.classList.add('btn-running');

  setTimeout(() => {
    try {
      state.results    = solve();
      state.revealMode = true;
      renderResults();
      show(resultsSection);
      resultsSection.scrollIntoView({behavior: 'smooth'});
      setTimeout(() => spawnConfetti(CONFETTI_PIECES), 450);
    } catch (err) {
      alert(`Assignment failed: ${err.message}`);
    } finally {
      runBtn.disabled  = false;
      runBtn.innerHTML = '🎲 Run Random Assignment';
      runBtn.classList.remove('btn-running');
      state.revealMode = false;
    }
  }, 30);
});

// ── Solver (random shuffle respecting min/max capacities) ──────────────────────
function solve() {
  const students = state.students;
  const cats     = state.categories;
  const n        = students.length;
  const m        = cats.length;
  const gMin     = state.globalMin;
  const gMax     = state.globalMax;

  if (m * gMin > n) throw new Error(`No feasible assignment with min ${gMin} per group.`);

  // Every project starts at gMin, then remaining seats are handed out in a
  // random order (capped at gMax) so group sizes vary run to run.
  const counts  = new Array(m).fill(gMin);
  let remaining = n - m * gMin;
  const order   = shuffle(Array.from({length: m}, (_, i) => i));
  const maxIterations = m * (gMax - gMin) + m; // worst case: every project climbs from gMin to gMax
  let idx = 0;
  while (remaining > 0 && idx < maxIterations) {
    const j = order[idx % m];
    if (counts[j] < gMax) { counts[j]++; remaining--; }
    idx++;
  }
  if (remaining > 0) throw new Error(`Could not place all ${n} students within the given capacities.`);

  const shuffledStudents = shuffle(students);
  const results = [];
  let cursor = 0;
  for (let j = 0; j < m; j++) {
    for (let k = 0; k < counts[j]; k++) {
      results.push({student: shuffledStudents[cursor++], category: cats[j]});
    }
  }
  return results;
}

// ── Results rendering ────────────────────────────────────────────────────────────
function renderResults() {
  const {results, categories, globalMin, globalMax} = state;

  const byCat = {};
  categories.forEach(c => { byCat[c] = []; });
  results.forEach(r => { byCat[r.category].push(r); });

  const emptyCats = categories.filter(c => byCat[c].length === 0).length;
  const belowMin  = globalMin > 0 ? categories.filter(c => byCat[c].length < globalMin) : [];

  const warnChips = [
    emptyCats ? `${emptyCats} empty categor${emptyCats > 1 ? 'ies' : 'y'}` : '',
    ...belowMin.map(c => `${esc(c)}: ${byCat[c].length} placed (min ${globalMin})`),
  ].filter(Boolean);

  summaryStats.innerHTML = `
    <div class="stats-row">
      <div class="stat-chip">${results.length} students placed</div>
      <div class="stat-chip">${categories.length} projects</div>
      ${warnChips.map(w => `<div class="stat-chip stat-chip-warn">${w}</div>`).join('')}
    </div>`;

  const cards = categories.map(cat => {
    const members = byCat[cat];
    const full    = members.length >= globalMax;
    const empty   = members.length === 0;

    const bodyRows = members.length
      ? members.map(r => `<tr><td>${esc(r.student)}</td></tr>`).join('')
      : `<tr><td class="empty-msg">No students assigned</td></tr>`;

    return `
      <div class="cat-card${empty ? ' cat-empty' : ''}">
        <div class="cat-header">
          <span class="cat-title">${esc(cat)}</span>
          <span class="cat-count${full ? ' at-cap' : ''}">${members.length}&thinsp;/&thinsp;${globalMax}</span>
        </div>
        <table class="data-table inner-table">
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
  const rows = [['Student', 'Assigned Project']];
  state.results.forEach(r => rows.push([r.student, r.category]));
  downloadBlob(Papa.unparse(rows), 'random_group_assignments.csv', 'text/csv');
});

// ── Reset ──────────────────────────────────────────────────────────────────────
resetBtn.addEventListener('click', () => {
  Object.assign(state, {students: [], categories: [], globalMin: 0, globalMax: 3, results: [], revealMode: false});
  studentsInput.value       = '';
  projectsInput.value       = '';
  globalMinInput.value      = '0';
  globalMaxInput.value      = '3';
  studentsCount.textContent = '';
  projectsCount.textContent = '';
  capSummary.innerHTML      = '';
  hide(resultsSection);
  hide(capacityWarning);
  window.scrollTo({top: 0, behavior: 'smooth'});
});
