#!/usr/bin/env python3
"""
The composition engine: fully automatic verified chorale generation.

    python engine/compose.py --tonic D --mode minor --phrases 3 --seed 11 \
        --out out/engine_piece.json [--density 1.0] [--plain] [--melody m.json]

Pipeline (each stage governed the way the skill prescribes):
  1. melody()    — a bar-form soprano, the Stollen sung twice then the
                   Abgesang (skipped when --melody supplies one: the given
                   tune is law and is never altered; its JSON may name a
                   "stollen" of that many chords to repeat)
  2. bass_line() — beam search over the outer-voice oracle; zero-support
                   moves excluded (hard corpus veto), every proposed dyad
                   must be harmonizable by the chord vocabulary, line shape
                   scored against the greedy root-position seesaw
  3. harmonize() — alto/tenor/chord beam search: voice-leading laws as hard
                   constraints, tendency tones (leading tones up, sevenths
                   down, never doubled), chromatic chords must reach their
                   tonicization target, false relations penalized
  4. check_chorale — the final gate; failures are discarded and recomposed
  5. ornament()  — corpus-rate figuration (unless --plain)
The Stollen's repeat is literal: bass_line, harmonize and ornament may only
repeat there what they wrote the first time.

Deterministic for a given (params, seed): retry attempts anneal the bass
search with rising temperature so each attempt explores a different line.
"""
import json, math, random, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / '.claude' / 'skills' / 'choral-counterpoint' / 'scripts'
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import score_io
import check_chorale
import ornament as ornament_mod
import chords as chordlib

PC = score_io.PC
ORACLE = json.load(open(SCRIPTS.parent / 'data' / 'outer_voice_table.json'))
MELODY = json.load(open(SCRIPTS.parent / 'data' / 'melody_table.json'))

def iv_bucket(iv):
    if iv == 0: return 'rep'
    return ('u' if iv > 0 else 'd') + \
           ('1' if abs(iv) <= 2 else '2' if abs(iv) <= 4 else '3')

MAJOR = [0, 2, 4, 5, 7, 9, 11]
MINOR = [0, 2, 3, 5, 7, 8, 10]          # natural; LT handled at cadences

def scale_pcs(tonic_pc, mode):
    base = MAJOR if mode == 'major' else MINOR
    return [(tonic_pc + d) % 12 for d in base]

# ---------------------------------------------------------------- melody --
#
# Bar form (AAB), as Lutheran chorale tunes are: a Stollen of one or two
# phrases, sung twice, then an Abgesang of new phrases. The phrase count
# (2, 3, 4) sets the size of the form:
#   2 -> Stollen of 1 phrase,  Abgesang of 2 new phrases: A A B C
#   3 -> Stollen of 2 phrases, Abgesang of 2 new phrases: A B A B C D
#   4 -> Stollen of 2 phrases, Abgesang of 3 new phrases: A B A B C D E
# When the Stollen closes on the tonic, 40% of tunes are Reprisenbar: the
# Abgesang ends with the Stollen's closing phrase again, which then is the
# final cadence. So a tune has 4-8 phrases. The repeat is literal down to
# the ornaments (bass_line, harmonize and ornament copy it); the reprise is
# harmonized anew, so the ending still moves.
#
# Phrases take hymn-meter lengths (8.7, 7.6, 8.8.7, 8, 7 or 6 notes a line)
# and end in one of Bach's cadence formulas (MELODY cadences, count >= 5),
# placed as a unit and never entered by a tritone or an augmented second.
# The free notes before the formula follow the corpus transition weights
# times Bach's soprano degree profile, pulled toward the phrase's contour
# (an arch, a descent or an ascent): every legal completion is enumerated
# (at most four free notes) and one is drawn in proportion to the product of
# those weights. The tune's one highest note is placed once, at the peak of
# an Abgesang phrase. Eb and F tunes are authentic, G, A and Bb plagal, and
# C and D end on the upper tonic (C5, D5), so every tune sits inside D4-G5.
# The same design as the JS engine's planner (instrument/web/engine.js),
# with this engine's own random stream.

def js_round(x):
    """JavaScript's Math.round: halves go up (Python's round goes to even)."""
    return math.floor(x + 0.5)

def weighted_choice(rng, items, weights):
    total = sum(weights)
    r = rng.random() * total
    for x, w in zip(items, weights):
        r -= w
        if r <= 0:
            return x
    return items[-1]

def pick_w(rng, pairs):
    ok = [(x, w) for x, w in pairs if w > 0]
    return weighted_choice(rng, [x for x, _ in ok], [w for _, w in ok])

# the weight of an opening or a peak that leaves d semitones for the free
# notes to cover in k intervals: past 1.2 a note, a phrase stops being
# walkable mostly by step, and its free notes turn to thirds
TRAVEL = 1.2

def travel_w(d, k):
    excess = max(0.0, d - TRAVEL * k)
    return math.exp(-excess * excess / 2)

METERS = [((8, 7), 3),       # 8.7.8.7
          ((7, 6), 3),       # 7.6.7.6
          ((8, 8, 7), 2),    # 8.8.7
          ((8,), 2),         # long metre lines
          ((7,), 2),
          ((6,), 1)]

