# Agent 驱动引擎：运行、验收与接入

这份文档只描述**怎么跑起来、怎么确认它在工作、AI 怎么接进来**。它不是设计讨论，
所有命令都可以直接复制执行。

## 1. 一条命令启动

```bash
node scripts/agent-stack.js
```

它会做三件事：

1. 构建工作区依赖（`@box/apis`、`@box/schema` 等），再启动源码服务；
2. 等待每个服务真正可探测，而不是"进程起来了就算"；
3. 打印服务表、编辑器入口、当前识别码、可直接粘贴的 MCP 配置。

只看状态、不启动：

```bash
node scripts/agent-stack.js --status      # 人读
node scripts/agent-stack.js --status --json  # 机器读（CI / agent），不健康时退出码 1
```

### 服务与端口

| 服务 | 端口 | 健康判据 | 说明 |
| --- | --- | --- | --- |
| creator | 3127 | `GET /api/health-check` → 200 | 地图编辑器 |
| voxa | 3123 | `GET /api/agent/v1/state` → 200/401 | 模型编辑器（401 = 端口活着，只是没登录） |
| player-service | 3124 | `GET /api/health-check` → 200 | 玩家身份 |
| edit-runtime | 9967 | TCP 握手成功 | 地图预览运行时；它说的是游戏线协议，HTTP 探测会挂住 |

`edit-runtime` 用 TCP 而不是 HTTP 探测是有原因的：这个端口收到 HTTP GET 不会返回，
用 HTTP 探测会得到"超时"，看起来像挂了，其实完全正常。

Play（3121）和玩家后台（8000）默认不启动：它们不在创作环里，而且每个都实占内存。
需要时：

```bash
node scripts/agent-stack.js --with-admin      # 带上玩家后台
```

### Windows 前提

依赖构建脚本是 POSIX 一行式（`rm -rf build`）。`agent-stack.js` 会自动把
`C:\Program Files\Git\usr\bin` 放到 PATH 前面；如果没装 Git for Windows，
构建会在第一个依赖就失败，报 `'rm' 不是内部或外部命令`。

## 2. 活体通道是什么

不是"AI 生成文件 → 你刷新看结果"，而是：**AI 的每个动作都在你打开的那个编辑器里执行**。

| 你看到的 | 底层走的路 |
| --- | --- |
| 镜头平滑移动 | `look` → 编辑器相机 tween（地图）/ `camera.setPosition` + `orbitControls.update()`（VOXA） |
| 光标跟着方块走 | `cursor` → 地图的体素光标 / VOXA 原生 `Pointer.setAgentVoxelPosition` |
| 方块一格一格出现 | `place_path` / `paint_path` 逐格提交 + `paceMs` 停顿 |
| 代码在 Monaco 里出现 | `script_replace` / `script_insert` → 编辑器文本模型（和人工输入同一条同步链） |
| 人一动鼠标就交还视角 | `pointerdown` / `wheel` → `release_camera` |

硬规则：

- 一条命令一个动作，命令由**当前打开的标签页**执行；标签页关了就没有身体。
- 写操作失败不要盲重试，先 `observe` 确认这一步是不是已经生效。
- 保存前先停预览（地图侧 `PREVIEW_RUNNING` 会拒绝保存）。

## 3. 接入方式（生产也用这一套）

### 3.1 地图

1. 打开 Creator → 进入一张地图的编辑器；
2. 右侧 `Agent Active` → `活体` 页签 → 应显示“编辑器已接入”；
3. 把面板上的**两样东西**交给 AI：编辑器地址（`…/e/<projectId>`）+ `MAP-` 识别码；
   或者点“复制 MCP 配置”，把整段 JSON 贴进 AI 客户端的 MCP 配置。

**不需要人工提供 project id**：`join` 响应返回 `project.id` 和 `map.editorUrl`，
MCP 客户端会自动发现。`BOX_MAP_PROJECT` 仍然可用，但它只是覆盖项。

前置条件（这不是纯网页直连）：

- 有人登录 Creator 并在该地址打开编辑器，标签页保持可见（命令由这个标签页执行）；
- AI 侧运行 MCP 客户端，或自行向 `/api/agent/v1/live/map/<projectId>/*` 发 HTTP；
- 标签页没打开时 `agent_status` 返回 `attached:false`，不要靠重试解决。

### 3.2 部署后的码持久化

地图码、令牌摘要和审计日志都在 `BOX_AGENT_ACCESS_PATH` 指向的 JSON 里。生产
compose 把它固定到挂载卷 `/app/apps/local-engine/data/agent-access.json`，因此
**容器重启/重建后码与已加入的 agent 都保持不变**。如果自定义部署没有设置这个
变量，生产默认会落到 Next standalone 目录（`…/.next/standalone/apps/game/data`），
容器重建即丢失，表现为每张图都换了新码。

生成了什么：

```json
{
  "mcpServers": {
    "box3-agent": {
      "command": "node",
      "args": ["<仓库>/tools/box3-agent-mcp/src/index.js"],
      "env": {
        "BOX_MAP_AGENT_BASE_URL": "https://box3.cdk.lat/edit",
        "BOX_MAP_AGENT_CODE": "MAP-XXXX-XXXX-XXXX",
        "BOX_MAP_PROJECT": "<地图 project id>"
      }
    }
  }
}
```

**这个 MCP 可以跑在任何机器上**，不要求在服务器上。它只做出站 HTTP。

### 3.2 VOXA

1. 打开 VOXA（本地 `http://127.0.0.1:3123`，或部署域名）；
2. 右下 `Agent Active` → `活体` 页签，会显示"编辑器已接入 · AI 可操作"；
3. 拿 `VOX-XXXX-XXXX-XXXX` 识别码，或直接点"复制 MCP 配置"。

