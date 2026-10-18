/**
 * MAP-OPS domain: the orchestration ends of the loop that the engine deliberately
 * keeps outside the AI tools — runtime liveness, preview ordering, persistence,
 * and self-discovery of what the running engine actually exposes.
 *
 * Why each exists (all read off the source, not guessed):
 *   - `map_status` / `GET …/status`: writes are only possible while an edit
 *     runtime for this project is alive (`tool.ts:82-92` pre-checks
 *     `/__local_runtime/status` and refuses 409 otherwise).
 *   - `map_preview`: voxel persistence requires the preview to be stopped
 *     (`replica-server.ts:1602`, restated by `save.ts` which refuses 409
 *     `PREVIEW_RUNNING` unless `force`).
 *   - `map_save`: nothing an AI writes reaches disk until
 *     `POST …/save` forwards to `/internal/save-local-project`; it returns the
 *     new `permissionHash`, which is the same chain `map_revision` reads.
 *   - `map_tool_catalog`: the runtime answers its own mounted tool list
 *     (`GET …/tool`), so the MCP can tell — from the live engine, not from a
 *     grep — which write capabilities are still missing.
 */
import { ENGINE_TOOLS_USED, assertWritable, callInternal, fail, internalPath } from './_shared.js'

const readAnnotations = (title) => ({
  title,
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
})

const mapIdProperty = { mapId: { type: 'string', minLength: 1, maxLength: 63 } }

