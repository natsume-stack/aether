/**
 * THE ERROR CONTRACT: every failing tool call, from every layer, leaves this
 * process as
 *
 *   { code, retryable, hint, message, status?, detail?, problems? }
 *
 * Why a table and not just `throw new Error(...)`: the callers are language
 * models. "HTTP 409" and a stack trace are not actionable, and an untranslated
 * engine message is a Chinese sentence written for a human sitting in the editor
 * — it names neither the next tool nor the reason. So:
 *   - `code`      stable machine token, never absent (a missing code is a bug);
 *   - `retryable` "re-issue THIS call after you have done the hint", not "loop";
 *   - `hint`      the concrete next tool call, with the parameter to carry;
 *   - `message`   always this layer's sentence. Engine prose is quarantined in
 *                 `detail.upstreamMessage` (truncated by _shared.js) and stacks
 *                 are never serialized at all.
 *
 * Codes that already arrive with a hint (`WriteGuardError` from the guard layer,
 * src/tools/_shared.js) are passed through untouched; this table exists for the
 * codes raised OUTSIDE that layer — `EngineError` (engine-client.js),
 * `GuardError` (script-write.js) and `LocalStoreError` (local-store.js) — so the
 * whole face, not just the new write domains, obeys one contract.
 */
import { WriteGuardError } from './tools/_shared.js'

