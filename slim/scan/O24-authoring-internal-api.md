# O24 · `/edit` 公网化后 internal 创作面的可达性 + save/preview 顺序约束（B/D 泳道，2026-10-18）

承重结论一句话：**`/api/internal/**` 在路由层照样被公网命中（前缀被网关剥掉、Next basePath 恒空），能不能做事只取决于 TCP 对端是不是回环 —— 出厂编排下答案是"打不通（403）"，但这个保证 100% 依赖部署形状，同 netns 形状实测就是 200。**

---

## 1. 分流规则（源码级，`distribution/play-lite/gateway.js`，只读取证未修改）

| 事实 | 出处 |
|---|---|
| 前缀表由运维 env `BOX_GATEWAY_ROUTES` 提供，出厂样例：`{"prefixes":{"/edit":"creator","/admin":"player-service"},"default":"play","slashRoots":["/admin"]}` | `gateway.js:43`（解析）、`:49-52`（读取）；样例原文见 `box3-re/tmp/g1-prep.txt` / `g1-slash-raw.txt`（UTF-16，本泳道解码后引用） |
| **最长前缀 + 段边界**命中：`/edit` 命中 `/edit` 与 `/edit/x`，不命中 `/editable` | `gateway.js:69-81` `selectUpstream()` |
| 命中前缀后**剥掉前缀**再拨上游：`/edit/projects` → 上游收到 `/projects` | `gateway.js:95-101` `stripPrefix()` |
| 无 `deny`/`allowlist` 概念：网关只按前缀转发，鉴权一律留在服务内部 | 文件头注释 `gateway.js:12-20`（"不做鉴权…不改 header"） |
| creator **不发布任何宿主端口**，公网唯一入口是 path-gateway；服务间用 Docker DNS 名 | `compose.gateway.yml` 的 `creator.ports`（注释"不发布任何宿主端口"）与文件尾"内部互联一律用 Docker DNS 名，绝不填公网回环地址" |

⇒ 对 internal 的直接推论：**`/edit` 前缀不是保护**。`GET /edit/api/internal/map-authoring/<id>/status` 会被剥成 `/api/internal/map-authoring/<id>/status` 打给 creator 进程；无前缀的 `/api/internal/…` 则落默认 `play` 进程（同一份 Next 代码，两个 `BOX_DEPLOYMENT_MODE`）。

## 2. Next 路由匹配（源码级）

- `apps/game/next.config.js:64-160` 的 `rewrites()` 逐条为 `/api/realtime/socket`、`/api/creator/v1/scene/socket`、`/api/session`、`/api/server-info`、`/block/:path*`、`/engine/:path*`、`/runtime/*`、`/p/:world/__local_runtime/:path*` 等 —— **没有任何一条覆盖 `/api/internal/**`，也没有 `/api/:path*` 兜底**（`grep -n "internal" next.config.js` 零命中）⇒ internal 命中 Next 页面 API 处理器本身。
- `@box/deployment-routing` 只挂 `assetPrefix`，**从不设 `nextConfig.basePath`** ⇒ Next 服务端路由器看到的 basePath 恒空，带 `/edit` 打进去 404、剥掉才命中（`gateway.js:15-18` 与 `compose.gateway.yml` ★ 关键机制段，均已由 G1b 实测）。
- 四个 internal 处理器（`apps/game/pages/api/internal/map-authoring/[projectId]/{status,tool,save,preview}.ts`）第一件事都是 `if (!allowLoopback(req, res)) return;`，且**没有一个检查 `BOX_DEPLOYMENT_MODE`** ⇒ play 进程同样服务这些路由。
- `_guard.ts:14-28`：`allowLoopback` 只看 `req.socket.remoteAddress ∈ {127.0.0.1, ::1, ::ffff:127.0.0.1}`，否则 403 `{code:'FORBIDDEN', message:'loopback-only internal route'}`。**本轮一字未改**，且不含任何密钥分支。

## 3. 实测：真 socket 过真网关（不是推断）

命令与脚本落盘：`node box3-re/tmp/b2-gw-internal-probe.mjs`，原文输出 `box3-re/tmp/b2-gw-internal-probe.txt`。
做法：真起 `distribution/play-lite/gateway.js` 子进程（`BOX_GATEWAY_ROUTES` 同出厂样例），两个上游是真 HTTP 服务，各自把 `req.socket.remoteAddress` 喂进 `_guard.ts:18-27` 的逐字复刻判定后返回 403/200。客户端从本机非回环 IPv4（`100.66.95.28`）打网关 —— 这是"跨网络命名空间"的等价形状（容器里对端是桥接网关 IP，fleet 实测 creator `172.18.0.1`、lite `172.19.0.1`）。

