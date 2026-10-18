/**
 * P0-A GUARDRAIL TESTS: every writer on the merged face is driven over the
 * protocol against the loopback double (mock/authoring.js), each on a real
 * refusal path, and each refusal must arrive as the uniform
 * `{code, retryable, hint}` contract.
 *
 * The four guardrails being pinned (all copied from `script_write`'s shape,
 * src/script-write.js, and shared through src/tools/_shared.js):
 *   1. optimistic lock  — expectedRevision, engine-authoritative where the tool
 *      takes one (terrainApply / uiNodeAdd), MCP-layer snapshot elsewhere;
 *   2. budget gate      — cells / batch sizes refused HERE, before the engine;
 *   3. transactional rollback — a mid-batch failure removes what was already
 *      created and reports `rollback`;
 *   4. hard ordering    — a live preview must refuse voxel writes and forced
 *      saves, because the engine records no chunk hashes while running
 *      (services/game-server/src/replica/…/replica-server.ts:1602).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildContext } from '../src/index.js'
import { createHandler } from '../src/server.js'
import { seedProject, startMockEngine } from '../mock/engine.js'

const MAP = 'wire-map'

async function harness(t, authoring = {}) {
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'box3-mcp-guard-'))
  t.after(() => fs.rmSync(projectsRoot, { recursive: true, force: true }))
  seedProject(projectsRoot, {
    directory: MAP,
    permanentMapId: 'cccccccccccccccccccc',
    name: '护栏图',
    localScripts: { 'index.js': 'server' },
    sharedScripts: [{ entry: 'lib.js', side: 'server', content: 'module.exports = 1\n' }],
  })
  const engine = await startMockEngine({
    projectsRoot,
    events: [],
    authoring: { projectId: MAP, entities: { izr_root: { id: '1', name: 'root' } }, ...authoring },
  })
  t.after(() => engine.close())
  const ctx = buildContext({
    BOX_CREATOR_BASE_URL: engine.baseUrl,
    BOX_CREATOR_CLI_TOKEN: engine.token,
    BOX_MAP_PROJECTS_ROOT: projectsRoot,
    BOX_MCP_TYPEGATE: 'syntax',
    BOX_ENGINE_REPO_ROOT: path.resolve(import.meta.dirname, '..', '..', '..'),
  })
  const handle = createHandler(ctx)
  let id = 0
  const call = async (name, args) => handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } })
  const ok = async (name, args) => {
    const response = await call(name, args)
    assert.equal(response.result.isError, false, `${name} 应当成功：${JSON.stringify(response.result.structuredContent?.error)}`)
    return response.result.structuredContent
  }
  /** The contract itself: code + retryable + hint, and no stack, no raw body in message. */
  const fails = async (name, args, code) => {
    const response = await call(name, args)
    assert.equal(response.result.isError, true, `${name} 必须失败`)
    const error = response.result.structuredContent.error
    assert.equal(error.code, code, `${name} 的错误码：${JSON.stringify(error)}`)
    assert.equal(typeof error.retryable, 'boolean', `${name} 缺 retryable`)
    assert.equal(typeof error.hint, 'string', `${name} 缺 hint`)
    assert.ok(error.hint.length > 10, `${name} 的 hint 太空`)
    assert.ok(!/^\s*at\s/m.test(JSON.stringify(error)), `${name} 泄漏了堆栈`)
    return error
  }
  return { engine, ctx, call, ok, fails, handle }
}

// ---------------------------------------------------------------- TERRAIN ----

test('terrain_apply refuses while the preview runs and never reaches the engine write', async (t) => {
  const { ok, fails, engine } = await harness(t, { previewRunning: true })
  const info = await ok('terrain_info', { mapId: MAP })
  assert.equal(info.previewRunning, true)
  assert.match(info.next, /map_preview/)
  const error = await fails(
    'terrain_apply',
    { mapId: MAP, region: { min: [0, 0, 0], max: [1, 1, 1] }, block: 5, expectedRevision: info.revision },
    'PREVIEW_RUNNING',
  )
  assert.equal(error.retryable, true)
  assert.match(error.hint, /map_preview/)
  assert.match(error.hint, /1602/)
  assert.ok(!engine.authoring.state.calls.includes('terrainApply'), '拒绝必须发生在 terrainApply 之前，不是静默成功')
})