/** code -> {retryable, hint}. `hint` must name the next tool, not a feeling. */
const CODE_CONTRACT = {
  // ---- transport / identity (engine-client.js) ----
  ENGINE_UNREACHABLE: {
    retryable: true,
    hint: '先 engine_health 确认 BOX_CREATOR_BASE_URL 指向正在运行的 Creator（默认 http://127.0.0.1:3127）；连不上就修地址，不要重试写入。',
  },
  ENGINE_TIMEOUT: {
    retryable: true,
    hint: '引擎侧超时。把单次请求拆小（分块 region / 分批实体），或加大 BOX_MCP_TIMEOUT_MS；写类工具上游本身有 120 s 预算。',
  },
  CLI_TOKEN_MISSING: {
    retryable: false,
    hint: '设置环境变量 BOX_CREATOR_CLI_TOKEN（bxc_ 前缀，scope 要含本次操作）。内部 map-authoring 写路由不需要它。',
  },
  AUTH_REQUIRED: {
    retryable: false,
    hint: 'BOX_CREATOR_CLI_TOKEN 无效或已撤销：换一枚带该 scope 的 token（签发走 player-admin 的 create-cli-token，属写操作，需人工）。',
  },
  FORBIDDEN: {
    retryable: false,
    hint: 'Creator 的 Host/Origin 门没过（creator-api-security.ts:38-73）。把 BOX_CREATOR_BASE_URL 指回 127.0.0.1 的地址，别经反向代理。',
  },
  INTERNAL_ROUTE_NOT_DEPLOYED: {
    retryable: false,
    hint: '内部路由 404 说明这个 Creator 构建里没有 /api/internal/map-authoring/**（O4 §7 之后才有）。engine_health 看镜像版本，或换用当前分支构建的实例。',
  },
  NOT_LOOPBACK: {
    retryable: false,
    hint: 'map-authoring 内部路由只接受 loopback socket peer。把 MCP 与 Creator 放同一主机/同一网络命名空间。',
  },
  PROJECT_NOT_FOUND: {
    retryable: false,
    hint: 'mapId 在这台引擎上不存在。先 map_list 拿 permanentMapId 或本地工程目录名（引擎两种都认）。',
  },
  INVALID_PROJECT_ID: {
    retryable: false,
    hint: 'mapId 形态不合 _guard.ts:44 的 ^[a-z0-9][a-z0-9-]{0,62}$。map_list 的返回里取原值，不要自己拼。',
  },
  HTTP_404: {
    retryable: false,
    hint: '上游 404：路由或资源不存在。map_status + map_tool_catalog 先确认这条能力在当前构建里到底有没有。',
  },
  HTTP_405: { retryable: false, hint: '方法不对：这类路由的动词是固定的，按工具描述调用即可，不要自己拼 HTTP。' },
  HTTP_502: {
    retryable: true,
    hint: 'Next 到编辑运行时的转发失败。先 map_status 看 runtimeActive；false 就要人工在 Creator 里打开这张图的编辑器。',
  },

  // ---- revision / lock (script-write.js + tools/_shared.js) ----
  REVISION_REQUIRED: {
    retryable: true,
    hint: '先带 confirm:false 跑一次 dry-run，把返回的 currentRevision 原样作为 expectedRevision 再调一次。',
  },
  REVISION_CONFLICT: {
    retryable: true,
    hint: '重新读一次当前 revision（script_read / map_revision / entity_list / ui_tree_read / terrain_info），确认差异后带新令牌重试；绝不覆盖写。',
  },
  REVISION_UNAVAILABLE: {
    retryable: false,
    hint: '当前 revision 读不出来就没法做乐观锁：确认这张图可读（map_revision / BOX_MAP_PROJECTS_ROOT），或明确传 allowUnhedged:true 承担无锁风险。',
  },
  REVISION_SOURCE_UNAVAILABLE: {
    retryable: false,
    hint: 'map-local 入口脚本在 HTTP 面必定 404，只能从盘上 headHash 链读。设置 BOX_MAP_PROJECTS_ROOT 指向工程目录后重试。',
  },
  REVISION_UNREADABLE: {
    retryable: true,
    hint: '盘上版本链读不动（project-state.json → permissionHash → versionControl）。map_revision 单独跑一次定位是哪一环断了。',
  },
  WRITE_DISABLED: {
    retryable: false,
    hint: '本实例是只读 profile。要写就重启 MCP：BOX_MCP_PROFILE=authoring 且 BOX_MCP_ALLOW_WRITE=1。',
  },
  ROLLBACK_PREIMAGE_UNAVAILABLE: {
    retryable: false,
    hint: '读不到写前内容就没有回滚物料：设置 BOX_MAP_PROJECTS_ROOT（map-local 只能从盘上读），或明确传 allowBlindWrite:true 接受不可回滚。',
  },

  // ---- arguments / validation ----
  INVALID_ARGS: {
    retryable: true,
    hint: '按 problems 里的 path 改参数再调；additionalProperties:false，多余键（比如拼错的 mapid）也会被拒。',
  },
  MAP_ID_REQUIRED: { retryable: false, hint: 'map_list 拿 permanentMapId 或工程目录名，然后带上 mapId。' },
  PROJECTS_ROOT_UNAVAILABLE: {
    retryable: false,
    hint: '没有可读的 BOX_MAP_PROJECTS_ROOT：盘侧版本链（乐观锁唯一可信来源）拿不到。配上路径，或接受不带 expectedRevision 的降级模式。',
  },
  LOCAL_ROOT_MISSING: { retryable: false, hint: '需要盘读但 BOX_MAP_PROJECTS_ROOT 不可用；设置它，或让持有工程目录的一方来读。' },
  LOCAL_PROJECT_NOT_FOUND: { retryable: false, hint: '工程目录不在 projectsRoot 下：map_list 核对目录名 / permanentMapId。' },
  LOCAL_SCRIPT_NOT_FOUND: { retryable: false, hint: '该 map-local 脚本不在这条 headHash 链上：script_list 看 mapLocalScripts 再决定新建还是改名。' },
  LOCAL_SCRIPT_SIDE_MISMATCH: {
    retryable: false,
    hint: 'side 与资产类型位（1=server / 7=client，project-manager.js:2165-2171）不符：按 script_list 返回的 type 传对应 side。',
  },
  MISSING_PERMISSION_HASH: { retryable: false, hint: '这张图还没有 permissionHash（从未在编辑器里保存过）：先人工保存一次，或走 map_save（需要活动运行时）。' },

  // ---- script text gates ----
  SCRIPT_SIDE_INVALID: { retryable: false, hint: 'side 只能是 client 或 server（类型位 1/7）。' },
  SCRIPT_ENTRY_INVALID: { retryable: false, hint: 'entry 用 [A-Za-z0-9._-]{1,160} 且不含 ..；带路径的写法引擎一律拒。' },
  SCRIPT_CONTENT_REQUIRED: { retryable: false, hint: 'content 必须是字符串（整体覆盖，不是补丁）；空串也算给了。' },
  SCRIPT_CONTENT_TOO_LARGE: { retryable: false, hint: '正文超过 20 MiB 协议上限（packages/cli/src/index.ts:11）。拆文件。' },
  TYPE_GATE_FAILED: {
    retryable: true,
    hint: '按 detail.errors 的 code + line 改正正文，再重跑 script_typecheck；需要真实签名用 contract_describe，不要凭记忆调 API。',
  },
  SHARED_SCRIPTS_NOT_FOUND: {
    retryable: false,
    hint: '共享脚本表里没有这一份（map-local 入口必定 404）。script_read 用 source:local，或 script_list 看 mapLocalScripts。' },
  INVALID_STORAGE_REQUEST: {
    retryable: false,
    hint: 'storage 的 scope 只能是 project/group，space 要满足 [A-Za-z0-9_]{1,50}；照 data_read 的描述改。',
  },

  // ---- last resort ----
  TOOL_FAILED: {
    retryable: false,
    hint: '这一支没有结构化的错误码（本层缺陷，应当上报）：detail 里带了这次调用的上下文，先 map_status + engine_health 定位，不要盲目重试写操作。',
  },
}