场景 A：跨 netns（出厂形状，上游拨号地址 = 非回环 IP）
```
GET /edit/api/internal/map-authoring/p1/status
  -> HTTP 403 {"upstream":"creator","seenUrl":"/api/internal/map-authoring/p1/status","seenPeer":"100.66.95.28","loopbackGuard":"DENY","body":{"code":"FORBIDDEN","message":"loopback-only internal route"}}
GET /api/internal/map-authoring/p1/status
  -> HTTP 403 {"upstream":"play","seenUrl":"/api/internal/map-authoring/p1/status","seenPeer":"100.66.95.28","loopbackGuard":"DENY",...}
```
注意 `seenUrl`：**路径已经剥成无前缀的 `/api/internal/...`，Next 一定命中**；挡住的是对端地址，不是路由。

场景 B：同一 netns（危险形状，上游拨号地址 = `127.0.0.1`）
```
GET /edit/api/internal/map-authoring/p1/status
  -> HTTP 200 {"upstream":"creator","seenUrl":"/api/internal/map-authoring/p1/status","seenPeer":"127.0.0.1","loopbackGuard":"ALLOW","body":{"servedBy":"creator-next-handler"}}
GET /api/internal/map-authoring/p1/status
  -> HTTP 200 {"upstream":"play",...,"loopbackGuard":"ALLOW","body":{"servedBy":"play-next-handler"}}
```
⇒ **回环门保护的是"同机"这个语义，不是"公网不可达"这个语义**。谁把网关和 Next 塞进同一个 netns（或把 internal 面所在进程自己暴露出去），internal 立刻变成公网可写面。

附带两条边界实测（同一次运行）：
- `GET /edit/%2e%2e/api/internal/map-authoring/p1/status` → 上游收到 `/api/internal/map-authoring/p1/status` 且 `upstream":"play"`：`..` 在 URL 规范化阶段就被折叠，**请求脱离了 `/edit` 前缀、改落默认上游**。⇒ 不能把网关前缀表当路径 allowlist 用。
- `GET /editable/api/internal/x` → `upstream":"play","seenUrl":"/editable/api/internal/x"`：段边界判定有效，`/editable` 不会被误转给 creator。

## 4. 收紧（按可落地度排序）

1. **部署不变量（已在 `compose.gateway.yml` 里，必须当作验收项守）**：creator/play/player-service 不发布宿主端口；网关上游一律 Docker DNS 名（`http://creator:3000`），**绝不允许 `127.0.0.1`、`host.docker.internal` 或宿主发布端口回环**。违反即退化成上面场景 B（实测 200）。这是 internal 面公网不可达的**唯一实际支撑**。
2. **网关侧显式拒绝（属 G1b 泳道，本泳道不改 `distribution/**`）**：建议在 `selectUpstream()` 前加一条 deny —— 规范化后的 pathname 命中 `/api/internal/` 前缀即 403 `INTERNAL_ROUTE_DENIED`，并只允许从 `127.0.0.1` 对端的服务间调用。这样第 1 条被破坏时还有第二道，且把"403 的存在性泄露"变成明确的网关语义。
3. **应用侧模式门（建议，需 B/C 决策，本泳道不动 `_guard.ts`）**：internal 处理器目前不检查 `BOX_DEPLOYMENT_MODE`；play 进程没有理由服务地图写面。加 `if (process.env.BOX_DEPLOYMENT_MODE !== 'creator') return res.status(404).end()` 属于 `_guard.ts` 之外的改动，但需要与 A/C 泳道协调，本轮**未做**。
4. **AI 流量收口（本泳道已做）**：AI 写工具面已提升到 `/api/creator/v1/authoring/*`（带身份、审计、撤销、限流，见 `plan/N6-ai-access-bridge.md`），MCP/AI 侧不应再打 `/api/internal/*`；internal 回归它的设计语义：同机编排（编辑器面板、本地 launcher）。

## 5. save/preview 顺序约束（源码依据，实跑核对）

主控给的口径 `services/game-server/src/replica-server.ts:1602` **路径少了一层**，实际文件是 `services/game-server/src/edit/replica/replica-server.ts`（`find . -name replica-server.ts` 唯一命中）。原文（`sed -n '1592,1616p'`）：

```
  // save voxel, script and hash links into project
  private async _storeProject() {
…
    // update voxel hashes only if game isn't running
    const gameState = this._state.game.state;
    if (!gameState.replica.running) {
      const voxels = await recordVoxelInfo(gameState);
      if (voxels) {
        if (… && !VoxelRDA.stateSchema.equal(voxels, replicaState.project.voxels)) {
          actions.push(ProjectRDA.action(store).voxels(voxels));
        }
…
```
`grep -n` 定位：`1600: // update voxel hashes only if game isn't running`、`1602: if (!gameState.replica.running) {`、`1603: const voxels = await recordVoxelInfo(gameState);`。⇒ **预览在跑时保存，体素 chunk hash 整段被跳过**，写盘的是一个地形哈希陈旧（或未记录）的工程，且没有任何报错。

