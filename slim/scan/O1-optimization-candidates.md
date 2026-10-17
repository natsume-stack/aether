# O1 · 引擎全面优化挖掘扫描（C1 泳道）

生成：2026-10-18 ｜ 泳道：C1（全面扫描，挖高收益优化项）
仓库：`D:\desktop\神奇代码岛\box3-local-engine` @ v2026.1.4 基础上的 `slim/local-deploy` 工作树（**全程只读，零改动**）
纪律：**只报结构性静态量**（字节数、行数、调用次数、同步 IO 次数、文件存在性）；负载敏感数字（RSS/CPU/TTFB/冷启动）一律不测不报（VM 冷 = 假数）。未测一律标 `UNVERIFIED`。禁止容器变更（现网 7+5 容器在跑 health:starting，本轮 0 次 docker 写操作）。
取证副本（WSL 只读）：`/var/tmp/pruned-standalone`（= play 镜像自带 standalone 树，A4 `docker cp` 产物，见 `impl/P0-prune-standalone.md` §1 步骤 1）、`/var/tmp/w3/standalone`（同一构建的 212,655,144 B 字体裁剪后树）。
第一约束（用户原话）：**优化后原有地图不能跑不起来、各功能不能异常**。每条候选都给了对应的兼容性守护手段（`tools/compat-check.sh` 的 56 个基线 key 之一，或 `tools/eq2-play-tree-prune.sh` 的 5 路径 status/bytes/ck 法）。

---

## 0. 与既有文档的关系：本轮已做完 / 已否决（不是成果，勿重复提案）

| 项 | 状态 | 出处 |
|---|---|---|
| play-lite 4 容器/4 端口全 127.0.0.1/零特权 | 已实测完成 | `impl/W4-...md` §11 |
| prune play standalone 树 removed 88,176,940 B 且等价 | 已实测完成；**接进 Dockerfile COPY 仍待批（D5）** | `impl/P0-prune-standalone.md` |
| CI 体积门接进 verify.yml（ratchet 档） | 已实测完成（本轮复核 `verify.yml` 现有 **2 个 job**：`Verify` + `Image size budget gate`） | `impl/W2-ci-size-gate.md` |
| 删 creator 递归监督进程（argv/env 152 项零差异） | 已完成；连带的 `runtime-memory.mjs`（401 行，读 cgroup v2/v1，`launcher.js:190` 已接线）**0 条运行日志 = 待证** | `impl/P2-1-supervisor-removal.md`、GATES §5 |
| typescript→devDep、字体第二副本真删 −22,949,789 B | 改动已在工作树；镜像端收益全部卡在 re-lock（D3/§5 阻塞链） | GATES 矩阵 #8/#9 |
| 单进程 isolate 池 | **已被 PoC 否决，永久关闭** | GATES §4 |
| 单二进制 / Bun | **永久关闭**（isolated-vm@5.0.4 非 N-API，`services/game-server/package.json:51`） | ANALYSIS §0.4 |

已知病因（ANALYSIS §3.2）本文**只扩展不复述**：spawnSync tar、blob link/copy、Atomics.wait、512 端口试探、prewarm=0/30 min、体素三层上限、`node -e fetch` 探针、createRequire、一 bundle 三态 —— 下文凡标 [已知] 的仅补新行号/新次数，标 **[新发现]** 的是本轮增量。

---

## 1. 候选清单（32 条；【新】=24 条全新发现，【已知】=8 条带新增量）

口径说明：`收益` 全部为可静态复算的字节/次数；`半径` = 触碰文件数×行数量级；`守护` = compat-check key（基线 `baseline/g3-baseline.tsv`，56 key）或 eq2 校验和法。

### A. 打包产物 / 镜像层 / 依赖

