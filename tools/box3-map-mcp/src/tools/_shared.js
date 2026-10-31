/**
 * Shared guard layer for the WRITE tool domains (terrain / entity / model / ui /
 * script-runtime / map-ops).
 *
 * Why this file exists: every write domain needs the same four things — a
 * loopback HTTP call into the Creator internal map-authoring surface, an
 * optimistic-lock check that refuses instead of overwriting, a budget that
 * refuses before the engine does, and a translation of upstream failure into
 * "what should the model do next". Duplicating that per domain is how a guard
 * gets missed in one of them.
 *
 * Upstream surface (verified against the source, not assumed):
 *   - `POST /api/internal/map-authoring/<projectId>/tool`
 *     (`apps/game/pages/api/internal/map-authoring/[projectId]/tool.ts`) forwards
 *     `{tool, args}` to the edit runtime's loopback-only `/internal/ai-tool`
 *     (`services/game-server/src/edit/ai/ai-tool-route.ts`), which executes the
 *     engine's own Vercel-AI-SDK tools verbatim.
 *   - The runtime tools are camelCase (`terrainApply`, `createEntity`, …) and the
 *     router answers `200 {tool, result}` for anything it ran, `409` for the two
 *     conflicts it recognises (`PREVIEW_RUNNING`, `REVISION_CONFLICT`), `400`
 *     with `available` for an unmounted tool, `501` for a tool without
 *     `execute`, `413` above 32 MiB.
 *   - Persistence is a SEPARATE call: `POST …/save` (loopback) forwards to
 *     `/internal/save-local-project`. A runtime write that is never saved only
 *     lives in the in-memory replica.
 */
import { createHash } from 'node:crypto'

/**
 * Budgets. Numbers are derived from the upstream limits, not picked for taste:
 *
 * TERRAIN_MAX_CELLS_PER_CALL = 100_000
 *   The engine itself refuses above 500_000 cells (`map-authoring-tools.ts:286`),
 *   but the rollback pair is what actually binds: `terrainApply` returns
 *   `undoToken = JSON.stringify([{x,y,z,prev}…])`, roughly 45-60 B per cell, and
 *   `terrainRevert` has to send those bytes BACK through two 32 MiB body limits
 *   (Next `tool.ts:140-146` and the runtime router `ai-tool-route.ts:41`).
 *   100_000 cells ≈ 6 MiB of undoToken: one order of magnitude of headroom, and
 *   a 500k region would produce ~30 MiB which sits exactly on the refusal line.
 *
 * ENTITY_MAX_PER_CALL = 200
 *   Each entity is its own `replica.projectTransaction()` commit
 *   (`entity-tools.ts:283-318`), so a batch is N transactions, not one. 200
 *   keeps a single MCP call inside the 20 s default request budget while the
 *   engine's own `listEntities` only ever echoes 50 rows back.
 *
 * UI_MAX_NODES_PER_CALL = 100
 *   Same shape as entities (one transaction per `uiNodeAdd`).
 *
 * SCRIPT_MAX_OPS_PER_CALL = 200, SCRIPT_MAX_CONTENT_BYTES = 2 MiB
 *   `updateScript` applies character-index based insert/remove ops against the
 *   initial text (`entity-tools.ts:105-154`); more than a couple of hundred ops
 *   on a multi-MB file is where an off-by-one silently corrupts the script.
 *   2 MiB is well under the 20 MiB ceiling `script_write` already enforces
 *   (`script-write.js:29`), so the two write paths stay comparable.
 *
 * ARG_JSON_MAX_BYTES = 8 MiB
 *   Cheap pre-check on the serialized args so a runaway region array fails here
 *   with an actionable hint instead of as an upstream 413.
 */
export const BUDGETS = {
  TERRAIN_MAX_CELLS_PER_CALL: 100_000,
  ENTITY_MAX_PER_CALL: 200,
  UI_MAX_NODES_PER_CALL: 100,
  SCRIPT_MAX_OPS_PER_CALL: 200,
  SCRIPT_MAX_CONTENT_BYTES: 2 * 1024 * 1024,
  ARG_JSON_MAX_BYTES: 8 * 1024 * 1024,
}

