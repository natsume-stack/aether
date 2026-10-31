# Agent Active — 识别码即开发账号

> 2026-10-25 · 让外部 AI（ZCode / Claude / 任何 agent）加入**已有地图或玩家自建地图**的开发。

## 一句话

每张地图在编辑器右下角的 **Agent Active** 面板里有一串识别码（`MAP-XXXX-XXXX-XXXX`）；
VOXA 页面同款面板里是模型识别码（`VOX-XXXX-XXXX-XXXX`）。把识别码发给 AI，
AI 用它换取令牌即可加入开发——**地图码 = 这张图的全部开发，VOXA 码 = 仅模型构建**。

## 最小交接：只给两样东西

| 给 AI 的信息 | 从哪来 | 是否必需 |
| --- | --- | --- |
| 编辑器地址（如 `https://box3.cdk.lat/edit/e/<projectId>`） | 面板“活体”页签显示的地址，或 `GET /api/agent/v1/live/manifest` 的 `editorUrl` | 必需 |
| 地图识别码 `MAP-….` | 面板“识别码”页签 | 必需 |
| project id | `join` 响应里的 `project.id`；MCP 客户端会自动发现 | **不需要人工提供** |
| 安装 MCP 客户端 | `tools/box3-agent-mcp` | 活体通道必需；只用批量面可自行发 HTTP |

“复制 地址+识别码”按钮复制的就是前两行；面板的“复制 MCP 配置”按钮则把地址、
识别码和 project id 一起写进 MCP 注册 JSON。

## 前置条件（不要宣传成“纯网页直连”）

活体命令由**已打开的那一个编辑器标签页**执行，所以：

1. 有人在该地址登录 Creator 并打开地图编辑器，保持标签页可见；
2. AI 侧能运行 MCP 客户端（`node tools/box3-agent-mcp/src/index.js`），或自行向
   `/api/agent/v1/live/map/<projectId>/*` 发 HTTP 请求；
3. 标签页没有打开时，任何活体命令都返回 `EDITOR_NOT_ATTACHED`，重试不会变好。

只有批量创作面（`/api/agent/v1/map/<projectId>/tool`：地形/实体/UI/脚本）由运行时
执行，不要求标签页可见，但仍需要同一条识别码换来的令牌。

## AI 如何定位并打开正确地图

识别码**自己选定地图**：`join` 不需要 project id，返回 `project.id`、`map.editorUrl`
和 `map.attached`。AI 的流程是：

1. `POST /api/agent/v1/join {code}` → 拿令牌 + `map.editorUrl`；
2. 把 `editorUrl` 交给能开浏览器的人或 agent，打开并保持；
3. `GET …/live/map/<projectId>/status` 看到 `attached:true` 后再发命令；
4. 若 `attached:false`，回到第 2 步，而不是换码重试。

MCP 客户端把第 3 步封装成 `agent_status`，`--doctor` 会把 join 与 attach 一起实测。

## 面板

| 位置 | 面板 | 展示内容 |
| --- | --- | --- |
| Creator 编辑器（`/e/<project>`）右下角 | Agent Active | 地图识别码（复制/轮换）、已加入 Agent（吊销）、日志、产物 |
| VOXA（`:3123`）右下角 | Agent Active · VOXA | VOXA 识别码、已加入 Agent、日志、产物 |

识别码可随时**轮换**（旧码立即失效，已加入的 agent 不受影响，需单独吊销）。

## AI 接入协议（地图码）

