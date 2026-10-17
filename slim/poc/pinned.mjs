// Pin the exact transfer options for args + results in ivm@5.0.4.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const ivm = require('isolated-vm');

const isolate = new ivm.Isolate({ memoryLimit: 256 });
const context = isolate.createContextSync();
isolate.compileScriptSync(`
let _n = 0; const _store = [];
globalThis.onTick = (p) => { _n++; return { ok: true, x: p.a * p.b, n: _n, list: [1,2,3] }; };
globalThis.retPrim = (p) => 'got:' + p.a;
globalThis.slow = (ms) => { const e = Date.now()+ms; while (Date.now()<e); return 'slept-'+ms; };
globalThis.hang = () => { while (true) {} };
globalThis.boom = () => { throw new Error('author bug'); };
globalThis.alloc = (mb) => { for (let i=0;i<mb;i++) _store.push(new Uint8Array(1048576).fill(7)); return _store.length; };
`, { filename: 'p.js' }).runSync(context);

const R = (n) => context.global.getSync(n, { reference: true });
const T = (label, fn) => { try { console.log(label, '=>', JSON.stringify(fn())); }
  catch (e) { console.log(label, '=> ERR', String(e.message).split('\n')[0]); } };

const ARGS = [{ copy: true, depth: 2 }];
console.log('--- arg/result transfer option matrix ---');
T('args default (no opts)', () => R('onTick').applySync(undefined, [{ a: 3, b: 4 }], { timeout: 5000 }));
T('args copy+depth, result default', () => R('onTick').applySync(undefined, [{ a: 3, b: 4 }], { arguments: ARGS, timeout: 5000 }));
T('args copy, result copy depth2', () => R('onTick').applySync(undefined, [{ a: 3, b: 4 }],
  { arguments: ARGS, result: { copy: true, depth: 2 }, timeout: 5000 }));
T('primitive return, args copy', () => R('retPrim').applySync(undefined, [{ a: 9 }], { arguments: ARGS, timeout: 5000 }));
T('ExternalCopy as arg', () => R('retPrim').applySync(undefined,
  [new ivm.ExternalCopy({ a: 11 }).copyInto({ transferIn: true })], { timeout: 5000 }));

console.log('--- timeout + recovery with the working call form ---');
const OPT = { arguments: ARGS, result: { copy: true, depth: 2 }, timeout: 100 };
let t = Date.now();
T('slow(300) budget100', () => R('slow').applySync(undefined, [300], { ...OPT, timeout: 100 }));
console.log('  elapsed', Date.now() - t, 'ms  isDisposed=', isolate.isDisposed);
t = Date.now();
T('hang() budget100', () => R('hang').applySync(undefined, [], { ...OPT, timeout: 100 }));
console.log('  elapsed', Date.now() - t, 'ms  isDisposed=', isolate.isDisposed);
T('recovery tick after hang', () => R('onTick').applySync(undefined, [{ a: 2, b: 3 }],
  { arguments: ARGS, result: { copy: true, depth: 2 }, timeout: 1000 }));
T('boom()', () => R('boom').applySync(undefined, [], { ...OPT, timeout: 1000 }));
T('recovery tick after boom', () => R('onTick').applySync(undefined, [{ a: 1, b: 1 }],
  { arguments: ARGS, result: { copy: true, depth: 2 }, timeout: 1000 }));
isolate.dispose();
