/**
 * Tool registry. Two layers, merged into ONE advertised face:
 *
 *   1. the slice-A base face (`buildBaseTools` below): 11 readers mapped onto an
 *      existing, already-scoped `creator/v1` route or computed purely locally,
 *      plus the single disk writer `script_write`. The scope column matters:
 *      nothing here asks for a capability outside the factory nine in
 *      `apps/game/shared/creator-cli-policy.ts:5-15`.
 *   2. the write domains (`./tools/index.js`): terrain / entity / model / ui /
 *      script-runtime / map-ops, driven over the loopback
 *      `/api/internal/map-authoring/<id>/{tool,status,preview,save}` surface
 *      with no creator/v1 scope (that boundary is the loopback socket check).
 *
 * `buildTools()` is what `server.js` and `index.js` consume; it is the merged,
 * duplicate-checked, profile-filtered face. Before P0-A the domains existed but
 * nothing imported them, so `tools/list` advertised layer 1 only and every
 * `terrain_* / entity_* / model_* / ui_* / script_* / map_*` name was dead code.
 */
import { checkScript, describeContract } from './typegate.js'
import { writeScript } from './script-write.js'
import { judgeEvents } from './acceptance.js'
import { verifyBlobName } from './cid.js'
import { buildDomainTools, mergeToolSets, isWriteTool } from './tools/index.js'

const mapIdSchema = {
  type: 'string',
  description: '地图标识：永久地图 ID（20 位十六进制）或本地工程目录名，两者引擎都认（project-manager.js:974-988）',
  minLength: 1,
  maxLength: 63,
}

const scriptReference = {
  side: {
    type: 'string',
    enum: ['client', 'server'],
    description: '脚本侧：server 走服务端 isolate，client 走客户端；类型位 1/7（project-manager.js:2170）',
  },
  entry: {
    type: 'string',
    pattern: '^[A-Za-z0-9._-]{1,160}$',
    description: '脚本文件名。index.js / clientIndex.js 是 map-local，其余默认进地图组共享表',
  },
}

/**
 * REAL DATA: the two sides are not loaded by the same kind of module system, so
 * `dialect` has no single default. server `index.js` = CommonJS wrapper
 * (`resource.ts:387-405` injects require/module/exports, `safe-eval.ts:36-52`
 * evaluates a function body); client `clientIndex.js` = ES module executed from
 * an Import Map inside an iframe (`ses-client.ts:283-294` + `:318-353`).
 */
const dialectSchema = {
  type: 'string',
  enum: ['cjs', 'esm'],
  description:
    '脚本方言；不传时按 side 取默认：server=cjs、client=esm（客户端脚本实测就是 ESM，' +
    'require/module.exports 在那个沙箱里不存在）。显式传值会覆盖默认，并在返回的 dialect/dialectSource 里如实标注。',
}

