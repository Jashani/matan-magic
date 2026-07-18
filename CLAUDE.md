# Group Assignment Tool — Project Notes

A single-page, no-build web app that optimally assigns students to projects based on ranked preferences. Runs locally via `python3 -m http.server` or by opening `index.html` directly.

## Files

| File | Purpose |
|---|---|
| `index.html` | All markup. Four `<section>` cards (steps 1–4). No framework. |
| `app.js` | All logic — CSV parsing, solver, rendering. Single file, no modules. |
| `style.css` | All styles. CSS custom properties for colours, no preprocessor. |
| `sample_60.csv` | 60-student test fixture: 20 categories, 18 chosen (Cat 19 & 20 never selected), Category 1 oversubscribed (15 students ranked it top-2). |
| `.claude/launch.json` | Tells the preview tool to run `python3 -m http.server --directory /Users/yasha/git/Matan 8791`. |

## User flow (the four steps)

1. **Upload CSV** — `Name, Choice 1 … Choice 5`. PapaParse (CDN) parses it into `state.rawData`.
2. **Preview** — table of parsed data; validation warnings for duplicates / missing names.
3. **Configure assignment** — two columns:
   - *Projects textarea* — pre-filled with categories detected from the CSV. Teacher adds any projects no student listed (e.g. Category 19, 20). This textarea is the authoritative project list used by the solver.
   - *Group sizes* — global Min / Max per group applied to every project equally.
4. **Results** — category cards with student lists. Toggle (default OFF) reveals each student's achieved preference rank. Download CSV button. Reset button.

## Solver (`app.js` lines ~7–79 + ~323–401)

No external solver library. Uses a hand-written **min-cost max-flow** (SPFA successive shortest paths):

- **Cost matrix**: rank 1 → cost 1, rank 5 → cost 5, project not in student's preferences → cost 99 (UNRANKED_COST).
- **Graph**: source → students → projects → sink, plus auxiliary SS/TT nodes for lower-bound enforcement.
- **Lower-bound transformation**: converts per-project min-capacity constraints into a standard max-flow problem so the solver enforces both min and max capacities as hard constraints.
- **Output**: optimal assignment minimising total preference rank across all students. Students assigned to unranked projects are flagged "No preference matched" in the results.

Key invariant: `edges[id]` is always the forward edge; `edges[id ^ 1]` is its reverse (they're added in pairs).

## State shape

```js
state = {
  rawData:    [{name, prefs: string[]}],  // from CSV
  categories: string[],                   // from projects textarea at run-time
  globalMin:  number,                     // min students per project
  globalMax:  number,                     // max students per project
  results:    [{student, category, rankAchieved, noMatch}],
  showRanks:  boolean,                    // toggle state
}
```

## Key design decisions

- **No LP solver CDN** — `javascript-lp-solver/prod/bundle.js` is not published in the npm package (browsers get an ORB error). The MCF implementation is ~70 lines and covers the same problem class.
- **Project list is independent of CSV** — students may not list every project; the textarea lets the teacher add the full official list so the solver always fills every project.
- **Global not per-project capacities** — one Min/Max pair applies to all projects. Kept simple intentionally; the solver supports per-project limits internally if needed later.
- **Toggle default OFF** — rank details are hidden on load so the teacher can display results publicly without revealing who got a 4th choice, then flip the toggle deliberately.
