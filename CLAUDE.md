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

1. **Piece determinism is a public contract.** The live machine's piece
   No. N is `composePiece(N)`; `?piece=N` links exist in the wild. ANY
   change to `instrument/web/engine.js` that alters rng call order or
   search behavior renumbers the entire infinite library. Before touching
   it: hash pieces 1–10 before/after (see the mulberry32 fix in git log for
   the pattern). Behavior-changing edits are allowed but are a breaking
   change to be called out loudly.
2. **Python and JS engines are siblings, not clones.** Same design, same
   tables, independent PRNGs. Don't expect identical pieces across them.
3. **Checkers are calibrated against Bach**, deliberately a bit stricter
   (residual ~0.24 violations/chorale on the corpus itself, every category
   explained). If you change a rule, re-run `tools/validate_checker.py`
   and expect near-silence — zero means too loose, noise means too strict.

## Verification commands

- JS engine batch: `cd instrument/web && node test_engine.mjs`
  (expects 200/200 clean, ~12 ms/piece, determinism check included)
- Checker false-alarm run: `python tools/validate_checker.py`
- Clean-room scoring: `python tools/cleanroom_eval.py "feste Burg"`
- Serve the machine locally: launch config "instrument" → localhost:8901
  → `/web/index.html?v=<bump>` (python http.server caches hard; always
  bust with a query string when iterating)

## Website sync (the machine is vendored)

Live at apophenia.blog/work/choral-hurdy-gurdy (repo DashWieland/dash_website,
files at `components/hurdygurdy/*` + `components/HurdyGurdy.tsx` shell).
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