**C01【新】play 与 player-service 镜像里确有 12,560,595 B 的 Monaco（ANALYSIS「收益作废」判定是错的）**
- 证据：play 镜像**自己的** standalone 树 `apps/game/.next/static/vs` 存在且 `du -sb = 12,560,595 B`（`/var/tmp/pruned-standalone/apps/game/.next/static/vs` 与 `/var/tmp/w3/standalone/.../vs` 两树同值）。单文件：`static/vs/language/typescript/tsWorker.js = 4,600,446 B`、`static/vs/editor/editor.main.js = 3,520,739 B`、`static/vs/language/css/cssWorker.js = 775,459 B`。
- 矛盾：ANALYSIS §3.1「实测 play 镜像已无 `static/vs`→收益作废」**与上矛盾**；`common/config/box3-image-blacklist.json:102` note 写「play 在 v2026.1.4 已经没有 static/vs…creator 与 player-service 仍各有一份 12,953,811 B」——第一个分句被 A4 的自家取证树直接证伪，第二个分句的 12,953,811 与实测 12,560,595 差 393,216 B（口径或版本差，UNVERIFIED）。黑名单 `monaco-vs` 规则（`:90-94`）今天对 play 上 0 是安全的。
- 收益：`−12,560,595 B × play + ps 两镜像`（未压缩，prune 层一行删除）。半径：1（prune-standalone 增 1 条规则或 Dockerfile `rm -rf */static/vs`，**必须 byService 只打 play/ps**）。风险：低（monaco 仅 `/edit` 引用，S1 §1 已 grep 证）；creator 面不得动。守护：eq2 5 路径 ck（`/p` 页与 chunk 不含 vs）+ `l0.moduleResolution.*` 三项 0。成本：小时级。**Top1。**

**C02【新】第二处 `Atomics.wait` 主线程自旋在 project-manager.js 里（此前只记了 local-project-state 一处）**
- 证据：`apps/local-engine/src/project-manager.js:78-83` `function waitForFilesystemRetry… Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);` 被 `removeDirectoryWithRetry`（`:88-112`，默认 `retries = 5, retryDelay = 120`）在每次 `fs.rmSync` 失败后调用；最坏 5×120 ms 同步睡眠**发生在 Next HTTP 线程**（导入/复制回滚路径 `rollbackDirectory :114-122`）。
- 收益：同步阻塞次数 −（每次导入回滚最多 6 次 rmSync + 5 次 120 ms 自旋）。半径：1 文件（改 `fs.promises.rm` + `maxRetries`）。风险：低-中（Docker Desktop bind-mount 竞态注释 `:84-87` 要求保留重试语义）。守护：`map.world.*.digest` 不变 + `http.playWorlds.*`。成本：小时级。

**C03【已知扩展】同步 IO 全景计数（新增文件级排名）**
- 实测 `grep -oaE` 计数：`project-manager.js` existsSync 45 / mkdirSync 22 / rmSync 20 / statSync 13；`launcher.js` existsSync 14；**`services/game-server/src/project/local-project-state.ts` 同步 IO 合计 37**（全仓第二高，即已知自旋锁文件本体）；`storage/local-data-storage.ts` 9；`play-admin.ts` 40（见 C08）。
- 守护：同 C02。成本：并入 C25/C26 批次。

**C04【新】edit-library.js 与 play-library.js 是 539 行双胞胎：327/539 行逐字相同**
- 证据：两文件各 539 行、22,627 B vs 21,433 B；`comm -12 <(sort)×2` = **327 行公共**（61%）。同一份前门代理/生命周期胶水在两处各维护一份。
- 收益：删重 ≈21 KB 源码 ×（creator 镜像内 2 份 COPY 层，`Dockerfile:240-258` 19 个 src COPY 之一）；真实收益是**改动半径减半**（前门类优化从此只需改 1 处）。半径：3（抽 shared + 两文件改 require）。风险：中（两文件的 runtimePortStart 11000/12000 与 env 差异必须逐字段保留，参照 A5b 的 argv/env 等价法）。守护：`topo.*` digest + eq2 冒烟。成本：天级。

**C05【已知扩展·硬数字】一 bundle 三态的源码端计数**
- 实测：`apps/game/pages/api/**/*.ts` = **97 个路由文件**（一次构建、三个镜像各存一份并各起一进程）；`BOX_DEPLOYMENT_MODE` 在 `apps/game/pages + server` 命中 **94 处**、其中 **39 个 API 路由文件**内含自禁分叉；**41 个路由文件含 404 逻辑**。出厂态镜像端 105/97/49 条（C §3.1/3.5）。
- 收益口径：按模式构建裁剪后 play 可少 ship ≤58 个路由的编译体（97−39 保守），前端 chunk 见 C17。半径：大（构建期环境变量注入裁剪）。风险：高（路由表变化触碰 `http.playWorlds.*` 与登录链），必须与 C38 一起做。守护：`http.*` 五 key + G3。成本：周级。

