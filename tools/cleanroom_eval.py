#!/usr/bin/env python3
"""
Clean-room evaluation: harmonize a Bach chorale's soprano with the engine
and grade against Bach's own harmonization — with the test chorale REMOVED
from the oracle before composing (leave-one-out), so the engine cannot have
memorized the answer.

Usage: python tools/cleanroom_eval.py "feste Burg" [more title substrings...]

Metrics per soprano onset:
  bass-pc   engine bass pitch class == Bach's bass pitch class
  chord     engine 4-voice pc-set == Bach's 4-voice pc-set (strictest)
  harmony   pc-sets share root-third overlap (>= 2 common pcs incl. bass-or-root)

This is the open thread from the July findings: the round-3 outer-voice
oracle scored 60% exact / 73% same-harmony on a rhythmically simple melody;
"Ein' feste Burg" is the harder round-2 melody, re-run bass-first.
"""
import json, sys, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'engine'))
sys.path.insert(0, str(ROOT / '.claude' / 'skills' / 'choral-counterpoint' / 'scripts'))
sys.path.insert(0, str(ROOT / 'tools'))

from music21 import corpus
import mine_oracle
import score_io

VOICE_NAMES = ['soprano', 'alto', 'tenor', 'bass']

def extract_answer(chorale):
    """SATB pitches at soprano onsets + fermata positions, or None."""
    parts = chorale.parts
    if len(parts) != 4:
        return None
    flat = [p.flatten().notesAndRests.stream() for p in parts]
    def mean_pitch(f):
        ns = list(f.notes)
        return sum(n.pitch.midi for n in ns) / len(ns) if ns else 0
    flat.sort(key=mean_pitch, reverse=True)
    sop = flat[0]
    rows, ferm = [], []
    for idx, n in enumerate(sop.notes):
        chord = []
        for f in flat:
            el = f.getElementAtOrBefore(n.offset)
            if el is None or el.isRest:
                return None
            if el.offset + el.quarterLength < n.offset + 1e-6:
                return None
            chord.append(el.pitch.midi)
        rows.append(chord)
        if any(type(e).__name__ == 'Fermata' for e in n.expressions):
            ferm.append(idx + 1)
    return rows, ferm

def evaluate(title_sub):
    matches = []
    for chorale in corpus.chorales.Iterator():
        t = chorale.metadata.title or ''
        if title_sub.lower() in t.lower():
            matches.append((t, chorale))
    if not matches:
        print(f"no chorale matching {title_sub!r}")
        return
    # leave-one-out oracle over ALL matched settings of this melody
    tmp = tempfile.mktemp(suffix='.json')
    mine_oracle.main(exclude=[title_sub], out=tmp)
    import compose as eng
    eng.ORACLE = json.load(open(tmp))

    for t, chorale in matches:
        got = extract_answer(chorale)
        if got is None:
            print(f"{t}: skipped (rests or non-SATB)")
            continue
        rows, ferm = got
        k = chorale.analyze('key')
        tonic = k.tonic.name.replace('-', 'b')
        sop_line = [r[0] for r in rows]
        piece = eng.compose(
            tonic=tonic, mode=k.mode, seed=7, plain=True,
            given_melody={'soprano': sop_line, 'fermatas': ferm})
        if piece is None:
            print(f"{t}: engine failed to harmonize cleanly")
            continue
        eng_voices = {v: [score_io.midi_num(p) for p in piece[v]] for v in VOICE_NAMES}
        n = len(rows)
        bass_hits = chord_hits = harm_hits = 0
        detail = []
        for i in range(n):
            bach = rows[i]
            engc = [eng_voices[v][i] for v in VOICE_NAMES]
            b_ok = bach[3] % 12 == engc[3] % 12
            set_bach, set_eng = {p % 12 for p in bach}, {p % 12 for p in engc}
            c_ok = set_bach == set_eng
            h_ok = c_ok or (len(set_bach & set_eng) >= 2 and b_ok)
            bass_hits += b_ok; chord_hits += c_ok; harm_hits += h_ok
            detail.append('=' if c_ok else ('b' if b_ok else '.'))
        print(f"\n{t} [{tonic} {k.mode}], {n} onsets "
              f"(engine attempt {piece['_meta']['attempt']}, "
              f"{piece['_meta']['warnings']} warnings)")
        print(f"  bass-pc match : {bass_hits}/{n} = {100*bass_hits//n}%")
        print(f"  chord match   : {chord_hits}/{n} = {100*chord_hits//n}%")
        print(f"  harmony match : {harm_hits}/{n} = {100*harm_hits//n}%")
        print(f"  per-onset     : {''.join(detail)}   (= chord, b bass-only, . miss)")

if __name__ == '__main__':
    for sub in sys.argv[1:] or ["feste Burg"]:
        evaluate(sub)
