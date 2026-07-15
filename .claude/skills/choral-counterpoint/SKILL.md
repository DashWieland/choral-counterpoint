---
name: choral-counterpoint
description: Compose and verify choral counterpoint — strict two-voice Fuxian species counterpoint or four-voice Bach-style chorale harmonization — for any parameters (key, mode, voices, melody, tempo). Use whenever the user asks to write counterpoint, harmonize a melody or chorale, compose in the style of Bach, Fux, or Palestrina, produce SATB/four-part/hymn writing, or any rule-governed vocal polyphony — even if they just say "write me some counterpoint" or "harmonize this tune." Always run the bundled checkers before presenting anything; never trust an unverified composition.
---

# Choral Counterpoint (species + chorale)

## What this is (for someone who doesn't know these styles)

This skill lets an AI compose two kinds of classical vocal music: **species
counterpoint** (two melodies woven together under the strict 18th-century
rules of Fux, the system Haydn, Mozart, and Beethoven trained on) and
**chorale harmonization** (four-part hymn writing in the style of J.S. Bach).
These styles are unusual in one crucial way: they are among the only creative
domains where "good" is *checkable*. The rules — no parallel fifths, resolve
the leading tone, keep voices in range — are explicit enough that a program
can verify every note, and the taste that rules can't capture can be measured
statistically against the 371 chorales Bach actually wrote. So instead of the
AI generating something that merely *sounds* plausible (what you get if you
ask it to "write a pop song" — no rulebook, no answer key, no way to be
wrong), composition here becomes a loop with teeth: propose notes, have a
program catch every rule violation, cross-examine every choice against what
Bach did in the same situation, revise, and only present work that survives.
The AI's musical judgment is still doing real work — but it is *governed*,
the way an engineer's judgment is governed by tests. That is why the output
is reliably idiomatic rather than accidentally so.

## Parameters

Every request maps onto these; pick sensible defaults for any the user omits.

| parameter | values | default |
|---|---|---|
| style | `species1` (two voices) / `chorale` (SATB) | infer; chorale if a melody to harmonize is given |
| tonic + mode | any pc; species: church modes, chorale: major/minor | D dorian / F major |
| melody | given CF or soprano; else compose/pick a standard one | Fux CF (species); compose 2 phrases (chorale) |
| position | species only: CP above or below the CF | above |
| length | species: CF length; chorale: phrases (fermata every 4–6 chords) | 11 bars / 2–4 phrases |
| tempo | BPM for the MIDI render | 72 (chorale), 96 (species) |
| output | `.json` (always) and `.mid` via render script | ask or use `out/` |

## Species-1 workflow (two voices)

1. Fix CF and mode. Standard Fux CFs: D dorian `D F E D G F A G F E D`;
   C ionian `C D F E F G A G E D C`; G mixolydian `G C B G C E D G' E C D B A G`.
2. Compose the cadence first (penultimate: M6 above / m3 below, CP takes the
   raised leading tone), then the opening (perfect consonance; unison/octave
   only if CP is below), then the middle. Plan a single climax ~60–75% through.
3. Core rules: consonances only (no 4ths!), no parallel/antiparallel/direct
   perfects, ≤3 parallel 3rds/6ths, mostly stepwise, leaps ≥4th recover by
   step opposite, stay diatonic except the cadential leading tone.
4. Write `{"mode","tonic","cf_position","cantus","counterpoint"}` JSON, run
   `python scripts/check_species1.py piece.json`, revise offending bars only,
   repeat until clean. Then render.

## Chorale workflow (SATB)

Compose **outer voices first** — the bass line against the soprano is where
the signal lives; inner voices are filler constrained by the frame.

1. Soprano: given melody, or compose one (mostly stepwise, quarter-note
   slots, fermata on each phrase-final chord; 1-indexed fermata positions).
2. Bass, one phrase at a time, under the **veto loop** (see below), using
   `python scripts/oracle_outer.py melody.json` (Bach's ranked bass responses
   for every melody transition).
3. Chords from the outer dyads (10ths/6ths → first inversions; octaves/5ths →
   root position), then alto+tenor: complete triads, double the root (never
   the leading tone), common tones held, steps preferred.
4. Verify: `python scripts/check_chorale.py piece.json` — fix violations,
   weigh warnings (doubled-LT warnings are real errors unless the passage has
   modulated). Re-check the bass with
   `python scripts/oracle_outer.py melody.json --bass <notes>` — zero-support
   transitions mean Bach never made that move: reconsider unless you can say
   exactly why this context is special.
5. Only present work that passes both. Render:
   `python scripts/render_midi.py piece.json out.mid --bpm 72`.

## The veto loop (authority arrangement — this is load-bearing)

- **The oracle proposes.** Query it before trusting instinct; instinct alone
  confabulates plausibility (measured: 2 of 3 "musical" contrary-motion ideas
  had zero corpus support).
- **You veto for line.** Never greedy-chain the oracle's top picks — that
  collapses to a 1–5–1–5 root-position seesaw. Choose among its options for
  bass-line shape: contrary motion at cadences, steps and directed arcs,
  climax placement.
- **The corpus vetoes back.** Zero support in ~350 chorales is evidence you
  are wrong, not evidence you are interesting. Rarity is only valuable above
  a support floor.
- **The checker is the final gate.** Six simultaneous voice pairs is past
  attention's reliable ceiling (measured: five-of-six, every time). Run it;
  never hand-verify only.

## Ornamentation (after the skeleton passes)

A clean skeleton can be figured the way Bach figures his:
`python scripts/ornament.py skeleton.json out.json [--density 1.0] [--seed 7]`
applies eighth-note passing tones, neighbors, suspensions, and cadential
anticipations at rates mined from the corpus (bass fills 84% of rising
thirds; alto suspends at 13% of step-down opportunities; soprano stays
plain 91% of the time). Every candidate ornament is auto-rejected if it
would break a rule or create a new surface parallel. Verify any ornamented
score with `python scripts/check_ornaments.py piece.json` — event-format
scores carry their skeleton, and the checker enforces NCT discipline
(suspensions prepared and resolved down, passing tones stepwise).

## Files

- `scripts/check_species1.py` — two-voice rule checker (JSON or 2-track MIDI)
- `scripts/check_chorale.py` — SATB checker, calibrated against the Bach
  corpus (false-alarm floor 0.24/chorale, every residual category explained)
- `scripts/oracle_outer.py` — outer-voice oracle, 16,852 transitions from 345
  chorales; propose mode and `--bass` veto mode
- `scripts/ornament.py` / `scripts/check_ornaments.py` — corpus-rate
  figuration over a verified skeleton, and its surface checker
- `scripts/render_midi.py` — JSON → MIDI at any BPM; fermatas held 2×
- `scripts/score_io.py` — shared loading for slot- and event-format scores
- `data/outer_voice_table.json`, `data/ornament_table.json` — mined tables
  (rebuild: `tools/mine_oracle.py`, `tools/mine_ornaments.py` in the repo)

## Known limits

Degrees are relative to the *global* key, so heavy modulation blurs oracle
counts and the doubled-LT check (hence warning, not violation). No chromatic
layer yet: tonicizations, secondary dominants, and chromatic passing chords
are the residual miss category (quality-level, not root-level). The checker
is deliberately a bit stricter than Bach (he leaps a 7th about once per ten
chorales; you don't get to).