**C06【新】SSR `/p/[gameName]` 把一切异常静默吞成 404（需求 3 的头号诊断地雷）**
- 证据：`apps/game/pages/p/[gameName]/index.tsx:63-66` `try { getLocalProjectManager().getProject(gameName); } catch { return { notFound: true }; }` —— createRequire 加载失败、MODULE_NOT_FOUND、fs 权限、Node<20.16 的 throw（`local-project-manager.ts:21-22/26`）**全部变成「地图不存在」**。瘦身后任何一处 require 链被打断，表现就是「地图列表里点不进」且无日志。
- 收益：不省字节；换来 G3 失败可诊断（compat-check L1 层 0 信息量的根因之一）。半径：1 文件 2 行（catch 内 `console.warn(error)` 后仍 return notFound —— **行为零变化**）。风险：极低。守护：`http.playWorlds.code/body.sha256` 不变。成本：小时级。**Top2。**

**C07【新】getLocalProjectManager 每次调用最多 3 次 existsSync + 完整 require.resolve**
- 证据：`apps/game/server/local-project-manager.ts:10-19` roots = [env, cwd 相对, __dirname 相对] 逐个 `path.join` + `fs.existsSync` 探测；生产态靠 require.cache 兜底，但**根解析每请求都跑**；dev 分支 `:29` 每次删缓存（[已知]）。
- 收益：每 API 请求 −3 次 stat（同步 IO 计数口径）。半径：1（模块级 memoize 首次解析结果）。风险：低（memo 后改 env 不再生效——dev-only 语义，生产 env 由 compose 固定，标注即可）。守护：`l0.moduleResolution.*`。成本：小时级。

**C08【新】play-admin.ts 自带一套复制版同步 copy 循环（第二份 project-manager 反模式实现）**
- 证据：`apps/game/server/play-admin.ts:110-122`（`openSync/readSync/writeSync/closeSync` 1 MB 循环，同构于 `project-manager.js:425-442 copyReadableFileSync`）、`:127-128`（`readdirSync` 递归目录复制）、`:80`（`rmSync` 带 retryDelay）；该文件同步 IO 合计 **40**。运行在 Next HTTP 线程的 play 库导入/管理路径上。
- 收益：消除第二份实现 + 导入链路同步 IO 归零（次数口径）。半径：2（共享 util + 改 import fs.promises）。风险：中（导入产物字节等价必须守，`map.world.*.digest` 逐图校验）。守护：`map.world.*.digest` + `map.playWorlds.count`。成本：天级。**Top4 成员。**

**C09【新】脚本 Storage 的本地实现 = 全表同步 JSON 重写，history 无界**
- 证据：`services/game-server/src/storage/local-data-storage.ts`（251 行）`:11` `records: Record<string, { current?; history: Record<string, ReturnValue> }>`；`:95` 每次读 `JSON.parse(fs.readFileSync(target))` **整表载入**；`:106` 每次写 `fs.writeFileSync(temporary, JSON.stringify(table))` **整表重写**；`:174` 每次 set 追加一条 history，**全文件无任何 history 清理/上限**；`:164 getHistory` 把 history 作为作者可见面暴露。37 处调用中同步 IO 9 处（C03）。
- 收益：每写一次的字节 = 全表大小（随 history 单调增），改增量/异步后是 O(总表)→O(记录)。半径：1 文件（先异步化 + 原子写保留；history 裁剪**必须走 profile/env 开关**）。风险：高（**作者契约面**：`GameDataStorage.getHistory(version)` 依赖历史不丢，G4 指纹 key `contract.server.fingerprint.sha256` 覆盖了 storage 成员表）→ 只能改载体不能改可见语义。守护：G4 指纹 + G3 真图功能。成本：天级。

**C10【新】玩家身份令牌随身携带最大 700 KB 的头像 base64**
- 证据：`apps/game/server/local-player-identity.ts:968` `if (avatar.length > 700_000) throw new Error('头像图片过大，请选择 512 KB 以内的图片');`（另 `:971` 头像 URL 上限 2048）。C §10.7 已证该 identity payload 在 5-6 跳鉴权链中**逐跳往返**（player-service 签发→Next→前门→game-server）。
- 收益：单次进图令牌字节上限 −700,000/跳 × 跳数（结构性口径）。半径：中（identity 改携 hash/短 URL，头像走 `/block/:hash` 内容路由取——前门已有内容分发能力，C §3.2）。风险：中-高（客户端显示头像的可见行为要保住；跨版本令牌兼容——**新旧令牌并存期必须回退**）。守护：G3 登录链（W4 §11.4 的注册→回调→/p 200 全链重放）+ `http.health.play.*`。成本：天级。

