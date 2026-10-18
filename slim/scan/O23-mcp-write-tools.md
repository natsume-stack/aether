# O23 · MCP 写面接线（P0-A 收尾 · 泳道 A）

日期：2026-10-18 ｜ 仓库：`D:/desktop/神奇代码岛/box3-local-engine`（分支 `main`，本地提交 `5f5764f`，未 push）
被测物：`tools/box3-map-mcp/`（Node 标准库，零依赖，`"type":"module"`，宿主 node v24.18.0）
基线：主控交接口径「`node --test test/*.test.js` = 53/53 全绿；`src/tools/` 七个域模块是孤儿代码，没有任何地方 import」。
本轮就是那条缺口的收口，**不是重新取证**。全部改动落在 `tools/box3-map-mcp/` 内；未碰 `apps/ packages/ services/ internals/ distribution/ docker-compose.yml BOX3-IMAGE-CATALOG.json pnpm-lock.yaml rush.json`；**未修改 `src/typegate.js` 与 `test/typegate.test.js`**（`git status` 里它们的改动是主控那条 typegate 修复）；未创建/未 import `src/dod.js`、`src/ui-binding.js`（有测试钉住，见 §7）。

---

## 1. 接线前后对照（亲自跑出）

| 项 | 接线前 | 接线后 |
|---|---|---|
| `tools/list`（profile=authoring） | **12** | **37** |
| `tools/list`（profile=readonly / ALLOW_WRITE=0） | 11 | **21** |
| `--tools-json` 字节数 | 18,379（O3 §4 记录） | **50,708** |
| 被 import 的域模块 | **0 / 7**（`src/server.js` 只 `import { buildTools } from './tools.js'`） | **7 / 7** |
| 引擎 22 个 AI 工具透出数 | 0（域模块不可达）| **22/22**（其中 17 个 headless 可达，5 个脚本域如实拒） |
| `node --test test/*.test.js` | 53 pass / 0 fail | **87 pass / 0 fail / 0 skipped** |
| 重名注册防护 | 无（`byName` 是 Map，重名会静默遮蔽） | **构建期抛错 + 运行期二次校验** |

新增 25 个名字（差集，顺序即 `tools/list` 顺序）：

```
terrain_info terrain_read terrain_apply terrain_revert
entity_list entity_create entity_update entity_move entity_delete entity_copy
model_list model_search_public model_add_to_project
ui_tree_read ui_node_add ui_node_remove
script_list_runtime script_read_runtime script_create script_patch script_delete
map_status map_tool_catalog map_preview map_save
```

老 12 个（`engine_health map_list map_resources script_list script_read data_read runtime_status runtime_events_tail script_typecheck contract_describe map_revision script_write`）**一个没丢、签名与描述未弱化**；主控任务书里写的「13 个」实际是 12 个（`src/tools.js` 的数组长度 = 12，与 O3 §2「12 个：11 只读 + 1 写」一致），测试把它钉成常量（`test/tools-wiring.test.js:74`）。

**唯一一条被改写的既有断言**（透明记录，不是放松）：`test/server.test.js:72-97` 原来用「只允许这批名字」的闭集写法表达「切片 A 只有一个写工具」，接线后必然红。改写为对合并面的闭集断言（37 个名字逐个列出），保留 `requiredReadTools` 与 `script_write` 的 readOnlyHint/destructiveHint/idempotentHint 三条原断言。其余 5 个测试文件 0 改动。

---

## 2. 「引擎 22 个 AI 工具」的源码依据（以源码为准，不信文档数字）

`services/game-server/src/edit/ai/ai-server.ts:282-304` 把三个工厂的返回值合成 `this.tools`；逐个工厂按 `X: tool({` 精确计数：

