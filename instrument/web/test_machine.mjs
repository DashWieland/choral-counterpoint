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

// null chorales are stepped over, in either direction (a stub engine that
// composes nothing at Nos. 5, 6 and 100..199)
const stub = k => (k === 5 || k === 6 || (k >= 100 && k < 200)) ? null : { key: 'stub', k };
expect('forward past a null', pieceOrNext(5, 1, stub).number, 7);
expect('backward past a null', pieceOrNext(6, -1, stub).number, 4);
expect('a long null run gives up', pieceOrNext(100, 1, stub), null);
expect('an address past a short null run opens the next piece', openAddress('5', stub).number, 7);
expect('inside a null run longer than the search, No. 1 opens', openAddress('150', stub).number, 1);
// and the search never steps off the shelf
expect('past the last piece', pieceOrNext(LAST + 1), null);
expect('before No. 1', pieceOrNext(0, -1), null);
// the machine plays engine.js
expect('No. 42 is engine.js No. 42', openAddress('42').piece.key, composePiece(42).key);

console.log(failed ? `\n${failed}/${checks} FAILED` : `address contract holds (${checks} checks)`);
process.exitCode = failed ? 1 : 0;
