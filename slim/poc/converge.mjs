// Converge: (a) get a callable Reference out of a script, (b) getHeapStatistics shape.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const ivm = require('isolated-vm');

const isolate = new ivm.Isolate({ memoryLimit: 256 });
const context = isolate.createContextSync();

const src = `
globalThis.__poc = {
  tickCount: 0,
  onTick(p) { this.tickCount++; return { ok: true, x: p.a * p.b, n: this.tickCount }; },
  slow() { const e = Date.now() + 200; while (Date.now() < e); return 1; },
  hang() { while (true) {} },
  boom() { throw new Error('author bug'); },
};
"completion-" + __poc.tickCount;
`;

const script = isolate.compileScriptSync(src, { filename: 'poc.js', produceCachedData: true });
const completion = script.runSync(context);
console.log('completion value =', JSON.stringify(completion));

const t = (label, fn) => {
  try { console.log(label, '=>', JSON.stringify(fn())); }
  catch (e) { console.log(label, '=> ERR', String(e.message).split('\n')[0]); }
};

t('global.get(reference)', () => {
  const r = context.global.getSync('shell', { reference: true });
  return r === undefined ? 'undefined' : 'got';
});
t('global.get(__poc,reference)', () => {
  const r = context.global.getSync('__poc', { reference: true });
  return r ? Object.getOwnPropertyNames(Object.getPrototypeOf(r)).join(',') : 'undefined';
});

const pocRef = context.global.getSync('__poc', { reference: true });
if (pocRef) {
  t('ref.get(onTick,reference)', () => {
    const f = pocRef.getSync('onTick', { reference: true });
    return f ? 'fn-ref' : 'undefined';
  });
  const fn = pocRef.getSync('onTick', { reference: true });
  if (fn) {
    t('fn.apply onTick', () => fn.apply(pocRef, [{ a: 3, b: 4 }], { result: { promise: false, depth: 2 }, timeout: 5000 }));
    t('fn.apply onTick again', () => fn.apply(pocRef, [{ a: 5, b: 5 }], { result: { promise: false, depth: 2 }, timeout: 5000 }));
  }
  t('pocRef.apply onTick (direct)', () => pocRef.apply('onTick', [{ a: 1, b: 1 }], { result: { promise: false, depth: 2 }, timeout: 5000 }));
  const boom = pocRef.getSync('boom', { reference: true });
  t('boom propagates error?', () => boom.apply(pocRef, [], { result: { promise: false }, timeout: 5000 }));
}

console.log('=== getHeapStatisticsSync ===');
console.log(JSON.stringify(isolate.getHeapStatisticsSync(), null, 1));
t('getHeapStatistics async', () => isolate.getHeapStatistics);
console.log('cpuTime/wallTime:', typeof isolate.cpuTime, typeof isolate.wallTime, isolate.referenceCount);

isolate.dispose();
console.log('after dispose isDisposed =', isolate.isDisposed);
