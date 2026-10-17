# S2 — 服务端运行时与进程/内存模型（源码白盒）

> 泳道：进程模型 / 沙箱 / 内存预算 / 同步 IO / Web-引擎耦合 / mudb / 冷启动 / 可观测性。
> 仓库：`D:\desktop\神奇代码岛\box3-local-engine`（tag v2026.1.4，commit a35455d）。所有 `path:line` 为**源码行**（非出厂 bundle 偏移）。
> 引用而不重做：`box3-re\C-architecture.md`（出厂 bundle 进程模型/令牌流/10 条批判）、`box3-re\E-runtime-baseline.md`（实测 RSS/healthy/TTFB 基线）、`box3-re\B-size-audit.md`、`box3-re\A-docs.md`。
> 本车道为**只读**：未运行 rush/build/test，未触碰 `~/box3`，未启停容器。运行态数字全部引用 E 车道；需重启才能测的列入 §10。

---

## 0. 口径：出厂拓扑（一句话）

`Dockerfile:284` `CMD node apps/local-engine/src/launcher.js --production --creator`（play 为 `:350`），`Dockerfile:199/283` `ENTRYPOINT ["tini","--"]`，`Dockerfile:183` `ENV NODE_ENV=production`。
launcher 是唯一"控制面"：它自己 fork Next（`launcher.js:1279`），并按需 fork 地图运行时；Rust `server-manager` 只在 `map-runtime-profiles.json` 给出资源组时才被调用（`launcher.js:248-278`，`runtime-container-client.js:24`），而资源组的 `cpuMilli/memoryMb` 在 schema 层被硬写成 `null`（`map-runtime-profiles.js:47-49`），**默认永远走进程隔离分支**（`launcher.js:249` 直接 return null）。

---

## 1. 源码级进程模型图：一张地图从"点击进入"到"脚本跑起来"

### 1.1 Creator（编辑/预览）路径 —— 每图 **3 个新进程 / 3 个 V8 heap / 1 个 TCP 端口**

```
浏览器 → Next(:3000, pid=next-server) → /runtime/edit/* → launcher 前门(:9967)
                                                              │ edit-library.ensureRuntime  (edit-library.js:143)
                                                              ├ allocateRuntimePort        (edit-library.js:89-101, 最多 512 次试探)
                                                              ├ startProjectRuntime        (launcher.js:1006) ── spawn ★P2 递归 launcher.js
                                                              │     launcher.js:1024-1062  detached, stdio:'inherit', --runtime-only --runtime-mode <mode> --project <id>
                                                              │        └ 子 launcher 再次 require project-manager (launcher.js:104)
                                                              │          + getLaunchTarget (launcher.js:115 → project-manager.js:2543)
                                                              │          + startGameServer (launcher.js:776) ── spawn ★P3
                                                              │                launcher.js:777-787 → run()(354) → spawnRuntime(368) → child_process.spawn
                                                              │                cmd = node dist/src/launch.js --useProdBundle   (dev: -r @swc-node/register src/launch.ts)
                                                              └ waitForRuntimeReady → /api/health-check 轮询 (runtime-readiness.js:25-70)
                                                                       ★P3 game-server 启动时 fork ★P4
                                                                       ivmp-script-socket-server.ts:54  child_process.fork('./ivmp-process-entry')
```

| 实体 | 创建行 | 数量 | RSS 依据 |
|---|---|---|---|
| P2 递归监督 launcher | `launcher.js:1024` | 每图 1 | E §2 同类 node 进程 **56.6 MB**（creator launcher.js） |
| P3 game-server | `launcher.js:777`（经 `run`→`spawnRuntime` `:354/:368`） | 每图 1 | UNVERIFIED（E 未开局）；参照 P2 + mudb 状态 + 体素，INFERRED 60–90 MB |
| P4 ivmp 脚本进程 | `ivmp-script-socket-server.ts:54-68`（`fork`, `execArgv:['--no-node-snapshot']` 见 `:19-24`） | 每图 1 | node 基线 INFERRED 40–50 MB + isolate ≤ `SCRIPT_MEMORY_LIMIT` |
| V8 isolate | `ivmp-vm-controller.ts:64-75` `new ivm.Isolate({memoryLimit:_memoryLimitMb})` | 每图 1 | 512 / 1024 / 2048 MB 三档，见 §3 |
| Node V8 heap | P2/P3/P4 各 1 | **每图 3** | — |
| TCP 端口 | `entry.ts:782-789`（**唯一** listen；WS 复用同一 httpServer，`createServer.ts:143-148`） | 每图 1 | 11000+/12000+ |
| IPC 通道 | `ivmp-script-socket-server.ts:60` `serialization:'advanced'` + `stdio:'inherit'` | 每图 1 | — |

**监督进程 P2 的真实价值 = 0**：`run()` 的子进程退出回调直接 `shutdown(code)`（`launcher.js:359-364`），即 P2 不重启、不退避、不接管，只是"陪葬"。它唯一多做的是**每张图重跑一遍工程校验/快照/资产检查**（§7）。

### 1.2 Play（游玩库）路径 —— 每图 **2 个新进程**（少一个）

`launcher.js:889-1004` `startLibraryRuntime` **直接 spawn game-server**（`:911-983`），不递归 launcher.js。同一条命令、同一 env 集合，两条路径语义不同 —— 这就是 P2 可以整块删除的现成证据（把 creator 的 `startProjectRuntime` 也改成直起 game-server 即可）。

### 1.3 传送房间

每房间 = 一个完整实例（`edit-library.js:141` `runtimeKey = room:<roomId>`，`launcher.js:1042-1047`），因此"分片"成本 = §1.1 全套 ×1，`BOX_TELEPORT_MAX_ROOMS=64`（compose:352/517）理论上界 64×3 进程，而 creator `pids_limit:1024`（compose:300/483）。

### 1.4 可压缩空间（对标 E）

| 项 | 出厂 | 源码可证的目标 | 依据 |
|---|---|---|---|
| 每图新增进程 | 3（creator）/ 2（play） | **1** | 删 P2（`:1024`→改直 spawn）+ isolate 池化删 P4（§2） |
| 每图新增 RSS | INFERRED 150–200 MB（空闲） | **≈60–75 MB**（1 进程）→ 多图共享后 **增量 15–25 MB/图** | P2 56 MB + P4 基线 45 MB 可回收 |
| 每图端口 | 1 | 1（可折叠为前门路由键，见 §2.4） | `entry.ts:788` |
| 首图延迟 | UNVERIFIED（E §11.3 顺延） | §7 目标 3–6 s | — |

---

## 2. "每图 3 进程" → "每进程 N 个 isolate"：可行性

### 2.1 源码里已有的 VM 模式（出厂只用 `ivmp`）

* 选择点：`launcher.js:106` `scriptVm = process.env.BOX_SCRIPT_VM || 'ivmp'` → env `VM`（`launcher.js:832`、`:945`）→ `config/index.ts:65` `vm: S('VM','')`（**无枚举校验**）→ `entry.ts:652-680` 三分支 `switch`：
  * `local` → `LocalScriptSocketServer`（`entry.ts:653-655`，**同进程、无沙箱**，仅测试/浏览器内）
  * `ivm2` → `Ivm2ScriptServer`（`entry.ts:656-667`）：**同进程内 `new ivm.Isolate`**，成熟度见 §2.2
  * `ivmp` / default → 子进程 fork（`entry.ts:668-679`）
* `launch.ts:31 --help` 还写着 `local, isolate, worker, isolate-snapshot` —— **`isolate`/`worker`/`isolate-snapshot` 在 `entry.ts` 的 switch 里不存在**，会落进 `default` 变成 ivmp。
* **跨层不一致（可直接修 bug）**：Rust 调度器给隔离容器写死 `("VM","isolate")`（`apps/server-manager-rust/src/runtime/runtime.rs:382`），而 game-server 只认 `ivmp` ⇒ 声明的"in-process isolate"被静默降级成"每图再 fork 一个进程"。同时容器内 `METHOD=local`（`runtime.rs:377`）会关掉 mudb 协议校验以外的行为、并把存储降级（`entry.ts:686-688` `if (storageMode==='pg') storageMode='sqlite'`）。
* `isolated-vm@5.0.4`（`services/game-server/package.json:51`）本身完全支持一进程多 isolate，无全局状态限制。

