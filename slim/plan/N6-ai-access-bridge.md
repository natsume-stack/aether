# N6 · AI 接入桥终态（B/D 泳道，2026-10-18；按 `N7-ai-adaptation-decisions.md` 决策 1 落地）

## 0. 一句话终态

AI 地图创作**只有一个身份**：`bxc_*` CLI Token + 新 scope `authoring.apply`，端点族 `/api/creator/v1/authoring/*`；`/api/internal/map-authoring/*` 与运行时 `/internal/ai-tool` 保持"同机编排、零凭据、loopback-only"原样，**不接受任何共享密钥**。

## 1. scope 清单（出厂 9 项一字不减 → 现 10 项，严格 additive）

`apps/game/shared/creator-cli-policy.ts:5-16`

| # | scope | 组 | 本轮 |
|---|---|---|---|
| 1-9 | `projects.list` `resources.list` `scripts.read` `scripts.update` `storage.read` `storage.write` `runtime.view` `runtime.control` `scene.capture` | 原组 | 未动 |
| 10 | **`authoring.apply`** | `AI 创作` | **新增**，`:15`；元数据 `:35` |

元数据文案（门户勾选面直接展示，`label=执行 AI 地图创作`）：
> 对已打开的编辑运行时调用体素/UI/实体创作工具，并按"停预览→写→保存"顺序落盘；含该工程预览启停，每次写操作按 Token 落审计行

**粒度取舍（自定，理由写明）**：`authoring.apply` 覆盖 tools 调用 + save + 该工程 preview 启停 + 自己审计行的读取。把 preview 启停并进来是因为 `stop-preview → write → save` 是不可拆分的闭环（`replica-server.ts:1600-1602`），只给写不给停等于给一个必然 409 的面；不想让 AI 碰预览的 token 就**不要授这个 scope**（改授 `runtime.control` 走既有 `/projects/<id>/runtime`）。常量导出点：`apps/game/server/creator-authoring-bridge.ts:53`。

## 2. 端点清单（全部 `authorizeCreatorCliApi(req, res, 'authoring.apply')` 开头）

| 方法 | 路径 | 文件 | 作用 |
|---|---|---|---|
| GET | `/api/creator/v1/authoring/<id>/tools` | `pages/api/creator/v1/authoring/[projectId]/tools.ts` | 列运行时工具目录（name+description） |
| POST | `/api/creator/v1/authoring/<id>/tools` | 同上 | 调一次工具，body `{tool|name, args?}`；32MB body 上限（`undoToken`）；配额门 |
| POST | `/api/creator/v1/authoring/<id>/save` | `…/[projectId]/save.ts` | 落盘；预览在跑 → 409 `PREVIEW_RUNNING`，`force:true` 才越权 |
| GET | `/api/creator/v1/authoring/<id>/preview` | `…/[projectId]/preview.ts` | 预览状态 |
| POST | `/api/creator/v1/authoring/<id>/preview` | 同上 | `{action:"start"|"stop"}`；审计 `preview.start/stop` |
| GET | `/api/creator/v1/authoring/<id>/status` | `…/[projectId]/status.ts` | 编排前置自检：runtimeActive / previewRunning / saveBlockedWhilePreviewRunning / 端点自述 |
| GET | `/api/creator/v1/authoring/audit?projectId=&limit=` | `…/authoring/audit.ts` | 只回显**本 token**（subject + 指纹双条件）的审计行 |

身份门新增：`apps/game/server/creator-api-security.ts:228` `authorizeCreatorCliApi()` —— 与既有布尔门 `allowAuthenticatedCreatorCliApi`（`:208`，现已改为 `Boolean(await authorizeCreatorCliApi(...))`）**失败序列化逐字一致**，只是把 `identity` 交回路由用于审计。既有 9 条 CLI 路由零改动。

编排实现：`apps/game/server/creator-authoring-bridge.ts`
- `createLoopbackRuntimeCaller()` 拨号形状**逐字沿用** `_guard.ts:39-45/:57`：`http://127.0.0.1:${BOX_EDIT_RUNTIME_PORT||BOX_EDIT_SERVER_PORT||9967}/<id>/{internal/ai-tool,internal/save-local-project,internal/creator-preview-runtime,__local_runtime/status}`；`BOX_EDIT_RUNTIME_HOST=0.0.0.0`（绑定地址）被显式归一回 `127.0.0.1`，因为 0.0.0.0 不是合法拨号目标。
- **不冷启动编辑器**：写前先 GET `__local_runtime/status`，`pid` 缺失即 409 `RUNTIME_NOT_ACTIVE`，`internal/ai-tool` 一次都不会被请求。
- **不重实现引擎语义**：乐观锁、`undoToken`、`PREVIEW_RUNNING`/`REVISION_CONFLICT` 全部由 `ai-tool-route.ts` 定性并原样透传（409 仍是 409）。

## 3. 审计（每次写一行）

