# O4 · 引擎侧 AI 全面适配：地形与 UI 的服务端可编程写入口（C4 泳道 · 切片 B）

生成：2026-10-18 ｜ 泳道：C4 ｜ 工作目录：`D:\desktop\神奇代码岛\box3-local-engine`（分支 `slim/local-deploy`）
授权：用户原话「允许对引擎进行 aimcp 等工具的全面适配 … 让 aiagent 能接入并操控、编辑地图」= **明确授权改引擎源码**；同一句更高红线「原有地图不能跑不起来、各功能异常不能接受」= **兼容性优先，宁可少做**。本泳道在两者之间取值：**全部改动为纯加法**，未改变任何既有端点/契约行为。
取证基线：`plan/N2-mcp-ai-map-authoring.md`（A8）、`scan/O1`、`scan/O2`、`impl/G3-map-compat-baseline.md`、`ANALYSIS-AND-PLAN.md §3.4`。

> **验证状态**：本机无依赖、禁止 `rush/pnpm install`，**tsc / next build 未运行**。所有 TS 改动为**静态走查**（对齐同族 `entity-tools.ts` 的调用面），未经编译验证 —— 全文标 **UNVERIFIED**。禁止容器变更 / 真写地图，端到端写入验证留给 C6/串行轮。

---

## 1. 改动文件清单

**新增（4 个）**
| 文件 | 作用 |
|---|---|
| `services/game-server/src/edit/ai/map-authoring-tools.ts` | `createMapAuthoringTools()`：地形读/写/回滚 + UI 树读/增/删，走 runtime 内存态 RDA/体素 |
| `apps/game/pages/api/internal/map-authoring/_guard.ts` | loopback 门 + 运行时内部路由转发助手（下划线前缀 = Next 不当路由） |
| `apps/game/pages/api/internal/map-authoring/[projectId]/status.ts` | GET：探测编辑运行时/预览态 + 声明 headless 写路由可用性 |
| `apps/game/pages/api/internal/map-authoring/[projectId]/preview.ts` | POST start/stop：转发到 runtime 既有 `/internal/creator-preview-runtime` |
| `apps/game/pages/api/internal/map-authoring/[projectId]/save.ts` | POST：预览在跑则 409 拒绝（硬顺序），否则转发 `/internal/save-local-project` |

（`_guard.ts` + 3 路由 = 4 个 internal 面文件；加 map-authoring-tools = 新增 4 个「代码文件」，internal 目录共 4 文件。）

**修改（2 个）**
| 文件 | 改动 | 兼容性 |
|---|---|---|
| `services/game-server/src/edit/replica/validate/validate-voxel-action.ts` | `// TODO` 恒 true → 真校验（保守） | 见 §3.1 |
| `services/game-server/src/edit/ai/ai-server.ts` | `this.tools` 追加 `...mapAuthoringTools`（import + 类型 + 构造器 3 处） | 纯加法 |

`validate-project-action.ts` **未改**：它禁客户端 `voxels` 动作是既有护栏（N2 §2.5 判定为「设计使然」），改它 = 改客户端声明面语义 = 破红线，故保留原行为，仅作证据引用。

---

## 2. 能力矩阵

| 能力 | 工具/端点名 | 入参 schema（摘要） | 副作用 | 幂等 | 失败回滚 | 兼容证明 |
|---|---|---|---|---|---|---|
| 地形元信息 | `terrainInfo`（AI 工具） | `{}` | 无 | I | – | 只读，无契约面 |
| 地形区域读 | `terrainRead` | `{region:{min[3],max[3]},limit?}` | 无 | I | – | `map.*` digest 不变（不写） |
| 地形批量写 | `terrainApply` | `{region,block,rotation?,expectedRevision,allowWhileRunning?,dryRun?}` | 改 `state.game.voxel` 内存体素 | NI（同参同区域→同结果，近似 I） | 返回 `undoToken`→ `terrainRevert` | `dryRun` 默认 false；**未落盘前**不触 `map.*`；落盘仅在预览停后由 save 完成 |
| 地形回滚 | `terrainRevert` | `{undoToken}` | 用 prev 值重放 | I（重放同一 token） | – | – |
| UI 树读 | `uiTreeRead` | `{}` | 无 | I | – | – |
| UI 节点增 | `uiNodeAdd` | `{parentId?,name,nodeType:'screen'\|'element',data,expectedRevision}` | `replica.projectTransaction().uiTree.add` | NI（随机 id） | RDATransaction **自动 inverse**（commit 失败即回滚） | 走与浏览器同一棵树，不改 schema |
| UI 节点删 | `uiNodeRemove` | `{nodeIds[]}` | `.uiTree.remove` | NI | 同上 inverse | – |
| 预览编排（loopback） | `POST /api/internal/map-authoring/<id>/preview` | `{action:'start'\|'stop'}` | 转发 runtime 既有路由 | I | – | 新端点，未改既有 |
| 落盘（loopback，带硬顺序） | `POST /api/internal/map-authoring/<id>/save` | `{force?}` | 转发 runtime 既有 save | I（hash 不变即空操作） | 引擎级 `createProjectSnapshot/restoreProjectSnapshot`（已存在，见 §4） | 新端点，未改 `local-projects/[id]/publish` |

