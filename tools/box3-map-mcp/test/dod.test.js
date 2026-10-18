/**
 * LANE E TESTS — every DoD rule gets a positive AND at least one counterexample
 * that is ASSERTED RED (`verdict === 'FAIL'` + the specific code). No skips, no
 * "should fail" comments: the last test in this file proves the counterexample
 * set covers all 17 rules, so a rule added without a red case fails the suite.
 *
 * The base evidence below is a real all-green map report: one that passes only
 * because every group actually produced evidence.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  ADVISORY_CODES,
  CLOSE_TYPE,
  DOD_CODE_CONTRACT,
  DOD_GROUPS,
  DOD_RULES,
  PLAYBOOK,
  PLAYBOOK_UNSKIPPABLE,
  PROTECTED_PLAY_FIELDS,
  UI_REFERENCE_PATTERNS,
  auditPlaybook,
  compareSurface,
  declaredUiNames,
  dodHintFor,
  dodRetryable,
  dodRuleIndex,
  evaluateDoD,
  extractUiReferences,
  firstFailurePayload,
  summarize,
  verifyErrorContract,
} from '../src/dod.js'
import { buildContext } from '../src/index.js'
import { buildTools } from '../src/tools.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const typegateConfig = {
  repoRoot: REPO_ROOT,
  packageRoot: path.resolve(import.meta.dirname, '..'),
  typeGate: 'syntax',
  typescriptEntry: '',
}

/** The client script a finished map would carry: one live UI reference, nothing sensitive. */
const CLIENT_SCRIPT = `import { hp } from './lib.js'
const button = ui.findChildByName('hp')
button.events.pointerdown.on(() => { world.hp = 1 })
export const ready = true
`
const SERVER_SCRIPT = `const lib = require('./lib.js')
module.exports = { onTick: () => { world.Quanjujiaoyi = 1 } }
`

function baseEvidence() {
  return {
    mapId: 'dod-map',
    scripts: [
      {
        name: 'clientIndex.js',
        side: 'client',
        content: CLIENT_SCRIPT,
        check: {
          satisfied: true,
          mode: 'syntax-fallback',
          dialect: 'esm',
          dialectSource: 'side=client 默认',
          errors: [],
          warnings: [{ code: 'UNDECLARED_API_MEMBER', severity: 'warning', symbol: 'world.hp', message: 'world.hp 未在声明里' }],
        },
      },
      {
        name: 'index.js',
        side: 'server',
        content: SERVER_SCRIPT,
        check: {
          satisfied: true,
          mode: 'syntax-fallback',
          dialect: 'cjs',
          dialectSource: 'side=server 默认',
          errors: [],
          warnings: [{ code: 'UNDECLARED_API_MEMBER', severity: 'warning', symbol: 'world.Quanjujiaoyi', message: '未声明自定义属性（真实图上有 86 个）' }],
        },
      },
    ],
    uiTree: {
      revision: 'ui:1',
      nodes: [
        { id: 'ROOT_ID', name: 'Root', parentId: '', type: 'root', childrenIds: ['DEFAULT_SCREEN_ID'] },
        { id: 'DEFAULT_SCREEN_ID', name: 'screen', parentId: 'ROOT_ID', type: 'node', childrenIds: ['7'] },
        { id: '7', name: 'hp', parentId: 'DEFAULT_SCREEN_ID', type: 'leaf', childrenIds: [], value: { type: 'image' } },
      ],
    },
    entry: { gameName: 'dod-map', httpStatus: 200, notFound: false, redirected: false, playEnabled: true },
    ws: {
      connected: true,
      sessionId: 'sid-1',
      enteredWorld: true,
      aliveMs: 12000,
      closeCode: 1000,
      closeReason: '',
      wasClean: true,
      clientInitiatedClose: true,
    },
    runtimeStatus: { running: true, phase: 'ready' },
    runtimeEvents: [
      { type: 'status', phase: 'ready', running: true, at: 1, id: 10 },
      { type: 'log', side: 'client', level: 'log', message: 'ready', at: 2, id: 11 },
    ],
    sinceEventId: 9,
    terrainWritten: true,
    saves: [{ ok: true, previewRunning: false, forced: false, permissionHash: 'ph-2' }],
    writes: [
      { tool: 'terrain_apply', ok: true, before: { revision: 'terrain:1' }, readback: { headHash: 'h2' } },
      { tool: 'ui_node_add', ok: true, before: { revision: 'ui:0' }, readback: { revision: 'ui:1' } },
    ],
    revisionChain: { before: { headHash: 'h1' }, after: { headHash: 'h2' } },
    legacyReadback: [{ name: '老图-A', digestBefore: 'sha:aaa', digestAfter: 'sha:aaa' }],
    customProperties: { before: ['Quanjujiaoyi', 'legacyFlag'], after: ['Quanjujiaoyi', 'legacyFlag', 'newFlag'] },
    injection: { target: 'world', frozen: false, sealed: false, surfaceBefore: ['world', 'ui'], surfaceAfter: ['world', 'ui', 'player'] },
    toolsList: { before: ['map_list', 'map_status', 'script_read'], after: ['map_list', 'map_status', 'script_read', 'ui_tree_read', 'terrain_apply'] },
    writeTouches: [{ tool: 'ui_node_add', path: 'uiTree/nodes/7', kind: 'write' }],
  }
}

/** Rules / `ruleId/code` pairs that were ACTUALLY asserted FAIL — counted, not claimed. */
const provenRed = new Set()
const provenRedPairs = new Set()
let redCalls = 0

