# P2-1 · creator 递归监督进程删除（A5/A5b 泳道交付）

- 状态：**代码完成并通过桩级等价验证；体积/时延收益一律待证**
- 文件所有权：本泳道只改 `apps/local-engine/src/launcher.js`（另新建本文档）；`build.js`、`runtime-memory.mjs`、`scripts/**`、`distribution/**` 属其它泳道，未动
- A5b 收尾动作：语义审计 + argv/env 桩验证 + explicitMB 分支验证 + 仓库格式化规则核查（对 launcher.js 施加了 prettier 归一，纯空白/换行改动，`git diff` 由 +448/−251 收敛为 **+434/−251**，行数 1550→**1536**）
- 基线：`git show HEAD:apps/local-engine/src/launcher.js` = 1353 行；工作区 = HEAD + W3/W5 实测内存预算改动（约 +81 行）+ A5 监督进程删除改动

---

## 1. 改前 / 改后职责对照表（一张 creator 地图）

改前 3 进程：front-door(launcher --creator) → **监督进程(launcher --runtime-only，本轮删除)** → game-server → (fork) ivmp 脚本进程。
改后 2 进程：front-door → game-server → (fork) ivmp 脚本进程。

| 原由监督进程承担的职责 | 改前落点（HEAD launcher.js） | 改后落点（工作区 launcher.js） | 状态 |
| --- | --- | --- | --- |
| 项目校验 + 启动快照刷新（`getLaunchTarget` 在模块加载时校验 source 并 materialize 组状态） | 监督进程模块级 :127-133 | `createProjectRuntime` :1177（`projectManager.getLaunchTarget({ project: project.id })`，含 `kind !== 'source'` 拒止） | 等价 |
| per-map 内存预算三元组（voxel 阶梯 → heap/memory 上限）+ 预算报告打印 | 监督进程模块级推导并 console.log | `scriptMemoryBudget(configured*MB, voxelCount)` :1183-1184 + `scriptBudgetReport` 打印 :1185-1191 | 等价（预算公式为 W3/W5 设计，非本轮改动） |
| 存储准备：`mkdirSync(dataRoot)`、edit 模式 `makeRuntimeDataReadable`、缺失资产时 `spawnSync prepare-assets`、`validateDefaultAvatar(dataRoot)` | 监督进程 main() :644-673 | `prepareRuntimeStorage(runtime.dataRoot, runtime.startsEditServer)` :445，在 `startProjectRuntime` :1239 调用 | 等价 |
| production 下 game-server 构建存在性检查 | 监督进程 main() `if (production)` 块 | `assertGameServerBuild()` :472，`startProjectRuntime` :1240-1242（仅 production，与改前同一守卫条件） | 等价 |
| game-server argv 组装（`-r @swc-node/register src/launch.ts` / prod `dist/src/launch.js --useProdBundle`） | 监督进程 main() 内 `startGameServer` | `gameServerLaunchArgs()` :897（与 play 直起路径共用） | **桩验证逐字节一致**（§3） |
| game-server env 组装（端口、`MODE`、`BOX_*`、`SCRIPT_HEAP_MB/SCRIPT_MEMORY_LIMIT`、NODE_OPTIONS） | 监督进程模块级 sharedEnv + main() env | `buildSharedEnv(baseEnv, ports, memory)` :803 + `gameServerEnv(runtime, mode, port, hostIP)` :902 | **桩验证 152/152 字段一致**（§3） |
| 端口试探（11000/12000 起 `net.createServer` 至多 512 次） | **本来就在 front-door 的 edit-library**，监督进程不参与 | 未动（`edit-library.js:73-101`，本轮该文件零改动） | 不变 |
| 健康检查 | 双份：监督进程自身 `waitForGameRuntime(/api/health-check)`（:1210-1242，对调用方冗余）+ edit-library `waitForRuntimeReady`（真正门） | 仅 edit-library `waitForRuntimeReady`（`edit-library.js:205-218`，URL `http://127.0.0.1:<port>/api/health-check`） | 语义保留：edit-library 侧门未动；启动期"子进程死掉快速失败"靠 `handle.exitPromise`（`runtime-readiness.js:42-45` 消费），新 handle 仍提供 |
| 信号与终止（进程组连坐回收 game-server + 脚本 worker） | 监督进程 `detached` 任组长；`terminateRuntimeChild` 用 `process.kill(-pid)` | game-server 自身 `detached: process.platform !== 'win32'` 任组长（:1243-1246），同一 `terminateRuntimeChild` SIGTERM→5s→SIGKILL 逻辑 | 等价（组长 pid 由监督进程换成 game-server，`-child.pid` 连坐语义不变）；Windows 差异见 §5-D |
| 退出码传播 | game-server 非零退出 → 监督进程 `run()` 处理器 `shutdown(code||1)` → 监督进程以同码退出 → handle.exitPromise 收到 | game-server 退出直接落 `handle.exitCode/exitSignal` 并 resolve exitPromise（:1260-1274） | 等价（消费方 edit-library/runtime-readiness 只看 exited/exitPromise，无人解析旧监督进程退出码；creator 场景本就无 exit-code 外部契约——改前退出码同样止步于监督进程） |
| 崩溃重启 | **没有**（A5 取证成立：监督进程仅 `shutdown`，从不重拉）；重开由 edit-library 状态机 + `x-box-runtime-restart` 头（`edit-library.js:321`）与下次进图 `ensureRuntime` 完成 | 同一机制，未动 | 不变（无"没人做"空洞：改前也没人做） |
| 多图并发隔离 | 每图一个 detached 监督进程 | 每图一个 detached game-server（每图独立端口由 edit-library 分配，`runtimes` 按 `projectId/roomId` 键隔离） | 等价 |
| 仪表盘每图 CPU/RSS（`attachRuntimeMetrics` 采进程树） | 以监督进程为根做 /proc 树求和（**含监督进程自身 RSS**） | 以 game-server 为根求和（:603-607 注释同步改写） | 口径变化：删后每图 RSS 读数天然少一层进程——这正是 56 MB 主张的实测方法，本轮未测（§7） |
| `--runtime-only` 入口本身 | 支持 | **仍然完整支持**：参数解析 :98/:74-75、互斥校验 :257-277、main() 的 `startsPlayServer/startsEditServer`/健康检查/"BOX Project Runtime is ready" 分支 :1398-1439 全部保留 | 外部兼容（§4） |

