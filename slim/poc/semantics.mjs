// Semantics gate v2: correct thisArg (undefined), closure-based API, recovery after timeout.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const ivm = require('isolated-vm');

const isolate = new ivm.Isolate({ memoryLimit: 256 });
const context = isolate.createContextSync();
isolate.compileScriptSync(`
let _n = 0;
const _store = [];
globalThis.onTick  = (p) => { _n++; return { ok: true, x: p.a * p.b, n: _n, s: 'v' + _n }; };
globalThis.slow    = (ms) => { const e = Date.now() + ms; while (Date.now() < e); return 'slept-' + ms; };
globalThis.hang    = () => { while (true) {} };
globalThis.boom    = () => { throw new Error('author bug'); };
globalThis.alloc   = (mb) => { for (let i = 0; i < mb; i++) _store.push(new Uint8Array(1048576).fill(i & 255)); return _store.length; };
globalThis.asyncPing = () => Promise.resolve('resolved-async');
globalThis.getState = () => _n;
`, { filename: 'p.js' }).runSync(context);

const R = (name) => context.global.getSync(name, { reference: true });
const callSync = (name, args, opts) => R(name).applySync(undefined, args, opts);

console.log('--- A: result copy, thisArg=undefined ---');
for (const o of [{ result: { depth: 1 }, timeout: 5000 }, { result: { promise: false, depth: 2 }, timeout: 5000 }, undefined]) {
  try { console.log(JSON.stringify(o), '=>', JSON.stringify(callSync('onTick', [{ a: 3, b: 4 }], o))); }
  catch (e) { console.log(JSON.stringify(o), '=> ERR', String(e.message).split('\n')[0]); }
}

console.log('--- B: async promise result (engine uses promise:true) ---');
try {
  const pr = callSync('asyncPing', [], { result: { promise: true }, timeout: 5000 });
  console.log('got ivm promise, type=', typeof pr, 'thenable=', !!(pr && pr.then));
  if (pr && pr.then) await pr.then((v) => console.log('awaited =>', v), (e) => console.log('rejected =>', e.message));
} catch (e) { console.log('ERR', String(e.message).split('\n')[0]); }

console.log('--- C: timeout on 300ms blocking fn, budget 100ms ---');
let t = Date.now();
try { callSync('slow', [300], { timeout: 100 }); console.log('NO THROW?!'); }
catch (e) { console.log('THREW after', Date.now() - t, 'ms |', e.message.split('\n')[0]); }
console.log('isDisposed =', isolate.isDisposed, '| state readable =', callSync('getState', [], undefined));

console.log('--- D: timeout on while(true), budget 100ms ---');
t = Date.now();
try { callSync('hang', [], { timeout: 100 }); console.log('NO THROW?!'); }
catch (e) { console.log('THREW after', Date.now() - t, 'ms |', e.message.split('\n')[0]); }
let ok = 0, fail = null;
for (let i = 0; i < 20; i++) {
  try { const r = callSync('onTick', [{ a: 2, b: 3 }], { result: { depth: 1 }, timeout: 1000 }); ok = r.n; }
  catch (e) { fail = e.message.split('\n')[0]; break; }
}
console.log('post-hang: 20 ticks, last n =', ok, 'fail =', fail);
console.log('--- E: 5 repeated hangs, cumulative recovery ---');
for (let k = 0; k < 5; k++) {
  try { callSync('hang', [], { timeout: 50 }); } catch { }
  try { callSync('onTick', [{ a: 1, b: 1 }], { result: { depth: 1 }, timeout: 1000 }); console.log('cycle', k, 'recovered OK'); }
  catch (e) { console.log('cycle', k, 'DEAD:', e.message.split('\n')[0]); break; }
}
console.log('--- F: uncaught vm error then recovery ---');
try { callSync('boom', [], { timeout: 1000 }); } catch (e) { console.log('boom:', e.message.split('\n')[0]); }
try { console.log('after boom tick n =', callSync('onTick', [{ a: 1, b: 1 }], { result: { depth: 1 }, timeout: 1000 }).n); }
catch (e) { console.log('after boom DEAD:', e.message.split('\n')[0]); }
console.log('--- G: heap after work ---');
console.log(JSON.stringify(isolate.getHeapStatisticsSync()));
console.log('cpuTime ns =', isolate.cpuTime, 'wallTime ns =', isolate.wallTime);
isolate.dispose();
console.log('SMOKE2 DONE, isDisposed =', isolate.isDisposed);