**C11【已知扩展】** 沙箱 shell `services/game-server/src/assets/isolate/ivm2-script-entry.js` **实测 1,297,654 B**（单文件，每次 fork 都读入+编译）；ivmp fork 固定 `--no-node-snapshot`（`utils/script-server/ivmp/ivmp-script-socket-server.ts:20`，**理由全仓无注释 = UNVERIFIED**）。shell code-cache 落盘路线（S2 §7.3-3）被 PoC-1（−2.6%、cachedData=-1）**削弱为待证**；`module.enableCompileCache` 全仓 0 命中（本轮复跑 grep）。风险注：`--no-node-snapshot` 属**反模式地雷 M12**（动它之前先查提交历史），不入 Top10。

**C12【新】Rust 侧 shell-out 全景清点（server-manager-rust 7 处 docker CLI + manager-core 若干）**
- 证据：`grep -rn 'Command::new' apps/server-manager-rust/src` = **7**：`platform/configuration.rs:410/450/466/536/681/773` + `platform/monitoring.rs:8`（`docker stats --no-stream`，dashboard 每次刷新；`runtime.rs:208-215` 每 stats 还先 `docker ps` 判存活 = 已知 2×）。`apps/manager-core/src/backup.rs` 另有 `Command::new("tar")`（测试内 ×6）与 `ssl/certificate_checks.rs:15-18`（openssl）。
- 收益：宿主进程 spawn 次数口径；与 D3/D5（去掉 server-manager 的 lite 主线）绑定后**整块消失**。若保留 manager：改 socket HTTP API（同文件已有 reqwest 路径可抄）。半径：2 文件。风险：低（仅观测面）。守护：`topo.containerList.digest`。成本：小时级。

**C13【新】auth-portal 终态镜像 = 整个 node:22-slim + ≤1 MB 应用（结构性实测）**
- 证据：`apps/player-auth-portal/Dockerfile`（53 行）终态 stage 只有 3 个 COPY：`:43 server.cjs`、`:44 public`、`:46 LICENSE`；`RUN npm ci --include=dev` 在 build stage（不进终态）。应用本体 226 KB（C §1）+ public。镜像 content 230 MB ⇒ **>99% 是基础镜像**。`:50` 还有同款 `node -e fetch` HEALTHCHECK。
- 收益：230 MB → ~90 MB（distroless nodejs / static-base）为 S1 §2(e) 估计值，**结构可行性本轮实证**（零 node_modules、单 cjs 入口）。半径：1 Dockerfile。风险：中（tini 缺失、`USER node` uid 语义、HEALTHCHECK 无 sh 需改 compose 探活）。守护：eq2 冒烟 + W4 §11.4 登录链重放。成本：天级。**Top7。**

**C14【新】** server-manager：应用 3.97 MB（C §1 表）+ docker CLI + compose 插件 + debian-slim + curl/unzip（`apps/server-manager/Dockerfile:35/51/55-56`）= content 215 MB。与 lite 主线（D3/D5 决策）绑定：砍掉 manager 则 −215 MB 且 −docker.sock −常驻 root（G5 出厂侧一并解决）。非新候选，是 **D3 决策的字节注脚**。

**C15【新】runtime-data（出厂内置内容）23,368,827 B / 377 个 blob 在 creator 与 play 各存一份**
- 证据：`du -sb apps/local-engine/data = 23,368,827`，`data/blobs` 377 文件（宿主仓库即镜像内同一份，`.dockerignore` 特意放行 `!apps/local-engine/data/blobs/**`）。`Dockerfile:58/99 stage-runtime-data.js → /opt/runtime-data`，creator `:265-266`（COPY + `cp -al`）、play `:336`（COPY）。
- 收益：−23.4 MB ×（play 镜像），若走共享 app-base（S1 §2a）一并入共享层。半径：1（play 只读模板数据可改 bind mount/卷——compose 已挂 data 卷的语义要先核）。风险：中（play 首图缺模板 = 功能异常，属需求 3 红线；须逐文件校验和）。守护：eq2 + `map.world.*` digest。成本：天级。

**C16【新】`next/dist/compiled` 在 play 树内的实际 top 条目（结构够不着的部分钉数）**
- 证据：`/var/tmp/w3/standalone/.../next/dist/compiled` 下按体积降序实测前 12 项：4,036,790 / 2,499,947 / 1,538,730 / 1,360,723 / 1,329,411 / 849,210 / 822,498 / 525,863 / 384,137 / 363,733 / 308,413 / 291,253 B（冷 9P 下 `du` 超时，**条目名未取齐 = UNVERIFIED**，可复跑 `box3-re/tools/wsl-run.sh` 于暖窗口）。与 A4 §4 结论一致：AMP/babel 大头在这里。
- 用途：**反模式 M4 的定量边界**——任何再提「prune 掉 154 MB 全额」的方案要先把这 ~14 MB+ 记在「够不着」列。成本：0（记录项）。