乐观锁：`expectedRevision` = 由 `terrainInfo/terrainRead`（体素网格采样 FNV-1a）或 `uiTreeRead`（节点拓扑 FNV-1a）返回的 token；写前重算比对，不等 → `REVISION_CONFLICT`。

---

## 3. 关键设计点与不可回避的风险

### 3.1 validate-voxel-action 从恒 true → 真校验（保守）
唯一调用方 `replica-server.ts:580`（客户端 `voxel` 动作）。新逻辑**只拒绝结构上不可能出现在任何合法地图的写法**：非整数/负坐标、`b` 越出 packed uint16、`VOXEL_*` 常量漂移、序列 > 50 万。空序列与带 rotation 位（`b & 0xC000`）**一律接受**——合法编辑本就靠 `setVoxelRotate` 写旋转位。因 `VoxelWrite` 由 mudb schema 保证 x/y/z/b 已是 uint 域，真实客户端流量**几乎不可能被新规则误判非法** → 兼容性：`checkVoxelWriteSequence` 对既有会话行为等价。UNVERIFIED（未跑回归）。

### 3.2 「预览在跑就不能记 chunk hash」硬顺序 —— 本泳道选择**明确拒绝 + 可诊断错误**，不改引擎保存语义
`replica-server.ts:1602` `if (!gameState.replica.running)` 是**既有且正确**的行为（运行中体素尚未 bake 完，记 hash 会写坏）。本泳道**不动它**，而是在两层拦截：
- `terrainApply`：`state.game.state.replica.running && !allowWhileRunning` → `PREVIEW_RUNNING`（文案直引 `:1602`）。
- `POST .../save`：先探预览态，running → `409 PREVIEW_RUNNING`，指引先 `.../preview {action:"stop"}`；`force:true` 可强存（承袭 `publish.ts` 的 ECONNREFUSED 容错风格）。
（「内部自动停预览再存」= 会改运行态可见行为，风险高，留给用户决策，见 §5 D-a。）

### 3.3 地形级 revision：引擎**没有**独立的持久化地形 revision —— 复用既有工程级链，未新造
盘侧已有 `project-state.json → permissionHash → versionControl.branches[b].headHash`，每次写把 `prevHash = 旧 headHash` 前推（`project-manager.js:2056-2197 updateProjectScript` 是范例），回滚有 `createProjectSnapshot`/`restoreProjectSnapshot`（N2 §3.4 L1/L2 已存在）。
- **内存态乐观锁**用 §2 的采样 token（本泳道新实现，轻量）。
- **落盘级 revision** 直接骑工程级 headHash，**无需**新造地形专用 revision。→ 结论：「补地形 revision/快照」**不可回避地被现有工程级链满足**，本泳道不重复实现，避免碰 `project-manager.js`（越界）。

### 3.4 ⚠️ 最大风险：headless HTTP 触达不到地形/UI 工具（越权面 + 路由归属）
地形/UI 工具**确实**在 runtime 服务端（`edit/ai/map-authoring-tools.ts`，与浏览器写同一棵树），但它们经 **AiProtocol（mudb）** 只被**编辑器内 AI 面板**调用。要让外部 MCP **无头 HTTP** 调用，必须在 runtime 上注册一条 `/internal/ai-tool` 路由——而 runtime 的 httpRoutes 全在 **`createServer.ts`（本泳道禁止改）** 里挂载，`entry.ts:705` 按 `httpRoutes[pathname]` 精确匹配。**因此本泳道无法在不越界的前提下交付 headless 写端点**；internal Next 面（§2 编排）只能转发 runtime **已存在**的 preview/save，无法触发工具写入。这是**切片 B 落地的硬缺口**，非本泳道能单方面关闭（见 §5 D-b）。

