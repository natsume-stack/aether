/**
 * ui-binding.js — the read-only consistency gate for "UI node <-> script event
 * binding" (lane C, plan/N7 决策 2).
 *
 * WHAT A BINDING ACTUALLY IS, per the source (no new model invented here):
 *   - The event names are the script-API event maps:
 *     packages/script-api/src/client/modules/ui.ts:16-28
 *       UiNodeEvents  = { pointerdown, pointerup }
 *       UiInputEvents = UiNodeEvents & { focus, blur }
 *       UiImageEvents = UiNodeEvents & { load }
 *     the emitter is `events: EventEmitter<UiNodeEvents>` (ui.ts:45) and the
 *     attach API is `on/once/add/remove/off/removeAll`
 *     (packages/script-api/src/client/modules/events.ts:10-63).
 *   - A node is reached BY NAME, never by id: `findChildByName` is declared on
 *     the base node (ui.ts:41) and the documented idiom is
 *     `ui.findChildByName('rendering3d').events.on('pointerdown', ...)`
 *     (packages/script-api/src/client/modules/world.ts:15-19).
 *   - `pointerEventBehavior` (ui.ts:65) is assigned at RUNTIME from the
 *     PointerEventBehavior enum; the persisted schema deliberately does NOT
 *     carry it -- internals/schema/project/ui-rda/defs.ts:816 says
 *     "TODO 暂时不放入UITreeNode中，目前并未提供相关的编辑项", and :818 is the enum.
 *   - THEREFORE: no declarative "bindings" field exists anywhere in the UI RDA
 *     schema (a grep over internals/schema/project finds exactly one
 *     event-related symbol, PointerEventBehavior, and it is not in the tree).
 *     The binding relationship lives in CLIENT SCRIPT TEXT and nowhere else, so
 *     this gate cross-checks script text against the tree instead of writing a
 *     new shape. Adding one would be the schema change 决策 2 forbids.
 *   - Script assets are addressed by side + entry (src/script-write.js:28-58,
 *     map-local entries `index.js` / `clientIndex.js`) and by relative import
 *     specifiers inside script text. `ui` exists only in the client module set
 *     (packages/script-api/src/server/modules has no findChildByName), so a UI
 *     binding in a server script is always a bug.
 *
 * ERROR CONTRACT (same shape as src/errors.js and the WriteGuardError in
 * src/tools/_shared.js, but deliberately NOT imported: this is a zero-dependency
 * pure module so any lane can wire it without pulling the guard layer):
 *   every problem is { code, retryable, hint, ...context }.
 * `retryable` means "re-issue THIS validation after doing the hint", so any
 * finding the caller can fix by editing its own inputs is true; only malformed
 * input -- where re-running unchanged can never help -- is false.
 *
 * THIS FUNCTION DOES NOT WRITE. It never mutates, re-orders, re-keys or
 * re-serialises its input; an old map's uiTree round-trips byte for byte
 * (asserted in test/ui-binding.test.js against the real 61-node production
 * uiTree blob).
 */

/** The five and only five event names a UI node can be bound to (ui.ts:16-28). */
export const UI_EVENT_NAMES = Object.freeze(['pointerdown', 'pointerup', 'focus', 'blur', 'load'])

/**
 * PointerEventBehavior, copied from the declaration layer
 * (internals/schema/project/ui-rda/defs.ts:818-835, which mirrors
 * packages/script-api/src/client/modules/ui.ts:194-211). Member names AND
 * numeric values are both legal spellings in script text; nothing else is.
 */
export const POINTER_EVENT_BEHAVIOR_MEMBERS = Object.freeze({
  DISABLE_AND_BLOCK_PASS_THROUGH: 0,
  DISABLE: 1,
  BLOCK_PASS_THROUGH: 2,
  ENABLE: 3,
})

export const POINTER_EVENT_BEHAVIOR_VALUES = Object.freeze([0, 1, 2, 3])

/** `focus` / `blur` only exist on UiInput, `load` only on UiImage (ui.ts:21-28). */
const EVENT_KIND_REQUIREMENT = Object.freeze({
  focus: 'input',
  blur: 'input',
  load: 'image',
})

/** Element keys the engine union and the MCP add-payload use (defs.ts:768-774, src/tools/ui.js:26). */
const ELEMENT_KEYS = Object.freeze(['box', 'image', 'text', 'scrollBox', 'input'])

/**
 * The rule table. `id` is what tests and the doc cite, `code` is what leaves the
 * process. Kept as data so "every rule has a positive and a negative case" is
 * checkable rather than folklore.
 */
