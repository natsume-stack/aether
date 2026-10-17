# BOX3 本地引擎：轻量化与私有化改造 —— 分析与计划

生成时间：2026-10-17 ｜ 方法：7 条泳道并行取证 + 主控亲自复测（拒绝转述）
状态：**方向已从"逆向"改为"白盒 fork-and-slim"**，因为 v2026.1.4 起官方 MIT 全量开源。
本文所有数字都来自实际执行过的命令；未测到的标 `UNVERIFIED`。

---

## 0. 结论（先给判断）

1. **不需要逆向。** 上游在 v2026.1.4（2026-10-16）把引擎以 **MIT** 全量开源，并且**删光了许可证机制**：六套产物全量 grep `boxlic / BOX_LICENSE / /run/secrets / device-id / trusted-time` **零命中**，新 `compose.yml` 的 12 行 license 挂载归零。`LICENSE.md` = MIT Copyright (c) 2026 深圳奇梦岛。→ **私有化部署在法律与技术上已无障碍，直接读源码。**
2. **你这台机器已经升到最新版**：`v0.3.0 → v2026.1.4`，6 镜像 SHA256 全对，7/7 healthy，数据零变化（4983 文件、203,016,544 B 与升级前逐字节一致）。详见 §1。
3. **"选 JS 所以臃肿"这个前提，被实测否证。** 三条独立证据：
   - 整栈 7 容器**空闲总 RSS 313.67 MiB**、接口 TTFB 中位 **6.9 ms**（升级后我复测 442 MiB 是启动预热值，稳定后回到 330–334 MiB）；
   - 真正的重量在**交付层**：WSL 的 `vmmem` 向宿主实收 **5.3–6.1 GB**，而 `.wslconfig` 保留 12 GB——用户感知的"重"几乎全部来自 Docker+WSL 这层税；
   - 产物里的胖，**主要是打包纪律问题而不是语言问题**：跨镜像**字节级重复 613 MB**；单个 JS 镜像 **39%（≈154 MB）是构建期工具**（`@swc/core` 48 MB 运行时 0 处引用、typescript 33、babel 31、esbuild 11、sass 4、AMP 4、sql.js debug 变体 22.7）；最极端的例子是 `player-auth-portal`——**应用本体 280 KB，镜像 230 MB**。
4. **但你对"不利于个人组织私有化"的直觉有一半是对的**，只是原因不是 JS 本身：
   - 语言确实带来一个硬约束：脚本沙箱是 **`isolated-vm@5.0.4`（V8/glibc 绑定的 `.node`，非 N-API）**，它把服务端**锁死在 Node**——无法纯 V8 SEA 单文件化、无法跑在 Bun(JSC) 上。所以"20 MB 单二进制交付"这条路在保留现有作者脚本生态的前提下走不通。
   - 真正的私有化拦路虎是**交付形态**：必须有 Docker Engine + Compose v2（`bootstrap.sh:190` **显式拒绝 podman**）、**PostgreSQL 必须**、`server-manager` 必须常驻并挂 **`/var/run/docker.sock` + `user:"0:0"`**（等价宿主 root）、`install.sh` 写死 `assets.box3.fun` 且 `validDownloadBase()` 拒绝自建 CDN 域名。
5. **推荐路线：三层瘦身（fork-and-slim），不重写。** 依据：源码 47 万行 / 34 个 project；作者脚本契约面明确可枚举（**服务端 398 个可调用、客户端 32 个**，见 §3.4）；74% 的 game-server 复杂度是为"跑不可信玩家 JS"而存在的本质复杂度。换语言不会消掉这 74%，只会把它重新付一遍。**（2026-10-17 PoC 事后印证：把每图独立进程换成同进程 N isolate 后，一个挂死脚本就把同伴 tick 从 6.25 ms 拖到 127.28 ms、堆外 Array buffer OOM 后 RSS 回落不了（2200.7 → 2173.6 MB）—— 进程边界买到的隔离性不是"冗余"，是本质复杂度。见 §4.2 与 `impl/GATES.md` §4。）**
6. **可达目标（有证据的量化承诺）**：
   - P0（打包与发行，零运行时改动，1–2 周）：分发 **1011.5 MiB → ≤550 MiB**；`docker load` 后 content **2.74 GB → ≤1.4 GB**；`/app` 从 398 MB → **≈190 MB**。
   - P1（部署形态，2–4 周）：常驻容器 **7 → 3**、宿主端口 **9 → 3**、**去掉 docker.sock 特权**（出厂代码已支持：`launcher.js:254` 无 `BOX_RUNTIME_MANAGER_URL` 就走 shared-Node；官方 `distribution/play/README.md` 已是"只 2 镜像开服"的先例）、真离线自托管安装可用。
   - P2（运行时，**PoC 已定生死：isolate 池路线被否决**）：~~每图 **3 进程 → 1 进程 + isolate 池**；每图增量 RSS **150–200 MB → 15–25 MB**~~ → **该路线 2026-10-17 PoC 否决**（1 个挂死 isolate 使同伴 tick p99 从 6.25 ms 恶化到 127.28 ms，门 20 ms；4 isolate 并发 OOM 峰值 HWM 2200.7 MB、dispose 后仍 2173.6 MB 不回落。详见 §4.2 与 `impl/GATES.md` §4）。P2 只保留两项低风险：**删 creator 递归监督进程**、**冷启动路径去同步 IO**；首图 **3–6 s**、第 2+ 图 **<2 s**、名义内存预算 **12.94 GB → ≤5.9 GB** 三项仍为 `UNVERIFIED` 目标。
7. **我的额外见解（与"追求最轻"相反的提醒）**：对小组织，**运维面的数量**（容器数/端口数/特权数/外部依赖数）比**字节数**更影响可用性；而 v2026.1.4 证明了一个反向趋势——**内存上限被砍（player-service 1g→256m、auth 128m→64m）但磁盘字节反而 6/6 全部变大**（creator 658→679 MB 等，合计 +120 MB）。**上游只会加不会减**，所以若不自己建 CI 体积门，任何一次升级都会把瘦身成果吃掉。