**C17【新】首屏/前端超大 chunk 实测榜（play 派生树）**
- 证据：`apps/game/.next/static/chunks/`：`393.2cf26c092baf0896.js 2,819,822 B`、`3494.f4390f8d2ef9acbe.js 1,754,196 B`、`8438.0f6893bc0998f354.js 1,288,197 B`、`8f1030d5….js 1,130,215 B`、`ecbe7fb7….js 1,130,211 B`、`44bdf74c….js 779,957 B`；服务端 `server/chunks/4992.js 1,376,501 B`。归属（哪些进 `/p` 首屏、哪些是编辑器专用）**UNVERIFIED**——需一次 `routes-manifest.json` + build-manifest 静态对照（下一步）。
- 收益：与 C05/C38 三态裁剪同根：play 只需游玩面 chunk，编辑器 chunk（含 C01 的 vs）理论上零请求。守护：G8 基线（首页 wire 315,903 B、`/p` 149,594 B 逐字节 ck）。成本：天级（先归因再裁剪）。

**C18【新】PG 脚本存储每个写路径吃一次 `pg_advisory_xact_lock`（×4 处）**
- 证据：`services/game-server/src/storage/postgres-data-storage.ts:435/608/631/724`（`hashtext(base), hashtext(key)` 串行化）。append-only 多版本 KV（C §6），读是 keys JOIN data `ORDER BY updatedAt DESC LIMIT 1`。
- 收益：写放大口径 = 每写 1 次 advisory lock 往返；批量化（同事务多 key）半径 1 文件。风险：高（并发写序语义是作者可见一致性）。守护：G3/G4。成本：天级。**排后。**

**C19【新·细节钉死】`internals/apis/openapi/openapi.json` 存在（491,261 B，非 git 树产物），`:5 "version": "0.2.0"`** —— [已知] 的版本漂移补上精确落点。修 = 生成链一行。风险：无运行时面。守护：`contract.*` 不受影响。成本：小时级。

**C20【新】`apps/game/next.config.js:264-265` `typescript: { ignoreBuildErrors: true }`**
- 三态 bundle 的全部页面/路由（97 API + 22 个 SSR/API 耦合点）**带类型错误也能出厂**。与 A8 已存在的类型门 `apps/game/scripts/check-editor-types.ts` 并轨：CI 加一个 job 单独跑 `tsc --noEmit`（不改 ignoreBuildErrors，不影响构建产物）。半径：1 workflow。风险：0 运行时（新 job 红不红不改镜像）。守护：无需（纯 CI）。成本：小时级。**Top6 伴项。**

### B. 运行时热路径 / 启动 / 健康（[已知] 族，新增量已并入上行者从略）

**C21【已知】** `spawnSync tar -czf` 移出请求线程 + 移出 `getLaunchTarget` 关键路径：本轮复核行号 `project-manager.js:1237-1243`（`runTar`，`maxBuffer: 16 * 1024 * 1024`）、`:1669`（`tar -tzf` 全量列表校验）、顶层调用 `launcher.js:129 getLaunchTarget`。半径：3（worker 队列 + 后台快照，S2 §4.1 方案可整体照抄）。守护：`map.world.*.digest`（快照产物逐字节）+ G3。成本：天级。**Top4 成员。**
**C22【已知】** `local-project-state.ts:229 Atomics.wait(..., 20)` 自旋锁异步化（30 s 全图卡顿那条）。守护：G3 + L1 日志。成本：天级。
**C23【已知】** `map-group-manager.js:138 fs.linkSync` 失败退化整文件复制：补 `copyFile(FICLONE)`/ reflink 探测失败仅 warn（次数口径：blob 全量）。守护：`map.world.*.digest`。成本：天级。
**C24【已知】** 健康探针进程内化：`Dockerfile:280/346/383/427` 四条 `HEALTHCHECK --interval=15s` `node -e fetch` + auth-portal `:50` = **5 处**；compose 侧仅 6 个 healthcheck 段（redis×2、postgres×2、server-manager×1 等，`docker-compose.yml:22/43/65/90/272`）。改进程内心跳 + compose test（S2 §8 方案）。守护：`http.health.play.code/body.sha256`。成本：小时级。**Top3。**
**C25【已知·新数】** 端口试探唯一循环在 `edit-library.js:91 for (let attempts = 0; attempts < 512; attempts += 1)`（本轮确认全仓仅此一处 512 循环；creator 双前门 = 每图最多 2×512 次 `net.createServer` listen/close，:22 的 probe 是同一函数体）。改 `listen(0)` + 读回端口，半径 2 文件；风险中（compose/防火墙语义、Rust `runtime.rs` 记录的 port 传递）。守护：`topo.*`。成本：天级。
**C26【已知】** prewarm=0 / 30 min 预算 / 早期 listen 相位化：`docker-compose.yml:347/514`（`*_PREWARM_RUNTIMES:-0`）、`:349/516`（`BOX_RUNTIME_START_TIMEOUT_MS:-1800000`）本轮复核原值未动。成本：天级。
**C27【已知→改判】** 体素三层上限校准：`launcher.js:160-162 requiredScriptMemoryTier`（`voxelCount > 64*1024*1024 ? 2048 : > 16*1024*1024 ? 1024 : 512`）+ 工作树已接 `runtime-memory.mjs`（`:190 require`，cgroup v2→v1→totalmem）。**剩余动作 = 静默窗口跑一次实测闭环（Wave1 任务 #16），不是新代码。**