/** Engine-side hard ceiling reported by `map-authoring-tools.ts:286`. */
export const ENGINE_TERRAIN_CELL_LIMIT = 500_000

/** Matches the upstream fetch budget: Next `tool.ts` uses AbortSignal.timeout(120_000). */
export const WRITE_TIMEOUT_MS = 120_000

export const INTERNAL_PREFIX = '/api/internal/map-authoring'

/**
 * THE AUTHORITATIVE COVERAGE TABLE — the engine's AI tool face, read out of the
 * source, not out of a document:
 *
 *   services/game-server/src/edit/ai/entity-tools.ts
 *     createScriptTools   : listScripts:37 readScript:55 updateScript:75
 *                           createScript:156 deleteScript:222                (5)
 *     createEntityTools   : createEntity:254 deleteEntity:321 updateEntity:346
 *                           listEntities:446 moveEntity:468 copyEntities:501
 *                           getProjectModels:609 searchPublicModels:655
 *                           addModelToProject:676 createEntityFromModel:685  (10)
 *   services/game-server/src/edit/ai/map-authoring-tools.ts
 *     createMapAuthoringTools: terrainInfo:180 terrainRead:196 terrainApply:226
 *                           terrainRevert:318 uiTreeRead:354 uiNodeAdd:378
 *                           uiNodeRemove:437                                 (7)
 *   = 22 tools, exactly what `AiServer.this.tools` bundles; N12 adds the four
 *     block-catalog helpers (blockCatalog/getBlock/resolvePalette/searchBlocks)
 *     -> 26.
 *     (ai-server.ts:300-304: {...entityTools, ...scriptTools, ...mapAuthoringTools}).
 *
 * The loopback headless router mounts only 17 of them: `ai-tool-route.ts:78-91`
 * spreads `createMapAuthoringTools + createEntityTools` and its spec
 * (createServer.ts:649-654) carries `{replica, state, gameId, logger}` — while
 * `createScriptTools(state, codeEditor, logger)` (entity-tools.ts:31-35) needs
 * `spec.codeEditorController`, which the route never passes. That is why the
 * script domain below exists and refuses with ENGINE_TOOL_NOT_MOUNTED instead
 * of silently pretending the capability is absent.
 */
export const ENGINE_AI_TOOL_SOURCES = {
  entityTools: 'services/game-server/src/edit/ai/entity-tools.ts',
  mapAuthoringTools: 'services/game-server/src/edit/ai/map-authoring-tools.ts',
  headlessRouter: 'services/game-server/src/edit/ai/ai-tool-route.ts',
  aiServerBundle: 'services/game-server/src/edit/ai/ai-server.ts',
}

/** MCP tool name -> the engine tool(s) it drives. Arrays = one tool, two engines. */
export const ENGINE_TOOL_FOR_MCP_TOOL = {
  terrain_info: 'terrainInfo',
  terrain_blocks: ['blockCatalog', 'getBlock', 'resolvePalette', 'searchBlocks'],
  terrain_read: 'terrainRead',
  terrain_apply: 'terrainApply',
  terrain_revert: 'terrainRevert',
  entity_list: 'listEntities',
  entity_create: ['createEntity', 'createEntityFromModel'],
  entity_update: 'updateEntity',
  entity_move: 'moveEntity',
  entity_delete: 'deleteEntity',
  entity_copy: 'copyEntities',
  model_list: 'getProjectModels',
  model_search_public: 'searchPublicModels',
  model_add_to_project: 'addModelToProject',
  ui_tree_read: 'uiTreeRead',
  ui_node_add: 'uiNodeAdd',
  ui_node_remove: 'uiNodeRemove',
  script_list_runtime: 'listScripts',
  script_read_runtime: 'readScript',
  script_create: 'createScript',
  script_patch: 'updateScript',
  script_delete: 'deleteScript',
}

/** Engine tool -> the MCP tool that drives it (`headless` = reachable via /internal/ai-tool). */
export const ENGINE_AI_TOOLS = [
  ...Object.entries(ENGINE_TOOL_FOR_MCP_TOOL).flatMap(([mcp, engine]) =>
    (Array.isArray(engine) ? engine : [engine]).map((name) => ({
      engineTool: name,
      mcpTool: mcp,
      headless: !['listScripts', 'readScript', 'createScript', 'updateScript', 'deleteScript'].includes(name),
    })),
  ),
].sort((a, b) => (a.engineTool < b.engineTool ? -1 : 1))