### 2.2 ivm2 的成熟度与接口差

* 接口一致：`ScriptServer` 只有 `start/close/state/clients + launch()`（`utils/script-server/type.ts:5-11`）；`Ivm2ScriptServer`（`ivm2-script-socket-server.ts:364-492`）与 `IvmpScriptSocketServer`（`ivmp-script-socket-server.ts:26-173`）都实现它 ⇒ **配置级可换，无需调用方改动**。
* ivm2 每次 `launch()` 建 `isolate+context+script`（`:415`、`:420-421`），并**跨 launch 复用 V8 code cache**：`compileScriptSync(entryScript,{produceCachedData:true, cachedData:this._cachedData})`（`:421-428`）。ivmp 侧同样逻辑在 `ivmp-vm-controller.ts:83-91`，但 `_cachedData` 活在**子进程**里，进程一死就丢。
* ivm2 缺的东西（成熟度差项，全部可补）：
  1. 无 `onCatastrophicError` 处理（ivmp 有：`ivmp-vm-controller.ts:66-73` → `events.crash` → `stop()`）；ivm2 只有 `_notifyError`/`_notifyScriptTimeout`（`ivm2-script-socket-server.ts:80-110`）。
  2. `close()` 里 `isolate.dispose()`（`:331`）是同步的；无优雅终止握手（ivmp 靠 `markedForDeath` + `isolateStopSemaphore`，`script-host.ts:1097-1111`）。
  3. 无独立日志 pid 域（`ivmp-process-entry.ts:11-27` 给子进程单独 pino）。
  4. **CPU 闸弱**：`postMessage.apply(...,{timeout})`（`:194-197`）是 V8 interrupt 终止，但 isolate 与宿主**共享同一事件循环线程** ⇒ 一次脚本同步段超时 = 该 game-server 进程全体玩家掉帧；ivmp 至少把停顿关在子进程里。

### 2.3 宿主侧其实已经"多会话就绪"

`script-host.ts:1094-1111` 遍历 `this.protocol.clients`（多 sessionId）逐个 `markedForDeath[sessionId]=true` + 等 `isolateStopSemaphore.p(pendingStop)`；`IvmpScriptSocketServer.clients[]`（`:36`）与 `RemoteScriptProtocol.server.launch: MuASCII(sessionId)`（`ivmp/protocol.ts:12`）都带 sessionId。**唯一缺的是 raw 通道的路由键**：
`ivmp-process-entry.ts:61-63` `raw(client,data,unreliable){ controller.send(data,unreliable) }` → `controller` 只有一个 `_isolate`（`ivmp-vm-controller.ts:20-24`，`run()` 在 `:55-58` 直接拒绝二次运行），且 `MuChildProcessSocketClient.send` 的 IPC envelope 只有 `{message, unreliable}`（`packages/mudb/src/socket/child_process/client.ts:61-64`），服务端每个 client 都 `process.on('message')` 无差别转发（`child_process/server.ts:152-167`，注释 `:194` "目前一个Server仅对应一个Client"）。

### 2.4 建议设计：共享监督进程 + isolate 池（"scriptlet daemon"）

```
前门 launcher（唯一常驻，1 个）
  ├─ game-server 池：G 个进程（G ≈ max(1, ceil(活动图数 / K))），每个仍 listen 一个端口 P_g
  │     └─ ScriptletDaemon（复用 ivmp-process-entry，1 进程 N isolate）
  │           ├─ isolate_i（图 i 的 shell），memoryLimit = budget_i，onCatastrophicError → 只 dispose i + 事件带 i
  │           └─ routing: envelope 增 sessionId → {sessionId, message, unreliable}
  └─ 路由：浏览器仍连前门端口，按 /{mapId}[/__room/{roomId}] 把 WS 转到 (G, i)
```

改动半径（小→大顺序）：
1. `child_process/message.ts` + `client.ts:61-64` + `server.ts:152` 加 sessionId（≈30 行，两侧同仓同版本，兼容风险可控）。
2. `ivmp/protocol.ts` 的 `raw` 改为带 key（或每个 isolate 注册一个 mudb protocol 实例，idBase 天然区分，`mudb/src/protocol.ts:143-151`）。
3. `IsolateVmController` 由单例改 `Map<sessionId, {isolate,context,script,shellInterface,sendSemaphore}>`（`:19-52` 字段全部入 Map），`send(data)`→`send(sessionId,data)`；`_cachedData` 提升为 daemon 级共享（现在 `:24` 已是实例级，`ivm2-script-socket-server.ts:365` 是 server 级 ⇒ 照抄即可）。
4. 前门 `launcher.js:1006-1084` 删递归 spawn，改 `:911` 式直起 game-server；端口分配从"每图 1 个"变"每池 1 个"，`edit-library.js:89-101` 的 512 次 `net.createServer` 试探随之减一个数量级。

### 2.5 收益 / 代价（量化）

| 维度 | 数值 | 依据 |
|---|---|---|
| 省内存 | **−45~56 MB/图**（P2 56 MB，E §2 实测同类 node 进程 56.6 MB；P4 node 基线 INFERRED 45 MB） ⇒ 3 进程→1 进程约 **−100 MB/图**，creator 默认 6+4=10 个运行时 ⇒ **−1.0 GB 峰值预算** | `launcher.js:1024`、`ivmp-script-socket-server.ts:54` |
| 省冷启动 | 去掉 P2 的模块加载 + 工程校验 + tar 快照 + avatar 校验（§7）INFERRED **0.4–3 s/图**；去掉一次 `fork` + `--no-node-snapshot` 的 node boot + 1.3 MB shell 读入/编译 INFERRED **0.3–1.5 s/图**（共享 `_cachedData` 后第 2..N 图接近 0） | `ivmp-script-socket-server.ts:19-24`、`ivmp-process-entry.ts:30-33`、`ivmp-vm-controller.ts:83-91` |
| 崩溃隔离半径 | **变差**：ivmp 下脚本进程 OOM/abort 只杀一张图；同进程 N isolate 下，V8 致命错误 / native crash / `process.abort` 会带走**同进程所有图**（半径 = K 张图）。缓解：`onCatastrophicError`（`ivmp-vm-controller.ts:66-73`）+ K 上限 + 按"信任等级/租户"分池 + K 张图共享一次 3 秒倒计时重启（现状崩溃已是整服重启：`play-server.ts:110-119`） | — |
| 内存互相踩踏 | **可控**：`ivm.Isolate({memoryLimit})` 是 V8 堆硬上限，跨 isolate 不共享堆；风险只在 ExternalCopy/transferIn 的 buffer（宿主侧分配，`ivmp-vm-controller.ts:257-261`）不计入 isolate 配额 ⇒ 必须给"宿主侧 buffer 驻留"设全局配额（当前无）。 | — |
| CPU 抢占公平性 | **变差**（ivm2 同 loop）：单脚本同步段可占满宿主 tick（64 Hz，`index.ts:87`），无时间片。缓解：per-isolate `scriptTimeout`（已有，`ivmp-vm-controller.ts:246-248`）+ 每 tick 预算计数 + 超额 isolate 自动挪到独立进程（"降级到 ivmp"作为逃生阀，正好用现成的双实现）。 | — |
| 安全边界 | **不变**：不可信 JS 始终在 V8 isolate 内，宿主暴露面 = `jail.setSync('secret', hostInterface)`（`ivmp-vm-controller.ts:112-117`）。两个必须一起修的真洞：① `hostInterface` 里塞了 `ivm` 本身（`:403`），dev 还整包注入 `jail.setSync('ivm', ivm)`（`:119-124`）——池化后这等于把**别的图的 isolate 句柄**交给攻击者；② 宿主 `new Function(脚本源)` 的管理员通道 `admin-server.ts`（C §5）判定只看 `isAdmin`。⇒ **池化的前置条件是把 `ivm` 从 jail 里摘掉**。 | — |

结论：**可行且收益大，但不是"默认改 ivm2"**。建议默认 = "共享 ScriptletDaemon 进程 + N isolate（带 sessionId 路由）"，即保留进程边界但把 1 进程:1 isolate 改成 1 进程:K isolate；`local` 仅 dev/test；`ivm2`（纯同进程）作为"低配模式/单机小图"可选，并且必须先补齐 §2.2 的 1/2/4 三点 + 摘掉 `ivm` 注入。

