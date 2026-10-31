import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildContext } from '../src/index.js'
import { createHandler, validateArgs } from '../src/server.js'
import { seedProject, startMockEngine } from '../mock/engine.js'

const requiredReadTools = [
  'engine_health',
  'map_list',
  'map_resources',
  'script_list',
  'script_read',
  'runtime_status',
  'runtime_events_tail',
  'data_read',
]

async function harness(t, options = {}) {
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'box3-mcp-rpc-'))
  t.after(() => fs.rmSync(projectsRoot, { recursive: true, force: true }))
  seedProject(projectsRoot, {
    directory: 'rpc-map',
    permanentMapId: 'bbbbbbbbbbbbbbbbbbbb',
    name: 'RPC 图',
    blobNameForm: options.blobNameForm || 'cidv0',
    localScripts: { 'index.js': 'server' },
    sharedScripts: [{ entry: 'lib.js', side: 'server', content: 'module.exports = 1\n' }],
  })
  const engine = await startMockEngine({
    projectsRoot,
    events: [
      { type: 'log', side: 'server', level: 3, message: 'boot' },
      { type: 'log', side: 'server', level: 3, message: 'hi' },
    ],
  })
  t.after(() => engine.close())
  const ctx = buildContext({
    ...process.env,
    BOX_CREATOR_BASE_URL: engine.baseUrl,
    BOX_CREATOR_CLI_TOKEN: engine.token,
    BOX_MAP_PROJECTS_ROOT: projectsRoot,
    BOX_MCP_TYPEGATE: 'syntax',
    BOX_ENGINE_REPO_ROOT: path.resolve(import.meta.dirname, '..', '..', '..'),
  })
  return { handle: createHandler(ctx), ctx }
}

test('initialize negotiates a known protocol version', async (t) => {
  const { handle } = await harness(t)
  const response = await handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
  })
  assert.equal(response.result.protocolVersion, '2025-06-18')
  assert.ok(response.result.capabilities.tools)
  assert.equal(response.result.serverInfo.name, 'box3-map-mcp')
  assert.match(response.result.instructions, /expectedRevision/)
})

test('unknown protocol version falls back to a supported one', async (t) => {
  const { handle } = await harness(t)
  const response = await handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })
  assert.equal(response.result.protocolVersion, '2025-06-18')
})