### 3.5 A8 越权面（`bxc_` 任意 scope 直达 create/publish/export/package/import）——**仅记录，未动**
scope 校验发生在 `creator-api-security.ts:141`（CLI）而非入口 `:105`（用户级 `creatorPermissions`）。收紧 = 改**既有鉴权语义** = 用户红线「不得单方面改鉴权」→ **不自改**。本泳道新 internal 面**不新增**该风险：只走 loopback（无 token 也需本机 socket 对端），且未触碰那五条路由。

### 3.6 地雷自查（O1/O2/G3）
- **未碰**：`world/player/entity/voxels/gui` 的 freeze/seal（地雷 1，86 隐藏属性面）—— 新工具只**读写**体素/UI，不改对象可扩性。
- **未碰** mudb 注册顺序 / 跨端 schema 副本 / box-encode / CID（地雷 2/3/4）—— 新代码不 import 也不改这些；地形写走 runtime 既有 `setVoxel`，落盘走既有 `saveProject`。
- **未碰** `entry.ts:686-688` pg→sqlite 静默降级、`publish.ts:31` ECONNREFUSED 容错、catch 吞错族。
- **未碰**客户端 `ai-server.ts:70`「Do NOT generate client scripts」—— 移除它属改 AI 出厂行为（作者可感），**留给用户决策**（§5 D-c）；本泳道只**加**地形/UI 工具，不动该提示。

---

## 4. 用什么检查证明没破坏兼容

对应 `box3-re/tools/compat-check.sh`（56 key）：
- **全部改动不落盘、不改既有端点** → `map.world.*.digest`、`map.project.*.digest`、`map.scriptBlobs.total`、`http.playWorlds.*` **应逐项相等**（本泳道不写图，天然满足）。
- **未碰 398 契约源/ dts** → `contract.server.fingerprint.sha256`、`contract.client.fingerprint.sha256` **应相等**。
- **未改入口 require 链/打包** → `l0.moduleResolution.*`、`impl.coverage.missing` **应 0/不变**。
- 地形校验器 `validate-voxel-action.ts` 属 `services/game-server`，非 d.ts，不入契约指纹；其对客户端 `voxel` 路径的等价性用 **G3 真图（起床战争）进图刷地形冒烟**证明（本泳道无图无运行时 → **UNVERIFIED**，交 C6）。
- 复跑（只读）：
  ```bash
  MSYS_NO_PATHCONV=1 wsl -d Ubuntu-24.04 -- bash \
    "/mnt/d/desktop/神奇代码岛/box3-re/tools/compat-check.sh" --skip-http --skip-docker
  ```
- 结构自检（本机可跑，非编译）：`node --check` 仅适用 JS；本次全是 TS → 用静态走查（对齐 `entity-tools.ts` 调用面）替代，**未经 tsc/next build 验证**。新路由文件均为 `< 500` 行、下划线助手文件 Next 不计路由；`scripts/check-public-routing-structure.js` 只校验 Rust 模块，不受影响（实测其 assert 仅针对 `*.rs`）。

---

## 5. 需用户决策（本泳道不自做）
- **D-a**：`terrainApply` 落盘是否允许「内部自动 stop-preview→write→save」一体化（便利但改运行态可见行为）。本泳道仅做「拒绝 + 指引」。
- **D-b**：是否在 `createServer.ts` 增加一条 loopback `/internal/ai-tool` 路由，使 §2 的地形/UI 工具可被外部 MCP **无头**调用（N2 R1）。这是 headless 全自动地形的**唯一收口点**，但属 C4 禁止文件；建议批准由 C4 之外的授权轮实现，半径 1 文件 1 路由 + 复用 `createMapAuthoringTools`。
- **D-c**：是否解除 `ai-server.ts:70`「Do NOT generate client scripts」。移除 = 改出厂 AI 行为（作者可感）；且客户端 DTS 链仍断（O2 §4.2/§4.5），解除前须先修 client include，否则模型瞎写。
- **D-d**：A8 越权面（`bxc_` 任意 scope 直达 create/publish/…）收紧方案（N2 §2.4/D2）—— 属鉴权语义，用户定。
- **D-e**：地形/内存 revision 用采样 FNV-1a（省算力、非全量哈希）是否满足多 agent 并发强度；若要强一致需改全量 `voxels.data` 摘要（依赖 VoxelServer 暴露 `.data`，**未确证**）。

---