---

## 3. 内存模型：把体素猜测换成可测量预算

### 3.1 现状：三层叠加、零校准

| 层 | 值 | 出处 |
|---|---|---|
| 容器 cgroup | creator 6 g / play 4 g / voxa 1 g / player-service 1 g / auth 128 m / postgres 512 m / server-manager 128 m | `docker-compose.yml:298, 481, 564, 115, 189, 32, 246` |
| 每图脚本 | `requiredScriptMemoryMB = voxels>64M?2048 : voxels>16M?1024 : 512`，与 env 取 `Math.max` | `launcher.js:136-160` |
| 进程 Node 堆 | 仅当 `BOX_RUNTIME_NODE_MEMORY_MB>0` 才写 `--max-old-space-size`；**compose 从未设置** ⇒ game-server / launcher 子进程堆**无上限** | `launcher.js:879-884`、`launcher.js:915/1027` 只在 `profile.memoryMb`（默认 null，`map-runtime-profiles.js:47-49`）时生效 |
| cgroup 读取 | **全仓库无一处** `grep sys/fs/cgroup` 命中（.ts/.js/.rs 全量） | — |

两点必须纠正 C 的表述：

1. **体素启发式对 play 库路径根本不生效**。`launchTarget` 只在 `--project/--release` 时存在（`launcher.js:113-119`），play 容器 CMD 是 `--play` 无 `--project`（`Dockerfile:350`）⇒ `initialMapSize=[]` ⇒ `initialMapVoxelCount=1`（`:136` 的空数组 reduce）⇒ 恒 512。也就是说：**已发布地图永远吃 compose 的 512 MB（`:509`），只有 creator 预览/传送房间才可能抬到 2 GB**。同一份"猜测"在两条路径上一边失效一边危险。
2. **限额是算术上不自洽的**（这是"保险系数而非测量结果"的硬证据）：creator 默认 `6 edit + 4 play = 10` 个运行时（`compose:345-346`），play 默认 `8`（`compose:513`）。`10 × 512 MB = 5.1 GB ≈ 6 GB 容器上限`，`8 × 512 MB = 4.096 GB = 4 GB 容器上限` —— **只算 isolate 配额就把 cgroup 吃满 100%**，还没算每图 2–3 个 Node 进程本身、Next/launcher 的 92/85 MB（E §1）与体素/预烘焙缓冲。任意两张大图同时逼近配额 → 内核 OOM 挑**整个 creator 容器**（含 Web 层与所有其它地图）。这就是"没测过"的证明：任何做过测量的人都会留下 `sum(child_limits) < container_limit` 的痕迹，而这里恰好是等号以上。

### 3.2 已有的采样底座（不用新造）

`launcher.js:476-606` 已经把"一棵进程树的 RSS/CPU/进程数"做成了带 250 ms TTL 的采样器：

* `readRuntimeProcessStats(pid)` 解析 `/proc/<pid>/status` 的 `VmRSS` 与 `/proc/<pid>/stat` 的 utime+stime（`:481-500`）；
* `readRuntimeProcesses()` 全量扫 `/proc` 建父子索引（`:514-541`，缓存 TTL `:506`）；
* `readRuntimeProcessTree(rootPid)` 汇总 descendant（`:543-575`）；
* `attachRuntimeMetrics()` 暴露 `cpuPercent / memoryBytes / processCount / uptimeMs`，并由 `/__local_runtime/status` 直接进 JSON（`edit-library.js:109-121`、`play-library.js` 同结构）。

缺的两块：**(a)** 没有任何 `process.memoryUsage()` / `isolate.getHeapSize()` 上报（全仓仅 `edit/replica/replica-server.ts:2688-2689` 在保存时打一行 `process.memoryUsage()` 日志；`isolated-vm` 的 `getHeapSize/getHeapStatistics` **零使用**）；**(b)** 采样器只在有人查 status 时才跑，没有闭环反馈到预算。

### 3.3 建议：可测量预算 + 一致性校验

1. **启动期校验（纯静态，零成本，先落地）**：在 `launcher.js` 计算 `scriptMemoryMB` 之后加断言链
 `Σ(活跃 isolate 上限) + Σ(进程数 × 基线 RSS) + Next 预留 ≤ mem_limit × 0.90`，其中 `mem_limit` **从 cgroup 读**（容器内 `/sys/fs/cgroup/memory.max`，v2；v1 为 `memory.limit_in_bytes`）而不是信 env。不满足就自动降 `scriptMemoryMB` 到可行值并 warn（今天的行为是不管多大都 `Math.max`）。
2. **运行期自适应**：`/proc` 采样已有；补 `isolate.getHeapSizeSync()`（在 `ivmp-vm-controller.ts` 每次 `postMessage` 完成后节流取一次）→ 得 `peak_i`。预算规则改为 `limit_i = clamp(基线, peak_i 的 P95 × 1.5, 单图硬顶)`，取代 `voxels>64M?2048`。体素数**降级为下界提示**（大地图确实需要更多镜像缓冲，见 `launcher.js:137-140` 注释），不再当唯一依据。
3. **给进程堆补上真正的闸**：`BOX_RUNTIME_NODE_MEMORY_MB` 必须有默认值（否则 game-server 无 `--max-old-space-size`，`launcher.js:879-884`），且 `container_mem ≥ Σ(节点内所有 --max-old-space) + Σ(isolate 上限) + page cache`。
4. **小机器安全默认值**（基于 E §1 空闲 313.67 MB + §3 实付 5.3–6.1 GB 的差，INFERRED，需 §10-3 实测收敛）：

| 服务 | 现在 | 建议（8 GB 主机单机） | 依据 |
|---|---|---|---|
| creator mem_limit | 6 g | **2.5 g** | 空闲 92 MB；峰值 ≈ Web 100 + N 图×(60 + script 256) |
| play mem_limit | 4 g | **2 g** | 空闲 85.5 MB |
| 每图 SCRIPT_MEMORY_MB | 512（且 play 路径恒 512） | **256（采样自适应 256–1024）** | §3.3-2 |
| BOX_RUNTIME_NODE_MEMORY_MB | 未设（无上限） | **512** | §3.3-3 |
| MAX_RUNTIMES | 6+4 / 8 | **按 `mem_limit / 每图实测预算` 反推**（当前硬编码 compose:345-346/513） | 现值是拍的 |
| voxa / player-service / auth | 1 g / 1 g / 128 m | **384 m / 384 m / 96 m** | E 实测 42.2 / 55.7 / 13.2 MB（且 `--max-old-space` 已是 192/48） |
| postgres | 512 m | 保留 | E 23 MB（但 shared_buffers 需要） |
| 合计名义 | 12.94 GB | **≈ 5.9 GB**，与 8 GB 主机自洽 | — |

### 3.4 顺带纠正一个"永不回收"的说法

`launcher.js:878` `MAX_ZERO_PLAYER_TIME: BOX_RUNTIME_IDLE_TIMEOUT_MS || '2147483647'` 看起来危险，但 compose **两条服务都设了 900000**（`:348`、`:515`），所以出厂态拿到的是 15 分钟；`2147483647` 只在裸 `node src/launcher.js` 开发时生效。更要紧的是：`MAX_ZERO_PLAYER_TIME → createServer.ts:217 zeroPlayerTimeout` **在全仓库没有任何消费者**（`grep zeroPlayerTimeout` 仅命中赋值处与 schema 默认 `settings/server-settings-schema.ts:55`）⇒ game-server 自我回收是**死配置**，真正的回收只有前门 `collectIdle`（`runtime-lifecycle.js:81-99`）+ `activeConnections` 引用计数（`:35-53`）。风险：任何**不经过前门**的连接（例如客户端被 `runtime-upstream` 之外的地址直连）不计入引用计数，则该图永不回收。

---

## 4. 同步 IO 与锁：逐个定位