---

## 1. 升级执行记录（对应任务项 3，已完成）

| 步骤 | 实测结果 |
|---|---|
| 最新版核对 | `https://assets.box3.fun/local-engine/latest.txt` = **`2026.1.4`**（GitHub tag `v2026.1.4`，commit `a35455d814`，发布 2026-10-16） |
| 服务器包 | `BOX3-Engine-Server-2026.1.4-linux-amd64.zip` = **25,294 B**，解包 14 个文本文件，`BOX3-PACKAGE-MODE.json` `{"mode":"slim"}` → **包内零镜像** |
| 镜像归档 | 6 个 tar.gz 合计 **1,060,646,139 B**，逐个 `sha256sum` 与 `BOX3-IMAGE-CATALOG.json` 双校验（sha 相同 **且** 字节数相同）：**6/6 VERIFIED** |
| 导入 | `docker image load` ×6。**坑：归档里只有 `launcher-content-<imageId>` 内容 tag，没有 compose 引用的 `v2026.1.4-linux-amd64`**（构建器故意只 `docker tag` 一次）→ 必须按 catalog 的 `imageIds` 补打版本 tag，否则 `up` 会去 docker.io 拉不存在的镜像并 i/o timeout |
| 平台一致性 | 6 个版本 tag 的 `Id` 与 catalog 完全一致，`Architecture/OS` = `amd64/linux` |
| 切换 | 原地升级（保留同一安装目录，避免 Windows 侧管理器路径失效）：`compose.yml` 换成官方版（md5 与包内一致），`.env` 只改 `BOX_IMAGE_TAG=v2026.1.4-linux-amd64` 与 `COMPOSE_PROFILES=…,desktop-postgres` |
| 结果 | **7/7 healthy**；`/api/health-check` 实测 play `200 5ms`、creator `200 9ms`、player-service `200 5ms`、manager `200 43ms`；`/api/play-worlds` 返回真实地图 `cloud-4e84ee7ef626058f-imported`「起床战争」 |
| 数据完整性 | 与升级前快照逐项 diff：**4983 文件 / 203,016,544 B 完全一致**；creator 容器内仍见 3 个工程（`yunhai-xiantu` 等）；Postgres 卷未动 |
| 回滚 | 快照目录 `/root/box3/upgrade-snapshot-<ts>/`（compose/.env/SHA256SUMS/每容器 inspect/数据清单）+ `tools/` 下 4 个可复跑脚本 |

**顺带查明的一个真问题**：你这台机器原本是**三向失配**——宿主目录声明 0.2.0、`.env` 写 0.2.0、容器实际跑 0.3.0（桌面管理器换 tag 的机制产物，`launcher-content-*` tag 与 6 个 `.env.bak-*`、`patches/` 是痕迹）。**以后升级必须用官方 install.sh，不要混用桌面管理器与手工 compose。**

---

## 2. 现状事实基线（v2026.1.4 实测）

### 2.1 交付与资源

| 指标 | 出厂值 | 备注 |
|---|---|---|
| 常驻容器 / service 总数 | **7** / **11**（含 3 个一次性 `*-storage-init`） | compose profiles: creator/play/voxa/player-service/auth-portal/desktop-{postgres,redis} |
| 宿主发布端口 | **9**：3121 3123 3124 3125 3127 5432 9966 9967 + `0.0.0.0:3130` | 9966/9967 是地图运行时前门，只绑 127.0.0.1 |
| 分发字节 | **1,011.5 MiB gz**（6 归档）；ZIP 仅 25 KB | 首网要拉满 1 GB |
| `docker load` 后 content | **2.74 GB**（creator 679 / play 616 / ps 513 / voxa 484 / auth 230 / manager 215 MB） | 对比 v0.3.0 的 2.6 GB：**变胖 120 MB** |
| `docker system df` | 8.26 GB（含重复），2.63 GB 可回收 | 本机还留着 0.2.0/0.3.0 旧 tag |
| 空闲 RSS | **313.67 MiB**（12×10s 均值）；Rust manager 仅 **2.16 MiB** | 单个 `next-server` 92–122 MiB，**≈43 倍差** |
| WSL 宿主实付 | **vmmem 5.3–6.1 GB**（WSL 内只报 used 1.57 GB） | 用户感知的"重"主要在这里 |
| TTFB | JS 服务中位 **6.9 ms**（2–11 ms），Rust **1.6 ms** | 说明"慢"不在 JS |
| 全栈到 healthy | **11.5 s**（单服务 6.6–10.8 s，VM 起后、镜像已缓存） | 冷启（先 down 再 up）实测 play 4.16 s |
| 外部强依赖 | Docker+Compose v2（**拒 podman**）、**PostgreSQL 必须**（无它 `map-admission` 返回 false，进不了图）；Redis 可选（出厂 `BOX_REDIS_MODE=disabled`，实测未部署） | |
| 客户端首屏 | Play 首页浏览器实下 **315,903 B**（HTML 51.5 KB + 20 资源，JS 220 KB）；镜像内 chunk 口径 `/p/[gameName]` **598,064 B**；`static/media` 字体 **34 MB**、creator 另有 Monaco **13 MB** | 登录态下的真实进图字节 `UNVERIFIED` |

### 2.2 源码结构（Rush 单仓，8486 文件）

`apps/game` 202,211 行（编辑器+游玩客户端）｜`services/game-server` 83,357 行（权威引擎/沙箱）｜`apps/voxa` 59,961｜`packages/mudb` 40,536（自研二进制 diff WS）｜`internals/schema` 36,337｜`packages/voxa-project` 34,886｜`internals/build-system` 31,892｜Rust：`apps/{deployment-manager(Tauri),manager-core,server-manager-rust}`。

**4 个 JS 镜像其实是同一个 `apps/local-engine/Dockerfile`（432 行）的 4 个 target**（`docker-compose.yml:103/286/469/556`），`launcher.js` 在 creator/play 里 **md5 相同**；`server-manager`/`auth-portal` 各自独立 Dockerfile。