/** Assert a DoD run went red on ONE rule with ONE code, and say which variant it was. */
function assertRed(report, ruleId, code, label) {
  assert.equal(report.verdict, 'FAIL', `${label}：本应判 FAIL，实际 ${report.verdict}（failures=${JSON.stringify(report.failures.map((f) => f.code))}）`)
  assert.ok(report.blockingRuleIds.includes(ruleId), `${label}：规则 ${ruleId} 没进 blockingRuleIds（${report.blockingRuleIds.join(', ')}）`)
  const hit = report.failures.find((item) => item.ruleId === ruleId && item.code === code)
  assert.ok(hit, `${label}：缺失败项 ${ruleId}/${code}，实到 ${report.failures.map((f) => `${f.ruleId}/${f.code}`).join(', ')}`)
  assert.equal(typeof hit.retryable, 'boolean', `${label}：${code} 缺 retryable`)
  assert.ok(hit.hint && hit.hint.length > 10, `${label}：${code} 的 hint 太空`)
  assert.ok(!/at\s+\S+:\d+/.test(JSON.stringify(hit)), `${label}：失败项里泄漏了堆栈`)
  provenRed.add(ruleId)
  provenRedPairs.add(`${ruleId}/${code}`)
  redCalls += 1
  return hit
}

/** ------------------------------------------------------------------ 基线：全绿 ------------------------------------------------------------------ */

test('base evidence passes all 17 rules with zero blocking findings', async () => {
  const report = await evaluateDoD(baseEvidence(), {})
  assert.deepEqual(report.failures, [], JSON.stringify(report.failures, null, 2))
  assert.equal(report.passed, true)
  assert.equal(report.verdict, 'PASS')
  assert.equal(report.rulesRun, 17, '四组规则总数')
  assert.deepEqual(
    { static: report.groups.static.rules, runtime: report.groups.runtime.rules, rollback: report.groups.rollback.rules, compat: report.groups.compat.rules },
    { static: 4, runtime: 4, rollback: 4, compat: 5 },
    '每组条数必须与文档口径一致',
  )
  assert.equal(report.groups.static.failed, 0)
  assert.equal(report.groups.compat.failed, 0)
  assert.equal(report.uiDangling.length, 0)
  assert.equal(firstFailurePayload(report), undefined)
  // The undeclared members are reported, never dropped — and never blocking.
  assert.ok(report.advisories.some((item) => item.code === 'UNDECLARED_API_MEMBER'))
  for (const item of report.advisories) assert.equal(item.severity, 'warning')
})

test('a rule with no evidence at all is a fail, not a pass', async () => {
  const report = await evaluateDoD({ mapId: 'empty' }, {})
  assert.equal(report.passed, false)
  // S2 has no `requires` (it judges the gate's own configuration), so 16 of 17 rules
  // can only answer "I have nothing to judge".
  assert.equal(report.failures.length, 16, JSON.stringify(report.failures.map((f) => [f.ruleId, f.code]), null, 2))
  for (const item of report.failures) assert.equal(item.code, 'EVIDENCE_MISSING')
  assert.equal(report.groups.static.failed, 3)
  assert.equal(report.groups.compat.failed, 5)
})

/** ------------------------------------------------------------------ 静态四门 ------------------------------------------------------------------ */

test('S1 positive: a real syntax gate run over both sides passes (server CJS / client ESM)', async () => {
  const evidence = baseEvidence()
  evidence.scripts = [
    { name: 'index.js', side: 'server', content: 'module.exports = 1\n' },
    { name: 'clientIndex.js', side: 'client', content: "export const ready = 1\n" },
  ]
  const report = await evaluateDoD(evidence, { typegateConfig })
  const gate = report.gates.find((row) => row.id === 'S1-script-syntax-dialect')
  assert.equal(gate.status, 'pass', JSON.stringify(gate.findings))
})

test('S1 red: an ESM body on the server side goes red on the real syntax gate', async () => {
  const evidence = baseEvidence()
  evidence.scripts = [{ name: 'index.js', side: 'server', content: "import hp from './lib.js'\n" }]
  const report = await evaluateDoD(evidence, { typegateConfig, scriptMode: 'syntax' })
  const hit = assertRed(report, 'S1-script-syntax-dialect', 'SCRIPT_GATE_FAILED', 'S1 语法')
  assert.match(JSON.stringify(hit.detail.errors), /ESM_SYNTAX_IN_CJS_SCRIPT/, '真门给出的子码要留在 detail 里')
  provenRed.add('S1-script-syntax-dialect')
})

test('S1 red: a client script squeezed through the dialect:"cjs" escape hatch is still not done', async () => {
  const evidence = baseEvidence()
  evidence.scripts = [
    { name: 'clientIndex.js', side: 'client', content: "const lib = require('./lib.js')\nmodule.exports = lib\n", dialect: 'cjs' },
  ]
  const report = await evaluateDoD(evidence, { typegateConfig, scriptMode: 'syntax' })
  const hit = assertRed(report, 'S1-script-syntax-dialect', 'SCRIPT_DIALECT_MISMATCH', 'S1 方言逃生阀')
  assert.equal(hit.got, 'cjs')
  assert.equal(hit.expected, 'esm')
  provenRed.add('S1-script-syntax-dialect')
})

test('S1 red: unparseable body, wrong side, and no gate at all each go red', async () => {
  const broken = baseEvidence()
  broken.scripts = [{ name: 'index.js', side: 'server', check: { satisfied: false, dialect: 'cjs', mode: 'syntax-fallback', errors: [{ code: 'SYNTAX_ERROR', severity: 'error', message: 'Unexpected token' }], warnings: [] } }]
  assertRed(await evaluateDoD(broken, {}), 'S1-script-syntax-dialect', 'SCRIPT_GATE_FAILED', 'S1 语法门不过')

  const wrongSide = baseEvidence()
  wrongSide.scripts = [{ name: 'index.js', side: 'services', check: { satisfied: true, dialect: 'cjs', errors: [], warnings: [] } }]
  assertRed(await evaluateDoD(wrongSide, {}), 'S1-script-syntax-dialect', 'SCRIPT_SIDE_INVALID', 'S1 side 非法')

  const noGate = baseEvidence()
  noGate.scripts = [{ name: 'index.js', side: 'server', content: 'x\n' }]
  assertRed(await evaluateDoD(noGate, {}), 'S1-script-syntax-dialect', 'SCRIPT_GATE_UNAVAILABLE', 'S1 无门可用')
  provenRed.add('S1-script-syntax-dialect')
})