| # | 阻塞点 | 源码位置 | 落在哪条路径 | 最坏卡顿 |
|---|---|---|---|---|
| 1 | `Atomics.wait(SharedArrayBuffer,0,0,20)` 主线程自旋抢文件锁 | `project/local-project-state.ts:211-254`（`openSync(...,'wx')` `:220`，写 metadata+fsync `:240-241`，超时默认 30 s / stale 300 s `:89-103`） | **game-server 主线程**（唯一调用链：`updateLocalGroupProjectState:302-324` ← `setDeletedLocalProjectModelPath:472-501` / `syncLocalProjectModelPaths:503-533`，由编辑期 replica 请求触发 `edit/replica/replica-server.ts:1674/1942/2085/2355/2693`） | **30 s 全图卡顿**：64 Hz tick（`index.ts:87`）+ 所有玩家 WS 停摆；持锁进程崩溃后要等 stale 300 s 才可回收，期间每张兄弟图各卡 30 s 再抛错 |
| 2 | `spawnSync('tar', …)`（16 MB maxBuffer） | `apps/local-engine/src/project-manager.js:1237-1252`；列表校验 `:1662-1690`（`tar -tzf` 全量解压）；调用者 `createProjectSnapshot:746-793`、`importProject:1752`、导出/发布 `:2406` | **Next.js HTTP 线程**（`apps/game/pages/api/local-projects/import.ts`、`[id]/export.ts`、`publish.ts`、`snapshots.ts` 全部 → `getLocalProjectManager()`） | 与工程体积成正比：数百 MB 工程 ⇒ **秒级到数十秒**整个 Web 服务无响应（含健康检查、登录、其它项目列表）。UNVERIFIED 具体毫秒数（§10-5） |
| 3 | 模块顶层（**不是**函数里）就执行 `getLaunchTarget` | `launcher.js:115` → `project-manager.js:2543-2569`：`validateProjectSource:696-734`（多次 existsSync/readFileSync）→ `mapGroupManager.materialize`（`map-group-manager.js:99-150`：遍历**全部 group blob**，`linkSync`，失败退化为 `copyFileSync`+`chmodSync` `:140-146`）→ `createProjectSnapshot(...,'launch')` ⇒ **#2 的同步 tar** → `getProject:937-968` | **每个 P2 监督进程的启动关键路径**（§1.1），即玩家"点击进入地图"那一次 | 冷启动直接被 tar 支配；且**每张图都付一遍** |
| 4 | 读路径写文件 + 目录全扫 | `project-manager.js:937-968`（`getProject` 缺 `permanentMapId` 时 `writeJSON` `:947`）、`permanentMapIdExists:670-684`（`readdirSync` + 逐个 `readJSON`）、`createPermanentMapId:686-694`（**每次尝试都全扫**）、`listProjects:990-1002`（全量 readdir+readJSON）、`resolveProjectReference:969-986`（失败再 `listProjects`） | **前门每次未命中引用都要付**：`launcher.js:1087-1119` 的 `resolveProject` 兜底就是 `getProject` 抛错 → `listProjects()` → `getProject()` | N 个项目 × 同步读；N=500 时单次可达数百 ms，且在代理请求的 await 链上（`edit-library.js:413-417`） |
| 5 | `copyReadableFileSync` 1 MB 缓冲同步读写循环 | `project-manager.js:425-442`（`readSync/writeSync` `:433-435`），`copyReadableDirectorySync:448+` 递归 | 导入 / 模板复制 / 发布 ⇒ Next 线程 | 单 blob 上限（`VOXA_MAX_BLOB_BYTES` 默认 256 MiB，`compose:578`）⇒ **最坏一个文件就卡几十秒** |
| 6 | `spawnSync(process.execPath, prepare-assets.js)` | `launcher.js:660-667`；`validateDefaultAvatar:314-331`（1 次 readFileSync + **18 次 existsSync**）；`fs.mkdirSync` `:645`；`makeRuntimeDataReadable` `:651` | P2 每张图启动路径 | 一次 node 子进程冷启（≈100–300 ms）+ 19 次 stat |
| 7 | 同步体素解压（**游戏侧唯一必须量化的 tick 相关项**） | `createServer.ts:191` → `voxel/voxel-server.ts:214-234`：`for (i in chunkBytes) boxDecompress(...)` **无 await、无分片** | boot（listen 之前）—— 好在不是每 tick；但同样代码路径在 `voxelServerChanged` 的热更包上复用（`voxel-server.ts:236+`） | 与体素数线性；1024×128×1024 级 ⇒ 秒级同步停顿，UNVERIFIED（§10-4） |
| 8 | 无界并发预取 | `internals/build-system/tasks/prebake.ts:23-43`：`for(i) chunks[i]=content.retrieve(...)` 全部并发、结果全量驻留 | boot（与脚本服务器 fork **并行**，`entry.ts:461-682` 的 `Promise.all`） | 峰值内存 = 整图体素字节 + 数千并发 fd/回调；磁盘抖动放大 §7 的耗时 |
| 9 | 端口试探 | `edit-library.js:89-101`（最多 512 次 `net.createServer` listen/close） | 每次建图（creator） | 通常 1 次命中；重启残留端口多时 ≈ 数百 ms |

### 4.1 建议方案

* **#1**：改 `fs.promises.open(path,'wx')` + `AbortSignal.timeout` 指数退避（0→5→20 ms，上限 = 现有 30 s），或 `fs.watch` 锁文件 unlink 事件驱动唤醒（Linux inotify 对 bind mount 有效；WSL 需 polling watch，标 INFERRED）。要点：**把 `operation` 变 async，锁等待期间事件循环必须活着**。共享状态还可以更彻底：把 `project-state.json` 的读-改-写移进前门单进程（前门已经持有 `projectManager`，`launcher.js:104`），子进程改走 IPC 请求 ⇒ 文件锁整体消失（与 C §10 的"锁是为共享 bind mount 写的"结论一致）。
* **#2/#3/#5**：`worker_threads` 任务队列 + SSE 进度（前端已有进度条，见 §7）。至少做到 **tar 移出 HTTP 线程**（`spawn` + 流式 + `stream.pipeline`）。快照从 `getLaunchTarget` 关键路径移到"进入编辑器后 5 s 空闲时"（`launcher.js:1304-1337` 已有后台 timer 模式，可复用）。
* **#4**：`getProject` 禁止在读路径写盘（迁移改为一次性启动升级）；`permanentMapIdExists` 换成前门维护的 `Map<permanentId,projectId>`（目录变更用 `fs.watch` 失效）；`resolveProject` 兜底不再 `listProjects()` 全扫。
* **#6**：资产/头像校验只在 `creatorMode` 前门做一次并缓存结果到 `~/.box3` 外部标记文件；监督进程跳过（`launcher.js:644-673` 的三个条件都用 `startsPlayServer||startsEditServer`，可在 `runtimeOnly` 时改走"轻校验"）。
* **#7/#8**：体素解压分片 + `setImmediate` 让出（或 `AsyncResource` worker 池）；预取加信号量（并发 ≤ 16），并且**只预取视口相关 chunk**（服务器权威体素需要全量，但可延迟到首个玩家请求该 chunk，INFERRED 需检查 `voxel-server.ts` 的按需路径是否已支持）。

---

## 5. Web 层与引擎层耦合：`createRequire` 载入 project-manager

* 机制：`apps/game/server/local-project-manager.ts:9-32` —— 运行时用 `process.getBuiltinModule('module').createRequire(__filename)` 解析绝对路径 `apps/local-engine/src/project-manager.js`（`BOX_LOCAL_ENGINE_ROOT` 或两个相对回退 `:10-17`），**绕开 webpack bundle**（注释 `:23-25`，另有 `pages/api/creator/v1/projects/[projectId]/scripts/[side]/[entry].ts:38` 记录过一次 `__dirname` 破坏 createRequire 的事故）。
* ⚠ **dev 每次请求重新 require**：`local-project-manager.ts:30` `if (NODE_ENV!=='production') delete localRequire.cache[resolvedPath]` ⇒ 每个 API 调用都重新解析+求值 3075 行（含 §4 的全部顶层同步 IO）。出厂是 production（`Dockerfile:183`）所以缓存生效，但这行决定了"源码开发体验"的尾延迟。
* 耦合面：**22 个文件**调用它（`grep -l getLocalProjectManager`），其中 **3 个是 SSR 页面**：`app/e/[container]/page.tsx:23`、`pages/p/[gameName]/index.tsx:64`、`pages/projects/launch.tsx:22` —— 三处都只为了一次 `getProject()` 存在性判断（`notFound()`）。其余 19 处是 API 路由（工程 CRUD / 导入导出 / 发布 / 快照 / 备份 / 资源清单）与 `server/creator-storage.ts`、`server/map-info.ts`、`server/system-status.ts`。
* 替代方案（推荐 A+B 组合）：
  * **A. 内部仓库服务**：前门（launcher，已持 `projectManager` 与全部路由代理，`edit-library.js:274-466`）增一组 `/__local_repo/*` 内部 REST（`list/get/create/import/export/publish/snapshot`），Next 侧只留一个 200 行的 HTTP client ⇒ 立刻解除"Web 进程 = 引擎文件系统"的耦合，SSR 页面改 1 次 `fetch`（本机 <2 ms，E §5 已证 JS 内部 RPC 是毫秒级）。
  * **B. Next 只做静态壳**：把 `pages/api/*` + `app/*` 迁进 A 的轻量 server（Node http 或 Rust），Next 以 `output:'export'` 产物由静态资源服务（前门已有内容路由 `/block`，`entry.ts:429-431`）。