两层拒绝（都是本轮实测过的代码，不是文案）：
- **引擎内**：`services/game-server/src/edit/ai/ai-tool-route.ts:24-27` 声明"hard ordering rule（terrain writes refused with PREVIEW_RUNNING …replica-server.ts:1602）"，`:193-198` 把 `PREVIEW_RUNNING`/`REVISION_CONFLICT` 映射成 HTTP 409。
- **路由层（本泳道新增，creator/v1）**：`apps/game/server/creator-authoring-bridge.ts:522+` 的 `saveAuthoringProject()` 先 GET 运行时 `internal/creator-preview-runtime`，`isPreviewRunning()`（`:220`，接受 `{running:true}` 与 `{phase:'running'}` 两种上报形状）命中即 **409 `PREVIEW_RUNNING` 且完全不触碰保存路由**，除非 `force:true`；探针本身失败则不阻断合法保存（由保存自身定性）。拒绝行仍落审计，`detail` 带 `replica-server.ts:1600-1602`。

测试原文（`node --experimental-strip-types server/creator-authoring-bridge.test.ts`，`cd apps/game`）：
```
ok - save：预览在跑即 409 PREVIEW_RUNNING，且完全不触碰保存路由
ok - save：force:true 显式越权，仍然落一行可归因审计并记录 after revision
ok - save：预览探针挂了不阻断合法保存（由保存自身定性）
ok - 预览运行判定覆盖运行时两种上报形状
```

## 6. 负向结果 / UNVERIFIED（不藏）

- `UNVERIFIED（真容器）`：本轮禁碰 docker 与现网容器，**没有**在 `box3-lite-creator-1` 里跑 `curl 127.0.0.1:3000/api/internal/...`。fleet 的 `172.18.0.1 → 403 / exec 内 127.0.0.1 → 200` 是**二手证据**（原文记录在已被 stash 的 `apps/game/server/ai-authoring-access.ts` 头注释，`git stash list` 可取回），本泳道用本机跨 netns 等价形状复现了同一条判定，但容器实测仍缺。
- `UNVERIFIED（真 Next 进程）`：`seenUrl` 由真网关转发得到，但上游是复刻探针而非 `next start` 的进程（本仓 `@box/apis`、`@box/player-policy` 等均无 `dist/`，Next 无法在此环境构建），所以"Next 路由表确实命中 `/api/internal/*`"这一条仍是源码级 + 注释级证据（第 2 节），不是进程级实测。
- `已证红的既有缺口`：`cd internals/apis && node scripts/generate-openapi.mjs --check` → 原文
  ```
  Error: openapi/openapi.json is stale; run npm run generate
  ```
  **本轮改动前就已 stale**（`internals/apis` 目录 git 状态干净），说明新加的 5 条 creator/v1 路由要进契约必须由有权限的泳道跑一次 `npm run generate`；本泳道按边界未碰 `internals/apis/**`。好消息：`verify.yml` 的 `verify` job 只跑 `format-check + lint`（`scripts/repo-tasks.js:186-189`），`check:openapi` 挂在 `check` 任务（`:51`）上，不在 CI 阻断面内。
- `UNVERIFIED（格式化门）`：`node scripts/format-repository.js` 与 `apps/game` 全量 jest 都跑不起来 —— `tools/repo-tooling` 里没装 `prettier`（`require.resolve('prettier/bin/prettier.cjs', {paths:['tools/repo-tooling']})` 直接抛错），jest 侧 `Cannot find module '@box/apis' from 'server/player-service-client.ts'`（11 个用例全红）。因此本轮所有测试都用**零依赖 standalone runner** 跑（下节命令）。
- 单文件 tsc 对照（证明新路由不引入新类型问题）：出厂路由 `pages/api/creator/v1/projects/[projectId]/runtime/index.ts` 与新 5 条 authoring 路由的错误集合**逐字相同**，只有一条既有缺口：
  ```
  server/player-service-client.ts(2,27): error TS2307: Cannot find module '@box/apis' or its corresponding type declarations.
  ```
  `server/creator-authoring-bridge.ts` + `shared/creator-cli-policy.ts` 单独 tsc（`--strict --skipLibCheck`）：**0 错误**。
- `eslint`（apps/game 本地 bin，默认配置发现）对全部新增/修改文件：**exit 0**。

## 7. 可复跑命令（本机实测有效，宿主 node v24.18.0）

```bash
cd box3-local-engine/apps/game
node --experimental-strip-types server/creator-authoring-bridge.test.ts   # 28/28
node --experimental-strip-types server/creator-api-security.test.ts        # 13/13
node --experimental-strip-types --check "pages/api/creator/v1/authoring/[projectId]/tools.ts"
node box3-re/tmp/b2-gw-internal-probe.mjs   # 网关可达性探针（原文输出落 box3-re/tmp/b2-gw-internal-probe.txt）
```
jest 模式（依赖 `rush install` + `@box/apis` 构建后才可用）：`node_modules/.bin/jest --runInBand --runTestsByPath server/creator-authoring-bridge.test.ts server/creator-api-security.test.ts` —— 当前环境**跑不通**，见上节负向结果。
