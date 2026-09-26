// The machine's address contract: ?piece=N opens No. N anywhere on the
// shelf (1 .. MAX_SAFE_INTEGER), junk opens No. 1, past the end opens the
// last piece, and every search past null chorales returns. (Before the
// bound, the stuck-float addresses below froze the tab.) Then editions: an
// ed-less ?piece= link is Edition 1 forever, a fresh visit plays the current
// edition, and only released editions open from a URL.
import { composePiece } from './engine-ed1.js';
import { composePiece as composeEd2 } from './engine-ed2.js';
import { openAddress, pieceOrNext, editionOf, EDITIONS, RELEASED, CURRENT } from './machine.js';

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

// editions
const ed = (q, released, current) => editionOf(new URLSearchParams(q), released, current);
expect('?piece=12 (released 1)', ed('?piece=12', 1, 1), 1);
expect('?piece=12 (released 2)', ed('?piece=12', 2, 2), 1);
expect('fresh visit (current 1)', ed('', 1, 1), 1);
expect('fresh visit (current 2)', ed('', 2, 2), 2);
expect('?piece=12&ed=2 (released 1)', ed('?piece=12&ed=2', 1, 1), 1);
expect('?piece=12&ed=2 (released 2)', ed('?piece=12&ed=2', 2, 2), 2);
expect('?ed=2 alone (released 2)', ed('?ed=2', 2, 2), 2);
for (const junk of ['0', '3', 'two', '1.5', '-1'])
  expect(`?piece=5&ed=${junk}`, ed(`?piece=5&ed=${junk}`, 2, 2), 1);
expect('Edition 1 is the frozen engine', EDITIONS[1], composePiece);
expect('Edition 2 is the frozen engine', EDITIONS[2], composeEd2);
// as released: Edition 2 is current, and every ed-less link stays Edition 1
expect('released', RELEASED, 2);
expect('current', CURRENT, 2);
expect('a fresh visit plays Edition 2', editionOf(new URLSearchParams('')), 2);
expect('an ed-less ?piece= link is Edition 1', editionOf(new URLSearchParams('?piece=12')), 1);
expect('?piece=12&ed=2 opens Edition 2', editionOf(new URLSearchParams('?piece=12&ed=2')), 2);
expect('?piece=12&ed=3 is not released', editionOf(new URLSearchParams('?piece=12&ed=3')), 1);
expect('the machine defaults to Edition 1', openAddress('42').piece.key,
  openAddress('42', EDITIONS[1]).piece.key);

console.log(failed ? `\n${failed}/${checks} FAILED` : `address contract and editions hold (${checks} checks)`);
process.exitCode = failed ? 1 : 0;