test('S2 positive: undeclared members stay advisory and never block', async () => {
  const report = await evaluateDoD(baseEvidence(), {})
  assert.equal(report.passed, true)
  assert.ok(report.advisories.some((item) => item.code === 'UNDECLARED_API_MEMBER'), '86 个自定义属性的那条路必须走得通')
})

test('S2 red: registering an advisory code as blocking is itself a hard fail', async () => {
  const report = await evaluateDoD(baseEvidence(), { blockingCodes: ['UNDECLARED_API_MEMBER'] })
  assertRed(report, 'S2-advisory-only-undeclared-members', 'DOD_GATE_NARROWING', 'S2 收紧门')
  assert.equal(report.failures.find((item) => item.code === 'DOD_GATE_NARROWING').retryable, false)
  provenRed.add('S2-advisory-only-undeclared-members')
})

test('S2 red: an upstream gate that parks undeclared members in errors is refused', async () => {
  const evidence = baseEvidence()
  evidence.scripts[1].check = {
    satisfied: false,
    dialect: 'cjs',
    mode: 'language-service',
    errors: [{ code: 'UNDECLARED_API_MEMBER', severity: 'error', symbol: 'world.Quanjujiaoyi', message: '属性不存在' }],
    warnings: [],
  }
  const report = await evaluateDoD(evidence, {})
  assertRed(report, 'S2-advisory-only-undeclared-members', 'UNDECLARED_MEMBER_TREATED_AS_BLOCKING', 'S2 上游误分类')
  provenRed.add('S2-advisory-only-undeclared-members')
})

test('S3 positive: the referenced name is in the tree, so nothing dangles', async () => {
  const report = await evaluateDoD(baseEvidence(), {})
  assert.equal(report.gates.find((gate) => gate.id === 'S3-ui-reference-not-dangling').status, 'pass')
  assert.deepEqual(report.uiDangling, [])
})

test('S3 red: a UI reference that is not in the tree is red, and the report names it', async () => {
  const evidence = baseEvidence()
  evidence.scripts[0].content = CLIENT_SCRIPT.replace("findChildByName('hp')", "findChildByName('mp_bar')")
  const report = await evaluateDoD(evidence, {})
  const hit = assertRed(report, 'S3-ui-reference-not-dangling', 'UI_REFERENCE_DANGLING', 'S3 悬空引用')
  assert.deepEqual(hit.detail.dangling.map((row) => row.name), ['mp_bar'])
  assert.equal(hit.detail.dangling[0].script, 'clientIndex.js')
  assert.equal(report.uiDangling.length, 1, 'uiDangling 必须单独暴露：这是 E 行验收口径')
  assert.equal(firstFailurePayload(report).code, 'UI_REFERENCE_DANGLING')
  provenRed.add('S3-ui-reference-not-dangling')
})

test('S3 red: no ui_tree_read reading, or a red lane C validator, both stay red', async () => {
  const noTree = baseEvidence()
  delete noTree.uiTree
  assertRed(await evaluateDoD(noTree, {}), 'S3-ui-reference-not-dangling', 'EVIDENCE_MISSING', 'S3 缺树读数')

  const bindingBroken = baseEvidence()
  const report = await evaluateDoD(bindingBroken, {
    uiBindingValidator: () => [{ code: 'UI_EVENT_NAME_UNKNOWN', severity: 'error', node: 'hp', event: 'click', message: 'click 不是既有 UiEvent 名' }],
  })
  assertRed(report, 'S3-ui-reference-not-dangling', 'UI_BINDING_INVALID', 'S3 绑定校验（泳道 C 注入位）')
  provenRed.add('S3-ui-reference-not-dangling')
})

test('the lane C envelope is accepted verbatim: {ok, problems[]} with a warning stays advisory', async () => {
  // Shape read off src/ui-binding.js:420-440 (problem() + finish()) — not imported here.
  const asRunByMainControl = () => ({
    ok: false,
    errorCount: 1,
    warningCount: 1,
    problems: [
      { code: 'UI_TREE_REF_UNRESOLVED', severity: 'error', retryable: true, hint: '把绑定指到树里存在的名字', rule: 'R2', message: '控件 "mp_bar" 不在 uiTree 里', subject: 'mp_bar' },
      { code: 'UI_EVENT_KIND_MISMATCH', severity: 'warning', retryable: false, hint: 'focus 只在 input 上有效', rule: 'R4', message: '事件 focus 与该节点类型不匹配', subject: 'hp' },
    ],
  })
  const report = await evaluateDoD(baseEvidence(), { uiBindingValidator: asRunByMainControl })
  const hit = assertRed(report, 'S3-ui-reference-not-dangling', 'UI_BINDING_INVALID', 'S3 收 C 的 problems 信封')
  assert.equal(hit.detail.upstreamCode, 'UI_TREE_REF_UNRESOLVED', '上游码必须留在 detail 里')
  assert.ok(
    report.advisories.some((item) => item.code === 'UI_BINDING_ADVISORY' && /focus/.test(item.message)),
    'C 的 warning 不能被升成阻塞项',
  )
  provenRed.add('S3-ui-reference-not-dangling')
})

test('S3: a commented-out reference is not a live reference, and a declared-but-unused node is only a warning', async () => {
  const commented = baseEvidence()
  commented.scripts[0].content = "// const gone = ui.findChildByName('ghost')\nexport const ready = 1\n"
  const report = await evaluateDoD(commented, {})
  assert.equal(report.passed, true, JSON.stringify(report.failures))
  assert.ok(report.advisories.some((item) => item.code === 'UI_NODE_UNREFERENCED'), '超集是合法的，只能提示')

  const dynamic = baseEvidence()
  dynamic.scripts[0].content = "const name = pick()\nconst node = ui.findChildByName(name)\nexport default node\n"
  const second = await evaluateDoD(dynamic, {})
  assert.equal(second.passed, true)
  assert.ok(second.advisories.some((item) => item.code === 'UI_REFERENCE_DYNAMIC_UNVERIFIED'))
})