| 工厂 | 文件:行 | 工具 | 个数 |
|---|---|---|---|
| `createScriptTools` | `entity-tools.ts:31-245` | `listScripts:37 readScript:55 updateScript:75 createScript:156 deleteScript:222` | 5 |
| `createEntityTools` | `entity-tools.ts:247-812` | `createEntity:254 deleteEntity:321 updateEntity:346 listEntities:446 moveEntity:468 copyEntities:501 getProjectModels:609 searchPublicModels:655 addModelToProject:676 createEntityFromModel:685` | 10 |
| `createMapAuthoringTools` | `map-authoring-tools.ts:107-459` | `terrainInfo:180 terrainRead:196 terrainApply:226 terrainRevert:318 uiTreeRead:354 uiNodeAdd:378 uiNodeRemove:437` | 7 |
| **合计** | | | **22** |

外部可达面（headless）只有 **17**：`ai-tool-route.ts:78-91` 只 spread `createMapAuthoringTools + createEntityTools`（其注释明写 script 工具「deliberately NOT exposed here」）。**根因不是选择，是实参形状对不上**：`createScriptTools(state, codeEditor, logger)`（`entity-tools.ts:31-35`）需要 `CodeEditorServerController`，而该路由的 spec 是 `{replica, state, gameId, logger}`（`createServer.ts:649-654`）。`edit-server.ts:108` 的 `codeEditorController` 是 public，`ai-server.ts:288-291` 正是这么传的 ⇒ 关闭这条缺口 = **2 行**（spec 加一个字段 + 一次 spread），但落在 `services/`，A 泳道红线禁止，见 §9 D-1。

A 侧处置：**5 个脚本域工具照样透出**（否则就是「静默丢能力」），调用时回结构化 `ENGINE_TOOL_NOT_MOUNTED`（`detail.available` 是引擎自报的 17 个名单），并指回 `script_write`。`map_tool_catalog` 把这件事变成实测差集，不用猜。

---

## 3. 工具清单（读/写、乐观锁、错误契约）

`R`=只读 `W`=写；锁列：**engine**=引擎自己比 `expectedRevision`；**mcp**=本层快照前置校验（非原子）；**headHash**=盘上 `project-state.json → permissionHash → versionControl → branch.headHash`；`—`=无写语义。
错误契约列 `✓` = 失败一律 `{code, retryable, hint, message}`（`src/errors.js:170 errorPayload()`，`src/server.js:182 inBandError()`）。