## 6. UNVERIFIED 汇总
1. 全部 TS 未经 `tsc`/`next build`（无依赖、禁装包）。
2. `action.uiTree.add/remove` 与 `UITreeRDA.nodeSchema.alloc().value = {type,data}` 的 union 赋值语义 —— 按 `createEntity` 同构推定，未运行。
3. `state.game.voxel` 暴露 `shape/getVoxel/setVoxel/setVoxelRotate`（`.data` 未确证）—— 依据 `replica-server.ts:1265/1278/1559`、`index.ts:499` 静态引用。
4. runtime httpRoutes 对 `/<projectId>/internal/...` 前缀的精确匹配/剥离机制 —— 承 `publish.ts`/`creator-preview-runtime.ts` 既有用法推定，未实测。
5. 越权面、DTS 断链相关引用来自 N2/O2，未在本泳道复算。
6. 端到端「改地形/改 UI→落盘→上服」—— 按纪律**禁止真写**，交 C6/串行轮。

---

## 7. headless 收口（C4b 续写 · 2026-10-18 · §3.4/D-b 缺口的授权关闭轮）

用户授权原文：「允许对引擎进行 aimcp 等工具的全面适配，目的就是让 aiagent 能接入并操控，编辑地图」。据此**只改了 §3.4 点名的那一个文件**，落地 N2 R1（半径：1 既有文件 + 2 新文件），**不重写 §1-§6**。

### 7.1 改动
| 文件 | 性质 | 位置 |
|---|---|---|
| `services/game-server/src/createServer.ts` | **修改（唯一既有文件，纯加法）**：在既有 `local+edit` 的 internal 段（`/internal/save-local-project` 之后）注册 `spec.httpRoutes['/internal/ai-tool']`；动态 `await import('./edit/ai/ai-tool-route')` 照 `./edit/edit-server` 同款，**play 模式模块图零变化** | 现 **:635-654**（原 :633 与 :635 之间插入，其余行未动） |
| `services/game-server/src/edit/ai/ai-tool-route.ts` | **新增**：loopback-only 工具派发器。`createAiToolRouteHandler({replica,state,gameId,logger})` 用 `createMapAuthoringTools(...)+createEntityTools(...)`（与 `ai-server.ts:282-304` 同一对工厂、同一实参形状）**原样复用**，无第二套写入逻辑；script 工具族**故意不暴露**（`script_write` 在 C3 侧已有类型门+CAS+读回） | 208 行 |
| `apps/game/pages/api/internal/map-authoring/[projectId]/tool.ts` | **新增**：Next 侧转发（`_guard.ts` **未改**——其 `callEditRuntime` 的 suffix 白名单是 C4 交付面，本路由自带 fetch；复用其 `allowLoopback/projectId/isValidProjectId`）。先探 `GET /<id>/__local_runtime/status`（edit-library 自答、**不分配运行时**，`edit-library.js:283-298`），`pid` 缺失即 409 `RUNTIME_NOT_ACTIVE`——挡住 library 对未知路径 `ensureRuntime` 的重副作用（`edit-library.js:413-429`） | 146 行 |

### 7.2 接口形状（runtime 侧 `POST/GET /internal/ai-tool`）
- **门**：socket 对端 ∈ {127.0.0.1, ::1, ::ffff:127.0.0.1}，否则 `403 {code:'FORBIDDEN'}`（与 `localOnly`/`save-local-project` 逐字一致；**未新增任何鉴权、未动 `bxc_` 面**）。
- `GET` → `200 {tools:[{name,description}], usage}` 工具目录（terrainInfo/terrainRead/terrainApply/terrainRevert/uiTreeRead/uiNodeAdd/uiNodeRemove + createEntity/updateEntity/deleteEntity/moveEntity/copyEntities/listEntities/getProjectModels/searchPublicModels/addModelToProject/createEntityFromModel）。
- `POST {tool|name, args}` → zod `inputSchema.safeParse` 先验参（`400 TOOL_ARGS_INVALID{issues}`）→ 直调该工具 `execute`（AI SDK v5 语义，第二参 `{toolCallId:'http-<uuid>',messages:[]}`）。
  - `200 {tool, result}`（result 即 C4 工具原返回，含 `undoToken/newRevision` 等带内字段）；
  - result 带内 `success:false` 且 `code ∈ {PREVIEW_RUNNING, REVISION_CONFLICT}` → **HTTP 409** 同码透出；
  - 其余：`400 UNKNOWN_TOOL{available}` / `400 INVALID_BODY` / `413 BODY_TOO_LARGE`（body 上限 32 MiB，容纳大区域 undoToken）/ `501 TOOL_NOT_EXECUTABLE` / `500 TOOL_EXECUTION_FAILED`。
- Next 侧 `GET|POST /api/internal/map-authoring/<projectId>/tool` 状态透传；`ECONNREFUSED`/运行时未开 → `409 RUNTIME_NOT_ACTIVE`；`bodyParser.sizeLimit:'32mb'`。

