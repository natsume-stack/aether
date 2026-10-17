// W7 PoC-4: blast radius. One isolate OOMs, another throws uncaught.
// Questions: do siblings survive? does the HOST process survive?
// is isolate.dispose() enough to reclaim RSS, or do we need the whole child process?
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const ivm = require('isolated-vm');
const { AUTHOR_SCRIPT } = await import('./author-script.mjs');

const MEM = 512, N_SIB = Number(process.argv[2] || 4);
const rssMB = () => Number(fs.readFileSync('/proc/self/status', 'utf8').match(/VmRSS:\s*(\d+)/)[1]) / 1024;
const hwmMB = () => Number(fs.readFileSync('/proc/self/status', 'utf8').match(/VmHWM:\s*(\d+)/)[1]) / 1024;

const mk = (withCatastrophic) => {
  const opts = { memoryLimit: MEM };
  if (withCatastrophic) opts.onCatastrophicError = (msg) => { mk.catastrophic.push(String(msg).split('\n')[0]); };
  const isolate = new ivm.Isolate(opts);
  mk.catastrophic = mk.catastrophic || [];
  const context = isolate.createContextSync();
  isolate.compileScriptSync(AUTHOR_SCRIPT, { filename: 'author.js' }).runSync(context);
  isolate.compileScriptSync(`
    globalThis.__oom = () => { const keep = []; for (;;) keep.push(new Uint8Array(1048576).fill(1)); };
    globalThis.__throwTop = () => { throw new Error('uncaught author error at top level'); };
  `, {}).runSync(context);
  return { isolate, context,
    tick: context.global.getSync('__pocTick', { reference: true }),
    oom: context.global.getSync('__oom', { reference: true }),
    thr: context.global.getSync('__throwTop', { reference: true }) };
};
mk.catastrophic = [];

const health = (v, i) => {
  try { const r = v.tick.applySync(undefined, [new ivm.ExternalCopy({ steps: 5, dt: 0.016, i }).copyInto({ transferIn: true, release: true })], { timeout: 3000, result: { copy: true, depth: 1 } }); return { i, ok: true, tick: r.tick }; }
  catch (e) { return { i, ok: false, err: String(e.message).split('\n')[0] }; }
};

const report = { hostPid: process.pid, memLimitMB: MEM, siblings: N_SIB };
const survivors = Array.from({ length: N_SIB }, (_, i) => mk(false));
report.baselineRSS_MB = +rssMB().toFixed(1);
report.allHealthyBefore = survivors.map(health).every((r) => r.ok);

// ---- experiment 1: uncaught exception inside one isolate ----
{
  const v = mk(true);
  let res;
  try { v.thr.applySync(undefined, [], { timeout: 3000 }); res = 'no throw'; }
  catch (e) { res = e.message.split('\n')[0]; }
  const after = survivors.map(health);
  report.uncaughtException = {
    surfaced: res,
    catastrophicCallbacks: mk.catastrophic.length,
    hostAlive: true,
    siblingsHealthy: after.filter((r) => r.ok).length + '/' + N_SIB,
    failedSiblings: after.filter((r) => !r.ok),
    rss_MB: +rssMB().toFixed(1),
  };
  try { v.tick.applySync(undefined, [new ivm.ExternalCopy({ steps: 2, dt: 0.016, i: 0 }).copyInto({ transferIn: true, release: true })], { timeout: 2000, result: { copy: true, depth: 1 } }); report.uncaughtException.sameIsolateStillUsable = true; }
  catch (e) { report.uncaughtException.sameIsolateStillUsable = false; }
  v.isolate.dispose();
}

// ---- experiment 2: OOM one isolate to its 512MB limit ----
{
  const v = mk(true);
  const before = rssMB();
  let res, err = null;
  try { v.oom.applySync(undefined, [], { timeout: 20000 }); res = 'returned without error'; }
  catch (e) { err = String(e.message).split('\n')[0]; res = 'THREW'; }
  const peak = hwmMB();
  const after = survivors.map(health);
  report.oom = {
    outcome: res, err,
    isDisposed: v.isolate.isDisposed,
    catastrophicCallbacks: mk.catastrophic.slice(0, 3),
    hostAlive: true,
    siblingsHealthy: after.filter((r) => r.ok).length + '/' + N_SIB,
    failedSiblings: after.filter((r) => !r.ok),
    rssBefore_MB: +before.toFixed(1), rssDuring_MB: +rssMB().toFixed(1), peakHWM_MB: +peak.toFixed(1),
    isolateV8Heap_MB: +(v.isolate.getHeapStatisticsSync().used_heap_size / 1048576).toFixed(1),
  };
  const rBefore = rssMB();
  try { v.isolate.dispose(); report.oom.disposeThrew = false; } catch (e) { report.oom.disposeThrew = String(e.message).split('\n')[0]; }
  if (global.gc) { global.gc(); global.gc(); }
  report.oom.rssAfterDispose_MB = +rssMB().toFixed(1);
  report.oom.rssReclaimed_MB = +(rBefore - rssMB()).toFixed(1);
  report.oom.isDisposedAfter = v.isolate.isDisposed;
}

// ---- experiment 3: does a disposed isolate's memory ever come back? ----
{
  const vs = Array.from({ length: N_SIB }, () => mk(false));
  const pre = rssMB();
  vs.forEach((v, i) => { try { v.oom.apply(undefined, [], { timeout: 15000 }).catch(() => {}); } catch {} });
  await new Promise((r) => setTimeout(r, 1500));
  const peakMany = hwmMB();
  vs.forEach((v) => { try { v.isolate.dispose(); } catch {} });
  if (global.gc) global.gc();
  await new Promise((r) => setTimeout(r, 500));
  report.concurrentOOM = {
    launched: N_SIB, rssBefore_MB: +pre.toFixed(1), peakHWM_MB: +peakMany.toFixed(1),
    rssAfterDispose_MB: +rssMB().toFixed(1),
    hostAlive: true,
    survivorsStillHealthy: survivors.map(health).filter((r) => r.ok).length + '/' + N_SIB,
  };
}

report.finalHostRSS_MB = +rssMB().toFixed(1);
console.log(JSON.stringify(report, null, 1));