class Key:
    """A key's frame for the planner: degrees, ambitus, window, formulas."""
    def __init__(self, tonic_pc, mode):
        self.mode, self.tonic_pc = mode, tonic_pc
        self.major = mode == 'major'
        self.degs = MAJOR if self.major else MINOR
        t4 = 60 + tonic_pc
        self.frame = 'high' if t4 <= 62 else 'plagal' if t4 >= 67 else 'authentic'
        self.T = t4 + 12 if self.frame == 'high' else t4      # the final: Eb4..Bb4, C5, D5
        self.lo, self.hi = ((self.T - 8, self.T + 4) if self.frame == 'high' else
                            (self.T - 5, self.T + 7) if self.frame == 'plagal' else
                            (self.T, self.T + 12))
        self.floor = max(62, self.lo - 2)
        self.window = [m for m in range(self.floor, 80) if self.deg(m) in self.degs]
        self.triads = [(0, 4, 7), (7, 11, 2)] if self.major else [(0, 3, 7), (7, 11, 2), (7, 10, 2)]
        self.tonic_triad = (0, 4, 7) if self.major else (0, 3, 7)
        self.formulas = {}
        for k, c in MELODY['cadences'].get(mode, {}).items():
            if c < 5:
                continue
            degs = [int(x) for x in k.split(',')]
            if degs[0] == degs[1] == degs[2]:
                continue                                   # a static cadence (minor 0,0,0)
            self.formulas.setdefault(degs[2], []).append((degs, c))
        self.openings = MELODY['phrase_openings'].get(mode, {})
        self.mid = (self.lo + self.hi) / 2

    def deg(self, m):
        return (m - self.tonic_pc) % 12

    def in_tonic_triad(self, m):
        return self.deg(m) in self.tonic_triad

    def one_triad(self, *ms):
        return any(all(self.deg(m) in t for m in ms) for t in self.triads)

    def aug2(self, a, b):
        return (not self.major and abs(a - b) == 3 and
                {self.deg(a), self.deg(b)} == {8, 11})

    def opening(self, m):
        return self.openings.get(str(self.deg(m)), 0) + 5

# a phrase-boundary interval (last note of a phrase -> first note of the next)
def boundary_ok(K, a, b):
    d = abs(b - a)
    return d <= 9 and d != 6 and not K.aug2(a, b)

# an interval inside a phrase: unison to fourth, or a fifth
def inner_ok(K, a, b):
    d = abs(b - a)
    return (d <= 5 or d == 7) and not K.aug2(a, b)

CADENCE_FLOOR = 63                 # no fermata on C4-D4
BOUNDARY_W = {0: 4, 1: 4, 2: 4, 3: 2.2, 4: 2.2, 5: 1.5, 7: 1, 8: 0.5, 9: 0.5}

# chromatic degree -> the diatonic degree with the same letter
TWIN = {'major': {1: 0, 3: 4, 6: 5, 8: 7, 10: 11},
        'minor': {11: 10, 9: 8, 4: 3, 6: 5, 1: 2}}

# corpus weight of interval iv at phrase position j (of L) after interval p.
# The second note of a phrase has no interval before it inside the phrase
# (the corpus counts from the third note on), so it gets the early-phrase
# distribution summed over every context.
EARLY_ANY = {}
for _mode in ('major', 'minor'):
    _acc = {}
    for _k, _t in MELODY['transitions'].items():
        if _k.startswith(_mode + '|') and _k.endswith('|early'):
            for _iv, _c in _t.items():
                _acc[_iv] = _acc.get(_iv, 0) + _c
    EARLY_ANY[_mode] = _acc
_TOTALS = {}

def corpus_w(mode, j, L, p, iv):
    if j <= 1 or p is None:
        table, name = EARLY_ANY[mode], ('early-any', mode)
    else:
        frac = j / L
        posb = 'early' if frac < 0.4 else 'mid' if frac < 0.8 else 'late'
        name = f"{mode}|{iv_bucket(max(-7, min(7, p)))}|{posb}"
        table = MELODY['transitions'].get(name, {})
    tot = _TOTALS.get(name)
    if tot is None:
        tot = _TOTALS[name] = sum(table.values())
    return (table.get(str(max(-7, min(7, iv))), 0) + 0.5) / (tot + 7.5)

# Bach's soprano pitch profile: how often each scale degree carries a
# soprano onset (the oracle's arrivals), relative to an even spread over the
# seven degrees. The interval tables know nothing about degrees, so without
# this the free notes over-use the leading tone and under-use the fourth.
DEGREE_PRIOR = {}
for _mode in ('major', 'minor'):
    _c, _tot = {}, 0
    for _k, _v in ORACLE['arrivals'].items():
        _m, _d = _k.split('|')[:2]
        if _m != _mode:
            continue
        for _n in _v.values():
            _c[_d] = _c.get(_d, 0) + _n
            _tot += _n
    DEGREE_PRIOR[_mode] = {d: 7 * n / _tot for d, n in _c.items()}

def legal_motion(K, a, b, c, p, pp):
    """May note c follow b, given the previous interval p = b - a and the one
    before it, pp? (a and the intervals may be None at the start of the tune)"""
    if p is None:
        return True
    q = c - b
    aq, ap = abs(q), abs(p)
    if p == 0 and pp is not None and abs(pp) >= 5:
        # a fourth or more, then a repeated note: the recovery is still owed
        back = pp * q < 0
        if abs(pp) >= 8:
            return back and aq <= 2                      # after a sixth: step back
        return aq <= 2 or (back and aq <= 4)             # a step, or a third back
    same, opp = p * q > 0, p * q < 0
    pp_leap = pp is not None and abs(pp) >= 3
    if pp_leap and ap >= 3 and aq >= 3:
        return False                                     # three leaps in a row
    if pp_leap and ap >= 3 and pp * p > 0:               # after an arpeggio: a step,
        return aq <= 2 and (abs(pp + p) < 8 or opp)      #   turning back if it spans a sixth
    # two same-way leaps (thirds or fourths) inside one tonic or dominant
    # triad, spanning at most a sixth: C-E-G, G-B-D, E-G-C, G-C-E
    arpeggio = (same and 3 <= ap <= 5 and 3 <= aq <= 5 and
                K.one_triad(a, b, c) and abs(c - a) <= 9)
    if ap >= 8:
        return opp and aq <= 2                           # after a sixth: step back
    if ap >= 5:                                          # after a fourth or fifth
        if opp:
            return aq <= 4
        if q == 0 or arpeggio:
            return True
        return same and aq <= 2 and p == 5 and K.deg(a) == 7 and K.deg(b) == 0   # 5-1-2
    if ap >= 3:                                          # after a third
        if not same:
            return aq <= 5
        return aq <= 2 or arpeggio
    return True