```json
{
  "BOX_VOXA_AGENT_BASE_URL": "http://127.0.0.1:3123",
  "BOX_VOXA_AGENT_CODE": "VOX-XXXX-XXXX-XXXX"
}
```

### 3.3 上线前自检

```bash
node tools/box3-agent-mcp/src/index.js --doctor
```

它做的是真调用，不是打印配置：

- `join`：识别码还能不能换到令牌（轮换过就会红，并给出下一步）；
- `status`：编辑器标签页是否真的接入；
- `summary.map.next` / `summary.voxa.next`：直接告诉你下一条该做什么。

任一通道 `reachable=false` 时退出码为 1。

### 3.4 路径前缀（部署在 `/edit` 下）

生产把编辑器挂在 `https://box3.cdk.lat/edit`，网关剥掉 `/edit` 再转发给 creator。
所以 `BOX_MAP_AGENT_BASE_URL` 必须**带 `/edit`**，客户端会保留它：

```
https://box3.cdk.lat/edit  →  https://box3.cdk.lat/edit/api/agent/v1/live/map/<id>/cmd
```

如果写成不带前缀的域名，请求会落到 play 上游而不是 creator，表现是一堆无意义的 404。
这条有回归测试（`tools/box3-agent-mcp/test/script-tools.test.js`）。

网关还必须原样透传这些头，少一个就 403：
`Host`、`Origin`、`X-Forwarded-Host`、`X-Forwarded-Proto`、`Cookie`。

## 4. 工具面

`node tools/box3-agent-mcp/src/index.js --tools-json` 是唯一权威清单（当前 42 个）。

| 面 | 工具 |
| --- | --- |
| 地图观察/移动 | `agent_status` `agent_observe` `agent_look` `agent_cursor` |
| 地图搭建 | `agent_place` `agent_erase` `agent_place_path` `agent_fill_box` |
| 地图实体 | `agent_entities` `agent_select_entity` `agent_place_model` |
| 地图脚本 | `agent_script_files` `agent_script_open` `agent_script_read` `agent_script_replace` `agent_script_insert` |
| 地图收尾 | `agent_undo` `agent_redo` `agent_save` `agent_preview` `agent_screenshot` `agent_say` `agent_wait` `agent_release_camera` |
| VOXA | `voxa_status` `voxa_observe` `voxa_look` `voxa_cursor` `voxa_paint` `voxa_erase` `voxa_paint_path` `voxa_fill_box` `voxa_palette` `voxa_set_color` `voxa_undo` `voxa_redo` `voxa_save` `voxa_screenshot` `voxa_say` `voxa_wait` |

只读模式：`BOX_AGENT_ALLOW_WRITE=0` 会把所有写工具替换成直接报
`WRITE_DISABLED`，观察类工具照常工作。

## 5. 验证现状（诚实版）

### 已跑通的自动化检查

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 地图活体中继 | `cd apps/game && node --experimental-strip-types server/agent-live.test.ts` | PASS |
| VOXA 活体中继 | `cd apps/voxa && node --experimental-strip-types server/agent-live.test.ts` | 6/6 PASS |
| MCP 客户端 + 工具面 | `cd tools/box3-agent-mcp && node --test test/*.test.js` | 8/8 PASS |
| 工具清单 | `node tools/box3-agent-mcp/src/index.js --tools-json` | 42 个 |
| 服务自检 | `node scripts/agent-stack.js --status` | 4/4 OK |
| VOXA 活体端到端 | `BOX_VOXA_AGENT_CODE=... node scripts/agent-live-smoke.mjs voxa` | join + status 通 |

### 仍然需要在真机上看的

- 浏览器里 `look` 的镜头位移、`paint_path` 的逐格出现是否肉眼可见
  （`node scripts/agent-voxa-live-check.mjs` 会截 PNG，需要浏览器已登录）。
- 地图侧 `place_model` 的本地模型字段是否够渲染。
- 生产域名下的 join/attach：依赖网关头透传与 `BOX_CREATOR_ALLOWED_HOSTS` 配置。

## 6. 排查

| 症状 | 先看什么 |
| --- | --- |
| `--doctor` 报 `EDITOR_NOT_ATTACHED` | 编辑器标签页是否打开且可见；面板“活体”页签是否显示已接入 |
| `--doctor` 报 `INVALID_CODE` | 识别码被轮换过，回面板重新复制完整码 |
| `CROSS_MAP_TOKEN` | 用了另一张图的令牌；用目标图的 `MAP-` 码重新 join，令牌不能跨图 |
| attach 返回 200 但 status 一直 `attached:false` | 活体会话表必须挂在 `globalThis`（Next 每个 API 路由一个模块实例）；检查 `server/agent-live.ts` 的 hub 初始化 |
| 新地图第一次打开面板报 500 | `state` 路由必须 `await ensureMapAgentAccess` 再读面板状态 |
| 重启后码变了 | `BOX_AGENT_ACCESS_PATH` 是否指向挂载卷（生产 compose 已设置） |
| 生产 404 / 结果无意义 | `BOX_MAP_AGENT_BASE_URL` 是否带 `/edit` 前缀 |
| 生产 403 | 网关头透传；`BOX_CREATOR_ALLOWED_HOSTS` 是否含该域名 |
| `EDITOR_TIMEOUT` | 先 `observe`：命令可能已经生效，别盲目重放写操作 |
| 依赖构建失败 `'rm' 不是内部或外部命令` | 用 `node scripts/agent-stack.js` 启动（它会补 PATH） |
