// With every flag off, the lab engine must reproduce the shipped engine
// note for note (events) and draft for draft (attempt). Usage:
//   node --no-warnings verify.mjs [from] [to]
import { composePiece } from './shipped.mjs';
import { composePieceLab } from './engine.lab.mjs';

const from = Number(process.argv[2] || 1), to = Number(process.argv[3] || 3000);
let bad = 0;
for (let n = from; n <= to; n++) {
  const a = composePiece(n), b = composePieceLab(n, {});
  const same = a && b && a.attempt === b.attempt &&
    JSON.stringify(a.events) === JSON.stringify(b.events);
  if (!same) { bad++; if (bad <= 5) console.log(`No. ${n} differs`); }
}
console.log(`${to - from + 1 - bad}/${to - from + 1} identical (No. ${from}..${to})`);
process.exit(bad ? 1 : 0);