test('terrain_apply dry-run then write then terrain_revert round-trips the undo token', async (t) => {
  const { ok } = await harness(t)
  const info = await ok('terrain_info', { mapId: MAP })
  const region = { min: [0, 0, 0], max: [1, 1, 1] }
  const plan = await ok('terrain_apply', { mapId: MAP, region, block: 5, rotation: 1, expectedRevision: info.revision, dryRun: true })
  assert.equal(plan.dryRun, true)
  assert.equal(plan.changed, 8)
  assert.equal(plan.requestedCells, 8)
  assert.match(plan.revertHint, /dryRun/)

  const written = await ok('terrain_apply', { mapId: MAP, region, block: 5, rotation: 1, expectedRevision: info.revision })
  // Packed uint16: type id in the low 14 bits, rotation in the top 2
  // (VOXEL_TYPE_MASK / VOXEL_ROTATION_SHIFT, voxel-protocol.ts:14-15).
  assert.equal(written.block, (1 << 14) | 5)
  assert.notEqual(written.newRevision, info.revision)
  assert.match(written.persistHint, /map_save/)
  assert.ok(written.undoTokenBytes > 0)

  const after = await ok('terrain_read', { mapId: MAP, region })
  assert.deepEqual(after.cells.map((cell) => cell.b), Array(8).fill((1 << 14) | 5))

  const reverted = await ok('terrain_revert', { mapId: MAP, undoToken: written.undoToken })
  assert.equal(reverted.restored, 8)
  assert.equal(reverted.restoredRatio, '8/8')
  const back = await ok('terrain_read', { mapId: MAP, region })
  assert.deepEqual(back.cells.map((cell) => cell.b), Array(8).fill(0))
})

test('terrain_apply rejects a stale revision, an empty region and an over-budget region', async (t) => {
  const { ok, fails, engine } = await harness(t)
  const info = await ok('terrain_info', { mapId: MAP })
  const stale = await fails(
    'terrain_apply',
    { mapId: MAP, region: { min: [0, 0, 0], max: [0, 0, 0] }, block: 1, expectedRevision: 'terrain:0000000000000000' },
    'REVISION_CONFLICT',
  )
  assert.equal(stale.detail.current, info.revision)
  assert.match(stale.detail.revisionAuthority, /map-authoring-tools\.ts/)
  assert.ok(!engine.authoring.state.calls.includes('terrainApply'))

  await fails(
    'terrain_apply',
    { mapId: MAP, region: { min: [9, 9, 9], max: [10, 10, 10] }, block: 1, expectedRevision: info.revision },
    'TERRAIN_REGION_EMPTY',
  )
})

test('the terrain budget stops a 1e6-cell region locally, well under the engine limit', async (t) => {
  const { ok, fails, engine } = await harness(t, { shape: [100, 100, 100] })
  const info = await ok('terrain_info', { mapId: MAP })
  const error = await fails(
    'terrain_apply',
    { mapId: MAP, region: { min: [0, 0, 0], max: [99, 99, 99] }, block: 1, expectedRevision: info.revision },
    'TERRAIN_BUDGET_EXCEEDED',
  )
  assert.equal(error.detail.cells, 1_000_000)
  assert.equal(error.detail.engineLimit, 500_000)
  assert.match(error.hint, /拆成/)
  assert.ok(!engine.authoring.state.calls.includes('terrainApply'), '预算门必须先于引擎写')
})

test('terrain_revert refuses an undo token it cannot parse instead of guessing', async (t) => {
  const { fails } = await harness(t)
  const error = await fails('terrain_revert', { mapId: MAP, undoToken: 'not json at all' }, 'UNDO_TOKEN_UNPARSEABLE')
  assert.match(error.hint, /terrain_apply/)
  await fails('terrain_revert', { mapId: MAP, undoToken: '{"a":1}' }, 'UNDO_TOKEN_UNPARSEABLE')
})

// --------------------------------------------------------------- ENTITY ----

test('entity_create places entities, chains the revision and states the persistence rule', async (t) => {
  const { ok } = await harness(t, { models: { cube: { modelId: 7 } } })
  const listed = await ok('entity_list', { mapId: MAP })
  assert.equal(listed.total, 1)
  assert.match(listed.revision, /^entity:/)
  const created = await ok('entity_create', {
    mapId: MAP,
    entities: [{ name: 'torch', position: [1, 2, 3], mesh: 'mesh/cube.vb' }, { modelId: 7, name: 'from-model' }],
    expectedRevision: listed.revision,
  })
  assert.equal(created.created.length, 2)
  assert.deepEqual(created.created.map((row) => row.via), ['raw', 'model'])
  assert.match(created.persistHint, /map_save/)
  assert.notEqual(created.revision, listed.revision, '写完的 revision 必须前推，否则下一批会拿旧锁')
  const after = await ok('entity_list', { mapId: MAP })
  assert.equal(after.total, 3)
  assert.equal(after.revision, created.revision)
})