export function buildBaseTools(ctx) {
  const readOnly = (title) => ({
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  })

  const tools = [
    {
      name: 'engine_health',
      description:
        '引擎健康检查。唯一不需要鉴权的 creator/v1 路由，用来确认基地址、镜像版本与部署模式。副作用：无。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: readOnly('Creator 引擎健康检查'),
      scope: '（无需 token）',
      handler: async () => {
        const response = await ctx.request({ path: '/api/creator/v1/health', method: 'GET' }, ctx.config)
        return { httpStatus: response.httpStatus, ...response.data }
      },
    },
    {
      name: 'map_list',
      description: '列出本地引擎全部工程（地图）。返回 permanentMapId / name / status / mapRole / updatedAt。副作用：无。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: readOnly('地图清单'),
      scope: 'projects.list',
      handler: async () => {
        const response = await ctx.request(
          { path: ctx.apiPath('projects'), method: 'GET', capability: 'projects.list' },
          ctx.config,
        )
        const local = ctx.store && ctx.store.available ? ctx.store.listProjects() : []
        return {
          httpStatus: response.httpStatus,
          count: (response.data.projects || []).length,
          projects: response.data.projects || [],
          localDisk: local.length ? local : undefined,
        }
      },
    },
    {
      name: 'map_resources',
      description:
        '读一张图的资源清单（模型/图片/音频/UI 树索引）。对应 getProjectResources（project-manager.js:2342-2389），' +
        '它内部会走 permissionHash → versionControl → branch.headHash 全链，所以这个工具同时是版本链可用性的探针。副作用：无。',
      inputSchema: {
        type: 'object',
        properties: { mapId: mapIdSchema },
        required: ['mapId'],
        additionalProperties: false,
      },
      annotations: readOnly('地图资源清单'),
      scope: 'resources.list',
      handler: async (args) => {
        const response = await ctx.request(
          {
            path: ctx.apiPath('projects', args.mapId, 'resources'),
            method: 'GET',
            capability: 'resources.list',
          },
          ctx.config,
        )
        const data = response.data || {}
        const count = (value) => (Array.isArray(value) ? value.length : Object.keys(value || {}).length)
        return {
          httpStatus: response.httpStatus,
          projectId: data.projectId,
          counts: {
            modelAssets: count(data.modelAssets),
            pictureAssets: count(data.pictureAssets),
            audioAssets: count(data.audioAssets),
            uiTree: count(data.uiTree),
          },
          resources: data,
        }
      },
    },
    {
      name: 'script_list',
      description:
        '列脚本。HTTP 面只返回地图组共享脚本（listProjectSharedScripts, project-manager.js:2239-2269）；' +
        '配了 BOX_MAP_PROJECTS_ROOT 时额外返回 map-local 入口脚本（index.js / clientIndex.js），' +
        '那两类在 HTTP 面上是读不到的。副作用：无（盘侧只读）。',
      inputSchema: {
        type: 'object',
        properties: { mapId: mapIdSchema },
        required: ['mapId'],
        additionalProperties: false,
      },
      annotations: readOnly('脚本清单'),
      scope: 'scripts.read',
      handler: async (args) => {
        const response = await ctx.request(
          { path: ctx.apiPath('projects', args.mapId, 'scripts'), method: 'GET', capability: 'scripts.read' },
          ctx.config,
        )
        const local = ctx.store && ctx.store.available ? ctx.store.listMapLocalScripts(args.mapId) : undefined
        return {
          httpStatus: response.httpStatus,
          projectId: response.data.projectId,
          sharedScripts: response.data.scripts || [],
          mapLocalScripts: local,
          note: local
            ? undefined
            : 'map-local 脚本未列出：未配置可读的 BOX_MAP_PROJECTS_ROOT。',
        }
      },
    },
    {
      name: 'script_read',
      description:
        '读一份脚本正文 + 内容哈希。shared 脚本走 GET .../scripts/{side}/{entry}；' +
        'map-local 入口脚本 HTTP 必定 404，会自动退回盘上 headHash 链读取。' +
        '盘读会带回 nameForm/contentVerified：blob 名可能是 CIDv0，也可能是 URL-safe SHA-256（云端导入的图两种混在同一个 blobs 目录里），' +
        '两种都按字节复算校验；legacy UUID 形式无法复算，只会报 unverified。副作用：无。',
      inputSchema: {
        type: 'object',
        properties: {
          mapId: mapIdSchema,
          ...scriptReference,
          source: {
            type: 'string',
            enum: ['auto', 'http', 'local'],
            description: 'auto：先 HTTP，map-local 时退盘；http/local：只走一种，便于对照两条路径',
          },
        },
        required: ['mapId', 'side', 'entry'],
        additionalProperties: false,
      },
      annotations: readOnly('读取脚本正文'),
      scope: 'scripts.read',
      handler: async (args) => {
        const source = args.source || 'auto'
        const useLocal = source === 'local' || (source === 'auto' && ['index.js', 'clientIndex.js'].includes(args.entry))
        if (useLocal) {
          if (!ctx.store || !ctx.store.available) {
            throw ctx.guardError(
              'LOCAL_ROOT_MISSING',
              `需要盘读 ${args.entry}，但 BOX_MAP_PROJECTS_ROOT 不可用：${ctx.store ? ctx.store.unavailableReason() : '未初始化'}`,
            )
          }
          return { readBackSource: 'local-disk', ...ctx.store.readMapLocalScript(args.mapId, args.entry, args.side) }
        }
        const response = await ctx.request(
          {
            path: ctx.apiPath('projects', args.mapId, 'scripts', args.side, args.entry),
            method: 'GET',
            capability: 'scripts.read',
          },
          ctx.config,
        )
        const content = response.data.content
        // Both content-addressed name forms have to be accepted here: checking
        // only CIDv0 would report a cloud-imported script as "hash mismatch"
        // when it is perfectly intact.
        const nameCheck = verifyBlobName(content || '', response.data.hash)
        return {
          readBackSource: 'http-shared',
          httpStatus: response.httpStatus,
          ...response.data,
          contentBytes: Buffer.byteLength(content || '', 'utf8'),
          nameForm: nameCheck,
          hashMatchesContent: nameCheck.verifiable ? nameCheck.verified : undefined,
          hashUnverifiableReason: nameCheck.verifiable
            ? undefined
            : `${nameCheck.form} 形式的 blob 名无法从内容复算摘要，本项未验证`,
        }
      },
    },
    {
      name: 'data_read',
      description:
        '读作者数据空间（world.storage 的盘侧对应物）。带 key 返回单值，不带 key 返回分页键列表。' +
        '上限：space 名 [A-Za-z0-9_]{1,50}，key ≤1 KiB，limit 1-100。副作用：无。',
      inputSchema: {
        type: 'object',
        properties: {
          mapId: mapIdSchema,
          scope: { type: 'string', enum: ['project', 'group'] },
          space: { type: 'string', pattern: '^[A-Za-z0-9_]{1,50}$' },
          key: { type: 'string', maxLength: 1024 },
          page: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
        required: ['mapId', 'scope', 'space'],
        additionalProperties: false,
      },
      annotations: readOnly('读数据空间'),
      scope: 'storage.read',
      handler: async (args) => {
        const response = await ctx.request(
          {
            path: ctx.apiPath('projects', args.mapId, 'storage', args.scope, args.space),
            method: 'GET',
            capability: 'storage.read',
            query: { key: args.key, page: args.page, limit: args.limit },
          },
          ctx.config,
        )
        return { httpStatus: response.httpStatus, ...response.data }
      },
    },
    {
      name: 'runtime_status',
      description:
        '预览运行时状态。编辑库不会为未打开的工程分配运行时，所以 idle 是正常态而非故障。副作用：无。',
      inputSchema: {
        type: 'object',
        properties: { mapId: mapIdSchema },
        required: ['mapId'],
        additionalProperties: false,
      },
      annotations: readOnly('预览运行时状态'),
      scope: 'runtime.view',
      handler: async (args) => {
        const response = await ctx.request(
          { path: ctx.apiPath('projects', args.mapId, 'runtime'), method: 'GET', capability: 'runtime.view' },
          ctx.config,
        )
        return { httpStatus: response.httpStatus, ...response.data }
      },
    },
    {
      name: 'runtime_events_tail',
      description:
        '取预览运行期事件尾部（log / exception / clear / status，缓冲上限 500 条、单条 16 KiB）。' +
        '本工具读完自己断流，不会把 SSE 挂住。传 sinceEventId 可利用 Last-Event-ID 重放（服务端只重放 id > N 的，' +
        '所以最早只能从 id=2 起，id=1 与 id=0 的初始 status 帧取不回）。副作用：无。',
      inputSchema: {
        type: 'object',
        properties: {
          mapId: mapIdSchema,
          sinceEventId: { type: 'integer', minimum: 1 },
          maxEvents: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
          idleMs: { type: 'integer', minimum: 100, maximum: 10_000, default: 1500 },
          timeoutMs: { type: 'integer', minimum: 500, maximum: 30_000, default: 15_000 },
          judge: { type: 'boolean', default: true, description: '是否顺带跑 V2 判定（无 exception / 无 MODULE_NOT_FOUND）' },
        },
        required: ['mapId'],
        additionalProperties: false,
      },
      annotations: readOnly('运行期事件尾部与验收判定'),
      scope: 'runtime.view',
      handler: async (args) => {
        const tail = await ctx.tail(
          {
            path: ctx.apiPath('projects', args.mapId, 'runtime', 'events'),
            capability: 'runtime.view',
            lastEventId: args.sinceEventId,
            maxEvents: args.maxEvents ?? 50,
            idleMs: args.idleMs,
            timeoutMs: args.timeoutMs,
          },
          ctx.config,
        )
        const verdict = args.judge === false ? undefined : judgeEvents(tail.events, { sinceId: args.sinceEventId })
        return {
          stopReason: tail.stopReason,
          received: tail.events.length,
          lastEventId: tail.lastEventId,
          events: tail.events,
          verdict,
        }
      },
    },
    {
      name: 'script_typecheck',
      description:
        '落盘前的类型/语法门（V0），纯本地，不碰引擎。mode=language-service 时等价于 ' +
        'apps/game/scripts/check-editor-types.ts:12-54 的 ts.createLanguageService；' +
        'typescript 不可解析时自动降级到 syntax（node:vm 解析 + 声明文件未声明成员提示），并在 mode 里如实报告。副作用：无。',
      inputSchema: {
        type: 'object',
        properties: {
          side: scriptReference.side,
          content: { type: 'string', description: '待校验正文' },
          dialect: dialectSchema,
          mode: { type: 'string', enum: ['auto', 'language-service', 'syntax', 'off'] },
        },
        required: ['side', 'content'],
        additionalProperties: false,
      },
      annotations: { ...readOnly('脚本类型门'), openWorldHint: false },
      scope: '（纯本地，无 HTTP）',
      handler: async (args) => ({
        ...(await checkScript(args, ctx.config)),
        contentBytes: Buffer.byteLength(args.content || '', 'utf8'),
      }),
    },
    {
      name: 'contract_describe',
      description:
        '从出厂声明文件里读出 API 全局与成员名单，供 AI 按签名写脚本而不是凭记忆猜 API。' +
        '纯本地、只读；结论只是提示（真实地图会在 API 对象上挂未声明自定义属性）。副作用：无。',
      inputSchema: {
        type: 'object',
        properties: {
          side: scriptReference.side,
          filter: { type: 'string', description: '只看某个全局名，或只看含该成员的全局' },
        },
        required: ['side'],
        additionalProperties: false,
      },
      annotations: { ...readOnly('API 契约面查询'), openWorldHint: false },
      scope: '（纯本地，无 HTTP）',
      handler: async (args) => describeContract(ctx.config, args.side, args.filter),
    },
    {
      name: 'map_revision',
      description:
        '读引擎的 revision 令牌：project-state.json → permissionHash → versionControl → branch.headHash（盘侧只读）。' +
        '这是 scripts.update 唯一可信的乐观锁凭据（引擎自己不做 CAS）。未配 BOX_MAP_PROJECTS_ROOT 时明确报不可用。副作用：无。',
      inputSchema: {
        type: 'object',
        properties: { mapId: mapIdSchema },
        required: ['mapId'],
        additionalProperties: false,
      },
      annotations: { ...readOnly('地图版本头'), openWorldHint: false },
      scope: '（纯本地盘读，无 HTTP）',
      handler: async (args) => {
        if (!ctx.store || !ctx.store.available) {
          throw ctx.guardError('PROJECTS_ROOT_UNAVAILABLE', ctx.store ? ctx.store.unavailableReason() : '未初始化')
        }
        return ctx.store.readRevision(args.mapId)
      },
    },
    {
      name: 'script_write',
      description:
        '落盘写作者脚本的正路：走 scripts.update 写一份脚本（PUT .../scripts/{side}/{entry}），' +
        '不依赖编辑运行时，引擎离线也能写。terrain_*/entity_*/ui_* 的 script_create/script_patch 只改编辑器内存态且当前不可达，别拿它们当落盘通道。' +
        '默认 confirm:false = dry-run，只返回计划（当前 revision、预测 CIDv0、类型门结论），不写任何东西。' +
        '真写必须带 expectedRevision，与引擎当前 revision 不一致就 REVISION_CONFLICT 拒绝；' +
        '落盘前必过类型门；写后逐字节读回校验，失败自动把原内容写回。副作用：产生新 blob 并推进版本链（引擎侧只增不改）。',
      inputSchema: {
        type: 'object',
        properties: {
          mapId: mapIdSchema,
          ...scriptReference,
          content: { type: 'string', description: '完整正文（整体覆盖，不是补丁）' },
          expectedRevision: {
            type: 'string',
            description: '乐观锁令牌：branch.headHash（有盘读时）或 script_read 的 hash（降级模式）',
          },
          confirm: { type: 'boolean', default: false, description: 'false=dry-run；true 才落盘' },
          dialect: dialectSchema,
          typeGateMode: { type: 'string', enum: ['auto', 'language-service', 'syntax', 'off'] },
          verify: { type: 'boolean', default: false, description: '写后跑 V2 运行期验收（需要预览运行时在跑）' },
          sinceEventId: {
            type: 'integer',
            minimum: 1,
            description: '验收窗口起点：Last-Event-ID 重放只覆盖 id > 此值的事件，用它跳过写入前已有的异常',
          },
          maxEvents: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
          verifyIdleMs: { type: 'integer', minimum: 100, maximum: 10_000, default: 1500 },
          verifyWaitMs: { type: 'integer', minimum: 500, maximum: 30_000, default: 8000 },
          allowUnhedged: { type: 'boolean', default: false, description: '明知无 CAS 也要写（默认禁止）' },
          allowBlindWrite: { type: 'boolean', default: false, description: '明知无回滚原内容也要写（默认禁止）' },
        },
        required: ['mapId', 'side', 'entry', 'content'],
        additionalProperties: false,
      },
      annotations: {
        title: '写入作者脚本（带乐观锁与类型门）',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      scope: 'scripts.update',
      handler: async (args) => writeScript(args, ctx),
    },
  ]

  return tools
}

/**
 * THE MERGED FACE (`tools/list` and `tools/call` both come from here).
 *
 * Duplicate names throw at build time: `server.js` indexes by name with a Map,
 * so a collision would otherwise shadow a tool silently and an agent would call
 * the wrong implementation. Read-only profiles drop every writer — the slice-A
 * one plus the 15 domain writers named in `WRITE_TOOL_NAMES`.
 */
export function buildTools(ctx) {
  const all = mergeToolSets([buildBaseTools(ctx), buildDomainTools(ctx)])
  const readOnlyProfile = ctx.config.profile === 'readonly' || ctx.config.allowWrite === false
  return readOnlyProfile ? all.filter((tool) => !isWriteTool(tool.name)) : all
}