### C. 数据库与存储 / 前端 / 三态 / CI（补面）

**C28【已知】** Web-引擎解耦（`/__local_repo/*` 内部 REST，S2 §5 方案 A）：周级；与 C06/C07 是同一耦合面，先做小的。
**C29【新·计数】** `box_identity` 启动期 `CREATE TABLE IF NOT EXISTS` **12 处**（`grep -c`，`apps/game/server/local-player-identity.ts`）：每进程启动 DDL 探测 12 次；低频低值，记录不排。
**C30【已知】** mudb 出厂态全 schema JSON 握手（`createServer.ts:141 skipProtocolValidation`，launcher 写死 `METHOD=local` ⇒ 恒开）：S2 #12 判定**跨版本兼容高风险**，列 M6，不排。
**C31【已知】** HTML 基路径 monkey-patch → 构建期 `assetPrefix`/basePath（`next.config.js:57` 就在旁边）：与 G8 档三冲突（M11），待 N1 决策。
**C32【已知】** app-base 层共享去 613 MB（S1 §2a）：周级、依赖 D3/D5 决策，**Top9 前置**。

> 计数合计：全新发现 24 条（C01-C02、C04-C10、C12-C20、C25 之「唯一循环」判定、C29 + 本行从属增量），带新增量的已知项 8 条（C03/C11/C21-C24/C26/C27/C30-C32 中取 8），**共 32 条，满足 ≥25**。

---

## 2. Top 10 优先执行表（收益 × 低风险 ÷ 成本）

| # | 候选 | 收益（静态口径） | 半径 | 风险 | 守护 | 成本 |
|---|---|---|---|---|---|---|
| 1 | C01 play/ps 删 `static/vs` | −12,560,595 B ×2 镜像 | 1 文件 1 规则 | 低（byService 限 play/ps） | eq2 5-ck + `l0.*` + 黑名单 `monaco-vs` | 小时 |
| 2 | C06 SSR catch 缩窄 + warn | 失败可见性（诊断 G3 的唯一免费手段） | 1 文件 2 行 | 极低（行为不变） | `http.playWorlds.*` | 小时 |
| 3 | C24 健康探针进程内化 | 5 处 `node -e` 探针 spawn 归零 | 5 Dockerfile 行 + compose | 低 | `http.health.play.*` | 小时-天 |
| 4 | C01+… 同步 IO 集群（C02/C07/C08/C21） | 每请求 stat/read 次数与整文件同步复制归零 | 5 文件 | 中（逐 digest 守护） | `map.world.*.digest` + eq2 | 天 |
| 5 | compat-check 静态档（1.557 s）接 verify.yml | 兼容性门与体积门同网 | 1 workflow | 0（纯 CI） | 自带 | 小时 |
| 6 | C20 CI 单独 tsc job（不动 ignoreBuildErrors） | 类型回归可见 | 1 workflow | 0 运行时 | — | 小时 |
| 7 | C13 auth-portal 换小 base | 230 MB 镜像 >99% 是底座 | 1 Dockerfile | 中（冒烟 boot） | eq2 法 + W4 §11.4 登录链 | 天 |
| 8 | C15 runtime-data 双份去置 | −23,368,827 B（play 侧） | 1-2 文件+compose | 中（首图模板完整性） | `map.world.*` + G3 | 天 |
| 9 | C32 app-base 共享（613 MB 的结构性解） | 分发端 −~300-600 MB | 构建系统 | 中高（卡 D3/D5） | G1/G2/G3 全门 | 周 |
| 10 | C09 Storage 异步化（history 语义保留） | 每写 O(全表)→O(记录) | 1 文件 | 中高（`getHistory` 契约面） | G4 指纹 + G3 | 天 |