def connect_ok(K, e1, e, nxt):
    """Can a phrase ending ...e1, e be followed by the (already written) phrase nxt?"""
    if not boundary_ok(K, e, nxt[0]):
        return False
    if e == nxt[0] and (e1 == e or nxt[1] == e):
        return False                                     # three in a row
    p = nxt[0] - e
    return (legal_motion(K, e, nxt[0], nxt[1], p, None) and
            legal_motion(K, nxt[0], nxt[1], nxt[2], nxt[1] - nxt[0], p))

def place_nearest(K, e0, degs):
    out = [e0]
    for d in degs[1:]:
        prev, best = out[-1], None
        for m in range(prev - 6, prev + 7):
            if K.deg(m) == d and (best is None or abs(m - prev) <= abs(best - prev)):
                best = m
        out.append(best)
    return out

def placements(K, spec):
    out = []
    limit = spec['ceil']
    for degs, count in K.formulas.get(spec['target'], []):
        for e0 in range(K.floor, limit + 1):
            if K.deg(e0) != degs[0]:
                continue
            notes = place_nearest(K, e0, degs)
            if any(m is None or m < K.floor or m > limit for m in notes):
                continue
            if any(abs(notes[j] - notes[j-1]) == 6 or abs(notes[j] - notes[j-1]) > 7
                   or K.aug2(notes[j-1], notes[j]) for j in (1, 2)):
                continue
            if notes[2] < CADENCE_FLOOR:
                continue
            final = spec['final_set']            # an empty list still restricts (as in JS)
            if final is not None and not any(m == notes[2] for m, _ in final):
                continue
            nxt = spec['next']
            if nxt and nxt != 'self' and not connect_ok(K, notes[1], notes[2], nxt):
                continue
            w = count * math.exp(-abs(e0 - spec['center']) / 5)
            if final is not None:
                w *= next(fw for m, fw in final if m == notes[2])
            out.append(((notes, degs), w))
    return out

def compose_phrase(K, spec, rng):
    """spec: L, target, prev_last, prev_prev, ceil, climax, contour_w, first,
    final_set, next ('self' | notes of the phrase that follows | None), center"""
    L = spec['L']
    F = L - 3                                # free notes at 0..F-1, formula at F..L-1
    places = placements(K, spec)
    if not places:
        return None
    for _ in range(30):
        contour = 'arch' if spec['climax'] is not None else pick_w(rng, list(spec['contour_w'].items()))
        (e0, e1, e2), _degs = pick_w(rng, places)
        fmax = max(e0, e1, e2)
        top = spec['climax'] if spec['climax'] is not None else spec['ceil']
        # a chromatic formula note must not be preceded closely by its
        # diatonic twin (Bb A B-natural)
        twins = {TWIN[K.mode][K.deg(m)] for m in (e0, e1, e2) if K.deg(m) in TWIN[K.mode]}

        # the opening note (within reach of the cadence mostly by step)
        s0c = [m for m in K.window if m <= spec['ceil'] and abs(m - e0) <= 2 * F + 1]
        if spec['first']:
            s0c = [m for m in s0c if K.in_tonic_triad(m) and m <= K.lo + 9]
        else:
            s0c = [m for m in s0c if boundary_ok(K, spec['prev_last'], m)
                   and not (m == spec['prev_last'] and spec['prev_prev'] == m)]
        if spec['next'] == 'self':
            s0c = [m for m in s0c if boundary_ok(K, e2, m)]
        if contour == 'descend':
            s0c = [m for m in s0c if m >= e0 + 3 and m >= fmax]
        elif contour == 'ascend':
            s0c = [m for m in s0c if m <= e0 - 3]
        else:
            s0c = [m for m in s0c if m <= top - 2]
        if not s0c:
            continue
        s0 = pick_w(rng, [(m, K.opening(m) *
                           ((1 if m <= K.lo + 7 else 0.5) if spec['first']
                            else BOUNDARY_W.get(abs(m - spec['prev_last']), 0)) *
                           travel_w(abs(m - e0), F)) for m in s0c])

        # the peak of an arch
        kp = P = None
        if contour == 'arch':
            peaks = ([spec['climax']] if spec['climax'] is not None else
                     [m for m in K.window if m >= s0 + 2 and m >= fmax and m >= e0 + 2
                      and m <= spec['ceil']])
            # reachable by steps (the climax may be taken by one leap, and left by one third)
            up, down = (3, 1) if spec['climax'] is not None else (1, 0)
            opts = []
            for pk in peaks:
                for k in range(1, F):
                    if pk - s0 > 2 * k + up or pk - e0 > 2 * (F - k) + down:
                        continue
                    if k >= F - 2 and K.deg(pk) in twins:
                        continue
                    rise = pk - max(s0, e0)
                    w = ((1 if spec['climax'] is not None else math.exp(-((rise - 3) ** 2) / 4)) *
                         (2 if k in (js_round(F / 2), js_round((F - 1) / 2)) else 1) *
                         travel_w(pk - s0, k) * travel_w(pk - e0, F - k))
                    opts.append(((pk, k), w))
            if not opts:
                continue
            P, kp = pick_w(rng, opts)

        notes = [None] * L
        notes[0], notes[F], notes[F + 1], notes[F + 2] = s0, e0, e1, e2
        ceil_free = min(spec['ceil'], P if contour == 'arch' else
                        s0 if contour == 'descend' else max(fmax, s0 + 2))
        strict_below = spec['climax']            # only the peak may touch the climax
        pts = [(0, s0), (kp, P), (F, e0)] if contour == 'arch' else [(0, s0), (F, e0)]

        def curve(j):
            for i in range(1, len(pts)):
                if j <= pts[i][0]:
                    (x0, y0), (x1, y1) = pts[i - 1], pts[i]
                    return y0 + (y1 - y0) * (j - x0) / (x1 - x0)
            return e0
        if not fill(K, spec, notes, F, kp, P, ceil_free, strict_below, twins, curve, rng):
            continue
        if max(notes) - min(notes) < 4:
            continue
        if spec['next'] == 'self' and not connect_ok(K, e1, e2, notes):
            continue
        return notes
    return None