export const BINDING_RULES = Object.freeze([
  { id: 'R1', code: 'UI_BINDING_INPUT_INVALID', severity: 'error', summary: '输入本身不成形（uiTree / scripts / bindings 类型错）' },
  { id: 'R2', code: 'UI_TREE_REF_UNRESOLVED', severity: 'error', summary: '悬空控件：绑定指向的名字在 uiTree 里不存在（或不在其子树里）' },
  { id: 'R3', code: 'UI_EVENT_NAME_INVALID', severity: 'error', summary: '事件名不在 UiEvent 的五个名之内' },
  { id: 'R4', code: 'UI_EVENT_KIND_MISMATCH', severity: 'warning', summary: '事件名合法但节点类型不支持（focus/blur 需 input，load 需 image）' },
  { id: 'R5', code: 'UI_SCRIPT_NOT_FOUND', severity: 'error', summary: '指向不存在的脚本（import 目标 / 绑定声明的 side+entry 不在清单里）' },
  { id: 'R6', code: 'UI_BINDING_DUPLICATE', severity: 'error', summary: '重复绑定：同一脚本对同一控件的同一事件注册两次' },
  { id: 'R7', code: 'UI_POINTER_EVENT_BEHAVIOR_INVALID', severity: 'error', summary: 'PointerEventBehavior 取值非法（成员名不存在，或数字不在 0..3）' },
  { id: 'R8', code: 'UI_NODE_NAME_AMBIGUOUS', severity: 'error', summary: '控件重名：按名字寻址的绑定无法确定命中哪个节点' },
  { id: 'R9', code: 'UI_ORPHAN_NODE', severity: 'error', summary: '孤儿子节点：parentId 指向树里不存在的节点' },
  { id: 'R10', code: 'UI_BINDING_SIDE_INVALID', severity: 'error', summary: '服务端脚本里写 UI 绑定（ui / findChildByName 只在 client 侧存在）' },
])

const RULE_BY_CODE = new Map(BINDING_RULES.map((rule) => [rule.code, rule]))

/** retryable = "按 hint 修完输入再跑一次这次校验是有意义的"。 */
const RETRYABLE_CODES = new Set(
  BINDING_RULES.filter((rule) => rule.code !== 'UI_BINDING_INPUT_INVALID').map((rule) => rule.code),
)

const isString = (value) => typeof value === 'string'

/** The hints name the next tool call, never a feeling (contract of src/errors.js). */
const HINTS = {
  UI_TREE_REF_UNRESOLVED:
    '二选一：用 ui_node_add 把这个名字的控件建出来，或把脚本里的 findChildByName 改成 ui_tree_read 里真实存在的 name。改完重跑本次校验。',
  UI_EVENT_NAME_INVALID:
    'UiEvent 只有 pointerdown / pointerup / focus / blur / load 五个名（packages/script-api/src/client/modules/ui.ts:16-28）。换成其中一个再来，不要发明新事件名。',
  UI_EVENT_KIND_MISMATCH:
    'focus / blur 只在 UiInput 上（ui.ts:21-24），load 只在 UiImage 上（ui.ts:26-28）。要么把控件换成该类型，要么把回调挂到该类型支持的事件上。',
  UI_SCRIPT_NOT_FOUND:
    '先 script_list_runtime 拿真实脚本清单：import 的相对路径要命中其中一个 entry，绑定声明的 side+entry 也要存在。补齐脚本或改掉引用后重跑；新建正文走 script_write。',
  UI_BINDING_DUPLICATE:
    '删掉其中一次注册（同一事件挂两次回调会执行两遍）。确认只保留一处后重跑。',
  UI_POINTER_EVENT_BEHAVIOR_INVALID:
    'PointerEventBehavior 只有 DISABLE_AND_BLOCK_PASS_THROUGH=0 / DISABLE=1 / BLOCK_PASS_THROUGH=2 / ENABLE=3（ui.ts:194-211，defs.ts:818-835）。用这四个成员名或 0-3 的整数再来。',
  UI_NODE_NAME_AMBIGUOUS:
    '绑定是按名字寻址的（ui.ts:41），重名等于命中哪个看运气。先 ui_tree_read 核对这些 id，再把其中一个改成唯一 name（ui_node_add 建新的 + ui_node_remove 删旧的），改完重跑本次校验。',
  UI_ORPHAN_NODE:
    '这个 parentId 在树里不存在，节点挂不上任何父链。用 ui_node_add 建出父节点，或用 ui_node_remove 把这个孤儿连同子孙一起清掉。',
  UI_BINDING_SIDE_INVALID:
    'ui / findChildByName 只存在于 client 模块（packages/script-api/src/client/modules/ui.ts；script-api/src/server/modules 下没有同名 API）。把这段绑定挪到 side:client 的脚本里。',
  UI_BINDING_INPUT_INVALID:
    '校验器需要 { uiTree, scripts }：uiTree 用 ui_tree_read 的返回（{nodes:[...]} 或盘上的 id→node 映射），scripts 用 [{side,entry,content}]，bindings（可选）用 [{nodeId|name,event,script:{side,entry}}]。先把输入补齐再来。',
}