test('entity_create rolls back the entities it already placed when a later item fails', async (t) => {
  const { ok, fails, engine } = await harness(t, { models: { cube: { modelId: 7 } } })
  const listed = await ok('entity_list', { mapId: MAP })
  engine.authoring.state.calls.length = 0
  const error = await fails(
    'entity_create',
    { mapId: MAP, entities: [{ name: 'ok-one' }, { modelId: 999, name: 'missing-model' }], expectedRevision: listed.revision },
    'ENTITY_CREATE_FAILED',
  )
  assert.equal(error.detail.rollback.rolledBack, true)
  assert.equal(error.detail.rollback.removedIds.length, 1)
  assert.equal(error.detail.failures[0].error.code, 'ENGINE_REFUSED')
  assert.ok(engine.authoring.state.calls.includes('deleteEntity'), '回滚必须真的调用 deleteEntity')
  const after = await ok('entity_list', { mapId: MAP })
  assert.equal(after.total, 1, '半成品不能留在图里')
})

test('entity_create refuses an unhedged write, an empty batch and an over-budget batch', async (t) => {
  const { ok, fails, engine } = await harness(t)
  const listed = await ok('entity_list', { mapId: MAP })
  const missing = await fails('entity_create', { mapId: MAP, entities: [{ name: 'x' }], expectedRevision: 'entity:nonsense' }, 'REVISION_CONFLICT')
  assert.match(missing.hint, /entity_list/)
  const unhedged = await ok('entity_create', { mapId: MAP, entities: [{ name: 'no-lock' }], expectedRevision: listed.revision, allowUnhedged: true })
  assert.equal(unhedged.created.length, 1)
  // `additionalProperties`/required are enforced by validateArgs; the batch
  // gates below are the domain's own and have to answer in the same shape.
  await fails('entity_create', { mapId: MAP, entities: [], expectedRevision: listed.revision }, 'ENTITY_BATCH_EMPTY')
  const tooMany = await fails(
    'entity_create',
    { mapId: MAP, entities: Array.from({ length: 201 }, (_, i) => ({ name: `e${i}` })), expectedRevision: listed.revision },
    'ENTITY_BUDGET_EXCEEDED',
  )
  assert.match(tooMany.hint, /projectTransaction/)
  assert.deepEqual(tooMany.detail.limit, 200)
  engine.authoring.state.calls.length = 0
})

test('entity_delete plans before it destroys and refuses ids the snapshot does not show', async (t) => {
  const { ok, fails, engine } = await harness(t)
  const listed = await ok('entity_list', { mapId: MAP })
  const plan = await ok('entity_delete', { mapId: MAP, entityIds: ['1'], expectedRevision: listed.revision })
  assert.equal(plan.dryRun, true)
  assert.equal(plan.wouldDelete[0], '1')
  assert.ok(!engine.authoring.state.calls.includes('deleteEntity'), 'dry-run 不许真删')

  await fails('entity_delete', { mapId: MAP, entityIds: ['424242'], expectedRevision: listed.revision }, 'ENTITY_NOT_FOUND')
  const deleted = await ok('entity_delete', { mapId: MAP, entityIds: ['1'], expectedRevision: listed.revision, confirm: true })
  assert.deepEqual(deleted.survivors, [])
  const after = await ok('entity_list', { mapId: MAP })
  assert.equal(after.total, 0)
})

