import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildContext } from '../src/index.js'
import { writeScript } from '../src/script-write.js'
import { seedProject, startMockEngine } from '../mock/engine.js'
import { contentHash, isCidV0 } from '../src/cid.js'

const mapId = '4c326f298de10dadc3f7'
const directory = 'e2e-map'

const goodScript = 'const hp = storage.world.get("hp")\nmodule.exports = { hp }\n'
const badSyntax = 'function ( {\n'
const secretScript = 'const dsn = "postgres://u:p@10.0.0.9/db"\nconsole.log(dsn)\n'

async function withEngine(t, options = {}) {
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'box3-mcp-e2e-'))
  t.after(() => fs.rmSync(projectsRoot, { recursive: true, force: true }))
  const seeded = seedProject(projectsRoot, {
    directory,
    permanentMapId: mapId,
    name: '端到端测试图',
    blobNameForm: options.blobNameForm || 'cidv0',
    localScripts: { 'index.js': 'server', 'clientIndex.js': 'client' },
    sharedScripts: [{ entry: 'lib.js', side: 'server', content: 'module.exports = { v: 1 }\n' }],
  })
  const engine = await startMockEngine({
    projectsRoot,
    events: options.events || [],
    tamper: options.tamper,
  })
  t.after(() => engine.close())
  const env = {
    ...process.env,
    BOX_CREATOR_BASE_URL: engine.baseUrl,
    BOX_CREATOR_CLI_TOKEN: engine.token,
    BOX_MAP_PROJECTS_ROOT: projectsRoot,
    BOX_MCP_TYPEGATE: options.typeGate || 'syntax',
    BOX_MCP_PROFILE: options.profile || 'authoring',
    BOX_MCP_ALLOW_WRITE: options.allowWrite === false ? '0' : '1',
    BOX_ENGINE_REPO_ROOT: path.resolve(import.meta.dirname, '..', '..', '..'),
  }
  const ctx = buildContext(env)
  ctx.mock = engine
  ctx.projectsRoot = projectsRoot
  ctx.seeded = seeded
  return ctx
}

function stateFile(ctx) {
  return path.join(ctx.projectsRoot, directory, 'source', 'project-state.json')
}

test('dry-run changes nothing on disk and hands back the revision token', async (t) => {
  const ctx = await withEngine(t)
  const before = fs.readFileSync(stateFile(ctx), 'utf8')
  const result = await writeScript(
    { mapId, side: 'server', entry: 'lib.js', content: goodScript },
    ctx,
  )
  assert.equal(result.dryRun, true)
  assert.equal(result.wouldWrite, true)
  assert.equal(result.currentRevision, ctx.seeded.projectHash)
  assert.equal(result.revisionSource, 'branch.headHash')
  assert.equal(result.predictedHash, contentHash(goodScript))
  assert.equal(result.rollbackAvailable, true)
  assert.equal(fs.readFileSync(stateFile(ctx), 'utf8'), before, 'dry-run 不允许碰盘')
})

test('confirm without expectedRevision is refused (engine has no CAS)', async (t) => {
  const ctx = await withEngine(t)
  await assert.rejects(
    () =>
      writeScript(
        { mapId, side: 'server', entry: 'lib.js', content: goodScript, confirm: true },
        ctx,
      ),
    (error) => error.code === 'REVISION_REQUIRED' && error.detail.currentRevision === ctx.seeded.projectHash,
  )
})

test('a stale expectedRevision is refused before any HTTP write', async (t) => {
  const ctx = await withEngine(t)
  const before = fs.readFileSync(stateFile(ctx), 'utf8')
  await assert.rejects(
    () =>
      writeScript(
        {
          mapId,
          side: 'server',
          entry: 'lib.js',
          content: goodScript,
          confirm: true,
          expectedRevision: 'QmStaleStaleStaleStaleStaleStaleStaleStaleSt1',
        },
        ctx,
      ),
    (error) => error.code === 'REVISION_CONFLICT',
  )
  assert.equal(fs.readFileSync(stateFile(ctx), 'utf8'), before)
})