| MCP 工具 | 引擎侧对应 | 读/写 | 乐观锁 | 其他护栏 | 契约 |
|---|---|---|---|---|---|
| `engine_health` map_list map_resources script_list script_read data_read runtime_status runtime_events_tail | creator/v1 现有路由（scope 仍不超出出厂 9 项） | R | — | — | ✓ |
| `script_typecheck` `contract_describe` | 纯本地（typegate/声明文件） | R | — | — | ✓ |
| `map_revision` | 盘上版本链只读 | R | headHash 来源 | — | ✓ |
| `terrain_info` `terrain_read` | `terrainInfo` `terrainRead` | R | 产出 revision | — | ✓ |
| **`terrain_apply`** | `terrainApply` | W | **engine**（`map-authoring-tools.ts:264`）+ 本层重取（`terrain.js:196-210`） | 预算 100k 格（`terrain.js:158-183`）、**预览硬门**（`terrain.js:184-199`）、dangerScan、只读面门 | ✓ |
| **`terrain_revert`** | `terrainRevert` | W | 用 undoToken 回放（无需令牌） | undoToken 可解析 + 100k 上限（`terrain.js:262-291`） | ✓ |
| `entity_list` | `listEntities` | R | 产出 mcp 快照 revision（≤50 行回显会标 `snapshotIncomplete`） | — | ✓ |
| **`entity_create`** | `createEntity` + `createEntityFromModel` | W | mcp（`entity.js:177`） | 批量 ≤200、modelId 必须为数字、失败**事务回滚**（`entity.js:214-247`） | ✓ |
| **`entity_update`** | `updateEntity` | W | mcp（`entity.js:307`） | 空 properties 拒、不存在 id 拒、写后 readBack | ✓ |
| **`entity_move`** | `moveEntity` | W | mcp（`entity.js:357`） | position 三元组 | ✓ |
| **`entity_delete`** | `deleteEntity` | W | mcp（`entity.js:417`） | **默认 dry-run，`confirm:true` 才删**、未知 id 拒、删后 survivors 复核 | ✓ |
| **`entity_copy`** | `copyEntities` | W | mcp（`entity.js:484`） | 未知 id 拒（引擎会静默跳过） | ✓ |
| `model_list` `model_search_public` | `getProjectModels` `searchPublicModels` | R | — | 空壳检索如实标 `unavailable:true` | ✓ |
| **`model_add_to_project`** | `addModelToProject` | W（引擎无 execute） | mcp 不适用 | 默认 dry-run；真调回 `ENGINE_TOOL_NOT_IMPLEMENTED`（501） | ✓ |
| `ui_tree_read` | `uiTreeRead` | R | 产出 engine 令牌 | — | ✓ |
| **`ui_node_add`** | `uiNodeAdd` | W | **engine**（`map-authoring-tools.ts:404`，409 带内码本层会挖出来） | 批量 ≤100、nodeType 判别、element data 必须含 box/image/text/scrollBox/input、**逐节点链式 revision**、失败回滚 | ✓ |
| **`ui_node_remove`** | `uiNodeRemove` | W | mcp（`ui.js:308`，引擎侧不校验） | 默认 dry-run + `orphanRisk` 预展示、未知 id 拒 | ✓ |
| `script_list_runtime` `script_read_runtime` | `listScripts` `readScript` | R | — | 当前必回 `ENGINE_TOOL_NOT_MOUNTED` | ✓ |
| **`script_create` `script_patch` `script_delete`** | `createScript` `updateScript` `deleteScript` | W | mcp（`script.js:218/328/407` + 正文级 `expectedContentHash`） | **本地门先跑**：typegate、2 MiB 正文、≤200 op、op 形状、保留入口名、dangerScan | ✓ |
| `map_status` | Next `.../status` | R | — | 预览/运行时判定 + 旧文案标 stale | ✓ |
| `map_tool_catalog` | Next `.../tool` GET | R | — | 自动回报 missing/extra 差集 | ✓ |
| **`map_preview`** | Next `.../preview` | W（改运行态） | — | 只允许 start/stop；只读面拒 | ✓ |
| **`map_save`** | Next `.../save` → `/internal/save-local-project` | W | 落盘后回读 `diskHeadHash` 复核 | **预览在跑 409 拒**，`force:true` 才强存 | ✓ |

写工具共 **16**（15 个域写 + `script_write`），`WRITE_TOOL_NAMES`（`_shared.js:642`）与 `isWriteTool()`（`tools/index.js:86`）是唯一名单，测试要求它与 `annotations.readOnlyHint===false` 的集合逐项相等（`test/tools-wiring.test.js`）。

---

## 4. 护栏机制：复用而非另造（源码位置）

| 机制 | 权威实现（老） | 接线后新写面的复用点 |
|---|---|---|
| headHash 乐观锁 | `src/script-write.js:67 currentRevision()` → `:145-160` CAS → `:161-175` 缺令牌/无令牌拒写 | `map_save` 落盘后回读 `ctx.store.readRevision().headHash`（`tools/map-ops.js:178-186`）；`map_revision` 仍是唯一盘侧令牌出口 |
| 引擎内存 revision | `map-authoring-tools.ts:58 computeTerrainRevision` / `:80 computeUiRevision`（FNV-1a 采样） | `terrain_apply` 传 `expectedRevision` 并**自己再取一次 terrainInfo 比对**（`terrain.js:157-210`）；`ui_node_add` 交给引擎并挖 409 带内码 |
| 本层快照 CAS（引擎没令牌的工具） | `_shared.js:509 snapshotRevision` + `:523 requireClientRevision` | `entity.js:177/307/357/417/484`、`ui.js:308`、`script.js:218/328/407` |
| 预算门 | `_shared.js:61 BUDGETS`（100k 格 / 200 实体 / 100 UI 节点 / 200 op / 2 MiB / 8 MiB 参数体） | `terrain.js:158-183`、`entity.js:84-106`、`ui.js:155-167/292-299`、`script.js:72-101/281-291` |
| 失败事务回滚 | `script-write.js:287-305 restorePreImage → FAILED_ROLLED_BACK` | `entity.js:214-247`（删掉本次已建 id 并报 `rollback.{attempted,rolledBack,removedIds/orphanIds}`）、`ui.js:216-253`（同形态，且 `created.length===0` 时**直接透传引擎原码**，不再包一层 `*_FAILED`） |
| 只读面 / profile 门 | `script-write.js:138-143` | `_shared.js:631 assertWritable`（每个写 handler 第一行）+ `server.js:141` 被 profile 摘掉的写工具仍回 `WRITE_DISABLED` |
| 危险内容 | `typegate.js` 的敏感面正则 | `_shared.js:596 dangerScan` 7 条正则（eval / new Function / globalThis['Function'] / WebAssembly / 动态 import / `__proto__` / node 内置模块），送进引擎的**任何 JSON**都先扫 |

