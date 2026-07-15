#!/usr/bin/env python3
"""
The engine's chord vocabulary — diatonic triads and sevenths plus the
chromatic layer (secondary dominants and their diminished stand-ins).

All pitch classes are relative to the tonic. Each chord carries its
tendency tones: `lt` must resolve UP a semitone and is never doubled;
`seventh` must resolve DOWN by step and is never doubled. Chromatic
chords name a `target` degree: the harmony they tonicize must actually
arrive next (V/V that never reaches V is rejected at search time).
"""

def _c(name, pcs, lt=None, seventh=None, target=None):
    return {'name': name, 'pcs': tuple(pcs), 'lt': lt,
            'seventh': seventh, 'target': target}

MAJOR = [
    _c('I',      (0, 4, 7)),
    _c('ii',     (2, 5, 9)),
    _c('iii',    (4, 7, 11)),
    _c('IV',     (5, 9, 0)),
    _c('V',      (7, 11, 2),     lt=11),
    _c('vi',     (9, 0, 4)),
    _c('viio',   (11, 2, 5),     lt=11),
    _c('V7',     (7, 11, 2, 5),  lt=11, seventh=5),
    _c('ii7',    (2, 5, 9, 0),   seventh=0),
    # chromatic layer
    _c('V/V',    (2, 6, 9),      lt=6,  target=7),
    _c('V7/V',   (2, 6, 9, 0),   lt=6,  seventh=0,  target=7),
    _c('viio/V', (6, 9, 0),      lt=6,  target=7),
    _c('V/ii',   (9, 1, 4),      lt=1,  target=2),
    _c('V/vi',   (4, 8, 11),     lt=8,  target=9),
    _c('V7/vi',  (4, 8, 11, 2),  lt=8,  seventh=2,  target=9),
    _c('V7/IV',  (0, 4, 7, 10),  seventh=10,        target=5),
]

MINOR = [
    _c('i',      (0, 3, 7)),
    _c('iio',    (2, 5, 8)),
    _c('III',    (3, 7, 10)),
    _c('iv',     (5, 8, 0)),
    _c('v',      (7, 10, 2)),
    _c('V',      (7, 11, 2),     lt=11),
    _c('VI',     (8, 0, 3)),
    _c('bVII',   (10, 2, 5)),
    _c('viio',   (11, 2, 5),     lt=11),
    _c('V7',     (7, 11, 2, 5),  lt=11, seventh=5),
    _c('viio7',  (11, 2, 5, 8),  lt=11, seventh=8),
    _c('iio7',   (2, 5, 8, 0),   seventh=0),
    # chromatic layer
    _c('V/V',    (2, 6, 9),      lt=6,  target=7),
    _c('V7/V',   (2, 6, 9, 0),   lt=6,  seventh=0,  target=7),
    _c('viio/V', (6, 9, 0),      lt=6,  target=7),
    _c('V/iv',   (0, 4, 7),      lt=4,  target=5),
    _c('V7/iv',  (0, 4, 7, 10),  lt=4,  seventh=10, target=5),
]

MAJOR_SCALE = {0, 2, 4, 5, 7, 9, 11}
MINOR_SCALE = {0, 2, 3, 5, 7, 8, 10, 11}          # natural + raised 7th

def vocabulary(mode):
    return MAJOR if mode == 'major' else MINOR

def scale(mode):
    return MAJOR_SCALE if mode == 'major' else MINOR_SCALE

def is_chromatic(chord, mode):
    return not set(chord['pcs']) <= scale(mode)

def harmonizable_pairs(mode):
    """All (pc_a, pc_b) relative-pc dyads some chord can explain."""
    pairs = set()
    for ch in vocabulary(mode):
        for a in ch['pcs']:
            for b in ch['pcs']:
                pairs.add((a, b))
    return pairs