发射点：`writeAuthoringAudit()`（`creator-authoring-bridge.ts:307`），sink = stdout 恒发（`[box3.creator-authoring] {json}`，容器里就是 `docker logs`），另在 `BOX_CREATOR_AUTHORING_AUDIT_PATH` 配置时追加 JSONL 文件；写文件失败**绝不把已授权的写变成 500**。读取：`readAuthoringAudit()`（`:339`），未配置文件时如实回答 `sink:"stdout-only"`。

字段（6 个是决策 1 的契约，其余是本泳道加的归因件）：
```json
{"at":"…","tokenSubject":"<identity.subjectId>","tokenFingerprint":"<sha256(bearer)[0:12]>",
 "projectId":"…","tool":"terrainApply|save|preview.stop","revisionBefore":"41","revisionAfter":"42",
 "result":"applied|refused|failed|saved|preview-started|preview-stopped|denied-rate-limit",
 "statusCode":200,"code":"PREVIEW_RUNNING","action":"tool|save|preview","detail":"≤8KiB，含源码依据文案"}
```
不可逆与不泄漏：`tokenFingerprint()`（`:277`）只留 12 位摘要；审计行、配额键、错误文案都不含 `bxc_` 原文，也不复制 `undoToken`（响应体只按 `REVISION_KEYS` 有界遍历 256 个节点取 revision）。**被拒的写也落一行**（409/429/502 全审计）。

## 4. 签发 / 撤销 / 限流

- **签发**：门户 `apps/player-admin/src/pages/creator/creator-management.tsx:438-481`（`CliTokenScopes` 用 `CREATOR_CLI_CAPABILITIES.reduce` 按 `group` 渲染勾选，**没有硬编码 9 项**，新 scope 自动出现）→ `POST /api/play-admin/players/<subjectId>`（`apps/game/pages/api/play-admin/players/[subjectId].ts:67-68`，注意主控口径里的 `player-admin` 目录实际是 **`play-admin`**）→ `parsePlayerItemOperation` zod（`server/player-admin-validation.ts:102-110` 枚举直接来自 `CREATOR_CLI_CAPABILITIES`，`.max(32)`）→ `createCreatorCliToken()`（`server/local-player-identity.ts:1932-1957`，`bxc_<id>_<32B base64url>`，只存 HMAC 摘要）→ 管理审计 `creator.cli-token.create`。需要 `creator-tokens.manage`（`packages/player-policy/src/policy.ts:17`）。
- **撤销**：`revoke-cli-token`（`player-admin-validation.ts:158` → `players/[subjectId].ts:73-74` → `local-player-identity.ts:1960`）置 `revoked_at`；身份解析 `WHERE t.token_hash = $1 AND t.revoked_at IS NULL`（`:927`）→ `AUTH_REQUIRED` → creator/v1 层 **401 `AUTH_REQUIRED` / "CLI Token 无效或已撤销"**。**按 token 单独撤销，不影响同账号其他 token** —— 这正是共享密钥给不了的性质。降权改 scope 走 `update-cli-token`（`:1976-1994`）。
- **限流**：`consumeAuthoringWriteQuota(fingerprint, projectId)`（`:400`），键 = `指纹|地图`，默认 60 次 / 5 分钟，env 可调 `BOX_CREATOR_AUTHORING_RATE_LIMIT_MAX` / `..._WINDOW_MS`；超限 429 + `Retry-After` + 审计 `denied-rate-limit`；放行时回 `X-Authoring-Quota-Remaining`。

## 5. 请求时序（AI 侧一轮写）

```
1. MCP/AI 持 bxc_ token → POST /edit/api/creator/v1/authoring/<id>/status   （creator 进程）
     allowCreatorApi(Host/Origin/mode) → resolvePlayerServiceIdentity(→ player-service 解析 token)
     → creatorCliPermissions 含 authoring.apply ? 继续 : 401/403
2. GET  …/tools            → 探针 __local_runtime/status（无 pid 直接 409，不冷启动）→ 工具目录
3. POST …/preview {action:"stop"}  → 运行时 internal/creator-preview-runtime → 审计 preview-stopped
4. POST …/tools {tool:"terrainApply", args:{expectedRevision:41,…}}
     → 配额门 → 转发 internal/ai-tool → 引擎 200/409 → 审计 {before:41, after:42, result}
   （失败/冲突：409 REVISION_CONFLICT 原样透传，可 terrainRevert(undoToken) 回滚）
5. POST …/save             → 预览状态门（在跑 → 409 PREVIEW_RUNNING，除非 force）→ internal/save-local-project → 审计 saved + permissionHash
6. GET  …/audit            → 只回本 token 的行；出问题按 tokenFingerprint 定位并 revoke
```

## 6. `ai-authoring-access.ts` 处置结论：**选 (a) 整体退场**

```
$ git stash push -u -m "lane-B/D 决策1否决：/internal 共享密钥方案（BOX_AI_AUTHORING_TOKEN）整体退场，AI 身份改走 bxc_ + authoring.apply" \
    -- apps/game/server/ai-authoring-access.ts apps/game/server/ai-authoring-access.test.ts
Saved working directory and index state On slim/local-deploy: lane-B/D 决策1否决：…
$ git stash list
stash@{0}: On slim/local-deploy: lane-B/D 决策1否决：/internal 共享密钥方案（BOX_AI_AUTHORING_TOKEN）整体退场，AI 身份改走 bxc_ + authoring.apply
$ ls apps/game/server/ai-authoring-access*
ls: cannot access 'apps/game/server/ai-authoring-access*': No such file or directory
```

