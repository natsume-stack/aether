// W7 PoC-1: single-isolate cost (create/context/compile/run/first-call) + V8 code-cache delta.
// Engine-faithful conventions: ExternalCopy args, result:{copy,depth}, timeout on every call.
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
const require = createRequire(import.meta.url);
const ivm = require('isolated-vm');
const { AUTHOR_SCRIPT } = await import('./author-script.mjs');

const MEM = 512, N = 20, WARMUP = 3, TIMEOUT = 10000;
const srcBytes = Buffer.byteLength(AUTHOR_SCRIPT);

const p = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.max(0, Math.min(s.length - 1, Math.ceil(q / 100 * s.length) - 1))]; };
const stat = (a) => ({ n: a.length, min: +Math.min(...a).toFixed(3), p50: +p(a, 50).toFixed(3), p95: +p(a, 95).toFixed(3), max: +Math.max(...a).toFixed(3) });

function cycle(cachedData) {
  const t = [];
  const mark = () => t.push(performance.now());
  mark();
  const isolate = new ivm.Isolate({ memoryLimit: MEM, inspector: false }); mark();
  const context = isolate.createContextSync({ inspector: false }); mark();
  const script = isolate.compileScriptSync(AUTHOR_SCRIPT, {
    filename: 'author-boilerplate.js', produceCachedData: true, cachedData: cachedData || undefined,
  }); mark();
  const shell = script.runSync(context); mark();
  // engine-style first call with a timeout budget
  const res = context.global.getSync('__pocTick', { reference: true })
    .applySync(undefined, [new ivm.ExternalCopy({ steps: 20, dt: 0.016, i: 1 }).copyInto({ transferIn: true, release: true })],
      { timeout: TIMEOUT, result: { copy: true, depth: 2 } }); mark();
  isolate.dispose(); mark();
  return {
    create: t[1] - t[0], context: t[2] - t[1], compile: t[3] - t[2], run: t[4] - t[3],
    firstCall: t[5] - t[4], dispose: t[6] - t[5], total: t[5] - t[0],
    cachedData: script.cachedData || null, res, rejected: !!script.cachedDataRejected,
  };
}

const cold = [];
for (let i = 0; i < N + WARMUP; i++) { const r = cycle(null); if (i >= WARMUP) cold.push(r); }
const blob = cold[0].cachedData;
const blobBytes = blob ? (blob.byteLength ?? blob.length ?? (Buffer.isBuffer(blob) ? blob.length : -1)) : 0;
const blobKind = blob ? (Object.prototype.toString.call(blob)) : 'none';
console.log('author script size          =', srcBytes, 'bytes');
console.log('cachedData produced         =', blobBytes, 'bytes  (kind=' + blobKind + ')');
console.log('cachedDataRejected (cold)   =', cold.some((c) => c.rejected));

const warm = [];
if (blob) {
  for (let i = 0; i < N + WARMUP; i++) { const r = cycle(blob); if (i >= WARMUP) warm.push(r); }
  console.log('cachedDataRejected (warm)   =', warm.some((c) => c.rejected));
}

const keys = ['create', 'context', 'compile', 'run', 'firstCall', 'dispose', 'total'];
const pick = (arr, k) => arr.map((r) => r[k]);
const out = {
  meta: {
    node: process.version, ivm: require('isolated-vm/package.json').version,
    memoryLimitMB: MEM, authorScriptBytes: srcBytes, samples: N, warmupDiscarded: WARMUP,
    host: { cpu: require('os').cpus()[0].model, cores: require('os').cpus().length },
  },
};
for (const k of keys) {
  out['NOCACHE_' + k] = stat(pick(cold, k));
  if (blob) out['CACHE_' + k] = stat(pick(warm, k));
}
if (blob) {
  const d = (k) => +((100 * (p(pick(warm, k), 50) - p(pick(cold, k), 50)) / p(pick(cold, k), 50)).toFixed(1));
  out.delta_pct = Object.fromEntries(keys.map((k) => [k, d(k)]));
}
console.log('sample tick result =', JSON.stringify(cold[0].res).slice(0, 260));
console.log(JSON.stringify(out, null, 1));
