// Edition 1, the engine every ?piece=N link plays: engine-ed1.js once
// editions exist (choral-counterpoint#2), engine.js before that.
const mod = await import('../../instrument/web/engine-ed1.js')
  .catch(() => import('../../instrument/web/engine.js'));
export const { composePiece, checkChorale } = mod;