def fill(K, spec, notes, F, kp, P, ceil_free, strict_below, twins, curve, rng):
    """The free notes: every completion that passes the checks, drawn in
    proportion to the product of the weights. A phrase has at most four free
    notes, so this is a few thousand paths at most."""
    L = len(notes)

    def seq(k):
        return notes[k] if k >= 0 else (spec['prev_last'] if k == -1 else None)

    def iv_into(k):
        a, b = seq(k - 1), seq(k)
        return None if a is None or b is None else b - a

    def repeats_before(j):
        return sum(1 for k in range(1, j) if notes[k] == notes[k - 1])

    def ok(j, m):
        b = notes[j - 1]
        if not inner_ok(K, b, m):
            return False
        if m == b:
            if seq(j - 2) == m:
                return False
            if repeats_before(j) >= 1:
                return False
        if j >= 3 and m == notes[j - 2] and b == notes[j - 3] and m != b:
            return False
        if abs(m - b) >= 3:
            leaps = sum(1 for k in range(1, j) if abs(notes[k] - notes[k - 1]) >= 3)
            big = sum(1 for k in range(1, j) if abs(notes[k] - notes[k - 1]) >= 5)
            if leaps >= 2 or (abs(m - b) >= 5 and big >= 1):
                return False
        return legal_motion(K, seq(j - 2), b, m, iv_into(j - 1), iv_into(j - 2))

    def seam_ok():
        e0, e1, e2 = notes[F], notes[F + 1], notes[F + 2]
        if not ok(F, e0):
            return False
        if notes[F - 1] == e0 == e1:
            return False
        if e1 == notes[F - 1] and e0 == notes[F - 2] and e0 != e1:
            return False                                   # x y x y
        if e2 == e0 and e1 == notes[F - 1] and e1 != e2:
            return False
        if sum(1 for k in range(1, L) if notes[k] == notes[k - 1]) > 2:
            return False
        return (legal_motion(K, notes[F - 1], e0, e1, e0 - notes[F - 1], iv_into(F - 1)) and
                legal_motion(K, e0, e1, e2, e1 - e0, e0 - notes[F - 1]))

    found, ws = [], []

    def rec(j, w):
        if j == F:
            if seam_ok():
                found.append(notes[1:F])
                ws.append(w)
            return
        if j == kp:
            if ok(j, P):
                notes[j] = P
                rec(j + 1, w)
                notes[j] = None
            return
        next_fixed = kp if kp is not None and j < kp else F
        goal = P if next_fixed == kp else notes[F]
        p = iv_into(j - 1)
        near_cadence = j >= F - 2
        for m in K.window:
            if abs(m - notes[j - 1]) > 7 or m > ceil_free:
                continue
            if near_cadence and K.deg(m) in twins:
                continue
            if strict_below is not None and m >= strict_below:
                continue
            if abs(goal - m) > 4 * (next_fixed - j):
                continue
            if not ok(j, m):
                continue
            iv = m - notes[j - 1]
            dev = m - curve(j)
            wm = (corpus_w(K.mode, j, L, p, iv) * math.exp(-(dev * dev) / 24.5) *
                  (DEGREE_PRIOR[K.mode].get(str(K.deg(m))) or 0.1))
            # the interval into a fixed note (the peak, or the cadence
            # formula) is part of the line too: weight it by the corpus as well
            if next_fixed == j + 1:
                wm *= corpus_w(K.mode, j + 1, L, iv, goal - m)
            notes[j] = m
            rec(j + 1, w * wm)
            notes[j] = None

    rec(1, 1.0)
    if not found:
        return False
    pick = weighted_choice(rng, found, ws)
    notes[1:F] = pick
    return True

STOLLEN_T = {
    'major': {'single': {0: 4, 7: 3, 4: 2, 2: 1}, 'first': {7: 3, 4: 3, 2: 2, 0: 1},
              'close': {0: 6, 7: 2, 4: 1, 2: 1}},
    'minor': {'single': {0: 4, 7: 3, 3: 2, 2: 1}, 'first': {7: 3, 3: 3, 2: 2, 0: 1},
              'close': {0: 6, 7: 2, 3: 2, 2: 1}},
}
ABGESANG_T = {'major': {7: 4, 9: 2, 2: 2, 4: 2, 11: 1, 5: 1},
              'minor': {3: 4, 7: 3, 10: 2, 2: 2, 5: 1}}
LETTERS = 'ABCDEFGH'