N7 决策 2 的红线遵守情况：未新增/改写 UI 数据形状与事件语义（`ui_node_add` 的 `data` 只按 `UINodeSpec` 的判别键校验，`ui.js:48-75`）；未新造事件模型；一切改动 additive —— `tools/list` 只增名字、`structuredContent.error` 只增字段（`retryable`/`hint`/`status`/`detail`），老字段 `code`/`message`/`problems` 语义不变，`_meta` 增加 `box3-map-mcp/engine-tool` 一条（老 `box3-map-mcp/scope` 原样）。

---

## 5. 错误契约：`{code, retryable, hint}`

`src/errors.js`（新，197 行）是唯一的收口：
- `code` 永不为空；缺 code 的分支被显式归到 `TOOL_FAILED`，hint 自报「本层缺陷，应当上报」。
- `retryable`：域守卫自己声明（`WriteGuardError.retry`），其余按 35 项 `CODE_CONTRACT` 表（`errors.js:27`），HTTP_5xx 兜底 true。
- `hint`：一律点名下一步该调哪个工具、该带哪个参数；`errors.js` 的表只服务**从守卫层之外抛出的码**（`EngineError` / `GuardError` / `LocalStoreError`），守卫层自带 hint 的原样透传（有测试钉住两种行为）。
- **原始中文/HTTP 文案不再出现在 `message`**：`_shared.js:428 translateUpstream` 给错误打 `fromUpstream`，`errors.js:170` 把它换成本层句子，引擎原文（截断 300 字符）隔离进 `detail.upstreamMessage`；`stack` 一律不进 payload（`errors.js:196`）。
- 上游 JSON body 被 **拍平**进 `detail`（`_shared.js:490 safeBody`，含对 `{tool, result}` 的一层拆解），所以 `detail.available` / `detail.issues` / `detail.currentRevision` 是模型该看到的位置。
- 本轮修掉两处真实缺陷：① 运行时的 `PREVIEW_RUNNING` / `REVISION_CONFLICT` 是 **HTTP 409 + 带内嵌套**（`ai-tool-route.ts:192-198`），旧翻译只读 `body.code`，会把它们报成 opaque `HTTP_409`；② `callInternal` 没把 `tool` 传进翻译上下文，`ENGINE_TOOL_NOT_MOUNTED` 的 hint 里工具名是 `"?"`。

实测原文（无凭据、指向死端口，证明 message 已脱敏）：

```json
{ "code": "ENGINE_UNREACHABLE", "retryable": true,
  "hint": "先 engine_health 确认 BOX_CREATOR_BASE_URL …",
  "message": "ENGINE_UNREACHABLE：本次调用未完成，处置见 hint。",
  "detail": { "upstreamMessage": "无法连接 Creator API（http://127.0.0.1:1）：connect ECONNREFUSED 127.0.0.1:1",
              "upstream": { "code": "ENGINE_UNREACHABLE" } } }
```

全 37 个带必填参数的工具逐个用空参数打一遍，必须是 `INVALID_ARGS` + `retryable:boolean` + `hint` 非空 + 无堆栈（`test/tools-wiring.test.js`「every declared tool fails the argument check…」）。

---

## 6. 硬顺序（源码依据，不是约定）

