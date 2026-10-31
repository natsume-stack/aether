/**
 * P0-A WIRING TESTS: the domain modules must be reachable from the protocol,
 * with no shadowed registrations, and the whole face must obey one error shape.
 *
 * These are deliberately about the WIRING (counts, names, collisions, profile
 * filtering, contract shape) — the guardrail behaviour of each writer is in
 * test/domain-guardrails.test.js.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildContext } from '../src/index.js'
import { buildTools, buildBaseTools } from '../src/tools.js'
import { createHandler } from '../src/server.js'
import { ENGINE_AI_TOOLS, ENGINE_TOOLS_USED, ENGINE_TOOL_FOR_MCP_TOOL, WRITE_TOOL_NAMES } from '../src/tools/_shared.js'
import { mergeToolSets, isWriteTool } from '../src/tools/index.js'
import { CONTRACT_CODES, errorPayload } from '../src/errors.js'
import { seedProject, startMockEngine } from '../mock/engine.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

/** Legacy 26-tool surface. New authoring/review factories have separate coverage;
 * this table does not claim to enumerate every runtime tool.
 */
const ENGINE_SOURCE_FILES = {
  'services/game-server/src/edit/ai/entity-tools.ts': [
    'listScripts', 'readScript', 'updateScript', 'createScript', 'deleteScript',
    'createEntity', 'deleteEntity', 'updateEntity', 'listEntities', 'moveEntity',
    'copyEntities', 'getProjectModels', 'searchPublicModels', 'addModelToProject', 'createEntityFromModel',
  ],
  'services/game-server/src/edit/ai/map-authoring-tools.ts': [
    'terrainInfo', 'terrainRead', 'terrainApply', 'terrainRevert',
    'blockCatalog', 'getBlock', 'resolvePalette', 'searchBlocks',
    'uiTreeRead', 'uiNodeAdd', 'uiNodeRemove',
  ],
}

function names(ctx) {
  return buildTools(ctx).map((tool) => tool.name)
}

function authoringCtx(overrides = {}) {
  return buildContext({
    BOX_MCP_PROFILE: 'authoring',
    BOX_MCP_ALLOW_WRITE: '1',
    BOX_MCP_TYPEGATE: 'syntax',
    BOX_ENGINE_REPO_ROOT: REPO_ROOT,
    ...overrides,
  })
}

async function engineHarness(t, options = {}) {
  const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'box3-mcp-wiring-'))
  t.after(() => fs.rmSync(projectsRoot, { recursive: true, force: true }))
  seedProject(projectsRoot, {
    directory: 'wire-map',
    permanentMapId: 'cccccccccccccccccccc',
    name: '接线图',
    localScripts: { 'index.js': 'server' },
    sharedScripts: [{ entry: 'lib.js', side: 'server', content: 'module.exports = 1\n' }],
  })
  const engine = await startMockEngine({ projectsRoot, events: [], authoring: options.authoring || {} })
  t.after(() => engine.close())
  const ctx = buildContext({
    BOX_CREATOR_BASE_URL: engine.baseUrl,
    BOX_CREATOR_CLI_TOKEN: engine.token,
    BOX_MAP_PROJECTS_ROOT: projectsRoot,
    BOX_MCP_TYPEGATE: 'syntax',
    BOX_ENGINE_REPO_ROOT: REPO_ROOT,
    ...(options.env || {}),
  })
  return { engine, ctx, handle: createHandler(ctx) }
}

test('the merged face is 12 base tools + 26 domain tools = 38, with no duplicates', () => {
  const ctx = authoringCtx()
  const all = buildTools(ctx)
  const base = buildBaseTools(ctx)
  assert.equal(base.length, 12, '切片 A 的 12 个工具一个都不能少')
  assert.equal(all.length, 38)
  assert.equal(new Set(all.map((tool) => tool.name)).size, all.length)
  assert.deepEqual(
    Object.keys(ENGINE_TOOL_FOR_MCP_TOOL).filter((name) => !all.some((tool) => tool.name === name)),
    [],
    '每个引擎域工具都必须真的被 advertise',
  )
})

