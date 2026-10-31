/**
 * UI domain: the interface half of the pipeline, on top of the engine's
 * `uiTreeRead / uiNodeAdd / uiNodeRemove` (map-authoring-tools.ts:354-457).
 *
 * Lock semantics, per the source:
 *   - `uiNodeAdd` DOES take `expectedRevision` and compares it against
 *     `computeUiRevision(tree)` (fnv1a over node ids, types, child counts) —
 *     that token is engine-authoritative, and the router maps the refusal to 409.
 *   - `uiNodeRemove` does NOT: the lock is checked here against the same engine
 *     token read via `uiTreeRead`, immediately before the call.
 *
 * Batching: every successful `uiNodeAdd` changes the tree, so its own
 * `newRevision` becomes the token for the next node. A batch therefore chains
 * revisions instead of reusing a stale one (which the engine would refuse), and
 * a mid-batch failure rolls the created nodes back with `uiNodeRemove`.
 */
import {
  BUDGETS,
  assertWritable,
  callEngineTool,
  dangerScan,
  fail,
  requireClientRevision,
} from './_shared.js'

const ELEMENT_KEYS = ['box', 'image', 'text', 'scrollBox', 'input']

const readAnnotations = (title) => ({
  title,
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
})

const writeAnnotations = (title, destructive = false) => ({
  title,
  readOnlyHint: false,
  destructiveHint: destructive,
  idempotentHint: false,
  openWorldHint: true,
})

async function readUiTree(ctx, mapId) {
  return callEngineTool(ctx, mapId, 'uiTreeRead', {})
}

function checkNodePayload(node, index) {
  const data = node.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    fail({
      code: 'UI_NODE_DATA_INVALID',
      message: `nodes[${index}].data 必须是一个对象（引擎按 UINode 联合的 payload 处理）`,
      retry: false,
      hint:
        'screen 用 {zIndex, enable, layout:{type, data}}；element 用 ' +
        `{${ELEMENT_KEYS.join('|')}} 其中一个作为顶层键，例如 {text:{content:"标题"}}。`,
    })
  }
  if (node.nodeType === 'element') {
    const known = Object.keys(data).filter((key) => ELEMENT_KEYS.includes(key))
    if (!known.length) {
      fail({
        code: 'UI_NODE_DATA_INVALID',
        message: `nodes[${index}] 是 element，但 data 里没有 ${ELEMENT_KEYS.join('/')} 任何一个键`,
        retry: false,
        hint:
          `引擎不会拒绝未知键（z.record 全放行），结果是建出一个渲染不出来的空节点——比报错更糟。` +
          `改成 {${ELEMENT_KEYS[0]}:{...}} 这类形态再来。`,
        allowedKeys: ELEMENT_KEYS,
        actualKeys: Object.keys(data),
      })
    }
  }
}