test('S4 red: a database DSN in a script is refused with the publish-rule message', async () => {
  const evidence = baseEvidence()
  evidence.scripts[1].content = 'const dsn = "postgres://user:secret@10.0.0.1/db"\nmodule.exports = { dsn }\n'
  const report = await evaluateDoD(evidence, { typegateConfig })
  const hit = assertRed(report, 'S4-no-sensitive-strings', 'SENSITIVE_CONTENT', 'S4 敏感串')
  assert.equal(hit.retryable, false, '带凭据的正文不能"重试"，只能改内容')
  assert.match(hit.message, /数据库连接串/)
  provenRed.add('S4-no-sensitive-strings')
})

/** ------------------------------------------------------------------ 运行四门 ------------------------------------------------------------------ */

test('R1 red: notFound / playEnabled=false / login redirect / 502 each go red', async () => {
  const cases = [
    [{ notFound: true }, 'ENTRY_NOT_FOUND'],
    [{ playEnabled: false }, 'ENTRY_PLAY_DISABLED'],
    [{ redirected: true, redirectTo: 'playerLogin' }, 'ENTRY_AUTH_REDIRECT'],
    [{ httpStatus: 502 }, 'ENTRY_BAD_STATUS'],
  ]
  for (const [patch, code] of cases) {
    const evidence = baseEvidence()
    Object.assign(evidence.entry, patch)
    assertRed(await evaluateDoD(evidence, {}), 'R1-entry-contract', code, `R1 ${code}`)
  }
  provenRed.add('R1-entry-contract')
})

test('R2 red: kickSession(NoAuth=5) is a hard fail, and 1005/clean is a kick not a healthy close', async () => {
  const kicked = baseEvidence()
  kicked.ws.kickCode = CLOSE_TYPE.NoAuth
  const first = assertRed(await evaluateDoD(kicked, {}), 'R2-ws-session-survives', 'WS_KICK_NO_AUTH', 'R2 踢人')
  assert.equal(CLOSE_TYPE.NoAuth, 5, 'CloseType 的顺序就是值：NoAuth 必须是 5')
  assert.equal(first.retryable, false, '同一条 fail-closed 路径重试只会被再踢一次')

  const silent1005 = baseEvidence()
  silent1005.ws.closeCode = 1005
  silent1005.ws.wasClean = true
  silent1005.ws.clientInitiatedClose = false
  assertRed(await evaluateDoD(silent1005, {}), 'R2-ws-session-survives', 'WS_CLOSE_1005', 'R2 无码 close')

  const otherKick = baseEvidence()
  otherKick.ws.kickCode = CLOSE_TYPE.LinkExpired
  assertRed(await evaluateDoD(otherKick, {}), 'R2-ws-session-survives', 'WS_KICKED', 'R2 其它踢会话')

  const short = baseEvidence()
  short.ws.aliveMs = 40
  short.ws.clientInitiatedClose = false
  assertRed(await evaluateDoD(short, {}), 'R2-ws-session-survives', 'WS_SESSION_TOO_SHORT', 'R2 40 ms 即断（O15 回环实测）')

  const neverConnected = baseEvidence()
  neverConnected.ws.connected = false
  assertRed(await evaluateDoD(neverConnected, {}), 'R2-ws-session-survives', 'WS_SESSION_NOT_CONNECTED', 'R2 从未连上')

  const noWorld = baseEvidence()
  noWorld.ws.enteredWorld = false
  assertRed(await evaluateDoD(noWorld, {}), 'R2-ws-session-survives', 'WS_NO_WORLD_ENTRY', 'R2 没到进图里程碑')
  provenRed.add('R2-ws-session-survives')
})

test('R2 positive: 1005 by the probe itself is the known-benign second reading (O15:179)', async () => {
  const evidence = baseEvidence()
  evidence.ws.closeCode = 1005
  evidence.ws.clientInitiatedClose = true
  const report = await evaluateDoD(evidence, {})
  assert.equal(report.gates.find((gate) => gate.id === 'R2-ws-session-survives').status, 'pass', JSON.stringify(report.failures))
})

test('R3 red: exception, MODULE_NOT_FOUND, an empty window and status-only frames are all red', async () => {
  const thrown = baseEvidence()
  thrown.runtimeEvents.push({ type: 'exception', side: 'client', level: 'error', message: 'Cannot read properties of undefined', stack: 'at clientIndex.js:2:11', at: 3, id: 12 })
  assertRed(await evaluateDoD(thrown, {}), 'R3-runtime-events-tail-clean', 'RUNTIME_EXCEPTION', 'R3 异常')

  const missingModule = baseEvidence()
  missingModule.runtimeEvents = [{ type: 'exception', side: 'server', level: 'error', message: "Error: Cannot find module './lib.js'", stack: '', at: 3, id: 12 }]
  assertRed(await evaluateDoD(missingModule, {}), 'R3-runtime-events-tail-clean', 'MODULE_NOT_FOUND', 'R3 require 图')

  const idle = baseEvidence()
  idle.runtimeEvents = [{ type: 'status', phase: 'ready', running: true, at: 1, id: 10 }]
  assertRed(await evaluateDoD(idle, {}), 'R3-runtime-events-tail-clean', 'NO_RUNTIME_EVIDENCE', 'R3 只有 status 帧')

  const nothing = baseEvidence()
  nothing.runtimeEvents = []
  assertRed(await evaluateDoD(nothing, {}), 'R3-runtime-events-tail-clean', 'EVIDENCE_MISSING', 'R3 空窗不许当通过')

  const notRunning = baseEvidence()
  notRunning.runtimeStatus = { running: false, phase: 'idle' }
  assertRed(await evaluateDoD(notRunning, {}), 'R3-runtime-events-tail-clean', 'RUNTIME_IDLE', 'R3 预览没跑')
  provenRed.add('R3-runtime-events-tail-clean')
})

