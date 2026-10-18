/**
 * LANE E — THE MACHINE-CHECKABLE DEFINITION OF DONE.
 *
 * "Is this map finished?" is not a paragraph an agent can grade itself against.
 * This module turns that question into 17 executable rules over an EVIDENCE
 * object, in four groups (static / runtime / rollback / compat), and every
 * rule emits the same `{code, retryable, hint}` triple the rest of this MCP
 * promises (src/errors.js). Nothing here is advisory prose: `passed` is only
 * true when every rule in scope returned no blocking finding, and a rule that
 * was handed no evidence FAILS rather than "passes by absence" — that is the
 * difference between a gate and a checklist.
 *
 * HARD SOURCES (read, not assumed):
 *   - preview / save ordering — `services/game-server/src/edit/replica/replica-server.ts:1600-1603`:
 *       // update voxel hashes only if game isn't running
 *       const gameState = this._state.game.state;
 *       if (!gameState.replica.running) { const voxels = await recordVoxelInfo(gameState); ... }
 *     While a preview runs, the save path never records voxel chunk hashes, so a
 *     save taken during a preview silently loses terrain. Rule `R4` makes that a
 *     HARD failure, including the `force:true` escape hatch `map_save` exposes.
 *   - kick semantics — `internals/schema/types/game.ts:1-10` (`CloseType`, where
 *     `NoAuth` is the 6th member = 5), `services/game-server/src/index.ts:366`
 *     and `edit/replica/replica-server.ts:1391` both `kickSession(sessionId, CloseType.NoAuth)`.
 *     A kicked session is closed WITHOUT a status code, so the browser sees
 *     `code=1005 / reason='' / wasClean=true` (measured 4/4 paths in
 *     box3-re/scan/O15-ws-disconnect.md:40 ms loopback kill). Rule `R2` treats
 *     1005-with-clean as a server kick, not as a healthy disconnect.
 *   - entry contract — `apps/game/pages/p/[gameName]/index.tsx:55-68` (unknown
 *     play world → `notFound`, `playEnabled===false` → `notFound`, unauthenticated
 *     cookie → redirect to player login) + `apps/local-engine/src/play-library.js:424-436`
 *     (proxy to the runtime, 502 when the runtime upstream fails). Rules `R1`/`K5`.
 *   - protected metadata — `apps/game/server/play-admin.ts:858-859`
 *     `['name','author','description','cover','loadingCover']`. Rule `K5`.
 *   - compatibility red line — real maps carry 86 undeclared custom properties,
 *     so undeclared members may only WARN (`src/contract.js:174`
 *     `UNDECLARED_API_MEMBER`), never block; freeze/seal/shrinking an injected
 *     surface is a contract violation. Rules `S2`/`K2`/`K3`/`K4`, and every
 *     comparison here is growth-only (superset), never equality.
 *
 * REUSED, NOT REIMPLEMENTED: `judgeEvents()` from src/acceptance.js is the
 * runtime event verdict (rule `R3`), `scanSensitiveContent()` / `defaultDialect()`
 * from src/typegate.js are the static text gates (rules `S4`/`S1`), and
 * `isRetryable()` from src/errors.js is the authority on whether a conflict code
 * is retryable (rule `B3`). Lane C's UI-binding validator is a SEAM: it is
 * injected through `options.uiBindingValidator` (or its output passed as
 * `evidence.uiBindingFindings`) — this file neither imports nor owns it.
 */
import { judgeEvents } from './acceptance.js'
import { scanSensitiveContent, defaultDialect, checkScript } from './typegate.js'
import { isRetryable, CONTRACT_CODES } from './errors.js'

export const DOD_VERSION = 'e1'

/** Transcribed from `internals/schema/types/game.ts:1-10` (enum order IS the value). */
export const CLOSE_TYPE = {
  Normal: 0,
  Webgl: 1,
  Server: 2,
  Network: 3,
  Max: 4,
  NoAuth: 5,
  NeedLogin: 6,
  LinkExpired: 7,
  TimeRestriction: 8,
}

/** Close codes that mean "the server pulled the rug", per O15 field data. */
export const FATAL_WS_CLOSE_CODES = new Set([1005, 1006, 1011, 1012, 1015])

/**
 * Codes that MUST stay advisory: the 86 undeclared custom properties of real
 * maps live in this bucket. Blocking any of them is what rule `S2` exists to
 * catch (and it is itself a red counterexample in the test).
 */
export const ADVISORY_CODES = new Set([
  'UNDECLARED_API_MEMBER',
  'REQUIRE_SPECIFIER_UNVERIFIED',
  'BARE_IMPORT_SPECIFIER_UNVERIFIED',
  'UI_NODE_UNREFERENCED',
  'UI_REFERENCE_DYNAMIC_UNVERIFIED',
  'UI_BINDING_ADVISORY',
  'BUDGET_ADVISORY',
])

