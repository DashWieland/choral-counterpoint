#!/usr/bin/env python3
"""
Outer-voice oracle: what bass does Bach write against this soprano?

Mined from the music21 Bach chorale corpus at soprano-onset granularity
(tools/mine_oracle.py in the auto_compose repo rebuilds the table).

Two modes — the two directions of the veto loop:

PROPOSE   python oracle_outer.py melody.json
  For each melody transition, print Bach's bass responses ranked by corpus
  frequency. YOU then veto for line shape: greedy-chaining the top choice
  produces a root-position seesaw (mode collapse) — never do that.

VETO      python oracle_outer.py melody.json --bass D3 G2 ...
  Score a proposed bass line. Any transition with zero corpus support is
  flagged: rare-in-corpus is evidence you are wrong, not distinctive.

melody.json: {"tonic":"F","mode":"major","soprano":["F4",...],"fermatas":[4,8]}
fermatas are 1-indexed melody positions that end phrases (cadence targets).
Pitch classes print as scale degrees relative to the tonic (b2, #4, etc.).
"""
import json, sys
from pathlib import Path

PC = {'C':0,'C#':1,'Db':1,'D':2,'D#':3,'Eb':3,'E':4,'E#':5,'Fb':4,'F':5,'F#':6,
      'Gb':6,'G':7,'G#':8,'Ab':8,'A':9,'A#':10,'Bb':10,'B':11,'B#':0,'Cb':11}
DEG = {0:'1',1:'b2',2:'2',3:'b3',4:'3',5:'4',6:'#4',7:'5',8:'b6',9:'6',10:'b7',11:'7'}
IV  = {0:'P8',1:'m2',2:'M2',3:'m3',4:'M3',5:'P4',6:'TT',7:'P5',8:'m6',9:'M6',10:'m7',11:'M7'}

def midi(name):
    i = 1
    while i < len(name) and name[i] in '#b':
        i += 1
    return 12 * (int(name[i:]) + 1) + PC[name[:i]]

TABLE = json.load(open(Path(__file__).resolve().parent.parent / 'data' / 'outer_voice_table.json'))

def ranked(counter, top=6):
    total = sum(counter.values())
    return [(k, c, 100 * c / total) for k, c in
            sorted(counter.items(), key=lambda kv: -kv[1])[:top]], total

def main():
    d = json.load(open(sys.argv[1]))
    tonic_pc, mode = PC[d['tonic']], d.get('mode', 'major')
    sop = [midi(p) for p in d['soprano']]
    ferm = set(d.get('fermatas', ()))
    rel = lambda m: (m - tonic_pc) % 12
    bass = None
    if '--bass' in sys.argv:
        i = sys.argv.index('--bass')
        bass = [midi(p) for p in sys.argv[i+1:]]
        if len(bass) != len(sop):
            sys.exit(f"bass has {len(bass)} notes, melody has {len(sop)}")

    # opening
    op = TABLE['openings'].get(f"{mode}|{rel(sop[0])}", {})
    if bass is None:
        opts, total = ranked(op)
        print(f"note 1 (deg {DEG[rel(sop[0])]}, opening) — bass degrees, n={total}:")
        for k, c, pct in opts:
            print(f"    deg {DEG[int(k)]:>3}  {pct:4.0f}%  ({c})")
    else:
        c = op.get(str(rel(bass[0])), 0)
        flag = "  << ZERO SUPPORT" if c == 0 else ""
        print(f"note 1: bass deg {DEG[rel(bass[0])]}  support {c}{flag}")

    zero = 0
    for j in range(1, len(sop)):
        cad = 1 if (j + 1) in ferm or j == len(sop) - 1 else 0
        tkey = f"{mode}|{rel(sop[j-1])}>{rel(sop[j])}|{cad}"
        trans = TABLE['transitions'].get(tkey, {})
        akey = f"{mode}|{rel(sop[j])}|{cad}"
        arr = TABLE['arrivals'].get(akey, {})
        head = (f"note {j+1} (deg {DEG[rel(sop[j-1])]}->{DEG[rel(sop[j])]}"
                f"{', CADENCE' if cad else ''})")
        if bass is None:
            opts, total = ranked(trans)
            print(f"{head} — bass responses (from>to), n={total}:")
            for k, c, pct in opts:
                f_, t_ = (int(x) for x in k.split('>'))
                vert = IV[(rel(sop[j]) - t_) % 12]
                print(f"    {DEG[f_]:>3} > {DEG[t_]:<3} {pct:4.0f}%  ({c})   vertical vs melody: {vert}")
        else:
            bkey = f"{rel(bass[j-1])}>{rel(bass[j])}"
            c = trans.get(bkey, 0)
            n = sum(trans.values())
            am = arr.get(str(rel(bass[j])), 0)
            if c == 0:
                zero += 1
                alt = ", ".join(f"{DEG[int(k.split('>')[1])]}({v})" for k, v, _ in ranked(trans, 3)[0])
                print(f"{head}: bass {DEG[rel(bass[j-1])]}>{DEG[rel(bass[j])]}  "
                      f"support 0/{n}  << ZERO SUPPORT (arrival marginal {am}; Bach's moves: {alt})")
            else:
                print(f"{head}: bass {DEG[rel(bass[j-1])]}>{DEG[rel(bass[j])]}  support {c}/{n}")
    if bass is not None:
        print(f"\n{zero} zero-support transitions" if zero else "\nall transitions have corpus support")
        sys.exit(1 if zero else 0)

if __name__ == '__main__':
    main()