def try_tune(K, n_phrases, rng):
    S = 2 if n_phrases >= 3 else 1
    n_new = 3 if n_phrases >= 4 else 2
    mode = K.mode

    def pick_t(table, avoid=()):
        return pick_w(rng, [(d, w) for d, w in table.items() if d not in avoid])

    # the climax: the tune's one highest note
    T = K.T
    cx_opts = ([(T + 7, 3), (T + (9 if K.major else 8), 3), (T + 12, 2)] if K.frame == 'plagal' else
               [(T + (4 if K.major else 3), 3), (T + 5, 3), (T + 7, 2)] if K.frame == 'high' else
               [(T + 12, 4), (T + 14, 3), (T + (16 if K.major else 15), 2)])
    Cx = pick_w(rng, [(m, w) for m, w in cx_opts if m <= 79])

    # the cadence plan
    st_t = [pick_t(STOLLEN_T[mode]['single'])] if S == 1 else [pick_t(STOLLEN_T[mode]['first'])]
    if S == 2:
        st_t.append(pick_t(STOLLEN_T[mode]['close'], (st_t[0],)))
    reprise = st_t[S - 1] == 0 and rng.random() < 0.4
    ab_t = []
    for i in range(n_new):
        prev = st_t[S - 1] if i == 0 else ab_t[i - 1]
        ab_t.append(0 if not reprise and i == n_new - 1 else pick_t(ABGESANG_T[mode], (prev,)))

    # hymn meter -> phrase lengths
    meter = pick_w(rng, METERS)
    st_l = [meter[i % len(meter)] for i in range(S)]
    ab_l = [meter[i % len(meter)] for i in range(n_new)]

    # where the climax falls: an Abgesang phrase, most often its first
    cw = [5, 4, 2 if reprise else 1] if n_new == 3 else ([6, 4] if reprise else [8, 2])
    climax_at = pick_w(rng, list(enumerate(cw)))

    tonics = [(m, w) for m, w in ((T, 2), (T + 12, 1))
              if m < Cx and m >= CADENCE_FLOOR and m <= K.hi + 2]
    below = Cx - 1

    # the Stollen
    stollen = []
    prev_last = prev_prev = None
    for i in range(S):
        closing = i == S - 1
        spec = dict(
            L=st_l[i], target=st_t[i], prev_last=prev_last, prev_prev=prev_prev, ceil=below,
            climax=None, first=i == 0,
            contour_w={'arch': 5, 'ascend': 3, 'descend': 2} if i == 0 and S == 2
                      else {'arch': 4, 'descend': 4, 'ascend': 2},
            final_set=tonics if st_t[i] == 0 and closing else None,
            next=('self' if S == 1 else stollen[0]) if closing else None,
            center=K.lo + 4 if S == 2 and i == 0 else K.mid - 1)       # the Stollen starts low
        ph = compose_phrase(K, spec, rng)
        if not ph:
            return None
        stollen.append(ph)
        prev_last, prev_prev = ph[-1], ph[-2]

    # the Abgesang
    abgesang = []
    for i in range(n_new):
        final = not reprise and i == n_new - 1
        climax = Cx if i == climax_at else None
        spec = dict(
            L=ab_l[i], target=ab_t[i], prev_last=prev_last, prev_prev=prev_prev, ceil=below,
            climax=climax, first=False,
            contour_w={'descend': 6, 'arch': 4} if final else {'arch': 4, 'descend': 4, 'ascend': 2},
            final_set=tonics if final else None,
            next=stollen[S - 1] if reprise and i == n_new - 1 else None,
            center=Cx - 5 if climax is not None else K.mid - 1 if i == n_new - 1 else K.mid + 2)
        ph = compose_phrase(K, spec, rng)
        if not ph:
            return None
        if any(q == ph for q in stollen + abgesang):
            return None
        abgesang.append(ph)
        prev_last, prev_prev = ph[-1], ph[-2]

    # assemble: Stollen, Stollen again, Abgesang (+ reprise)
    phrases = stollen + stollen + abgesang
    labels = ([LETTERS[i] for i in range(S)] * 2 + [LETTERS[S + i] for i in range(n_new)])
    if reprise:
        phrases.append(stollen[S - 1])
        labels.append(LETTERS[S - 1])
    pitches = [m for ph in phrases for m in ph]
    fermatas, acc = [], 0
    for ph in phrases:
        acc += len(ph)
        fermatas.append(acc)
    return {'pitches': pitches, 'fermatas': fermatas,
            'form': {'labels': labels, 'reprise': reprise, 'climax': Cx,
                     'stollen_chords': sum(len(ph) for ph in stollen)}}

def melody(tonic_pc, mode, n_phrases, rng):
    """A bar-form soprano: {'pitches', 'fermatas', 'form'}, or None when the
    planner gives up (200 restarts; geometric, so never in practice)."""
    K = Key(tonic_pc, mode)
    n = max(2, min(4, n_phrases))
    for _ in range(200):
        tune = try_tune(K, n, rng)
        if tune:
            return tune
    return None

# ------------------------------------------------------------- bass line --

def oracle_moves(mode, s_from_pc, s_to_pc, cad, b_from_pc):
    key = f"{mode}|{s_from_pc}>{s_to_pc}|{cad}"
    table = ORACLE['transitions'].get(key, {})
    out = {}
    for k, c in table.items():
        f, t = (int(x) for x in k.split('>'))
        if f == b_from_pc:
            out[t] = out.get(t, 0) + c
    if not out:                                        # arrivals fallback
        akey = f"{mode}|{s_to_pc}|{cad}"
        out = {int(p): c for p, c in ORACLE['arrivals'].get(akey, {}).items()}
    return out

