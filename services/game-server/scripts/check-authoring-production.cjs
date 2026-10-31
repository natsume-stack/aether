'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
const { packageAuthoringResources } = require('./package-authoring-resources.cjs');

// Compile just the production checking boundary into a clean, external tree.
// It has no monorepo ancestor, SWC, ts-node or tools/ directory at runtime.
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'box3-authoring-production-'));
try {
  const entryDir = path.join(temporary, 'dist/src/edit/ai');
  fs.mkdirSync(entryDir, { recursive: true });
  for (const name of [
    'script-check-worker',
    'script-typecheck',
    'script-preview',
    'script-diagnostic-policy',
  ]) {
    const source = fs.readFileSync(path.join(__dirname, '../src/edit/ai', name + '.ts'), 'utf8');
    const compiled = ts.transpileModule(source, {
      fileName: name + '.ts',
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    });
    fs.writeFileSync(path.join(entryDir, name + '.js'), compiled.outputText);
  }
  const manifest = packageAuthoringResources(path.join(temporary, 'dist/authoring-resources'));
  assert.equal(manifest.files.length, 4);
  fs.mkdirSync(path.join(temporary, 'node_modules'));
  fs.symlinkSync(
    path.dirname(require.resolve('typescript/package.json')),
    path.join(temporary, 'node_modules/typescript'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const harness = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const { checkScriptIsolated } = require('./dist/src/edit/ai/script-check-worker');
    const { findAuthoringRoot } = require('./dist/src/edit/ai/script-typecheck');
    (async () => {
      assert.equal(findAuthoringRoot(), path.resolve('dist/authoring-resources'));
      const file={fileId:'main',name:'index.js',isClient:false,text:'world.say("original");'};
      const clean=await checkScriptIsolated(file,[file],'world.say("updated");',{});
      assert.equal(clean.available,true,JSON.stringify(clean));
      assert.equal(clean.accepted,true,JSON.stringify(clean));
      const bad=await checkScriptIsolated(file,[file],'world.thisMethodDoesNotExist();',{});
      assert.equal(bad.available,true,JSON.stringify(bad));
      assert.equal(bad.accepted,false);
      assert.ok(bad.diagnostics.some(row=>row.code==='TS2339'));
      const legacy={...file,text:'world.thisMethodDoesNotExist();'};
      const compatible=await checkScriptIsolated(legacy,[legacy],legacy.text+'\\n// preserved legacy error',{},'no-new-errors');
      assert.equal(compatible.accepted,true,JSON.stringify(compatible));
      assert.equal(compatible.clean,false);
      fs.renameSync('dist/authoring-resources/ui-binding.mjs','dist/authoring-resources/ui-binding.missing');
      const missing=await checkScriptIsolated(file,[file],file.text,{});
      assert.equal(missing.available,false,'missing validator must refuse');
      assert.equal(missing.passed,false);
      console.log('Production checker: clean/invalid/legacy/missing-resource checks passed without source checkout or dev loaders');
    })().catch(error=>{console.error(error);process.exitCode=1;});
  `;
  fs.writeFileSync(path.join(temporary, 'check.cjs'), harness);
  const env = { ...process.env };
  delete env.BOX_AUTHORING_REPO_ROOT;
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const child = spawnSync(process.execPath, ['check.cjs'], {
    cwd: temporary,
    env,
    encoding: 'utf8',
    timeout: 90000,
  });
  process.stdout.write(child.stdout || '');
  process.stderr.write(child.stderr || '');
  assert.ifError(child.error);
  assert.equal(child.status, 0, 'isolated compiled checker failed');
} finally {
  // The only recursive cleanup target is the exact directory we just created.
  fs.rmSync(temporary, { recursive: true, force: true });
}
