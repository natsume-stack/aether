// Discover how to get a callable handle out of script.runSync in ivm@5.0.4
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const ivm = require('isolated-vm');

const isolate = new ivm.Isolate({ memoryLimit: 256 });
const context = isolate.createContextSync();

function show(label, fn) {
  try {
    const r = fn();
    console.log(label, '=> OK type=' + typeof r + ' keys=' +
      (r && typeof r === 'object' ? Object.getOwnPropertyNames(r).slice(0, 12).join(',') : String(r)));
    return r;
  } catch (e) {
    console.log(label, '=> ERR ' + String(e.message).split('\n')[0]);
  }
}

// A) plain completion value (object literal)
show('A runSync no-opts', () => {
  const s = isolate.compileScriptSync('({ f(){ return 7; } })');
  return s.runSync(context);
});

// B) reference result
show('B runSync reference', () => {
  const s = isolate.compileScriptSync('({ f(){ return 7; } })');
  return s.runSync(context, { result: { reference: true } });
});

// C) ivm available inside?
show('C typeof ivm inside', () => {
  const s = isolate.compileScriptSync('typeof ivm');
  return s.runSync(context);
});

// D) inject ivm then ExternalCopy pattern (what the engine does in dev)
show('D injected ivm ExternalCopy', () => {
  context.global.setSync('ivm', ivm);
  const s = isolate.compileScriptSync(
    'new ivm.ExternalCopy({ f(){ return 7; } }).copyInto({ transferIn: true, release: true })'
  );
  return s.runSync(context, { result: { reference: true, transferred: true } });
});

// E) context.eval with reference
show('E eval reference', () => context.evalSync('({ f(){ return 7; } })', { result: { reference: true } }));

// F) Reference class + wrap
show('F wrap call', () => {
  const h = context.evalSync('({ f(){ return 7; } })', { result: { reference: true } });
  if (!h) return 'no handle';
  console.log('   handle methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(h)).join(','));
  return h.applySync('f', [], { result: { promise: false } });
});

isolate.dispose();