test('happy path writes a shared script and the read-back is byte exact', async (t) => {
  const ctx = await withEngine(t)
  const plan = await writeScript({ mapId, side: 'server', entry: 'lib.js', content: goodScript }, ctx)
  const written = await writeScript(
    {
      mapId,
      side: 'server',
      entry: 'lib.js',
      content: goodScript,
      confirm: true,
      expectedRevision: plan.currentRevision,
    },
    ctx,
  )
  assert.equal(written.status, 'OK')
  assert.equal(written.writeResult.shared, true)
  assert.equal(written.writeResult.hash, contentHash(goodScript))
  assert.equal(written.verification.readBackSource, 'http-shared')
  assert.equal(written.verification.script.content, goodScript)
  assert.equal(written.failures.length, 0)

  const listed = await ctx.request({ path: ctx.apiPath('projects', mapId, 'scripts'), capability: 'scripts.read' })
  assert.ok(listed.data.scripts.some((script) => script.entry === 'lib.js'))
})

test('writing map-local index.js advances the version chain and reloads from disk', async (t) => {
  const ctx = await withEngine(t)
  const plan = await writeScript({ mapId, side: 'server', entry: 'index.js', content: goodScript }, ctx)
  assert.equal(plan.revisionSource, 'branch.headHash')
  assert.equal(plan.isNewScript, false)
  const written = await writeScript(
    {
      mapId,
      side: 'server',
      entry: 'index.js',
      content: goodScript,
      confirm: true,
      expectedRevision: plan.currentRevision,
    },
    ctx,
  )
  assert.equal(written.status, 'OK')
  assert.equal(written.writeResult.shared, false)
  assert.equal(written.verification.script.nameForm.form, 'cidv0')
  assert.equal(written.verification.script.contentVerified, true)
  assert.equal(written.unverified.length, 0)
  assert.equal(written.failures.length, 0)
  // The engine returns the NEW head for map-local writes and the OLD head for
  // shared writes; the guard must notice the chain actually moved.
  const after = ctx.store.readRevision(mapId)
  assert.notEqual(after.headHash, plan.currentRevision, 'headHash 必须前进')
  assert.equal(after.headHash, written.writeResult.revision)
  assert.equal(written.verification.readBackSource, 'local-disk')
  assert.equal(written.verification.script.content, goodScript)
  assert.equal(written.verification.reloadable, true)

  // Second write must use the new head, proving the token rotated.
  await assert.rejects(
    () =>
      writeScript(
        {
          mapId,
          side: 'server',
          entry: 'index.js',
          content: `${goodScript}// again\n`,
          confirm: true,
          expectedRevision: plan.currentRevision,
        },
        ctx,
      ),
    (error) => error.code === 'REVISION_CONFLICT',
  )
})

test('read-back mismatch triggers an automatic rollback to the original bytes', async (t) => {
  const ctx = await withEngine(t, { tamper: true })
  const original = 'module.exports = { v: 1 }\n'
  const written = await writeScript(
    {
      mapId,
      side: 'server',
      entry: 'lib.js',
      content: goodScript,
      confirm: true,
      expectedRevision: ctx.seeded.projectHash,
    },
    ctx,
  )
  assert.equal(written.status, 'FAILED_ROLLED_BACK')
  assert.ok(written.failures.some((item) => item.code === 'CONTENT_MUTATED'))
  assert.equal(written.rolledBack, true)
  const restored = await ctx.request({
    path: ctx.apiPath('projects', mapId, 'scripts', 'server', 'lib.js'),
    capability: 'scripts.read',
  })
  assert.equal(restored.data.content, original, '回滚必须把原内容写回')
})

test('acceptance loop fails loudly on an exception event with MODULE_NOT_FOUND', async (t) => {
  const ctx = await withEngine(t, {
    events: [
      { type: 'log', side: 'server', level: 3, message: 'boot' },
      {
        type: 'exception',
        side: 'server',
        level: 0,
        message: "Cannot find module 'missing.js'",
        stack: { name: 'Error', message: 'boom', stack: [{ function: 'f', file: 'missing.js', line: 3, column: 1 }] },
      },
    ],
  })
  ctx.mock.state.running = true
  const written = await writeScript(
    {
      mapId,
      side: 'server',
      entry: 'lib.js',
      content: "require('missing.js')\n",
      confirm: true,
      expectedRevision: ctx.seeded.projectHash,
      verify: true,
      sinceEventId: 1,
      typeGateMode: 'off',
    },
    ctx,
  )
  assert.equal(written.status, 'FAILED_ROLLED_BACK')
  assert.equal(written.acceptance.verdict, 'FAIL')
  assert.ok(written.acceptance.findings.some((item) => item.code === 'MODULE_NOT_FOUND'))
  assert.equal(written.rolledBack, true)
})