test('every legacy engine AI tool is reachable through a named MCP tool (26/26)', () => {
  const ctx = authoringCtx()
  const advertised = new Set(names(ctx))
  assert.equal(ENGINE_AI_TOOLS.length, 26)
  const missing = ENGINE_AI_TOOLS.filter((row) => !advertised.has(row.mcpTool)).map((row) => `${row.engineTool}->${row.mcpTool}`)
  assert.deepEqual(missing, [])
  // The catalog tool's own dependency table has to name all 26 as well,
  // otherwise map_tool_catalog would report a false "all mounted".
  assert.equal(new Set(Object.values(ENGINE_TOOLS_USED)).size, 26)
})

/**
 * The coverage claim is pinned against the ENGINE SOURCE, not against this
 * repository's documents: the two factory files are parsed for `X: tool({`, and
 * the result must equal the table the MCP advertises against.
 */
test('the legacy 26-tool table matches its engine factory declarations', () => {
  const fromSource = []
  for (const [relative, expected] of Object.entries(ENGINE_SOURCE_FILES)) {
    const file = path.join(REPO_ROOT, relative)
    if (!fs.existsSync(file)) {
      assert.fail(`找不到引擎工具源文件 ${relative}：无法验证 26 工具覆盖面（需要完整仓库树或 BOX_ENGINE_REPO_ROOT）`)
    }
    const text = fs.readFileSync(file, 'utf8')
    const declared = [...text.matchAll(/^\s{4}([A-Za-z]+): tool\(\{/gm)].map((match) => match[1])
    // New coordinated authoring readers are tested by actual runtime factory
    // integration. This table advertises the unchanged legacy MCP coverage only.
    const coordinatedReaders = relative.endsWith('/entity-tools.ts') ? ['entityContext']
      : relative.endsWith('/map-authoring-tools.ts') ? ['uiContext'] : []
    assert.deepEqual(declared.filter(name => coordinatedReaders.includes(name)), coordinatedReaders)
    const found = declared.filter(name => !coordinatedReaders.includes(name))
    assert.deepEqual(found, expected, `${relative} 里的 tool() 名单与测试内转录不一致（引擎加了/改名了工具）`)
    fromSource.push(...found)
  }
  assert.equal(fromSource.length, 26)
  assert.deepEqual(
    [...new Set(fromSource)].sort(),
    ENGINE_AI_TOOLS.map((row) => row.engineTool).sort(),
    'ENGINE_AI_TOOLS 必须与引擎源码里的工具名单逐一对齐',
  )
})

test('a duplicate registration is refused at build time instead of shadowing a tool', () => {
  const handler = async () => ({})
  assert.throws(
    () => mergeToolSets([[{ name: 'map_list', handler }, { name: 'map_list', handler }]]),
    /重名注册.*map_list/,
  )
  // Cross-layer collision (a domain module reusing a slice-A name) must also throw.
  assert.throws(
    () => mergeToolSets([buildBaseTools(authoringCtx()), [{ name: 'script_write', handler }]]),
    /重名注册.*script_write/,
  )
  assert.throws(() => mergeToolSets([[{ name: 'broken' }]]), /工具声明不完整/)
})

test('the read-only profile drops exactly the writers and keeps every reader', () => {
  const writers = buildTools(authoringCtx()).filter((tool) => isWriteTool(tool.name)).map((tool) => tool.name)
  assert.equal(writers.length, 16, '15 个域写工具 + script_write')
  assert.deepEqual(writers.filter((name) => name !== 'script_write').sort(), [...WRITE_TOOL_NAMES].sort())
  const readonly = buildTools(authoringCtx({ BOX_MCP_PROFILE: 'readonly' }))
  assert.equal(readonly.length, 22)
  for (const name of writers) assert.ok(!readonly.some((tool) => tool.name === name), `${name} 不该出现在只读面`)
  for (const tool of readonly) assert.equal(tool.annotations.readOnlyHint, true, `${tool.name} 是写工具却进了只读面`)
  assert.deepEqual(
    buildTools(authoringCtx({ BOX_MCP_ALLOW_WRITE: '0' })).map((tool) => tool.name),
    readonly.map((tool) => tool.name),
    'readonly profile 与 ALLOW_WRITE=0 必须是同一副面孔',
  )
})

test('a writer gated off by the profile still answers with the structured WRITE_DISABLED contract', async (t) => {
  const { handle } = await engineHarness(t, { env: { BOX_MCP_PROFILE: 'readonly' } })
  const response = await handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'terrain_apply', arguments: { mapId: 'wire-map', region: { min: [0, 0, 0], max: [1, 1, 1] }, block: 1, expectedRevision: 'x' } },
  })
  const error = response.result.structuredContent.error
  assert.equal(response.result.isError, true)
  assert.equal(error.code, 'WRITE_DISABLED')
  assert.equal(error.retryable, false)
  assert.equal(typeof error.hint, 'string')
  assert.match(error.hint, /BOX_MCP_PROFILE/)
  // An unknown tool name stays a protocol-level error (nothing of ours is "disabled", it just does not exist).
  const unknown = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } })
  assert.equal(unknown.error.code, -32602)
})