## 2. diff 摘要（工作区 vs HEAD）

`git diff --stat` → `apps/local-engine/src/launcher.js | 685 +++++++-----`（**434 insertions, 251 deletions**）。其中混有上一轮 W3/W5 的实测内存预算改动（`require('./runtime-memory.mjs')` :190、三层上限对齐、`scriptBudgetReport`），非 A5 独有。A5 改动形态（与主控给的清单一致，A5b 复核全部在位）：

- 新增函数：`runtimePorts(env)` :112、`mapVoxelCount(size)` :153、`requiredScriptMemoryTier(voxelCount)` :160、`scriptMemoryBudget(explicitMB, voxelCount)` :196、`scriptBudgetReport(...)` :224、`prepareRuntimeStorage(dataRoot, startsEditServer)` :445、`assertGameServerBuild()` :472、`gameServerLaunchArgs()` :897、`gameServerEnv(runtime, mode, port, hostIP)` :902、`createProjectRuntime(project, port, mode, profile, instance)` :1154；`validateDefaultAvatar/readProjectHash/readCloudMapId` 加可选参数（默认值保持旧调用行为，:1392 处旧式无参调用仍在）。
- 删除：`startProjectRuntime` 内对 `src/launcher.js --runtime-only --runtime-mode <mode> --project <id>` 的递归 `spawn`（原 HEAD :1021-1090）——改后 :1237 直接 `spawnRuntime(process.execPath, gameServerLaunchArgs(), {cwd: gameServerRoot, detached, stdio:'inherit', env: gameServerEnv(runtime,...)})`，与 play 直起路径（:1022-1026）共用同一 argv/env 构造器。
- **内存预算改动未被削弱（独立确认）**：`node --check` 通过；`runtime-memory.mjs` 接线在 :190；per-map 预算在 :1183-1184；三桩对照（§3）显示 compat/explicit 两分支与 HEAD 逐字节一致、measured 分支只有 `SCRIPT_HEAP_MB/SCRIPT_MEMORY_LIMIT` 两键按设计变化（512→2048），其余 149 键一致。

