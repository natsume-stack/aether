// Enumerate isolated-vm@5.0.4 real API surface (no guessing).
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const ivm = require('isolated-vm');

function protoOf(o, label) {
  const seen = new Set();
  let cur = o, depth = 0;
  const out = [];
  while (cur && depth < 5) {
    for (const k of Object.getOwnPropertyNames(cur)) {
      if (k === 'constructor' || seen.has(k)) continue;
      seen.add(k);
      let d = 'fn';
      try { d = typeof o[k] === 'function' ? 'fn' : typeof o[k]; } catch { d = 'getter'; }
      out.push(k + ':' + d);
    }
    cur = Object.getPrototypeOf(cur);
    depth++;
  }
  console.log('### ' + label + '\n  ' + out.join('\n  '));
}

console.log('=== ivm top-level keys ===');
console.log(Object.keys(ivm).join(', '));

const isolate = new ivm.Isolate({ memoryLimit: 512 });
protoOf(isolate, 'Isolate instance');
const context = isolate.createContextSync();
protoOf(context, 'Context instance');
const script = isolate.compileScriptSync('1+2');
protoOf(script, 'Script instance');

console.log('=== live probe of memory APIs ===');
for (const name of ['getHeapSize', 'getHeapStatistics', 'getHeapUsage', 'getExternalMemory',
                    'isLowMemory', 'acquireHeapSize', 'compileScriptSync']) {
  console.log(name, '->', typeof isolate[name]);
}
console.log('heapUsage =', JSON.stringify(isolate.getHeapUsage && isolate.getHeapUsage()));
console.log('isLowMemory =', isolate.isLowMemory && isolate.isLowMemory());
console.log('getExternalMemory =', isolate.getExternalMemory && isolate.getExternalMemory());
isolate.dispose();