export function buildUiTools(ctx) {
  return [
    {
      name: 'ui_tree_read',
      description:
        '读整棵 UI 树（每个节点 id/name/parentId/type/childrenIds/value）+ 引擎算出的 revision。' +
        'ui_node_add 的 expectedRevision 取这里（引擎自己校验），ui_node_remove 也用同一个令牌（本层校验）。' +
        '节点数量大时本工具会把树原文返回，注意 context 占用：先用它定位要改的子树，再只写那块。副作用：无。',
      inputSchema: {
        type: 'object',
        properties: {
          mapId: { type: 'string', minLength: 1, maxLength: 63 },
          nameFilter: { type: 'string', maxLength: 80, description: '只保留 name 含该子串的节点（本地过滤，不省流量但省阅读）' },
        },
        required: ['mapId'],
        additionalProperties: false,
      },
      annotations: readAnnotations('UI 树与 revision'),
      scope: 'loopback internal（无 creator/v1 scope）',
      handler: async (args) => {
        const tree = await readUiTree(ctx, args.mapId)
        const nodes = tree.nodes || []
        const matched = args.nameFilter
          ? nodes.filter((node) => String(node.name || '').includes(args.nameFilter))
          : nodes
        return {
          ...tree,
          totalNodes: nodes.length,
          returnedNodes: matched.length,
          nodes: matched,
          revisionAuthority: 'engine（computeUiRevision，map-authoring-tools.ts:80）',
          next: `写 UI 时 expectedRevision=${tree.revision}；节点总数 ${nodes.length}。`,
        }
      },
    },
    {
      name: 'ui_node_add',
      description:
        `往 UI 树加节点，一次最多 ${BUDGETS.UI_MAX_NODES_PER_CALL} 个。每项 {parentId?, name, nodeType:"screen"|"element", data}。` +
        'parentId 省略时引擎挂到默认屏（DEFAULT_SCREEN_ID）。element 的 data 必须含 box/image/text/scrollBox/input 之一，' +
        '否则本层直接拒绝（引擎会照收并给你一个渲染不出来的空节点）。' +
        '必须带 ui_tree_read 的 expectedRevision；批量时逐个用上一次返回的 newRevision 继续（引擎会改树，令牌必变）。' +
        '中途失败就用 uiNodeRemove 把本次已建节点删掉并回报 rolledBack。' +
        'screen 的 layout 形态只做建议（advisory），不硬拦，因为引擎侧 schema 未在本地验证过。' +
        '副作用：写内存 UI 树（每个节点一次 projectTransaction），map_save 才落盘。',
      inputSchema: {
        type: 'object',
        properties: {
          mapId: { type: 'string', minLength: 1, maxLength: 63 },
          nodes: {
            type: 'array',
            minItems: 1,
            maxItems: BUDGETS.UI_MAX_NODES_PER_CALL,
            description: '要加的节点数组，顺序即创建顺序',
          },
          expectedRevision: {
            type: 'string',
            description:
              '乐观锁令牌：ui_tree_read 的 revision（引擎 uiNodeAdd 原生校验这个值，权威）。' +
              '批量时第 2 个起由本层自动改用上一次返回的 newRevision。',
          },
        },
        required: ['mapId', 'nodes', 'expectedRevision'],
        additionalProperties: false,
      },
      annotations: writeAnnotations('加 UI 节点（批量 + 链式 revision + 回滚）'),
      scope: 'loopback internal（写内存 UI 树，map_save 才落盘）',
      handler: async (args) => {
        assertWritable(ctx, 'ui_node_add')
        const nodes = Array.isArray(args.nodes) ? args.nodes : []
        if (!nodes.length) {
          fail({
            code: 'UI_BATCH_EMPTY',
            message: 'nodes 不能是空数组',
            retry: false,
            hint: '空数组会让 revision 看起来没变、却消耗一次往返；要么给出节点，要么别调。',
          })
        }
        if (nodes.length > BUDGETS.UI_MAX_NODES_PER_CALL) {
          fail({
            code: 'UI_BUDGET_EXCEEDED',
            message: `一次要加 ${nodes.length} 个 UI 节点，超过本层上限 ${BUDGETS.UI_MAX_NODES_PER_CALL}`,
            retry: false,
            hint:
              `分 ${Math.ceil(nodes.length / BUDGETS.UI_MAX_NODES_PER_CALL)} 批，每批 <= ${BUDGETS.UI_MAX_NODES_PER_CALL} 个；` +
              '依据：引擎每个节点一次 projectTransaction().commit()（map-authoring-tools.ts:412-425），' +
              '批量越大、中途失败要回滚的节点越多，链式 revision 也越容易在长事务里过期。',
            count: nodes.length,
            limit: BUDGETS.UI_MAX_NODES_PER_CALL,
          })
        }
        nodes.forEach((node, index) => {
          dangerScan(node, `ui_node_add.nodes[${index}]`)
          if (node.nodeType !== 'screen' && node.nodeType !== 'element') {
            fail({
              code: 'UI_NODE_TYPE_INVALID',
              message: `nodes[${index}].nodeType="${node.nodeType}" 非法`,
              retry: false,
              hint: '引擎的联合判别位只认 "screen" 或 "element"（map-authoring-tools.ts:388）。',
            })
          }
          if (typeof node.name !== 'string' || !node.name) {
            fail({
              code: 'UI_NODE_NAME_REQUIRED',
              message: `nodes[${index}].name 必须是非空字符串`,
              retry: false,
              hint: 'name 是 UI 脚本里取节点用的键（ui.screen(...) 之类），空名字等于给自己埋坑。',
            })
          }
          checkNodePayload(node, index)
        })

        const created = []
        const advisories = []
        let current = args.expectedRevision
        const failures = []
        for (const [index, node] of nodes.entries()) {
          if (node.nodeType === 'screen' && !(node.data && node.data.layout)) {
            advisories.push({
              index,
              name: node.name,
              note: 'screen 没带 layout：引擎不会拦，但渲染层可能拿不到布局。建议 {zIndex, enable, layout:{type, data}}。',
            })
          }
          try {
            const result = await callEngineTool(ctx, args.mapId, 'uiNodeAdd', {
              parentId: node.parentId,
              name: node.name,
              nodeType: node.nodeType,
              data: node.data,
              expectedRevision: current,
            })
            created.push({ index, nodeId: result.nodeId, parent: node.parentId || 'DEFAULT_SCREEN' })
            if (typeof result.newRevision === 'string') current = result.newRevision
          } catch (error) {
            failures.push({ index, node, cause: error, error: { code: error.code, message: error.message, hint: error.hint } })
            break
          }
        }
        if (failures.length) {
          // Nothing got created => there is nothing to roll back and the engine's
          // own refusal IS the answer. Re-raising it keeps the precise code
          // (`REVISION_CONFLICT`, `ENGINE_TOOL_NOT_MOUNTED`, …) plus its status
          // and detail at the top level, instead of flattening all of them into
          // one `UI_NODE_ADD_FAILED`.
          if (!created.length) throw failures[0].cause
          let rollback = { attempted: false, rolledBack: false }
          if (created.length) {
            try {
              await callEngineTool(ctx, args.mapId, 'uiNodeRemove', {
                nodeIds: created.map((row) => row.nodeId),
              })
              rollback = { attempted: true, rolledBack: true, removedIds: created.map((row) => row.nodeId) }
            } catch (error) {
              rollback = {
                attempted: true,
                rolledBack: false,
                orphanIds: created.map((row) => row.nodeId),
                error: { code: error.code, message: error.message, hint: error.hint },
              }
            }
          }
          fail({
            code: 'UI_NODE_ADD_FAILED',
            message: `第 ${failures[0].index} 个节点失败，此前已建 ${created.length} 个`,
            retry: true,
            hint: rollback.rolledBack
              ? '本次已建节点已全部删除，树回到写前状态。按 failure 修参数，重新 ui_tree_read 取 revision 再来。'
              : rollback.attempted
                ? `回滚失败：残留节点 id 见 rollback.orphanIds，用 ui_node_remove 手工清掉，否则图里留着半成品。`
                : '没有残留节点。按 failure 里的原因修参数，重新 ui_tree_read 取 revision 再来。',
            created,
            failures,
            rollback,
            revisionAtFailure: current,
          })
        }
        const tree = await readUiTree(ctx, args.mapId)
        return {
          success: true,
          created,
          nodeIds: created.map((row) => row.nodeId),
          revision: tree.revision,
          totalNodes: (tree.nodes || []).length,
          advisories,
          revisionAuthority: 'engine（uiNodeAdd 原生校验）+ 本层链式刷新',
          persistHint: 'UI 节点只在内存 replica 里：map_save 之后才进盘上地图。',
          next: `已加 ${created.length} 个节点；下一次写的 expectedRevision=${tree.revision}；落盘用 map_save。`,
        }
      },
    },
    {
      name: 'ui_node_remove',
      description:
        `按 id 删 UI 节点，一次最多 ${BUDGETS.UI_MAX_NODES_PER_CALL} 个。破坏性：默认 confirm:false 只出计划（会列出将被删节点的 name/type 和父节点），` +
        'confirm:true 才真删。引擎 delete 侧没有 CAS，所以 expectedRevision（ui_tree_read 的 revision）由本层校验。' +
        '引擎按 id 数组删除且不会重挂子节点：删父节点要把它子孙的 id 一起传进来。' +
        '没有 undoToken，删除不可在本层回滚——先 ui_tree_read 留一份原文再删。副作用：改内存 UI 树，map_save 才落盘。',
      inputSchema: {
        type: 'object',
        properties: {
          mapId: { type: 'string', minLength: 1, maxLength: 63 },
          nodeIds: { type: 'array', minItems: 1, maxItems: BUDGETS.UI_MAX_NODES_PER_CALL },
          expectedRevision: {
            type: 'string',
            description: 'ui_tree_read 的 revision；本层校验（引擎 uiNodeRemove 不校验）',
          },
          confirm: { type: 'boolean', description: 'false=dry-run 只出计划；true 才真删（默认 false）' },
          allowUnhedged: { type: 'boolean' },
        },
        required: ['mapId', 'nodeIds', 'expectedRevision'],
        additionalProperties: false,
      },
      annotations: writeAnnotations('删除 UI 节点（需 confirm）', true),
      scope: 'loopback internal（破坏性写，map_save 才落盘）',
      handler: async (args) => {
        assertWritable(ctx, 'ui_node_remove')
        const ids = (args.nodeIds || []).map(String)
        if (!ids.length) {
          fail({ code: 'UI_BATCH_EMPTY', message: 'nodeIds 不能为空', retry: false, hint: '给出要删的 id。' })
        }
        if (ids.length > BUDGETS.UI_MAX_NODES_PER_CALL) {
          fail({
            code: 'UI_BUDGET_EXCEEDED',
            message: `一次要删 ${ids.length} 个节点，超过本层上限 ${BUDGETS.UI_MAX_NODES_PER_CALL}`,
            retry: false,
            hint: `分批删，每批 <= ${BUDGETS.UI_MAX_NODES_PER_CALL}；每批之间用 ui_tree_read 重取 revision。`,
          })
        }
        const tree = await readUiTree(ctx, args.mapId)
        const nodes = tree.nodes || []
        await requireClientRevision({
          current: tree.revision,
          expected: args.expectedRevision,
          kind: 'UI 树',
          authority: 'engine 令牌 + 本层前置校验（引擎 uiNodeRemove 不校验）',
          allowUnhedged: args.allowUnhedged,
          next: 'ui_tree_read',
        })
        const missing = ids.filter((id) => !nodes.some((node) => String(node.id) === id))
        if (missing.length) {
          fail({
            code: 'UI_NODE_NOT_FOUND',
            message: `这些 id 不在 UI 树里：${missing.join(', ')}`,
            retry: false,
            hint:
              '引擎的 uiTree.remove 对未知 id 静默通过，本层拒绝以免"删了个寂寞"还继续落盘。' +
              '先 ui_tree_read 核对 id（id 是引擎生成的数字串）。',
            missing,
          })
        }
        if (args.confirm !== true) {
          return {
            dryRun: true,
            wouldRemove: ids,
            matched: nodes.filter((node) => ids.includes(String(node.id))),
            orphanRisk: nodes
              .filter((node) => ids.includes(String(node.parentId || '')) && !ids.includes(String(node.id)))
              .map((node) => ({ id: node.id, name: node.name, parentId: node.parentId })),
            revision: tree.revision,
            next:
              '带 confirm:true 且 expectedRevision=' + tree.revision + ' 再调一次即真删。' +
              (nodes.filter((node) => ids.includes(String(node.parentId || '')) && !ids.includes(String(node.id))).length
                ? '注意 orphanRisk：这些子节点的父节点会被删掉，但引擎不会重挂它们。'
                : '本次不会产生孤儿子节点。'),
          }
        }
        const result = await callEngineTool(ctx, args.mapId, 'uiNodeRemove', { nodeIds: ids })
        return {
          ...result,
          removed: ids,
          revisionBefore: tree.revision,
          persistHint: '删除只在内存里：map_save 才写回盘。',
          next: `删掉 ${ids.length} 个节点，新的 expectedRevision=${result.newRevision}。`,
        }
      },
    },
  ]
}