test('tools/list advertises the eight read tools plus the merged write face', async (t) => {
  const { handle } = await harness(t)
  const response = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
  const names = response.result.tools.map((tool) => tool.name)
  for (const name of requiredReadTools) assert.ok(names.includes(name), `缺少只读工具 ${name}`)
  assert.ok(names.includes('script_write'))
  // CLOSED SET, now over the merged face (P0-A): the slice-A base face plus the
  // six write domains. Nothing may show up that is not declared here — this is
  // the assertion that used to encode "the single writer is script_write".
  const declared = [
    ...requiredReadTools,
    'script_write', 'script_typecheck', 'contract_describe', 'map_revision',
    'terrain_info', 'terrain_blocks', 'terrain_read', 'terrain_apply', 'terrain_revert',
    'entity_list', 'entity_create', 'entity_update', 'entity_move', 'entity_delete', 'entity_copy',
    'model_list', 'model_search_public', 'model_add_to_project',
    'ui_tree_read', 'ui_node_add', 'ui_node_remove',
    'script_list_runtime', 'script_read_runtime', 'script_create', 'script_patch', 'script_delete',
    'map_status', 'map_tool_catalog', 'map_preview', 'map_save',
  ]
  assert.deepEqual([...new Set(names)].sort(), [...declared].sort())
  for (const tool of response.result.tools) {
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} 的 inputSchema 必须是 object`)
    assert.ok(tool.description.length > 20)
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean')
  }
  const writer = response.result.tools.find((tool) => tool.name === 'script_write')
  assert.equal(writer.annotations.readOnlyHint, false)
  assert.equal(writer.annotations.destructiveHint, true)
  assert.equal(writer.annotations.idempotentHint, true)
})

test('tools/call round trips a read tool through the mock engine', async (t) => {
  const { handle } = await harness(t)
  const health = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'engine_health', arguments: {} } })
  assert.equal(health.result.isError, false)
  assert.equal(health.result.structuredContent.apiVersion, 'v1')
  assert.match(health.result.content[0].text, /apiVersion/)

  const listed = await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'map_list', arguments: {} } })
  assert.equal(listed.result.structuredContent.projects[0].permanentMapId, 'bbbbbbbbbbbbbbbbbbbb')

  const scripts = await handle({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'script_list', arguments: { mapId: 'bbbbbbbbbbbbbbbbbbbb' } },
  })
  assert.equal(scripts.result.structuredContent.sharedScripts[0].entry, 'lib.js')
  assert.equal(scripts.result.structuredContent.mapLocalScripts[0].entry, 'index.js')
})

test('map-local script_read falls back to the disk chain automatically', async (t) => {
  const { handle } = await harness(t)
  const read = await handle({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'script_read', arguments: { mapId: 'rpc-map', side: 'server', entry: 'index.js' } },
  })
  assert.equal(read.result.isError, false)
  assert.equal(read.result.structuredContent.readBackSource, 'local-disk')
  assert.equal(read.result.structuredContent.shared, false)
})

/**
 * REAL DATA: on an imported map the shared-script hash the HTTP surface hands
 * back is a 43-character URL-safe SHA-256 name. `hashMatchesContent` used to be
 * computed with the CIDv0 algorithm only, so it reported a perfectly intact
 * script as a mismatch — a false alarm on every cloud-imported map. It is now
 * `verifyBlobName`, which re-derives whichever content-addressed form the name
 * claims to be and reports `undefined` (plus a reason) for a form that cannot
 * be re-derived at all.
 */
test('script_read verifies URL-safe blob names instead of calling them mismatches', async (t) => {
  const { handle } = await harness(t, { blobNameForm: 'sha256-url' })
  const shared = await handle({
    jsonrpc: '2.0',
    id: 70,
    method: 'tools/call',
    params: { name: 'script_read', arguments: { mapId: 'rpc-map', side: 'server', entry: 'lib.js', source: 'http' } },
  })
  assert.equal(shared.result.isError, false)
  const payload = shared.result.structuredContent
  assert.equal(payload.readBackSource, 'http-shared')
  assert.equal(payload.hash.length, 43)
  assert.equal(payload.nameForm.form, 'sha256-url')
  assert.equal(payload.nameForm.verifiable, true)
  assert.equal(payload.hashMatchesContent, true)
  assert.equal(payload.hashUnverifiableReason, undefined)
  assert.equal(payload.content, 'module.exports = 1\n')

  const listed = await handle({
    jsonrpc: '2.0',
    id: 71,
    method: 'tools/call',
    params: { name: 'script_list', arguments: { mapId: 'rpc-map' } },
  })
  assert.equal(listed.result.isError, false)
  const mapLocal = listed.result.structuredContent.mapLocalScripts
  assert.equal(mapLocal.length, 1)
  assert.deepEqual(
    { entry: mapLocal[0].entry, side: mapLocal[0].side, type: mapLocal[0].type, shared: mapLocal[0].shared },
    { entry: 'index.js', side: 'server', type: 1, shared: false },
  )
  assert.equal(mapLocal[0].hash.length, 43)

  const local = await handle({
    jsonrpc: '2.0',
    id: 72,
    method: 'tools/call',
    params: { name: 'script_read', arguments: { mapId: 'rpc-map', side: 'server', entry: 'index.js' } },
  })
  assert.equal(local.result.structuredContent.readBackSource, 'local-disk')
  assert.equal(local.result.structuredContent.nameForm.form, 'sha256-url')
  assert.equal(local.result.structuredContent.contentVerified, true)
})

test('runtime_events_tail parses SSE frames and judges them', async (t) => {
  const { handle } = await harness(t)
  const events = await handle({
    jsonrpc: '2.0',
    id: 8,
    method: 'tools/call',
    params: { name: 'runtime_events_tail', arguments: { mapId: 'rpc-map', sinceEventId: 1, idleMs: 300, timeoutMs: 3000 } },
  })
  const payload = events.result.structuredContent
  assert.equal(payload.events[0].type, 'log')
  assert.equal(typeof payload.events[0].id, 'number')
  assert.equal(payload.verdict.verdict, 'PASS')

  // No Last-Event-ID => the engine only sends the initial status frame. That
  // must never be reported as a passing acceptance window.
  const bare = await handle({
    jsonrpc: '2.0',
    id: 80,
    method: 'tools/call',
    params: { name: 'runtime_events_tail', arguments: { mapId: 'rpc-map', idleMs: 300, timeoutMs: 3000 } },
  })
  assert.equal(bare.result.structuredContent.verdict.verdict, 'NO_EVENTS')
  assert.equal(bare.result.structuredContent.verdict.passed, false)
})

test('engine errors are reported in band, not as protocol errors', async (t) => {
  const { handle, ctx } = await harness(t)
  ctx.config.cliToken = 'bxc_wrong'
  const failed = await handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'map_list', arguments: {} } })
  assert.equal(failed.result.isError, true)
  assert.equal(failed.result.structuredContent.error.code, 'AUTH_REQUIRED')
  assert.equal(failed.id, 9)
  assert.equal(failed.error, undefined)
})

test('missing token is caught locally before any socket opens', async (t) => {
  const { handle, ctx } = await harness(t)
  ctx.config.cliToken = ''
  const failed = await handle({
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: { name: 'script_list', arguments: { mapId: 'rpc-map' } },
  })
  assert.equal(failed.result.structuredContent.error.code, 'CLI_TOKEN_MISSING')
})

test('argument validation rejects undeclared and missing keys', async (t) => {
  const { handle } = await harness(t)
  const bad = await handle({
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: { name: 'map_resources', arguments: { mapId2: 'x' } },
  })
  assert.equal(bad.result.structuredContent.error.code, 'INVALID_ARGS')
  assert.deepEqual(
    bad.result.structuredContent.error.problems.map((problem) => problem.path).sort(),
    ['mapId', 'mapId2'],
  )
})

test('protocol-level errors keep JSON-RPC semantics', async (t) => {
  const { handle } = await harness(t)
  const unknown = await handle({ jsonrpc: '2.0', id: 12, method: 'resources/list' })
  assert.equal(unknown.error.code, -32601)
  const invalid = await handle({ id: 13, method: 'ping' })
  assert.equal(invalid.error.code, -32600)
  const notification = await handle({ jsonrpc: '2.0', method: 'notifications/initialized' })
  assert.equal(notification, undefined)
  assert.equal(validateArgs({ type: 'object', properties: {} }, ['x']).length, 1)
})