理由（三条独立成立）：
1. **它是第三种身份方案**：`BOX_AI_AUTHORING_TOKEN` 单把共享密钥 + CIDR + 传输分类，语义上就是决策 1 点名的"零身份 + 全图写权限"，既不按人也不可按 token 撤销；(b) 的"改造成纯运维隧道辅助"要求它**不再承载身份**，而它 19KB 的主体（`authorizeAiAuthoringRemote` 的 token/CIDR/transport 判定）恰恰全是身份，剥掉后只剩一个空壳 —— 那是造新语义而不是保留。
2. **它的真实需求已被 creator/v1 覆盖**：文件头注释给出的唯一场景是"远端 AI 主机没有 docker 权限，打不到回环"。`/api/creator/v1/authoring/*` 正是这个场景的答案：公网可达、TLS、带 token、可审计、可单独撤销。同机场景继续用 `docker exec` 隧道（零改动，`_guard.ts` 天然允许）。
3. **它没有依赖方**：`grep -r "ai-authoring-access|BOX_AI_AUTHORING_TOKEN" apps tools` 只命中它自己、它的 test，以及本泳道新增的**负向断言字符串**（`creator-authoring-bridge.test.ts:546/563`），删掉不破任何编译面；stash 后 `28/28`、`13/13` 仍然全绿。
   它的三个好点子被搬进了桥里并有了正确的宿主：指纹归因（`tokenFingerprint`）、有界响应窥探（`REVISION_KEYS` + 256 节点上界）、失败也审计 + 按指纹限流。

反证义务（决策 1 要求）：**没有**"为什么不能走 creator/v1"的反证 —— creator/v1 需要的三样前置全部已在：CLI scope 机制（`normalizeCreatorCliCapabilities` 签发/鉴权两端共用一份枚举）、`/internal/ai-tool` 已存在且语义完整、`allowCreatorApi` 的 Host/Origin 门在公网前缀下已由 G1b 实测放行。**给 internal 加密钥在此环境下没有任何 creator/v1 覆盖不了的场景。**

## 7. 验收表对照（决策 1 / 泳道 D 口径）

| 要求 | 落点 | 证据 |
|---|---|---|
| AI 通道落在 creator/v1 + 新 scope | 上表 7 个端点 + `authoring.apply` | `28/28`，含"新路由不得出现 `BOX_AI_AUTHORING_TOKEN`/`allowLoopback`"的源码级断言 |
| 令牌不落盘 | 只存 `tokenFingerprint`（12 hex） | 用例 `审计行含 6 个契约字段，且不含凭据与 Authorization 原文`、`配额键只含指纹，绝不含凭据原文` |
| 签发/撤销/审计路径 | §3 §4 | `13/13` 里的"身份可归因门"用例证明撤销态 → 401，浏览器 Cookie（CLI scopes 恒空）→ 403 |
| `/internal/*` 保持 loopback-only | `_guard.ts` 零改动 | 用例 `回环门一字未改`：6 个对端地址逐一实测 403/200 + 6 个禁用词（`authorization/token/secret/bearer/fingerprint/BOX_AI_AUTHORING`）在 `_guard.ts` **零命中**；反向对照：同一正则在旁路密钥文件命中全部 6 个词 ⇒ 断言非空转 |

## 8. 未尽项（交接，不在本泳道边界内）

- **OpenAPI 契约注册**：`internals/apis/openapi/openapi.json` 需要 `cd internals/apis && npm run generate` 才会收入这 7 条 creator/v1 操作。前置事实：该文件**本轮改动前就已 stale**（`node scripts/generate-openapi.mjs --check` → `openapi/openapi.json is stale; run npm run generate`），且 `internals/apis/**` 不在本泳道可改清单内；`check:openapi` 挂在 `repo-tasks check` 而非 CI 的 `verify`。→ 需要一条独立小泳道连同 A/C 的新 internal 路由一起重建契约。
- **MCP 侧改指 `creator/v1/authoring`**：`tools/box3-map-mcp/**` 属 A/C/E 泳道，本泳道未碰（红线）。当前 A 泳道若仍打 `/api/internal/map-authoring/*`，在同机隧道形状下继续可用；要跨机就必须换成带 token 的 authoring 面。
- **真图端到端**：签发 token 硬依赖 PostgreSQL（`local-player-identity.ts:915` 无库直接 throw），本轮禁容器变更 ⇒ **`UNVERIFIED`**：真实 `bxc_` token 打 `/api/creator/v1/authoring/<id>/tools` 是否 2xx、真 `terrainApply` 的 revisionBefore/After 是否落进审计文件，均未跑过。
- **`play-admin` 门户 UI 未做浏览器实测**：勾选面靠枚举驱动已由源码断言证明（用例 3），但没在真 Umi 应用里点过。