export function buildMapOpsTools(ctx) {
  return [
    {
      name: 'map_status',
      description:
        '这张图现在能不能被 headless 写：编辑运行时是否活着（runtimeActive）、预览是否在跑（preview.running / phase）、' +
        '以及 Next 侧自报的 headlessWriteRoute 状态。写之前先跑它：runtimeActive=false 时任何写都会 409 RUNTIME_NOT_ACTIVE，' +
        '得先在 Creator 里打开这张图的编辑器。副作用：无。',
      inputSchema: { type: 'object', properties: { ...mapIdProperty }, required: ['mapId'], additionalProperties: false },
      annotations: readAnnotations('编辑运行时与写面状态'),
      scope: 'loopback internal（无 creator/v1 scope）',
      handler: async (args) => {
        const response = await callInternal(ctx, args.mapId, 'status', { method: 'GET' })
        const data = response.data || {}
        const preview = data.preview || {}
        const runnable = data.runtimeActive === true
        const previewRunning = preview.running === true || preview.phase === 'running'
        // status.ts still self-reports `headlessWriteRoute:"unavailable"` — that
        // text predates `tool.ts` (box3-re/scan/O4-engine-ai-adaptation.md §7.6
        // U2). The live probe is `map_tool_catalog`, so this tool must NOT let a
        // stale field mask the ordering fact the agent actually needs.
        const staleSelfReport = data.headlessWriteRoute === 'unavailable'
        return {
          httpStatus: response.httpStatus,
          ...data,
          runtimeActive: runnable,
          previewRunning,
          canWrite: runnable,
          canPersistTerrain: runnable && !previewRunning,
          writeRouteSelfReport: data.headlessWriteRoute,
          writeRouteSelfReportIsStale: staleSelfReport,
          next: !runnable
            ? '运行时没开：在 Creator 里打开这张图的编辑器（tool.ts:82-92 会先探 /__local_runtime/status），再 map_status 复测。'
            : previewRunning
              ? '预览在跑：体素写会被拒（replica-server.ts:1602）。先 map_preview {action:"stop"}，写完 map_save，要验收再 map_preview {action:"start"}。'
              : '运行时在线且预览已停：可以 terrain_* / entity_* / ui_*，写完 map_save。' +
                (staleSelfReport ? '本行的 headlessWriteRoute:"unavailable" 是旧文案，用 map_tool_catalog 实测。' : ''),
        }
      },
    },
    {
      name: 'map_tool_catalog',
      description:
        '问引擎本身："这张图的运行时现在挂了哪些 AI 工具"，并自动和本 MCP 依赖的工具名单对比，' +
        '回报 missing（引擎没挂 → 对应 MCP 写工具会报 ENGINE_TOOL_NOT_MOUNTED）与 extra。' +
        '判断"这个能力现在到底能不能用"就靠它，不用猜。副作用：无。',
      inputSchema: { type: 'object', properties: { ...mapIdProperty }, required: ['mapId'], additionalProperties: false },
      annotations: readAnnotations('引擎工具目录与覆盖差集'),
      scope: 'loopback internal（无 creator/v1 scope）',
      handler: async (args) => {
        const response = await callInternal(ctx, args.mapId, 'tool', { method: 'GET' })
        const listed = (response.data && response.data.tools) || []
        const names = listed.map((tool) => tool.name)
        const missing = Object.entries(ENGINE_TOOLS_USED)
          .filter(([, tool]) => !names.includes(tool))
          .map(([domain, tool]) => ({ domain, engineTool: tool }))
        const byDomain = {}
        for (const [domain, tool] of Object.entries(ENGINE_TOOLS_USED)) {
          byDomain[domain] = byDomain[domain] || []
          byDomain[domain].push({ engineTool: tool, mounted: names.includes(tool) })
        }
        return {
          httpStatus: response.httpStatus,
          mountedCount: names.length,
          mounted: names,
          mcpDependsOn: Object.values(ENGINE_TOOLS_USED).length,
          missing,
          byDomain,
          usage: response.data && response.data.usage,
          next: missing.length
            ? `这些引擎工具没挂在 headless 路由上：${missing.map((row) => row.engineTool).join(', ')}。` +
              '对应 MCP 域会直接报 ENGINE_TOOL_NOT_MOUNTED，需要泳道 B/C 在 ai-tool-route.ts 里补挂载；' +
              '脚本正文现在走 script_write。'
            : '引擎侧工具全部就位：地形/实体/模型/UI 写 + map_save 就是完整闭环。',
        }
      },
    },
    {
      name: 'map_preview',
      description:
        '开/停这张图的实时预览（转发运行时的 /internal/creator-preview-runtime）。' +
        '地形写的硬顺序要求先停预览再保存；验收（runtime_events_tail）反过来要求预览在跑。' +
        '所以典型闭环是：map_preview stop → 写 → map_save → map_preview start → runtime_events_tail 看有没有 exception。' +
        '副作用：真启停运行时进程里的预览会话（会断开当前编辑器预览连接）。',
      inputSchema: {
        type: 'object',
        properties: {
          ...mapIdProperty,
          action: { type: 'string', enum: ['start', 'stop'], description: 'start=开预览，stop=停预览' },
        },
        required: ['mapId', 'action'],
        additionalProperties: false,
      },
      annotations: {
        title: '启停实时预览',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      scope: 'loopback internal（控制运行时预览会话）',
      handler: async (args) => {
        assertWritable(ctx, 'map_preview')
        const response = await callInternal(ctx, args.mapId, 'preview', {
          method: 'POST',
          body: { action: args.action },
        })
        const data = response.data || {}
        return {
          httpStatus: response.httpStatus,
          action: args.action,
          ...data,
          next:
            args.action === 'stop'
              ? '预览已停：现在可以 terrain_apply / map_save（体素 chunk 只在预览停止时的保存里记录）。'
              : '预览在跑：验收用 runtime_events_tail；要写地形先 map_preview stop。',
        }
      },
    },
    {
      name: 'map_save',
      description:
        '把当前内存里的编辑结果落盘（转发 /internal/save-local-project，返回 permissionHash）。' +
        '这是整条链的收口：terrain_* / entity_* / ui_* 只改运行时副本，不 map_save 就什么都不留。' +
        '预览在跑时上游会 409 PREVIEW_RUNNING 拒绝（replica-server.ts:1602：运行时不记录 voxel chunk，存了就是丢地形）；' +
        '确实只要存非体素改动才传 force:true。' +
        '写完 map_save 之后用 map_revision 复核 headHash 是否推进。副作用：写工程目录的 blob 与版本链（只增不改）。',
      inputSchema: {
        type: 'object',
        properties: {
          ...mapIdProperty,
          force: {
            type: 'boolean',
            description: '预览仍在跑时也要保存（会丢体素 chunk 记录，默认 false）',
          },
        },
        required: ['mapId'],
        additionalProperties: false,
      },
      annotations: {
        title: '保存地图到盘（版本链只增）',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      scope: 'loopback internal（写工程目录 / 版本链）',
      handler: async (args) => {
        assertWritable(ctx, 'map_save')
        const response = await callInternal(ctx, args.mapId, 'save', {
          method: 'POST',
          body: args.force === true ? { force: true } : {},
        })
        const data = response.data || {}
        let diskRevision
        let revisionError
        if (ctx.store && ctx.store.available) {
          try {
            diskRevision = ctx.store.readRevision(args.mapId).headHash
          } catch (error) {
            revisionError = { code: error.code, message: error.message }
          }
        }
        return {
          httpStatus: response.httpStatus,
          ...data,
          forced: args.force === true,
          diskHeadHash: diskRevision,
          revisionReadbackError: revisionError,
          next:
            args.force === true
              ? 'force 保存完成，但预览在跑时体素 chunk 不入盘：地形改动要重做一遍（先停预览再存）。'
              : '已落盘：用 map_revision 复核 headHash、用 map_list 看 status；要跑验收就 map_preview start 再 runtime_events_tail。',
        }
      },
    },
  ]
}

export { internalPath, fail }
