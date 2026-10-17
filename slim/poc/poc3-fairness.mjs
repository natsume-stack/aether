// W7 PoC-3: CPU fairness under a runaway isolate.
// The engine's own semantics: every call into an isolate carries {timeout: scriptTimeout}
// and a timeout is treated as a crash. Two host call forms exist and they behave
// completely differently, so measure both:
//   async  -> ref.apply(...)        (what ivmp-vm-controller.ts:383 uses)
//   sync   -> ref.applySync(...)    (blocks the calling JS thread)
import { createRequire } from 'node:module';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
const require = createRequire(import.meta.url);
const ivm = require('isolated-vm');
const { AUTHOR_SCRIPT } = await import('./author-script.mjs');

const MEM = 512, TICK_MS = 50, DURATION_MS = Number(process.argv[2] || 6000), TIMEOUT = 10000;
const N_ISO = Number(process.argv[3] || 3);
const HANG_FROM = Number(process.argv[4] || 1500);
const HANG_MS = Number(process.argv[5] || 3000);
const HANG_MODE = process.argv[6] || 'async';   // async | sync
const HANG_COUNT = Number(process.argv[7] || 1); // how many isolates run while(true) at once

const mk = () => {
  const isolate = new ivm.Isolate({ memoryLimit: MEM });
  const context = isolate.createContextSync();
  isolate.compileScriptSync(AUTHOR_SCRIPT, { filename: 'author.js' }).runSync(context);
  isolate.compileScriptSync('globalThis.__hang = () => { while (true) {} };', {}).runSync(context);
  return {
    isolate, context,
    tick: context.global.getSync('__pocTick', { reference: true }),
    hang: context.global.getSync('__hang', { reference: true }),
  };
};
const iso = Array.from({ length: N_ISO }, () => mk());
const EC = (o) => new ivm.ExternalCopy(o).copyInto({ transferIn: true, release: true });

const pctOf = (a, q) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.max(0, Math.min(s.length - 1, Math.ceil(q / 100 * s.length) - 1))] : NaN; };
const phase = iso.map(() => ({ before: [], during: [] }));
const errors = iso.map(() => []);
const hangEvents = [];
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

const t0 = performance.now();
let running = true, inHang = false;

async function loop(i) {
  let prev = performance.now();
  while (running) {
    await new Promise((r) => setTimeout(r, TICK_MS));
    if (!running) break;
    const now = performance.now();
    const gap = now - prev - TICK_MS;   // deviation from the 50ms target
    prev = now;
    (inHang ? phase[i].during : phase[i].before).push(gap);
    try {
      // async call, exactly like the engine's .apply(...,{timeout})
      await iso[i].tick.apply(undefined, [EC({ steps: 6, dt: 0.016, i })],
        { timeout: TIMEOUT, result: { copy: true, depth: 1 } });
    } catch (e) { errors[i].push(String(e.message).split('\n')[0]); }
  }
}

const hangStart = new Promise((resolve) => setTimeout(() => resolve(performance.now() - t0), HANG_FROM));
hangStart.then((at) => {
  inHang = true;
  hangEvents.push({ atMs: +at.toFixed(1), msg: 'isolate#0..#' + (HANG_COUNT - 1) + ' start while(true); form=' + HANG_MODE + ' budget=' + HANG_MS + 'ms' });
  let settled = 0;
  for (let h = 0; h < HANG_COUNT; h++) {
    const th = performance.now();
    const done = (ok, extra) => {
      hangEvents.push({
        iso: h, atMs: +(performance.now() - th).toFixed(1), msg: ok, ...extra,
        thisIsolateAlive: !iso[h].isolate.isDisposed,
        othersAlive: iso.filter((_, j) => j !== h).every((v) => !v.isolate.isDisposed),
      });
      if (++settled === HANG_COUNT) setTimeout(() => { inHang = false; }, 400);
    };
    if (HANG_MODE === 'async') {
      iso[h].hang.apply(undefined, [], { timeout: HANG_MS })
        .then(() => done('hang returned WITHOUT error'))
        .catch((e) => done('timeout FIRED', { err: String(e.message).split('\n')[0] }));
    } else {
      try { iso[h].hang.applySync(undefined, [], { timeout: HANG_MS }); done('hang returned WITHOUT error'); }
      catch (e) { done('timeout FIRED (sync)', { err: String(e.message).split('\n')[0] }); }
    }
  }
});

const timers = iso.map((_, i) => loop(i));
await new Promise((r) => setTimeout(r, DURATION_MS));
running = false;
await Promise.all(timers).catch(() => {});
loopDelay.disable();

const rows = iso.map((_, i) => ({
  idx: i,
  role: i < HANG_COUNT ? 'HANGER' : 'victim',
  ticksBefore: phase[i].before.length,
  ticksDuring: phase[i].during.length,
  jitter_before_ms: { p50: +pctOf(phase[i].before, 50).toFixed(2), p99: +pctOf(phase[i].before, 99).toFixed(2), max: +(phase[i].before.length ? Math.max(...phase[i].before) : 0).toFixed(2) },
  jitter_during_ms: { p50: +pctOf(phase[i].during, 50).toFixed(2), p99: +pctOf(phase[i].during, 99).toFixed(2), max: +(phase[i].during.length ? Math.max(...phase[i].during) : 0).toFixed(2) },
  callErrors: errors[i].length, firstError: errors[i][0] || null,
}));
const agg = (pred) => {
  const sel = rows.filter(pred);
  const b = [], d = [];
  sel.forEach((r) => { b.push(r.jitter_before_ms.p50); d.push(r.jitter_during_ms.p99); });
  return { n: sel.length, worst_before_p50: +Math.max(...b, 0).toFixed(2), worst_during_p99: +Math.max(...d, 0).toFixed(2) };
};
console.log(JSON.stringify({
  config: { HANG_MODE, HANG_COUNT, N_ISO, TICK_MS, DURATION_MS, TIMEOUT, HANG_FROM, HANG_MS, memMB: MEM, cores: require('os').cpus().length },
  hangEvents,
  victim_summary: agg((r) => r.role === 'victim'),
  hanger_summary: agg((r) => r.role === 'HANGER'),
  perIsolate: rows,
  mainEventLoopDelay_ms: {
    p50: +(loopDelay.percentile(50) / 1e6).toFixed(2),
    p99: +(loopDelay.percentile(99) / 1e6).toFixed(2),
    max: +(loopDelay.max / 1e6).toFixed(2),
  },
  post_hang_health: iso.map((v, i) => {
    try { const r = v.tick.applySync(undefined, [EC({ steps: 4, dt: 0.016, i })], { timeout: 2000, result: { copy: true, depth: 1 } }); return i + ':OK tick=' + r.tick; }
    catch (e) { return i + ':DEAD ' + String(e.message).split('\n')[0]; }
  }),
}, null, 1));
iso.forEach((v) => v.isolate.dispose());