---

## 3. 诊断：四个真正的臃肿源（按可省字节 × 改动半径排序）

### 3.1 打包纪律（最大、最便宜）
- **613 MB 跨镜像字节级重复**（creator∩play 共享 288.9 MB / 8668 文件；ps 再带 203 MB 同一份 web standalone；voxa 带 120.9 MB）。去重后 `/app` 唯一内容只 **419.6 MB / 9935 文件**。
- **每镜像 ≈154 MB（39%）是构建期工具**（~~预期 −154 MB/镜像~~ → **2026-10-17 A4 实测收窄**：`prune-standalone.mjs` 在 play 自带 standalone 树实删 **88,176,940 B ≈ 84.09 MiB 未压缩**、等价性通过（control/pruned 5 路径 status+bytes+ck 逐项相同、两树 `MODULE_NOT_FOUND=0`、两树 `/api/health-check` UP 200），差额属**结构性够不着**：AMP 主张 4 MB → store 命中 **0 B**（`next/dist/compiled/amphtml-validator` 是 Next 内建）、babel 主张 31 MB → store 只有 **4,478,924 B**（大头 `next/dist/compiled/babel`）、sql.js debug **22.7 MB** + isolated-vm + 后端 typescript 副本 **~24 MB** 在 `/opt/game-server` 后端树（本测试只挂 standalone，`trimmed=0`）、swc 实测 **50,398,488 B** 反比主张 48 MB 多约 2 MB。原文与逐族核对见 `impl/P0-prune-standalone.md` §2a/§4；`≤1.4 GB content`、`/app ≈190 MB`、分发 `≤550 MiB` **仍是 UNVERIFIED（0 次镜像重建）**）：根因是 `Dockerfile:236/315` 对 `.next/standalone` **整块 COPY 且不 prune**（而同一文件对 `/opt/game-server` 却做了极细的 `find -delete`——只漏了最大的那层）；放大器是 `next.config.js:45 outputFileTracingRoot=<整仓>`。
- `sql.js` 4 个 asm 变体同捆（只加载 1 个，22.7 MB 纯浪费）；字体 12 MB `.ttf` + 7.6 MB `.woff` 同字族双格式、且在 `static/media` 与 `server/chunks/static/media` **各存一份**（58.6 MB/镜像）；`typescript` 被当 prod 依赖（运行时 `require` 命中 = 0）。
- **一条修正**：早前"Monaco 被 ship 到没有编辑器的 play/ps"的判断，**在 v2026.1.4 上实测 play 镜像已无 `static/vs`**（creator 有 13 MB）→ 该项收益作废，别再列进 P0。

### 3.2 进程与内存模型（冷启动与扩展性的真瓶颈）
- 一张地图 = **3 个进程**：递归 spawn 的 launcher 监督进程 + game-server + `fork` 出的 isolated-vm 脚本进程；端口从 11000/12000 起逐个 `net.createServer` 试探（最多 512 次）。
- **creator 路径的递归监督进程是纯冗余**：`launcher.js:1024` 起监督进程，而 play 路径 `launcher.js:911-983` **已经是直起 game-server 的实现**；监督进程没有任何重启逻辑（`:359-364`）。删掉即省 **56 MB/图 + 0.4–3 s/图**。
- 内存闸是**按地图体素体积猜**：`launcher.js:136-160` 的 `voxels>64M?2048 : >16M?1024 : 512`，再叠加容器 `mem_limit`(6g/4g) 与 `--max-old-space-size`，三层互不校准。硬证据：creator `10×512 MB isolate ≈ 6 GB = mem_limit`、play `8×512 MB = 4 GB = mem_limit`——**限额就是 isolate 数量的保险系数**，而全仓 **0 处**读 `sys/fs/cgroup`、**0 处**用 `isolate.getHeapSizeSync()`。
- `prewarm=0` + `BOX_RUNTIME_START_TIMEOUT_MS=1800000`（**30 分钟启动预算**）+ 零人回收两套语义（game-server 路径 `MAX_ZERO_PLAYER_TIME=2147483647` 永不回收 vs library 路径 900 s）。
- 冷启动关键路径上有**模块顶层同步 `spawnSync tar -czf` 全工程快照**（`project-manager.js:2543-2569 → :746-793 → :1238`）与 blob 全量 link/copy（`map-group-manager.js:125-146`）——最坏可吃掉数十秒。
- 主线程自旋锁：`local-project-state.js:6596` 用 `openSync("wx")` + `Atomics.wait(SharedArrayBuffer,0,0,20)` 阻塞至多 30 s，跑在游戏服务器事件循环里。
- Web 层与引擎层同进程：Next API 路由用 `createRequire` 在运行时从磁盘载入 88 KB `project-manager.js`（含 `existsSync×45 / mkdirSync×22 / rmSync×20 / readFileSync×10`），同步 IO 落在用户点 UI 的链路上。
- 健康检查本身在烧 CPU：JS 镜像用 `node -e fetch`、Rust 用 shell 起 docker CLI（`runtime.rs:208-246` 每次 stats shell 出 2 次）→ 实测空闲 CPU 1.8–13.9% 主要来自这里。

### 3.3 架构性重复与死面
- 一个 bundle 三态 → creator 93 / play 86 / player-service 44 条 API **互为子集**，靠 handler 内 `BOX_DEPLOYMENT_MODE → 404` 自我禁用；三个镜像各存同一份 246 MB 前端，**无法按需裁剪，安全面被无谓放大**。
- HTML 基路径靠 monkey-patch `http.ServerResponse.prototype` 全量缓冲 + 正则改写（>8 MB 直接 destroy），而 `assetPrefix` 就在旁边一行。
- 容器隔离**实际不可用**：`server-manager` 需要的 `box-local-engine-runtime` 镜像在本机根本没安装（`docker images` 实测）→ 出厂态只能吃 shared-Node 降级分支，却仍要付 docker.sock + root 的代价。