`services/game-server/src/edit/replica/replica-server.ts:1600-1602`（本轮亲自读到）：

```ts
// update voxel hashes only if game isn't running
const gameState = this._state.game.state;
if (!gameState.replica.running) {
```

⇒ 三层拦截，绝不做成静默成功：
1. **本层先拒**：`terrain_apply` 写之前重取 `terrainInfo`，`previewRunning && allowWhileRunning!==true` → `PREVIEW_RUNNING`（`terrain.js:184-199`，hint 里引 `replica-server.ts:1602`）。测试断言 `terrainApply` **从未被调用**（`engine.authoring.state.calls` 不含它）。
2. **引擎再拒**（绕过本层/`allowWhileRunning` 之外的路径）：`map-authoring-tools.ts:272-280` → 409 → 本层解出带内 `code`。
3. **落盘门**：`.../save`（`save.ts` 的 409 分支）→ `map_save` 拒，`force:true` 才强存，且 `next` 明说「force 保存会丢体素 chunk，地形要重做」。测试断言被拒时 `saved===0`。

实体/UI/脚本写不受 `:1602` 影响（它们走 project 事务，不在那个分支里），但同样必须 `map_save` 才落盘，因此每个写工具描述里都写死了这条顺序；测试逐个校验描述含 `map_save|预览|不写任何东西`，且 `terrain_apply`/`map_save` 必须点名 `1602`（`test/tools-wiring.test.js`）。

固定闭环（也写进了 `initialize.instructions`，`server.js:106-115`）：
`map_status → map_preview stop → terrain_apply(expectedRevision) → [entity_*/ui_*] → map_save → map_preview start → runtime_events_tail 断言无 exception`。

---

## 7. 测试（我亲自跑过的命令与原文数字）

```
$ cd tools/box3-map-mcp
$ for f in src/*.js src/tools/*.js mock/*.js scripts/*.js test/*.js; do node --check "$f"; done
node --check files=30 all-ok                     # 30 个 js 文件 0 语法错误

$ node --test test/*.test.js
ℹ tests 87
ℹ suites 0
ℹ pass 87
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3158.9129
exit 0

$ 逐文件（与合跑口径一致）
cid.test.js 7/7 · local-store.test.js 7/7 · script-write.test.js 14/14 ·
server.test.js 11/11 · typegate.test.js 14/14 · tools-wiring.test.js 13/13 ·
domain-guardrails.test.js 21/21        合计 = 87，0 fail，0 skipped
```

> `duration_ms` 是单次运行值（同一天跑出过 3062.4309 / 2805.3913 / 3158.9129），只作参考；`tests/pass/fail/skipped` 四项在三次运行里恒定为 87/87/0/0。

- 接线前基线（主控交接）：53/53。本轮净增 **34** 条 = `tools-wiring.test.js` 13 + `domain-guardrails.test.js` 21；`server.test.js` 仍是 11 条（只改写其中 1 条的闭集，见 §1）。53 → 87，逐文件相加自洽。
- **22/22 覆盖面的证据不是文档**：`test/tools-wiring.test.js:104` 直接读 `entity-tools.ts` + `map-authoring-tools.ts`，用 `/^\s{4}([A-Za-z]+): tool\(\{/gm` 抽出名单，先要求它与测试内逐行转录的 22 个名字相等（引擎改名/加工具就红），再要求它等于本层 `ENGINE_AI_TOOLS` 的引擎名集合，最后（`:88`）要求每个 `mcpTool` 都真的出现在 `tools/list` 里。找不到那两个 TS 文件时 **fail 而非 skip**（宁可红也不冒充验证过）。
- 全 37 个带必填参数的工具逐个用空参数打一遍：必须是 `INVALID_ARGS` + `retryable:boolean` + 非空 `hint` + 无堆栈（`test/tools-wiring.test.js:191`）；写工具逐个被要求把落盘/预览顺序写进描述（`:241`）。
- 协议面真实往返（stdio）：`initialize → notifications/initialized → tools/list → tools/call terrain_info`（指向死端口）→ `tools/list` 回 37，`tools/call` 回带内 `isError:true` + §5 那个 payload。
- `map_status` 的旧文案处理：`status.ts:42-46` 仍自报 `headlessWriteRoute:'unavailable'`（O4 §7.6 U2）。A 侧**没动引擎文件**，改为在本层把它标 `writeRouteSelfReportIsStale:true`，并让 `canWrite` 只取决于运行时是否活着（`tool.ts:82-92` 的真实预检）、`canPersistTerrain` 取决于预览是否停止。有测试钉住两者分离。
- 泳道边界自证：`tools-wiring.test.js` 断言 `src/` 与 `src/tools/` 里没有任何文件 import `dod.js`/`ui-binding.js`，且这两个文件不由 A 创建。