/**
 * The shape `map_tool_catalog` consumes: label -> engine tool name. Used to tell
 * an agent, from the LIVE engine, which of the 22 are actually mounted right now.
 */
export const ENGINE_TOOLS_USED = Object.fromEntries(
  ENGINE_AI_TOOLS.map((row) => {
    if (row.mcpTool === 'entity_create') {
      // Keep the historical `entity_create` label for createEntity and suffix
      // only the second engine it drives, so existing reports stay stable.
      return [
        row.engineTool === 'createEntity' ? 'entity_create' : `entity_create#${row.engineTool}`,
        row.engineTool,
      ]
    }
    const driven = ENGINE_TOOL_FOR_MCP_TOOL[row.mcpTool]
    // One MCP tool driving several engine tools needs a unique label per engine
    // tool, otherwise map_tool_catalog would silently under-report coverage.
    return [Array.isArray(driven) && driven.length > 1 ? `${row.mcpTool}#${row.engineTool}` : row.mcpTool, row.engineTool]
  }),
)

/** Error carrying the "next step" fields an autonomous agent needs. */
export class WriteGuardError extends Error {
  constructor({ code, message, retry = false, hint, status, fromUpstream = false, ...extra }) {
    super(message)
    this.name = 'WriteGuardError'
    this.code = code
    this.retry = retry
    this.hint = hint
    this.status = status
    /**
     * True when `message` is text that came from the engine rather than from
     * this layer. `errors.js errorPayload()` replaces such a message with the
     * MCP-authored sentence for that code and parks the original under
     * `detail.upstreamMessage`; a locally raised refusal keeps its own
     * (more specific, already structured) message.
     */
    this.fromUpstream = fromUpstream
    this.detail = Object.keys(extra).length ? extra : undefined
  }
}

export function fail(spec) {
  throw new WriteGuardError(spec)
}

/** mapId has to survive BOTH guards: the engine's `isValidProjectId` and our own. */
export function assertMapId(ctx, mapId) {
  const value = String(mapId || '').trim()
  if (!value) {
    fail({
      code: 'MAP_ID_REQUIRED',
      message: 'mapId 不能为空',
      hint: '先调 map_list 拿 permanentMapId 或本地工程目录名，再带 mapId 重试。',
    })
  }
  if (!ctx.config.projectIdPattern.test(value) && !ctx.config.mapIdentityPattern.test(value)) {
    fail({
      code: 'INVALID_PROJECT_ID',
      message: `mapId "${value}" 不是引擎接受的形态`,
      hint:
        '写路由只接受 ^[a-z0-9][a-z0-9-]{0,62}$（本地工程目录名）或 20 位小写十六进制的永久地图 ID' +
        '（_guard.ts:44 isValidProjectId）。大小写、下划线、空格都会被 400 拒；先 map_list 核对。',
    })
  }
  return value
}

export function internalPath(ctx, mapId, suffix) {
  return `${INTERNAL_PREFIX}/${encodeURIComponent(mapId)}/${suffix}`
}

/**
 * Loopback-internal routes carry no creator/v1 scope, so they are called WITHOUT
 * a `capability`: `engine-client.requestHeaders` only demands the CLI token when a
 * capability is declared. The real boundary is the loopback socket check.
 */
export async function callInternal(ctx, mapId, suffix, { method = 'GET', body, timeoutMs, tool } = {}) {
  const id = assertMapId(ctx, mapId)
  try {
    const response = await ctx.request({
      path: internalPath(ctx, id, suffix),
      method,
      body,
      timeoutMs: timeoutMs || ctx.config.timeoutMs,
    })
    return response
  } catch (error) {
    throw translateUpstream(error, { mapId: id, suffix, tool })
  }
}

/**
 * One engine AI-tool call. Returns the engine's in-band result object on success;
 * anything the tool reports as `success:false` is raised as a structured error,
 * because a write tool that returns `isError:false` over a refusal is exactly how
 * an agent ends up believing it edited a map it did not.
 */