### 3.4 但作者契约是有限、可枚举的（这是"不必重写"的关键论据）
- 服务端权威契约 = `packages/script-api/dts/box3-server-api.d.ts`（4603 行）：**398 个可调用**（方法式 183 + 箭头式 215）+ 1234 属性；注入 9 个全局。客户端**声明面只有 32 个可调用**，运行时实现 ≈156 个。
- 只有 `world/entity/voxels` 一族（9 个 mudb synchronizer 文件）强绑定 diff 协议；`storage` 走 `CommonGameDataStorage` 接口，**换后端是干净的**（PG→SQLite 可行，S2/S5 一致结论）。
- 包格式可独立复刻：CIDv0（`sha256+0x12,0x20+base58`）+ flat blob 仓 + `stableStringify` + 引用闭包扫描 + tar.gz → **估 <1500 行**即可自成一个 `box3-pack` 工具（不再需要 `spawnSync tar`）。
- **契约漂移已证**：`apps/game/client-api-tsconfig.json:7-10` 的 include 指向 `git ls-files` **0 命中**的旧路径 → 客户端 DTS **无法再生成**，入库物冻结；官方"脚本 API"文档站 `docs.box3lab.com/api/` 是 404 死链；`openapi.json` 里 `info.version` 仍是 `0.2.0`。
- **headless 部署缺口**（直接影响"帮本地开发者部署地图"）：~~create/publish/export/package/play-import 五个 HTTP 端点**只认玩家浏览器会话 Cookie**，CLI Token 能力集封顶 9 项且不含它们 → **今天无法在 CI 里完成"建图→发布→上服"**，必须模拟登录。~~ → **2026-10-17 终局修订（A10，依据 `plan/N2-mcp-ai-map-authoring.md` §1.4/§2.3/§8-M2，A10 已逐字复核四处 path:line）**：该判断**在源码层不成立**。`Authorization: Bearer bxc_…` 会被同一条身份链接受（`apps/game/server/player-service-client.ts:87-89` → `apps/game/pages/api/player-internal/runtime-identity.ts:21-24` → `apps/game/server/local-player-identity.ts:923`），而五条浏览器路由查的是**用户级 `creatorPermissions`**（`apps/game/server/creator-api-security.ts:105`），**`:141` 才是 9 项 CLI scope 的校验处**；`play-admin/import` **从来不是 Cookie 门**而是 `Bearer $BOX_PLAY_ADMIN_TOKEN`。**真正的阻塞换成了：地形（voxels）与 UI 树（uiTree）的服务端可编程写入口为零**（体素只能走需登录会话的 `VoxelProtocol`，`validate-project-action.ts:14-21` 明确禁止 project 级体素动作；`edit/ai/entity-tools.ts` 无体素、无 UI 工具）。**并且这条"借道"是越权面而不是便利**：只授 `projects.list` 的只读 token 也能发布/删图，9 项 scope 的最小权限承诺在这五条路由上失效。既有地基另记：**引擎已内置 15 个 zod AI 工具**（`edit/ai/entity-tools.ts:31-812`，经 `edit/edit-server.ts:192-202` 挂载，走 `replica.projectTransaction()` 写同一棵 `EntitiesTreeRDA`，**不依赖 LLM**），其中体素 0 个、UI 0 个；内置 AI 提示 `edit/ai/ai-server.ts:70` 原文 "Do NOT generate client scripts. The client API is currently not supported."。**端到端仍 0 次**（用真 token 打 publish 是否 2xx = UNVERIFIED；借道另需 PostgreSQL，`local-player-identity.ts:915`）。§5 风险表"headless/CI 部署链缺端点授权"一行**据此重述为"缺工具面 + 存在越权面"**；§4.3 的 G9 门定义行不在本次修订授权范围内，**暂与本段不一致**，以 `impl/GATES.md` §9.1 修订 1/2 为准。

---

## 4. 改进方案与计划

### 4.1 选型结论

| 候选 | 结论 | 关键理由 |
|---|---|---|
| A. fork-and-slim（改打包+部署形态） | **采纳（主线）** | 零运行时风险拿下 613 MB + 154 MB/镜像；上游已 MIT、已有 play-only 先例（`distribution/play/compose.yml`）与 shared-Node 回退（`launcher.js:254`） |
| B. Node 单进程化（isolate 池） | **已否决（2026-10-17 PoC 实测）** —— 原判断为"采纳（需 PoC）" | 原判断的形成过程（保留）：省 56 MB/图；但 `scriptTimeout` 只是"单次 apply"级、无每 tick 每 isolate 记账 → CPU 公平性与崩溃半径未证。**否决数据**：N16/H=1 时 victim `worst_during_p99` = **127.28 ms**（H=0 基线 6.25 ms，门 20 ms）、N16/H=4 → **57.8 ms**、N32/H=8 → **152.8 ms**；4 isolate 并发 OOM **峰值 HWM 2200.7 MB、dispose 后仍 2173.6 MB**；`isolateV8Heap_MB: 0.7` 说明爆的是 V8 堆外 Array buffer，heap 采样看不见。原文输出 `poc/out-poc3-sweep.txt`、`poc/out-poc4.txt`；完整判据 `impl/GATES.md` §4 |
| C. Go/Rust + QuickJS 重写 | **不采纳** | isolated-vm 已是成熟 V8 沙箱；QuickJS 对 CJS 语义与 398 面契约需重做；74% 复杂度是本质复杂度 |
| D. Bun / Node SEA 单文件 | **不可行** | `isolated-vm` 是 glibc+V8 绑定的 `.node`（非 N-API）→ 不能 SEA、不能跑 Bun(JSC) |
| E. 上 Kubernetes | **推迟（对个人组织不做）** | docker.sock 动态起子运行时须重写成 Operator/Agones；`box_engine` 动态建表 + PVC 共享 + 每图一 Pod 抖动，成本远大于收益 |

