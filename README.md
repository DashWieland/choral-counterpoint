# choral-counterpoint

An engine that composes verified four-part chorales without end, and without a language model in the loop. It harmonizes in the style of Bach and writes species counterpoint in the style of Fux, over any key, mode, melody, and tempo. It ships three ways: a Python composer and server, a dependency-free JavaScript port, and a crankable web music box — the **[Choral Hurdy-Gurdy](https://apophenia.blog/work/choral-hurdy-gurdy)** — that composes a new, never-before-heard chorale for every turn of the handle.

It began as a Claude Code *skill*: a rulebook and a set of checkers a language model used to compose one careful piece at a time. That skill is still here, under `.claude/skills/`, and it is where the musical knowledge is authored. But the checkers, the corpus oracle, and the mined taste tables turned out to be enough to compose without the model at all — search the bass lines Bach would actually write, fill the inner voices under the voice-leading laws as hard constraints, verify every note, keep only what survives. What comes out is infinite by construction and fully deterministic. Piece No. *N* is the same piece for everyone, forever.

## Why these styles work when "write me a song" doesn't

These styles are unusual in one crucial way: they are among the only creative domains where "good" is *checkable*. The rules — no parallel fifths, resolve the leading tone, keep voices in range — are explicit enough that a program can verify every note, and the taste that rules can't capture can be measured statistically against the 371 chorales Bach actually wrote. So instead of generating something that merely *sounds* plausible, composition becomes a loop with teeth: propose notes, catch every rule violation, cross-examine every choice against what Bach did in the same situation, revise, and keep only work that survives. Musical judgment still does real work — a beam search scored for line shape, or an LLM's ear — but it is *governed*, the way an engineer's judgment is governed by tests.

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

engine/                           # fully automatic composition (no LLM in the loop)
├── compose.py                    # melody planner → oracle-governed bass beam search
│                                 #   → inner-voice search → verify → ornament (~30 ms/piece)
└── serve.py                      # HTTP server: /compose, /compose.mid, /next
                                  #   (compose-ahead buffer for instruments)

instrument/web/                   # the Choral Hurdy-Gurdy: the engine ported to JS,
│                                 #   a WebAudio choir, and a crankable music box —
│                                 #   live at apophenia.blog/work/choral-hurdy-gurdy
│                                 #   (CONCEPT.md alongside is the design record)

tools/                            # rebuild / validation harnesses (need music21)
├── mine_oracle.py                # regenerates the oracle table from the corpus
├── mine_ornaments.py             # regenerates Bach's figuration rates
├── validate_checker.py           # runs the checker over Bach himself (false-alarm test)
└── perform.py                    # choir-ish synthesizer: score JSON → WAV

out/                              # the FABE chorale + the packaged skill
```

Three layers, one discipline:

1. **The skill** (`.claude/skills/`) is where the musical knowledge is authored — the checkers, the oracle, the mined tables, and an **ornamentation layer** (`ornament.py` decorates a verified skeleton with passing tones, neighbors, suspensions, and cadential anticipations at rates mined from Bach's own figuration, rejecting any candidate that would break a rule; `check_ornaments.py` verifies the result).
2. **The engine** (`engine/`) composes with no model in the loop — the oracle proposes bass moves (zero-support moves excluded), beam searches take the composer's veto role with line-shape scoring, the checkers are the final gate, then ornamentation. ~30 ms per piece; batch-validated 24/24 clean across six keys and both modes. `serve.py` exposes it over HTTP with a compose-ahead buffer.
3. **The instrument** (`instrument/web/`) is the whole engine ported to dependency-free JavaScript plus a WebAudio choir, running as an infinite, crankable music box. 200/200 pieces verified clean in-browser at ~12 ms each; live at [apophenia.blog/work/choral-hurdy-gurdy](https://apophenia.blog/work/choral-hurdy-gurdy).

## The three safeguards

1. **Rule checkers.** Four voices generate six simultaneous voice pairs, and hand-checking reliably covers five of them — the missed parallel rotates. The checker has no attention ceiling. It was calibrated by running it on the Bach corpus itself and demanding near-silence: rules Bach trips at material rates (inner-voice crossing, spacing, hidden fifths) are warnings; parallel fifths and octaves are hard violations. Residual: 0.24 violations/chorale on Bach, every category inspected and explained.

2. **The corpus oracle.** Chord symbols turned out to be the wrong representation for "what Bach would do" — the signal lives in the outer voices. The oracle maps every soprano transition to Bach's bass responses, ranked by frequency, at the granularity you actually compose at.

3. **The veto loop.** The oracle proposes (greedy-chaining its top picks collapses to a root-position seesaw — don't). The composer vetoes for line shape. The corpus vetoes back: a bass move with zero support in ~350 chorales is evidence you're wrong, not evidence you're interesting. The checker is the final gate.

## Install

Copy `.claude/skills/choral-counterpoint/` into your project's `.claude/skills/` directory (or drop the packaged `out/choral-counterpoint.skill` zip into a client that accepts skill packages). The scripts need Python 3; `render_midi.py` needs `mido`. The `tools/` harnesses additionally need `music21` (only for rebuilding/validating — the skill itself ships with the mined table).

## The FABE chorale

`out/fabe_chorale.{json,mid,wav}` is the first piece composed with the skill: a three-phrase chorale in D minor, signed by Claude with the motif **F–A–B♭–E** — which spells *Fable*, in German note-nomenclature, after the model that wrote it. The trick is Bach's own; he wove B–A–C–H into the unfinished fugue that closes *The Art of Fugue*.

## License

MIT