export async function callEngineTool(ctx, mapId, engineTool, args, { timeoutMs } = {}) {
  const payload = { tool: engineTool, args: args || {} }
  const serialized = JSON.stringify(payload)
  const bytes = Buffer.byteLength(serialized, 'utf8')
  if (bytes > BUDGETS.ARG_JSON_MAX_BYTES) {
    fail({
      code: 'ARGS_BUDGET_EXCEEDED',
      message: `${engineTool} 的参数体积 ${bytes} B 超过本层上限 ${BUDGETS.ARG_JSON_MAX_BYTES} B`,
      hint: '把请求拆成多次调用（体素按 region 分块、实体按数组分片），不要一次推一个巨型对象。',
      bytes,
      limit: BUDGETS.ARG_JSON_MAX_BYTES,
    })
  }
  const response = await callInternal(ctx, mapId, 'tool', {
    method: 'POST',
    body: payload,
    timeoutMs: timeoutMs || WRITE_TIMEOUT_MS,
    tool: engineTool,
  })
  const wrapped = response.data || {}
  const result = wrapped.result === undefined ? wrapped : wrapped.result
  if (result && result.success === false) {
    throw translateUpstream(
      Object.assign(new Error(result.error || `${engineTool} 未成功`), {
        code: result.code || 'ENGINE_REFUSED',
        status: response.httpStatus,
        detail: result,
      }),
      { mapId, tool: engineTool },
    )
  }
  return result
}

/**
 * The whole point of this table: a model cannot act on "HTTP 409". Every branch
 * returns `{code, retry, hint}` where `hint` names the tool to call next.
 * `retry` means "same call, after you do the hint" — never "loop freely".
 */
