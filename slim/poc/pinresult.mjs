// Final calling-convention pin: ExternalCopy args + result forms.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const ivm = require('isolated-vm');

const isolate = new ivm.Isolate({ memoryLimit: 256 });
const context = isolate.createContextSync();
isolate.compileScriptSync(`
let _n = 0;
globalThis.tickObj   = (p) => { _n++; return { ok: true, x: p.a * p.b, n: _n, list: [1,2,{z:1}] }; };
globalThis.tickStr   = (p) => { _n++; return JSON.stringify({ ok: true, x: p.a * p.b, n: _n }); };
globalThis.tickNum   = (p) => { _n++; return p.a * p.b; };
globalThis.hang      = () => { while (true) {} };
`, { filename: 'p.js' }).runSync(context);

const R = (n) => context.global.getSync(n, { reference: true });
const EC = (o) => new ivm.ExternalCopy(o).copyInto({ transferIn: true, release: true });
const T = (label, fn) => { try { console.log(label, '=>', JSON.stringify(fn())); }
  catch (e) { console.log(label, '=> ERR', String(e.message).split('\n')[0]); } };

console.log('--- result forms (arg = ExternalCopy) ---');
T('tickObj result default', () => R('tickObj').applySync(undefined, [EC({ a: 3, b: 4 })], { timeout: 1000 }));
T('tickObj result copy depth1', () => R('tickObj').applySync(undefined, [EC({ a: 3, b: 4 })], { timeout: 1000, result: { copy: true, depth: 1 } }));
T('tickObj result copy depth2', () => R('tickObj').applySync(undefined, [EC({ a: 3, b: 4 })], { timeout: 1000, result: { copy: true, depth: 2 } }));
T('tickObj result promise', () => R('tickObj').applySync(undefined, [EC({ a: 3, b: 4 })], { timeout: 1000, result: { promise: true } }));
T('tickStr (primitive JSON)', () => R('tickStr').applySync(undefined, [EC({ a: 3, b: 4 })], { timeout: 1000 }));
T('tickNum (primitive)', () => R('tickNum').applySync(undefined, [EC({ a: 3, b: 4 })], { timeout: 1000 }));

console.log('--- promise:true awaited ---');
try {
  const pr = R('tickObj').applySync(undefined, [EC({ a: 5, b: 5 })], { timeout: 1000, result: { promise: true } });
  const v = await pr;
  console.log('awaited =>', JSON.stringify(v));
} catch (e) { console.log('ERR', String(e.message).split('\n')[0]); }

console.log('--- hang + recovery for each viable form ---');
for (const [label, run] of [
  ['tickStr', () => R('tickStr').applySync(undefined, [EC({ a: 2, b: 3 })], { timeout: 1000 })],
  ['tickObj/promise', () => R('tickObj').applySync(undefined, [EC({ a: 2, b: 3 })], { timeout: 1000, result: { promise: true } })],
]) {
  try { R('hang').applySync(undefined, [], { timeout: 100 }); } catch {}
  try { const r = run(); console.log(label, 'after hang =>', JSON.stringify(r && r.then ? 'promise' : r)); }
  catch (e) { console.log(label, 'after hang => ERR', String(e.message).split('\n')[0]); }
}
isolate.dispose();