/** Codes that are *known* to be safe to re-issue; everything else defaults to false. */
export function isRetryable(code, fallback) {
  if (typeof fallback === 'boolean') return fallback
  const entry = CODE_CONTRACT[code]
  if (entry) return entry.retryable
  return /^HTTP_5\d\d$/.test(String(code))
}

export function hintFor(code, fallback) {
  if (typeof fallback === 'string' && fallback) return fallback
  const entry = CODE_CONTRACT[code]
  return entry ? entry.hint : CODE_CONTRACT.TOOL_FAILED.hint
}

/** Codes this module promises to translate (used by the contract test). */
export const CONTRACT_CODES = Object.keys(CODE_CONTRACT)

/**
 * The single place that turns a thrown error into the wire payload.
 * @param {unknown} error
 * @param {{problems?: unknown[]}} extra
 */
export function errorPayload(error, extra = {}) {
  const code = (error && error.code) || 'TOOL_FAILED'
  const retryFromGuard = error instanceof WriteGuardError && typeof error.retry === 'boolean' ? error.retry : undefined
  const payload = {
    code,
    retryable: isRetryable(code, retryFromGuard),
    hint: hintFor(code, error && error.hint),
    // An error raised BY this layer keeps its own (specific) message; anything
    // that came from the engine gets our sentence for that code, so raw HTTP
    // prose / Chinese editor text never sits in the primary field. EngineError
    // is the transport class (engine-client.js) and is always upstream prose.
    message:
      error && error.message && error.fromUpstream !== true && error.name !== 'EngineError'
        ? error.message
        : `${code}：本次调用未完成，处置见 hint。`,
  }
  if (error && typeof error.status === 'number') payload.status = error.status
  if (extra.problems) payload.problems = extra.problems
  const detail = error && error.detail
  if (detail && typeof detail === 'object') {
    // `stack` deliberately never enters the payload: a frame list is noise to a
    // model and can leak absolute paths.
    const { stack, ...rest } = detail
    void stack
    if (Object.keys(rest).length) payload.detail = rest
  }
  return payload
}