```sh
# 1. 用识别码换令牌（只需做一次；令牌妥善保存，服务器只存摘要）
curl -X POST http://127.0.0.1:3127/api/agent/v1/join \
  -H 'Content-Type: application/json' \
  -d '{"code":"MAP-XXXX-XXXX-XXXX","name":"zcode"}'
# → 201 { token, agentId, scope:"map", project:{id,name?},
#          map:{ projectId, editorUrl, attached }, prerequisites:[...],
#          transport:{ requiresEditorTab:true, pureWebDirect:false, endpoints },
#          usage:{...} }

# 2. 列出可用工具（引擎 AI 工具层：terrain/entities/ui/script）
curl http://127.0.0.1:3127/api/agent/v1/map/<projectId>/tools \
  -H "Authorization: Bearer agx_..."

# 3. 调用工具（写地形前先停预览；顺序 = 停预览 → 写 → 保存）
curl -X POST http://127.0.0.1:3127/api/agent/v1/map/<projectId>/tool \
  -H "Authorization: Bearer agx_..." -H 'Content-Type: application/json' \
  -d '{"tool":"terrainApply","args":{...}}'

# 4. 保存工程（预览运行中会 409 PREVIEW_RUNNING）
curl -X POST http://127.0.0.1:3127/api/agent/v1/map/<projectId>/save \
  -H "Authorization: Bearer agx_..." -H 'Content-Type: application/json' -d '{}'

# 5. 登记产物（面板"产物"页签可见）
curl -X POST http://127.0.0.1:3127/api/agent/v1/map/<projectId>/artifacts \
  -H "Authorization: Bearer agx_..." -H 'Content-Type: application/json' \
  -d '{"kind":"gdd","name":"像素战争-512","detail":"muse 产出"}'
```

动作一览：`tools`(GET) / `tool`(POST) / `status`(GET) / `save`(POST) / `artifacts`(GET|POST)。
语义与引擎 loopback 工具层完全一致：`expectedRevision` 乐观锁（409 `REVISION_CONFLICT`）、
预览运行中拒写地形（409 `PREVIEW_RUNNING`）、`undoToken` 回滚。

## AI 接入协议（VOXA 码，仅模型构建）

```sh
curl -X POST http://127.0.0.1:3123/api/agent/v1/join \
  -H 'Content-Type: application/json' -d '{"code":"VOX-XXXX-XXXX-XXXX","name":"zcode"}'
# → 201 { token, scope:"voxa" }

curl http://127.0.0.1:3123/api/agent/v1/models -H "Authorization: Bearer agx_..."

# 导入 aether/chisel 产出的 .voxaproject bundle（原始 zip 字节）
curl -X POST http://127.0.0.1:3123/api/agent/v1/models \
  -H "Authorization: Bearer agx_..." --data-binary @models/pixel-rifle.voxaproject
```

导入校验链与 `/api/local/models/import` 完全一致（bundle 解析、schema 迁移、
model-meta/data 哈希绑定），导入成功后模型立即出现在 VOXA 模型清单。

## 与 aether 四引擎的关系

- **chisel**（VOXA 建模）的产物 `.voxaproject` 可直接经 VOXA 码导入 → AI 有了
  识别码就能把精细模型管线接进任何一张现有地图。
- **muse / gaia / prism** 的产物（GDD / TerrainPlan / UI 套件）经地图码的
  `artifacts` 登记，并可用 `tool` 动作把 terrainApply / UI 写入引擎（工具目录
  见 `tools`，与 feather 的 `engineCall` 同一工具层）。
- 引擎在本机跑 aether 管线时仍可走 loopback `/internal/ai-tool`；识别码通道
  是给"AI 在别处、引擎在服务器"的场景准备的，两者共用同一个工具层。

## 安全模型

1. 识别码是唯一凭据；令牌只存 HMAC-SHA256 摘要，原文不可回溯，join 只返回一次。
2. 所有 agent 动作（含拒绝）写审计日志，面板按 agent 归因；令牌以 12 位指纹展示。
   审计详情里的 `MAP-`/`VOX-` 识别码与 `agx_` 令牌会被替换成 `[redacted:MAP]` 形式，
   任何普通日志都拿不到可直接复用的凭据。