const UPSTREAM_TRANSLATIONS = {
  ENGINE_UNREACHABLE: () => ({
    code: 'ENGINE_UNREACHABLE',
    retry: true,
    hint:
      '连不上 Creator。确认 BOX_CREATOR_BASE_URL 指向正在运行的实例（默认 http://127.0.0.1:3127）；' +
      '若 Creator 在容器里且宿主没发布端口，就得把本 MCP 跑进同一网络命名空间。engine_health 是最快的探针。',
  }),
  ENGINE_TIMEOUT: () => ({
    code: 'ENGINE_TIMEOUT',
    retry: true,
    hint:
      '引擎侧超时。terrainRevert 的 undoToken 可能有数 MB；先调小区域/批量，' +
      '或加大 BOX_MCP_TIMEOUT_MS（上游本身有 120 s 的预算）。',
  }),
  CLI_TOKEN_MISSING: () => ({
    code: 'CLI_TOKEN_MISSING',
    retry: false,
    hint: '设置 BOX_CREATOR_CLI_TOKEN（bxc_ 前缀）。内部写路由本身只要 loopback，creator/v1 读路由需要它。',
  }),
  FORBIDDEN: () => ({
    code: 'NOT_LOOPBACK',
    retry: false,
    hint:
      'map-authoring 内部路由只接受 loopback socket peer（_guard.ts:20-36）。' +
      '把 MCP 和 Creator 放同一台主机/同一容器网络，别用反向代理转发过来。',
  }),
  INVALID_PROJECT_ID: () => ({
    code: 'INVALID_PROJECT_ID',
    retry: false,
    hint: 'mapId 形态不合 _guard.ts:44。先 map_list 拿 permanentMapId 或工程目录名。',
  }),
  INVALID_BODY: () => ({
    code: 'INVALID_TOOL_BODY',
    retry: true,
    hint: '上游要求 body 形如 {tool, args}；这是本层的装配问题，检查工具名是否为空。',
  }),
  INVALID_ACTION: () => ({
    code: 'INVALID_PREVIEW_ACTION',
    retry: false,
    hint: 'map_preview 的 action 只能是 start 或 stop。',
  }),
  UNKNOWN_TOOL: (context) => ({
    code: 'ENGINE_TOOL_NOT_MOUNTED',
    retry: false,
    hint:
      `引擎的 /internal/ai-tool 没有挂载 "${context.tool || '?'}"（可用清单见 detail.available）。` +
      '脚本域的 listScripts/createScript/readScript/updateScript/deleteScript 只进了 AiServer（编辑器面板），' +
      'headless 路由当前取不到：等泳道 B/C 把 createScriptTools 并进来。' +
      '脚本正文请继续用 script_write（它有 CAS + 类型门 + 读回校验）。',
  }),
  TOOL_NOT_EXECUTABLE: (context) => ({
    code: 'ENGINE_TOOL_NOT_IMPLEMENTED',
    retry: false,
    hint:
      `"${context.tool || '?'}" 在引擎里声明了但没有 execute（addModelToProject 就是这种空壳，` +
      'entity-tools.ts:676-683）。这一条要等泳道 B/C 落地，换 tool 或换路径都没用。',
  }),
  TOOL_ARGS_INVALID: () => ({
    code: 'ENGINE_ARGS_INVALID',
    retry: true,
    hint:
      '引擎 zod 校验没过，detail.issues 是原样的 zod issue（path + code + message）。' +
      '按 path 改字段再重试；不要靠猜，字段定义就在本工具 description 里。',
  }),
  PREVIEW_RUNNING: () => ({
    code: 'PREVIEW_RUNNING',
    retry: true,
    hint:
      '预览在跑时体素保存不会记 chunk（replica-server.ts:1602）。固定顺序：' +
      'map_preview {action:"stop"} → 写入 → map_save；只改内存态可传 allowWhileRunning:true（但别指望落盘）。',
  }),
  REVISION_CONFLICT: () => ({
    code: 'REVISION_CONFLICT',
    retry: true,
    hint:
      '乐观锁没过：有人（编辑器或另一个 agent）在你读之后改过这块内容。' +
      '重新读一次拿新的 revision（terrain 用 terrain_info/terrain_read，UI 用 ui_tree_read，' +
      '实体用 entity_list），再带 expectedRevision 重试。绝不覆盖式写入。',
  }),
  RUNTIME_NOT_ACTIVE: () => ({
    code: 'RUNTIME_NOT_ACTIVE',
    retry: false,
    hint:
      '这张图当前没有打开的编辑运行时，headless 写工具无处落地。' +
      '先在 Creator 里打开这张图的编辑器（9966/9967 运行时进程存在），再用 map_status 确认 runtimeActive:true。',
  }),
  BODY_TOO_LARGE: () => ({
    code: 'BODY_TOO_LARGE',
    retry: false,
    hint: '请求体超过上游 32 MiB。缩小 region / 减少单批数量，分多次调用。',
  }),
  TOOL_EXECUTION_FAILED: () => ({
    code: 'ENGINE_EXECUTION_FAILED',
    retry: true,
    hint:
      '引擎执行抛异常，可能已经部分写入：terrain 用返回过的 undoToken 走 terrain_revert 回滚，' +
      '实体/UI 用 entity_list / ui_tree_read 查出这次新增的 id 再删；确认干净后才重试。',
  }),
  RUNTIME_REQUEST_FAILED: () => ({
    code: 'RUNTIME_REQUEST_FAILED',
    retry: true,
    hint: 'Next 到编辑运行时的转发失败（超时或连接问题）。先 map_status 看 runtimeActive，必要时让人重开编辑器。',
  }),
  NOT_FOUND: () => ({
    code: 'INTERNAL_ROUTE_NOT_DEPLOYED',
    retry: false,
    hint:
      '这个 Creator 里没有 /api/internal/map-authoring/** 这条路由（返回的是 404 页面而不是 JSON）。' +
      '该路由随 5266e19 之后才存在：把 MCP 指向用当前分支构建的 Creator，或先 engine_health 看镜像版本。',
  }),
  /**
   * The engine also refuses with a bare `{success:false, error:"…"}` and no code
   * at all (`entity-tools.ts:214`, `:305`, `:441`; `map-authoring-tools.ts:221`).
   * Translating it keeps the contract (`code` + `hint`) instead of dumping the
   * raw editor prose on the caller.
   */
  ENGINE_REFUSED: (context) => ({
    code: 'ENGINE_REFUSED',
    retry: false,
    hint:
      `引擎的 ${context.tool || '该工具'} 用不带错误码的 success:false 拒绝（原文在 detail.upstreamMessage）。` +
      '按原文修参数，然后用对应域的 *_list / *_read 读回现状再决定下一步；这一类重试同一次调用不会变好。',
  }),
  EMPTY_REGION: () => ({
    code: 'TERRAIN_REGION_EMPTY',
    retry: false,
    hint: 'region 和地形求交后一个格子都不剩。先 terrain_info 拿 shape，把 min/max 夹回 [0,shape) 内。',
  }),
  TOO_LARGE: () => ({
    code: 'TERRAIN_ENGINE_LIMIT',
    retry: false,
    hint:
      `引擎侧 region 超过 ${ENGINE_TERRAIN_CELL_LIMIT} 格直接拒（map-authoring-tools.ts:286）；` +
      `本层更早一步就停在 ${BUDGETS.TERRAIN_MAX_CELLS_PER_CALL} 格。把 region 切成若干 <= ${BUDGETS.TERRAIN_MAX_CELLS_PER_CALL} 格的块。`,
  }),
  SCRIPT_NOT_FOUND: () => ({
    code: 'SCRIPT_NOT_FOUND',
    retry: false,
    hint: 'fileId 不存在。脚本域的运行时文件列表当前拿不到（见 ENGINE_TOOL_NOT_MOUNTED），改用 script_list 的 entry 定位。',
  }),
  ENTITY_NOT_FOUND: () => ({
    code: 'ENTITY_NOT_FOUND',
    retry: false,
    hint: 'entityId 不在这张图的实体树里。先 entity_list 取真实 id（id 是引擎随机数字串，不是名字），再重试。',
  }),
  MODEL_NOT_FOUND: () => ({
    code: 'MODEL_NOT_FOUND',
    retry: false,
    hint: 'modelId 不在工程资产里。先 model_list 拿 id；要往工程里加公共模型目前引擎是空壳（ENGINE_TOOL_NOT_IMPLEMENTED）。',
  }),
}