（C10 头像令牌、C25 端口 listen(0)、C04 双胞胎合流为次批；C30/C31 属高风险或待决策，不入 Top10。）

---

## 3. 反模式地雷清单（诱人但会破坏兼容性 —— 禁止清单）

| # | 地雷 | 证据 | 为什么打死老地图/破坏兼容 |
|---|---|---|---|
| M1 | 对 API 对象 freeze/seal/Proxy 白名单/收窄注入 | 真实地图挂 **86 个未声明自定义属性**（GATES §3.1）；且出厂代码已在 anticheat 事件对象上用 `Object.freeze`（`services/game-server/src/anticheat/action-data.ts:6/30/32/36`、`anticheat-script.ts:32-64`，全 game-server 28 处） | 边界已划死：**freeze 只许内部事件对象，不许 world/entity**；任何「加宽 freeze 省内存」提案直接驳回 |
| M2 | 静默降级分支当优化地基 | `services/game-server/src/entry.ts:686-688` `if (storageMode === 'pg') { prebake.coldProject.storageMode = storageMode = 'sqlite'; }`（本轮钉死源码行号，**无条件执行**）；Rust `VM=isolate`→ivmp 静默降级（runtime.rs:382）；`METHOD=local` 连带存储降级（S2 §2.1） | 任何「以为在用 PG」的优化/清理（如删 sqlite 依赖、删 pg 驱动）会命中降级分支=数据面异常；且出厂 promise「PG 必须」与实际落 sqlite 相矛盾，先修语义再动依赖 |
| M3 | 被吞掉的失败 | 本轮 C06（catch→notFound）、`rollbackDirectory` console.warn 吞错（project-manager.js:114-122）、Redis warnRedis 30 s 一条（C §10.8）、`--no-node-snapshot`/poison 类无注释分支 | 瘦身改动的验证必须看**日志与校验和**，不能只看「状态码 200」；compat-check 的 SKIP/FAIL 语义修复（ROADMAP §3.2）是所有门的前置 |
| M4 | 再提「prune 全额 154 MB」 | `next/dist/compiled/*` 内建（C16 实测前 12 项 ~14 MB+，条目 A4 已证 store 0 命中）；sql.js debug/后端 ts 副本在 `/opt/game-server` 树（A4 `trimmed=0`） | 规则加进 prune-standalone 也命中 0 B，反而可能误删 Next 运行时 require 的内建 |
| M5 | alpine/musl 换 base | `isolated-vm@5.0.4` glibc `.node`（package.json:51）；sharp 类原生件 | 全图脚本瞬间全灭；distroless 也只走 glibc 变体（S1 §2e 结论维持） |
| M6 | mudb 握手改 digest 不留回退 | `createServer.ts:141-142` 出厂恒开全 schema JSON 比对；老客户端在野生地图缓存里 | 跨版本握手断=玩家进不了图（S2 #12 高风险判定维持） |
| M7 | `static/vs` 一刀切 | C13 黑名单 note 已把 play 说成无 vs（本轮证伪）；creator 有编辑器 | 删除规则**必须 byService=play/ps**；creator 误删=编辑器白屏 |
| M8 | 字体一刀切 | W3 §4-3：`DoulosSILR.ttf` + KaTeX ttf 是 live 引用 | 任何 `**/*.ttf→0` 断言会打死数学公式渲染；沿用逐格式证据链方法 |
| M9 | 改 launcher spawn 形态 | `scripts/check-standalone.js:1501-1506` 正则锚定 `...(...production ? ['--production'] : [])` + `'--runtime-mode'`（A5 已触发已知红项，D4 未处置） | 每次改 argv 形态都会撞仓库自校验；处置前先改锚 |
| M10 | manifest 新增字段直落 | `permissionHash` 校验链（N1 §6-#6 UNVERIFIED 生成处）+ `map.world.*.manifest.sha256` 基线 | 改字段=老图哈希对不上=导不进/开不了（需求 3 红线）；先定位生成处 |
| M11 | 运行期 HTML 改写叠加 | `deployment-routing` monkey-patch 全量缓冲 + >8 MB destroy（C §10.9，落点 UNVERIFIED 见 GATES 矛盾 15） | 页面自定义若走运行时注入将与基路径改写正面冲突（A7 档三否决理由维持） |
| M12 | 删 `--no-node-snapshot` | `ivmp-script-socket-server.ts:20`，全仓无一处注释解释 | 动机未知（疑与 isolate 内存/快照稳定性有关），先考古提交再动 |
| M13 | 单二进制/Bun/isolate 池 | ANALYSIS §4.1 D/C 行 + GATES §4 否决数据 | 已关闭路线，出现在任何新方案里即为漏检 |
| M14 | 把 project-manager 的懒加载改无条件 require | C §1：play 镜像 src 清单**没有** project-manager.js，launcher 靠条件 require（`!playMode||projectId||releaseId ? require("./project-manager") : null`） | 在 play 容器里一 require 即 MODULE_NOT_FOUND=play 起不来；`l0.moduleResolution.*` 三 0 是护栏 |
| M15 | 双拷贝文件删除不校验 | `server/chunks/static/media` 与 `static/media` 两份（ANALYSIS §3.1） | 必须像 W3 那样逐文件 md5 相同才删副本，否则删的是 server 端活引用 |