## 3. argv/env 逐项等价论证 + 最小启动桩验证原文

### 3.1 静态论证要点（改后读码，逐字段）

creator 地图链路上，改后的 `baseEnv`（:1155-1174）= 旧 front-door 传给监督进程 spawn 的 env 覆盖集（旧 HEAD :1040-1064 逐键对照：`SERVER_ID/TYPE/TELEPORT_ACCESS/BOX_LOCAL_PLAYER_LIMIT/BOX_TELEPORT_MAX_ROOMS/BOX_RUNTIME_IDLE_TIMEOUT_MS/BOX_RUNTIME_NODE_MEMORY_MB/BOX_TELEPORT_CONTROL_URL/BOX_EDIT_RUNTIME_PORT|BOX_PLAY_RUNTIME_PORT/…_HOST='127.0.0.1'`，顺序与条件相同）。`buildSharedEnv` 仍直接读 `process.env` 的键（`BOX_TELEPORT_INTERNAL_TOKEN/REDIS_*/STORAGE_CACHE_*/BOX_LOCAL_OSS_CDN_URL/BOX_LOCAL_AVATAR_API_URL/BOX_PLAYER_SERVICE_*/BOX_BUNDLED_CONTENT_PATH` 等）**均不在覆盖集内**，front-door 与监督进程在这些键上看到同一个值；端口相关键全部改为经 `ports=runtimePorts(baseEnv)` 解析，覆盖生效路径一致。`gameServerEnv` 中 `PLAYER_LIMIT/MAX_ZERO_PLAYER_TIME/NODE_OPTIONS/SERVER_ID` 用 `baseEnv.*`（其余 `process.env.*`），等价性由桩实测闭环。

### 3.2 桩设计与可复跑命令（全部在系统临时目录，仓库零新增文件）

`%TEMP%\a5b\`：`stub-boot.cjs`（`Module._resolveFilename` 桩掉 `@box/apis`、`@box/utils/moderation-runtime-auth` 等未安装的工作区包；`child_process.spawn/spawnSync` 全 mock 并捕获 argv+env）、`base-env.cjs`（两侧共用最小确定性环境：固定 `PERMISSION_TOKEN_SECRET/BOX_TELEPORT_INTERNAL_TOKEN`、`BOX_EDIT_SERVER_PORT=21000/BOX_PLAY_SERVER_PORT=21001/BOX_WEB_PORT=21090`）、`create-project.cjs`（用真 project-manager 建 `a5b-stub-map` 64×32×64 并克隆成两份逐字节相同工程）、`run-old.cjs`（把 HEAD launcher.js + 现行为对等的兄弟模块复制到 `old-repo/`，`data/services/scripts/config` 用 mklink /J 指回真仓库，以 `--runtime-only --runtime-mode edit --project a5b-stub-map` 启动，env 逐键复刻旧 front-door 的 spawn 覆盖 → 捕获旧世界 game-server 的 argv/env）、`run-new.cjs`（真仓库 launcher 以 `--creator` 启动，等 edit-library 监听后 `POST /a5b-stub-map/__local_runtime/start` 走真实起图分支 → 捕获新世界的 argv/env）、`compare.cjs`（路径归一后逐字段 diff）。

复跑：`node run-old.cjs <compat|measured|explicit>`、`node run-new.cjs <同>`、`node compare.cjs <同>`。

### 3.3 原文结果

**compat（`BOX_SCRIPT_MEMORY_BUDGET=compat`，隔离 A5 与 W3/W5 的预算改动）**：

```json
{ "mode": "compat",
  "argv": { "old": ["-r","@swc-node/register","src/launch.ts"],
            "new": ["-r","@swc-node/register","src/launch.ts"], "equal": true },
  "env": { "same": 152, "different": [], "only_old": [], "only_new": [] },
  "spawnShape": { "detached": {"old": false, "new": false},
                  "stdio": {"old": "inherit", "new": "inherit"},
                  "cwdNormalized": {"old": "<REPO>/services/game-server",
                                     "new": "<REPO>/services/game-server"} } }