/**
 * @param {unknown} error EngineError / WriteGuardError / anything
 * @param {{mapId?:string, suffix?:string, tool?:string}} context
 */
export function translateUpstream(error, context = {}) {
  if (error instanceof WriteGuardError) return error
  const rawCode = error && error.code ? String(error.code) : ''
  const status = error && typeof error.status === 'number' ? error.status : undefined
  const detail = (error && error.detail) || {}
  // A 404 from Next's app router is an HTML page with no `code`; anything that
  // looks like markup means "the route does not exist", not "your args are wrong".
  const looksHtml = typeof detail.raw === 'string' && detail.raw.trimStart().startsWith('<')
  // REAL SHAPE OF THE UPSTREAM: `ai-tool-route.ts:198` answers the two in-band
  // refusals (`PREVIEW_RUNNING`, `REVISION_CONFLICT`) as HTTP 409 with the body
  // `{tool, result:{success:false, code, error}}` — the refusal code is NESTED
  // under `result`, so reading only `body.code` would report every one of them
  // as an opaque `HTTP_409`. Both places are consulted now.
  const nestedCode = detail.result && typeof detail.result.code === 'string' ? detail.result.code : ''
  const engineCode =
    typeof detail.code === 'string' && detail.code
      ? detail.code
      : nestedCode || (looksHtml ? 'NOT_FOUND' : rawCode)
  const translated = UPSTREAM_TRANSLATIONS[engineCode] || UPSTREAM_TRANSLATIONS[rawCode]
  // The engine's own prose (and any HTTP error string) is never allowed to sit in
  // the top-level `message`: it is parked under `detail.upstreamMessage`,
  // truncated, and `fromUpstream` tells `errorPayload()` to substitute ours.
  const upstreamMessage = truncateUpstreamText(
    (typeof detail.result?.error === 'string' && detail.result.error) ||
      (typeof detail.error === 'string' && detail.error) ||
      (error && error.message) ||
      '',
  )
  if (!translated) {
    return new WriteGuardError({
      // Upstream body FIRST so our own labels always win the keys
      // (`code`/`message`/`hint`/`status`), while everything else the engine
      // returned (`available`, `issues`, `currentRevision`, …) stays flat in
      // `detail` where an agent looks for it.
      ...safeBody(detail),
      code: engineCode || rawCode || (status ? `HTTP_${status}` : 'ENGINE_CALL_FAILED'),
      message: error && error.message ? error.message : String(error),
      retry: status >= 500,
      hint:
        `上游没有给出可翻译的错误码（status=${status ?? 'n/a'} code=${engineCode || rawCode || 'n/a'}）。` +
        '先 map_status + engine_health 定位是路由缺失、运行时没开还是参数不对，再重试；detail 里带了原始响应。',
      status,
      fromUpstream: true,
      upstreamMessage,
      upstream: { code: engineCode || rawCode, message: upstreamMessage },
    })
  }
  const { code, retry, hint } = translated({ ...context, status })
  return new WriteGuardError({
    ...safeBody(detail),
    code,
    message: error && error.message ? error.message : `${code}`,
    retry,
    hint,
    status,
    fromUpstream: true,
    upstreamMessage,
    upstream: { code: engineCode || rawCode, status },
  })
}