def concretize(pc, prev_pitch, lo=38, hi=62):
    cands = [m for m in range(lo, hi + 1) if m % 12 == pc and abs(m - prev_pitch) <= 12]
    return sorted(cands, key=lambda m: (abs(m - prev_pitch), abs(m - 48)))

def opens_on_tonic(sop, tonic_pc, mode):
    """Can the first chord be I or i? Always, for the engine's own melodies
    (they start on 1, 3 or 5); a given melody may start elsewhere."""
    return (sop[0] - tonic_pc) % 12 in {0, 3 if mode == 'minor' else 4, 7}

def bass_line(sop, fermatas, tonic_pc, mode, rng, beam_width=10, temp=0.0, rep=0):
    """rep: chords in the Stollen, sung again right after it. Inside the
    repeat each line may only repeat what it wrote the first time, so the
    search chooses a Stollen it can sing twice."""
    n = len(sop)
    ferm = set(fermatas)
    rel = lambda m: (m - tonic_pc) % 12
    pairs = chordlib.harmonizable_pairs(mode)
    scale = chordlib.scale(mode)
    # the piece opens with the tonic in the bass, as Bach's chorales do (the
    # oracle's openings are every phrase's, and would open on la or mi); a
    # given melody that starts off the tonic triad keeps the oracle's choice
    opens = {'0': 1} if opens_on_tonic(sop, tonic_pc, mode) else \
        ORACLE['openings'].get(f"{mode}|{rel(sop[0])}", {'0': 1})

    def legal(i, prev, cand, t_pc):
        """What the inner-voice search and the checker would reject later,
        refused where the notes are written: bass note cand at chord i."""
        a = abs(cand - prev)
        if a in (10, 11):
            return False                       # seventh leap: checker kills it
        if pair_parallel(sop[i-1], prev, sop[i], cand):
            return False                       # the sixth pair
        if i == n - 1 and cand % 12 != tonic_pc:
            return False                       # end on the tonic
        if sop[i] - cand <= 3:
            return False                       # room for alto and tenor
        if mode == 'minor' and a == 3 and i not in ferm and {rel(prev), t_pc} == {8, 11}:
            return False                       # augmented second
        return True

    def returns(last, b0):
        """Can a Stollen ending on bass note last start over on b0? The repeat
        begins again after a breath, so the move needs no precedent in the
        oracle, only the hard rules and at most an octave."""
        return abs(b0 - last) <= 12 and legal(rep, last, b0, rel(b0))

    def reaches_tonic(prev):
        """Can a line at the next-to-last chord still reach a tonic the search
        may write? (otherwise the whole beam can die on the last chord)"""
        i = n - 1
        moves = oracle_moves(mode, rel(sop[i-1]), rel(sop[i]), 1, rel(prev))
        if 0 not in moves or (rel(sop[i]), 0) not in pairs:
            return False
        return any(legal(i, prev, c, 0) for c in concretize(tonic_pc, prev)[:2])

    beams = []
    for p, c in sorted(opens.items(), key=lambda kv: -kv[1])[:6]:
        if (rel(sop[0]), int(p)) not in pairs:
            continue
        pc = (int(p) + tonic_pc) % 12
        for b0 in concretize(pc, 45)[:2]:
            beams.append((math.log1p(c) + rng.uniform(0, temp), [b0]))
    for i in range(1, n):
        cad = 1 if (i + 1) in ferm or i == n - 1 else 0
        nxt = []
        for score, line in beams:
            prev = line[-1]
            fixed = line[i - rep] if rep and rep <= i < 2 * rep else None
            if fixed is not None and i == rep:
                # the repeat starts over: its first bass note is written as it stands
                if returns(prev, fixed):
                    nxt.append((score + rng.uniform(0, temp), line + [fixed]))
                continue
            moves = oracle_moves(mode, rel(sop[i-1]), rel(sop[i]), cad, rel(prev))
            for t_pc, cnt in moves.items():
                if (rel(sop[i]), t_pc) not in pairs:
                    continue                           # no chord explains this dyad
                abs_pc = (t_pc + tonic_pc) % 12
                for cand in concretize(abs_pc, prev)[:2]:
                    if fixed is not None and cand != fixed:
                        continue
                    s = score + math.log1p(cnt) + rng.uniform(0, temp)
                    dm, ds = cand - prev, sop[i] - sop[i-1]
                    if dm == 0 and ds == 0:
                        s -= 0.2       # repeated chord: fine under a repeated note
                    if (dm < 0 < ds) or (ds < 0 < dm):
                        s += 0.6
                    elif dm == 0 or ds == 0:
                        s += 0.2
                    a = abs(dm)
                    if not legal(i, prev, cand, t_pc):
                        continue
                    if rep and i == rep - 1 and not returns(cand, line[0]):
                        continue                       # the Stollen must be able to start over
                    if i == n - 2 and not reaches_tonic(cand):
                        continue
                    if a == 6:
                        s -= 1.0                       # tritone leap: warning tier
                    s += 0.5 if a in (1, 2) else (0.2 if a <= 4 else
                                                  0.05 if a <= 7 else -0.5)
                    if t_pc not in scale:
                        # rarity is already priced by oracle support; only
                        # augmented-second shapes need an extra guard
                        if a == 3:
                            s -= 2.0
                    if rel(prev) not in scale and dm != 1:
                        s -= 2.0       # a chromatic bass tone resolves up a semitone
                    pcs = [x % 12 for x in line[-3:]] + [cand % 12]
                    if len(pcs) >= 4 and pcs[-1] == pcs[-3] and pcs[-2] == pcs[-4] \
                            and pcs[-1] != pcs[-2]:
                        s -= 1.4
                    if pcs.count(cand % 12) >= 3:
                        s -= 0.8
                    if not 40 <= cand <= 60:
                        s -= 0.3
                    ic = (sop[i] - cand) % 12
                    if ic in (1, 2, 11):
                        s -= 2.5
                    if i == n - 1 and (cand % 12) != tonic_pc:
                        s -= 3.0
                    nxt.append((s, line + [cand]))
        nxt.sort(key=lambda x: -x[0])
        beams = nxt[:beam_width]
        if not beams:
            return None
    return beams[0][1]

