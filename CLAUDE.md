# Group Assignment Tool — Project Notes

A no-build, single-page web app that assigns students to project periods from their
stated preferences (optimal, via min-cost flow). Runs locally via
`python3 -m http.server` or by opening `index.html` directly.

The entire UI is in **Hebrew**, and `index.html` is `lang="he" dir="rtl"`. All user-facing strings live in `index.html` and `app.js`; keep new ones Hebrew. CSS uses logical properties (`inset-inline-*`, `margin-inline-start`, `text-align: start`) so the layout mirrors correctly — avoid raw `left`/`right` for anything direction-dependent.

## Files

| File | Purpose |
|---|---|
| `index.html` | The assignment page. Four `<section>` cards (steps 1–4). No framework. |
| `app.js` | Parsing, name matching, MCF solver, rendering, export. |
| `common.js` | Helpers used by `app.js`: `$`, `show`/`hide`, `esc`, `readTable`, `downloadBlob`, `spawnConfetti`. Loaded before `app.js`. `readTable` reads .xlsx/.xls/.csv into an array-of-arrays; `downloadBlob` prepends a UTF-8 BOM to `text/csv` so Excel reads the Hebrew columns correctly. |
| `style.css` | All styles. CSS custom properties for colours, no preprocessor. |
| `sample_60.csv` | **Legacy** fixture for the old single-CSV ranked-choice flow. Not readable by the current three-file input; kept only for reference. |
| `.claude/launch.json` | Tells the preview tool to run `python3 -m http.server 8792`. |

CDN dependencies: PapaParse (CSV writing) and SheetJS `xlsx` (all spreadsheet reading + xlsx export).

## Input: three files

`.xlsx` is preferred over `.csv` — no encoding ambiguity, and no dependence on the
exporter quoting the commas that appear *inside* period names. Both are accepted.
Columns are located by **header text**, not position, so column order may change.

