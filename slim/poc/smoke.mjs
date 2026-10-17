// W7 PoC smoke test: can isolated-vm@5.0.4 load at all in the play image?
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

console.log('node', process.version, process.platform, process.arch);

let ivm = null;
const tries = [
  'isolated-vm',
  '/app/services/game-server/node_modules/.pnpm/isolated-vm@5.0.4/node_modules/isolated-vm',
  '/app/services/game-server/node_modules/isolated-vm',
];
for (const p of tries) {
  try {
    ivm = require(p);
    console.log('LOAD OK from:', p);
    break;
  } catch (e) {
    console.log('LOAD FAIL from:', p, '->', String(e.message).split('\n')[0]);
  }
}
if (!ivm) { console.log('SMOKE FAIL - cannot load isolated-vm'); process.exit(42); }

console.log('pkg version:', require('isolated-vm/package.json').version);

const isolate = new ivm.Isolate({ memoryLimit: 512 });
console.log('isolate created');
const context = isolate.createContextSync({});
console.log('context created');
const script = isolate.compileScriptSync('1+2', {});
console.log('compileScriptSync ok, runSync =', script.runSync(context));

console.log('API present:', JSON.stringify({
  getHeapSize: typeof isolate.getHeapSize,
  getExternalMemory: typeof isolate.getExternalMemory,
  acquireHeapSize: typeof isolate.acquireHeapSize,
  isLowMemory: typeof isolate.isLowMemory,
  dispose: typeof isolate.dispose,
  createContext: typeof isolate.createContext,
  compileScript: typeof isolate.compileScript,
  Reference: typeof ivm.Reference,
  ExternalCopy: typeof ivm.ExternalCopy,
  Promise: typeof ivm.Promise,
}));

console.log('heapSize MB =', (isolate.getHeapSize() / 1048576).toFixed(3),
            'external MB =', (isolate.getExternalMemory() / 1048576).toFixed(3),
            'lowMemory?', isolate.isLowMemory());
isolate.dispose();
console.log('disposed OK');
console.log('SMOKE PASS  VmRSS=' +
  (require('fs').readFileSync('/proc/self/status', 'utf8').match(/VmRSS:\s*(\d+)/)[1] / 1024).toFixed(1) + ' MB');