* 对"去掉 SSR 镜像"的影响：**正面**。当前 Next 进程不能删的原因是它同时承担 (i) SSR 页面、(ii) 引擎文件系统 API、(iii) 鉴权/令牌签发（C §8）。(ii) 一旦下沉，(i) 只剩 3 个页面做纯存在性检查（E §5 实测 SSR 首页 TTFB ~1.0–1.13 s，是**整栈最慢的请求路径**，远重于任何 API），(iii) 可与 (ii) 同进程。⇒ 静态壳 + 一个 ~15 MB 的 API 进程即可替换 creator/play 的两个 `next-server`（E §2 实测 122.3 + 113.9 MB，11 线程），**−220 MB 空闲**，且不再有 launcher/next 双进程（E §10 的第 (d) 条验收线）。风险：`apps/game` 的路由约定/中间件（`server/dev-server`，`launcher.js:1270-1277`）与 Next 图片/国际化能力，属于 B 车道的体量审计范围，此处只给指针。

---

## 6. mudb 协议与状态同步：是不是已经很轻？

### 6.1 帧格式（源码可证）

* 二进制帧 = `varint(messageId)` + `schema.diff(...)`：`packages/mudb/src/protocol.ts:64-91`（发送 `stream.writeVarint(this.idBase+messageId)` 后写 diff）；接收 `:196-231`（`readVarint` → `schema.patch`）。raw 通道：`:114-119` 预留 `5 + data.length`，实际写 1 个 varint id + 原样 payload ⇒ **头 1–2 字节**（`idBase` 由 protocol 注册顺序累加，`:143-151`）。
* JSON 帧只用于 raw-string 消息：`:100-103`（`{i,d}`）与解析 `:183-195`。
* 差异同步语义在 schema 层：`packages/mudb/src/schema/*.ts`（5003 行含 rda/rpc/socket 共约 20122 行）；`struct.ts`(523)、`sorted-array.ts`(309)、`dictionary.ts`(328)、`array.ts`(284)、`quantized-float.ts`(91) —— 量化浮点说明**体素/坐标是定点压缩传输的**，这是 socket.io 完全没有的能力。
* 分片重组：`socket/web/server.ts:78-101`（ws `binaryType:'fragments'` + `allocBuffer/freeBuffer` 池化）；心跳 `:404-411`（`pingInterval=10000`，半周期扫描）；背压 `:179-212`：**unreliable** 走"选 bufferedAmount 最小的 socket，≥ `bufferLimit`(默认 1024，`:365`) 就丢包"，**reliable 无任何水位检查**（`:210` 直接 `send`）⇒ 慢客户端 + 可靠通道 = 内核/进程发送队列无界增长（**这是唯一真实的内存型风险**）。
* 会话证明握手：`socket/web/server.ts:439-449`（`sec-websocket-protocol` 里的 `box3-proof.<token>`，`MuSessionProof.matches/verify`，重连时 `connection ? matches(existing.sessionProof)` `:470`），`createServer.ts:143-148` 打开 `requireSessionProof:true` + `maxPayload` play 1 MB / edit 16 MB，且强制子协议 `box3-game`（`:375-378`）。**无额外往返**（借用 WS 握手）——这点比 socket.io 的 ENGINE.IO 两轮握手轻。
* 房间广播：无房间概念，`protocol.broadcast` 遍历 `sockets[]`（`protocol.ts:74-87`）—— 地图内全量广播 + rda 差异，规模 70 人（`BOX_LOCAL_PLAYER_LIMIT`，compose:328/497）时 O(N) 可接受。

### 6.2 每连接内存（静态可推）

`MuServer.start` 的 `connection` 回调（`server.ts:159-271`）为**每个连接、每个已注册 protocol** 分配：

1. `bandwidth[pid][sessionId] = {sent:{raw:{count,bytes}}, received:{raw:{...}}}` `:164-177`；
2. `new MuRemoteClient` `:178-181`；
3. `factory.createDispatch([socket], ...)` —— **对协议内每条消息名生成一个闭包**（`protocol.ts:61-94`）+ `createSendRaw` 闭包 `:96-136`；
4. `protocolHandlers[pid] = {rawHandler, messageHandlers}` 再包一层闭包 `:196-202`。

play 模式注册的服务端协议约 **25–28 个**（`grep "spec.server.protocol("`：net/player/input/interact/chat/clock/gui/href/navigator/rtc/remote-channel/game-ui/dialog/storage/... + `anticheat/anticheat-host.ts:15` + `moderation/moderation-host.ts:35`），消息名总量 INFERRED 150–250。⇒ 每连接 **≈ 200–300 个闭包/对象**，JS 堆增量 **INFERRED 3–10 KB/连接**（V8 闭包 ~100–150 B）。加上 ws 层与 rda 状态副本，10 KB/连接是合理下界。**结论：mudb 的连接成本量级远低于 socket.io（后者每连接持有 adapter 房间集合 + ack 表 + JSON 序列化管线）。** 真正值得压的是下面两条。

### 6.3 可压缩点（带行号）

1. **协议一致性握手在出厂态是开着的**（重要）：`createServer.ts:141-142` `skipProtocolValidation = NODE_ENV!=='development' && method!=='local'`，而 launcher 把 `METHOD:'local'` 写死（`launcher.js:791`、`:931`，Rust 容器同样 `runtime.rs:377`）⇒ 条件恒为 `false` ⇒ `MuServer` 每条新连接都 `JSON.stringify({clientJsonStr, serverJsonStr})` 并发送（`server.ts:226-230`），客户端整串解析比对（`client.ts:118`）。这两串是**全部 25+ 协议 schema 的稳定序列化**（`protocol.ts:57` `stableStringify`；`MuProtocolFactory.jsonStr` 拼接 `:150`）——体积与协议总数成正比（可参考：打包进沙箱的客户端 shell `src/assets/isolate/ivm2-script-entry.js` 为 **1,297,654 B**，其中就包含这些 schema），保守 INFERRED 数十 KB～百 KB/连接。修法（低风险）：`MuServer` 启动时预计算 digest，握手只发 `{h: sha256(jsonStr)}`（64 B）；或把 `skipProtocolValidation` 从 `method` 解耦，仅按 `NODE_ENV`/显式 env 决定。**顺带修掉客户端每次 `JSON.parse` 大串的 CPU 尖峰。**
2. **messageGuard 的无条件克隆**：`server.ts:286-311` 一旦安装 guard，每条入站消息 `schema.clone(event.data)`（或复制 Uint8Array）后才异步裁决；guard 由反作弊按需安装（`anticheat/message-inspector.ts:34-37`，`anticheat-host.ts:31-42` 只在脚本注册监听或"恢复期"才装）。装了就等于**每条玩家消息多一次深拷贝 + 一次 `JSON.stringify(publicData(...))`**（`message-inspector.ts:57-64`，>16 KiB 直接拒绝）。建议：按 `observesMessage` 掩码（已存在，`:41`）先过滤再克隆；克隆改惰性（拒绝路径才需要 retained 副本）。
3. **reliable 通道补水位**：与 unreliable 一样检查 `bufferedAmount`，超限触发限速/踢人（`web/server.ts:209-211`）。
4. `_findConnection` 线性扫（`web/server.ts:389-396`）与 `sockets.splice(indexOf)`（`server.ts:265`）改 Map —— O(N)→O(1)，70 人下是微优化，但池化多图后同一进程连接数会 ×K。