**外部对标（S7 结论，最该抄的 3 个做法）**：Gitea 式"单二进制 + 内嵌静态资源 + SQLite 默认 + 每架构签名"；systemd **Quadlet / systemd-run** 用原生 cgroup 监督替代 docker.sock（rootless-in-rootless 在 podman 上不可用，别指望）；Sigstore keyless + GitHub `actions/attest` 的 provenance/SBOM 取代 `tar.gz + latest.txt`。
**关键缺口**：本仓 **6 条 workflow 里无任何 cosign/syft/attestation 环节**——对小组织私有化部署，这比镜像大小更要命（无法验证"下载的确实是官方构建"）。

### 4.2 阶段计划

**P0 打包与产物（1–2 周，不改运行时代码）**

| 动作 | 改哪 | 预期 |
|---|---|---|
| COPY standalone 前 prune 构建工具（`.pnpm/{@swc+core,typescript,esbuild,sass,@babel}*`；sql.js 只留 1 变体） | `apps/local-engine/Dockerfile:236,315,68` | ~~−154 MB/镜像（未压）~~ → **预期列改口径**：实测可达 **−88,176,940 B/play 树（≈84.09 MiB 未压缩，等价性已证）**；creator/player-service 两棵树按同结构外推各 ≈88 MB（**UNVERIFIED，A4 只跑了 play**）、voxa 未知；剩余 ~50 MB 属 `next/dist/compiled/*` Next 内建 + `/opt/game-server` 后端树，**本工具结构上够不着**（须后端 `find -delete` 另案）。来源 `impl/P0-prune-standalone.md` §2a/§4/§5.1 |
| `typescript` 从 `dependencies` 移到 `devDependencies` | `services/game-server/package.json` | −8.9 MB×2，且**最易被上游接受的一条 PR** |
| 字体 woff2-only + 去 `server/chunks` 双拷贝 | `apps/game/assets/fonts` + `build.js:240-246` | −30~58 MB/镜像 |
| 收窄 `outputFileTracingRoot` / 补 `outputFileTracingExcludes` | `next.config.js:45,48-56` | −140 MB/镜像（依赖树二次物化） |
| **CI 体积预算门 + 构建工具黑名单断言** | `verify.yml`（现只跑格式） | 防回归，守住上面所有 |
| **目标** | | 分发 1011.5 MiB → **≤550 MiB**；content 2.74 GB → **≤1.4 GB**；`/app` 398 → **≈190 MB** |

**P1 部署形态（2–4 周，运维面收敛）**

1. **去 docker.sock**：默认用 shared-Node 运行时（`launcher.js:254` 实锤可行，官方 play-only 分发已示范不配 `BOX_RUNTIME_MANAGER_URL`）；需要隔离时用 `systemd-run`/cgroup 限额替代 Docker。→ **常驻特权进程 1 → 0**。
2. **最小开服包自动化**：新增 `package-minimal-play`，只产 play + player-service(+auth-portal)，前端静态化产物 + 极小 server。→ 容器 **7→3**、端口 **9→3**、传输 **444 MB → 150–200 MB**。
3. **真离线/自托管**：放宽 `build-image-downloads.js:15-24 validDownloadBase()`、`install.sh:123` 写死域名、`manager-core/release_channel.rs:2-3` 常量、Tauri CSP 四处；或走已存在的 `package-web --mode local` 完整离线包模式。
4. **供应链可信**：镜像 digest 钉死 + SBOM + cosign/attest（P0 内顺手做）。
5. **`.wslconfig` 立即生效**：`memory=6GB`（现在 12GB 而实际只用 0.3 GB）、`processors=4`、`autoMemoryReclaim=gradual`（治 vmmem 5.3–6.1 GB）、`networkType=mirrored`；并把 `apps/local-engine/{projects,play-worlds,data}` **留在 WSL ext4**（9P 跨 VM 每次 stat/open 有惩罚，叠加 §3.2 的同步 IO 与自旋锁会放大）。

**P2 运行时（PoC 已跑完 → isolate 池否决，2026-10-17；数据见 `poc/` 与 `impl/GATES.md` §4）**

| 动作 | 依据 | 预期 |
|---|---|---|
| 删 creator 路径递归监督进程，改直起 game-server | `launcher.js:1024` → 抄 `:911-983` | −56 MB/图、−0.4~3 s/图，**半径 1 文件、风险低** |
| 冷启动路径去同步：`spawnSync tar`、blob 全量 link、自旋锁 | `project-manager.js:2543-2569→:1238`、`map-group-manager.js:125-146`、`local-project-state.js:6596` | 首图最坏省数十秒 |
| cgroup/heap 采样闭环取代体素猜测；三层内存上限对齐 | `launcher.js:136-160,879-884`；全仓 0 处读 cgroup | 名义预算 **12.94 GB → ≤5.9 GB** |
| ~~isolate 池（每图 1 进程）~~ **已被 PoC 否决（2026-10-17）** | 原依据（保留）：`entry.ts:652-680` 有 `local/ivm2/ivmp` 三模可切；`Rust runtime.rs:382` 写的 `VM=isolate` 会被静默降级为 ivmp（**出厂未测分支**）。**否决实测**：`poc/out-poc3-sweep.txt` → H=0 时 victim worst p99 **6.25 ms**，N16/H=1 → **127.28 ms**（门 20 ms），N16/H=4 → **57.8 ms**，N32/H=8 → **152.8 ms**；`poc/out-poc4.txt` → 4 isolate 并发 OOM **峰值 HWM 2200.7 MB、dispose 后仍 2173.6 MB**，`isolateV8Heap_MB: 0.7`（爆的是 V8 堆外 Array buffer，heap 采样不可见）。N16/H=1 比 H=4 更差 → **非单调，`poc/raw3/` 同配置两 rep 相差 4.4×，抖动数待复测**（结论方向不受影响） | ~~每图增量 **150–200 MB → 15–25 MB**；64 房间从 64 进程变 16 进程（K=4）~~ → **主张作废**。（附注：`poc/out-poc2.txt` 的 loaded/K=16 实测 `perIsolate_dRSS_KB: 4533.3` ≈ 4.4 MiB 说明**合成脚本**下边际内存确实低，但那是 3,982 B 合成脚本，不含真实地图缓冲，且被 `impl/GATES.md` §4.3 的堆外 OOM 实测（并发 OOM 后 RSS 不回落）抵消，不构成翻案。） |
| 健康检查进程内化（去掉 `node -e fetch` 与 docker CLI shell） | `Dockerfile:281/347/384/428`、`runtime.rs:352-357,208-246` | 空闲 CPU 抖动归零 |