/** DoD's own codes. Same contract as src/errors.js: `{retryable, hint}`, hint names the next tool. */
export const DOD_CODE_CONTRACT = {
  EVIDENCE_MISSING: {
    retryable: true,
    hint: '本条 DoD 规则拿到的证据为空，判定为 fail 而不是"通过"。按 playbook 补齐读数：map_status / map_tool_catalog / ui_tree_read / script_list / map_revision / runtime_events_tail。',
  },
  // ---- static ----
  SCRIPT_SIDE_INVALID: { retryable: true, hint: 'side 只能是 client 或 server（类型位 1/7）；照 script_list 返回的 side 传。' },
  SCRIPT_GATE_FAILED: { retryable: true, hint: '按 detail.errors 的 code + line 改正文，再 script_typecheck → script_write/script_patch；不要绕过语法门。' },
  SCRIPT_DIALECT_MISMATCH: {
    retryable: true,
    hint: 'server=index.js 走 CommonJS 沙箱、client=clientIndex.js 走 import-map ESM。要么改正文符合该侧方言，要么显式传 dialect 并在 DoD 里说明理由。',
  },
  SCRIPT_GATE_UNAVAILABLE: {
    retryable: true,
    hint: '既没有 script_typecheck 的结论也没有可用语法门：先跑 script_typecheck，或给 evaluateDoD 传 options.runScriptGate / options.typegateConfig。',
  },
  DOD_GATE_NARROWING: {
    retryable: false,
    hint: '有人把只该告警的码（未声明成员等）注册成了拦截项——这会打死带 86 个自定义属性的真实地图。把它们从 options.blockingCodes 里移出去，DoD 判定的收紧本身就是缺陷。',
  },
  UNDECLARED_MEMBER_TREATED_AS_BLOCKING: {
    retryable: false,
    hint: '上游门把 UNDECLARED_API_MEMBER 之类放进了 errors（拦落盘）。把它们放回 warnings 再来：未声明成员只能提示，不能拦（兼容性红线）。',
  },
  UI_REFERENCE_DANGLING: {
    retryable: true,
    hint: '脚本按名字取的 UI 节点不在 ui_tree_read 的树里 ⇒ 运行期拿到 undefined。二选一：用 ui_node_add 将节点建出来（先 ui_tree_read 取 revision），或把脚本里的引用改成已存在的 name。改完重新 ui_tree_read + script_read 复跑 DoD。',
  },
  UI_BINDING_INVALID: {
    retryable: true,
    hint: 'UI 事件绑定校验（泳道 C 的 validateUiBindings）报错：按 detail 里的 node/event 修正，再 ui_node_add / script_patch 重做；事件名只能用既有 UiEvent 名（pointerdown/pointerup/focus/blur/load）。',
  },
  SENSITIVE_CONTENT: {
    retryable: false,
    hint: '命中引擎发布规则（project-manager.js:249-261 同款正则）：把凭据从脚本里移出去，改为服务端配置或 storage；带敏感串的图在发布/导出时会被整张打死。',
  },
  // ---- runtime ----
  ENTRY_NOT_FOUND: {
    retryable: false,
    hint: '进图 404：index.tsx:55-68 只在"图不在 play library / permanentMapId 不匹配"时 notFound。用 map_list 核对 permanentMapId 与工程目录名，别手拼 gameName。',
  },
  ENTRY_AUTH_REDIRECT: {
    retryable: true,
    hint: '被重定向到玩家登录（hasAuthenticatedPlayer 未过）：带有效 cookie 再探，或按 N6 的鉴权桥接取会话；这不是地图问题，但 DoD 不许据此声称"进图成功"。',
  },
  ENTRY_PLAY_DISABLED: { retryable: false, hint: 'playEnabled===false 会直接 notFound（index.tsx:63）：先在播放侧启用该图，再跑冒烟。' },
  ENTRY_BAD_STATUS: { retryable: true, hint: '入口 HTTP 非 2xx：先看 play-library.js:424-436 的转发是否 502（运行时没起来就用 map_status 看 runtimeActive）。' },
  WS_SESSION_NOT_CONNECTED: { retryable: true, hint: 'WS 从未连上：map_status 确认 runtimeActive，必要时 map_preview {action:"start"}，再重 probe。' },
  WS_KICK_NO_AUTH: {
    retryable: false,
    hint: '服务端 kickSession(CloseType.NoAuth=5)（index.tsx 无关，见 services/game-server/src/index.ts:366 / replica-server.ts:1391）：进图凭证/审核链路 fail-closed。这是服务端踢人，不是网络抖动，重试同一条路径只会再被踢。',
  },
  WS_KICKED: {
    retryable: false,
    hint: '非 NoAuth 的服务端踢会话（CloseType 见 internals/schema/types/game.ts）：按 reason 定位是登录态/链接过期/人数上限，不要在 DoD 里当"会话存活"记账。',
  },
  WS_CLOSE_1005: {
    retryable: false,
    hint: '1005 / reason="" / wasClean=true 且不是探针主动关闭 ⇒ 服务端 kickSession 后无码 close（O15 §实测：回环 40 ms 同形）。按踢人处理：查鉴权与审核凭证，不要当成正常断开。',
  },
  WS_ABNORMAL_CLOSE: { retryable: true, hint: '异常断开（1006/1011 等）且非客户端主动：先确认运行时与转发链（play-library.js:424-436），再复跑冒烟；一次复现即记 fail。' },
  WS_SESSION_TOO_SHORT: { retryable: true, hint: '会话活的时间低于 minSessionAliveMs：多半是进图后即被踢。加大探针观测窗口复跑，并回看服务端 kick 行。' },
  WS_NO_WORLD_ENTRY: { retryable: true, hint: '会话连着但没到达"进图"里程碑（world/scene 就绪）：等于没玩到这张图。把探针的里程碑断言补上再记账。' },
  RUNTIME_EXCEPTION: { retryable: true, hint: '运行期异常（acceptance.judgeEvents 原文）：把 message + locations 回喂模型修脚本，改完 map_save → map_preview start → runtime_events_tail 复跑。', upstream: true },
  MODULE_NOT_FOUND: { retryable: true, hint: 'require 图里缺模块：确认共享脚本存在（script_list），注意 index.js / clientIndex.js 是 map-local 不进共享表。', upstream: true },
  NO_RUNTIME_EVENTS: { retryable: true, hint: '窗口内零事件不等于通过：先 map_preview start，确认 runtime_status.running=true，再取 runtime_events_tail。', upstream: true },
  NO_RUNTIME_EVIDENCE: { retryable: true, hint: '只有 status 帧：预览刚启动还没跑脚本，或 sinceEventId 起点跳过了真实日志。按 playbook 顺序重取事件尾。', upstream: true },
  RUNTIME_IDLE: { retryable: true, hint: '预览运行时不在 running：V2 回路无法取证。map_preview {action:"start"} 之后再来；DoD 不接受"因为没跑所以没错"。' },
  SAVE_WHILE_PREVIEW_RUNNING: {
    retryable: true,
    hint: '硬顺序违例：预览在跑时保存不会记录 voxel chunk hash（replica-server.ts:1600-1603），地形会静默丢失。正确序列是 map_preview {action:"stop"} → 写 → map_save → map_preview {action:"start"}。停掉预览后重存一次。',
  },
  SAVE_FORCE_USED: {
    retryable: true,
    hint: 'map_save 用了 force:true，等于明知预览在跑仍强存（丢体素记录）。DoD 不接受 force 作为常规手段：先 map_preview stop 再不带 force 重存。',
  },
  TERRAIN_NOT_PERSISTED: {
    retryable: true,
    hint: '本次写过地形却没有任何"预览已停"的成功保存：terrain_* 只在运行时副本里，盘上没动。map_preview stop → map_save → map_revision 复核 headHash。',
  },
  // ---- rollback ----
  PREWRITE_TOKEN_MISSING: {
    retryable: true,
    hint: '写之前没拿到 revision/headHash 就没有回滚物料：先 script_read / ui_tree_read / terrain_info / entity_list / map_revision 读一次，把返回的令牌原样作为 expectedRevision 再写（宁可多一次往返）。',
  },
  WRITE_NOT_ROLLED_BACK: {
    retryable: false,
    hint: '失败的写没有回滚确认（rolledBack!==true）：图里留着半成品。按域回滚——terrain_revert / ui_node_remove / script_write 写回读到的原文——然后重跑 DoD。',
  },
  ROLLBACK_READBACK_MISSING: {
    retryable: true,
    hint: '回滚后必须读回证明（script_read / ui_tree_read / terrain_info / map_revision 的返回值）。没有 readback 的 rolledBack:true 只是自我声明，DoD 不认。',
  },
  ROLLBACK_HASH_MISMATCH: {
    retryable: false,
    hint: '回滚后盘上 headHash 与写前不一致：版本链被改动过（或回滚只回了一半）。不要继续往上写：先 map_revision 定位差异，必要时人工把工程恢复到写前头。',
  },
  HEAD_HASH_UNREADABLE: {
    retryable: true,
    hint: '读不到 headHash：设置 BOX_MAP_PROJECTS_ROOT 指向工程目录（盘上版本链是乐观锁唯一可信来源），或先确认这张图在编辑器里保存过（MISSING_PERMISSION_HASH）。',
  },
  HEAD_HASH_NOT_ADVANCED: {
    retryable: true,
    hint: '保存成功但版本头没推进：改动根本没进盘。map_status 看 runtimeActive，确认 map_save 真的转发了 /internal/save-local-project，再 map_revision 复测。',
  },
  CONFLICT_NOT_RETRYABLE: {
    retryable: false,
    hint: '乐观锁冲突（REVISION_CONFLICT / 409）被当成未知失败上报（retryable:false 或塌成 TOOL_FAILED）。按 src/errors.js 的表它是 retryable:true：主控接线处要保留原 code，不要让 errorPayload 兜底吞掉。',
  },
  ERROR_CONTRACT_INCOMPLETE: {
    retryable: false,
    hint: '错误对象缺 {code, retryable, hint} 三件套。这是本层缺陷，应当上报：接线处统一走 src/errors.js 的 errorPayload()，不要自己拼错误。',
  },
  // ---- compat ----
  LEGACY_MAP_BYTES_CHANGED: {
    retryable: false,
    hint: '旧图读回摘要变了：任何改写都必须被声明并单独评审（additive 判定）。先确认是不是保存路径重排了字段/丢了属性；没有声明就回滚这次改动。',
  },
  LEGACY_READBACK_UNAVAILABLE: {
    retryable: true,
    hint: '缺写前摘要（digestBefore）就没有"逐字节不变"的证据：先在写之前读一次并留摘要（map_revision / script_read / 旧图导出），再复跑 DoD。',
  },
  CUSTOM_PROPERTY_DROPPED: {
    retryable: false,
    hint: '未声明自定义属性被丢了（真实地图上有 86 个）：注入/回写必须是全键透传 + 只增不减。按 detail.lost 把键加回来；禁止 freeze/seal/白名单收窄。',
  },
  CUSTOM_PROPERTY_COUNT_SHRANK: {
    retryable: false,
    hint: '自定义属性数量下降：先别 map_save，用 map_revision + 写前摘要逐键比对 customProperties.beforeCount / afterCount，改成全键透传后再复跑 evaluateDoD。',
  },
  INJECTION_FROZEN: { retryable: false, hint: '被注入对象 Object.freeze 了：既有脚本读写任何未声明属性都会静默失败或抛错（86 个自定义属性的图首当其冲）。撤掉 freeze，保持可写超集。' },
  INJECTION_SEALED: { retryable: false, hint: 'Object.seal 与 freeze 同样致命（拒绝新增键）。撤掉 seal。' },
  INJECTION_SURFACE_NARROWED: {
    retryable: false,
    hint: '注入面变小了（detail.removed）：任何一次比较都只允许"增长/超集"。把少掉的成员加回去；新增可以，删除不行。',
  },
  ADVERTISED_TOOL_REMOVED: {
    retryable: false,
    hint: 'tools/list 面缩小了（detail.removed）：已经照旧名单行事的 agent 会突然找不到工具。要么恢复这些名字，要么由主控显式声明破坏性变更。',
  },
  PROTECTED_FIELD_TOUCHED: {
    retryable: false,
    hint: '写操作碰到播放侧受保护元数据（play-admin.ts:858 的 name/author/description/cover/loadingCover）：这些字段属人工/管理面，AI 作业流不得改。回滚该次写入。',
  },
  ENTRY_CONTRACT_MODIFIED: {
    retryable: false,
    hint: '进图契约（apps/game/pages/p/[gameName]/index.tsx:55-68 或 apps/local-engine/src/play-library.js:424-436）被改动：E 泳道判这是兼容性事故，AI 作业流必须绕开这两个文件。',
  },
  // ---- advisory classes (registered so they too carry the full triple; they never block) ----
  UNDECLARED_API_MEMBER: {
    retryable: false,
    hint: '只是提示：真实地图上有 86 个未声明自定义属性，这类成员永远不拦落盘。要确认签名用 contract_describe，要读回内容用 script_read。',
  },
  REQUIRE_SPECIFIER_UNVERIFIED: {
    retryable: false,
    hint: '只是提示：require 目标不在本图脚本表里。运行期若解析失败会由 runtime_events_tail 的 MODULE_NOT_FOUND 抓到。',
  },
  BARE_IMPORT_SPECIFIER_UNVERIFIED: {
    retryable: false,
    hint: '只是提示：Import Map 只登记本图模块，裸标识符能否解析未验证。要核对名单用 contract_describe(side:"client")。',
  },
  UI_NODE_UNREFERENCED: {
    retryable: false,
    hint: '只是提示（超集合法）：该节点没有脚本引用。确认是漏接还是预留，别为此删节点——删 UI 节点要 ui_node_remove + confirm。',
  },
  UI_REFERENCE_DYNAMIC_UNVERIFIED: {
    retryable: false,
    hint: '只是提示：变量名取节点静态判不了。把候选名改成字面量，或用 ui_tree_read 人工核对一次；运行期真悬空会由 R3 的异常兜住。',
  },
  UI_BINDING_ADVISORY: {
    retryable: false,
    hint: '泳道 C 的绑定校验给出的非阻塞提示：按 detail 里的 node/event 复核，需要改就 ui_tree_read 定位后重写绑定。',
  },
  BUDGET_ADVISORY: {
    retryable: false,
    hint: '只是提示：用量接近本层预算但还没超。拆批写（terrain_apply 分块、ui_node_add 分批）。',
  },
  // ---- self-check of this module ----
  DOD_CODE_UNREGISTERED: { retryable: false, hint: '抛出了一个 DOD_CODE_CONTRACT / errors.js 都没登记的码：本模块的契约缺陷，补表或改回既有码。' },
  DOD_RULE_MISCLASSIFIED: { retryable: false, hint: '某条规则把告警级码算成了阻塞级（或反之）：以 ADVISORY_CODES 为准修正分类。' },
  PLAYBOOK_ORDER_INVALID: { retryable: false, hint: 'playbook 步骤顺序违例（写/保存在起预览之前、保存前没停预览、缺自检等）。按 auditPlaybook 的 detail 调整步骤。' },
}