test('tools/list annotates the engine tool behind each domain tool for traceability', async (t) => {
  const { handle } = await engineHarness(t)
  const response = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
  const byName = Object.fromEntries(response.result.tools.map((tool) => [tool.name, tool]))
  assert.equal(byName.terrain_apply._meta['box3-map-mcp/engine-tool'], 'terrainApply')
  assert.deepEqual(byName.entity_create._meta['box3-map-mcp/engine-tool'], ['createEntity', 'createEntityFromModel'])
  assert.equal(byName.map_save._meta['box3-map-mcp/engine-tool'], undefined)
  assert.match(byName.ui_node_add._meta['box3-map-mcp/scope'], /loopback internal/)
  for (const tool of response.result.tools) {
    assert.equal(tool.inputSchema.type, 'object')
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean')
  }
})

/**
 * THE ERROR CONTRACT, swept over the whole face: every tool that declares
 * required arguments, called with none, must come back as
 * `{code, retryable, hint, message}` — never a bare string, never a stack.
 */
test('every declared tool fails the argument check into the structured contract', async (t) => {
  const { handle, ctx } = await engineHarness(t)
  let checked = 0
  for (const tool of buildTools(ctx)) {
    const required = tool.inputSchema.required || []
    if (!required.length) continue
    checked += 1
    const response = await handle({ jsonrpc: '2.0', id: 100 + checked, method: 'tools/call', params: { name: tool.name, arguments: {} } })
    assert.equal(response.result.isError, true, `${tool.name} 空参数必须 isError`)
    const error = response.result.structuredContent.error
    assert.equal(error.code, 'INVALID_ARGS', `${tool.name} 的错误码`)
    assert.equal(typeof error.hint, 'string', `${tool.name} 缺 hint`)
    assert.ok(error.hint.length > 10, `${tool.name} 的 hint 太空`)
    assert.equal(typeof error.retryable, 'boolean', `${tool.name} 缺 retryable`)
    assert.ok(Array.isArray(error.problems) && error.problems.length, `${tool.name} 缺 problems`)
    assert.ok(!/at\s+\S+:\d+/.test(JSON.stringify(error)), `${tool.name} 泄漏了堆栈`)
  }
  assert.ok(checked >= 30, `只扫到 ${checked} 个带必填参数的工具，面不对`)
})

test('the error table itself is complete: every contracted code has hint + retryable + message', () => {
  for (const code of CONTRACT_CODES) {
    const upstream = errorPayload(Object.assign(new Error('引擎原始中文提示'), { code, name: 'EngineError' }))
    assert.equal(upstream.code, code)
    assert.equal(typeof upstream.hint, 'string')
    assert.ok(upstream.hint.length > 10, `${code} 的 hint 太空`)
    assert.equal(typeof upstream.retryable, 'boolean', `${code} 缺 retryable`)
    assert.match(upstream.message, /处置见 hint/, `${code}：上游原文必须被换掉，不能当 message 抛给模型`)
    // The same code raised locally keeps its own, more specific message.
    const local = errorPayload(Object.assign(new Error(`${code}：本层的具体说明`), { code }))
    assert.equal(local.message, `${code}：本层的具体说明`)
  }
  // An error that carries its own hint (the guard layer) is passed through untouched.
  const hinted = errorPayload({ code: 'TERRAIN_BUDGET_EXCEEDED', message: '本次要写 1000000 格', hint: '拆块', retry: false })
  assert.deepEqual(
    { code: hinted.code, retryable: hinted.retryable, hint: hinted.hint, message: hinted.message },
    { code: 'TERRAIN_BUDGET_EXCEEDED', retryable: false, hint: '拆块', message: '本次要写 1000000 格' },
  )
  // Unknown code still yields a complete triple, with an explicit "this is a gap" hint.
  const unknown = errorPayload(Object.assign(new Error('引擎没头'), { code: 'NEVER_SEEN_BEFORE', name: 'EngineError', status: 503 }))
  assert.equal(unknown.retryable, false)
  assert.equal(unknown.status, 503)
  assert.match(unknown.hint, /map_status/)
  // A thrown error with NO code at all still yields the contract, and says so.
  const bare = errorPayload(new TypeError('cannot read property'))
  assert.equal(bare.code, 'TOOL_FAILED')
  assert.equal(typeof bare.retryable, 'boolean')
  assert.match(bare.hint, /本层缺陷/)
})

