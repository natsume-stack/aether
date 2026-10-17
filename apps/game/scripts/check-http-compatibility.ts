import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { copyToClipboard, writeClipboardText } from '../src/utils/copy2clipboard';
import { estimateStorage } from '../src/utils/storage/local-storage';
import { microphoneUnavailableReason } from '../src/engine/script/ses/apis/media-support';

function globals(values: Record<string, unknown>) {
  const saved = Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  return () => saved.forEach(([key, descriptor]) => {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  });
}

test('HTTP copying falls back without Clipboard API, restores focus, and never reports false success', async () => {
  let success = true;
  let removed = 0;
  let focus = 0;
  const restore = globals({
    window: {}, navigator: {},
    document: {
      activeElement: { focus() { focus++; } },
      body: { appendChild() {} },
      createElement: () => ({ style: {}, setAttribute() {}, focus() {}, select() {}, setSelectionRange() {}, remove() { removed++; } }),
      execCommand: () => success,
    },
  });
  try {
    await writeClipboardText('地图资源');
    success = false;
    assert.equal(copyToClipboard('不能复制'), false);
    await assert.rejects(writeClipboardText('不能复制'), /手动/);
    success = true;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
      clipboard: { async writeText() { throw new Error('permission denied'); } },
    } });
    await writeClipboardText('拒绝权限后回退');
    assert.equal(removed, 4);
    assert.equal(focus, 4);
  } finally { restore(); }
});

test('HTTP microphone restrictions are explicit and do not masquerade as denied permission', () => {
  const restore = globals({ window: { isSecureContext: false }, navigator: {}, MediaRecorder: undefined });
  try { assert.match(microphoneUnavailableReason()!, /HTTP.*HTTPS.*上传和播放不受影响/); }
  finally { restore(); }
});

test('secure loopback/HTTPS microphone support remains usable', () => {
  const restore = globals({ window: { isSecureContext: true }, navigator: { mediaDevices: { getUserMedia() {} } }, MediaRecorder: class {} });
  try { assert.equal(microphoneUnavailableReason(), undefined); }
  finally { restore(); }
});

test('missing or rejected storage estimates remain unknown rather than crashing or claiming zero', async () => {
  for (const navigator of [{}, { storage: { async estimate() { throw new Error('denied'); } } }]) {
    const restore = globals({ navigator });
    try { assert.deepEqual(await estimateStorage(), {}); }
    finally { restore(); }
  }
});

test('public HTTP skips optional map prefetch but never bypasses mandatory signed launcher cache', async () => {
  const filename = path.resolve(__dirname, '../components/play-resource-cache-bootstrap.tsx');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} as { bootstrapPlayResourceCache: (options: object) => Promise<void> } };
  vm.runInNewContext(compiled, {
    module, exports: module.exports, Error,
    require: (id: string) => id === 'react' ? { useEffect() {} } : { apiClient: {} },
  });
  const { bootstrapPlayResourceCache } = module.exports;
  const options = {
    world: 'test-map', isSecureContext: false,
    fetchManifest: async () => { assert.fail('HTTP must not prefetch'); },
    serviceWorkerContainer: { register: async () => { assert.fail('HTTP must not register'); } },
  };
  await bootstrapPlayResourceCache(options);
  await assert.rejects(bootstrapPlayResourceCache({ ...options, waitForCompletion: true }), /HTTPS/);
});
