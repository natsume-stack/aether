/**
 * SCRIPT-RUNTIME domain: the engine's in-editor script tools
 * (`listScripts / readScript / createScript / updateScript / deleteScript`,
 * entity-tools.ts:31-245) driven over the same loopback tool route.
 *
 * IMPORTANT, stated up front instead of letting an agent burn turns on it:
 * `services/game-server/src/edit/ai/ai-tool-route.ts:78-91` mounts ONLY
 * `createMapAuthoringTools` + `createEntityTools`. `createScriptTools` is wired
 * into the in-editor AiServer (ai-server.ts) but NOT into the headless router,
 * so every call here currently surfaces as ENGINE_TOOL_NOT_MOUNTED. The tools
 * are still exposed and fully guarded, so they light up the moment lane B/C adds
 * one spread to that router — and the local gates (type gate, danger scan,
 * budgets, CAS) already behave exactly like `script_write`.
 *
 * `script_write` (creator/v1 `scripts.update`) stays the production path for
 * committed script text: it has disk CAS via `branch.headHash`, a byte-exact
 * read-back and rollback. These runtime tools touch the UNSAVED editor buffer
 * (`state.codeEditor.fileDict`) — useful for wiring a map that is open in the
 * editor, never a substitute for `script_write`.
 */
import { createHash } from 'node:crypto'
import { BUDGETS, assertWritable, callEngineTool, dangerScan, fail, requireClientRevision, snapshotRevision } from './_shared.js'
import { checkScript } from '../typegate.js'

const entryPattern = /^[A-Za-z0-9._-]{1,160}$/

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

const MOUNT_NOTE =
  '引擎 headless 路由当前没挂 createScriptTools（ai-tool-route.ts:78-91），' +
  '这一族会回 ENGINE_TOOL_NOT_MOUNTED；正文写入请走 script_write（HTTP scripts.update，有 CAS + 类型门 + 读回）。'

function canonicalFileList(scripts) {
  const rows = (scripts || [])
    .map((file) => ({
      id: String(file.id),
      name: file.name,
      isClient: Boolean(file.isClient),
      order: file.order,
    }))
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return rows
}

function contentDigest(content) {
  return `sha256:${createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex').slice(0, 32)}`
}

async function runtimeFileRevision(ctx, mapId) {
  const listed = await callEngineTool(ctx, mapId, 'listScripts', {})
  return {
    revision: snapshotRevision('scriptFiles', { total: listed.total ?? 0, rows: canonicalFileList(listed.scripts) }),
    files: canonicalFileList(listed.scripts),
    raw: listed,
  }
}

async function gateScriptContent(ctx, { content, side, mode, dialect, toolName }) {
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > BUDGETS.SCRIPT_MAX_CONTENT_BYTES) {
    fail({
      code: 'SCRIPT_CONTENT_BUDGET_EXCEEDED',
      message: `${toolName} 的正文 ${bytes} B 超过本层上限 ${BUDGETS.SCRIPT_MAX_CONTENT_BYTES} B`,
      retry: false,
      hint:
        '把逻辑拆到多个文件（引擎按 order 依次加载共享脚本），单次写入停在 2 MiB：' +
        'updateScript 是字符下标级操作，文件越大一次误操作毁掉整份正文的概率越高。',
      bytes,
      limit: BUDGETS.SCRIPT_MAX_CONTENT_BYTES,
    })
  }
  const gate = await checkScript({ side, content, mode, dialect }, ctx.config)
  if (!gate.satisfied) {
    fail({
      code: 'TYPE_GATE_FAILED',
      message: `${toolName} 未过落盘前的类型/语法门（mode=${gate.mode}），本次没有发出引擎调用`,
      retry: true,
      hint:
        '按 detail.errors 的 code + line 改正文再来；成员不在契约面上时用 contract_describe 查真实 API，' +
        '不要凭记忆猜。',
      errors: gate.errors,
      warnings: gate.warnings,
      notes: gate.notes,
    })
  }
  return gate
}