/** Only plain JSON-ish keys reach the payload; never a function, never a stack. */
function safeBody(body) {
  const out = {}
  for (const [key, value] of Object.entries(body || {})) {
    if (key === 'stack' || typeof value === 'function') continue
    // The router wraps a tool refusal as `{tool, result:{…}}`; an agent wants
    // `detail.currentRevision` / `detail.issues`, not a second nesting level.
    if (key === 'result' && value && typeof value === 'object' && !Array.isArray(value)) Object.assign(out, safeBody(value))
    else out[key] = value
  }
  return out
}

/** Keep the quarantined upstream text bounded so a hostile/verbose body cannot flood the context. */
function truncateUpstreamText(value) {
  const text = String(value ?? '')
  return text.length > 300 ? `${text.slice(0, 300)}…(截断)` : text
}

/** Deterministic short token for the optimistic locks the ENGINE does not provide. */
export function snapshotRevision(kind, canonical) {
  const digest = createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex')
  return `${kind}:${digest.slice(0, 16)}`
}

/**
 * Client-side CAS. REAL LIMITATION, stated in-band rather than hidden:
 * the entity/UI-remove/script tools in `services/game-server/src/edit/ai/` have
 * no `expectedRevision` at all, so this check runs in this process, immediately
 * before the engine call. It is check-then-write, not atomic: it catches the
 * realistic races (agent ↔ human editor, agent ↔ agent, an agent re-applying a
 * stale plan) but cannot exclude a write that lands between the read and the
 * call. `revisionAuthority` says which side actually holds the lock.
 */
export async function requireClientRevision({ current, expected, kind, authority, allowUnhedged, next }) {
  const value = typeof expected === 'string' ? expected : undefined
  if (value === undefined) {
    if (allowUnhedged === true) {
      return { enforced: false, current, reason: 'allowUnhedged:true，本次未做乐观锁' }
    }
    fail({
      code: 'EXPECTED_REVISION_REQUIRED',
      message: `${kind} 写入必须带 expectedRevision（引擎侧这类工具没有 CAS，锁在本层）`,
      retry: false,
      hint:
        `把 ${next} 返回的 revision 原样带回来即可（当前值：${current ?? '读不到'}）。` +
        '确认不需要锁才传 allowUnhedged:true。',
      currentRevision: current,
      revisionAuthority: authority,
    })
  }
  if (current === undefined) {
    if (allowUnhedged === true) return { enforced: false, current, reason: '当前 revision 不可读，且 allowUnhedged:true' }
    fail({
      code: 'REVISION_UNAVAILABLE',
      message: `${kind} 的当前 revision 读不出来，无法做乐观锁`,
      retry: false,
      hint: `先确认 ${next} 能读到内容（运行时是否已打开：map_status），再重试。`,
      revisionAuthority: authority,
    })
  }
  if (value !== current) {
    fail({
      code: 'REVISION_CONFLICT',
      message: `乐观锁失败：expectedRevision=${value} 与当前 ${current} 不一致，${kind} 已被改动`,
      retry: true,
      hint: `重新 ${next} 取新的 revision，核对差异后再写；本层不会覆盖。`,
      expected: value,
      current,
      revisionAuthority: authority,
    })
  }
  return { enforced: true, current, authority }
}