**P2 的 30 行 PoC（原文要求：**"先做这个再谈重写……**抖动 >20 ms 就放弃 isolate 池，只做前两项**"**）→ 已执行完毕**（脚本：`poc/poc1-cost.mjs`、`poc/poc2-rss.mjs`、`poc/poc3-fairness.mjs` + `poc3-sweep.sh` + `poc3-cliff.sh`、`poc/poc4-crash.mjs`），**门被触发 → isolate 池放弃**。
执行时的两条方法论偏差（照实记，别让下一个人再踩）：
1. 原定"3 个 isolate"规格**单独看是过门的**：`poc/out-poc3-async.txt` 两个 victim `jitter_during_ms.p99` = **8.41 / 3.07 ms** < 20 ms。**否决来自更大 N**（16/24/32）与 `HANG_MODE=sync`（`poc/out-poc3-sync.txt` 三个 isolate 全 **≈2965 ms**、宿主主循环 max **3011.51 ms**）。所以"3 isolate 安全"是错觉，规模化/同步宿主调用才是杀手。
2. 抖动数不可复现到 ±20 ms 级：`poc/raw3/cliff_N16_rep{1,2}.json` 同为 N16/H=1 却是 **19.85 / 13.82 ms**（刚好在门内），与 sweep 的 **127.28 ms** 差一个数量级 → 只当量级证据。若将来重启此路，第一动作是固定 CPU 亲和 + 多 rep 取中位 + 区分 sync/async + 单独度量堆外 Array buffer。

**P2 现在的落点**：只做「删 creator 递归监督进程」与「冷启动路径去同步 IO」两项。**上表 −56 MB/图、−0.4~3 s/图 仍是 `待证`**（`src/S2-runtime-hotpath.md` §1.2 的 56.6 MB 是**同类 node 进程**的空闲实测值，不是删前删后差值；`box3-re/tools/w5-launchcost.sh` 输出未落盘）。

### 4.3 验收门（每阶段必须实测）

```
G1 体积：docker load 后 content 总和 ≤ 目标值；du /app 逐项复算
G2 运行：tools/baseline.sh 空闲总 RSS ≤ 320 MiB 且 TTFB 中位 ≤ 7 ms（不得劣化）
G3 功能：现存「起床战争」地图 导入→开放→浏览器进图→脚本 onPlayerJoin 触发
G4 契约：398 个服务端可调用全部有实现；独立 box3-pack 生成的 .boxplay 能被出厂 reader 接受
G5 安全：默认 profile 下无容器挂 docker.sock / 无 user:"0:0"
G6 离线：断网环境完成安装→开服→进图（BOX3_RELEASE_CDN_URL 指内网）
G7 供应链：每个归档带 sha256 + size + 源提交 + SBOM + 签名
```

**2026-10-17 追加两门（源自用户本轮传达的三条新需求，记分板见 `impl/GATES.md` §1/§7）**

```
G8 页面：play 页面自定义改造不得破坏现有地图渲染
        回归基线（已实测口径）：认证后 GET /p/<publicId> = 200 / 149,594 B（impl/W4 §3.5）、
        Play 首页浏览器实下 315,903 B（HTML 51.5 KB + 20 资源，§2.1）；
        字体侧必须同时保住 impl/W3 §4 第 3 条（DoulosSILR.ttf + KaTeX ttf 是 live，不许一刀切）
G9 headless：AI/MCP 接管地图开发链路可无浏览器跑通
        已知缺口（§3.4 / src/S6 §5）：create/publish/export/package/play-import 五端点只认
        浏览器会话 Cookie，CLI Token 能力集封顶 9 项且不含它们 → 今天 CI 里无法"建图→发布→上服"
```

**第三条新需求是约束不是门**：所有瘦身/提速必须建立在**对原有地图的支持**上 → 任何 G1 字节收益，在 G3（现有「起床战争」进图链）与 G4（398 可调用实现覆盖）未过之前不得合入。

**九门当前状态（2026-10-17，逐项原文数字与来源见 `impl/GATES.md`）**：G1 `部分` · G2 `部分（313.67 MiB 达标 / 同刻 328.05 MiB 超标，两口径并存）` · G3 `部分（/p 200 已通，真浏览器入局与 onPlayerJoin 未证）` · G4 `未开工` · G5 `部分（lite 达标，出厂主 compose 未改）` · G6 `部分（静态核验已做，断网端到端 0 次）` · G7 `部分（sha256/size/digest 有，源提交仅 staging，SBOM 与签名全仓 0 命中）` · G8 `未开工（取证规划已落盘 plan/N1）` · G9 `未开工`。

---

## 5. 风险与未知（诚实清单）