```

**measured（默认，本轮 W3/W5 设计行为）**：argv `equal: true`；env `same: 149`，仅两键不同——`["SCRIPT_HEAP_MB","512","2048"]`、`["SCRIPT_MEMORY_LIMIT","512","2048"]`（宿主 28476MB via os.totalmem 的实测抬升，`only_old/only_new` 为空）。**A5 的等价性判据 = compat 与 explicit 两模式 0 差异；measured 的两键差异是 W3/W5 的既定改动，不是 A5 引入。**

**explicit（operator 显式 `BOX_SCRIPT_HEAP_MB=700 / BOX_SCRIPT_MEMORY_MB=900`，A5 中断未收的验证项之一）**：argv `equal: true`；env `same: 153, different: []`——显式值 700/900 两侧原样落到 `SCRIPT_HEAP_MB/SCRIPT_MEMORY_LIMIT`，报告行：

```
Script isolate budget 900MB (heap 700MB) for 10 concurrent runtime(s); basis env; limit 28476MB via os.totalmem; reserve 7119MB; voxel floor 512MB from 131072 voxels
```

纯函数补充（`node --input-type=module` 直调 `deriveScriptMemoryBudget`）：`explicit 100 -> 512 env`（不降到阶梯之下）、`explicit 4096 tier2048 -> 4096 env`（显式只升不降）——与 HEAD 的 `max(configured, required)` 语义一致。

**"不再 spawn --runtime-only 子进程"的直接证据**（捕获文件里的全部 spawn）：

```
capture-old-compat: [ { type:"spawn", args:"-r @swc-node/register src/launch.ts", runtimeOnly:false } ]      ← 老世界：harness 自己就是监督进程
capture-new-compat: [ { type:"spawn", args:"-r ts-node/register server/dev-server/index.ts --http --port 21090", runtimeOnly:false },
                      { type:"spawn", args:"-r @swc-node/register src/launch.ts", runtimeOnly:false } ]       ← 新世界：front-door 起 web + 直起 game-server