# ------------------------------------------------------------ harmonize --

def voicings(chord, s, b, tonic_pc):
    """Legal alto/tenor fillings. Tendency tones are never doubled."""
    pcs = {(p + tonic_pc) % 12 for p in chord['pcs']}
    forbid_double = {(p + tonic_pc) % 12 for p in (chord['lt'], chord['seventh'])
                     if p is not None}
    out = []
    for a in range(53, 75):
        if a % 12 not in pcs or a > s or s - a > 12:
            continue
        for t in range(48, 70):
            if t % 12 not in pcs or t > a or a - t > 12 or t < b:
                continue
            quad_pcs = [s % 12, a % 12, t % 12, b % 12]
            if any(quad_pcs.count(f) > 1 for f in forbid_double):
                continue
            missing = len(pcs - set(quad_pcs))
            out.append((a, t, missing))
    return out

def pair_parallel(p1a, p1b, p2a, p2b):
    ic1, ic2 = (p1a - p1b) % 12, (p2a - p2b) % 12
    return (ic2 in (0, 7) and ic1 == ic2
            and p2a != p1a and p2b != p1b
            and (p2a > p1a) == (p2b > p1b))

def harmonize(sop, bass, fermatas, tonic_pc, mode, beam_width=14, rep=0):
    """rep: as in bass_line, the Stollen's repeat copies alto, tenor and chord."""
    n = len(sop)
    vocab = chordlib.vocabulary(mode)
    scale = chordlib.scale(mode)
    abspc = lambda rel: (rel + tonic_pc) % 12
    ferm_set = set(fermatas)
    open_tonic = opens_on_tonic(sop, tonic_pc, mode)

    def legal(i, pa, pt, a, t):
        """Hard rejects, stricter than the checker (even across fermatas): no
        parallel fifths or octaves between any two voices, the checker's leap
        rules for the inner voices, and no augmented second (any 3-semitone
        move with a chromatic end, or the minor b6/#7 pair)."""
        prev_q = (sop[i-1], pa, pt, bass[i-1])
        cur_q = (sop[i], a, t, bass[i])
        for x in range(4):
            for y in range(x + 1, 4):
                if pair_parallel(prev_q[x], prev_q[y], cur_q[x], cur_q[y]):
                    return False
        for prev_p, cur_p in ((pa, a), (pt, t)):
            step = abs(cur_p - prev_p)
            if step in (10, 11) or step > 12:
                return False
            if step == 3:
                rel2 = {(p - tonic_pc) % 12 for p in (prev_p, cur_p)}
                if rel2 == {8, 11} or any(r not in scale for r in rel2):
                    return False
        return True

    slots = []
    for i in range(n):
        opts = []
        for ci, ch in enumerate(vocab):
            if i == 0 and ci != 0 and open_tonic:
                continue                               # the first chord is I or i, complete
            pcs = {abspc(p) for p in ch['pcs']}
            if sop[i] % 12 not in pcs or bass[i] % 12 not in pcs:
                continue
            cost = 0.5 if len(ch['pcs']) == 4 else 0.0
            if chordlib.is_chromatic(ch, mode):
                # a secondary dominant is offered where the bass line walks
                # to its target next (payoff known up front, no beam gamble) —
                # or where the melody/bass note is itself chromatic and some
                # chord must explain it
                forced = (sop[i] - tonic_pc) % 12 not in chordlib.scale(mode) \
                    or (bass[i] - tonic_pc) % 12 not in chordlib.scale(mode)
                arrives = ch['target'] is not None and i + 1 < n \
                    and bass[i + 1] % 12 == abspc(ch['target'])
                if not (forced or arrives):
                    continue
                if arrives and (i + 2 in ferm_set or i + 1 == n - 1):
                    cost -= 0.8                        # V/x into a cadence: Bach's move
            for a, t, missing in voicings(ch, sop[i], bass[i], tonic_pc):
                if i > 0 or not missing or not open_tonic:
                    opts.append((a, t, ci, missing + cost))
        if not opts:
            return None
        slots.append(opts)
    beams = [(-c, [(a, t, ci)]) for a, t, ci, c in
             sorted(slots[0], key=lambda x: x[3])[:beam_width]]
    for i in range(1, n):
        nxt = []
        for score, line in beams:
            pa, pt, pci = line[-1]
            pch = vocab[pci]
            plt = abspc(pch['lt']) if pch['lt'] is not None else None
            psev = abspc(pch['seventh']) if pch['seventh'] is not None else None
            ptarget = abspc(pch['target']) if pch['target'] is not None else None
            fixed = line[i - rep] if rep and rep <= i < 2 * rep else None
            for a, t, ci, cost in slots[i]:
                if fixed is not None and (a, t, ci) != fixed:
                    continue                           # the repeat copies the Stollen
                ch = vocab[ci]
                cur_pcs = {abspc(p) for p in ch['pcs']}
                # tonicization should arrive: V/x resolving anywhere but a
                # chord containing x is heavily penalized (not killed — a
                # forced-chromatic melody can strand a beam otherwise)
                target_missed = ptarget is not None and ptarget not in cur_pcs
                if not legal(i, pa, pt, a, t):
                    continue
                # the Stollen's last chord must be able to start the repeat
                if rep and i == rep - 1 and not legal(rep, a, t, line[0][0], line[0][1]):
                    continue
                s = score - cost
                if target_missed:
                    s -= 3.0
                s -= 0.25 * (abs(a - pa) + abs(t - pt))
                if a == pa: s += 0.3
                if t == pt: s += 0.3
                if abs(a - pa) > 7 or abs(t - pt) > 7: s -= 1.0
                if a > sop[i-1] or t > pa or t < bass[i-1]:
                    s -= 1.2
                if ptarget is not None and bass[i] % 12 == ptarget:
                    s += 1.5                           # tonicized root in the bass
                # tendency resolutions in the inner voices
                for prev_p, cur_p in ((pa, a), (pt, t)):
                    if plt is not None and prev_p % 12 == plt:
                        s += 0.8 if cur_p - prev_p == 1 else -2.0
                    if psev is not None and prev_p % 12 == psev:
                        s += 0.5 if -2 <= cur_p - prev_p <= -1 else -2.5
                # tendency tones in the fixed voices constrain the chord CHOICE
                if plt is not None and bass[i-1] % 12 == plt \
                        and bass[i] - bass[i-1] != 1:
                    s -= 2.0
                if psev is not None and bass[i-1] % 12 == psev \
                        and not -2 <= bass[i] - bass[i-1] <= -1:
                    s -= 2.5
                if plt is not None and sop[i-1] % 12 == plt \
                        and sop[i] - sop[i-1] != 1:
                    s -= 1.5
                # false relation: a chromatic tone in one voice right after
                # its natural form sounded in a different voice
                prev_quad = [sop[i-1], pa, pt, bass[i-1]]
                cur_quad = [sop[i], a, t, bass[i]]
                for vi, cp in enumerate(cur_quad):
                    crel = (cp - tonic_pc) % 12
                    if crel in scale:
                        continue
                    for nat in ((cp - 1), (cp + 1)):
                        if (nat - tonic_pc) % 12 in scale:
                            for vj, pp in enumerate(prev_quad):
                                if vj != vi and pp % 12 == nat % 12:
                                    s -= 1.5
                nxt.append((s, line + [(a, t, ci)]))
        nxt.sort(key=lambda x: -x[0])
        beams = nxt[:beam_width]
        if not beams:
            return None
    return [(a, t) for a, t, _ in beams[0][1]]