| 风险 | 状态 |
|---|---|
| 登录态下玩家真实首屏字节、`prefetchHashes` 规模与首帧必下 blob | `UNVERIFIED`（需注册玩家 + 开放地图组，会改状态，我刻意没做） |
| isolate 池的 CPU 公平性与崩溃半径 | ~~`UNVERIFIED`，由 §4.2 的 30 行 PoC 决定~~ → **已测，结论 = 否决**（2026-10-17，`poc/out-poc3-sweep.txt` + `poc/out-poc4.txt`：N16/H=1 victim p99 **127.28 ms** 对门 20 ms；4 isolate 并发 OOM 峰值 **2200.7 MB**、dispose 后残留 **2173.6 MB**）。残留的 `UNVERIFIED` 只有一项：**恶化幅度与挂死数的单调关系**（H=1 比 H=4 差、raw3 两 rep 差 4.4×）→ 待复测，但**不影响否决** |
| **heap 采样对堆外分配失明（PoC 新发现）** | 已证：`isolateV8Heap_MB: 0.7` 时宿主 RSS 已 **592.3 MB**（`poc/out-poc4.txt`）→ `isolate.getHeapSizeSync()` / `getHeapStatisticsSync()` **看不到 Array buffer**；§4.2 里"cgroup/heap 采样闭环取代体素猜测"这一条**必须改成读 cgroup + smaps，heap 采样不足以支撑内存闭环** |
| **V8 code cache 帮不到冷启动** | PoC-1 实测 `delta_pct.total = −2.6%`、`cachedData produced = -1 bytes`（`poc/out-poc1.txt`）→ `src/S2-runtime-hotpath.md` §7-2/§9 的"省 −0.2~1.2 s"承诺**作废为待证** |
| `/etc/machine-id` 在 2026.1.4 的实际用途 | 已确认**不是许可**（`configuration.rs:892` 仅作 runtime identity，兜底 hostname+pid+time）；真实用途 `INFERRED` |
| 本地 install.sh 与官方包漂移 | 已发现本机 compose 曾被手工打过 WS-fix 补丁（现已被官方取代）；升级后已用官方文件 |
| 契约漂移继续恶化 | 客户端 DTS 生成链已断（include 路径不存在），一旦有人改 `ses/apis` 就无法同步类型 |
| `pg→sqlite` 强制降级分支 | 代码里存在 `if(storageMode==="pg") storageMode="sqlite"`，Postgres 承诺在特定路径落空 |
| headless/CI 部署链缺端点授权 | 见 §3.4，是"帮本地开发者部署地图"最实际的阻塞点 |
| 上游不接受瘦身 PR | 若 MIT 且体积回归门被拒，fork 维护成本可控（P0 全在 Dockerfile/CI 层，不碰业务代码） |
| 泳道交付缺口 | 前端(S4) 与数据(S5) 两条泳道未落盘，其职责已由 §2.1 实测 + `S8-client-payload-and-topology.md` + `S1/S2` 覆盖 |

---

## 6. 一句话可执行建议

> **别重写，也别急着上 K8s。** 两周内做完 P0（Dockerfile prune + `typescript` 挪 devDep + 字体单副本 + CI 体积门）就能把分发从 1011.5 MiB 压到 ~550 MiB；再做 P1（去 docker.sock 的 shared-Node 最小开服包 + `.wslconfig` 6 GB + 真离线）就把"7 容器 9 端口 root 特权"收敛成"3 容器 3 端口无特权"。运行时侧只先做一件低风险的事：**删掉 creator 那个纯冗余的监督进程**（省 56 MB/图，**此数仍 `待证`**）。~~isolate 池等 PoC 结果再决定~~ → **PoC 已出结果：isolate 池否决**（见 §4.2 与 `impl/GATES.md` §4）；P2 只剩"删监督进程 + 冷启动去同步 IO"两条腿。
> **P1 的 lite 形态已不是纸面计划**：`impl/W4-play-lite-package.md` 已实测 3 容器 / 3 端口 / 零特权 / 空闲 156.88 MiB / 分发 423.8 MiB，唯一必须补的是登录门户。**G1 的体积目标仍被 `pnpm-lock.yaml` 未 re-lock 卡住**（重建镜像前，任何"−154 MB/镜像"都只是承诺）。

---

## 7. 证据文件索引

> **2026-10-17 A10 终局修订追加**：本表新增 `impl/P0-prune-standalone.md`（A4）、`impl/W2-ci-size-gate.md`（A2）、`impl/W6-offline-selfhost.md`（A1）、`impl/G3-map-compat-baseline.md`（A9）、`plan/N1-play-page-customization.md`（A7）、`plan/N2-mcp-ai-map-authoring.md`（A8）与 `tools/compat-check.sh` + `baseline/` 七类条目，并扩写 W4/GATES 两行。**本文本轮只改了四处**：§3.1 的 154 MB 预期、§3.4 的 headless 段、§4.2 P0 表的 prune 行预期列、本节索引（原主张均以删除线保留）。其余段落（含 §0/§1 的 154 MB、§2.1 基线、§4.3 G4/G9 门定义行、§5 风险行、§6 建议）**未动**，与上述四处的新口径**暂不一致**，统一由主控决定何时回写。