export function buildScriptRuntimeTools(ctx) {
  return [
    {
      name: 'script_list_runtime',
      description:
        '列**编辑器内存里**的脚本文件（fileId / name / isClient / order），区别于 script_list 的共享脚本 HTTP 表：' +
        '这里能看到还没保存的新建/改名文件。写运行时脚本前用它取 fileId 和 revision。' +
        `当前状态：${MOUNT_NOTE} 副作用：无。`,
      inputSchema: {
        type: 'object',
        properties: { mapId: { type: 'string', minLength: 1, maxLength: 63 } },
        required: ['mapId'],
        additionalProperties: false,
      },
      annotations: readAnnotations('运行时脚本清单'),
      scope: 'loopback internal（需活动编辑运行时）',
      handler: async (args) => {
        const listed = await runtimeFileRevision(ctx, args.mapId)
        return {
          ...listed.raw,
          revision: listed.revision,
          revisionAuthority: 'mcp-layer（引擎脚本工具无 CAS）',
          note: MOUNT_NOTE,
        }
      },
    },
    {
      name: 'script_read_runtime',
      description:
        '读编辑器内存里某个 fileId 的脚本正文（未保存态）。script_patch 之前必须先用它读原文并记下 contentHash，' +
        '因为 patch 是字符下标级 insert/remove，下标只有对当前正文才有意义。' +
        `当前状态：${MOUNT_NOTE} 副作用：无。`,
      inputSchema: {
        type: 'object',
        properties: {
          mapId: { type: 'string', minLength: 1, maxLength: 63 },
          fileId: { type: 'string', minLength: 1, maxLength: 64, description: 'script_list_runtime 给的 id' },
        },
        required: ['mapId', 'fileId'],
        additionalProperties: false,
      },
      annotations: readAnnotations('运行时脚本正文'),
      scope: 'loopback internal（需活动编辑运行时）',
      handler: async (args) => {
        const result = await callEngineTool(ctx, args.mapId, 'readScript', { fileId: String(args.fileId) })
        return {
          ...result,
          contentBytes: Buffer.byteLength(result.content || '', 'utf8'),
          contentHash: contentDigest(result.content || ''),
          note: MOUNT_NOTE,
          next: 'script_patch 时把 contentHash 作为 expectedContentHash 带回来（本层据此拒绝基于旧正文的下标）。',
        }
      },
    },
    {
      name: 'script_create',
      description:
        '在编辑器里新建一份脚本文件（name / content / isClient）。' +
        '本地门：正文先过 typegate（语法 + 契约 + 敏感信息），再过危险面扫描（eval / Function / 动态 import / __proto__ / node 内置模块）；' +
        'index.js 与 clientIndex.js 是引擎保留入口，引擎自己会拒。必须带 script_list_runtime 的 revision。' +
        `当前状态：${MOUNT_NOTE} 副作用：写内存 fileDict，要 map_save 才进盘。`,
      inputSchema: {
        type: 'object',
        properties: {
          mapId: { type: 'string', minLength: 1, maxLength: 63 },
          name: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,160}$', description: '文件名，例如 quest.js；不能是 index.js / clientIndex.js' },
          content: { type: 'string', description: '初始正文（可空串）' },
          isClient: { type: 'boolean', description: 'true=客户端脚本（ESM 沙箱），false=服务端（CJS 沙箱）' },
          expectedRevision: { type: 'string', description: 'script_list_runtime 的 revision' },
          dialect: { type: 'string', enum: ['cjs', 'esm'], description: '不传按 side 默认：server=cjs、client=esm' },
          typeGateMode: { type: 'string', enum: ['auto', 'language-service', 'syntax', 'off'] },
          allowUnhedged: { type: 'boolean' },
        },
        required: ['mapId', 'name', 'content', 'expectedRevision'],
        additionalProperties: false,
      },
      annotations: writeAnnotations('新建运行时脚本文件'),
      scope: 'loopback internal（写内存 fileDict，map_save 才落盘）',
      handler: async (args) => {
        assertWritable(ctx, 'script_create')
        const name = String(args.name || '')
        if (!entryPattern.test(name) || name.includes('..')) {
          fail({
            code: 'SCRIPT_ENTRY_INVALID',
            message: `name "${name}" 不是合法脚本文件名`,
            retry: false,
            hint: '只允许 [A-Za-z0-9._-]{1,160}，且不含 ..（与 script_write 同一套规则）。',
          })
        }
        if (name === 'index.js' || name === 'clientIndex.js') {
          fail({
            code: 'SCRIPT_RESERVED_ENTRY',
            message: `${name} 是引擎保留的 map-local 入口脚本，不能用运行时工具新建`,
            retry: false,
            hint: '入口正文请用 script_write（side+entry=index.js/clientIndex.js，它会走盘上 headHash 链）。',
          })
        }
        dangerScan(args.content, 'script_create.content')
        const side = args.isClient === true ? 'client' : 'server'
        const gate = await gateScriptContent(ctx, {
          content: args.content,
          side,
          mode: args.typeGateMode,
          dialect: args.dialect,
          toolName: 'script_create',
        })
        const listed = await runtimeFileRevision(ctx, args.mapId)
        if (listed.files.some((file) => file.name === name)) {
          fail({
            code: 'SCRIPT_NAME_TAKEN',
            message: `运行时里已经有 ${name}`,
            retry: false,
            hint: '引擎 createScript 对重名直接失败（entity-tools.ts:181-189）。改名字，或者用 script_patch 更新已有文件。',
          })
        }
        await requireClientRevision({
          current: listed.revision,
          expected: args.expectedRevision,
          kind: '运行时脚本表',
          authority: 'mcp-layer（引擎脚本工具无 CAS）',
          allowUnhedged: args.allowUnhedged,
          next: 'script_list_runtime',
        })
        const result = await callEngineTool(ctx, args.mapId, 'createScript', {
          name,
          content: args.content,
          isClient: args.isClient === true,
        })
        const after = await runtimeFileRevision(ctx, args.mapId)
        return {
          ...result,
          gate: { mode: gate.mode, satisfied: gate.satisfied },
          revision: after.revision,
          note: MOUNT_NOTE,
          next: `已建 ${name}（fileId=${result.fileId}）；正文最终仍要用 script_write 走一遍才会进盘上的共享脚本表。`,
        }
      },
    },
    {
      name: 'script_patch',
      description:
        '按字符下标补丁式改运行时脚本（operations: [{type:"insert",index,text} | {type:"remove",index,count}]）。' +
        '所有下标都以"本次调用前的正文"为基准，所以必须同时带 expectedRevision（文件表快照）和 expectedContentHash' +
        '（script_read_runtime 返回的 contentHash）——本层会先重读正文比对，不一致就拒，避免把下标打在已经变过的文件上。' +
        `一次最多 ${BUDGETS.SCRIPT_MAX_OPS_PER_CALL} 个 operation；正文还要过类型门（按打完补丁后的预期长度做旁路提示）。` +
        `当前状态：${MOUNT_NOTE} 副作用：写内存 fileDict，要 map_save 才进盘。`,
      inputSchema: {
        type: 'object',
        properties: {
          mapId: { type: 'string', minLength: 1, maxLength: 63 },
          fileId: { type: 'string', minLength: 1, maxLength: 64 },
          operations: {
            type: 'array',
            minItems: 1,
            maxItems: BUDGETS.SCRIPT_MAX_OPS_PER_CALL,
            description: '按顺序应用的 insert/remove 操作；index 以初始正文为基准',
          },
          expectedRevision: { type: 'string', description: 'script_list_runtime 的 revision' },
          expectedContentHash: { type: 'string', description: 'script_read_runtime 的 contentHash（正文级 CAS）' },
          typeGateMode: { type: 'string', enum: ['auto', 'language-service', 'syntax', 'off'] },
          allowUnhedged: { type: 'boolean' },
        },
        required: ['mapId', 'fileId', 'operations', 'expectedRevision', 'expectedContentHash'],
        additionalProperties: false,
      },
      annotations: writeAnnotations('补丁式修改运行时脚本'),
      scope: 'loopback internal（写内存 fileDict，map_save 才落盘）',
      handler: async (args) => {
        assertWritable(ctx, 'script_patch')
        const operations = Array.isArray(args.operations) ? args.operations : []
        if (!operations.length) {
          fail({
            code: 'SCRIPT_OPS_EMPTY',
            message: 'operations 不能为空',
            retry: false,
            hint: '至少一个 insert/remove；空补丁会让上层误以为改动生效了。',
          })
        }
        if (operations.length > BUDGETS.SCRIPT_MAX_OPS_PER_CALL) {
          fail({
            code: 'SCRIPT_BUDGET_EXCEEDED',
            message: `一次要打 ${operations.length} 个 operation，超过本层上限 ${BUDGETS.SCRIPT_MAX_OPS_PER_CALL}`,
            retry: false,
            hint:
              `分 ${Math.ceil(operations.length / BUDGETS.SCRIPT_MAX_OPS_PER_CALL)} 轮，每轮之间重新 script_read_runtime` +
              ' 取 contentHash（下标基准每轮都会变）。',
            count: operations.length,
          })
        }
        operations.forEach((op, index) => {
          if (op?.type !== 'insert' && op?.type !== 'remove') {
            fail({
              code: 'SCRIPT_OP_TYPE_INVALID',
              message: `operations[${index}].type="${op?.type}" 非法`,
              retry: false,
              hint: '引擎只接受 "insert"（需要 text）或 "remove"（需要 count）。',
            })
          }
          if (!Number.isInteger(op.index) || op.index < 0) {
            fail({
              code: 'SCRIPT_OP_INDEX_INVALID',
              message: `operations[${index}].index 必须是非负整数`,
              retry: false,
              hint: 'index 是字符下标（以本次调用前的正文为基准），不是行号。',
            })
          }
          if (op.type === 'insert' && typeof op.text !== 'string') {
            fail({
              code: 'SCRIPT_OP_TEXT_REQUIRED',
              message: `operations[${index}] 是 insert 但没有 text`,
              retry: false,
              hint: '引擎对缺 text 的 insert 直接返回 "Insert operation requires text"（entity-tools.ts:127-134）。',
            })
          }
          if (op.type === 'remove' && !(Number.isInteger(op.count) && op.count > 0)) {
            fail({
              code: 'SCRIPT_OP_COUNT_REQUIRED',
              message: `operations[${index}] 是 remove 但 count 缺失或非正整数`,
              retry: false,
              hint: 'count 是要删的字符数；引擎默认 1，靠默认值删多字符很容易越界。',
            })
          }
          dangerScan(op.text ?? '', `script_patch.operations[${index}].text`)
        })
        const listed = await runtimeFileRevision(ctx, args.mapId)
        await requireClientRevision({
          current: listed.revision,
          expected: args.expectedRevision,
          kind: '运行时脚本表',
          authority: 'mcp-layer（引擎脚本工具无 CAS）',
          allowUnhedged: args.allowUnhedged,
          next: 'script_list_runtime',
        })
        const read = await callEngineTool(ctx, args.mapId, 'readScript', { fileId: String(args.fileId) })
        const actual = contentDigest(read.content || '')
        if (actual !== String(args.expectedContentHash)) {
          fail({
            code: 'REVISION_CONFLICT',
            message: `正文级乐观锁失败：expectedContentHash=${args.expectedContentHash} 与当前 ${actual} 不一致`,
            retry: true,
            hint:
              '文件内容在你上次读之后被改过，字符下标已经失去意义（引擎按当前正文派发 insert/remove，' +
              '错位会静默写坏正文）。重新 script_read_runtime 拿新 contentHash 和下标再来。',
            currentContentHash: actual,
          })
        }
        const patched = applyOperations(read.content || '', operations)
        const fileRow = listed.files.find((file) => file.id === String(args.fileId))
        const gate = await gateScriptContent(ctx, {
          content: patched,
          side: fileRow?.isClient === true ? 'client' : 'server',
          mode: args.typeGateMode,
          toolName: 'script_patch',
        })
        const result = await callEngineTool(ctx, args.mapId, 'updateScript', {
          fileId: String(args.fileId),
          operations,
        })
        const after = await callEngineTool(ctx, args.mapId, 'readScript', { fileId: String(args.fileId) })
        return {
          ...result,
          gate: { mode: gate.mode, satisfied: gate.satisfied },
          contentBeforeBytes: Buffer.byteLength(read.content || '', 'utf8'),
          contentAfterBytes: Buffer.byteLength(after.content || '', 'utf8'),
          contentHash: contentDigest(after.content || ''),
          revisionAuthority: 'mcp-layer（本层做文件表 + 正文双学校验；引擎无 CAS）',
          note: MOUNT_NOTE,
          next: '补丁只改了内存 fileDict：map_save 才会把这张图连同脚本落到盘上；共享脚本正文仍建议走 script_write。',
        }
      },
    },
    {
      name: 'script_delete',
      description:
        '删一个运行时脚本文件（按 fileId）。破坏性：默认 confirm:false 只回报将要删的文件名，confirm:true 才真删；' +
        '必须带 script_list_runtime 的 revision。index.js / clientIndex.js 由引擎自己拦（保留入口）。' +
        `当前状态：${MOUNT_NOTE} 副作用：改内存 fileDict，map_save 才落盘；本层没有 undoToken 可回滚。`,
      inputSchema: {
        type: 'object',
        properties: {
          mapId: { type: 'string', minLength: 1, maxLength: 63 },
          fileId: { type: 'string', minLength: 1, maxLength: 64 },
          expectedRevision: { type: 'string' },
          confirm: { type: 'boolean' },
          allowUnhedged: { type: 'boolean' },
        },
        required: ['mapId', 'fileId', 'expectedRevision'],
        additionalProperties: false,
      },
      annotations: writeAnnotations('删除运行时脚本（需 confirm）', true),
      scope: 'loopback internal（破坏性写，map_save 才落盘）',
      handler: async (args) => {
        assertWritable(ctx, 'script_delete')
        const listed = await runtimeFileRevision(ctx, args.mapId)
        const hit = listed.files.find((file) => file.id === String(args.fileId))
        if (!hit) {
          fail({
            code: 'SCRIPT_NOT_FOUND',
            message: `fileId=${args.fileId} 不在运行时脚本表里`,
            retry: false,
            hint: `可见文件：${listed.files.map((file) => `${file.id}(${file.name})`).join(', ') || '（空）'}。` +
              '引擎 deleteScript 对未知 id 返回 "File not found"，所以这里先挡住。',
          })
        }
        await requireClientRevision({
          current: listed.revision,
          expected: args.expectedRevision,
          kind: '运行时脚本表',
          authority: 'mcp-layer（引擎脚本工具无 CAS）',
          allowUnhedged: args.allowUnhedged,
          next: 'script_list_runtime',
        })
        if (args.confirm !== true) {
          return {
            dryRun: true,
            wouldDelete: { fileId: hit.id, name: hit.name, isClient: hit.isClient },
            revision: listed.revision,
            next: `带 confirm:true 且 expectedRevision=${listed.revision} 再调一次即真删；删掉的运行时文件在本层不可回滚。`,
          }
        }
        const result = await callEngineTool(ctx, args.mapId, 'deleteScript', { fileId: String(args.fileId) })
        return { ...result, revisionAfter: (await runtimeFileRevision(ctx, args.mapId)).revision, note: MOUNT_NOTE }
      },
    },
  ]
}

/**
 * Local, non-authoritative preview of what the engine's op list will produce.
 * Used only for the pre-flight type gate: the engine applies the same ops
 * against the same base text (entity-tools.ts:124-144), so an obviously broken
 * result never reaches the runtime. Order follows the engine's own dispatch.
 */
export function applyOperations(text, operations) {
  let out = String(text || '')
  for (const op of operations) {
    if (op.type === 'insert') out = out.slice(0, op.index) + op.text + out.slice(op.index)
    else if (op.type === 'remove') out = out.slice(0, op.index) + out.slice(op.index + (op.count ?? 1))
  }
  return out
}

export { contentDigest }
