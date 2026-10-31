import assert from 'node:assert/strict';
import { createScriptTools } from '../src/edit/ai/entity-tools';
import { coordinateAuthoring, authoringSessionFor } from '../src/edit/ai/authoring-tools';
import { createAiToolRouteHandler } from '../src/edit/ai/ai-tool-route';
import http from 'node:http';
import { once } from 'node:events';
import { checkScriptSnapshot } from '../src/edit/ai/script-typecheck';
import { checkScriptIsolated } from '../src/edit/ai/script-check-worker';
import fs from 'node:fs/promises';
import path from 'node:path';
import { scriptRevision } from '../src/edit/ai/script-preview';

async function main() {
  const file = { fileId: 'fixture', name: 'main.js', isClient: false, text: 'const score = 1;\n', order: 0 };
  const state = { codeEditor: { fileDict: { fixture: file } }, replica: { project: { uiTree: {} } } };
  const tools = coordinateAuthoring(state, createScriptTools(state as any, {} as any, { info() {} } as any));
  // Review must remain available even when journal failure blocks mutations.
  authoringSessionFor(state)!.disableWrites();
  const read = await (tools.readScript.execute as any)({ fileId: 'fixture' });
  assert.match(read.revision, /^[a-f0-9]{64}$/);
  const args = { fileId: 'fixture', expectedRevision: read.revision, edits: [{ index: 14, deleteCount: 1, text: '2' }] };
  assert.equal((tools.scriptPreview.inputSchema as any).safeParse(args).success, true);
  const preview = await (tools.scriptPreview.execute as any)(args);
  assert.equal(preview.content, 'const score = 2;\n');
  assert.equal(preview.applied, false);
  assert.equal(file.text, 'const score = 1;\n');
  file.text = 'const score = 3;\n';
  await assert.rejects((tools.scriptPreview.execute as any)(args), { code: 'REVISION_CONFLICT' });
  assert.equal(file.text, 'const score = 3;\n');
  assert.equal((await (tools.scriptPreview.execute as any)({ ...args, fileId: 'missing' })).code, 'FILE_NOT_FOUND');
  const valid = checkScriptSnapshot(file, [file], 'world.say("hello");');
  assert.equal(valid.available, true, JSON.stringify(valid));
  assert.equal(valid.passed, true, JSON.stringify(valid));
  const invalid = checkScriptSnapshot(file, [file], 'world.thisMethodDoesNotExist();');
  assert.equal(invalid.passed, false);
  assert.ok(invalid.diagnostics.some(row => row.code === 'TS2339'));
  const syntax = checkScriptSnapshot(file, [file], 'const = ;');
  assert.equal(syntax.passed, false);
  assert.equal(checkScriptSnapshot(file, [file], 'export const value = 1;').passed, false);
  const client = { ...file, isClient: true };
  const clientCheck = checkScriptSnapshot(client, [client], 'export const value = await Promise.resolve(1);');
  assert.equal(clientCheck.passed, true, JSON.stringify(clientCheck));
  const changed = checkScriptSnapshot(file, [file, { ...file, fileId: 'second', name: 'second.js', text: '' }], 'world.say("hello");');
  assert.notEqual(changed.dependencyRevision, valid.dependencyRevision);
  const named = { ...file, name: '中文脚本（别动）.js' };
  assert.equal(checkScriptSnapshot(named, [named], 'world.say("hello");').passed, true);
  const moduleSource = { ...file, name: 'Main.js' };
  const dependency = { ...file, fileId: 'module', name: 'Helpers.js', text: 'export const score = 1;' };
  const moduleCheck = checkScriptSnapshot(moduleSource, [moduleSource, dependency], 'const helper = require("./Helpers.js"); world.say(String(helper.score));');
  assert.equal(moduleCheck.passed, true, JSON.stringify(moduleCheck));
  let ticks = 0;
  const interval = setInterval(() => ticks++, 10);
  try {
    const pending = checkScriptIsolated(file, [file], 'world.say("hello");');
    const busy = await checkScriptIsolated(file, [file], 'world.say("hello");');
    assert.equal(busy.code, 'SCRIPT_CHECK_BUSY');
    const isolated = await pending;
    assert.equal(isolated.passed, true, JSON.stringify(isolated));
    assert.ok(ticks > 0, 'Main thread remained responsive during compilation');
  } finally { clearInterval(interval); }
  const missingBinding = await checkScriptIsolated(client, [client], 'ui.findChildByName("missing");', {});
  assert.equal(missingBinding.available, true, JSON.stringify(missingBinding));
  assert.equal(missingBinding.passed, false);
  assert.ok(missingBinding.bindings?.problems.some((row: any) => row.code === 'UI_TREE_REF_UNRESOLVED'));
  const oldError = { ...file, text: 'world.legacyMissing();\n' };
  const compatible = await checkScriptIsolated(oldError, [oldError], '// harmless prefix\n' + oldError.text, {}, 'no-new-errors');
  assert.equal(compatible.accepted, true, JSON.stringify(compatible));
  assert.equal(compatible.passed, false);
  assert.equal(compatible.clean, false);
  assert.equal(compatible.comparison?.introducedErrorCount, 0);
  const replacementError = await checkScriptIsolated(oldError, [oldError], 'world.anotherMissing();\n', {}, 'no-new-errors');
  assert.equal(replacementError.accepted, false, JSON.stringify(replacementError));
  assert.ok(replacementError.comparison!.introducedErrorCount > 0);
  const duplicateError = await checkScriptIsolated(oldError, [oldError], oldError.text + oldError.text, {}, 'no-new-errors');
  assert.equal(duplicateError.accepted, false);
  const badSyntax = await checkScriptIsolated(oldError, [oldError], 'const = ;', {}, 'no-new-errors');
  assert.equal(badSyntax.accepted, false);
  const oldBinding = { ...client, text: 'ui.findChildByName("oldMissing");\n' };
  const existingBinding = await checkScriptIsolated(oldBinding, [oldBinding], '// prefix\n' + oldBinding.text, {}, 'no-new-errors');
  assert.equal(existingBinding.accepted, true, JSON.stringify(existingBinding));
  assert.equal(existingBinding.passed, false);
  const newBinding = await checkScriptIsolated(oldBinding, [oldBinding], 'ui.findChildByName("newMissing");\n', {}, 'no-new-errors');
  assert.equal(newBinding.accepted, false);
  const exported = { ...file, name: 'library.js', text: 'export const value = 1;' };
  const importing = { ...file, fileId: 'consumer', name: 'consumer.js', text: 'const lib = require("./library.js"); world.say(String(lib.value));' };
  // Changing a dependency may break another file even if the candidate itself has no error.
  const brokenConsumer = await checkScriptIsolated({ ...exported, isClient: true },
    [{ ...exported, isClient: true }, { ...importing, isClient: true }], 'export const renamed = 1;', {}, 'no-new-errors');
  assert.equal(brokenConsumer.accepted, false, JSON.stringify(brokenConsumer));
  assert.ok(brokenConsumer.diagnostics.some(row => row.code === 'TS2339'));
  const sibling = { ...file, fileId: 'other-module', name: 'other.js', text: 'const score = "independent";' };
  const isolatedModuleScope = checkScriptSnapshot(file, [file, sibling], 'const score = 1;');
  assert.equal(isolatedModuleScope.passed, true, JSON.stringify(isolatedModuleScope));
  const changingCheck = (tools.scriptCheck.execute as any)({ ...args, expectedRevision: scriptRevision(file) });
  const editDuringCheck = setTimeout(() => { file.text += '// human edit\n'; }, 10);
  try {
    const checked = await changingCheck;
    assert.equal(checked.sourceStillMatches, false);
    assert.equal(checked.dependenciesStillMatch, false);
    assert.equal(file.text, 'const score = 3;\n// human edit\n');
  } finally { clearTimeout(editDuringCheck); file.text = 'const score = 3;\n'; }
  const previousRoot = process.env.BOX_AUTHORING_REPO_ROOT;
  try {
    process.env.BOX_AUTHORING_REPO_ROOT = process.cwd();
    const unavailable = checkScriptSnapshot(file, [file], 'world.say("hello");');
    assert.equal(unavailable.available, false);
    assert.equal(unavailable.passed, false);
  } finally {
    if (previousRoot === undefined) delete process.env.BOX_AUTHORING_REPO_ROOT;
    else process.env.BOX_AUTHORING_REPO_ROOT = previousRoot;
  }
  const handler = createAiToolRouteHandler({ state, replica: {}, codeEditorController: {}, gameId: 1,
    logger: { info() {}, error() {} } } as any);
  const server = http.createServer((req, res) => { void handler(req, res); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}/internal/ai-tool`;
    const catalog = await (await fetch(url)).json() as any;
    assert.ok(catalog.tools.some((t: any) => t.name === 'scriptPreview'));
    const request = (tool: string, args: any) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool, args }) });
    const readResponse = await (await request('readScript', { fileId: 'fixture' })).json() as any;
    const response = await request('scriptPreview', { ...args, expectedRevision: readResponse.result.revision });
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as any).result.applied, false);
    assert.equal((await request('scriptPreview', args)).status, 409);
    const checkResponse = await request('scriptCheck', { ...args, expectedRevision: readResponse.result.revision });
    assert.equal(checkResponse.status, 200);
    const checked = ((await checkResponse.json()) as any).result;
    assert.equal(checked.check.available, true, JSON.stringify(checked));
    assert.equal(checked.check.passed, true, JSON.stringify(checked));
    assert.equal(checked.sourceStillMatches, true);
    assert.equal(checked.dependenciesStillMatch, true);
    assert.equal(checked.check.bindings.ok, true);
    assert.equal(file.text, 'const score = 3;\n');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  const root = path.resolve(__dirname, '../../..');
  await fs.mkdir(path.join(root, '.local-evidence'), { recursive: true });
  await fs.writeFile(path.join(root, '.local-evidence/script-review-integration.json'), JSON.stringify({ at: new Date().toISOString(),
    scope: 'Local fixture with actual factories, coordinator, HTTP router, worker and shipped API declarations; not a live-map edit',
    checks: ['read revision', 'preview no write', 'stale revision HTTP 409', 'missing file refusal',
      'valid API passes', 'invalid API member fails', 'syntax error fails', 'server ESM refused', 'client ESM and top-level await pass',
      'Chinese filenames supported', 'missing declarations unavailable', 'dependency fingerprint changes',
      'worker keeps main event loop responsive', 'concurrent worker refused busy', 'missing UI reference fails',
      'HTTP check uses worker and UI bindings', 'edit during worker check detected without overwrite', 'all source text unchanged by checks',
      'explicit legacy policy preserves existing errors without claiming clean', 'new and repeated errors refused',
      'UI baseline tolerates line shifts and refuses new missing references', 'dependent file errors checked',
      'script-local declarations do not leak into sibling module scopes'],
  }, null, 2));
  console.log('PASS script review: factory, HTTP, isolated compiler, dependency identity and UI binding integration');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