test('R4 red: saving while a preview runs is a HARD failure, force included', async () => {
  const duringPreview = baseEvidence()
  duringPreview.saves = [{ ok: true, previewRunning: true, forced: false }]
  const hit = assertRed(await evaluateDoD(duringPreview, {}), 'R4-no-save-while-preview-running', 'SAVE_WHILE_PREVIEW_RUNNING', 'R4 预览中保存')
  assert.equal(hit.retryable, true, '停掉预览重存一次就能好：必须是可重试')
  assert.match(hit.hint, /replica-server\.ts:1600-1603|1600-1603|action:"stop"/)

  const forced = baseEvidence()
  forced.saves = [{ ok: true, previewRunning: true, forced: true }]
  const report = await evaluateDoD(forced, {})
  assertRed(report, 'R4-no-save-while-preview-running', 'SAVE_FORCE_USED', 'R4 force 保存')
  assertRed(report, 'R4-no-save-while-preview-running', 'TERRAIN_NOT_PERSISTED', 'R4 地形没落盘')

  const noTerrain = baseEvidence()
  noTerrain.saves = [{ ok: true, previewRunning: false, forced: false, terrainWrittenIgnored: true }]
  noTerrain.terrainWritten = false
  noTerrain.writes = [{ tool: 'map_save', ok: true, before: { headHash: 'h1' } }]
  assert.equal((await evaluateDoD(noTerrain, {})).passed, true, '没写地形时不该误报')
  provenRed.add('R4-no-save-while-preview-running')
})

/** ------------------------------------------------------------------ 可回滚四门 ------------------------------------------------------------------ */

test('B1 red: a write without a pre-captured revision/headHash is red', async () => {
  const evidence = baseEvidence()
  evidence.writes = [{ tool: 'ui_node_add', ok: true, before: {} }]
  assertRed(await evaluateDoD(evidence, {}), 'B1-prewrite-token-captured', 'PREWRITE_TOKEN_MISSING', 'B1 写前令牌')
  provenRed.add('B1-prewrite-token-captured')
})

test('B2 red: an un-rolled-back failure and a rollback without read-back are both red', async () => {
  const dirty = baseEvidence()
  dirty.writes = [{ tool: 'ui_node_add', ok: false, before: { revision: 'ui:0' }, error: { code: 'UI_NODE_ADD_FAILED', retryable: true, hint: '按 failure 修参数再来', message: '第 2 个失败' } }]
  assertRed(await evaluateDoD(dirty, {}), 'B2-rollback-confirmed-and-readable', 'WRITE_NOT_ROLLED_BACK', 'B2 没回滚')

  const claimed = baseEvidence()
  claimed.writes = [{ tool: 'ui_node_add', ok: false, before: { revision: 'ui:0' }, rolledBack: true, readback: {}, error: { code: 'UI_NODE_ADD_FAILED', retryable: true, hint: '按 failure 修参数再来', message: '第 2 个失败' } }]
  assertRed(await evaluateDoD(claimed, {}), 'B2-rollback-confirmed-and-readable', 'ROLLBACK_READBACK_MISSING', 'B2 回滚无读回')

  const honest = baseEvidence()
  honest.writes = [{ tool: 'ui_node_add', ok: false, before: { revision: 'ui:0' }, rolledBack: true, readback: { revision: 'ui:0', nodes: 3 } }]
  const report = await evaluateDoD(honest, {})
  assert.equal(report.gates.find((gate) => gate.id === 'B2-rollback-confirmed-and-readable').status, 'pass', JSON.stringify(report.failures))
  provenRed.add('B2-rollback-confirmed-and-readable')
})

test('B3 red: a CAS conflict surfaced as an unknown failure is red', async () => {
  const flattened = baseEvidence()
  flattened.writes = [{ tool: 'ui_node_add', ok: false, before: { revision: 'ui:0' }, rolledBack: true, readback: { revision: 'ui:0' }, error: { code: 'TOOL_FAILED', retryable: false, hint: '这一支没有结构化的错误码', message: 'HTTP 409' } }]
  assertRed(await evaluateDoD(flattened, {}), 'B3-revision-conflict-is-retryable', 'CONFLICT_NOT_RETRYABLE', 'B3 塌成 TOOL_FAILED')

  const notRetryable = baseEvidence()
  notRetryable.writes = [{ tool: 'ui_node_add', ok: false, before: { revision: 'ui:0' }, rolledBack: true, readback: { revision: 'ui:0' }, error: { code: 'REVISION_CONFLICT', retryable: false, hint: '重新读一次再来', message: '冲突' } }]
  assertRed(await evaluateDoD(notRetryable, {}), 'B3-revision-conflict-is-retryable', 'CONFLICT_NOT_RETRYABLE', 'B3 retryable 说假')

  const bare = baseEvidence()
  bare.writes = [{ tool: 'ui_node_add', ok: false, before: { revision: 'ui:0' }, rolledBack: true, readback: { revision: 'ui:0' }, error: { message: 'boom' } }]
  assertRed(await evaluateDoD(bare, {}), 'B3-revision-conflict-is-retryable', 'ERROR_CONTRACT_INCOMPLETE', 'B3 三件套缺失')

  const good = baseEvidence()
  good.writes = [{ tool: 'ui_node_add', ok: false, before: { revision: 'ui:0' }, rolledBack: true, readback: { revision: 'ui:0' }, error: { code: 'REVISION_CONFLICT', retryable: true, hint: '重新 ui_tree_read 取新 revision 再试', message: '冲突' } }]
  const report = await evaluateDoD(good, {})
  assert.equal(report.gates.find((gate) => gate.id === 'B3-revision-conflict-is-retryable').status, 'pass', JSON.stringify(report.failures))
  provenRed.add('B3-revision-conflict-is-retryable')
})