/**
 * Terrain regions: the engine clamps to bounds and refuses an empty intersection,
 * so the cell count we budget on has to be the CLAMPED count or the budget is
 * fiction. shape comes from terrain_info.
 */
export function terrainCellCount(region, shape) {
  const [sx, sy, sz] = shape
  const spans = [0, 1, 2].map((axis) => {
    const low = Math.max(0, Math.trunc(region.min[axis]))
    const high = Math.min(shape[axis] - 1, Math.trunc(region.max[axis]))
    return Math.max(0, high - low + 1)
  })
  return spans[0] * spans[1] * spans[2]
}

/**
 * Danger surface. The engine's script sandbox is already scoped, but these write
 * tools accept free-form JSON that ends up either as script text or as values a
 * running map reads back, so eval/Function-style payload injection is refused
 * here rather than discovered at play time. Mirrors the posture of the type gate
 * (lane E's `typegate.js`, which is only ever called from here, never edited).
 */
const DANGEROUS_PATTERNS = [
  ['EVAL', /\beval\s*\(/, 'eval(...) 会把地图数据面变成任意代码执行面'],
  ['FUNCTION_CTOR', /new\s+Function\s*\(/, 'new Function(...) 等价于 eval，沙箱外照样能跑'],
  ['FUNCTION_ALIAS', /globalThis\s*\[\s*['"]Function['"]/, '通过 globalThis 取 Function 是绕门的写法'],
  ['WASM', /WebAssembly\s*\.\s*(instantiate|compile)/, 'WebAssembly 编译不在地图脚本的支持面内'],
  ['DYNAMIC_IMPORT', /\bimport\s*\(/, '动态 import() 的说明符在沙箱里不可解析'],
  ['PROTOTYPE_POLLUTION', /__proto__/, '__proto__ 键会污染原型链'],
  ['NODE_FS', /require\s*\(\s*['"](fs|child_process|net|http|https)['"]\s*\)/, 'node 内置模块在地图脚本沙箱里不存在'],
]

export function dangerScan(value, field, seen = new Set()) {
  if (value === null || value === undefined) return
  if (typeof value === 'string') {
    for (const [name, rule, why] of DANGEROUS_PATTERNS) {
      if (rule.test(value)) {
        fail({
          code: 'DANGEROUS_CONTENT_BLOCKED',
          message: `${field} 命中危险面 ${name}`,
          retry: false,
          hint: `${why}。生产级地图不接受这条路：把逻辑写成显式的脚本调用，走 script_write（那里有类型门 + 读回校验）。`,
          field,
          rule: name,
        })
      }
    }
    return
  }
  if (typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)
  for (const [key, child] of Object.entries(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      fail({
        code: 'DANGEROUS_CONTENT_BLOCKED',
        message: `${field} 里出现了 ${key} 键`,
        retry: false,
        hint: '原型链键名会被引擎当数据吞掉或污染对象原型，一律禁止。',
        field,
      })
    }
    dangerScan(child, `${field}.${key}`, seen)
  }
}

/** Read-only profile must never reach the engine write surface at all. */
export function assertWritable(ctx, toolName) {
  if (ctx.config.profile === 'readonly' || ctx.config.allowWrite === false) {
    fail({
      code: 'WRITE_DISABLED',
      message: `${toolName} 被禁用：本实例以只读 profile 启动`,
      retry: false,
      hint: 'BOX_MCP_PROFILE=authoring 且 BOX_MCP_ALLOW_WRITE=1 才会暴露写工具。',
    })
  }
}

export const WRITE_TOOL_NAMES = new Set([
  'terrain_apply',
  'terrain_revert',
  'entity_create',
  'entity_update',
  'entity_move',
  'entity_delete',
  'entity_copy',
  'model_add_to_project',
  'ui_node_add',
  'ui_node_remove',
  'script_create',
  'script_patch',
  'script_delete',
  'map_save',
  'map_preview',
])
