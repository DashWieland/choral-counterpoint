#!/usr/bin/env python3
"""
Mine Bach's soprano habits: interval transitions and cadence formulas.

- transitions: P(next interval | previous interval bucket, position in phrase)
  intervals in semitones, capped to [-7, 7]; buckets: step/skip/leap x sign
- cadences:  the last three scale degrees into every fermata, as formulas
- phrase_openings: first scale degree of each phrase

Output: .claude/skills/choral-counterpoint/data/melody_table.json
"""
import json, sys
from collections import Counter, defaultdict
from pathlib import Path
from music21 import corpus

OUT = Path(__file__).resolve().parents[1] / '.claude' / 'skills' / 'choral-counterpoint' / 'data' / 'melody_table.json'

def bucket(iv):
    if iv == 0: return 'rep'
    s = 'u' if iv > 0 else 'd'
    a = abs(iv)
    return s + ('1' if a <= 2 else '2' if a <= 4 else '3')

def main(limit=10**9):
    trans = defaultdict(Counter)
    cadences = defaultdict(Counter)
    openings = defaultdict(Counter)
    n_ok = 0
    for i, chorale in enumerate(corpus.chorales.Iterator()):
        if i >= limit:
            break
        parts = chorale.parts
        if len(parts) != 4:
            continue
        try:
            k = chorale.analyze('key')
        except Exception:
            continue
        flat = [p.flatten().notesAndRests.stream() for p in parts]
        def mean_pitch(f):
            ns = list(f.notes)
            return sum(n.pitch.midi for n in ns) / len(ns) if ns else 0
        flat.sort(key=mean_pitch, reverse=True)
        sop = [n for n in flat[0].notes]
        if not sop:
            continue
        tonic_pc, mode = k.tonic.pitchClass, k.mode
        rel = lambda m: (m - tonic_pc) % 12
        n_ok += 1
        # split into phrases at fermatas
        phrase = []
        phrases = []
        for n in sop:
            phrase.append(n.pitch.midi)
            if any(type(e).__name__ == 'Fermata' for e in n.expressions):
                phrases.append(phrase)
                phrase = []
        if phrase:
            phrases.append(phrase)
        for ph in phrases:
            if len(ph) < 3:
                continue
            openings[mode][str(rel(ph[0]))] += 1
            if len(ph) >= 3:
                cadences[mode][','.join(str(rel(p)) for p in ph[-3:])] += 1
            for j in range(2, len(ph)):
                prev_iv = ph[j-1] - ph[j-2]
                iv = max(-7, min(7, ph[j] - ph[j-1]))
                frac = j / len(ph)
                pos = 'early' if frac < 0.4 else 'mid' if frac < 0.8 else 'late'
                trans[f"{mode}|{bucket(prev_iv)}|{pos}"][str(iv)] += 1
    OUT.parent.mkdir(parents=True, exist_ok=True)
    json.dump({
        'transitions': {k2: dict(v) for k2, v in trans.items()},
        'cadences': {k2: dict(v) for k2, v in cadences.items()},
        'phrase_openings': {k2: dict(v) for k2, v in openings.items()},
        'meta': {'chorales': n_ok},
    }, open(OUT, 'w'), indent=1)
    print(f"mined {n_ok} chorales -> {OUT}")
    for mode in ('major', 'minor'):
        top = Counter(cadences[mode]).most_common(6)
        print(f"  {mode} cadence formulas: " +
              "  ".join(f"[{k2}]x{c}" for k2, c in top))

if __name__ == '__main__':
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 10**9)