```

桩局限（如实声明）：Windows 宿主（win32）上跑桩，`detached` 两侧同判为 false，POSIX 进程组连坐只经读码论证；游戏脚本实际执行、`@swc-node` 真实加载均未发生（依赖未安装且本轮禁 `rush install`）。

## 4. 外部 `--runtime-only` 依赖清单（兼容性结论）

全仓 grep（`*.rs`、Dockerfile*、compose、yml/yaml、sh、ts/tsx、js、json；排除 node_modules/.next）：

| 命中 | 性质 |
| --- | --- |
| `apps/local-engine/Dockerfile:284/:350` | CMD 只传 `--production --creator` / `--production --play`，**不传 --runtime-only** |
| `scripts/dev-all.js:163/:177` | `--creator` / `--play`，同上 |
| `distribution/play-lite/compose.yml:6`、`apps/local-engine/Dockerfile:268` | 注释提及，非调用 |
| `scripts/check-standalone.js:1119/:1120/:1122` | **源码正则**断言 `runtimeOnly` 分支存在——A5 保留了整个 `--runtime-only` 入口，三条正则实测仍命中（§5-A 的例外是同文件另一条，见下） |
| Rust 侧（`apps/*/src/*.rs`）、docker-compose.yml、web 层（apps/game） | **0 命中** |

**结论：没有任何外部调用方传 `--runtime-only`；且该入参在工作区仍完整可用（解析、校验、main() 分支全保留），不构成兼容性破坏。** 若某私有部署脚本曾手工调用 `launcher.js --runtime-only --project <id>`（本仓不可见），改后行为与改前一致。

## 5. 发现的缺陷 / 职责空洞（照实标注）

- **A.（真回归，CI 会红）`scripts/check-standalone.js:1501-1508`** 要求 `startProjectRuntime[\s\S]*?\.\.\.\(production \? \['--production'\] : \[\]\)[\s\S]*?'--runtime-mode'[\s\S]*?mode` —— 该正则锚定的正是被删除的监督进程 spawn 参数行。25 条 launcher 正则经临时目录逐条实测：其余 24 条（含 forbid 类）new/old 判定均不变，唯此条 `new=false old=true`（`...(production ? ['--production'] : [])` 字面量在 launcher.js 已不存在）。`scripts/**` 属其它泳道，**本泳道未改**。建议 scripts 泳道把该条替换为等价断言，例如 `/startProjectRuntime[\s\S]*?gameServerLaunchArgs\(\)[\s\S]*?detached: process\.platform !== 'win32'/`（"直起时 production/dev argv 由共用函数决定、且保持独立进程组"——原语义的正则化）。
- **B.（架构性隐患）冷启动同步 IO 搬进了 front-door 事件循环**：改前 `getLaunchTarget`（工程校验 + materialize + 快照）、`prepareRuntimeStorage`（含可能的 `spawnSync prepare-assets`）发生在监督子进程自己的启动过程里，front-door 只付 `spawn` 一次；改后它们同步执行在 front-door 进程（edit-library 请求回调栈内，:1238-1239）。单图无碍，**多图并发冷开时会卡 creator web/库的请求处理**。属 HANDOVER P2 另一项"冷启动去同步 IO"的镜像问题——本轮 CPU-only 未实测卡顿量级，标注为待处理的已知缺陷（缓解方向：`setImmediate` 分段或挪回子进程，另行立项）。
- **C.（轻微观测损失）** game-server 崩溃时旧监督进程会打 `${command} stopped (${signal||code})`（stdio inherit 可见）；新路径 front-door 对该 child 只置 `exited/exitCode`，不打这行。用户在 edit-library `/__local_runtime/status` 仍能看到 `phase:'error' "运行时异常退出"`（edit-library.js:285-287），无功能空洞，日志少一行。
- **D.（非回归，记录）** win32 上 `detached:false`：旧版杀监督进程会把 game-server+脚本 worker 孤儿化，新版杀 game-server 会把脚本 worker 孤儿化——孤儿少了一层但仍有；POSIX 上两版连坐语义等（§1 表）。
- **E.（非缺陷，口径提醒）** 仪表盘每图 RSS/进程树根由监督进程上移到 game-server（:603-607 注释已同步）：改后看板每图读数天然下降约一层 node 进程——**这恰好说明 56 MB/图 不能拿删前删后的看板差直接冒领，需按 §7 串行实测**。
- **F.（桩的已知未覆盖项）** teleport 私有房间（`instance.privateRoom/serverId` 覆盖 `SERVER_ID/TYPE`）在桩里未跑（需 play 模式 + 房间管理链），但对应 env 覆盖逻辑与旧 spawn 逐键同源（:1155-1169 vs HEAD :1046-1064），静态对照一致。

## 6. 兼容性论证与回归检查点（与 G3 / compat-check.sh 对齐）

主张"**改完后现有真实地图在 creator 侧起图的行为与改前同构**"的根据：§1 职责对照无空洞 + §3 桩在 compat/explicit 模式下 argv/env 152/153 字段逐字节一致 + §4 `--runtime-only` 入口保留且无外部调用方 + edit-library（端口试探、健康门、maxRuntimes/idle 回收、restart 头）本轮零改动 + play 直起路径与 prod 独立容器入口未变。

回归时必查（按优先级，全部需在有 `@box` 依赖的完整环境/串行轮做）：
1. creator 进图（edit）首次冷开：项目校验/快照/资产准备成功，game-server 监听分配端口（11000 段），`/api/health-check` 就绪时长与改前同量级；
2. 预览 play 模式 + 传送私有房间（`instance.serverId` → `SERVER_ID/TYPE=teleport`）；
3. 关图/idle 回收：`terminateRuntimeChild` 后端口释放、无进程组残留（`pgid` 检查）；
4. 崩溃路径：kill -9 game-server 后 status 显示 `phase:'error' 运行时异常退出`，重开（`x-box-runtime-restart:1`）成功；
5. 多图并发（edit≤6、play≤4）不串端口、预算报告逐图打印本图 voxel 阶梯；
6. 外部入口烟测：`node launcher.js --runtime-only --runtime-mode edit --project <id>` 单跑一次（保证给任何历史工具留活路）；
7. **`rush verify` / `node scripts/check-standalone.js`：§5-A 修复前必红**——这是本泳道唯一需要跨泳道联动的兼容性项；
8. `box3-re/tools/compat-check.sh`：其 launcher 项（:249 起）是"打包产物树里 `src/launcher.js` 的 require 可达性 + 契约指纹"。本轮改动对 require 面的唯一新增依赖是 `./runtime-memory.mjs`（A5b 确认 :187-195 有 try/catch 降级，缺文件不炸启动）；对 G4 契约面（`world.*` 服务端 API）**零改动**，52 项检查预期不因本泳道翻红，但须在构建产物上实跑一轮 `--skip-docker` 留证（本轮未跑：需含 dist 的 standalone 树，CPU-only 轮未构建）。与 G3 门的对齐：本泳道交付只覆盖 G3 的"creator 起图"静态等价；G3 完整门（导入→开放→浏览器进图→`onPlayerJoin`）仍由 A9/串行轮把关，本改动进入 G3 实测时**第 1、2、4 项是新增风险面**（其余能力改前已在跑）。

## 7. 待证 / UNVERIFIED 清单

| 主张 | 状态 | 原因与复测方法 |
| --- | --- | --- |
| **省 56 MB/图** | **待证** | GATES.md A5 行已钉死口径：56.6 MB 是同类空载 node 进程的单点实测，**不是删前/删后的差值**。WSL 本轮刚重启、负载敏感指标禁测（CPU-only 泳道纪律）。复测：串行轮真实 creator 逐图开 N 张，采样 `readRuntimeProcessTree` 口径（改后）与含监督进程口径（改前基线）的每图 RSS 差 |
| **省 0.4–3 s/图** | **待证** | 同上，时延是负载敏感指标。复测：同一工程冷开 `starting→ready` 时间戳差（edit-library status 的 `updatedAt` 序列可采） |
| POSIX detached 连坐 | 读码等价，**未在 Linux 实跑** | 桩在 win32；Linux 侧 `process.kill(-pid)` 语义靠 §1 论证，待 WSL 内跑一次起图/关图 |
| teleport 房间 env | §5-F | 桩未覆盖，待 G3 轮 |
| `check-desktop-deployment-manager.js` | **UNVERIFIED** | 本机 `Cannot find module 'typescript'`（依赖未装，禁 rush install）；其 launcher 相关断言仅 `assert.match(launcher, /process\.env\.VOXA_URL/)`（:529），工作区 :294 在位，静态可读证 |
| eslint / prettier 插件全量格式化 | 部分 UNVERIFIED | `scripts/lib/client-format-plugin.cjs` 需 `tools/repo-tooling`/`apps/player-launcher` 的 node_modules，未联网安装；A5b 按 W2 泳道先例（`box3-re/tools/w2-fmt.sh` 同款旗标）用 prettier 3.6.2 + owned-code 规则（tab 4/semi/singleQuote/trailingComma all/printWidth 100）对 launcher.js 施加归一并复验 `FMT OK`；文件保持 CRLF（HEAD 检出即 CRLF，.prettierrc.cjs 的 `endOfLine: 'lf'` 是全局存量问题，非本泳道引入，未随文改写以免制造全文件 diff） |
| 25 条 check-standalone launcher 正则 | **1 FAIL/24 PASS** | 临时目录逐条对 old/new 求值原文见 §5-A；这是代码级验证，非脚本全量运行（脚本全量需构建产物） |

## 8. 本轮亲测命令清单（可复跑）

```
node --check apps/local-engine/src/launcher.js            # exit 0（格式化前后各一次）
git diff --stat apps/local-engine/src/launcher.js         # 685 files-chg: +434 −251（A5b 格式化后）
node scripts/check-engine-wire-protocols.js               # "engine wire protocol order checks passed" exit 0
node scripts/creator-player-identity.test.js              # 2/2 pass exit 0
%TEMP%\a5b\create-project.cjs → run-old/run-new/compare（compat|measured|explicit 三轮）  # §3.3 原文
prettier(w2-prettier 3.6.2) --parser babel --tab-width 4 --semi --single-quote --trailing-comma all --print-width 100
```