### 7.3 硬语义保持（逐条对 C4）
- **硬顺序**：预览在跑 → `terrainApply` 工具内部先拒 `PREVIEW_RUNNING`（文案仍直引 `replica-server.ts:1602`），本路由**不自动 stop-preview、不自动改运行态**；`allowWhileRunning` 逃生阀按 §5 D-a 原样保留（仅改内存态，落盘仍须停预览）。
- **乐观锁/回滚**：`expectedRevision`/`undoToken`→`terrainRevert` 全在工具内，未复制未削弱；工程级 `branch.headHash` 链继续由既有 `.../save`→`/internal/save-local-project` 推进，本路由**不落盘**。
- **纯加法**：既有端点/handler/路由 0 行为改动；`entry.ts:705` 精确匹配新增键 `'/internal/ai-tool'`，与 `/block` 前缀正则无冲突。地雷自查：未 freeze/seal（86 隐藏属性面）、未碰 `entry.ts:686-688` 降级、未碰 mudb/CID/契约源。

### 7.4 与 C3/C4 的衔接（编排顺序）
`status`（探测）→ `preview {action:"stop"}` → `tool terrainInfo`（取 revision）→ `tool terrainApply{expectedRevision}` →（失败带 `undoToken` 可 `terrainRevert`）→ `tool uiTreeRead/uiNodeAdd` → `save`（预览在跑会 409，§2 语义不变）。C3 的 12 个 MCP 工具与 `map_revision`（盘侧 headHash 链）不受影响；切片 B 的 MCP 新工具只需把 HTTP 目标从 creator/v1 换成该 Next 路由（loopback，无需 bxc_ token，与 §3.5 越权面隔离）。

### 7.5 验证程度（如实）
- **编译**：`node_modules` 全仓不存在（实测 `NO_TS`、无 `typescript` 包，禁装包）→ **tsc/next build 未运行，全部 UNVERIFIED**。
- **静态走查 + 逐行类型核对（本轮亲自核过的出处）**：`ServerRuntimeConfig.contentId: number`（`config/index.ts:36`，且 `startEditServer spec.contentId: number` `edit-server.ts:57`、`gameId=spec.contentId` `:63`，与 AiServer 的 `gameId:number` 同值同型）；`EditServer.state/replica` 均 public（`edit-server.ts:106-109`）；`bodyParse(req,maxSize)`（`packages/utils/src/backend.ts:3-23`）；zod `4.1.12`（两 package.json 实测）`safeParse/error.issues` 形状；`game-server/tsconfig` 无 `noUncheckedIndexedAccess`（`tools[name]` 索引安全）；`HttpRoutes` 值类型 `(req,res)=>Promise<void>`（`createServer.ts:73-78`）；edit-library 前缀剥离/通用转发（`edit-library.js:16-34,437-455`）；`/__local_runtime/status` 免分配应答与 `pid` 仅在 runtime 存活时透出（`edit-library.js:109-121,283-298`）。
- **桩调用/端到端**：按硬纪律**禁止真写、禁止触盘**，未执行；留给用户授权的串行轮/C6。
- 复跑（只读）：`grep -n "internal/ai-tool" services/game-server/src/createServer.ts services/game-server/src/edit/ai/ai-tool-route.ts "apps/game/pages/api/internal/map-authoring/[projectId]/tool.ts"`。

### 7.6 新增 UNVERIFIED / 残留风险
1. **U1（继承）**：跨网络边界时 `req.socket.remoteAddress` 若为容器网关 IP，本路由与既有 `save-local-project` **同样** 403（GATES #16 实测项，口径一致，非新增风险）。
2. `status.ts` 仍写 `headlessWriteRoute:'unavailable'`（:42-46）——本轮按「纯加法」纪律**未改该既有端点**，该声明已过时；权威探针改为 `GET .../tool` 目录（能列出即已通）。是否更新 status.ts 文案，请主控定夺。
3. edit-library 对未知转发路径会 `ensureRuntime`（开图副作用）——Next 面已用 `pid` 预探拦住；但若有人**绕过 Next 面直连 runtime 端口**，行为与直调既有 internal 路由相同（loopback 门不变），已在 7.2 注明。
4. AI SDK v5 `execute(input, options)` 第二参形状按 `ai-server.ts` 同包用法推定；32 MiB undoToken 上限是工程取值，未压测。
5. **§3.4 的结论口径更新**：缺口已由本节在授权轮关闭；§1-§3.6/§5/§6 原文保留不改（其中 D-b 视为「已批准并落地」）。