/** screen nodes and the root have no element kind; two persisted shapes exist. */
function elementKindOf(node) {
  const value = node && node.value
  if (!value || typeof value !== 'object') return undefined
  if (value.type === 'screen') return 'screen'
  if (value.type !== 'element') return undefined
  const data = value.data
  if (!data || typeof data !== 'object') return undefined
  // Persisted RDA union: value.data = { type: 'text', data: {...} }
  if (isString(data.type) && ELEMENT_KEYS.includes(data.type)) return data.type
  // MCP add-payload / mock: value.data = { text: {...} }
  for (const key of ELEMENT_KEYS) {
    if (key in data) return key
  }
  return undefined
}

/**
 * Accept every tree shape that exists in the wild WITHOUT normalising the
 * caller's object: the engine `uiTreeRead` result (`{nodes:[...]}`,
 * src/tools/ui.js:98-110), a bare array, or the persisted MuRDATree blob map
 * (`{id: node}`, the on-disk shape).
 */
export function normalizeUiTree(uiTree) {
  const raw = uiTree && typeof uiTree === 'object' ? uiTree : undefined
  if (!raw) return null
  let entries
  if (Array.isArray(raw)) entries = raw.map((node, index) => [String(index), node])
  else if (Array.isArray(raw.nodes)) entries = raw.nodes.map((node, index) => [String(index), node])
  else if (raw.nodes && typeof raw.nodes === 'object') entries = Object.entries(raw.nodes)
  else entries = Object.entries(raw)
  const nodes = []
  for (const [key, node] of entries) {
    if (!node || typeof node !== 'object') continue
    const parentId = typeof node.parentId === 'string' || typeof node.parentId === 'number' ? String(node.parentId) : ''
    nodes.push({
      id: String(node.id ?? key),
      name: isString(node.name) ? node.name : String(node.name ?? ''),
      parentId,
      childrenIds: Array.isArray(node.childrenIds) ? node.childrenIds.map(String) : [],
      kind: elementKindOf(node),
      valueType: node.value && typeof node.value === 'object' ? node.value.type : undefined,
    })
  }
  return nodes
}

/** All ids reachable below `rootId` (childrenIds ∪ reverse parentId edges). */
function descendantIds(nodes, rootId) {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const byParent = new Map()
  for (const node of nodes) {
    if (!node.parentId) continue
    if (!byParent.has(node.parentId)) byParent.set(node.parentId, [])
    byParent.get(node.parentId).push(node)
  }
  const seen = new Set()
  const stack = [rootId]
  while (stack.length) {
    const id = stack.pop()
    const node = byId.get(id)
    if (!node) continue
    const kids = [...node.childrenIds, ...(byParent.get(id) || []).map((kid) => kid.id)]
    for (const kid of kids) {
      if (seen.has(kid)) continue
      seen.add(kid)
      stack.push(kid)
    }
  }
  seen.delete(rootId)
  return seen
}

/**
 * Comment stripping that keeps string / template literals intact, so a
 * `findChildByName` written inside a comment never becomes a binding.
 */
export function stripComments(source) {
  const text = String(source ?? '')
  let out = ''
  let index = 0
  while (index < text.length) {
    const char = text[index]
    const next = text[index + 1]
    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      let removed = ''
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
        // Keep the newlines: a problem must cite the line the author sees in
        // the editor, not the line number left after the comment collapsed.
        if (text[index] === '\n') removed += '\n'
        index += 1
      }
      index += 2
      out += removed
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char
      out += char
      index += 1
      while (index < text.length) {
        if (text[index] === '\\') {
          out += text[index] + (text[index + 1] ?? '')
          index += 2
          continue
        }
        if (text[index] === quote) {
          out += quote
          index += 1
          break
        }
        out += text[index]
        index += 1
      }
      continue
    }
    out += char
    index += 1
  }
  return out
}

/**
 * The receiver of a member access, given the offset of the access itself.
 *
 * Two call sites and both have to work: `.events.on(…)` matches FROM the dot,
 * while `findChildByName(…)` matches FROM the method name and the dot is still
 * behind us. Consuming one optional dot first is what makes
 * `panel.findChildByName('child')` know its receiver at all -- without it every
 * subtree check silently degraded to a whole-tree name lookup.
 */
function receiverBefore(source, position) {
  let index = position - 1
  while (index >= 0 && /\s/.test(source[index])) index -= 1
  if (index >= 0 && source[index] === '.') index -= 1
  while (index >= 0 && /\s/.test(source[index])) index -= 1
  if (index < 0) return { receiver: null, chained: false }
  if (source[index] === ')') return { receiver: null, chained: true }
  const end = index + 1
  while (index >= 0 && /[\w$]/.test(source[index])) index -= 1
  return { receiver: source.slice(index + 1, end) || null, chained: false }
}

function lineOf(source, position) {
  let line = 1
  const limit = Math.min(position, source.length)
  for (let index = 0; index < limit; index += 1) {
    if (source[index] === '\n') line += 1
  }
  return line
}