# -------------------------------------------------------------- pipeline --

def compose(tonic='D', mode='minor', phrases=3, seed=7, density=1.0, plain=False,
            given_melody=None):
    """given_melody: {'soprano': [...names or midi...], 'fermatas': [...]} —
    harmonize-only mode; the soprano is taken as law and never altered."""
    tonic_pc = PC[tonic]
    for attempt in range(40):
        rng = random.Random(seed * 1000 + attempt)
        if given_melody is not None:
            sop = [score_io.midi_num(p) if isinstance(p, str) else p
                   for p in given_melody['soprano']]
            ferm = list(given_melody.get('fermatas', [len(sop)]))
            rep, labels = int(given_melody.get('stollen', 0)), None
        else:
            tune = melody(tonic_pc, mode, phrases, rng)
            if tune is None:
                continue
            sop, ferm = tune['pitches'], tune['fermatas']
            rep, labels = tune['form']['stollen_chords'], tune['form']['labels']
        bass = bass_line(sop, ferm, tonic_pc, mode, rng, temp=0.15 * attempt, rep=rep)
        if bass is None:
            continue
        inner = harmonize(sop, bass, ferm, tonic_pc, mode, rep=rep)
        if inner is None:
            continue
        piece = {
            'tonic': tonic, 'mode': mode,
            'soprano': [score_io.pitch_name(m) for m in sop],
            'alto':    [score_io.pitch_name(a) for a, _ in inner],
            'tenor':   [score_io.pitch_name(t) for _, t in inner],
            'bass':    [score_io.pitch_name(m) for m in bass],
            'fermatas': ferm,
        }
        if rep:
            piece['stollen'] = rep                 # chords sung twice; ornament copies them too
        voices = {v: [score_io.midi_num(p) for p in piece[v]] for v in score_io.VOICES}
        V, W = check_chorale.check(voices, tonic, mode, ferm)
        if V:
            continue
        piece['_meta'] = {'seed': seed, 'attempt': attempt, 'warnings': len(W)}
        if labels:
            piece['_meta']['form'] = ' '.join(labels)
        if plain:
            return piece
        out = ornament_mod.ornament(piece, density=density, seed=seed)
        out['_meta'] = piece['_meta']
        return out
    return None

if __name__ == '__main__':
    args = sys.argv
    get = lambda k, d: args[args.index(k) + 1] if k in args else d
    given = None
    tonic, mode = get('--tonic', 'D'), get('--mode', 'minor')
    if '--melody' in args:
        given = json.load(open(get('--melody', '')))
        tonic, mode = given.get('tonic', tonic), given.get('mode', mode)
    piece = compose(tonic=tonic, mode=mode,
                    phrases=int(get('--phrases', 3)), seed=int(get('--seed', 7)),
                    density=float(get('--density', 1.0)), plain='--plain' in args,
                    given_melody=given)
    if piece is None:
        sys.exit("failed to compose a clean piece in 40 attempts")
    out = get('--out', 'out/engine_piece.json')
    json.dump(piece, open(out, 'w'), indent=1)
    print(f"wrote {out}")
