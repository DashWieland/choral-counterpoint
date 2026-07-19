# The Choral Hurdy-Gurdy — design concept

*Signed off and built: the machine lives in `instrument/web/` (standalone
page + framework-free modules); site handoff in `website_handoff/`. This
document remains the design record.*

## The one-sentence idea

An infinite, indexed library of machine-composed, machine-verified chorales,
played by cranking a music box that is drawn as its own patent diagram.

## Why a patent drawing

A skeuomorphic music box needs gloss: gradients, shadows, rounded wood, none
of which exist in this design language. But the language *prescribes* an
alternative — cross-hatch for depth, hard 1px rules, engraved mono labels —
and that is exactly the vocabulary of a 19th-century patent drawing. So the
machine is presented as **FIG. 1**, a labeled technical illustration that
happens to be running. This solves three problems at once:

1. **No banned styling.** Hatching, ruled lines, and flat fills only.
2. **Intuitive reads.** Patent drawings come with part labels and leader
   lines. `CRANK — scroll to turn`, `MOTOR`, `TAPE`, `PLATE` are diegetic
   captions, not tutorial chrome. The interaction manual *is* the aesthetic.
3. **The site's thesis.** apophenia.blog treats every interactive element as
   an argument. This one argues: the machine is fully inspectable — a music
   generator you are allowed to see all the way into. A diagram that plays.

## The parts (FIG. 1)

```
   FIG. 1 — CHORAL HURDY-GURDY          ← title block, mono caps, secondary
  ┌──────────────────────────────────────────┐
  │  TAPE WINDOW                              │  ← upper ~60%: punched tape
  │  ····○···●══●··○····|····○···○·····       │    scrolling past a playhead
  │  ──────────┼──────────────────────        │
  │            ▲ playhead (fixed rule)        │
  ├──────────────────────────────────────────┤
  │ PLATE: No. 0214 · G MAJOR · 0 VIOLATIONS │  ← engraved plate, live
  │ [MOTOR]  BPM ▸ 072          ⭮ CRANK ────┼──← crank protrudes right
  └──────────────────────────────────────────┘
   annotations with leader lines around the box
```

- **The tape** is the score made visible: a punched-paper strip, one hole per
  note, vertical position = pitch (compressed piano-roll), color = voice
  (soprano sienna, alto bruise purple, tenor verdigris, bass ochre — the
  categorical palette in order). Upcoming holes are outlines (punched, unlit);
  the hole crossing the playhead fills solid (sounding); passed holes stay
  filled at half opacity. Time reads left-to-right with zero instruction.
  Fermatas are wide slots. Phrase ends are perforation lines across the tape.
  Ornament eighths are visibly smaller holes between the quarters — the
  figuration layer, legible as such.
- **The crank** protrudes from the right side, drawn with hatched depth, and
  visibly turns while music plays. Its angular velocity IS the master clock.
- **The plate** is an engraved maker's plate that updates per piece:
  `No. 0214 · G MAJOR · 3 PHRASES · 0 VIOLATIONS`. The number is the seed:
  piece No. 214 is the same piece for every visitor forever — the library is
  infinite AND indexed (deep-linkable: `?piece=214`). "0 VIOLATIONS" is not
  copy; the ported checker actually runs on every piece before it plays.
- **The motor** is a brass toggle (`MOTOR`) that auto-cranks at 66 BPM for
  people who just want to listen. Play button semantics, machine's diction.
- **BPM counter**: engraved odometer digits, live.

## Interaction model

- **Desktop:** mouse wheel over the machine spins the crank — each wheel tick
  adds angular velocity to a flywheel with friction. Stop scrolling and it
  coasts, winds down, and the music slows to a stop like a dying music box
  (audio releases gracefully, no click). Wheel input is captured ONLY when
  the pointer is over the machine; the page scrolls normally otherwise.
  Scroll-hijack is the #1 way this kind of page becomes hateful — the machine
  must never trap a reader trying to pass by. Escape hatch: machine occupies
  less than a viewport; a `hold shift to scroll past` affordance is NOT
  needed if capture is strictly pointer-over.
- **Mobile:** drag on the machine (circular or vertical) turns the crank;
  drag elsewhere scrolls the page. The crank handle is thumb-sized,
  bottom-right.
- **Motor + crank:** cranking while the motor runs takes over; release
  returns to motor tempo. BPM clamps to 40–140.
- **Backward cranking plays the piece backward** (retrograde). The plate
  temporarily reads `RETROGRADE` in dried rose. Stretch goal; cheap if the
  scheduler is position-driven, cut without grief if not.
- **First gesture = audio unlock.** WebAudio can't start without user input;
  the crank is inherently a gesture, so the machine is silent-but-turnable
  until the browser allows sound. No "click to enable audio" modal ever.
- **Export:** a small `export .mid` under the plate — Symphonia precedent,
  nearly free to build, and turns visitors into users.

## The engine, ported (the "infinite" claim)

The whole Python engine compiles to a single TypeScript module with no
dependencies (~1,100 lines: melody planner, bass beam search, inner-voice
search, chord vocabulary, ornament applier, and BOTH checkers) plus the three
mined tables (~300–500 KB JSON, lazy-loaded on first interaction). Every
piece is composed in-browser in ~30 ms and verified in-browser before it
sounds. The plate's `0 VIOLATIONS` is a live claim, checked by the same laws
that were calibrated against the Bach corpus. Seed = plate number, so the
infinite library is deterministic and shareable.