---

## 8. 改动文件（路径:行）

新增
- `src/tools/index.js`（88 行）— 接线枢纽：`DOMAINS:39`、`mergeToolSets:53`（重名即抛）、`buildDomainTools:73`、`isWriteTool:86`
- `src/errors.js`（197 行）— `CODE_CONTRACT:27`（35 码）、`isRetryable:149`、`hintFor:156`、`CONTRACT_CODES:163`、`errorPayload:170`、剥 `stack` 在 `:192`
- `mock/authoring.js`（429 行）— loopback 内部面 + 17 个工具的双：`callTool`、`status()`（含旧文案）、`preview()`、`save()`（409 顺序）、`toolCatalog()`、`mutateExternally()`
- `test/tools-wiring.test.js`（293 行，13 条）、`test/domain-guardrails.test.js`（484 行，21 条）

修改
- `src/tools.js` — 头注释 `:1-21`；`buildBaseTools:60`（原 `buildTools`，工具体未动，仅 `script_write` 描述 `:392-393` 不再自称「唯一的写工具」）；新 `buildTools:448`（merge + profile 过滤）
- `src/tools/_shared.js` — `ENGINE_AI_TOOL_SOURCES:104`、`ENGINE_TOOL_FOR_MCP_TOOL:112`、`ENGINE_AI_TOOLS:137`、`ENGINE_TOOLS_USED:151`、`WriteGuardError.fromUpstream:156-175`、`callInternal` 带 `tool` 上下文 `:211`、`callEngineTool` 透传 `:232`、`UPSTREAM_TRANSLATIONS.ENGINE_REFUSED`、`translateUpstream:428`（嵌套码挖掘 + `safeBody:490` 拍平 + `truncateUpstreamText:503`）
- `src/server.js` — `publicTool:28`（加 `engine-tool` `_meta`）、`writesDisabled:80`、重名二次校验 `:85`、`instructions:107-116`、被 profile 摘掉的写工具仍回 `WRITE_DISABLED:141`、`inBandError:182`
- `src/index.js` — `--tools-json` 复用 `publicTool`；新增 `--coverage-json`（`:44-59`）
- `src/tools/terrain.js` — 描述补 `1602`（`:121`）、`PREVIEW_RUNNING` hint 补源码依据（`:184-199`）
- `src/tools/map-ops.js` — `map_status` 判定重写（`:35-72`）、`map_save` 描述补 `1602`（`:152-157`）
- `src/tools/entity.js` `src/tools/ui.js` — 首项即失败时透传引擎原码（`entity.js:217`、`ui.js:222`）而不是包一层 `*_FAILED`
- `mock/engine.js` — `INTERNAL_PATTERN:24`、sim 构造 `:149`、内部面分发 + 409 包裹 `:156-195`、返回值加 `authoring` 句柄
- `test/server.test.js:72-97` — 闭集断言改写到合并面（§1 已声明）
- `docs/tools-list.snapshot.json` — 重生成（37 工具 / 50,708 字节），O3 §4 的旧快照（12 / 18,379）已过时

---

## 9. 未验证项（UNVERIFIED，一律不写成"应该能过"）