3. 识别码 / 令牌作用域硬隔离：VOXA 码永远无法触达地图工具，反之亦然。
4. 面板 API（读识别码、轮换、吊销）走创建者会话鉴权，agent 令牌不可见。
5. 存储为本地 JSON（`BOX_AGENT_ACCESS_PATH` / VOXA data 根下 `agent-access.json`），
   不引入数据库依赖；进程内写队列串行化，原子替换写入。

## 一张码只授权一张图

- 每个 projectId 有一条独立 entry，entry 自带 salt；令牌是按**该 entry 的 salt**
  计算的 HMAC。用地图 A 的令牌请求地图 B 的路径时摘要不可能匹配，返回
  `401 CROSS_MAP_TOKEN`（不是“令牌无效”，提示会告诉你换用目标图的码重新 join）。
- 地图令牌只触达**这张图自己的运行时与产物**（`/api/agent/v1/map/<A>/*`、
  `/api/agent/v1/live/map/<A>/*`、A 的 artifacts）。VOX- 模型构建是另一套凭据，
  地图码不能读/写 VOXA 模型库。
- 识别码生成时保证全局唯一；`projectId` 的 `permanentMapId` 别名会先归一化再比对，
  别名不能绕过绑定。

## 生命周期：轮换 / 吊销 / 重启

| 动作 | 旧码 | 已加入的 agent | 新 agent |
| --- | --- | --- | --- |
| 轮换识别码 | 立即无法 join（`INVALID_CODE`） | 继续可用，不受影响 | 用新码 join |
| 吊销某个 agent | 不变 | 该令牌立即失效（`INVALID_TOKEN`） | 用当前码 join |
| 进程/容器重启 | 码不变 | 令牌摘要不变，继续可用 | 正常 join |

重启稳定依赖 `BOX_AGENT_ACCESS_PATH` 指向持久卷。生产 compose 已把它固定到
`/app/apps/local-engine/data/agent-access.json`（挂载的 data 卷）；如果没有设置，
生产默认值是 Next standalone 目录下的 `data/agent-access.json`，容器重建即丢失，
表现为“每张图的码都换了”。活体会话本身是内存态：重启后编辑器标签页会自动重新
attach，不需要重新 join。

## 接入失败时

| 返回 | 含义 | 下一步 |
| --- | --- | --- |
| `401 INVALID_CODE` | 码不存在或已轮换 | 回面板重新复制完整码（`MAP-XXXX-XXXX-XXXX`） |
| `409 AGENT_LIMIT` | 该图 agent 达上限 | 面板吊销不用的 agent 后重试 |
| `401 CROSS_MAP_TOKEN` | 令牌属于另一张图 | 用目标图的码重新 join；令牌不可跨图 |
| `409 EDITOR_NOT_ATTACHED` | 没有打开的编辑器标签页 | 打开 `map.editorUrl` 并保持可见 |
| `409 EDITOR_STALE` | 2 分钟没心跳 | 确认标签页未被挂起；重开地图 |
| `504 EDITOR_TIMEOUT` | 回执超时 | 先 `observe` 确认是否已生效，别盲目重放写操作 |

错误响应只包含错误码、可读消息和下一步提示；不回显识别码、令牌或别的地图 id。

## 文件索引

| 文件 | 职责 |
| --- | --- |
| `apps/game/server/agent-access.ts` | 地图识别码存储（码/令牌/日志/产物） |
| `apps/game/pages/api/agent/v1/join.ts` | 地图码 join |
| `apps/game/pages/api/agent/v1/state.ts` | 面板数据源 + 轮换/吊销 |
| `apps/game/pages/api/agent/v1/map/[projectId]/[[...action]].ts` | agent 令牌创作面（tools/tool/status/save/artifacts） |
| `apps/game/src/views/edit/components/agent-active/` | 编辑器面板 UI |
| `apps/voxa/server/agent-access.ts` | VOXA 识别码存储（workspace 级） |
| `apps/voxa/pages/api/agent/v1/{join,state,models}.ts` | VOXA join / 面板 / 模型构建面 |
| `apps/voxa/src/views/agent-active/` | VOXA 面板 UI |
