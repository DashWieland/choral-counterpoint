# auto_compose / choral-counterpoint

Public repo (github.com/DashWieland/choral-counterpoint). Everything here
composes or verifies four-part chorales and species counterpoint. The
governing philosophy, validated repeatedly: **propose → machine-verify →
keep only survivors.** Checkers are load-bearing, not decorative; every
layer that skipped ground-truth confrontation shipped with bugs.

## Map

- `.claude/skills/choral-counterpoint/` — the Claude Code skill. Source of
  truth for the checkers, oracles, renderer, and mined tables. SKILL.md
  documents workflows and the veto loop.
- `engine/` — Python auto-composer (`compose.py`: melody → bass beam search
  over the oracle → inner voices → checker gate → ornament) and HTTP server
  (`serve.py`: /compose, /harmonize, /next with compose-ahead buffer).
- `instrument/web/` — the Choral Hurdy-Gurdy: full JS port of the engine +
  WebAudio choir + the machine UI. **Vendored to the website** (see below).
  `instrument/CONCEPT.md` is the design record, including as-shipped deltas.
- `tools/` — corpus miners (`mine_oracle.py`, `mine_ornaments.py`,
  `mine_melody.py`), validation harnesses (`validate_checker.py` = the
  lint-Bach false-alarm run, `cleanroom_eval.py` = leave-one-out scoring
  against Bach's own harmonizations), and `perform.py` (numpy choir → WAV).
- `out/` — compositions (FABE chorale = Claude's signed first piece), demos,
  A/B pairs, the packaged `.skill` zip.

## Invariants — do not break casually

1. **Piece determinism is a public contract, kept by editions.**
   `?piece=N` links exist in the wild. Edition 1 is frozen in
   `instrument/web/engine-ed1.js` with its own `tables-ed1.js`, and
   Edition 2 (bar form, released 2026-09-26) in `engine-ed2.js` with
   `tables-ed2.js`: never edit any of them. `node golden.mjs` checks each
   edition's pieces 1–20,000 against its `golden-edN.json`, and
   `test_engine.mjs` checks pieces 1–200 of each on every run. `engine.js`
   (with `tables.js`) is the working copy of the next edition, so behavior
   changes go there. `machine.js` maps `?ed=` to an engine: a link without
   `?ed=` is Edition 1, a fresh visit plays `CURRENT` (2), and a URL can
   open only editions up to `RELEASED` (2). Releasing an edition means
   freezing `engine.js` and `tables.js` as `engine-edN.js` and
   `tables-edN.js`, recording `node golden.mjs --edition N --write`, adding
   it to `EDITIONS`, then raising `RELEASED` and `CURRENT`. `log1p.js` freezes
   the only browser-dependent maths, so a piece is also the same in every
   browser. Addresses are parsed in `machine.js`
   (`openAddress`): plain decimal, No. 1 to `MAX_SAFE_INTEGER` — one
   further and n + 1 === n, which stalled the crank and froze the tab.
2. **Python and JS engines are siblings, not clones.** Same design, same
   tables, independent PRNGs. Don't expect identical pieces across them.
3. **Checkers are calibrated against Bach**, deliberately a bit stricter
   (residual ~0.24 violations/chorale on the corpus itself, every category
   explained). If you change a rule, re-run `tools/validate_checker.py`
   and expect near-silence — zero means too loose, noise means too strict.

## Verification commands

- JS engine batch: `cd instrument/web && node test_engine.mjs`
  (engine.js: 200/200 clean and in bar form, the Stollen repeated note for
  note with its ornaments; ends on the tonic, soprano in range, first draft
  kept ≥90%, ~21 ms/piece; engine-ed1.js and engine-ed2.js: pieces 1–200
  match their golden files)
- Census of an engine: `cd instrument/web && node census.mjs 1 20000`, or
  `node census.mjs sample 2000` for addresses spread up to 2^53 (Edition 2
  with bar form: first draft kept 96.9% and 97.4%, nothing empty, off the
  tonic, or out of range)
- Python engine census: `python engine/census.py` (2,520 pieces, every
  tonic, mode and size: first draft kept 96.9%, every piece in bar form
  with a literal repeat, on the tonic and in range; about 3 minutes)
- Golden test: `cd instrument/web && node golden.mjs`
  (each frozen edition's pieces 1–20,000 unchanged; about twelve minutes)
- Machine address contract: `cd instrument/web && node test_machine.mjs`
  (`?piece=` parsing, both ends of the shelf, null-chorale skipping,
  `?ed=` editions; <1 s)
- Checker false-alarm run: `python tools/validate_checker.py`
- Clean-room scoring: `python tools/cleanroom_eval.py "feste Burg"`
- Serve the machine locally: launch config "instrument" → localhost:8901
  → `/web/index.html?v=<bump>` (python http.server caches hard; always
  bust with a query string when iterating)

## Website sync (the machine is vendored)

Live at apophenia.blog/work/choral-hurdy-gurdy (repo DashWieland/dash_website,
files at `components/hurdygurdy/*` + `components/HurdyGurdy.tsx` shell).
Vendor every module `machine.js` imports: `engine-ed1.js`, `engine-ed2.js`,
`tables-ed1.js`, `tables-ed2.js`, `log1p.js`, `audio.js`, plus the CSS
(the working copy, `engine.js` with `tables.js`, stays here until it is
released). The
shell is the site's own file (`website_handoff/` is gitignored here).
Workflow: edit HERE first → verify → `cp` the changed files into a branch of
dash_website → PR (Vercel preview + SonarCloud run; the vendored dir is
excluded from Sonar via `.sonarcloud.properties` — analysis happens in THIS
repo's context instead). Never edit the site copy directly; it drifts.
The dash_website clone lives in session scratchpad; it needs
`git config core.longpaths true` on Windows, and repo-local user identity.

## Environment gotchas (they will bite again)

- The browser pane frequently reports `document.hidden` → rAF never fires →
  the machine looks dead and screenshots time out. ALWAYS probe
  `document.visibilityState` before diagnosing a dead loop. DOM/layout/CSS
  probes via javascript_tool still work when hidden; use them.
- `python -m http.server` + Chrome = stale module caches. Bust with `?v=N`
  on the page URL AND the module import.
- Dash listens on muddy TV speakers; for listening comparisons, match key,
  register, and tempo, and prefer pieces not crowded in the low end.

## Design rules for anything user-facing

Dash's design system (dark-first tokens, no gradients/shadows, radius ≤2px,
IBM Plex Mono / Playfair) — load the dash-design-system skill. Decorative
text restraint is a standing correction: terse labels, glyphs over phrases,
no explaining what a music box is. Both are also in memory.