test('B4 red: a head hash that never advanced, and a rollback that landed elsewhere, are both red', async () => {
  const stuck = baseEvidence()
  stuck.revisionChain = { before: { headHash: 'h1' }, after: { headHash: 'h1' } }
  assertRed(await evaluateDoD(stuck, {}), 'B4-head-hash-chain-monotonic', 'HEAD_HASH_NOT_ADVANCED', 'B4 版本头没推进')

  const rewound = baseEvidence()
  rewound.revisionChain = { before: { headHash: 'h1' }, after: { headHash: 'h2' }, rolledBackReadback: { headHash: 'h9' } }
  assertRed(await evaluateDoD(rewound, {}), 'B4-head-hash-chain-monotonic', 'ROLLBACK_HASH_MISMATCH', 'B4 回滚后头不对')

  const unreadable = baseEvidence()
  unreadable.revisionChain = { before: { headHash: 'h1' }, after: {} }
  assertRed(await evaluateDoD(unreadable, {}), 'B4-head-hash-chain-monotonic', 'HEAD_HASH_UNREADABLE', 'B4 读不到头')

  const declared = baseEvidence()
  declared.revisionChain = { before: { headHash: 'h1' }, after: { headHash: 'h1' }, noChangeDeclared: true }
  assert.equal((await evaluateDoD(declared, {})).passed, true, '声明了"本次无改动"就不该误报')
  provenRed.add('B4-head-hash-chain-monotonic')
})

/** ------------------------------------------------------------------ 兼容五门 ------------------------------------------------------------------ */

test('K1 red: a legacy map whose read-back digest moved is red', async () => {
  const evidence = baseEvidence()
  evidence.legacyReadback = [{ name: '老图-A', digestBefore: 'sha:aaa', digestAfter: 'sha:bbb' }]
  assertRed(await evaluateDoD(evidence, {}), 'K1-legacy-map-bytes-unchanged', 'LEGACY_MAP_BYTES_CHANGED', 'K1 逐字节变了')

  const noBefore = baseEvidence()
  noBefore.legacyReadback = [{ name: '老图-A', digestAfter: 'sha:aaa' }]
  assertRed(await evaluateDoD(noBefore, {}), 'K1-legacy-map-bytes-unchanged', 'LEGACY_READBACK_UNAVAILABLE', 'K1 没有写前摘要')

  const declaredChange = baseEvidence()
  declaredChange.legacyReadback = [{ name: '老图-A', digestBefore: 'sha:aaa', digestAfter: 'sha:bbb', declaredChange: true }]
  assertRed(await evaluateDoD(declaredChange, {}), 'K1-legacy-map-bytes-unchanged', 'LEGACY_MAP_BYTES_CHANGED', 'K1 声明了也照样红：DoD 不豁免')
  provenRed.add('K1-legacy-map-bytes-unchanged')
})

test('K2 red: dropping one of the 86 undeclared keys is red, by name and by count', async () => {
  const dropped = baseEvidence()
  dropped.customProperties = { before: ['Quanjujiaoyi', 'legacyFlag'], after: ['legacyFlag'] }
  const hit = assertRed(await evaluateDoD(dropped, {}), 'K2-custom-properties-preserved', 'CUSTOM_PROPERTY_DROPPED', 'K2 丢键')
  assert.deepEqual(hit.detail.lost, ['Quanjujiaoyi'])

  const shrunk = baseEvidence()
  shrunk.customProperties = { beforeCount: 86, afterCount: 85 }
  assertRed(await evaluateDoD(shrunk, {}), 'K2-custom-properties-preserved', 'CUSTOM_PROPERTY_COUNT_SHRANK', 'K2 数量下降')
  provenRed.add('K2-custom-properties-preserved')
})

test('K3 red: freeze, seal and a narrowed injected surface are each red', async () => {
  const frozen = baseEvidence()
  frozen.injection = { ...frozen.injection, frozen: true }
  assertRed(await evaluateDoD(frozen, {}), 'K3-no-freeze-seal-narrowing', 'INJECTION_FROZEN', 'K3 freeze')

  const sealed = baseEvidence()
  sealed.injection = { ...sealed.injection, sealed: true }
  assertRed(await evaluateDoD(sealed, {}), 'K3-no-freeze-seal-narrowing', 'INJECTION_SEALED', 'K3 seal')

  const narrowed = baseEvidence()
  narrowed.injection = { target: 'world', frozen: false, sealed: false, surfaceBefore: ['world', 'ui'], surfaceAfter: ['world'] }
  assertRed(await evaluateDoD(narrowed, {}), 'K3-no-freeze-seal-narrowing', 'INJECTION_SURFACE_NARROWED', 'K3 收窄')

  const grown = baseEvidence()
  grown.injection = { target: 'world', frozen: false, sealed: false, surfaceBefore: ['world'], surfaceAfter: ['world', 'ui', 'player'] }
  assert.equal((await evaluateDoD(grown, {})).passed, true, '只增长必须放行')
  provenRed.add('K3-no-freeze-seal-narrowing')
})

test('K4 red: a tool name that disappeared from the advertised face is red', async () => {
  const evidence = baseEvidence()
  evidence.toolsList = { before: ['map_list', 'map_status', 'script_read'], after: ['map_list', 'map_status'] }
  const hit = assertRed(await evaluateDoD(evidence, {}), 'K4-surface-growth-only', 'ADVERTISED_TOOL_REMOVED', 'K4 面缩小')
  assert.deepEqual(hit.detail.removed, ['script_read'])
  provenRed.add('K4-surface-growth-only')
})

test('K5 red: touching protected play metadata or the entry contract is red', async () => {
  for (const field of PROTECTED_PLAY_FIELDS) {
    const evidence = baseEvidence()
    evidence.writeTouches = [{ tool: 'map_meta_write', path: `manifest/${field}`, kind: 'write' }]
    assertRed(await evaluateDoD(evidence, {}), 'K5-entry-contract-and-protected-fields-untouched', 'PROTECTED_FIELD_TOUCHED', `K5 受保护字段 ${field}`)
  }

  const contract = baseEvidence()
  contract.entryContract = { modified: true, files: ['apps/game/pages/p/[gameName]/index.tsx'] }
  assertRed(await evaluateDoD(contract, {}), 'K5-entry-contract-and-protected-fields-untouched', 'ENTRY_CONTRACT_MODIFIED', 'K5 进图契约')

  const readOnly = baseEvidence()
  readOnly.writeTouches = [{ tool: 'ui_tree_read', path: 'manifest/name', kind: 'read' }]
  assert.equal((await evaluateDoD(readOnly, {})).passed, true, '只读碰过字段名不算写')
  provenRed.add('K5-entry-contract-and-protected-fields-untouched')
})

