# The engine lab

A flag-driven copy of Edition 1's engine (`engine.lab.mjs`) for measuring a
proposed change before it goes anywhere near a live `?piece=N`. With every
flag off it reproduces Edition 1 note for note:

```bash
node --no-warnings verify.mjs 1 3000
```

Measure a set of flags over addresses 1..20,000 (writes `results/<name>.json`):

```bash
node --no-warnings run.mjs edition2 sbParallel,bassAug2,bassSpace,tonicEnd,formulaFit,seamFix,register,innerRules 20000 16
```

Compare runs (renumbering share, per-key drafts), and refresh the committed summary:

```bash
node --no-warnings compare.mjs baseline edition2
```

```bash
node --no-warnings summarize.mjs
```

The flags are listed at the top of `engine.lab.mjs`. The other scripts reproduce single findings of the engine review (`docs/engine-review/`):

- `endings.mjs`: how Edition 1's pieces end.
- `sixth_pair.mjs`: where soprano/bass parallels come from.
- `crowding.mjs`: the bass meeting the soprano in failed drafts.
- `settings.mjs` and `diverse.mjs`: alternative settings of one tune.
- `log1p_check.mjs`: browser maths. Run it against the frozen table and it reports no change.
- `barform.mjs`, `barform-run.mjs` and `barform-examples.mjs`: the bar-form melody planner. `barform-literal.mjs` tests a literal Stollen repeat.
- `render.mjs`: WAV renders with the project's choir, a Node port of `tools/perform.py`. `listening.mjs "<folder>"` renders the review's examples into a listening folder, with a page that plays each pair side by side.

A promoted change must reproduce the lab's pieces address for address, as `engine.js` did for Edition 2.