test('acceptance refuses to claim a pass when the runtime is idle', async (t) => {
  const ctx = await withEngine(t)
  ctx.mock.state.running = false
  const written = await writeScript(
    {
      mapId,
      side: 'server',
      entry: 'lib.js',
      content: goodScript,
      confirm: true,
      expectedRevision: ctx.seeded.projectHash,
      verify: true,
    },
    ctx,
  )
  assert.equal(written.acceptance.verdict, 'SKIPPED_RUNTIME_NOT_RUNNING')
  assert.equal(written.acceptance.passed, false)
  assert.equal(written.status, 'WRITTEN_ACCEPTANCE_UNVERIFIED', '运行时没起来只能算未验收，不能算通过')
  assert.equal(written.unresolved[0].code, 'RUNTIME_IDLE')
})

test('the type gate blocks before anything is sent', async (t) => {
  const ctx = await withEngine(t)
  const before = fs.readFileSync(stateFile(ctx), 'utf8')
  for (const content of [badSyntax, secretScript]) {
    await assert.rejects(
      () =>
        writeScript(
          { mapId, side: 'server', entry: 'lib.js', content, confirm: true, expectedRevision: ctx.seeded.projectHash },
          ctx,
        ),
      (error) => error.code === 'TYPE_GATE_FAILED',
    )
  }
  assert.equal(fs.readFileSync(stateFile(ctx), 'utf8'), before)
})

test('creating a brand new shared script needs an explicit opt-in', async (t) => {
  const ctx = await withEngine(t)
  const head = ctx.store.readRevision(mapId).headHash
  await assert.rejects(
    () =>
      writeScript(
        { mapId, side: 'client', entry: 'newcomer.js', content: 'console.log(1)\n', confirm: true, expectedRevision: head },
        ctx,
      ),
    (error) => error.code === 'ROLLBACK_PREIMAGE_UNAVAILABLE',
  )
  const created = await writeScript(
    {
      mapId,
      side: 'client',
      entry: 'newcomer.js',
      content: 'console.log(1)\n',
      confirm: true,
      expectedRevision: head,
      allowBlindWrite: true,
    },
    ctx,
  )
  assert.equal(created.status, 'OK')
  assert.equal(created.writeResult.shared, true)
})

test('map-local entries cannot be written without a readable revision source', async (t) => {
  const ctx = await withEngine(t)
  ctx.store.projectsRoot = ''
  await assert.rejects(
    () =>
      writeScript(
        { mapId, side: 'server', entry: 'index.js', content: goodScript, confirm: true, allowBlindWrite: true },
        ctx,
      ),
    (error) => error.code === 'REVISION_SOURCE_UNAVAILABLE',
  )
})

test('readonly profile does not advertise or accept the write tool', async (t) => {
  const ctx = await withEngine(t, { profile: 'readonly' })
  const { buildTools } = await import('../src/tools.js')
  assert.ok(!buildTools(ctx).some((tool) => tool.name === 'script_write'))
  await assert.rejects(
    () => writeScript({ mapId, side: 'server', entry: 'lib.js', content: goodScript, confirm: true }, ctx),
    (error) => error.code === 'WRITE_DISABLED',
  )
})

/**
 * REAL DATA #1 — URL-safe SHA-256 blob names.
 *
 * A cloud-imported map carries its whole version chain under 43-character
 * base64url names (`box3-re/tmp/a9-jscripts.txt` shows both forms inside one
 * `source/blobs/`). The engine's own writer only ever emits CIDv0
 * (`storeReleaseBlob` -> `contentHash`, project-manager.js:196-205), so this
 * test pins the asymmetry the guards have to live with: read either form,
 * write CIDv0, and never mistake the imported naming for a stale revision or
 * a corrupt blob. The pre-slice code would have skipped the digest check
 * entirely on such a map.
 */