| 文件 | 内容 |
|---|---|
| `ANALYSIS-AND-PLAN.md` | 本文 |
| `A-docs.md` | 官方文档全量取证：local-engine **18 页**、arena 88 页、voxa 32 页、arenapro 53 页；版本机制、许可、服务拓扑、脚本 API 原文、体积数值 |
| `B-size-audit.md` | 6 镜像逐层体积、613 MB 重复的 md5 证明、154 MB 构建工具、top20 chunk 归属、理论下限 |
| `C-architecture.md` | 进程模型、路由表、沙箱、持久化、令牌矩阵、10 条代码可证设计问题（全部 `file:line@offset`） |
| `E-runtime-baseline.md` + `tools/baseline.sh` | 空闲 RSS/CPU/进程树/healthy/TTFB/WSL 税；可复跑基线脚本 |
| `F-release-diff.md` | 0.2.0→0.3.0→2026.1.4 逐项 diff、slim 包机制、三向失配根因、升级风险与脚本 |
| `src/S1-build-pipeline.md` | 产物流水线全图、每块可删字节的 `path:line`、去重 5 方案、最小开服包设计、CI 缺口 |
| `src/S2-runtime-hotpath.md` | 进程/内存模型解剖、isolate 池可行性、锁与同步 IO、改进清单（收益/半径/风险/可否上游） |
| `src/S6-script-contract.md` | 398/32 可调用契约面、包格式 writer 最小集（<1500 行）、blob 换存储半径、headless 缺口、契约漂移实证 |
| `src/S7-cloudnative-benchmark.md` | 外部先例对比、去 Docker 路径、K8s 取舍、WSL2 调优、运行时前沿数据、fork vs 上游成本模型 |
| `src/S8-client-payload-and-topology.md` | **我亲自测的**客户端首屏字节（wire + manifest 两种口径）与部署形态计数 |
| `impl/W3-fonts-and-prod-deps.md` | 字体单副本真删（−22,949,789 B）+ typescript 挪 devDep 的五路 0 命中证据链 + 镜像断言清单 |
| `impl/W4-play-lite-package.md` | play-lite 3 容器/3 端口/零特权**真实跑起来**的原文输出（RSS 156.88 MiB、分发 444,381,911 B、`/p/<publicId>` 200/149,594 B、`createSession` 200）；**§11（A3 续写）= 补回登录门户后的 4 容器形态**：4 端口全 127.0.0.1（新增 4125）、docker.sock 0、常驻 root 0、无密钥自助注册 201 → 回调 303 → `/p` 200/149,594 B、分发 **531,307,786 B = 506.7 MiB（−49.9%）**；RSS/TTFB 按纪律未测（§11.6） |
| `impl/P0-prune-standalone.md` | **A4**：`prune-standalone.md` 首次真实等价性验证 —— removed **88,176,940 B**（226,663,944 → 138,487,004）、5 路径 status/bytes/ck 逐项一致、`MODULE_NOT_FOUND 0/0`、逐族覆盖度核对（AMP 0 B / babel 4,478,924 B / sql.js `trimmed=0`）与 G1 推算；原始 stdout `tmp/eq2_out.txt` |
| `impl/W2-ci-size-gate.md` | **A2**：CI 体积门接线 —— 动手前**门不可运行**的三缺陷（`lib/budget.mjs:146-150` JSDoc `**/` → 加载即 SyntaxError；`REPO_ROOT` 少一层；黑名单表 0 消费者）、新增 `ratchet` 档（数值 = `basis.observed`）、**红/绿各次原文**（棘轮 exit 0 / `transition` **+66.7% 红** / 上游 +120 MB 重放红 / 黑名单 10 项红 / `--self-test` PASS / `node --test` 19/19）、阈值推导审查（`measured` 加总 ≠ `basis`、play==creator 疑似复制粘贴）、遗留 U1–U9 |
| `impl/W6-offline-selfhost.md` | **A1**：离线/自托管链核验 —— `bash -n` ×3 / `node --check` ×2 全 0、**`release_channel.rs` +261 行两处 E0277 已修 + `rustc --test` 4/4 绿**（整 crate `cargo check --offline` exit=101 缺 `tar/urlencoding/zip` → UNVERIFIED）、三层策略矩阵一致、**G6 缺口 8 条**、G7 逐要素表（SBOM/签名/attestation 全仓 0 命中）、决策 D1–D4 |
| `impl/G3-map-compat-baseline.md` | **A9**：G3/G4 兼容性回归基线 —— `tools/compat-check.sh`（56 检查项，全量 10.032 s / 静态 1.557 s）+ `baseline/g3-baseline.tsv`（56 key）+ `baseline/contract-server-api.members.tsv`（**2730 行**，指纹 `5bcc18f8…`）、首轮 **52 PASS/0 FAIL** 与篡改 4 项报红、**398 复现但语义 313**、**86 个未声明自定义属性 + 55 个声明面被调用**、素材表（唯一可用图「起床战争」908 文件 / 27,992,660 B；3 工程 `releases: []`）、改动×必过项映射表、L3 全层 UNVERIFIED |
| `plan/N1-play-page-customization.md` | **A7（G8 前置）**：play 页面锁定点 `path:line`（`pages/index.tsx:934-949/1491+/2918`、`server/play-worlds.ts:22/69`）、**现成 `theme` 4 值令牌链**（`project-types.ts:30` → `project-manager.js:2442` → `project-card.tsx:37`，赋值 `:1118-1127` 自动轮询、play 不读）、`play-admin.ts:858-861` 主动禁止服主改标题/封面、档一 4 文件 ~40–80 行切片、`project-editor-dialog-ui.test.ts:152` 硬断言、6 条 UNVERIFIED、5 条待批 |
| `plan/N2-mcp-ai-map-authoring.md` | **A8（G9 前置）**：四件接管事项可编程面取证表、鉴权攻坚（**五端点"只认 Cookie"被源码推翻** + 借道即越权面）、**内置 15 个 zod AI 工具（体素 0 / UI 0）**、MCP 工具面 L1–L4、验收闭环 V0–V6、兼容护栏 C1–C11、改造项 R1–R9、切片 A/B/C、6 条 U + 3 条矛盾 M1–M3、决策 D1–D7 |
| `box3-re/tools/compat-check.sh` + `box3-re/baseline/` | A9 交付的**可跑兼容性门**与基线（`g3-baseline.tsv` 56 key、`contract-server-api.members.tsv` 2730 行）；复跑入口见 A9 文末附录 |
| `impl/GATES.md` | **G1–G9 × 22 项改动记分板**（已实测/部分/待证/未开工）+ isolate 池否决决策 + **26 条文档矛盾清单**（§6）+ 决策日志（§7，含 22 条待用户决策）+ **§9 终局修订（A10）：8 组"~~原主张~~ → 修订为"、G1–G9 最新状态、主控转述与一手文档不符 7 条** |
| `poc/` | isolate 池生死判定的**原始输出**：`out-poc1.txt`（code cache）、`out-poc2.txt`（每 isolate RSS 斜率）、`out-poc3-*.txt` + `out-poc3-sweep.txt` + `raw3/`（CPU 公平性）、`out-poc4.txt`（崩溃半径与 OOM） |
| `tools/` | `wsl-run.sh`（WSL 只读取证封装）、`baseline.sh`、`stage-release.sh`、`tag-images-2026.1.4.sh`、`upgrade-inplace-2026.1.4.sh`、`finish-upgrade-2026.1.4.sh`、`measure-payload.sh`、`measure-client-payload.sh` |
| `D:\desktop\神奇代码岛\box3-local-engine` | 官方源码克隆（tag `v2026.1.4`，8486 文件）——**只读**，任何改动请另开 worktree |