---

## 7. 启动与就绪：真实瓶颈排序 + 预热方案

### 7.1 就绪语义的三个硬事实

1. **health-check 要等到整张图加载完才可用**：路由在 `entry.ts:374-397` 注册，但 `httpServer.listen()` 在 `entry.ts:782-789` —— 位于"工程加载 + 预烘焙（`:461-682`）+ `createGameServer`（`:758`）"之后。⇒ 前门的轮询（`runtime-readiness.js:41` → `launcher.js:407-419`，500 ms 一次）在此期间**只会 ECONNREFUSED**，无法区分"还在烤"和"死了"。
2. **42%→90% 的进度条实际不会动**：`edit-library.js:179-218` 先置 `percent:42`，只有 `onWindowElapsed` 才推进；而 `waitFor(url,{timeoutMs})`（`launcher.js:393-421`）在 `deadline = now + 30 min`（`:424-426`，`runtime-readiness.js:3` 默认 `1800000`，上限 24 h `:8`）内**只重试不 reject**（`:400-405`），所以 `onWindowElapsed` 只在整整 30 分钟超时后触发一次，`percent` 直接从 42 跳到 `min(90, 42+48)=90`（`edit-library.js:211`）。启动成功时用户看到 18%→42%→100%，**中间没有任何真实相位**。
3. **prewarm 恒为 0**：`compose:347` `BOX_CREATOR_EDIT_PREWARM_RUNTIMES:-0`、`:514` `BOX_PLAY_PREWARM_RUNTIMES:-0`，`launcher.js:289-295` 的 `prewarmCount` 取默认 0 ⇒ `:1304-1337` 的后台预热循环体为空（play 侧连 creator 预览的 `BOX_CREATOR_PLAY_MAX_RUNTIMES` 都没有预热键）。注释说明是刻意的（`:1301-1303`："启动全部地图会让服务启动和第一个玩家抢 CPU/磁盘"）——但这等于把全部冷启动成本转嫁给第一个玩家。

### 7.2 冷启动真实步骤排序（源码依赖顺序，成本 INFERRED，需 §10-4 定序）

| 序 | 步骤 | 代码 | 为何贵 |
|---|---|---|---|
| 1 | P2 监督进程 boot：`require project-manager`（3075 行）+ `getLaunchTarget` 顶层同步 IO | `launcher.js:104/115` → `project-manager.js:2543` | **含一次同步 `tar -czf`**（`:746-793`→`:1238`）+ group blob 全量 `linkSync/copyFileSync`（`map-group-manager.js:125-146`） |
| 2 | 资产/头像校验（18 次 existsSync + 可能 `spawnSync prepare-assets`） | `launcher.js:654-673`、`:314-331` | 一次额外 node 子进程 |
| 3 | game-server 模块图求值（59 个顶层 import，`entry.ts:1-79`；`isolated-vm` native binding；`sql.js`/`pg`/`pino`/`ws`/`zod`） | `dist/src/launch.js`（`launcher.js:780`） | **无 V8 compile cache**：全仓 `enableCompileCache`/`v8-compile-cache` 零命中，而基座是 `node:22.17.0`（compose:288）⇒ Node 22 的 `module.enableCompileCache()` 可直接用 |
| 4 | 并行：预烘焙 `bs.build('prebakeMap', ...)`（缓存命中则跳过） | `entry.ts:600-643`，`prebake.ts:45-170` | 未命中缓存 = 全量迁移 + 无界并发预取（`prebake.ts:23-43`） |
| 5 | 并行：fork ivmp 子进程 + 读 1.3 MB shell + `compileScriptSync` | `ivmp-script-socket-server.ts:54-68`、`ivmp-process-entry.ts:30-33`、`ivmp-vm-controller.ts:83-91` | `--no-node-snapshot`（`:20`）放弃 Node 启动快照；shell 编译是 isolate 首次 `runSync` 的大头（`:128`） |
| 6 | 体素同步解压 | `createServer.ts:191` → `voxel-server.ts:228-231` | 与体素数线性，单线程 |
| 7 | 首次 `scriptServer.launch()`：isolate 内 shell 自举、mudb client 连接、脚本 `require` | `script-host.ts:1045` | 玩家可见的"进入游戏"最后一段 |

### 7.3 可落地方案（按性价比）

1. **早期 listen + 真实相位**：把 `httpServer.listen()` 提到 `entry.ts:461` 之前，health-check 返回 `{status, phase:'baking|voxel|script|ready', percent, elapsedMs}`（数据源已有：日志点 `entry.ts:511/578/611/647/756/778/796`）。前门 `runtime-readiness.js` 改读 phase 而不是"通/不通"，**超时从 30 min 降到 120 s + 相位级重试**，UI 进度真正连续。
2. **V8 code cache 打开**：launcher 顶部 `require('module').enableCompileCache?.(dir)`（Node 22 支持，仓库现状零使用）；game-server 与 P2 都受益；同时**删掉 `getLaunchTarget` 里的 `createProjectSnapshot('launch')`**（移到空闲后台，§4.1-#3），首图最坏可省掉一次 tar。
3. **shell code cache 落盘**：`ivmp-vm-controller.ts:89-91` 已把 `cachedData` 存在实例字段；改为持久化到 `BOX_RUNTIME_CACHE_PATH/<sha256(shell)>.code`（`launcher.js:280-287` 的 `derivedRuntimePath` 正好是命名空间），**第 2+ 张图与重启后**都省一次 1.3 MB shell 解析。
4. **有界预热**：`prewarmCount` 默认 0 → 改为 `min(1, maxRuntimes)` 且只在 `BOX_PLAY_PREWARM_RUNTIMES` 未显式为 0 时生效；预热必须在**健康检查全绿之后**串行跑（已有 `setTimeout(…,1000)`，`launcher.js:1336`），并加"内存预算门"（§3.3-2 的采样），避免预热把 creator 6 GB 顶满。
5. **预取加信号量 + 体素解压分片让出**（§4.1-#7/#8）。
6. **删除 P2**（§2.4-4）：省一个 node boot + 一次校验/快照，这是**唯一能同时改善 RSS 与冷启动的结构性改动**。

预期首图延迟改善（INFERRED，需 §10-4 定基线后才能兑现为承诺值）：删 P2（−0.4~3 s）+ 免启动期 tar（−0~数十 s，取决于工程体积）+ compile cache（−0.2~0.8 s）+ shell cache 命中（−0.3~1.2 s）+ 早期 listen（体感：0 s 就有反馈）。目标：**首图 3–6 s、第 2+ 图 <2 s**。

---

## 8. 可观测性与健康检查

* **日志**：`utils/logger.ts:13-31` —— pino 8.19；`NODE_ENV==='development'` 才启用 `pino-pretty` **transport**（即 thread-stream 子线程 + 额外序列化）；容器里 `NODE_ENV=production`（`Dockerfile:183`）⇒ 无 transport 线程，直写 fd（这是好的一面）。ivmp 子进程另建一个 pino（`ivmp-process-entry.ts:11-27`），dev 下**同样**开 pretty transport ⇒ 每张图一个额外日志线程。`stdio:'inherit'`（`ivmp-script-socket-server.ts:59`）意味着子进程日志走父进程 fd，无管道背压但也无法分流。
* **metrics**：**全仓库无 metrics 端点**（`grep prometheus|/metrics` 在 game-server / local-engine / Rust / realtime-client 均 0 命中）。仅有：前门 `/__local_runtime/status`（`edit-library.js:283-298`）里嵌 `runtime.metrics()`（`launcher.js:581-605`：cpuPercent/memoryBytes/processCount/uptimeMs，来自 §3.2 的 `/proc` 采样，**无需新依赖**）；`game-server` 侧 `perf/perf-server-schema.ts` 只是状态字段。
* **健康检查的进程开销（E §1 CPU 抖动的根因）**：
  * JS 服务镜像 `Dockerfile:281`（creator）/ `:347`（play）/ `:384`（player-service）/ `:428`（voxa）都是 `CMD node -e "fetch(...)"` —— **每次探针起一个新 Node 进程**（~40–56 MB RSS 峰值 + 一次 V8 boot，≈100–200 ms CPU），默认 Docker 30 s、出厂 15 s（E §4）。
  * Rust 侧 `docker-compose.yml:272-277` `test: ["/app/server-manager","--healthcheck"]`（`main.rs:235-236` → `web.rs:14`）——native 自检，`interval:5s` 也只 0.55% CPU（E §1）。
  * 地图容器同病：`runtime.rs:352-357` `--health-cmd "node -e \"fetch(...)\""` + `--health-interval 5s`。
  * 仓库 `docker-compose.yml` 的 creator/play/voxa/player-service **本身没有 healthcheck 段**（只有 redis `:22`、postgres `:43/:65`、redis `:90`、server-manager `:272`）——说明 E 观察到的 15 s `node -e` 探针来自**镜像内 HEALTHCHECK**（Dockerfile 行号如上）。
