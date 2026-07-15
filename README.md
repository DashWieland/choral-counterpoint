# choral-counterpoint

A [Claude Code](https://claude.com/claude-code) skill that composes **verified choral counterpoint**: strict two-voice species counterpoint in the style of Fux, and four-voice chorale harmonization in the style of J.S. Bach — for any key, mode, melody, and tempo.

## Why these styles work when "write me a song" doesn't

These styles are unusual in one crucial way: they are among the only creative domains where "good" is *checkable*. The rules — no parallel fifths, resolve the leading tone, keep voices in range — are explicit enough that a program can verify every note, and the taste that rules can't capture can be measured statistically against the 371 chorales Bach actually wrote. So instead of a model generating something that merely *sounds* plausible, composition becomes a loop with teeth: propose notes, have a program catch every rule violation, cross-examine every choice against what Bach did in the same situation, revise, and only present work that survives. The model's musical judgment still does real work — but it is *governed*, the way an engineer's judgment is governed by tests.

## What's in the box

```
.claude/skills/choral-counterpoint/
├── SKILL.md                      # the skill: workflows, rules, governance loop
├── scripts/
│   ├── check_species1.py         # two-voice rule checker (Fux, first species)
│   ├── check_chorale.py          # four-voice SATB voice-leading checker
│   ├── oracle_outer.py           # "what bass would Bach write?" — corpus oracle
│   └── render_midi.py            # composition JSON → MIDI at any BPM
└── data/
    └── outer_voice_table.json    # 16,852 outer-voice transitions from 345 chorales

tools/                            # rebuild / validation harnesses (need music21)
├── mine_oracle.py                # regenerates the oracle table from the corpus
└── validate_checker.py           # runs the checker over Bach himself (false-alarm test)

out/                              # example compositions (JSON + MIDI)
```

## The three safeguards

1. **Rule checkers.** Four voices generate six simultaneous voice pairs, and hand-checking reliably covers five of them — the missed parallel rotates. The checker has no attention ceiling. It was calibrated by running it on the Bach corpus itself and demanding near-silence: rules Bach trips at material rates (inner-voice crossing, spacing, hidden fifths) are warnings; parallel fifths and octaves are hard violations. Residual: 0.24 violations/chorale on Bach, every category inspected and explained.

2. **The corpus oracle.** Chord symbols turned out to be the wrong representation for "what Bach would do" — the signal lives in the outer voices. The oracle maps every soprano transition to Bach's bass responses, ranked by frequency, at the granularity you actually compose at.

3. **The veto loop.** The oracle proposes (greedy-chaining its top picks collapses to a root-position seesaw — don't). The composer vetoes for line shape. The corpus vetoes back: a bass move with zero support in ~350 chorales is evidence you're wrong, not evidence you're interesting. The checker is the final gate.

## Install

Copy `.claude/skills/choral-counterpoint/` into your project's `.claude/skills/` directory (or drop the packaged `out/choral-counterpoint.skill` zip into a client that accepts skill packages). The scripts need Python 3; `render_midi.py` needs `mido`. The `tools/` harnesses additionally need `music21` (only for rebuilding/validating — the skill itself ships with the mined table).

## Example

`out/fabe_chorale.{json,mid}` is a three-phrase chorale in D minor composed by Claude with this skill, signed with the motif **F–A–B♭–E** — *Fable* in German note-spelling, after the model that wrote it. `out/demo_*` are the original end-to-end validation pieces.

## Provenance

Built in July 2026 by Claude (Fable 5) working with Dash Wieland, as the artifact of a research session on whether an LLM can scaffold itself into a compositional discipline: encode the rules, build the verifier, mine the corpus for taste, and measure against Bach with clean-room evaluation. The chorale checker and oracle were rebuilt from scratch from the `music21` Bach corpus and re-validated.

## License

MIT
