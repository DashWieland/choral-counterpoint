#!/usr/bin/env python3
"""
Mine the outer-voice oracle from the music21 Bach chorale corpus.

For every consecutive pair of soprano onsets, record what bass pitch-class
Bach writes against the arrival soprano note, conditioned on the soprano
transition. Granularity is soprano onsets (one chord per melody note) —
the same granularity at which harmonization happens.

Table layout (all pitch classes are semitone offsets 0-11 relative to tonic):
{
  "transitions": { "<mode>|<s_from>><s_to>|<cad>": {"<b_from>><b_to>": count} },
  "arrivals":    { "<mode>|<s_to>|<cad>":          {"<b_to>": count} },
  "openings":    { "<mode>|<s_pc>":                {"<b_pc>": count} },
  "meta":        { chorales, transitions, ... }
}
cad = 1 when the arrival soprano note carries a fermata (phrase-final chord).

Output: .claude/skills/choral-counterpoint/data/outer_voice_table.json
"""
import json, sys
from collections import Counter, defaultdict
from pathlib import Path

from music21 import corpus

OUT = Path(__file__).resolve().parents[1] / '.claude' / 'skills' / 'choral-counterpoint' / 'data' / 'outer_voice_table.json'

def soprano_bass_seq(chorale):
    """[(s_midi, b_midi, fermata, phrase_start)] at soprano onsets, or None."""
    parts = chorale.parts
    if len(parts) != 4:
        return None
    flat = [p.flatten().notesAndRests.stream() for p in parts]
    def mean_pitch(f):
        ns = list(f.notes)
        return sum(n.pitch.midi for n in ns) / len(ns) if ns else 0
    flat.sort(key=mean_pitch, reverse=True)
    sop, bass = flat[0], flat[3]
    seq = []
    next_is_phrase_start = True
    for n in sop.notes:
        b = bass.getElementAtOrBefore(n.offset)
        if b is None or b.isRest:
            return None
        if b.offset + b.quarterLength < n.offset + 1e-6:
            return None
        fermata = any(type(e).__name__ == 'Fermata' for e in n.expressions)
        seq.append((n.pitch.midi, b.pitch.midi, fermata, next_is_phrase_start))
        next_is_phrase_start = fermata
    return seq

def main(limit=10**9, exclude=None, out=None):
    """exclude: list of title substrings to leave out (for clean-room evals);
    out: alternative output path."""
    transitions = defaultdict(Counter)
    arrivals = defaultdict(Counter)
    openings = defaultdict(Counter)
    n_ok = n_skip = n_trans = 0
    for i, chorale in enumerate(corpus.chorales.Iterator()):
        if i >= limit:
            break
        title = (chorale.metadata.title or '')
        if exclude and any(x.lower() in title.lower() for x in exclude):
            n_skip += 1
            continue
        try:
            seq = soprano_bass_seq(chorale)
            k = chorale.analyze('key')
        except Exception:
            n_skip += 1
            continue
        if seq is None:
            n_skip += 1
            continue
        tonic_pc, mode = k.tonic.pitchClass, k.mode
        n_ok += 1
        rel = lambda m: (m - tonic_pc) % 12
        for j, (s, b, ferm, start) in enumerate(seq):
            if start:
                openings[f"{mode}|{rel(s)}"][str(rel(b))] += 1
            if j == 0:
                continue
            ps, pb = seq[j-1][0], seq[j-1][1]
            cad = 1 if ferm else 0
            transitions[f"{mode}|{rel(ps)}>{rel(s)}|{cad}"][f"{rel(pb)}>{rel(b)}"] += 1
            arrivals[f"{mode}|{rel(s)}|{cad}"][str(rel(b))] += 1
            n_trans += 1
    dest = Path(out) if out else OUT
    dest.parent.mkdir(parents=True, exist_ok=True)
    json.dump({
        'transitions': {k: dict(v) for k, v in transitions.items()},
        'arrivals': {k: dict(v) for k, v in arrivals.items()},
        'openings': {k: dict(v) for k, v in openings.items()},
        'meta': {'chorales': n_ok, 'skipped': n_skip, 'transitions': n_trans,
                 'granularity': 'soprano onsets', 'pc_encoding': 'semitones above tonic'},
    }, open(dest, 'w'), indent=1)
    print(f"mined {n_ok} chorales ({n_skip} skipped), {n_trans} transitions -> {dest}")

if __name__ == '__main__':
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 10**9)
