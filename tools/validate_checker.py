#!/usr/bin/env python3
"""
False-alarm run: execute check_chorale.check() on the Bach chorale corpus.
A correct checker should be near-silent on Bach (a handful of genuine,
famous parallels exist; every surviving VIOLATION must be listed and eyeballed).

Usage: python tools/validate_checker.py [max_chorales]
"""
import sys, importlib.util
from collections import Counter
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1] / '.claude' / 'skills' / 'choral-counterpoint' / 'scripts' / 'check_chorale.py'
spec = importlib.util.spec_from_file_location('check_chorale', SKILL)
cc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cc)

from music21 import corpus

VOICE_NAMES = ['soprano', 'alto', 'tenor', 'bass']

def extract(chorale):
    """SATB at onset-union granularity. Returns (voices, tonic, mode, fermatas) or None."""
    parts = chorale.parts
    if len(parts) != 4:
        return None
    flat = [p.flatten().notesAndRests.stream() for p in parts]
    # assign SATB by average pitch, not by part order in the file
    def mean_pitch(f):
        ns = list(f.notes)
        return sum(n.pitch.midi for n in ns) / len(ns) if ns else 0
    flat.sort(key=mean_pitch, reverse=True)
    onsets = sorted({n.offset for f in flat for n in f.notes})
    voices = {name: [] for name in VOICE_NAMES}
    fermatas = []
    for idx, off in enumerate(onsets):
        chord = []
        fermata_here = False
        for f in flat:
            el = f.getElementAtOrBefore(off)
            if el is None or el.isRest:
                return None      # rests: skip chorale, keep harness simple
            if el.offset + el.quarterLength < off + 1e-6:
                return None      # gap (voice not sounding here)
            chord.append(el)
            if any(type(e).__name__ == 'Fermata' for e in el.expressions):
                fermata_here = True
        for name, el in zip(VOICE_NAMES, chord):
            voices[name].append(el.pitch.midi)
        if fermata_here:
            fermatas.append(idx + 1)         # 1-indexed
    k = chorale.analyze('key')
    tonic = k.tonic.name.replace('-', 'b')
    return voices, tonic, k.mode, fermatas

def main(limit):
    n_ok = n_skip = 0
    vio = Counter()
    examples = []
    for i, chorale in enumerate(corpus.chorales.Iterator()):
        if i >= limit:
            break
        try:
            got = extract(chorale)
        except Exception as e:
            print(f"  extract error {chorale.metadata.title}: {e}", file=sys.stderr)
            n_skip += 1
            continue
        if got is None:
            n_skip += 1
            continue
        voices, tonic, mode, fermatas = got
        if tonic not in cc.PC:
            n_skip += 1
            continue
        V, W = cc.check(voices, tonic, mode, fermatas)
        n_ok += 1
        for v in V:
            rule = v.split(':')[0] if ':' in v else v.split('(')[0]
            rule = ' '.join(w for w in rule.split() if not any(c.isdigit() for c in w))
            vio[rule] += 1
            if len(examples) < 40:
                examples.append(f"{chorale.metadata.title}: {v}")
    print(f"\nchecked {n_ok} chorales ({n_skip} skipped), {sum(vio.values())} violations total")
    for rule, c in vio.most_common():
        print(f"  {c:4d}  {rule}")
    print("\nfirst examples:")
    for e in examples:
        print(f"  {e}")

if __name__ == '__main__':
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 10**9)