test('entity_update and entity_move validate the target and read the truth back', async (t) => {
  const { ok, fails } = await harness(t)
  const listed = await ok('entity_list', { mapId: MAP })
  // An empty `properties` object passes JSON-Schema but would be a silent no-op,
  // so the domain refuses it.
  const empty = await fails('entity_update', { mapId: MAP, entityId: '1', properties: {}, expectedRevision: listed.revision }, 'ENTITY_UPDATE_EMPTY')
  assert.equal(empty.retryable, false)
  await fails(
    'entity_update',
    { mapId: MAP, entityId: '999', properties: { position: [1, 1, 1] }, expectedRevision: listed.revision },
    'ENTITY_NOT_FOUND',
  )
  const moved = await ok('entity_move', { mapId: MAP, entityId: '1', position: [7, 8, 9], expectedRevision: listed.revision })
  assert.deepEqual(moved.readBack.position, [7, 8, 9])
  const updated = await ok('entity_update', {
    mapId: MAP,
    entityId: '1',
    properties: { scale: [2, 2, 2] },
    expectedRevision: moved.revision,
  })
  assert.deepEqual(updated.updatedKeys, ['scale'])
  assert.match(updated.verifyHint, /console\.warn/)
})

test('entity_copy reports the ids it can actually see, not just what the engine claims', async (t) => {
  const { ok, fails } = await harness(t)
  const listed = await ok('entity_list', { mapId: MAP })
  await fails('entity_copy', { mapId: MAP, entityIds: ['777'], expectedRevision: listed.revision }, 'ENTITY_NOT_FOUND')
  const copied = await ok('entity_copy', { mapId: MAP, entityIds: ['1'], expectedRevision: listed.revision })
  assert.deepEqual(copied.reportedNewIds, copied.detectedNewIds)
  assert.equal(copied.detectedNewIds.length, 1)
})

// ---------------------------------------------------------------- MODEL ----

test('model_list works, model_search_public reports the engine stub, model_add_to_project refuses', async (t) => {
  const { ok, fails } = await harness(t, { models: { cube: { modelId: 7 }, tree: { modelId: 9 } } })
  const models = await ok('model_list', { mapId: MAP })
  assert.deepEqual(models.models.map((row) => row.id).sort(), [7, 9])
  const filtered = await ok('model_list', { mapId: MAP, modelName: 'cu' })
  assert.equal(filtered.models.length, 1)

  const searched = await ok('model_search_public', { mapId: MAP, query: 'crate' })
  assert.equal(searched.unavailable, true, '空结果不能被当成"库里没货"')

  const planned = await ok('model_add_to_project', { mapId: MAP, modelIds: [7] })
  assert.equal(planned.dryRun, true)
  assert.equal(planned.engineSupport, 'none')
  const error = await fails('model_add_to_project', { mapId: MAP, modelIds: [7], confirm: true }, 'ENGINE_TOOL_NOT_IMPLEMENTED')
  assert.equal(error.retryable, false)
  assert.match(error.hint, /execute/)
})

// ------------------------------------------------------------------- UI ----

test('ui_node_add chains revisions across a batch and ui_tree_read reflects the tree', async (t) => {
  const { ok } = await harness(t)
  const tree = await ok('ui_tree_read', { mapId: MAP })
  const added = await ok('ui_node_add', {
    mapId: MAP,
    nodes: [
      { name: 'HUD', nodeType: 'screen', data: { zIndex: 1, enable: true, layout: { type: 'auto', data: {} } } },
      { name: 'title', nodeType: 'element', data: { text: { content: '标题' } } },
    ],
    expectedRevision: tree.revision,
  })
  assert.equal(added.created.length, 2)
  const read = await ok('ui_tree_read', { mapId: MAP })
  assert.equal(read.totalNodes, 2)
  assert.equal(read.revisionAuthority.includes('map-authoring-tools.ts'), true)
  assert.equal(read.revision, added.revision)
})

test('ui_node_add refuses malformed payloads locally and stale revisions at the engine', async (t) => {
  const { ok, fails } = await harness(t)
  const tree = await ok('ui_tree_read', { mapId: MAP })
  await fails(
    'ui_node_add',
    { mapId: MAP, nodes: [{ name: 'x', nodeType: 'widget', data: { text: {} } }], expectedRevision: tree.revision },
    'UI_NODE_TYPE_INVALID',
  )
  await fails(
    'ui_node_add',
    { mapId: MAP, nodes: [{ name: 'x', nodeType: 'element', data: { banana: {} } }], expectedRevision: tree.revision },
    'UI_NODE_DATA_INVALID',
  )
  // The engine DOES hold this lock (uiNodeAdd takes expectedRevision), and it
  // answers 409 with the refusal nested under `result` — the translation must
  // dig it out instead of reporting an opaque HTTP_409.
  const stale = await fails(
    'ui_node_add',
    { mapId: MAP, nodes: [{ name: 'x', nodeType: 'element', data: { text: { content: 'hi' } } }], expectedRevision: 'ui:stale' },
    'REVISION_CONFLICT',
  )
  // PROOF the nested 409 body is decoded: the code came from the ENGINE (this
  // domain does no local pre-check for ui_node_add), the HTTP status is kept,
  // and the engine's own `currentRevision` is flattened into detail.
  assert.equal(stale.status, 409)
  assert.equal(stale.detail.upstream.code, 'REVISION_CONFLICT')
  assert.equal(typeof stale.detail.currentRevision, 'string')
  assert.match(stale.detail.upstreamMessage, /UI tree changed/)
  assert.match(stale.hint, /ui_tree_read/)
})

