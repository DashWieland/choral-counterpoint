// The machine's address contract: ?piece=N opens No. N anywhere on the
// shelf (1 .. MAX_SAFE_INTEGER), junk opens No. 1, past the end opens the
// last piece, and every search past null chorales returns. (Before the
// bound, the stuck-float addresses below froze the tab.)
import { composePiece } from './engine.js';
import { openAddress, pieceOrNext } from './machine.js';

const LAST = Number.MAX_SAFE_INTEGER;
let checks = 0, failed = 0;
const expect = (label, got, want) => {
  checks++;
  if (got !== want) { failed++; console.log(`FAIL ${label}: got ${got}, want ${want}`); }
};
const opens = a => openAddress(a).number;

for (const n of [1, 2, 10, 42, 200, 123456789, 1e12, 999999999999999, LAST])
  expect(`?piece=${n}`, opens(String(n)), n);
expect('?piece=0042', opens('0042'), 42);
expect('?piece=+42', opens(' 42'), 42);            // URLSearchParams reads + as space
for (const a of [null, '', '0', '-5', '12.5', '0x10', '1e3', 'Infinity', 'abc'])
  expect(`?piece=${a}`, opens(a), 1);
for (const a of ['9007199254740992', '48411308052805240', '86640380872603950',
                 '99999999999999999999'])
  expect(`?piece=${a}`, opens(a), LAST);

// null chorales are stepped over, in either direction
const nul = 9007199254740984;
expect('No. 9007199254740984 is null', composePiece(nul), null);
expect('forward past a null', pieceOrNext(nul).number > nul, true);
expect('backward past a null', pieceOrNext(nul, -1).number < nul, true);
// and the search never steps off the shelf
expect('past the last piece', pieceOrNext(LAST + 1), null);
expect('before No. 1', pieceOrNext(0, -1), null);

console.log(failed ? `\n${failed}/${checks} FAILED` : `address contract holds (${checks} checks)`);
process.exitCode = failed ? 1 : 0;