* **零开销探针建议**：
  1. 把 `node -e` 换成**进程内心跳文件 + 无进程探针**：应用侧 `fs.writeSync('/tmp/healthbeat', JSON.stringify({phase,ts}))`（每 tick 或每秒），Docker 探针用 `test: ["CMD-SHELL","sh -c 'exit $(( $(date +%s) - $(cut -d, -f2 /tmp/healthbeat) > 30 ))'"]` —— 仍是 shell fork（≈1 MB、<10 ms），比 node 轻一个数量级；或彻底 `interval: 0` 关掉 Docker 探针，由前门/Rust 在**同一进程内**做 TCP/HTTP 探测（前门已有 `waitFor` `:393-421`，`apps/game/server/system-status.ts:27-38` 已有 in-process `probeTcp`，把 dashboard 探针复用为权威健康源）。
  2. health-check 响应里加 `phase/percent/isolateHeap/rssMB`（§3.3 + §7.3-1），使"进程在但没就绪"可观测，这是 30 min 超时敢降到 120 s 的前提。
  3. `readRuntimeProcessTree` 已是跨图聚合器，把它从"查 status 才算"改成 5 s 定时采样 + 环形缓冲（每图 ≈ 200 B/s），就是最小可用 metrics。

---

## 9. 改进清单（收益 / 半径 / 风险 / 可否上游）

收益列为"每图"或"整体"，数值为源码可推 + E 实测锚定的估计，凡未实测标 INFERRED；实现半径 = 需触碰的文件数与耦合深度。

| # | 改动 | 位置 | 省内存 | 省冷启动 | 实现半径 | 破坏兼容风险 | 可上游 |
|---|---|---|---|---|---|---|---|
| 1 | **creator 路径去掉递归监督 launcher，直起 game-server**（play 已有实现） | `launcher.js:1006-1084` → 抄 `:911-983` | **−56 MB/图**（E 实测同类进程 RSS 56.6 M）；10 运行时 → −0.55 GB | −0.4~3 s/图（INFERRED：省一次 node boot + 模块求值 + 校验/快照） | 小（1 文件，端口/env 语义要一起搬） | 低（`processGroup`/`detached` 语义需保留，`:1038/1068`） | ✅ 纯收益 |
| 2 | **共享 ScriptletDaemon + isolate 池（1 进程 K isolate），raw 通道加 sessionId** | `ivmp/protocol.ts:7-27`、`ivmp-process-entry.ts:61-63`、`ivmp-vm-controller.ts:19-52`、`mudb/socket/child_process/{client.ts:61-64,server.ts:152-167}` | **−45 MB/图**（node 基线，INFERRED）；K=4 时每图增量 → 15–25 MB | −0.3~1.5 s/图（省 fork；`_cachedData` 跨图复用，INFERRED） | 中大（6 文件 + 崩溃路径） | 中（崩溃半径 ×K；需 §2.5 前置安全修复） | ✅（需配安全边界评审） |
| 3 | **摘掉 jail 里的 `ivm` 注入**（池化的安全前置） | `ivmp-vm-controller.ts:112-124`（`createHostInterface:403` 的 `ivm`，dev `jail.setSync('ivm', ivm)`） | 0 | 0 | 极小 | 低（脚本 API 不该用得到 ivm；dev 测试工具需换 hook） | ✅ 安全修复，最容易先合 |
| 4 | **内存预算从"猜体素"改成"cgroup 校验 + 采样自适应"**，并给 game-server 默认 `--max-old-space-size` | `launcher.js:136-160`、`:879-884`、`map-runtime-profiles.js:47-49`；新增 `/sys/fs/cgroup/memory.max` 读取 | 不直接省，但**消除 Σchild>container 的 OOM 拓扑**（§3.1）；允许把 creator 6 g→2.5 g（**−3.5 GB 名义**，让 8 GB 机器可跑） | −0（启动期一次 stat） | 小（launcher 内） | 中（大地图配额可能被下调；需 warn + profile 覆写） | ✅ |
| 5 | **默认限额收敛**（compose/deployment-manager 默认值） | `docker-compose.yml:298,481,564,115,189`；`apps/deployment-manager/src-tauri/src/commands.rs:223-229,1136-1163`；`scripts/check-desktop-deployment-manager.js:283-289`（校验脚本会同步要求改） | 名义 −7 GB；实付 VM 峰值显著下降 | 0 | 极小（数值 + 同步校验脚本） | 低（用户已保存的 .env 不变；`memory_mebibytes` 默认值需同步） | ✅ |
| 6 | **tar/快照/导入移出请求线程** | `project-manager.js:1237-1252`、`746-793`、`1662-1690`、`2543-2569`、`425-442`、`map-group-manager.js:125-146` | 0 | **首图 −0~数十 s**（去掉启动期 tar，INFERRED 与工程体积成正比） | 中（worker 队列 + 进度 SSE；`runTar` 已是注入点 `options.runTar`） | 低（行为等价，只是异步化；错误时序要改） | ✅ |
| 7 | **`Atomics.wait` 锁改异步 / 状态写下沉前门** | `services/game-server/src/project/local-project-state.ts:211-254`（`:220/:229`），调用链 `:302-324`、`edit/replica/replica-server.ts:1674/1942/2085/2355` | 0 | 0 | 小（异步化）/ 大（下沉前门） | 中（并发语义，多进程 bind mount 共享；stale 回收 300 s 逻辑保留） | ✅（消除最坏 30 s 全图卡顿） |
| 8 | **早期 `listen` + 相位化健康报告 + 超时 30 min→120 s** | `entry.ts:374-397 vs 782-789`、`runtime-readiness.js:3/25-70`、`launcher.js:423-427`、`edit-library.js:179-218`、compose `:349/516` | 0 | 体感：首响应从"最长 30 min 黑箱"→ <1 s；真实改善取决于配套预热 | 中（需保证 listen 后请求被 503/phase 挡下） | 中（`waitFor` 语义、UI 契约 `/__local_runtime/status`） | ✅ |
| 9 | **V8 compile cache + 沙箱 shell code cache 落盘** | `launcher.js` 顶部（Node 22 `module.enableCompileCache`）；`ivmp-vm-controller.ts:89-91`；`launcher.js:280-287` 命名空间 | 0（code cache 磁盘 ≈ 数十 MB/进程） | **−0.2~0.8 s/进程** + **−0.3~1.2 s/图**（shell 编译，INFERRED） | 极小 | 低（cache 目录可写性：容器 `--read-only`，需 tmpfs/派生卷，见 `runtime.rs:351`） | ✅ |
| 10 | **有界预热（1 张主图）+ 预算门** | `launcher.js:289-295,1304-1337`；compose `:347/514` 默认值 | 预热图 +50~100 MB 常驻 | **第二图起 −80% 冷启动**（缓存/预热） | 小 | 低（默认 1 可关） | ✅（对"小团队体验"最直接的开关） |
| 11 | **`node -e` Docker 探针 → 进程内心跳 / 前门探针** | `Dockerfile:281/347/384/428`、`runtime.rs:352-357`；复用 `launcher.js:476-605`、`apps/game/server/system-status.ts:27-38` | −40~56 MB **瞬时尖峰/次**（不再每 15 s 起 node） | 0 | 小 | 低（健康语义变化需同步 Rust/文档） | ✅（E §1 空闲 CPU 抖动的直接解药） |
| 12 | **mudb 协议握手改 digest；出厂态关掉大 JSON 比对** | `createServer.ts:141-142`（`method==='local'` 使校验恒开）、`mudb/server.ts:226-230`、`mudb/client.ts:118`、`mudb/protocol.ts:57/150` | −数 KB/连接（`pendingMessages`+解析临时串） | 新连接 −几 ms~几十 ms/玩家 | 小（hash 需双端同版本） | **高**（跨版本握手兼容，必须保留旧串比对回退） | ⚠ 需上游协商 |
| 13 | **messageGuard 惰性克隆** | `mudb/server.ts:286-311`、`anticheat/message-inspector.ts:34-64` | −每条入站消息 1 次深拷贝 | tick 抖动下降 | 小 | 中（审核语义：裁决前必须持有副本的边界要重证） | ✅ |
| 14 | **reliable WS 通道补背压水位** | `mudb/socket/web/server.ts:209-211` | 消除慢客户端无界发送队列 | 0 | 极小 | 中（会开始踢/限速） | ✅ |
| 15 | **`METHOD=local` 与 `VM=isolate` 的语义修正**（isolate 模式落地或改名，消除容器路径被静默降级成 ivmp） | `runtime.rs:377/382`、`entry.ts:652-680`、`config/index.ts:65` | 随 #2 | 随 #2 | 小（加枚举校验 + 映射） | 低（当前 `isolate` 本就落到 default） | ✅ bugfix |
| 16 | **Web 层解耦：仓库操作下沉前门内部服务；Next 转静态壳** | `apps/game/server/local-project-manager.ts:9-32`（含 dev 每次重 require `:30`）、22 个调用点、3 个 SSR 页面（`app/e/[container]/page.tsx:23`、`pages/p/[gameName]/index.tsx:64`、`pages/projects/launch.tsx:22`） | **−~220 MB 空闲**（E §2：两个 `next-server` 122.3+113.9 MB 可被 ~15 MB API 进程替换） | SSR TTFB 从 0.99–1.13 s（E §5）→ 静态 <50 ms | 大（apps/game 面积） | 中（路由/鉴权/中间件迁移） | ⚠ 需上游架构决策；建议先做 A（内部 REST），B 作为发行形态选项 |
| 17 | **`getProject` 读路径禁写 + permanentId 索引** | `project-manager.js:937-968/670-694/969-986/990-1002` | 0 | 首图 −若干次全目录扫描（N 项目时数百 ms，INFERRED） | 小 | 低（迁移需一次性脚本补 permanentMapId） | ✅ |
| 18 | **体素解压分片让出 + 预取加信号量** | `voxel-server.ts:214-234`、`createServer.ts:191`、`prebake.ts:23-43` | 峰值 −（并发 chunk 数上限差）INFERRED 数十~数百 MB/大图 | 大图首图 −（避免 fd/内存抖动） | 中 | 中（预烘焙缓存键要包含并发参数？不必，仅取数顺序） | ✅ |