test('ui_node_remove shows the plan and the orphan risk, then deletes only on confirm', async (t) => {
  const { ok, fails } = await harness(t, {
    uiNodes: [
      { id: '10', name: 'HUD', type: 'screen', parentId: 'DEFAULT_SCREEN_ID', childrenIds: ['11'] },
      { id: '11', name: 'title', type: 'element', parentId: '10', childrenIds: [] },
    ],
  })
  const tree = await ok('ui_tree_read', { mapId: MAP })
  const plan = await ok('ui_node_remove', { mapId: MAP, nodeIds: ['10'], expectedRevision: tree.revision })
  assert.equal(plan.dryRun, true)
  assert.equal(plan.orphanRisk[0].id, '11', '删父留子必须被提前看见')

  await fails('ui_node_remove', { mapId: MAP, nodeIds: ['999'], expectedRevision: tree.revision }, 'UI_NODE_NOT_FOUND')
  const both = await ok('ui_node_remove', { mapId: MAP, nodeIds: ['10', '11'], expectedRevision: tree.revision, confirm: true })
  assert.deepEqual(both.removed, ['10', '11'])
  const after = await ok('ui_tree_read', { mapId: MAP })
  assert.equal(after.totalNodes, 0)
})

// ------------------------------------------------------ SCRIPT (not mounted) ----

test('the script runtime domain reports the engine router gap instead of pretending to work', async (t) => {
  const { ok, fails } = await harness(t)
  const error = await fails('script_list_runtime', { mapId: MAP }, 'ENGINE_TOOL_NOT_MOUNTED')
  assert.equal(error.retryable, false)
  assert.match(error.hint, /script_write/)
  assert.equal(error.detail.available.length, 17, 'headless 路由只挂 17 个（无 createScriptTools）')

  await fails('script_read_runtime', { mapId: MAP, fileId: 'f1' }, 'ENGINE_TOOL_NOT_MOUNTED')
  await fails(
    'script_create',
    { mapId: MAP, name: 'quest.js', content: 'module.exports = { v: 1 }\n', expectedRevision: 'scriptFiles:x' },
    'ENGINE_TOOL_NOT_MOUNTED',
  )
  await fails(
    'script_patch',
    {
      mapId: MAP,
      fileId: 'f1',
      operations: [{ type: 'insert', index: 0, text: 'x' }],
      expectedRevision: 'scriptFiles:x',
      expectedContentHash: 'sha256:x',
    },
    'ENGINE_TOOL_NOT_MOUNTED',
  )
  await fails('script_delete', { mapId: MAP, fileId: 'f1', expectedRevision: 'scriptFiles:x' }, 'ENGINE_TOOL_NOT_MOUNTED')
  const catalog = await ok('map_tool_catalog', { mapId: MAP })
  assert.deepEqual(catalog.missing.map((row) => row.engineTool).sort(), ['createScript', 'deleteScript', 'listScripts', 'readScript', 'updateScript'])
})

test('the script domain still runs its local gates before it discovers the router gap', async (t) => {
  const { fails, engine } = await harness(t)
  await fails('script_create', { mapId: MAP, name: 'index.js', content: 'x', expectedRevision: 'r' }, 'SCRIPT_RESERVED_ENTRY')
  await fails(
    'script_create',
    { mapId: MAP, name: 'evil.js', content: 'const run = eval("process.exit()")\n', expectedRevision: 'r' },
    'DANGEROUS_CONTENT_BLOCKED',
  )
  await fails(
    'script_patch',
    {
      mapId: MAP,
      fileId: 'f1',
      operations: [{ type: 'update', index: 0 }],
      expectedRevision: 'r',
      expectedContentHash: 'h',
    },
    'SCRIPT_OP_TYPE_INVALID',
  )
  assert.deepEqual(engine.authoring.state.calls, [], '本地门必须在任何引擎往返之前')
})

