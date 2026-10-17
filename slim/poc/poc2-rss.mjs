// W7 PoC-2: RSS cost per live isolate. Run one fresh process per count so the
// slope is measured, not inferred.  usage: poc2-rss.mjs <k> <mode: bare|loaded>
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const ivm = require('isolated-vm');
const { AUTHOR_SCRIPT } = await import('./author-script.mjs');

const K = Number(process.argv[2] || 1);
const MODE = process.argv[3] || 'loaded';   // bare = empty isolate; loaded = author script + 1 tick
const MEM = 512;

const rssKB = () => {
  const s = fs.readFileSync('/proc/self/status', 'utf8');
  const g = (re) => { const m = s.match(re); return m ? Number(m[1]) : NaN; };
  return { VmRSS: g(/VmRSS:\s*(\d+)/), VmHWM: g(/VmHWM:\s*(\d+)/), VmData: g(/VmData:\s*(\d+)/), VmSwap: g(/VmSwap:\s*(\d+)/) };
};

const gc = () => { if (global.gc) global.gc(); };

const base = rssKB();
const isolates = [], contexts = [];
for (let i = 0; i < K; i++) {
  const isolate = new ivm.Isolate({ memoryLimit: MEM, inspector: false });
  const context = isolate.createContextSync({ inspector: false });
  if (MODE === 'loaded') {
    isolate.compileScriptSync(AUTHOR_SCRIPT, { filename: 'author.js', produceCachedData: false }).runSync(context);
    context.global.getSync('__pocTick', { reference: true }).applySync(
      undefined, [new ivm.ExternalCopy({ steps: 20, dt: 0.016, i: 1 }).copyInto({ transferIn: true, release: true })],
      { timeout: 10000, result: { copy: true, depth: 2 } });
  }
  isolates.push(isolate); contexts.push(context);
}
const afterCreate = rssKB();
// steady state: drive 40 ticks on every isolate, then sample (loaded mode only)
if (MODE === 'loaded') for (let t = 0; t < 40; t++) {
  for (let i = 0; i < K; i++) {
    contexts[i].global.getSync('__pocTick', { reference: true }).applySync(
      undefined, [new ivm.ExternalCopy({ steps: 8, dt: 0.016, i: t }).copyInto({ transferIn: true, release: true })],
      { timeout: 10000, result: { copy: true, depth: 1 } });
  }
}
gc();
const steady = rssKB();
const heap = isolates.map((iso) => {
  const h = iso.getHeapStatisticsSync();
  return { used: h.used_heap_size, total: h.total_heap_size, phys: h.total_physical_size, limit: h.heap_size_limit, malloc: h.malloced_memory, ext: h.externally_allocated_size };
});
const sum = (k) => heap.reduce((a, b) => a + b[k], 0);

console.log(JSON.stringify({
  K, MODE, MEM,
  baseKB: base, afterCreateKB: afterCreate, steadyKB: steady,
  dRSS_create_KB: afterCreate.VmRSS - base.VmRSS,
  dRSS_steady_KB: steady.VmRSS - base.VmRSS,
  dHWM_KB: steady.VmHWM - base.VmHWM,
  perIsolate_dRSS_KB: +((steady.VmRSS - base.VmRSS) / Math.max(1, K)).toFixed(1),
  v8heap_used_KB: +(sum('used') / 1024).toFixed(1),
  v8heap_total_KB: +(sum('total') / 1024).toFixed(1),
  v8heap_phys_KB: +(sum('phys') / 1024).toFixed(1),
  v8_malloced_KB: +(sum('malloc') / 1024).toFixed(1),
  v8_ext_KB: +(sum('ext') / 1024).toFixed(1),
  perIsolate_v8used_KB: +(sum('used') / 1024 / Math.max(1, K)).toFixed(1),
  heap_size_limit_reported_MB: +(heap[0] ? heap[0].limit / 1048576 : 0).toFixed(1),
  referenceCount: isolates.reduce((a, b) => a + b.referenceCount, 0),
}));