test('every writer states the persistence / preview ordering it is bound by', () => {
  const ctx = authoringCtx()
  const writers = buildTools(ctx).filter((tool) => isWriteTool(tool.name))
  assert.equal(writers.length, 16)
  for (const tool of writers) {
    assert.match(
      tool.description,
      /map_save|预览|不写任何东西/,
      `${tool.name} 必须把"写完要 map_save / 预览在跑会拒"这条硬顺序写进描述，不能等 AI 自己发现`,
    )
  }
  // The two tools that carry the hard rule verbatim must cite the source line.
  const terrain = writers.find((tool) => tool.name === 'terrain_apply')
  assert.match(terrain.description, /replica-server\.ts:1602|1602/)
  const save = writers.find((tool) => tool.name === 'map_save')
  assert.match(save.description, /PREVIEW_RUNNING/)
})

test('the engine-tool table marks exactly the 5 script tools as unreachable headless', () => {
  const headless = ENGINE_AI_TOOLS.filter((row) => row.headless).map((row) => row.engineTool)
  const mounted = ENGINE_AI_TOOLS.filter((row) => !row.headless).map((row) => row.engineTool)
  assert.equal(headless.length, 21)
  assert.deepEqual(mounted.sort(), ['createScript', 'deleteScript', 'listScripts', 'readScript', 'updateScript'])
})

test('the lane E / lane C seams are left untouched and unimported', () => {
  // `src/dod.js` (lane E) and `src/ui-binding.js` (lane C) are being written in
  // parallel on this tree. Lane A must not import, stub or shadow them: the
  // hand-off is the main controller's wiring step, not ours.
  const srcDir = path.join(import.meta.dirname, '..', 'src')
  const files = [
    ...fs.readdirSync(srcDir).filter((name) => name.endsWith('.js')).map((name) => path.join(srcDir, name)),
    ...fs.readdirSync(path.join(srcDir, 'tools')).filter((name) => name.endsWith('.js')).map((name) => path.join(srcDir, 'tools', name)),
  ]
  for (const file of files) {
    if (file.endsWith(path.join('src', 'dod.js')) || file.endsWith(path.join('src', 'ui-binding.js'))) continue
    const text = fs.readFileSync(file, 'utf8')
    assert.doesNotMatch(text, /from\s+['"][^'"]*\/(dod|ui-binding)\.js['"]/, `${path.basename(file)} 不该 import 泳道 E/C 的文件`)
  }
  // The seams may now exist (lanes C and E delivered them) — what lane A must
  // not do is claim them: they stay out of the tool registry until the main
  // controller wires them.
  for (const seam of ['dod.js', 'ui-binding.js']) {
    if (!fs.existsSync(path.join(srcDir, seam))) continue
    const registry = fs.readFileSync(path.join(srcDir, 'tools', 'index.js'), 'utf8')
    assert.doesNotMatch(registry, new RegExp(`\\b${seam.replace('.', '\\.')}`), `域枢纽不该提前登记 ${seam}`)
  }
})

test('initialize hands the agent the hard ordering and the writer vocabulary', async (t) => {
  const { handle } = await engineHarness(t)
  const response = await handle({ jsonrpc: '2.0', id: 4, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
  const instructions = response.result.instructions
  assert.match(instructions, /expectedRevision/)
  assert.match(instructions, /map_preview/)
  assert.match(instructions, /map_save/)
  assert.match(instructions, /replica-server\.ts:1602|硬顺序/)
  assert.match(instructions, /retryable/)
})