// ------------------------------------------------------------- MAP-OPS ----

test('map_status tells the agent whether writing and persisting are currently possible', async (t) => {
  const { ok } = await harness(t, { previewRunning: true })
  const status = await ok('map_status', { mapId: MAP })
  assert.equal(status.runtimeActive, true)
  assert.equal(status.previewRunning, true)
  assert.equal(status.canWrite, true)
  assert.equal(status.canPersistTerrain, false, '预览在跑就不能落盘地形：这条必须说得出来')
  assert.equal(status.writeRouteSelfReport, 'unavailable')
  assert.equal(status.writeRouteSelfReportIsStale, true, 'status.ts 的旧文案不能反过来当能力缺失')
  assert.match(status.next, /map_preview/)
  assert.match(status.next, /1602/)
})

test('map_preview start/stop drives the ordering gate and map_save refuses while running', async (t) => {
  const { ok, fails, engine } = await harness(t)
  const started = await ok('map_preview', { mapId: MAP, action: 'start' })
  assert.equal(started.running, true)
  const blocked = await fails('map_save', { mapId: MAP }, 'PREVIEW_RUNNING')
  assert.match(blocked.hint, /1602|stop/)
  assert.equal(engine.authoring.state.saved, 0, '预览在跑时不能静默落盘')

  await fails('map_preview', { mapId: MAP, action: 'restart' }, 'INVALID_ARGS')
  const forced = await ok('map_save', { mapId: MAP, force: true })
  assert.equal(forced.forced, true)
  assert.equal(forced.permissionHash, engine.authoring.state.permissionHash)

  const stopped = await ok('map_preview', { mapId: MAP, action: 'stop' })
  assert.equal(stopped.running, false)
  const saved = await ok('map_save', { mapId: MAP })
  assert.equal(saved.httpStatus, 200)
  assert.ok(saved.diskHeadHash, '保存后要把盘上 headHash 读回来复核版本链')
  assert.equal(engine.authoring.state.saved, 2)
})

test('a project without an edit runtime refuses with RUNTIME_NOT_ACTIVE, not a silent no-op', async (t) => {
  const { fails } = await harness(t, { runtimeActive: false })
  const error = await fails('terrain_info', { mapId: MAP }, 'RUNTIME_NOT_ACTIVE')
  assert.match(error.hint, /map_status/)
  await fails('entity_list', { mapId: MAP }, 'RUNTIME_NOT_ACTIVE')
  await fails('ui_tree_read', { mapId: MAP }, 'RUNTIME_NOT_ACTIVE')
  await fails('map_save', { mapId: MAP }, 'RUNTIME_NOT_ACTIVE')
})

test('an un-deployed internal route is reported as a deployment gap, not as bad arguments', async (t) => {
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'box3-mcp-missing-'))
  t.after(() => fs.rmSync(projectsRoot, { recursive: true, force: true }))
  seedProject(projectsRoot, { directory: MAP, permanentMapId: 'cccccccccccccccccccc', name: '缺路由', localScripts: {}, sharedScripts: [] })
  const engine = await startMockEngine({ projectsRoot, events: [] })
  t.after(() => engine.close())
  const ctx = buildContext({
    BOX_CREATOR_BASE_URL: engine.baseUrl,
    BOX_CREATOR_CLI_TOKEN: engine.token,
    BOX_MAP_PROJECTS_ROOT: projectsRoot,
    BOX_MCP_TYPEGATE: 'syntax',
  })
  // Point the internal surface at a path the double does not implement: this is
  // what a Creator build without `map-authoring` looks like from the MCP.
  ctx.request = (spec) => {
    if (spec.path.startsWith('/api/internal/')) {
      return Promise.reject(
        Object.assign(new Error('404 page'), { name: 'EngineError', code: 'HTTP_404', status: 404, detail: { raw: '<!doctype html><html><body>404</body></html>' } }),
      )
    }
    return buildContext({ BOX_CREATOR_BASE_URL: engine.baseUrl }).request(spec)
  }
  const handle = createHandler(ctx)
  const response = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'terrain_info', arguments: { mapId: MAP } } })
  const error = response.result.structuredContent.error
  assert.equal(error.code, 'INTERNAL_ROUTE_NOT_DEPLOYED')
  assert.equal(error.retryable, false)
  assert.match(error.hint, /map-authoring/)
})