Pieces chain forever: piece ends → breath → next number composes during the
gap (30 ms into a 300 ms breath; no seam).

## Audio (port of perform.py)

Four additive voices (8 harmonics, per-voice brightness/detune/pan), delayed
vibrato, fermata swells, breaths between phrases, final ritardando per piece,
and a small Schroeder reverb (combs + allpasses — the Python one, note for
note). Master clock is tape position, driven by crank velocity; a lookahead
scheduler (~25 ms tick, ~120 ms horizon) re-reads BPM continuously so tempo
changes feel mechanical, not quantized.

## Placement & integration

- Native React client component (`HurdyGurdy.tsx` + module css) in
  dash_website, embedded at the top of the existing
  `counterpoint-hurdy-gurdy` note — the machine demonstrates, the existing
  FABE story explains. Not an iframe: native inherits both themes and the
  context-aware cursor.
- **Both themes, automatically:** all drawing reads CSS custom properties at
  render time (canvas samples computed style; re-samples on theme change).
  Electric = engraving on dark iron. Candlelight = ink on paper. The patent
  drawing survives both because it is only ever lines and flat fills.
- Cursor integration hook: over the machine, the site cursor could become the
  crank glyph (⭮) — one-line addition to their cursor map, optional.
- A standalone single-file `index.html` build also lives in the repo for
  anyone who clones it — same TS module, no site dependencies.

## Copy discipline

The blog page carries the editorial framing (the numbered library reads as
Borges's Library of Babel with the nonsense filtered out — every valid
chorale already at some address; cranking is looking-up). The standalone
demo keeps one terse, TRUTHFUL sentence:

> An endless, numbered library of chorales, each composed and verified in
> your browser. Piece No. N is the same for everyone who finds it; the
> unheard music is further out.

(Correction, 2026-07-18: the earlier "a chorale that has never been heard"
was false — determinism means the low numbers everyone shares. The unheard
music is only at unreached addresses.) Part labels are terse or absent. The crank gets `scroll to turn` (the one
non-obvious affordance); the playhead, plate, and motor explain themselves.
No poetic appositives, no explaining what a music box is. (Dash, reviewing
the first mockup: decorative caption flourishes read as LLM text — trust
the visualization.)

## Risks, named

1. **The visualization is the project.** (Dash's warning, and correct.) The
   tape must read as music at a glance at 720px. Mitigation: mockup phase
   with real piece data before any engine porting; kill-criteria = a
   stranger can't tell the tape is the score within five seconds.
2. **Scroll capture.** Strictly pointer-over; test with a reader who wants
   to ignore the machine.
3. **Porting drift.** The TS engine must produce *identical* pieces to the
   Python engine for the same seed (same RNG algorithm required — port
   Python's Mersenne Twister usage or switch both to a shared PRNG like
   mulberry32; decision: give the TS engine its own seeded PRNG and its own
   numbering — cross-language identity is not worth the constraint, but
   in-browser determinism is non-negotiable).
4. **Mobile audio.** iOS unlock quirks, background-tab throttling. The
   flywheel must pause cleanly when the tab hides.
5. **Perf.** One canvas, one redraw per frame, holes are rects/circles —
   trivial. The engine's 30 ms compose runs during breaths, never mid-note.

## Build order (after sign-off)

1. Mockup → this document's companion (`instrument/mockup/`) — judge the look.
2. Engine port + in-browser checker + golden tests against Python outputs' stats.
3. Audio port; A/B against perform.py renders by ear.
4. Crank physics + scheduler; tape renderer.
5. Integration into dash_website + handoff to the publishing agent.


---

## As shipped (2026-07-18) — deltas from this concept

The concept above is the record of intent; the shipped machine differs where
Dash's play-testing taught us better:

- **No FIG. 1, no annotations, no "0 VIOLATIONS."** The patent-drawing
  *vocabulary* (hatching, rules, engraved mono) survived; the patent-drawing
  *framing* didn't earn its place once the machine read as a music box on
  its own. Jargon left the plate. Eleven words of text remain.
- **Front crank, not side crank.** A flat frontal drawing cannot honestly
  depict a side crank (it would be edge-on). Shipped: barrel-organ front
  crank — bolted bearing plate, arm, grip, dashed swing path — inside the
  control row. Drag tracks the finger's angle around the hub (jog-wheel);
  release hands off to the flywheel. One revolution = two beats, the same
  gearing as the motor's visual.
- **Tape x-axis is performance time.** Fermata chords draw twice as wide and
  the playhead moves linearly. (Drawn-width ≠ heard-length was the single
  most disorienting bug of play-testing.)
- **Pieces crossfade** (~1.4 s release into the reverb while the next piece
  attacks) instead of breathing in silence — radio, not hymnal.
- **Tempo slider** (40–120) sets the motor; cranking overrides temporarily.
- **Capture is crank-only.** The cabinet face scrolls the page; only the
  crank captures wheel/drag. (The concept's "pointer-over the machine"
  capture was still too grabby in practice.)
- **Mobile:** under 560px the plate takes its own row; coarse pointers get
  44px-floor targets and a fattened slider thumb.
- **SPA teardown:** mount returns a dispose function; navigation silences
  the machine.
