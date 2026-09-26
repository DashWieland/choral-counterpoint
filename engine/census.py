#!/usr/bin/env python3
"""
Census of the Python engine: compose a fixed sample and report what a
listener would meet there. The sample is every tonic and mode, phrase
counts 2 to 4, seeds 1..60 (2,520 pieces).

    python engine/census.py [seeds=60]

Each piece must end on the tonic in soprano and bass, keep the soprano in
range, and be in bar form: the Stollen sung twice note for note, ornaments
included, phrases of 6 to 8 chords, and one climax. compose() already
guarantees no checker violations.
"""
import collections, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / '.claude' / 'skills' / 'choral-counterpoint' / 'scripts'))
import compose, score_io

VOICES = score_io.VOICES
midi = score_io.midi_num

def grid(events):
    """A voice's sounding pitch at every eighth."""
    return [midi(p) for p, ln in events for _ in range(ln)]

def main(seeds=60):
    t = collections.Counter()
    broken = collections.Counter()
    t0 = time.time()
    for tonic in ('C', 'D', 'Eb', 'F', 'G', 'A', 'Bb'):
        for mode in ('major', 'minor'):
            for phrases in (2, 3, 4):
                for seed in range(1, seeds + 1):
                    t['n'] += 1
                    p = compose.compose(tonic=tonic, mode=mode, phrases=phrases, seed=seed)
                    if p is None:
                        t['none'] += 1
                        continue
                    meta = p['_meta']
                    t['drafts'] += meta['attempt'] + 1
                    t['first'] += meta['attempt'] == 0
                    t['warnings'] += meta['warnings']
                    sk = {v: [midi(x) for x in p['skeleton'][v]] for v in VOICES}
                    sop, bass, tpc = sk['soprano'], sk['bass'], score_io.PC[tonic]
                    t['chords'] += len(sop)
                    if (sop[-1] - tpc) % 12 or (bass[-1] - tpc) % 12:
                        broken['off the tonic'] += 1
                    if any(m < 60 or m > 81 for m in sop):
                        broken['soprano out of range'] += 1
                    ends = p['skeleton']['fermatas']
                    lens = [f - (ends[i - 1] if i else 0) for i, f in enumerate(ends)]
                    if any(not 6 <= x <= 8 for x in lens):
                        broken['a phrase outside the hymn meters'] += 1
                    if sop.count(max(sop)) != 1:
                        broken['the climax sounds more than once'] += 1
                    L = p.get('stollen', 0)
                    if not L or L not in ends or 2 * L not in ends:
                        broken['no Stollen'] += 1
                        continue
                    if any(sk[v][:L] != sk[v][L:2 * L] for v in VOICES):
                        broken['the repeat is not the Stollen chord for chord'] += 1
                    if any(g[:2 * L] != g[2 * L:4 * L] for g in (grid(p['voices'][v]) for v in VOICES)):
                        broken['the repeat is not the Stollen ornament for ornament'] += 1
    kept = t['n'] - t['none']
    print(f"{t['n']} pieces: first draft kept {100 * t['first'] / kept:.1f}%, "
          f"{t['drafts'] / kept:.2f} drafts per piece, {t['none']} none, "
          f"{t['chords'] / kept:.1f} chords per piece, {t['warnings'] / kept:.2f} warnings per piece, "
          f"{(time.time() - t0) / t['n']:.2f} s per piece")
    print('every piece in bar form, literal repeat, on the tonic and in range' if not broken
          else 'BROKEN: ' + ', '.join(f'{k} {v}' for k, v in broken.items()))
    return 1 if broken or t['none'] else 0

if __name__ == '__main__':
    sys.exit(main(int(sys.argv[1]) if len(sys.argv) > 1 else 60))