/** ------------------------------------------------------------------ 覆盖率自证 ------------------------------------------------------------------ */

test('every DoD rule has at least one asserted-red counterexample', () => {
  const ids = DOD_RULES.map((rule) => rule.id)
  const uncovered = ids.filter((id) => !provenRed.has(id))
  assert.deepEqual(uncovered, [], `这些规则没有真的变红过：${uncovered.join(', ')}`)
  assert.equal(ids.length, 17)
  assert.deepEqual([...new Set(ids)].length, 17, '规则 id 不能重复')
  // 40+ distinct (rule, code) pairs were proven FAIL — the number is measured here,
  // not asserted from a comment, so a rule that only "looks" covered cannot pass.
  assert.ok(provenRedPairs.size >= 40, `反例只有 ${provenRedPairs.size} 条：${[...provenRedPairs].join(', ')}`)
  if (process.env.BOX3_DOD_REPORT_COUNT) console.log(`DOD_RED_PAIRS=${provenRedPairs.size} DOD_RED_CALLS=${redCalls}`)
  for (const group of DOD_GROUPS) {
    assert.ok(DOD_RULES.filter((rule) => rule.group === group).length > 0, `${group} 组是空的`)
    const groupRules = DOD_RULES.filter((rule) => rule.group === group).map((rule) => rule.id)
    assert.deepEqual(groupRules.filter((id) => !provenRed.has(id)), [], `${group} 组有规则没变红过`)
  }
})

test('the DoD error table is complete and mirrors the {code, retryable, hint} contract', () => {
  const codes = Object.keys(DOD_CODE_CONTRACT)
  assert.ok(codes.length >= 40, `DoD 码表只有 ${codes.length} 条`)
  for (const code of codes) {
    const entry = DOD_CODE_CONTRACT[code]
    assert.equal(typeof entry.retryable, 'boolean', `${code} 缺 retryable`)
    assert.ok(entry.hint.length > 10, `${code} 的 hint 太空`)
    assert.match(entry.hint, /[a-z_]+|BOX_|DoD|playbook/, `${code} 的 hint 没指向下一步`)
  }
  assert.equal(dodRetryable('NO_SUCH_CODE'), false)
  assert.match(dodHintFor('NO_SUCH_CODE'), /没登记|补表或改回既有码/)
})

test('verifyErrorContract refuses a verdict its own tables do not recognise', () => {
  assert.throws(
    () => verifyErrorContract({ failures: [{ ruleId: 'X', code: 'NOT_REGISTERED_ANYWHERE', retryable: false, hint: '一条足够长的提示文本', severity: 'error' }], advisories: [] }),
    /未登记的码 NOT_REGISTERED_ANYWHERE/,
  )
  assert.throws(
    () => verifyErrorContract({ failures: [], advisories: [{ ruleId: 'X', code: 'SENSITIVE_CONTENT', retryable: false, hint: '一条足够长的提示文本', severity: 'warning' }] }),
    /分类漂移/,
  )
  assert.throws(
    () => verifyErrorContract({ failures: [{ ruleId: 'X', code: 'EVIDENCE_MISSING', retryable: true, hint: '短', severity: 'error' }], advisories: [] }),
    /hint 太空/,
  )
})

/** ------------------------------------------------------------------ 纯函数与口径 ------------------------------------------------------------------ */