export function dodRetryable(code) {
  const entry = DOD_CODE_CONTRACT[code]
  return entry ? entry.retryable : false
}

export function dodHintFor(code) {
  const entry = DOD_CODE_CONTRACT[code]
  if (entry) return entry.hint
  return DOD_CODE_CONTRACT.DOD_CODE_UNREGISTERED.hint
}

/** The four groups. Order is the order the gates are meant to be run in. */
export const DOD_GROUPS = ['static', 'runtime', 'rollback', 'compat']

/** ---------------------------------------------------------------- helpers ---------------------------------------------------------------- */

const ALWAYS_DECLARED_UI = new Set(['Root', 'screen', 'ROOT_ID', 'DEFAULT_SCREEN_ID'])

/**
 * Comment stripper good enough for a reference scan: a UI name that only ever
 * appears inside a comment is not a live reference (mirrors the same rule the
 * typegate applies to `require`). String literals are preserved verbatim.
 */
export function stripComments(text) {
  let out = ''
  let i = 0
  const src = String(text ?? '')
  let quote = ''
  while (i < src.length) {
    const ch = src[i]
    const next = src[i + 1]
    if (quote) {
      out += ch
      if (ch === '\\') {
        out += next ?? ''
        i += 2
        continue
      }
      if (ch === quote) quote = ''
      i += 1
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      out += ch
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/** Literal-by-name UI access the shipped client API actually offers. */
export const UI_REFERENCE_PATTERNS = [
  { via: 'ui.findChildByName', re: /\.findChildByName\s*\(\s*(['"])([^'"\n]+)\1/g },
  { via: 'ui.screen', re: /\bui\s*\.\s*screen\s*\(\s*(['"])([^'"\n]+)\1/g },
  { via: 'ui.byName', re: /\bui\s*\.\s*byName\s*\(\s*(['"])([^'"\n]+)\1/g },
  { via: 'binding.uiNode', re: /\b(?:uiNode|uiNodeName|targetNode|nodeName|screenName)\s*:\s*(['"])([^'"\n]+)\1/g },
]

/** A call whose argument is not a string literal: cannot be verified statically. */
const DYNAMIC_UI_CALL = /\.findChildByName\s*\(\s*(?!['"])([A-Za-z_$][\w$]*)/g

/**
 * Every UI name a script asks for. `extraPatterns` only ever ADDS patterns —
 * lane C may widen this set, it must not be able to shrink it.
 * @returns {{literals:Array<{name:string, via:string, line:number}>, dynamic:Array<{symbol:string, line:number}>}}
 */
export function extractUiReferences(text, extraPatterns = []) {
  const source = stripComments(text)
  const patterns = [...UI_REFERENCE_PATTERNS, ...extraPatterns]
  const literals = []
  for (const pattern of patterns) {
    const re = pattern.re.global ? pattern.re : new RegExp(pattern.re.source, pattern.re.flags + 'g')
    re.lastIndex = 0
    for (const match of source.matchAll(re)) {
      const name = match[2] ?? match[1]
      if (!name) continue
      literals.push({ name, via: pattern.via, line: lineOf(source, match.index) })
    }
  }
  const dynamic = []
  for (const match of source.matchAll(DYNAMIC_UI_CALL)) {
    dynamic.push({ symbol: match[1], line: lineOf(source, match.index) })
  }
  return { literals, dynamic }
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length
}

/** Names AND ids the tree declares, plus the murda-tree roots (Root / screen). */
export function declaredUiNames(uiTree) {
  const names = new Set(ALWAYS_DECLARED_UI)
  const nodes = (uiTree && uiTree.nodes) || (Array.isArray(uiTree) ? uiTree : [])
  for (const node of nodes) {
    if (!node) continue
    if (node.name != null) names.add(String(node.name))
    if (node.id != null) names.add(String(node.id))
  }
  return names
}

/** Superset comparison. Growth is legal, anything else is a compatibility finding. */
export function compareSurface(before, after) {
  const a = new Set((before || []).map(String))
  const b = new Set((after || []).map(String))
  const removed = [...a].filter((name) => !b.has(name))
  const added = [...b].filter((name) => !a.has(name))
  return { removed, added, superset: removed.length === 0, beforeCount: a.size, afterCount: b.size }
}

function toList(value) {
  if (Array.isArray(value)) return value
  if (value == null) return []
  return [value]
}

function has(target, path) {
  if (target == null) return false
  const parts = String(path).split('.')
  let cursor = target
  for (const part of parts) {
    if (cursor == null || typeof cursor !== 'object') return false
    if (!(part in cursor)) return false
    cursor = cursor[part]
  }
  if (Array.isArray(cursor)) return cursor.length > 0
  if (typeof cursor === 'string') return cursor.length > 0
  if (typeof cursor === 'number') return Number.isFinite(cursor)
  if (typeof cursor === 'boolean') return true
  if (cursor && typeof cursor === 'object') return Object.keys(cursor).length > 0
  return cursor != null
}

/** `requires` entries may be `a|b` (any one of) or `!a` (must be falsy-free... no: must be PRESENT-and-false ok). */
function missingEvidence(evidence, requires = []) {
  const missing = []
  for (const term of requires) {
    const alternatives = String(term).split('|')
    if (!alternatives.some((alt) => has(evidence, alt))) missing.push(term)
  }
  return missing
}

/** One place to build a finding so the triple never goes out of shape. */
function finding(rule, code, message, extra = {}) {
  const severity = extra.severity || 'error'
  const { severity: _ignored, ...rest } = extra
  return {
    ruleId: rule.id,
    group: rule.group,
    severity,
    code,
    retryable: severity === 'error' ? dodRetryable(code) : false,
    hint: dodHintFor(code),
    message,
    ...rest,
  }
}

function advisory(rule, code, message, extra = {}) {
  return finding(rule, code, message, { ...extra, severity: 'warning' })
}

/** ---------------------------------------------------------------- rules ---------------------------------------------------------------- */

const S1 = {
  id: 'S1-script-syntax-dialect',
  group: 'static',
  title: '脚本语法/方言门（server=CJS、client=ESM）',
  requires: ['scripts'],
  source: 'services/game-server/src/script/bindings/resource.ts:387-405 + apps/game/src/engine/script/ses/ses-client.ts:283-294（两侧加载器不同方言）',
  async check({ scripts, options, evidence }) {
    const failures = []
    const advisories = []
    for (const [index, script] of scripts.entries()) {
      const label = script.name || script.entry || `scripts[${index}]`
      const side = script.side
      if (side !== 'client' && side !== 'server') {
        failures.push(
          finding(S1, 'SCRIPT_SIDE_INVALID', `${label} 的 side="${side ?? 'undefined'}"：DoD 只按 client/server 判方言。`, {
            script: label,
          }),
        )
        continue
      }
      let check = script.check
      if (!check) {
        if (typeof options.runScriptGate === 'function') {
          check = await options.runScriptGate(script, options)
        } else if (options.typegateConfig) {
          check = await checkScript(
            { side, content: script.content, dialect: script.dialect, mode: options.scriptMode || 'syntax' },
            options.typegateConfig,
          )
        }
      }
      if (!check || typeof check !== 'object') {
        failures.push(
          finding(S1, 'SCRIPT_GATE_UNAVAILABLE', `${label} 既没有 script_typecheck 结论也没有可用语法门：不判通过。`, {
            script: label,
          }),
        )
        continue
      }
      // The loaders are side-specific, so the DoD is stricter than the per-call
      // escape hatch `script_typecheck` offers: a finished map whose client script
      // was pushed through dialect:"cjs" is NOT done, even though the syntax gate
      // let it pass.
      const expected = defaultDialect(side)
      if (check.dialect && check.dialect !== expected) {
        failures.push(
          finding(
            S1,
            'SCRIPT_DIALECT_MISMATCH',
            `${label}（side=${side}）按 dialect=${check.dialect} 过门（来源 ${check.dialectSource || 'unknown'}），本侧加载器默认是 ${expected}。`,
            { script: label, expected, got: check.dialect, dialectSource: check.dialectSource },
          ),
        )
      }
      const blockingErrors = toList(check.errors).filter((item) => item && !ADVISORY_CODES.has(item.code))
      if (check.satisfied === false || blockingErrors.length) {
        failures.push(
          finding(S1, 'SCRIPT_GATE_FAILED', `${label} 未过静态门（mode=${check.mode || 'unknown'}）。`, {
            script: label,
            detail: { errors: toList(check.errors), mode: check.mode, tier: check.mode },
          }),
        )
      }
      // Advisory warnings stay non-blocking, but they are reported, never dropped.
      for (const item of [...toList(check.errors), ...toList(check.warnings)]) {
        if (item && ADVISORY_CODES.has(item.code)) {
          advisories.push(
            advisory(S1, item.code, `${label}：${item.message || item.symbol || item.code}`, {
              script: label,
              symbol: item.symbol,
            }),
          )
        }
      }
    }
    void evidence
    return { failures, advisories }
  },
}

const S2 = {
  id: 'S2-advisory-only-undeclared-members',
  group: 'static',
  title: '未声明成员只告警不拦（86 个自定义属性红线）',
  requires: [],
  check({ scripts, options }) {
    const failures = []
    const advisories = []
    // (a) DoD itself must never be configured to block an advisory class.
    const narrowed = toList(options.blockingCodes).filter((code) => ADVISORY_CODES.has(code))
    if (narrowed.length) {
      failures.push(
        finding(S2, 'DOD_GATE_NARROWING', `options.blockingCodes 把告警级码注册成了拦截项：${narrowed.join(', ')}。`, {
          detail: { narrowed, advisoryCodes: [...ADVISORY_CODES] },
        }),
      )
    }
    // (b) An upstream gate that parks undeclared members in `errors` is breaking the same line.
    for (const [index, script] of toList(scripts).entries()) {
      const label = script.name || script.entry || `scripts[${index}]`
      const blocked = toList(script.check && script.check.errors).filter(
        (item) => item && ADVISORY_CODES.has(item.code) && item.severity !== 'warning',
      )
      if (blocked.length) {
        failures.push(
          finding(S2, 'UNDECLARED_MEMBER_TREATED_AS_BLOCKING', `${label}：未声明成员被放进了 blocking errors（${blocked.map((item) => item.code).join(', ')}）。`, {
            script: label,
            detail: { blocked },
          }),
        )
      }
      for (const item of toList(script.check && script.check.warnings)) {
        if (item && ADVISORY_CODES.has(item.code)) {
          advisories.push(advisory(S2, item.code, `${label}：${item.message || item.symbol || item.code}（只告警，不拦落盘）`, { script: label }))
        }
      }
    }
    return { failures, advisories }
  },
}

const S3 = {
  id: 'S3-ui-reference-not-dangling',
  group: 'static',
  title: 'UI 引用不悬空（悬空即红）',
  requires: ['scripts', 'uiTree.nodes'],
  source: 'packages/script-api/src/client/modules/ui.ts:41 findChildByName + services/game-server/src/edit/ai/map-authoring-tools.ts:354-375 uiTreeRead 节点形状',
  check({ scripts, evidence, options }) {
    const failures = []
    const advisories = []
    const declared = declaredUiNames(evidence.uiTree)
    const nodes = toList(evidence.uiTree && evidence.uiTree.nodes)
    const patterns = []
    // Lane C widens the reference vocabulary through a seam; it can only ADD.
    for (const set of [options.uiReferencePatterns, evidence.uiReferencePatterns]) {
      for (const pattern of toList(set)) patterns.push(pattern)
    }
    const dangling = []
    const referenced = new Set()
    for (const [index, script] of toList(scripts).entries()) {
      const label = script.name || script.entry || `scripts[${index}]`
      if (typeof script.content !== 'string') continue
      const refs = extractUiReferences(script.content, patterns)
      for (const ref of refs.literals) {
        referenced.add(ref.name)
        if (!declared.has(ref.name)) dangling.push({ ...ref, script: label })
      }
      for (const dyn of refs.dynamic) {
        advisories.push(
          advisory(S3, 'UI_REFERENCE_DYNAMIC_UNVERIFIED', `${label}:${dyn.line} 用变量取节点（${dyn.symbol}），静态门无法判定它悬不悬空。`, {
            script: label,
            symbol: dyn.symbol,
          }),
        )
      }
    }
    if (dangling.length) {
      const names = [...new Set(dangling.map((row) => row.name))]
      failures.push(
        finding(
          S3,
          'UI_REFERENCE_DANGLING',
          `脚本引用了 ${names.length} 个不存在的 UI 节点名：${names.join(', ')}。运行期 findChildByName 返回 undefined，交互直接失效。`,
          { detail: { dangling, declaredNames: nodes.map((node) => node.name) } },
        ),
      )
    }
    // Declared-but-unreferenced is a superset and therefore legal: warning at most.
    for (const node of nodes) {
      if (!node || node.name == null) continue
      if (!referenced.has(String(node.name)) && !ALWAYS_DECLARED_UI.has(String(node.name))) {
        advisories.push(
          advisory(S3, 'UI_NODE_UNREFERENCED', `UI 节点 "${node.name}"（id=${node.id}）没有任何脚本引用：允许（超集），但值得确认不是漏接。`, {
            node: String(node.name),
          }),
        )
      }
    }
    // Lane C seam: the event-binding validator's findings, injected or precomputed.
    // `evidence` is never mutated — the merged list stays local to this rule.
    // `validateUiBindings()` (src/ui-binding.js) answers `{ok, problems:[...]}`, so
    // both a bare array and the `.problems` / `.findings` envelopes are accepted.
    const validator = typeof options.uiBindingValidator === 'function' ? options.uiBindingValidator : undefined
    let produced = validator ? validator({ scripts: toList(scripts), uiTree: evidence.uiTree, bindings: evidence.uiBindingProposals, evidence, options }) : undefined
    if (produced && !Array.isArray(produced)) produced = produced.problems ?? produced.findings ?? undefined
    const bindingFindings = Array.isArray(produced) ? produced : toList(evidence.uiBindingFindings)
    for (const item of bindingFindings) {
      if (!item) continue
      const rawCode = item.code || 'UI_BINDING_INVALID'
      if (item.severity === 'warning' || ADVISORY_CODES.has(rawCode)) {
        // An advisory whose code lane E has never seen still yields the full triple.
        const code = DOD_CODE_CONTRACT[rawCode] ? rawCode : 'UI_BINDING_ADVISORY'
        advisories.push(advisory(S3, code, item.message || `UI 绑定告警（${rawCode}）`, { detail: item }))
        continue
      }
      failures.push(
        finding(S3, 'UI_BINDING_INVALID', item.message || `UI 事件绑定校验失败（${rawCode}）`, {
          detail: { upstreamCode: rawCode, ...item },
          node: item.node ?? item.nodeName,
          event: item.event,
        }),
      )
    }
    return { failures, advisories }
  },
}

const S4 = {
  id: 'S4-no-sensitive-strings',
  group: 'static',
  title: '无敏感串（对齐引擎发布规则）',
  requires: ['scripts'],
  source: 'apps/local-engine/src/project-manager.js:63-73/249-261（同一组正则在发布/导出时打死整张图）',
  check({ scripts, evidence }) {
    const failures = []
    const texts = []
    for (const [index, script] of toList(scripts).entries()) {
      if (typeof script.content === 'string') {
        texts.push({ label: script.name || script.entry || `scripts[${index}]`, content: script.content })
      }
    }
    for (const row of toList(evidence.textAssets)) {
      if (row && typeof row.content === 'string') texts.push({ label: row.name || 'textAssets', content: row.content })
    }
    for (const { label, content } of texts) {
      for (const hit of scanSensitiveContent(content)) {
        failures.push(finding(S4, hit.code, `${label}：${hit.message}`, { script: label }))
      }
    }
    return { failures, advisories: [] }
  },
}

const R1 = {
  id: 'R1-entry-contract',
  group: 'runtime',
  title: '进图冒烟契约（入口 SSR 不被 notFound/重定向）',
  requires: ['entry'],
  source: 'apps/game/pages/p/[gameName]/index.tsx:55-68 + apps/local-engine/src/play-library.js:424-436',
  check({ evidence }) {
    const failures = []
    const entry = evidence.entry || {}
    if (entry.notFound === true) {
      failures.push(finding(R1, 'ENTRY_NOT_FOUND', `进图返回 notFound（gameName=${entry.gameName ?? '?'}）。`, { detail: entry }))
    }
    if (entry.playEnabled === false) {
      failures.push(finding(R1, 'ENTRY_PLAY_DISABLED', `该图 playEnabled=false，index.tsx:63 直接 notFound。`, { detail: entry }))
    }
    if (entry.redirected === true) {
      failures.push(finding(R1, 'ENTRY_AUTH_REDIRECT', `被重定向到玩家登录（destination=${entry.redirectTo ?? 'playerLoginURL'}）。`, { detail: entry }))
    }
    const status = entry.httpStatus ?? entry.status
    if (typeof status === 'number' && (status < 200 || status >= 300)) {
      failures.push(finding(R1, 'ENTRY_BAD_STATUS', `入口 HTTP ${status}。`, { detail: entry }))
    }
    return { failures, advisories: [] }
  },
}

const R2 = {
  id: 'R2-ws-session-survives',
  group: 'runtime',
  title: 'WS 会话存活（无 kick NoAuth=5 / 无 1005 无码 close）',
  requires: ['ws'],
  source: 'internals/schema/types/game.ts:1-10（CloseType.NoAuth=5）、services/game-server/src/index.ts:366、edit/replica/replica-server.ts:1391、box3-re/scan/O15-ws-disconnect.md:10',
  check({ evidence, options }) {
    const failures = []
    const ws = evidence.ws || {}
    if (ws.connected !== true) {
      failures.push(finding(R2, 'WS_SESSION_NOT_CONNECTED', 'WS 从未建立（connected!==true）：冒烟没跑起来。', { detail: ws }))
      return { failures, advisories: [] }
    }
    const kick = typeof ws.kickCode === 'number' ? ws.kickCode : undefined
    if (kick === CLOSE_TYPE.NoAuth) {
      failures.push(finding(R2, 'WS_KICK_NO_AUTH', `服务端 kickSession(CloseType.NoAuth=5)：sid=${ws.sessionId ?? '?'}。`, { detail: ws }))
    } else if (typeof kick === 'number' && kick !== CLOSE_TYPE.Normal) {
      failures.push(finding(R2, 'WS_KICKED', `服务端主动踢会话，CloseType=${kick}。`, { detail: ws }))
    }
    const clientInitiated = ws.clientInitiatedClose === true || ws.probeClosed === true
    if (typeof ws.closeCode === 'number' && ws.closeCode !== 1000 && ws.closeCode !== 1001) {
      if (ws.closeCode === 1005 && clientInitiated) {
        /* 1005 by the probe itself is O15's known-benign second reading (O15:179). */
      } else if (FATAL_WS_CLOSE_CODES.has(ws.closeCode)) {
        const code = ws.closeCode === 1005 ? 'WS_CLOSE_1005' : 'WS_ABNORMAL_CLOSE'
        failures.push(
          finding(R2, code, `close code=${ws.closeCode} / reason="${ws.closeReason ?? ''}" / wasClean=${ws.wasClean === true}。`, {
            detail: ws,
          }),
        )
      }
    }
    const minAlive = typeof options.minSessionAliveMs === 'number' ? options.minSessionAliveMs : 3000
    if (typeof ws.aliveMs === 'number' && ws.aliveMs < minAlive && !clientInitiated) {
      failures.push(finding(R2, 'WS_SESSION_TOO_SHORT', `会话只活了 ${ws.aliveMs} ms（阈值 ${minAlive} ms）。`, { detail: ws, minAliveMs: minAlive }))
    }
    if (ws.enteredWorld !== undefined && ws.enteredWorld !== true) {
      failures.push(finding(R2, 'WS_NO_WORLD_ENTRY', '会话连着但没到"进图"里程碑：等于没玩到这张图。', { detail: ws }))
    }
    return { failures, advisories: [] }
  },
}

const R3 = {
  id: 'R3-runtime-events-tail-clean',
  group: 'runtime',
  title: 'runtime 事件尾部无致命错（复用 acceptance.judgeEvents）',
  requires: ['runtimeEvents'],
  source: 'services/game-server/src/edit/debugger/debugger-server.ts:8-11 + edit/creator-preview-runtime.ts:8-19',
  check({ evidence }) {
    const failures = []
    const events = toList(evidence.runtimeEvents)
    // judgeEvents already refuses to call an empty window a pass — reuse it, do not re-lawyer it.
    const sinceId = evidence.sinceEventId ?? evidence.sinceId
    const verdict = judgeEvents(events, { sinceId })
    if (verdict.passed !== true) {
      for (const item of verdict.findings) {
        const code = DOD_CODE_CONTRACT[item.code] ? item.code : 'RUNTIME_EXCEPTION'
        failures.push(
          finding(R3, code, item.message || `运行期事件判定为 ${verdict.verdict}`, {
            detail: { verdict: verdict.verdict, eventId: item.eventId, side: item.side, locations: item.locations, upstreamCode: item.code },
          }),
        )
      }
    }
    const status = evidence.runtimeStatus
    if (status && status.running === false) {
      failures.push(finding(R3, 'RUNTIME_IDLE', `预览运行时 phase=${status.phase ?? '?'} 且 running=false：V2 回路无法取证。`, { detail: status }))
    }
    return { failures, advisories: [] }
  },
}

const R4 = {
  id: 'R4-no-save-while-preview-running',
  group: 'runtime',
  title: '预览中禁止 save（硬失败）',
  requires: ['saves|preview.running'],
  source: 'services/game-server/src/edit/replica/replica-server.ts:1600-1603（预览在跑时不记录 voxel chunk hash ⇒ 存了就是丢地形）',
  check({ evidence }) {
    const failures = []
    const saves = toList(evidence.saves)
    const terrainWritten = evidence.terrainWritten === true || toList(evidence.writes).some((row) => /^terrain_/.test(String(row && row.tool)))
    if (!saves.length) {
      failures.push(finding(R4, 'EVIDENCE_MISSING', '没有任何 map_save 记账：无法判断"写后是否落盘"，更无法判断落盘时预览是否停着。', { detail: { needed: 'evidence.saves[]' } }))
      return { failures, advisories: [] }
    }
    for (const [index, save] of saves.entries()) {
      const running = save.previewRunning === true || (save.previewRunning === undefined && save.phase === 'running')
      if (running) {
        failures.push(
          finding(R4, 'SAVE_WHILE_PREVIEW_RUNNING', `第 ${index + 1} 次 map_save 发生在预览运行期间：这一存不会记录 voxel chunk hash（replica-server.ts:1600-1603）。`, {
            detail: save,
          }),
        )
      }
      if (save.forced === true) {
        failures.push(
          finding(R4, 'SAVE_FORCE_USED', `第 ${index + 1} 次 map_save 用了 force:true：明知预览在跑仍强存，地形改动静默丢失。`, { detail: save }),
        )
      }
    }
    if (terrainWritten) {
      const clean = saves.some((save) => save.ok === true && save.previewRunning === false && save.forced !== true)
      if (!clean) {
        failures.push(
          finding(R4, 'TERRAIN_NOT_PERSISTED', '本次作业写过地形（terrain_apply/terrain_revert），却没有任何"预览已停"的成功保存：盘上地形仍是旧值。', {
            detail: { saves },
          }),
        )
      }
    }
    return { failures, advisories: [] }
  },
}

const B1 = {
  id: 'B1-prewrite-token-captured',
  group: 'rollback',
  title: 'save/写前必须拿到 revision 或 headHash',
  requires: ['writes'],
  source: 'src/tools/_shared.js:523-566 requireClientRevision + src/local-store.js:114-141 readRevision().headHash',
  check({ writes }) {
    const failures = []
    for (const [index, row] of writes.entries()) {
      const label = row.tool || row.target || `writes[${index}]`
      const before = row.before || {}
      const token = before.revision ?? before.headHash ?? before.content ?? before.scriptContent ?? before.tree
      if (token === undefined || token === null || token === '') {
        failures.push(
          finding(B1, 'PREWRITE_TOKEN_MISSING', `${label} 写前没有留 revision/headHash：没有回滚物料，也没有乐观锁。`, {
            detail: row,
          }),
        )
      }
    }
    return { failures, advisories: [] }
  },
}

const B2 = {
  id: 'B2-rollback-confirmed-and-readable',
  group: 'rollback',
  title: '失败必须回滚，且回滚后必须能读回',
  requires: ['writes'],
  source: 'src/tools/ui.js:216-252（mid-batch 失败用 uiNodeRemove 回滚并回报 rolledBack）',
  check({ writes }) {
    const failures = []
    for (const [index, row] of writes.entries()) {
      if (row.ok === true) continue
      const label = row.tool || row.target || `writes[${index}]`
      if (row.rolledBack !== true) {
        failures.push(
          finding(B2, 'WRITE_NOT_ROLLED_BACK', `${label} 失败后没有回滚确认：图里留着半成品（或残留 orphanIds）。`, {
            detail: { tool: label, orphanIds: row.rollback && row.rollback.orphanIds, error: row.error },
          }),
        )
        continue
      }
      const readback = row.readback ?? (row.rollback && row.rollback.readback)
      if (!readback || (typeof readback === 'object' && !Object.keys(readback).length)) {
        failures.push(
          finding(B2, 'ROLLBACK_READBACK_MISSING', `${label} 声称已回滚，却没有读回证据（script_read / ui_tree_read / terrain_info / map_revision 之一）。`, {
            detail: row,
          }),
        )
      }
    }
    return { failures, advisories: [] }
  },
}

const B3 = {
  id: 'B3-revision-conflict-is-retryable',
  group: 'rollback',
  title: '乐观锁冲突必须是可重试错误，而不是未知失败',
  requires: ['writes'],
  source: 'src/errors.js REVISION_CONFLICT{retryable:true} + services/game-server/src/edit/ai/map-authoring-tools.ts:404-411（引擎 409 带 code）',
  check({ writes }) {
    const failures = []
    for (const [index, row] of writes.entries()) {
      const error = row.error
      if (!error) continue
      const label = row.tool || row.target || `writes[${index}]`
      const looksLikeConflict =
        error.code === 'REVISION_CONFLICT' ||
        error.code === 'EXPECTED_REVISION_REQUIRED' ||
        error.status === 409 ||
        Boolean(error.detail && (error.detail.currentRevision || error.detail.expectedRevision || error.detail.revisionAuthority)) ||
        /revision|乐观锁|\bCAS\b|conflict|409/i.test(String(error.message || ''))
      if (!looksLikeConflict) {
        if (!error.code || typeof error.retryable !== 'boolean' || !error.hint) {
          failures.push(
            finding(B3, 'ERROR_CONTRACT_INCOMPLETE', `${label} 的错误缺 {code, retryable, hint} 三件套（code=${error.code ?? '无'}）。`, {
              detail: error,
            }),
          )
        }
        continue
      }
      // The authoritative classification is errors.js, and flattening into TOOL_FAILED is the failure mode.
      if (error.code === 'TOOL_FAILED' || !error.code) {
        failures.push(
          finding(B3, 'CONFLICT_NOT_RETRYABLE', `${label} 的乐观锁冲突被塌成了 TOOL_FAILED：模型收到的将是"未知失败"而不是"重取 revision 再试"。`, {
            detail: error,
          }),
        )
        continue
      }
      const authoritative = isRetryable(error.code)
      if (error.retryable !== true || authoritative !== true) {
        failures.push(
          finding(B3, 'CONFLICT_NOT_RETRYABLE', `${label}：code=${error.code} 的 retryable=${JSON.stringify(error.retryable)}，而错误表认定 ${JSON.stringify(authoritative)}。`, {
            detail: { error, authoritative },
          }),
        )
      }
      if (!error.hint) {
        failures.push(finding(B3, 'ERROR_CONTRACT_INCOMPLETE', `${label}：冲突码 ${error.code} 没带 hint。`, { detail: error }))
      }
    }
    return { failures, advisories: [] }
  },
}

const B4 = {
  id: 'B4-head-hash-chain-monotonic',
  group: 'rollback',
  title: '版本链只增：save 后 headHash 必须推进，回滚后必须回到写前值',
  requires: ['revisionChain.before.headHash|revisionChain.after.headHash'],
  source: 'src/local-store.js:114-141（project-state.json → permissionHash → branches[current].headHash）',
  check({ evidence }) {
    const failures = []
    const chain = evidence.revisionChain || {}
    const before = chain.before && chain.before.headHash
    const after = chain.after && chain.after.headHash
    if (!before || !after) {
      failures.push(
        finding(B4, 'HEAD_HASH_UNREADABLE', `读不全版本头：before=${before ?? '缺'} after=${after ?? '缺'}。`, { detail: chain }),
      )
      return { failures, advisories: [] }
    }
    const saves = toList(evidence.saves)
    const changedSomething = saves.some((save) => save.ok === true) || toList(evidence.writes).some((row) => row.ok === true)
    if (before === after && changedSomething && chain.noChangeDeclared !== true) {
      failures.push(
        finding(B4, 'HEAD_HASH_NOT_ADVANCED', `写/保存声称成功，但 headHash 仍是 ${before}：改动没进盘。`, { detail: chain }),
      )
    }
    const rolledBack = chain.rolledBackReadback && chain.rolledBackReadback.headHash
    if (rolledBack && rolledBack !== before) {
      failures.push(
        finding(B4, 'ROLLBACK_HASH_MISMATCH', `回滚后读回头是 ${rolledBack}，写前是 ${before}：回滚没有把工程放回写前位置。`, {
          detail: { before, rolledBack },
        }),
      )
    }
    return { failures, advisories: [] }
  },
}

const K1 = {
  id: 'K1-legacy-map-bytes-unchanged',
  group: 'compat',
  title: '旧图读回逐字节不变（additive 判定）',
  requires: ['legacyReadback'],
  source: 'box3-re/plan/N7-ai-adaptation-decisions.md C/E 行的兼容性红线：旧图 uiTree/属性读回必须逐字节不变',
  check({ legacyReadback }) {
    const failures = []
    for (const [index, row] of legacyReadback.entries()) {
      const label = row.name || row.mapId || `legacyReadback[${index}]`
      if (!row.digestBefore) {
        failures.push(finding(K1, 'LEGACY_READBACK_UNAVAILABLE', `${label} 没有写前摘要：无"逐字节不变"的证据可言。`, { detail: row }))
        continue
      }
      if (!row.digestAfter) {
        failures.push(finding(K1, 'LEGACY_READBACK_UNAVAILABLE', `${label} 没有写后摘要。`, { detail: row }))
        continue
      }
      if (String(row.digestBefore) !== String(row.digestAfter)) {
        failures.push(
          finding(K1, 'LEGACY_MAP_BYTES_CHANGED', `${label} 读回摘要变了：${row.digestBefore} → ${row.digestAfter}。`, {
            detail: { ...row, declared: row.declaredChange === true },
          }),
        )
      }
    }
    return { failures, advisories: [] }
  },
}

const K2 = {
  id: 'K2-custom-properties-preserved',
  group: 'compat',
  title: '自定义属性不丢（真实图上有 86 个未声明键）',
  requires: ['customProperties.before|customProperties.after|customProperties.beforeCount|customProperties.afterCount'],
  source: 'apps/local-engine/src/project-manager.js（未声明键全透传）+ N7 兼容性红线',
  check({ evidence }) {
    const failures = []
    const cp = evidence.customProperties || {}
    const beforeNames = toList(cp.before).map(String)
    const afterNames = toList(cp.after).map(String)
    if (beforeNames.length || afterNames.length) {
      const { removed } = compareSurface(beforeNames, afterNames)
      if (removed.length) {
        failures.push(
          finding(K2, 'CUSTOM_PROPERTY_DROPPED', `丢了 ${removed.length} 个未声明自定义属性：${removed.slice(0, 12).join(', ')}${removed.length > 12 ? ' …' : ''}。`, {
            detail: { lost: removed, beforeCount: beforeNames.length, afterCount: afterNames.length },
          }),
        )
      }
    } else if (typeof cp.beforeCount === 'number' || typeof cp.afterCount === 'number') {
      if (typeof cp.beforeCount === 'number' && typeof cp.afterCount === 'number' && cp.afterCount < cp.beforeCount) {
        failures.push(
          finding(K2, 'CUSTOM_PROPERTY_COUNT_SHRANK', `自定义属性数量 ${cp.beforeCount} → ${cp.afterCount}。`, { detail: cp }),
        )
      }
    } else {
      failures.push(finding(K2, 'EVIDENCE_MISSING', '既没有逐键名单也没有计数：无法判定自定义属性是否保住。', { detail: cp }))
    }
    return { failures, advisories: [] }
  },
}

const K3 = {
  id: 'K3-no-freeze-seal-narrowing',
  group: 'compat',
  title: '禁 freeze/seal、注入面只允许增长',
  requires: ['injection'],
  source: 'N7 兼容性红线：注入对象一旦被 freeze/seal，带 86 个自定义属性的真实地图立刻静默失效',
  check({ evidence }) {
    const failures = []
    const injection = evidence.injection || {}
    if (injection.frozen === true) {
      failures.push(finding(K3, 'INJECTION_FROZEN', `注入对象被 Object.freeze（${injection.target || 'world/global'}）。`, { detail: injection }))
    }
    if (injection.sealed === true) {
      failures.push(finding(K3, 'INJECTION_SEALED', `注入对象被 Object.seal（${injection.target || 'world/global'}）：新键写不进去。`, { detail: injection }))
    }
    const surface = compareSurface(toList(injection.surfaceBefore), toList(injection.surfaceAfter))
    if (injection.surfaceAfter != null && !surface.superset) {
      failures.push(
        finding(K3, 'INJECTION_SURFACE_NARROWED', `注入面缩小了 ${surface.removed.length} 个成员：${surface.removed.slice(0, 12).join(', ')}。`, {
          detail: { removed: surface.removed, added: surface.added.length },
        }),
      )
    }
    return { failures, advisories: [] }
  },
}

const K4 = {
  id: 'K4-surface-growth-only',
  group: 'compat',
  title: '对外面只允许超集（tools/list、声明、契约）',
  requires: ['toolsList.before|toolsList.after'],
  source: 'src/tools/index.js mergeToolSets（重名即抛）+ 主控 A 泳道 12→37 的增长事实',
  check({ evidence }) {
    const failures = []
    const tools = evidence.toolsList || {}
    const surface = compareSurface(toList(tools.before), toList(tools.after))
    if (!toList(tools.after).length) {
      failures.push(finding(K4, 'EVIDENCE_MISSING', '没有 tools/list 的当前名单：无法判定面是否缩小。', { detail: tools }))
      return { failures, advisories: [] }
    }
    if (!surface.superset) {
      failures.push(
        finding(K4, 'ADVERTISED_TOOL_REMOVED', `对外面少了 ${surface.removed.length} 个名字：${surface.removed.join(', ')}。`, {
          detail: { removed: surface.removed, addedCount: surface.added.length, before: surface.beforeCount, after: surface.afterCount },
        }),
      )
    }
    return { failures, advisories: [] }
  },
}

export const PROTECTED_PLAY_FIELDS = ['name', 'author', 'description', 'cover', 'loadingCover']

const K5 = {
  id: 'K5-entry-contract-and-protected-fields-untouched',
  group: 'compat',
  title: '进图契约与受保护元数据不许动',
  requires: ['writeTouches|entryContract'],
  source: 'apps/game/server/play-admin.ts:858-859 protectedFields + apps/game/pages/p/[gameName]/index.tsx:55-68 + apps/local-engine/src/play-library.js:424-436',
  check({ evidence }) {
    const failures = []
    const protectedFields = [...PROTECTED_PLAY_FIELDS, ...toList(evidence.extraProtectedFields).map(String)]
    for (const [index, touch] of toList(evidence.writeTouches).entries()) {
      const row = typeof touch === 'string' ? { path: touch } : touch || {}
      if (row.kind === 'read' || row.readOnly === true) continue
      const path = String(row.path || row.field || row.key || '')
      const last = path.split('/').filter(Boolean).pop() || path
      const hit = protectedFields.find((field) => last === field || path.endsWith(`.${field}`) || path.endsWith(`/${field}`))
      if (hit) {
        failures.push(
          finding(K5, 'PROTECTED_FIELD_TOUCHED', `${row.tool || `writeTouches[${index}]`} 触碰了受保护元数据字段 "${hit}"（play-admin.ts:858）。`, {
            detail: { path, rule: row.rule || 'write', ...row },
          }),
        )
      }
    }
    const contract = evidence.entryContract || {}
    if (contract.modified === true) {
      failures.push(
        finding(K5, 'ENTRY_CONTRACT_MODIFIED', `进图契约被改动：${(contract.files || []).join(', ') || '未声明文件'}。`, { detail: contract }),
      )
    }
    return { failures, advisories: [] }
  },
}

export const DOD_RULES = [S1, S2, S3, S4, R1, R2, R3, R4, B1, B2, B3, B4, K1, K2, K3, K4, K5]

/** ---------------------------------------------------------------- evaluator ---------------------------------------------------------------- */

/**
 * Run the gates. Async only because rule `S1` may invoke the real syntax gate;
 * pass precomputed `scripts[].check` and it is a pure synchronous-in-practice call.
 * @param {object} evidence see the shape documented in this file's header + O26 doc
 * @param {{groups?:string[], blockingCodes?:string[], uiReferencePatterns?:Array,
 *   uiBindingValidator?:(arg:object)=>Array, runScriptGate?:(script:object, options:object)=>Promise|object,
 *   typegateConfig?:object, scriptMode?:string, minSessionAliveMs?:number, ruleOverrides?:object}} [options]
 */
export async function evaluateDoD(evidence = {}, options = {}) {
  const groups = toList(options.groups).length ? toList(options.groups) : DOD_GROUPS
  const rules = DOD_RULES.filter((rule) => groups.includes(rule.group))
  const gates = []
  const failures = []
  const advisories = []
  const advisoriesByCode = Object.create(null)

  for (const rule of rules) {
    const override = (options.ruleOverrides && options.ruleOverrides[rule.id]) || {}
    const requires = override.requires || rule.requires || []
    const missing = missingEvidence(evidence, requires)
    const scoped = {
      evidence,
      options: { ...options, ...override },
      scripts: toList(evidence.scripts),
      writes: toList(evidence.writes),
      saves: toList(evidence.saves),
      legacyReadback: toList(evidence.legacyReadback),
    }
    let result = { failures: [], advisories: [] }
    if (missing.length) {
      result.failures.push(
        finding(rule, 'EVIDENCE_MISSING', `规则 "${rule.id}" 缺少证据：${missing.join(', ')}。缺证据判 fail，不判通过。`, {
          detail: { missing },
        }),
      )
    } else {
      result = (await rule.check(scoped)) || result
    }
    const blocking = result.failures.filter((item) => item.severity === 'error')
    if (blocking.length === 0 && result.advisories.length === 0 && !missing.length) {
      gates.push({ id: rule.id, group: rule.group, title: rule.title, status: 'pass', source: rule.source, findings: [] })
      continue
    }
    gates.push({
      id: rule.id,
      group: rule.group,
      title: rule.title,
      status: blocking.length ? 'fail' : 'warn',
      source: rule.source,
      findings: [...blocking, ...result.advisories],
    })
    failures.push(...blocking)
    for (const item of result.advisories) {
      advisories.push(item)
      advisoriesByCode[item.code] = (advisoriesByCode[item.code] || 0) + 1
    }
  }

  const byGroup = {}
  for (const group of groups) {
    const rows = gates.filter((gate) => gate.group === group)
    byGroup[group] = {
      rules: rows.length,
      failed: rows.filter((gate) => gate.status === 'fail').length,
      warned: rows.filter((gate) => gate.status === 'warn').length,
      passed: rows.filter((gate) => gate.status === 'pass').length,
    }
  }
  const dangling = failures
    .filter((item) => item.code === 'UI_REFERENCE_DANGLING')
    .flatMap((item) => (item.detail && item.detail.dangling) || [])

  const report = {
    version: DOD_VERSION,
    verdict: failures.length ? 'FAIL' : 'PASS',
    passed: failures.length === 0,
    mapId: evidence.mapId,
    rulesRun: gates.length,
    groups: byGroup,
    gates,
    failures,
    advisories,
    advisoriesByCode,
    // Surfaced on its own because lane E's acceptance criterion is exactly this phrase:
    // "UI 引用悬空即红".
    uiDangling: dangling,
    blockingRuleIds: gates.filter((gate) => gate.status === 'fail').map((gate) => gate.id),
    next: nextAdvice(gates, failures),
  }
  verifyErrorContract(report)
  return report
}

function nextAdvice(gates, failures) {
  if (!failures.length) return 'DoD 全绿：可以进 F 泳道端到端 demo。'
  const first = failures[0]
  const failedGroups = [...new Set(gates.filter((gate) => gate.status === 'fail').map((gate) => gate.group))]
  return `fail 组：${failedGroups.join(' / ')}；先看第一条 ${first.ruleId}（${first.code}）：${first.hint}`
}

/**
 * The gate about itself: a failure without the `{code, retryable, hint}` triple,
 * or with a code no table knows, is a defect in THIS layer and must not be able
 * to masquerade as a verdict. Throws instead of reporting.
 */
export function verifyErrorContract(report) {
  const known = new Set([...Object.keys(DOD_CODE_CONTRACT), ...CONTRACT_CODES])
  for (const item of [...report.failures, ...report.advisories]) {
    const problems = []
    if (typeof item.code !== 'string' || !item.code) problems.push('缺 code')
    else if (!known.has(item.code)) problems.push(`未登记的码 ${item.code}`)
    if (typeof item.retryable !== 'boolean') problems.push('缺 retryable')
    if (typeof item.hint !== 'string' || item.hint.length < 8) problems.push('hint 太空')
    if (typeof item.ruleId !== 'string') problems.push('缺 ruleId')
    if (problems.length) {
      throw new Error(`DoD 错误契约破坏（${item.ruleId || '?'} / ${item.code || '?'}）：${problems.join('，')}`)
    }
    if (item.severity === 'warning' && !ADVISORY_CODES.has(item.code)) {
      throw new Error(`DoD 分类漂移：warning 级却用了非告警码 ${item.code}`)
    }
  }
  return report
}

/** The wire-shaped error for a failing DoD (what main control should hand the model). */
export function firstFailurePayload(report) {
  const first = report.failures[0]
  if (!first) return undefined
  return {
    code: first.code,
    retryable: first.retryable,
    hint: first.hint,
    message: `${first.ruleId}：本次 DoD 判定为 fail（共 ${report.failures.length} 条阻塞项）。${first.message}`,
    detail: { ruleId: first.ruleId, group: first.group, ...first.detail },
  }
}

export function summarize(report) {
  return {
    verdict: report.verdict,
    rulesRun: report.rulesRun,
    failures: report.failures.length,
    advisories: report.advisories.length,
    groups: report.groups,
  }
}

export function dodRuleIndex() {
  const index = {}
  for (const rule of DOD_RULES) {
    index[rule.group] = index[rule.group] || []
    index[rule.group].push({ id: rule.id, title: rule.title, requires: rule.requires, source: rule.source })
  }
  return index
}

/** ---------------------------------------------------------------- playbook ---------------------------------------------------------------- */

/**
 * THE FIXED ACTION SEQUENCE for an AI doing map work with this MCP. Twelve
 * steps, each naming the tool it runs and the error code it reads when it
 * fails. `skippable:false` steps are the ones whose omission silently breaks
 * the result (preview ordering, pre-write token, read-back proof).
 * Lane F copies this verbatim; `auditPlaybook()` below is the machine check
 * that the copy still honours the hard ordering.
 */
export const PLAYBOOK = {
  title: 'BOX3 地图 AI 作业规程（E 泳道 DoD 版）',
  steps: [
    {
      n: 1,
      action: '读状态：确认这张图能不能被 headless 写、预览在不在跑',
      tool: 'map_status',
      args: '{ mapId }',
      read: 'runtimeActive / preview.running / canPersistTerrain',
      onErrorCode: 'HTTP_502',
      skippable: false,
      why: 'tool.ts:82-92 先探 /__local_runtime/status，runtimeActive=false 时任何写都是 409。',
    },
    {
      n: 2,
      action: '读能力目录：确认这 22 个引擎工具此刻真挂在运行时上',
      tool: 'map_tool_catalog',
      args: '{ mapId }',
      read: 'missing[]',
      onErrorCode: 'ENGINE_TOOL_NOT_MOUNTED',
      skippable: true,
    },
    {
      n: 3,
      action: '取版本令牌：写之前必须拿到盘上 headHash / 内存 revision',
      tool: 'map_revision',
      args: '{ mapId }',
      read: 'headHash（UI 用 ui_tree_read.revision，脚本用 script_read 的 revision）',
      onErrorCode: 'REVISION_SOURCE_UNAVAILABLE',
      skippable: false,
      why: '没有写前令牌 = 没有回滚物料（规则 B1）= 没有乐观锁。',
    },
    {
      n: 4,
      action: '停预览：写之前把实时预览停掉',
      tool: 'map_preview { action:"stop" }',
      args: '{ mapId, action:"stop" }',
      read: 'preview.running=false',
      onErrorCode: 'SAVE_WHILE_PREVIEW_RUNNING',
      skippable: false,
      why: 'replica-server.ts:1600-1603：预览在跑时保存不记录 voxel chunk hash ⇒ 地形静默丢失（规则 R4 硬失败）。',
    },
    {
      n: 5,
      action: '读现状：要改的那块长什么样（逐域）',
      tool: 'ui_tree_read / entity_list / terrain_info / script_list / script_read',
      args: '{ mapId, ... }',
      read: '节点 name/id 清单、实体 id、脚本 revision',
      onErrorCode: 'LOCAL_SCRIPT_NOT_FOUND',
      skippable: true,
    },
    {
      n: 6,
      action: '先过静态门：脚本正文送 typecheck（server=CJS / client=ESM）',
      tool: 'script_typecheck',
      args: '{ side, content, mode:"syntax" }',
      read: 'satisfied / errors / warnings（未声明成员只告警）',
      onErrorCode: 'TYPE_GATE_FAILED',
      skippable: false,
      why: '规则 S1/S2：语法/方言错到这里最便宜；未声明成员必须继续放行（86 个自定义属性）。',
    },
    {
      n: 7,
      action: '写 UI 节点（建脚本要引用的那些名字）',
      tool: 'ui_node_add',
      args: '{ mapId, nodes, expectedRevision }',
      read: 'nodeIds / newRevision（批量必须链式沿用）',
      onErrorCode: 'REVISION_CONFLICT',
      skippable: true,
      why: '顺序很关键：先建节点再写脚本，规则 S3 才不会把新引用判成悬空。',
    },
    {
      n: 8,
      action: '写地形/实体/模型/脚本正文（一次一小步）',
      tool: 'terrain_apply / entity_create / entity_update / model_add_to_project / script_write / script_patch',
      args: '{ mapId, ..., expectedRevision }',
      read: '每步返回的新 revision',
      onErrorCode: 'REVISION_CONFLICT',
      skippable: true,
    },
    {
      n: 9,
      action: '落盘：不带 force 保存（预览此时应已停）',
      tool: 'map_save',
      args: '{ mapId }（不要 force:true）',
      read: 'permissionHash / diskHeadHash',
      onErrorCode: 'SAVE_WHILE_PREVIEW_RUNNING',
      skippable: false,
      why: '不 map_save 就什么都不留；force 会把"存了但丢地形"变成静默事故（规则 R4）。',
    },
    {
      n: 10,
      action: '起预览：进入可取证状态',
      tool: 'map_preview { action:"start" }',
      args: '{ mapId, action:"start" }',
      read: 'preview.running=true',
      onErrorCode: 'RUNTIME_IDLE',
      skippable: false,
      why: '自检与冒烟都要读运行期事件，预览没跑就没有证据（规则 R3 把空事件窗判 fail）。',
    },
    {
      n: 11,
      action: '自检 DoD：把本次读数交给静态/运行/回滚/兼容四组门',
      tool: 'evaluateDoD（src/dod.js；主控以 map_dod_report 工具暴露）',
      args: '{ mapId, scripts, uiTree, entry, ws, runtimeEvents, saves, writes, revisionChain, legacyReadback, customProperties, injection, toolsList, writeTouches }',
      read: 'verdict / failures[] / uiDangling[]',
      onErrorCode: 'UI_REFERENCE_DANGLING',
      skippable: false,
    },
    {
      n: 12,
      action: '冒烟：进图一次，读事件尾，确认会话活着且无异常',
      tool: 'runtime_events_tail（+ 播放侧进图探针记录 entry/ws 读数）',
      args: '{ mapId, sinceEventId, limit }',
      read: 'exceptions / close code ≠ 1005 / kick ≠ 5',
      onErrorCode: 'WS_KICK_NO_AUTH',
      skippable: false,
      why: 'O15：kickSession 之后是无码 close ⇒ 浏览器 1005/wasClean=true，看起来"干净"其实是被踢。',
    },
  ],
}

export const PLAYBOOK_UNSKIPPABLE = PLAYBOOK.steps.filter((step) => step.skippable === false).map((step) => step.n)

/**
 * Machine check OF the playbook, so lane F cannot copy a softened version:
 *  - the hard ordering 停预览(4) → 写(7/8) → save(9) → 起预览(10) → 自检(11) → 冒烟(12)
 *  - every unskippable step still names a tool, and still names an error code
 *  - save never precedes stop-preview, start-preview never precedes save
 * @returns {Array<{code:string, message:string, detail:object}>} empty means the playbook itself passes
 */
export function auditPlaybook(steps = PLAYBOOK.steps) {
  const findings = []
  const indexOf = (needle) => {
    const found = steps.find((step) => step.tool.includes(needle) || step.action.includes(needle))
    return found ? found.n : -1
  }
  const stop = indexOf('action:"stop"')
  const save = indexOf('map_save')
  const start = indexOf('action:"start"')
  const dod = indexOf('evaluateDoD')
  const smoke = indexOf('runtime_events_tail')
  const order = [['停预览', stop], ['map_save', save], ['起预览', start], ['自检 DoD', dod], ['冒烟', smoke]]
  const missing = order.filter(([, n]) => n < 0).map(([label]) => label)
  if (missing.length) {
    findings.push({
      code: 'PLAYBOOK_ORDER_INVALID',
      message: `playbook 缺关键步骤：${missing.join(' / ')}。`,
      detail: { missing },
    })
  }
  const bad = []
  if (stop >= 0 && save >= 0 && stop > save) bad.push('map_save 之前必须先 map_preview stop')
  if (save >= 0 && start >= 0 && start < save) bad.push('map_preview start 不能早于 map_save')
  if (dod >= 0 && smoke >= 0 && dod > smoke) bad.push('自检 DoD 必须早于冒烟收工')
  if (bad.length) {
    findings.push({ code: 'PLAYBOOK_ORDER_INVALID', message: bad.join('；'), detail: { bad } })
  }
  for (const step of steps) {
    if (step.skippable === false && (!step.tool || !step.onErrorCode)) {
      findings.push({
        code: 'PLAYBOOK_ORDER_INVALID',
        message: `步骤 ${step.n} 不可跳，却没写工具名或错误码。`,
        detail: { n: step.n },
      })
    }
  }
  return findings
}