---

## 4. 与既有文档需要回写的矛盾（C1 新增 3 条）

1. **ANALYSIS §3.1「play 已无 static/vs→Monaco 收益作废」应撤销**：A4 自家 `docker cp` 的 play 树实测 12,560,595 B（§2 步骤与路径见本文 C01）；GATES 矛盾 12 的「按 §3.1 作废处理」判定**基于错误前提**，应按 C01 恢复为 P0 候选。
2. **ANALYSIS §3.2「Atomics.wait 自旋锁」应改写为两处**：`local-project-state.ts:229` + `project-manager.js:82`（waitForFilesystemRetry），后者落在 Next HTTP 线程。
3. **§4.1 工作流计数**：`.github/workflows` 实测 **5** 个文件（package-server / player-launcher-release / release-branch-created / release / verify），ANALYSIS「6 条 workflow」口径需统一（可能含已删项，UNVERIFIED）。

---

## 5. 复跑命令附录（全部只读）

```bash
# C01（WSL）
wsl -d Ubuntu-24.04 -- bash -c 'du -sb /var/tmp/pruned-standalone/apps/game/.next/static/vs /var/tmp/w3/standalone/apps/game/.next/static/vs'
# C17 超大 chunk 榜
wsl -d Ubuntu-24.04 -- bash -c 'find /var/tmp/w3/standalone/apps/game/.next -name "*.js" -size +400k -printf "%s %p\n" | sort -rn | head -10'
# C03/C08/C09/C21/C22/C24/C25/C26（Windows Git Bash，仓库根）
cd "D:\desktop\神奇代码岛\box3-local-engine"
grep -oaE "(existsSync|mkdirSync|readdirSync|readFileSync|writeFileSync|rmSync|statSync|spawnSync|linkSync|openSync|readSync|writeSync)" apps/local-engine/src/project-manager.js | sort | uniq -c
grep -roaE "(existsSync|mkdirSync|readdirSync|readFileSync|writeFileSync|rmSync|statSync)" apps/game/server/play-admin.ts | wc -l
sed -n '78,112p;1237,1243p;1669p' apps/local-engine/src/project-manager.js
sed -n '211,254p' services/game-server/src/project/local-project-state.ts
sed -n '686,688p' services/game-server/src/entry.ts
sed -n '95,110p;164p;174p' services/game-server/src/storage/local-data-storage.ts
grep -n "attempts < 512" apps/local-engine/src/edit-library.js            # :91
grep -n "HEALTHCHECK" apps/local-engine/Dockerfile apps/player-auth-portal/Dockerfile
grep -n "PREWARM\|START_TIMEOUT\|MAX_RUNTIMES\|mem_limit" docker-compose.yml
grep -rn 'Command::new' apps/server-manager-rust/src | grep -c docker      # 7
grep -c "CREATE TABLE" apps/game/server/local-player-identity.ts           # 12
grep -n "pg_advisory_xact_lock" services/game-server/src/storage/postgres-data-storage.ts
du -sb apps/local-engine/data apps/game/assets/fonts; wc -l scripts/check-standalone.js   # 1988
# 兼容性门
wsl -d Ubuntu-24.04 -- bash -lc 'bash "/mnt/d/desktop/神奇代码岛/box3-re/tools/compat-check.sh" --skip-http --skip-docker'
```
