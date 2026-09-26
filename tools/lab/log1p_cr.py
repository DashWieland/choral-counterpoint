# Regenerate log1p_cr.txt: the correctly rounded double of ln(1 + c) for
# c = 0..1600, from 60-digit decimal arithmetic (used by log1p_check.mjs).
from decimal import Decimal, getcontext
getcontext().prec = 60
open('log1p_cr.txt', 'w').write('\n'.join(
    repr(float((Decimal(1) + Decimal(c)).ln())) for c in range(1601)))