1. **真引擎、真图一次都没打**。无 `bxc_` token（签发是写操作 + 硬依赖 PostgreSQL），禁容器变更 ⇒ 25 个新工具在现网的行为全部 UNVERIFIED；已有证据只有 mock 全链 + 源码走查。7 个 creator/v1 读工具仍是 `CLI_TOKEN_MISSING` 前置门（与 O3 §5.1 同）。
2. **引擎 TS 未经 tsc/next build**（沿 O4 §7.5：全仓无 `node_modules`）。所以「headless 路由真能跑 17 个工具」本身仍是 UNVERIFIED；`ai-tool-route.ts` 与 `tool.ts` 的行为是按源码读出来的，不是实测的。
3. mock 的 zod 校验是**手工子集**（只在 `region/block/expectedRevision/name` 上模拟 `400 TOOL_ARGS_INVALID`）。真实 zod 更严，现网可能多拒参数、issue 形状也可能与 mock 不同 ⇒ `ENGINE_ARGS_INVALID` 分支只被 mock 覆盖。
4. **内存 revision 强度**：引擎是 FNV-1a **采样**（`map-authoring-tools.ts:39-77`，`<=64k` 采样点），mock 是全量 sha256。真机上未被采样命中的改动**可能不改变令牌** ⇒ terrain/ui 的 CAS 强度低于本文件 §3 的字面表述（O4 §5 D-e 同一件事）。不能当全量内容哈希用。
5. **mcp 层快照锁非原子**（`_shared.js:523` 注释自述：check-then-write）；`listEntities` 只回显 50 行（`entity-tools.ts:461`）⇒ 大图上那把锁只覆盖前 50 行 + 总数，返回里已用 `snapshotIncomplete` 明说。
6. `ui_node_add` 的 `data` 能否被编辑器/播放端真渲染 **未验证**（union 赋值语义按 `createEntity` 同构推定，O4 §6.2 同 UNVERIFIED）。本层只做判别位校验，`screen` 缺 `layout` 只给 advisory。
7. `dangerScan` 7 条正则与 typegate 的敏感面正则都是**启发式**，不是完备静态分析；不作为安全边界声明，只作为纵深。
8. `script_*` 五工具的本地门（typegate / 预算 / op 形状 / 双 CAS）在 mock 上跑过，但因为路由不挂载它们，**引擎侧行为一行也没验证过**。
9. `model_add_to_project` 只能证明"会 501"；`searchPublicModels` 只能证明"引擎硬编码空"。两者都不能算能力交付。
10. 未 push、未 commit（写文件只在授权目录），未跑 `compat-check.sh`（属其它泳道），未做端到端 G9 闭环。

## 10. 需主控决策

- **D-1**：是否在 `services/game-server` 补 2 行把 `createScriptTools` 挂上 headless 路由（spec 加 `codeEditorController: editServer.codeEditorController`，路由里多一次 spread；`ai-tool-route.ts:33-37` 的注释需要同步改写它「deliberately not exposed」的理由）。A 侧 5 个工具、错误码、本地门、revision 令牌已就位，挂上即绿。
- **D-2**：`status.ts:42-46` 的 `headlessWriteRoute:'unavailable'` 旧文案是否更新。A 已在本层中和它（`writeRouteSelfReportIsStale`），改引擎文件属 B/D 泳道所有权。
- **D-3**：E / C 接线点建议（A 未建桩、未 import）：**C（UI ↔ 脚本绑定校验）** 插在 `src/tools/ui.js:48-75 checkNodePayload`（纯函数、判别点唯一）；**E（DoD）** 插在 `src/tools/map-ops.js:180 map_save` 之前作为 gate（保存是唯一的"既成事实"点）。主控接上去即可，A 不占名字。
- **D-4**：是否要把 5 个当前必拒的 `script_*` 工具从默认面里摘掉（`BOX_MCP_EXCLUDE_UNMOUNTED=1` 之类）。A 的默认选择是**保留 + 如实拒**，因为「不许丢引擎能力面」是任务书红线；摘与不摘是产品判断。
- **D-5**：`docs/tools-list.snapshot.json` 已被我重生成（37/50,708B）。若主控把它当切片 A 的历史证据，需要留一份 12 工具旧版（我没有保留副本，可用 `git show HEAD:tools/box3-map-mcp/docs/tools-list.snapshot.json` 取回）。