/**
 * Literal-string regex fragments. Group numbering is load-bearing and is the
 * classic way to get this wrong, so each pattern spells its own backreference
 * index instead of interpolating a shared fragment (a shared `(['"])...` fragment
 * re-numbered every later group and silently made `.events.on('blur')` "capture"
 * the rest of the file). Real map scripts use BOTH 'single' and "double" quoted
 * arguments (`import { ColorList } from "./cilentConfig.js"`), so all three
 * quote forms are accepted.
 */
const FIND_CHILD = /\bfindChildByName\s*\(\s*(["'\x60])((?:\\.|(?!\1)[^\\])*)\1\s*\)/g
const EVENTS_CALL = /\.events\s*\.\s*(on|once|add|remove|off|removeAll)\s*\(\s*(["'\x60])((?:\\.|(?!\2)[^\\])*)\2/g
const DECLARATION = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]*)/g
const BEHAVIOR_MEMBER = /PointerEventBehavior\s*\.\s*([A-Za-z_$][\w$]*)/g
const BEHAVIOR_ASSIGN = /pointerEventBehavior\s*=\s*(-?\d+)\b/g
const IMPORT_FROM = /\bfrom\s*(["'\x60])((?:\\.|(?!\1)[^\\])*)\1/g
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(["'\x60])((?:\\.|(?!\1)[^\\])*)\1\s*\)/g

/**
 * Static scan of one script body: UI node references, event registrations,
 * pointerEventBehavior assignments, script imports.
 *
 * KNOWN LIMITS, stated instead of hidden. This is a regular-expression scan, not
 * an AST parse:
 *   - a node reached through a variable the scanner cannot classify (object
 *     property, function return, destructuring) is invisible to it;
 *   - `findChildByName(<non-literal>)` is skipped;
 *   - the subtree assertion only fires when the receiver is a statically known
 *     UI variable, otherwise the reference is checked against the whole tree.
 * So a clean report is "nothing I could see is broken", never "the map is fine".
 */
export function scanScriptBindings(content) {
  const source = stripComments(content)
  const refs = []
  const registrations = []
  const behaviors = []
  const imports = []
  const uiVars = new Map()

  for (const match of source.matchAll(DECLARATION)) {
    const name = match[1]
    const initializer = match[2]
    const chained = [...initializer.matchAll(FIND_CHILD)]
    if (chained.length) {
      uiVars.set(name, { ref: chained[chained.length - 1][2], absolute: /(^|[^.\w$])ui\s*\./.test(initializer) })
      continue
    }
    if (initializer.trim() === 'ui') {
      uiVars.set(name, { ref: null, absolute: true })
      continue
    }
    // UiNode.clone() returns a UiNode (ui.ts:53) whose name is not statically
    // known -- it is still a UI emitter, so event names on it are checkable.
    if (/\.clone\s*\(\s*\)/.test(initializer)) {
      uiVars.set(name, { ref: null, absolute: false })
    }
  }

  for (const match of source.matchAll(FIND_CHILD)) {
    const position = match.index
    const { receiver, chained } = receiverBefore(source, position)
    const known = receiver ? uiVars.get(receiver) : undefined
    refs.push({
      name: match[2],
      line: lineOf(source, position),
      receiver: chained ? null : receiver,
      // The subtree the search starts in, when we can name it statically.
      scope: known ? known.ref : null,
      scopeKnown: Boolean(known && known.ref),
    })
  }

  for (const match of source.matchAll(EVENTS_CALL)) {
    const position = match.index
    const { receiver, chained } = receiverBefore(source, position)
    let isUi = false
    let subject = null
    const known = receiver ? uiVars.get(receiver) : undefined
    if (receiver === 'ui') {
      isUi = true
    } else if (known) {
      isUi = true
      subject = known.ref
    } else if (receiver) {
      // A recognised NON-UI emitter. The real map does
      // `remoteChannel.events.on('client', ...)`
      // (blob QmVHQfvSjhY6dQdn31xXpou24BXXRrJHcHgsG6j8hmymYd:119), and `client`
      // is not a UiEvent: flagging every `.events.on` as a UI binding would be
      // a false positive against production data, so unknown receivers are
      // left alone rather than assumed to be UI.
      isUi = false
    } else if (chained) {
      // `<expr>.events.on(...)` where <expr> ends in a call: attribute it to the
      // nearest preceding findChildByName(...) inside the same expression.
      const before = source.slice(Math.max(0, position - 200), position)
      const inner = [...before.matchAll(FIND_CHILD)]
      if (inner.length) {
        isUi = true
        subject = inner[inner.length - 1][2]
      }
    }
    registrations.push({
      event: match[3],
      method: match[1],
      line: lineOf(source, position),
      receiver: chained ? null : receiver,
      isUi,
      subject,
    })
  }

  for (const match of source.matchAll(BEHAVIOR_MEMBER)) {
    behaviors.push({ kind: 'member', value: match[1], line: lineOf(source, match.index) })
  }
  for (const match of source.matchAll(BEHAVIOR_ASSIGN)) {
    behaviors.push({ kind: 'number', value: Number(match[1]), line: lineOf(source, match.index) })
  }

  for (const match of source.matchAll(IMPORT_FROM)) imports.push({ specifier: match[2], line: lineOf(source, match.index) })
  for (const match of source.matchAll(DYNAMIC_IMPORT)) imports.push({ specifier: match[2], line: lineOf(source, match.index), dynamic: true })

  return { refs, registrations, behaviors, imports, uiVars }
}

function entryBasename(entry) {
  return String(entry ?? '').replace(/\\/g, '/').split('/').pop()
}

function resolveImport(specifier, knownEntries) {
  const clean = String(specifier).replace(/\\/g, '/').replace(/^\.\//, '')
  if (knownEntries.has(clean)) return true
  if (knownEntries.has(entryBasename(clean))) return true
  if (clean.endsWith('.js') && knownEntries.has(clean.slice(0, -3))) return true
  if (!clean.endsWith('.js') && knownEntries.has(`${clean}.js`)) return true
  return false
}

function problem(code, fields) {
  const rule = RULE_BY_CODE.get(code)
  // The spread goes FIRST so the three contract fields can never be shadowed by
  // a context field of the same name (`severity: undefined` used to overwrite
  // the rule's own value, which turned an error into an unfeltable nothing).
  return {
    ...fields,
    code,
    retryable: fields.retryable === undefined ? RETRYABLE_CODES.has(code) : fields.retryable,
    hint: fields.hint,
    severity: fields.severity || (rule ? rule.severity : 'error'),
    rule: rule ? rule.id : undefined,
    message: fields.message,
  }
}

function finish(problems, checked) {
  const errorCount = problems.filter((item) => item.severity === 'error').length
  const warningCount = problems.length - errorCount
  return { ok: errorCount === 0, errorCount, warningCount, problems, checked }
}

/**
 * The gate. Read-only by construction: every input field is only ever read.
 *
 * @param {object} input
 * @param {unknown} [input.uiTree] ui_tree_read 的返回 / 盘上 id→node 映射 / 节点数组
 * @param {Array<{side?:string, entry?:string, name?:string, content?:string}>} [input.scripts] 脚本清单
 * @param {Array<{nodeId?:string, name?:string, event?:string, script?:{side:string, entry:string}}>} [input.bindings]
 *   待写入的绑定提案。注意现有 schema 里没有能存绑定的字段（defs.ts:816 的 TODO），
 *   所以这一维只是"写脚本正文之前先验一遍"的门，不回写任何形状。
 * @param {boolean} [input.scriptsAreComplete=true] 清单是否覆盖全部脚本；false 时未命中的
 *   import 降级为 warning，避免把"调用方只传了两个脚本"报成地图坏了。
 * @returns {{ok:boolean, errorCount:number, warningCount:number, problems:object[], checked:object}}
 */
export function validateUiBindings(input = {}) {
  const problems = []
  const { uiTree, scripts, bindings, scriptsAreComplete = true } = input || {}

  if (!Array.isArray(uiTree) && (!uiTree || typeof uiTree !== 'object')) {
    problems.push(
      problem('UI_BINDING_INPUT_INVALID', {
        message: 'uiTree 缺失或不是对象/数组，无法建立控件索引。',
        hint: HINTS.UI_BINDING_INPUT_INVALID,
        path: 'uiTree',
      }),
    )
  }
  if (scripts !== undefined && !Array.isArray(scripts)) {
    problems.push(
      problem('UI_BINDING_INPUT_INVALID', {
        message: `scripts 必须是数组（拿到的是 ${typeof scripts}）。`,
        hint: HINTS.UI_BINDING_INPUT_INVALID,
        path: 'scripts',
      }),
    )
  }
  if (bindings !== undefined && !Array.isArray(bindings)) {
    problems.push(
      problem('UI_BINDING_INPUT_INVALID', {
        message: `bindings 必须是数组（拿到的是 ${typeof bindings}）。`,
        hint: HINTS.UI_BINDING_INPUT_INVALID,
        path: 'bindings',
      }),
    )
  }
  if (problems.length) return finish(problems, { nodes: 0, scripts: 0, bindings: 0, refs: 0, registrations: 0, behaviors: 0, imports: 0 })

  const nodes = normalizeUiTree(uiTree) || []
  const nodesById = new Map(nodes.map((node) => [node.id, node]))
  const nodesByName = new Map()
  for (const node of nodes) {
    if (!nodesByName.has(node.name)) nodesByName.set(node.name, [])
    nodesByName.get(node.name).push(node)
  }

  // R8 -- duplicate names make every name-addressed binding ambiguous.
  for (const [name, owners] of nodesByName) {
    if (owners.length > 1) {
      problems.push(
        problem('UI_NODE_NAME_AMBIGUOUS', {
          message: `控件名 "${name}" 在 uiTree 里出现 ${owners.length} 次（id: ${owners.map((node) => node.id).join(', ')}）。`,
          hint: HINTS.UI_NODE_NAME_AMBIGUOUS,
          path: 'uiTree',
          subject: name,
          ids: owners.map((node) => node.id),
        }),
      )
    }
  }

  // R9 -- orphan nodes: a parentId that names nothing in the tree.
  for (const node of nodes) {
    if (!node.parentId || nodesById.has(node.parentId)) continue
    problems.push(
      problem('UI_ORPHAN_NODE', {
        message: `节点 ${node.id}（"${node.name}"）的 parentId="${node.parentId}" 不在 uiTree 里。`,
        hint: HINTS.UI_ORPHAN_NODE,
        path: `uiTree[${node.id}]`,
        subject: node.name,
        nodeId: node.id,
        parentId: node.parentId,
      }),
    )
  }

  const scriptList = (Array.isArray(scripts) ? scripts : []).map((script, index) => ({
    index,
    side: script && script.side ? String(script.side) : 'client',
    entry: String((script && (script.entry !== undefined ? script.entry : script.name)) ?? ''),
    content: script && typeof script.content === 'string' ? script.content : undefined,
  }))

  const entriesBySide = new Map()
  for (const script of scriptList) {
    if (!entriesBySide.has(script.side)) entriesBySide.set(script.side, new Set())
    const set = entriesBySide.get(script.side)
    set.add(script.entry)
    set.add(entryBasename(script.entry))
  }

  const scanned = scannedScripts(scriptList)

  for (const script of scanned) {
    const where = `scripts[${script.index}](${script.side}/${script.entry})`
    // R10 -- the UI event surface does not exist server-side.
    if (script.side === 'server' && script.offenderCount > 0) {
      problems.push(
        problem('UI_BINDING_SIDE_INVALID', {
          message: `${where} 是 server 脚本，但里面有 ${script.offenderCount} 处 UI 绑定调用（首个：第 ${script.firstOffenderLine} 行 ${script.firstOffender}）。`,
          hint: HINTS.UI_BINDING_SIDE_INVALID,
          path: `${where}@${script.firstOffenderLine}`,
          side: script.side,
          entry: script.entry,
          offenders: script.offenders,
        }),
      )
    }
  }

  const clientScans = scanned.filter((script) => script.side === 'client' && script.scan)

  for (const script of clientScans) {
    const where = `scripts[${script.index}](${script.side}/${script.entry})`
    const scan = script.scan
    const descendantCache = new Map()

    // R2 -- every node reference has to resolve.
    for (const ref of scan.refs) {
      const owners = nodesByName.get(ref.name)
      if (!owners || !owners.length) {
        problems.push(
          problem('UI_TREE_REF_UNRESOLVED', {
            message: `${where} 第 ${ref.line} 行引用控件 "${ref.name}"，uiTree 里没有这个名字。`,
            hint: HINTS.UI_TREE_REF_UNRESOLVED,
            path: `${where}@${ref.line}`,
            subject: ref.name,
            receiver: ref.receiver,
          }),
        )
        continue
      }
      if (ref.scopeKnown && ref.scope) {
        const roots = nodesByName.get(ref.scope)
        const root = roots && roots[0]
        if (root) {
          if (!descendantCache.has(root.id)) descendantCache.set(root.id, descendantIds(nodes, root.id))
          const allowed = descendantCache.get(root.id)
          if (!owners.some((owner) => allowed.has(owner.id) || owner.id === root.id)) {
            problems.push(
              problem('UI_TREE_REF_UNRESOLVED', {
                message: `${where} 第 ${ref.line} 行把 "${ref.name}" 当成 "${ref.scope}" 的子节点取，但它不在那个子树里。`,
                hint: HINTS.UI_TREE_REF_UNRESOLVED,
                path: `${where}@${ref.line}`,
                subject: ref.name,
                scope: ref.scope,
                receiver: ref.receiver,
              }),
            )
          }
        }
      }
    }

    // R3 / R4 -- event names, restricted to provably-UI emitters.
    for (const reg of scan.registrations) {
      if (!reg.isUi) continue
      if (!UI_EVENT_NAMES.includes(reg.event)) {
        problems.push(
          problem('UI_EVENT_NAME_INVALID', {
            message: `${where} 第 ${reg.line} 行给 UI 节点注册事件 "${reg.event}"，它不在 UiEvent 的五个名里。`,
            hint: HINTS.UI_EVENT_NAME_INVALID,
            path: `${where}@${reg.line}`,
            subject: reg.subject,
            event: reg.event,
            allowedEvents: [...UI_EVENT_NAMES],
          }),
        )
        continue
      }
      const required = EVENT_KIND_REQUIREMENT[reg.event]
      if (!required || !reg.subject) continue
      const owners = nodesByName.get(reg.subject)
      if (!owners || !owners.length) continue
      if (owners.every((owner) => owner.kind !== required)) {
        problems.push(
          problem('UI_EVENT_KIND_MISMATCH', {
            message: `${where} 第 ${reg.line} 行在 "${reg.subject}" 上监听 "${reg.event}"，但它的类型是 ${owners
              .map((owner) => owner.kind || owner.valueType || '未知')
              .join('/')}，只有 ${required} 支持这个事件。`,
            hint: HINTS.UI_EVENT_KIND_MISMATCH,
            path: `${where}@${reg.line}`,
            subject: reg.subject,
            event: reg.event,
            requiredKind: required,
            actualKinds: owners.map((owner) => owner.kind || owner.valueType || null),
          }),
        )
      }
    }

    // R6 -- the same script binding the same node + event twice.
    const byPair = new Map()
    for (const reg of scan.registrations) {
      if (!reg.isUi || !['on', 'once', 'add'].includes(reg.method)) continue
      const key = `${reg.subject === null || reg.subject === undefined ? `<${reg.receiver || 'root'}>` : reg.subject}|${reg.event}`
      if (!byPair.has(key)) byPair.set(key, [])
      byPair.get(key).push(reg)
    }
    for (const [key, list] of byPair) {
      if (list.length < 2) continue
      const [subject, event] = key.split('|')
      problems.push(
        problem('UI_BINDING_DUPLICATE', {
          message: `${where} 对控件 "${subject}" 的事件 ${event} 注册了 ${list.length} 次（行 ${list.map((reg) => reg.line).join(', ')}）。`,
          hint: HINTS.UI_BINDING_DUPLICATE,
          path: `${where}@${list[1].line}`,
          subject,
          event,
          lines: list.map((reg) => reg.line),
        }),
      )
    }

    // R7 -- PointerEventBehavior members and values.
    for (const behavior of scan.behaviors) {
      if (behavior.kind === 'member') {
        if (Object.prototype.hasOwnProperty.call(POINTER_EVENT_BEHAVIOR_MEMBERS, behavior.value)) continue
        problems.push(
          problem('UI_POINTER_EVENT_BEHAVIOR_INVALID', {
            message: `${where} 第 ${behavior.line} 行用了 PointerEventBehavior.${behavior.value}，枚举里没有这个成员。`,
            hint: HINTS.UI_POINTER_EVENT_BEHAVIOR_INVALID,
            path: `${where}@${behavior.line}`,
            value: behavior.value,
            allowedMembers: Object.keys(POINTER_EVENT_BEHAVIOR_MEMBERS),
          }),
        )
        continue
      }
      if (POINTER_EVENT_BEHAVIOR_VALUES.includes(behavior.value)) continue
      problems.push(
        problem('UI_POINTER_EVENT_BEHAVIOR_INVALID', {
          message: `${where} 第 ${behavior.line} 行把 pointerEventBehavior 直接赋成 ${behavior.value}，合法整数只有 0..3。`,
          hint: HINTS.UI_POINTER_EVENT_BEHAVIOR_INVALID,
          path: `${where}@${behavior.line}`,
          value: behavior.value,
          allowedValues: [...POINTER_EVENT_BEHAVIOR_VALUES],
        }),
      )
    }

    // R5 -- imports that point at a script the caller's list does not contain.
    for (const item of scan.imports) {
      const known = entriesBySide.get('client') || new Set()
      if (resolveImport(item.specifier, known)) continue
      problems.push(
        problem('UI_SCRIPT_NOT_FOUND', {
          message: `${where} 第 ${item.line} 行 import "${item.specifier}"，脚本清单里没有这个${item.dynamic ? '动态' : ''}目标。`,
          hint: HINTS.UI_SCRIPT_NOT_FOUND,
          // A partial script list is the caller's limitation, not the map's:
          // report it as a warning instead of calling production data broken.
          severity: scriptsAreComplete === false ? 'warning' : undefined,
          path: `${where}@${item.line}`,
          subject: item.specifier,
          from: `${script.side}/${script.entry}`,
        }),
      )
    }
  }

  // Declared binding proposals (the write-gate dimension).
  const declared = Array.isArray(bindings) ? bindings : []
  const declaredPairs = new Map()
  declared.forEach((binding, index) => {
    const where = `bindings[${index}]`
    const item = binding && typeof binding === 'object' ? binding : {}
    const event = isString(item.event) ? item.event : ''
    const nodeRef = isString(item.nodeId) && item.nodeId ? String(item.nodeId) : isString(item.name) ? item.name : ''
    const refKind = isString(item.nodeId) && item.nodeId ? 'id' : 'name'

    // R2 -- the target control must exist.
    if (!nodeRef) {
      problems.push(
        problem('UI_TREE_REF_UNRESOLVED', {
          message: `${where} 既没有 nodeId 也没有 name，指向不了任何控件。`,
          hint: HINTS.UI_TREE_REF_UNRESOLVED,
          path: where,
          subject: null,
        }),
      )
    } else {
      const owners = refKind === 'id' ? (nodesById.has(nodeRef) ? [nodesById.get(nodeRef)] : []) : nodesByName.get(nodeRef) || []
      if (!owners.length) {
        problems.push(
          problem('UI_TREE_REF_UNRESOLVED', {
            message: `${where} 指向控件 ${refKind}="${nodeRef}"，uiTree 里不存在。`,
            hint: HINTS.UI_TREE_REF_UNRESOLVED,
            path: where,
            subject: nodeRef,
            refKind,
          }),
        )
      } else {
        const required = EVENT_KIND_REQUIREMENT[event]
        if (required && owners.every((owner) => owner.kind !== required)) {
          problems.push(
            problem('UI_EVENT_KIND_MISMATCH', {
              message: `${where} 在 "${nodeRef}" 上绑 ${event}，但它的类型是 ${owners.map((owner) => owner.kind || owner.valueType || '未知').join('/')}，只有 ${required} 支持。`,
              hint: HINTS.UI_EVENT_KIND_MISMATCH,
              path: where,
              subject: nodeRef,
              event,
              requiredKind: required,
            }),
          )
        }
      }
    }

    // R3 -- the event name.
    if (!UI_EVENT_NAMES.includes(event)) {
      problems.push(
        problem('UI_EVENT_NAME_INVALID', {
          message: `${where}.event="${event}" 不是 UiEvent 的五个名之一。`,
          hint: HINTS.UI_EVENT_NAME_INVALID,
          path: `${where}.event`,
          subject: nodeRef || null,
          event,
          allowedEvents: [...UI_EVENT_NAMES],
        }),
      )
    } else {
      const key = `${nodeRef}|${event}`
      if (!declaredPairs.has(key)) declaredPairs.set(key, [])
      declaredPairs.get(key).push(index)
    }

    // R5 -- the script the binding says it lives in.
    if (item.script && typeof item.script === 'object') {
      const side = isString(item.script.side) ? item.script.side : 'client'
      const entry = String(item.script.entry ?? '')
      const known = entriesBySide.get(side) || new Set()
      if (!known.has(entry) || !entry) {
        problems.push(
          problem('UI_SCRIPT_NOT_FOUND', {
            message: `${where}.script 声明绑定在 ${side}/${entry}，脚本清单里没有这个脚本。`,
            hint: HINTS.UI_SCRIPT_NOT_FOUND,
            path: `${where}.script`,
            side,
            subject: entry || null,
          }),
        )
      }
    }
  })
  for (const [key, list] of declaredPairs) {
    if (list.length < 2) continue
    const [subject, event] = key.split('|')
    problems.push(
      problem('UI_BINDING_DUPLICATE', {
        message: `bindings 对控件 "${subject}" 的事件 ${event} 声明了 ${list.length} 次（下标 ${list.join(', ')}）。`,
        hint: HINTS.UI_BINDING_DUPLICATE,
        path: `bindings[${list[1]}]`,
        subject,
        event,
        indices: list,
      }),
    )
  }

  const checked = {
    nodes: nodes.length,
    scripts: scriptList.length,
    bindings: declared.length,
    refs: clientScans.reduce((sum, script) => sum + script.scan.refs.length, 0),
    registrations: clientScans.reduce((sum, script) => sum + script.scan.registrations.filter((reg) => reg.isUi).length, 0),
    behaviors: clientScans.reduce((sum, script) => sum + script.scan.behaviors.length, 0),
    imports: clientScans.reduce((sum, script) => sum + script.scan.imports.length, 0),
  }
  return finish(problems, checked)
}

/** Pre-classify scripts so the server-side rule does not scan twice. */
function scannedScripts(scriptList) {
  return scriptList.map((script) => {
    if (typeof script.content !== 'string') return { ...script, scan: null, offenders: [], offenderCount: 0, firstOffenderLine: 0, firstOffender: '' }
    const scan = scanScriptBindings(script.content)
    const offenders = [
      ...scan.refs.map((ref) => ({ line: ref.line, what: `findChildByName('${ref.name}')` })),
      ...scan.registrations.filter((reg) => reg.isUi).map((reg) => ({ line: reg.line, what: `.events.${reg.method}('${reg.event}')` })),
      ...scan.behaviors.map((behavior) => ({ line: behavior.line, what: `pointerEventBehavior=${behavior.value}` })),
    ].sort((left, right) => left.line - right.line)
    return {
      ...script,
      scan,
      offenders,
      offenderCount: offenders.length,
      firstOffenderLine: offenders.length ? offenders[0].line : 0,
      firstOffender: offenders.length ? offenders[0].what : '',
    }
  })
}