test('an imported map with URL-safe blob names keeps CAS, pre-image and read-back honest', async (t) => {
  const ctx = await withEngine(t, { blobNameForm: 'sha256-url' })
  const head = ctx.seeded.projectHash
  assert.equal(isCidV0(head), false)
  assert.equal(head.length, 43)

  const plan = await writeScript({ mapId, side: 'server', entry: 'index.js', content: goodScript }, ctx)
  assert.equal(plan.revisionSource, 'branch.headHash')
  assert.equal(plan.currentRevision, head, '乐观锁令牌就是 URL-safe 名字本身，不能被当成不可读')
  assert.equal(plan.preImageSource, 'local-disk')
  assert.equal(plan.rollbackAvailable, true)
  // The engine, not the caller, decides the name of what it writes.
  assert.equal(plan.predictedNameForm, 'cidv0')
  assert.equal(plan.predictedHash, contentHash(goodScript))
  assert.notEqual(plan.predictedHash, head, '写产生的名字不会是链上那个 URL-safe 名字')

  const written = await writeScript(
    { mapId, side: 'server', entry: 'index.js', content: goodScript, confirm: true, expectedRevision: head },
    ctx,
  )
  assert.equal(written.status, 'OK')
  assert.equal(written.failures.length, 0)
  assert.equal(written.unverified.length, 0, 'CIDv0 是可复算的形式，不该报 unverified')
  assert.equal(written.writeResult.hash, contentHash(goodScript))
  assert.equal(written.verification.readBackSource, 'local-disk')
  assert.equal(written.verification.script.content, goodScript)
  assert.equal(written.verification.script.nameForm.form, 'cidv0')
  assert.equal(written.verification.script.contentVerified, true)
  const after = ctx.store.readRevision(mapId)
  assert.equal(after.headHash, written.writeResult.revision)
  assert.equal(isCidV0(after.headHash), true, '写后的头变成 CIDv0，链仍然走通')

  await assert.rejects(
    () =>
      writeScript(
        { mapId, side: 'server', entry: 'index.js', content: `${goodScript}// more\n`, confirm: true, expectedRevision: head },
        ctx,
      ),
    (error) => error.code === 'REVISION_CONFLICT',
    '旧 import 图上的过期令牌同样必须被拒',
  )
})

/**
 * REAL DATA #2 — client scripts are ES modules.
 * `clientIndex.js` runs from an Import Map inside an iframe as
 * `<script type="module">` (ses-client.ts:283-294), so the write path must
 * accept top-level import/export for `side:"client"` by default and still
 * refuse the same bytes for `side:"server"`, whose isolate is CommonJS
 * (resource.ts:387-405 + safe-eval.ts:36-52).
 */
const esmClientScript = "import { hp } from './lib.js'\nexport const ready = true\nawait Promise.resolve(1)\n"

test('a client entry script is written as ESM and read back byte exact', async (t) => {
  const ctx = await withEngine(t)
  const head = ctx.store.readRevision(mapId).headHash
  const plan = await writeScript({ mapId, side: 'client', entry: 'clientIndex.js', content: esmClientScript }, ctx)
  assert.equal(plan.gate.dialect, 'esm')
  assert.equal(plan.gate.satisfied, true, JSON.stringify(plan.gate.errors))

  const written = await writeScript(
    {
      mapId,
      side: 'client',
      entry: 'clientIndex.js',
      content: esmClientScript,
      confirm: true,
      expectedRevision: head,
    },
    ctx,
  )
  assert.equal(written.status, 'OK')
  assert.equal(written.verification.script.side, 'client')
  assert.equal(written.verification.script.content, esmClientScript)
  assert.equal(written.verification.reloadable, true)

  // The identical bytes are illegal on the server side, and that must be the
  // only reason the write is refused: nothing reaches the engine. The revision
  // has to be re-read because the client write above already advanced the head
  // (CAS is checked before the gate, on purpose, so a stale token is refused
  // without ever evaluating the content).
  const freshHead = ctx.store.readRevision(mapId).headHash
  const before = fs.readFileSync(stateFile(ctx), 'utf8')
  await assert.rejects(
    () =>
      writeScript(
        {
          mapId,
          side: 'server',
          entry: 'index.js',
          content: esmClientScript,
          confirm: true,
          expectedRevision: freshHead,
        },
        ctx,
      ),
    (error) => {
      assert.equal(error.code, 'TYPE_GATE_FAILED')
      assert.ok(error.detail.errors.some((item) => item.code === 'ESM_SYNTAX_IN_CJS_SCRIPT'))
      return true
    },
  )
  assert.equal(fs.readFileSync(stateFile(ctx), 'utf8'), before, '类型门必须在任何 HTTP 写之前拦住')
})