---

## 10. POSTPONED_MEASUREMENTS（需要独占窗口/触发才能测，本车道未执行）

1. **每图真实增量 RSS 与进程数**（对标 §1.4 的 150–200 MB/图假设）：开局一张小图 + 一张 1024×128×1024 大图，`docker exec <c> sh -c 'for p in $(ls /proc|grep -E "^[0-9]+$"); do awk "/VmRSS|^Name/{printf \"%s \" \\\"/proc/\\$p/status\\\"; }"'`；前门 `/__local_runtime/status` 的 `memoryBytes/processCount` 可直接读（`launcher.js:581-605`），**无需重启**。
2. **isolate 实际堆 vs 512 MB 配额**：在 `ivmp-process-entry` 内加一次性 `isolate.getHeapSizeSync()` 日志（源码改动，属改造期实验），或 `kill -USR2` + `process.report`（E §11.5 已列，越界）。当前 UNVERIFIED。
3. **Σ(child limits) vs mem_limit 的 OOM 复现**：连续打开 8 张 play 图（`BOX_PLAY_MAX_RUNTIMES=8`，`compose:513`）观察 creator/play 容器 OOMKilled 与 `RestartCount`。需独占（升级车道会 recreate 容器）。
4. **冷启动相位耗时排序**（§7.2 全表 INFERRED → 实测）：用 `docker logs --timestamps` 对齐 `entry.ts:511/578/611/647/756/778/796` 与 `launcher.js:1212/1236/1242` 的就绪时刻；需要"重建容器"才能拿到干净 boot 序列。
5. **tar 快照对 HTTP 线程的阻塞时长**：对 100 MB / 1 GB 工程各跑一次 publish/export，测该服务其它端点（`/api/health-check`）的 TTFB 劣化。需写 `~/box3`（红线），顺延。
6. **mudb 协议 jsonStr 的真实字节数**（§6.3-1）：在 `MuServer.start`（`mudb/server.ts:150`）打印 `clientFactory.jsonStr.length` —— 一行日志即可把"数十 KB/连接"从 INFERRED 变实测。需改代码运行，或从出厂 bundle 静态提取（B 车道 bundle）。
7. **Atomics.wait 锁争用最坏 30 s** 是否在真实多子图（map group）编辑中发生：需要两个编辑器同时开同组两张图。
8. **每连接 JS 堆成本**（§6.2 的 3–10 KB 估计）：`--inspect` + heap snapshot diff 需要 20 个并发玩家连接，非只读。

---

## 11. 本车道结论（给主控的锚点）

1. **"重"确实不在 JS 执行，而在拓扑**：E 实测空闲 313.67 MB 对 12.94 GB 名义限额；本车道在源码里找到了这条鸿沟的**三个制造者**：(a) `creator/play` 每图 2–3 个 Node 进程（`launcher.js:1024` / `:911` / `ivmp-script-socket-server.ts:54`），(b) 由桌面 UI 手填、算术上必然超额的 `mem_limit` 组合（`docker-compose.yml:298/481` + `commands.rs:223-229`），(c) 每 15 s 起一个 Node 进程的容器健康探针（`Dockerfile:281/347/384/428`）。
2. **可压缩目标**：**每图 1 个进程**（#1 删监督进程，#2 池化 isolate），**每图增量 RSS 15–25 MB**（K=4 共享，基线单进程模型 60–75 MB），**首图 3–6 s / 第 2+ 图 <2 s**（#6 去 tar + #8 相位化 + #9 code cache + #10 预热），**整套空闲名义预算 ≤ 5.9 GB**（#4/#5），**用户机器 VmRSS（vmmem）目标 ≤ 1.5 GB**（属交付形态车道，但只有 #16 去 SSR 镜像 + #4/#5 收敛限额才能给它腾出空间）。
3. **最大不确定点**：**同进程多 isolate 的 CPU 公平性与崩溃半径**。源码给出充分的安全证据（V8 堆硬隔离 + 已有 `timeout` 闸），但**没有任何一处代码度量过"一个恶意脚本占用宿主事件循环的时长"**——`scriptTimeout` 是"单次 `apply` 调用"级（`ivmp-vm-controller.ts:246-248`），不是"每 tick 每 isolate 累计"级；而 `TICK_RATE=64` 的循环（`index.ts:87`）与 mudb 的可靠队列没有任何 per-isolate 预算记账。
   **能 retire 它的 PoC（无需上游改动，30 行以内，独占窗口内可跑）**：在一个 game-server 进程里用 `ivm2` 起 3 个 isolate（`ivm2-script-socket-server.ts:415-421` 直接复用，无需 #2 的路由改造），其中 1 个跑 `while(true){}` + 1 个跑高频 `postMessage`，然后测：(i) 宿主 `process.pid` 的 tick 间隔抖动（在 `clock-server-controller.ts:48-68` 的 tick 里打点）；(ii) 另外 2 个 isolate 的消息端到端延迟；(iii) 一个 `memoryLimit` 打满触发 OOM 抛出时其它 isolate 是否存活。判据：若 (i) 抖动 > 20 ms 或 (iii) 出现跨 isolate 连带 dispose，则**默认保持 ivmp（1 进程:1 isolate）只做 #1 删监督进程**，把 #2 作为"可信地图（自研/内部私有化）"专用模式；若抖动 < 5 ms 且崩溃被 V8 隔离干净，则 #2 可提为默认。