test('extractUiReferences only ever grows: lane C can add patterns, never remove them', () => {
  const four = UI_REFERENCE_PATTERNS.length
  assert.ok(four >= 4)
  const base = extractUiReferences("const a = ui.findChildByName('x')\nconst b = ui.screen('MAIN')\n")
  assert.deepEqual(base.literals.map((row) => row.name), ['x', 'MAIN'])
  const widened = extractUiReferences("const c = ui.pickNode('y')\n", [{ via: 'ui.pickNode', re: /ui\s*\.\s*pickNode\s*\(\s*(['"])([^'"]+)\1/g }])
  assert.deepEqual(widened.literals.map((row) => row.name), ['y'])
  assert.equal(base.literals.length, 2, '基础模式数不得被"加宽"操作悄悄改掉')
})

test('declaredUiNames covers name and id plus the murda-tree roots; compareSurface is superset-only', () => {
  const declared = declaredUiNames(baseEvidence().uiTree)
  for (const name of ['Root', 'screen', 'hp', '7', 'DEFAULT_SCREEN_ID']) assert.ok(declared.has(name), `${name} 应算已声明`)
  assert.equal(declared.has('ghost'), false)
  const grown = compareSurface(['a', 'b'], ['a', 'b', 'c'])
  assert.equal(grown.superset, true)
  assert.deepEqual(grown.added, ['c'])
  const shrunk = compareSurface(['a', 'b'], ['a'])
  assert.equal(shrunk.superset, false)
  assert.deepEqual(shrunk.removed, ['b'])
})

test('dodRuleIndex reports the documented 4/4/4/5 shape', () => {
  const index = dodRuleIndex()
  assert.deepEqual(Object.keys(index), DOD_GROUPS)
  assert.equal(index.static.length, 4)
  assert.equal(index.runtime.length, 4)
  assert.equal(index.rollback.length, 4)
  assert.equal(index.compat.length, 5)
  for (const rows of Object.values(index)) for (const row of rows) assert.ok(row.title && row.id)
})

test('summarize gives main control the counts it puts on screen', async () => {
  const evidence = baseEvidence()
  evidence.ws.kickCode = CLOSE_TYPE.NoAuth
  evidence.scripts[0].content = CLIENT_SCRIPT.replace("'hp'", "'ghost'")
  const report = await evaluateDoD(evidence, {})
  const summary = summarize(report)
  assert.equal(summary.verdict, 'FAIL')
  assert.equal(summary.failures, 2)
  assert.equal(summary.groups.runtime.failed, 1)
  assert.equal(summary.groups.static.failed, 1)
  assert.deepEqual(report.blockingRuleIds.sort(), ['R2-ws-session-survives', 'S3-ui-reference-not-dangling'])
  assert.equal(report.uiDangling.length, 1)
})

test('groups can be run one at a time without faking the others', async () => {
  const evidence = baseEvidence()
  evidence.ws.kickCode = CLOSE_TYPE.NoAuth
  const staticOnly = await evaluateDoD(evidence, { groups: ['static'] })
  assert.equal(staticOnly.passed, true)
  assert.equal(staticOnly.rulesRun, 4)
  const runtimeOnly = await evaluateDoD(evidence, { groups: ['runtime'] })
  assert.equal(runtimeOnly.passed, false)
  assert.equal(runtimeOnly.rulesRun, 4)
})

/** ------------------------------------------------------------------ playbook ------------------------------------------------------------------ */

test('the playbook is 12 steps, its hard ordering passes its own audit, and 8 steps are unskippable', () => {
  assert.equal(PLAYBOOK.steps.length, 12)
  assert.deepEqual(auditPlaybook(), [], 'playbook 自己必须过自己的审计')
  const stops = PLAYBOOK.steps.filter((step) => step.skippable === false).map((step) => step.n)
  assert.deepEqual(stops, PLAYBOOK_UNSKIPPABLE)
  assert.equal(PLAYBOOK_UNSKIPPABLE.length, 8)
  const byN = Object.fromEntries(PLAYBOOK.steps.map((step) => [step.n, step]))
  assert.ok(byN[4].tool.includes('action:"stop"') && byN[4].skippable === false, '第 4 步必须是"停预览"且不可跳')
  assert.ok(byN[9].tool.includes('map_save') && byN[9].skippable === false, '第 9 步 save 不可跳')
  assert.ok(byN[10].tool.includes('action:"start"'), '第 10 步才起预览')
  assert.ok(byN[11].tool.includes('evaluateDoD'), '第 11 步自检 DoD')
  assert.ok(byN[12].tool.includes('runtime_events_tail'), '第 12 步冒烟')
  for (const step of PLAYBOOK.steps) {
    assert.ok(step.action && step.tool && step.onErrorCode, `步骤 ${step.n} 缺 action/tool/onErrorCode`)
    assert.ok(step.read, `步骤 ${step.n} 没说读哪个返回字段`)
  }
})

test('the playbook audit really goes red on a softened copy', () => {
  const swapped = PLAYBOOK.steps.map((step) => ({ ...step }))
  // A lane that "optimises" the loop by starting the preview before saving:
  const save = swapped.find((step) => step.tool.includes('map_save'))
  const start = swapped.find((step) => step.tool.includes('action:"start"'))
  ;[save.n, start.n] = [start.n, save.n]
  const findings = auditPlaybook(swapped)
  assert.ok(findings.length, '顺序被改坏必须有 finding')
  assert.ok(findings.some((item) => item.code === 'PLAYBOOK_ORDER_INVALID'))
  assert.match(JSON.stringify(findings), /map_preview start|map_save/)

  const withoutStop = PLAYBOOK.steps.filter((step) => !step.tool.includes('action:"stop"'))
  const second = auditPlaybook(withoutStop)
  assert.ok(second.some((item) => /停预览/.test(item.message)), '删掉"停预览"必须被抓到')

  const mute = PLAYBOOK.steps.map((step) => (step.skippable === false ? { ...step, onErrorCode: '' } : step))
  assert.ok(auditPlaybook(mute).some((item) => /不可跳/.test(item.message)))
})

test('every playbook step names a tool that is really advertised, except the DoD seam lane E owns', () => {
  const ctx = buildContext({
    BOX_MCP_PROFILE: 'authoring',
    BOX_MCP_ALLOW_WRITE: '1',
    BOX_MCP_TYPEGATE: 'syntax',
    BOX_ENGINE_REPO_ROOT: REPO_ROOT,
  })
  const advertised = new Set(buildTools(ctx).map((tool) => tool.name))
  assert.equal(advertised.size, 37, 'A 泳道接完线后 face 是 37')
  for (const step of PLAYBOOK.steps) {
    if (step.n === 11) continue
    const named = step.tool.split(/[^a-z0-9_]+/i).filter((token) => advertised.has(token))
    assert.ok(named.length >= 1, `步骤 ${step.n} 没提到任何真实工具：${step.tool}`)
  }
  // The one thing lane E cannot wire itself: evaluateDoD is exported, and no
  // MCP tool exposes it yet. Main control owns that last hop.
  assert.equal(advertised.has('map_dod_report'), false, 'map_dod_report 由主控接线，不该已由某泳道创建')
})

test('lane E stays inside its file boundary: dod.js neither imports nor shadows lane C', async () => {
  const text = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'dod.js'), 'utf8')
  assert.doesNotMatch(text, /from\s+['"][^'"]*ui-binding\.js['"]/, 'ui-binding.js 是泳道 C 的，只能走注入位')
  assert.doesNotMatch(text, /from\s+['"][^'"]*server\.js['"]/)
  assert.match(text, /options\.uiBindingValidator/, 'C 泳道只能从注入位进来，这是契约的一部分')
  // Lane C's seam has to be reachable with its file absent, or the gate is C-coupled.
  const withoutValidator = await evaluateDoD(baseEvidence(), {})
  assert.equal(withoutValidator.passed, true)
  const report = await evaluateDoD(baseEvidence(), { uiBindingValidator: () => [] })
  assert.equal(report.passed, true, '注入位返回空数组就是没有绑定问题')
})

test('advisory codes are exactly the undeclared-member class (86 properties landmine)', () => {
  for (const code of ['UNDECLARED_API_MEMBER', 'REQUIRE_SPECIFIER_UNVERIFIED', 'BARE_IMPORT_SPECIFIER_UNVERIFIED']) {
    assert.ok(ADVISORY_CODES.has(code), `${code} 必须是告警级`)
  }
  assert.equal(ADVISORY_CODES.has('SYNTAX_ERROR'), false)
  assert.equal(ADVISORY_CODES.has('UI_REFERENCE_DANGLING'), false, '悬空引用永远是阻塞项')
})
