// Does "piece N is the same for everyone" survive a browser whose Math.log1p
// is correctly rounded? Compose No. from..to with V8's log1p and with a
// correctly rounded table (Python Decimal), compare note for note.
import { readFileSync } from 'node:fs';
import { composePiece } from './shipped.mjs';
const from = Number(process.argv[2] || 1), to = Number(process.argv[3] || 3000);
const cr = readFileSync(new URL('./log1p_cr.txt', import.meta.url), 'utf8').split('\n').map(Number);
const v8 = Math.log1p;
const pieces = [];
for (let n = from; n <= to; n++) pieces.push(JSON.stringify(composePiece(n).events));
let outside = 0;
Math.log1p = x => (Number.isInteger(x) && x >= 0 && x < cr.length) ? cr[x] : (outside++, v8(x));
const diff = [];
for (let n = from; n <= to; n++)
  if (JSON.stringify(composePiece(n).events) !== pieces[n - from]) diff.push(n);
console.log(`${diff.length} of ${to - from + 1} pieces change under a correctly rounded log1p: ${diff.slice(0, 12).join(', ')}` +
  (outside ? ` (${outside} non-integer calls fell back to V8)` : ''));