1. **Students** — `שם מלא`, `תעודת זהות`
2. **Periods** — `תקופה`, `כמות סטודנטים` (that period's capacity), `מרצה`
3. **Preferences** — a Google Forms export: `תעודת זהות`, one *first priority* column and one or more *second priority* columns (the live form has two, because it was edited mid-collection; responses are taken from whichever is filled).

Each student picks **3 unordered first-priority** periods and **3 unordered second-priority** ones.

## User flow (the four steps)

1. **Upload** the three files (any order; parsing runs once all three are present).
2. **Preview** — periods table, students-with-preferences table, validation warnings.
3. **Review unrecognised choices, then run** — see below.
4. **Results** — one card per lecturer (not per period), each listing that lecturer's numbered periods with their students as names on one run-on line separated by `|` (the layout is wide, `.container` 1400px, so the whole result fits one screen for a photo). **No preference levels and no placement statistics on screen** (the page is projected for the students); both live only in the exports. Export to xlsx or CSV. Reset.

**ID numbers are never shown on screen** — not in the preview, not in the results —
only in the downloaded file, so results can be projected publicly. Warnings about a
row that has no name to show quote the last four digits (`maskId`).

## Choice parsing — the hard part

Google Forms joins a student's three selections into **one cell** with `", "`, and the
period names themselves contain commas (`"המאה ה-14, מחצית שניה"`). The cell therefore
cannot be split on the comma. `splitChoices()` instead matches known period names
inside the cell, **longest first**, so a short name is never consumed out of the
middle of a longer one.

Text is compared through `norm()` (strips nikud, unifies dashes, drops punctuation,
collapses `"ה- 16"` → `"ה-16"`), because the periods sheet and the form disagree on
punctuation and stray spaces.

Some disagreements are real wording differences the form and the sheet never
reconciled, e.g. the form's `"המאה ה-16, השליש האחרון. אליזבת הראשונה"` vs the sheet's
`"המאה ה-16, מחצית שניה. אליזבת הראשונה"`. **These are never auto-matched.** Plain
string similarity confidently picks the *wrong* period here (it prefers the
18th-century Marie Antoinette entry, whose shared middle phrase outweighs
everything else), and a silent mis-match puts a student in the wrong project.
Instead, unrecognised fragments are listed in step 3 with a dropdown pre-selected to
the best candidate from an **IDF-weighted token-cosine** score — rarity weighting
makes distinctive words like `"אליזבת"` dominate — for the teacher to check and
correct. The dropdowns are read when the assignment runs (`applyMatchSelections`),
so a suggestion the teacher is happy with needs no extra click; choosing
*התעלמות* instead leaves that text unmatched and is remembered in `state.ignored`.
Selections become `state.aliases` and everything is re-parsed, so a fragment that
actually held two adjacent unmatched names splits correctly on the next pass.

## Solver

Hand-written **min-cost max-flow** (SPFA successive shortest paths); no solver library.
Graph: source → students → periods → sink, with each period's edge to the sink capped
at its `כמות סטודנטים`.

**Costs encode a lexicographic objective** (`buildCostMatrix`), with `A = n + 1`:

| Tier | Cost |
|---|---|
| first-priority choice | `0` |
| second-priority choice | `A` |
| no choice matched | `A + 1` |

Giving up one first-priority placement costs `A`, which exceeds the largest possible
saving from every other student combined (at most `n`). So the solver **maximises
first-priority placements first**, and only then maximises second-priority ones — it
will never trade one student's first priority for several students' second.

A sub-unit random jitter (`< 1/(2n+2)` per cell, so the tiers can never be reordered)
breaks ties, so that the three *unordered* choices within a tier, and the leftover
places handed to students with no matching choice, are distributed at random rather
than always favouring whichever period appears first in the file.

Key invariant: `edges[id]` is always the forward edge; `edges[id ^ 1]` is its reverse
(they're added in pairs).

## State shape

```js
state = {
  students:  [{id, name}],
  projects:  [{name, capacity, lecturer}],
  prefs:     Map(id → {primary: string[], secondary: string[]}),
  aliases:   Map(normalised form-text → period name),   // teacher-confirmed
  ignored:   Set(normalised form-text),                 // left unmatched on purpose
  unmatched: [{text, count, suggestions: [{project, score}]}],
  warnings:  string[],
  results:   [{id, name, project, lecturer, tier}],     // tier: 0 / 1 / 2
  revealMode: boolean,
}
```

## Export

Columns, in this order: `ID | שם | תקופה שהוקצתה | מרצה | רמת העדפה`, where the level is
`עדיפות ראשונה` / `עדיפות שניה` / `שיבוץ אקראי`. Rows follow the students-file order.
The xlsx has several sheets: `שיבוץ` (everyone, in the table above), one sheet per lecturer (same columns, that lecturer's students grouped by period; names pass through `sheetName` for Excel's 31-char / forbidden-character limits), and last `סטטיסטיקה` (`resultStats`): counts and percentages per tier, plus periods left empty. The CSV is a single table and carries no statistics.
In the xlsx export the ID column is forced to text so Excel cannot drop a leading zero.

## Key design decisions

- **No LP solver CDN** — `javascript-lp-solver/prod/bundle.js` is not published in the npm package (browsers get an ORB error). The MCF implementation is ~70 lines and covers the same problem class.
- **Capacities come from the periods file**, per period. There is no minimum group size: only the per-period maximum is enforced, so a period can end up under-filled if total capacity exceeds the number of students.
- **IDs are strings throughout** (`normId`) — Israeli IDs can carry a leading zero, and spreadsheet exports may hand them over in scientific notation.
- **Column detection is specificity-ranked** (`findCol`): patterns are listed most-specific-first and the column matching the most specific pattern wins. A first-match-wins search ties `"תעודת זהות"` with the Google-Forms timestamp `"חותמת זמן"`, which also contains the loose `ת.ז` pattern.
- **Preference levels are never shown on screen** — the results show names only, so the page can be projected for the students without revealing who got a second-priority project. The level is in the export's `רמת העדפה` column.
