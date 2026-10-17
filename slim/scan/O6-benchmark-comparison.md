# O6 — 全维度实测对比（出厂引擎 vs 轻量引擎）＋ demo 真图验证 ＋ box3.cdk.lat 处置

作者：C6 泳道（本轮唯一 Docker 权限泳道）
测量窗口：2026-10-18 **00:44 – 01:21**（本机时区 +08:00；WSL 内 `date -Is` 比宿主快约 2 分钟，本文一律用 WSL 原文时间戳 + `uptime`）
WSL 现场：Ubuntu-24.04 + Docker 29.1.3，`.wslconfig memory=8GB processors=8`
**本轮 WSL 未再重启**：`/proc/uptime` 4674 s(00:44) → 6659 s(01:21)，11 个容器的 `State.StartedAt` 全部 = `2026-10-17T15:31:19Z`（= 本地 23:31，即上一次重启后立即拉起），
所以 3 轮空闲 RSS 采样窗口是 **容器已连续运行 80–90 分钟的"熟态空闲"**，不是预热假数。每一段原文旁边都写了 `uptime`。

纪律执行：0 次 `prune` / `volume rm` / `compose down` / `--pull` / 镜像重建 / git 写 / install。
现网 `box-local-engine-*` 只做**只读 + 新增**；只有我自己的 `box3-lite-*` 被我重启过（2 次）。
证据文件全部在 `box3-re/tmp/`（编号 `c6-*`），本文每个数字后面给原文文件与可复跑命令。

---

## 1. demo 导入过程与真图验证（G3 第一次真图）

### 1.1 端点取证（只读，不猜 URL）

| 问题 | 确切答案 | 源码锚点 | 实测 |
|---|---|---|---|
| `.boxproject` 导入端点 | **`POST /api/local-projects/import`**，`bodyParser:false`，body = 归档裸字节，query `mode=independent\|submap` | `apps/game/pages/api/local-projects/import.ts:13,18,27-51` | creator `127.0.0.1:3127` → **401 `AUTH_REQUIRED`**；play `127.0.0.1:80` → **404**；lite `127.0.0.1:4121` → **404**（原文 `c6-09` §[4]） |
| 为什么 play/lite 是 404 | `allowCreatorApi()` 第一行 `process.env.BOX_DEPLOYMENT_MODE !== 'creator' → 404` | `apps/game/server/creator-api-security.ts:42-45` | 容器 env 实测：creator `BOX_DEPLOYMENT_MODE=creator`，play/lite 均 `=play`（`c6-08`） |
| 谁能过这道门 | Cookie 会话**或**任意 `Bearer bxc_…`（`player-service-client.ts:85-89` 把它转成 `X-Box-Creator-Authorization` 送身份服务），门在 `:105` 查**用户级 creatorPermissions**，不查 CLI scope | `creator-api-security.ts:93-108` vs `:125-153` | 未签发真 token（签发属变更动作，未做）→ **U2 仍 UNVERIFIED** |
| `.boxplay` 游玩库导入 | `POST /api/play-admin/import?mode=preview\|confirm`，Bearer `BOX_PLAY_ADMIN_TOKEN` | `apps/game/pages/api/play-admin/import.ts:27,55-90`、`play-admin-security.ts:9-26` | lite 无 token → **401 `服主密钥错误`**（路由存在且已开启）；带 token → **201/201**（`c6-13`） |
| 发布/打包 CLI | `node project-manager.js <list\|create\|publish\|package>`；**没有 import 子命令** | `apps/local-engine/src/project-manager.js:3050-3070` | `list` 跑通（`c6-09` §[3]），`publish`/`exportPlayBundle` 用模块 API 跑通（`c6-13`） |

**结论（结构性缺口）**：`.boxproject` 的导入面**只存在于 creator 模式**，lite 栈没有 creator，所以
**"把 demo 导进 lite 栈"这条路今天走不通**——只能先导入出厂 creator，再走 publish→`.boxplay`→play-admin 才能落到 lite 游玩面。
这直接回答了"以 demo 作为各泳道测试基准"的可行性：基准素材能进 lite，但**必须经过出厂 creator 一次**。

### 1.2 导入前快照（可复核）

原文 `c6-09-preimport-snapshot.txt`：
```
projects|files=4073|dubytes=175013372
play-worlds|files=908|dubytes=27992660
4073 /var/tmp/c6-pre-projects.sha256
 908 /var/tmp/c6-pre-play-worlds.sha256
edb5f6ec7d2d434d3fb6ee7790175b4e2d36aebdbbb8bb5b427c4650142f7ad9  /var/tmp/c6-pre-projects.sha256
ee390c6c5db140218305168254563b158e9c9f5d7efb13d52f25f2ffa3a8f3f0  /var/tmp/c6-pre-play-worlds.sha256
```
demo 归档：`20,054,401 B`，sha256 `a2752bc83c5d3307ac7ccda6728fd1aea19cf34f1ee46c8cc87dec49f2fca0c6`，2914 条目，
`group.json` 成员 = `cloud-4e84ee7ef626058f`（main，`mapRole:main`），`source/project-state.json` 里 **`permissionHash = QmVhLd6T2CnJjpkjkn9kYZxCPQUxvjDCchePs6RWiis9sC`（非空 ⇒ 能过发布硬门 `project-manager.js:2414-2416`）**。
> 顺带纠正一个旧口径：多份文档写"4983 个数据文件"，**实测 4073+908 = 4981**。

### 1.3 导入动作（引擎自己的代码路径，纯新增）

命令（原文 `c6-11-import.txt`）：
```
docker cp /var/tmp/c6-demo/demo.boxproject box-local-engine-creator-1:/tmp/c6-demo.boxproject
docker exec box-local-engine-creator-1 node -e '... pm.importProject("/tmp/c6-demo.boxproject",{mode:"independent"})'
```
结果：
```
projectsRoot=/app/apps/local-engine/projects
NEW_IDS=["cloud-4e84ee7ef626058f-imported-2"]
EXISTING_KEPT=["cloud-3a043df55e5057a5-imported","cloud-4e84ee7ef626058f-imported","yunhai-xiantu"]
import_wall_seconds=1.975166035
files=2910 bytes=41229421            # 新工程目录
compatibility level=warning  filesScanned=2907 scriptsScanned=48 warnings=4 errors=0 missingBlobCount=0
capabilities=["group-storage","player-kick","purchase","cloud-http"]
```
- **导入成功**，1.98 s，`nextImportedId()` 自动避开重名（`:1721-1730`），`mapGroupId` 重新分配 ⇒ 与既有 3 工程完全隔离。
- **兼容性判定：errors=0、missingBlobCount=0** ⇒ 当前引擎能完整读取这张图，缺的只是 4 条 warning（群组存储/踢人/支付/云端 API 在本地不模拟）。

### 1.4 导入后回归复核

原文 `c6-12-regression-check.txt`：
```
=== projects ===      existing_lines=4073  diff(pre, post-existing) → DIFF=EMPTY  OK: 既有工程逐字节未变
=== play-worlds ===   pre=908 post=908     → DIFF=EMPTY  OK: play-worlds 逐字节未变
post_agg play-worlds = ee390c6c… （与 pre 同一颗 sha256）
出厂 play /api/play-worlds → {id: cloud-4e84ee7ef626058f-imported, version: v1.0.1, playEnabled: true} 不变
```
兼容性闸 `compat-check.sh --quiet`（同一轮原文）：
```
FAIL drift.map.projects.count     = now=4 base=3
FAIL drift.map.scriptBlobs.total  = now=58 base=36
== FAIL  pass=54 fail=2 skip=0 ==
```
两条红**都是"新增第 4 个工程"造成的计数漂移**，原图 `cloud-4e84ee7ef626058f-imported` 的 `files/digest/manifest.sha256/scriptBlobs` 全部仍 PASS（pass 52→54）。
**判定：无回归。** 但这暴露闸的一个语义缺陷（§5-D4）：合法新增也会被判红。

### 1.5 发布 → 打包 → 导入 lite → 开放 → 进图（全链原文 `c6-13` / `c6-15` / `c6-18`）

```
publishMapGroup(cloud-4e84ee7ef626058f-imported-2, 1.0.0)  → 7.551 s   releases/1.0.0 = 935 文件 / 28,173,634 B
   permissionHash=QmTfSmPX4yiaHX9pm8gf98vf2ePbHYb3TbxTTGHEZ4VLDB  compatibility errors=0
exportPlayBundle(ref=id@1.0.0, assetMode=local)            → 3.567 s   .boxplay = 14,215,678 B（940 条目）
POST /api/play-admin/import?mode=preview  (Bearer owner)   → 201 ttfb=0.0066 s
   review.totalBytes=28,091,714  blobCount=931  unindexedBlobCount=537  mapCount=1（列出 script 资源含 client 脚本）
POST /api/play-admin/import?mode=confirm&reviewId=…        → 201 ttfb=1.113 s
   world.playEnabled=true   ← 「开放」在这一步自动完成，不需要额外动作
GET /api/play-worlds (lite)                                 → 200，2 张图（原 v1.0.1 + demo 1.0.0）
```
进图（用我在 lite 注册的玩家 `c6liteplayer`，`register 201 → login 200`，账号只进 lite 自己的 `box3-lite_box-lite-postgres-data` 卷，**没碰现网账号库**）：
```
GET /p/cloud-4e84ee7ef626058f-imported-2   http=200 bytes=149,616 ttfb=2.809 s        # 首次（冷）
POST /api/createSession  {mode:play, contentId/containerName: <world id>}
  attempt=1 http=202 RUNTIME_STARTING t=0.082 s
  attempt=6 http=200 t=10.772 s   → sessionId=a308379e-…  sessionProof=…  maxSockets=3  响应体 9,331 B
引擎侧原文（play 容器日志）：
  migrate voxel mesh … elapsed time 2ms（数百条）→ "Hot project baked."
  "Project loaded." → "Creating GameServer." → "Script server started." → "PlayServer started."
  "Script VM started." / "isolate received `notifyReady()`." / "socket script-0 ready"
  "local server listening on 10001" / "Server address: http://172.19.0.5:10001"
  "Total startup time = 1.40 seconds"
  "PostgreSQL legacy-compatible data storage ready: {namespace:"ea8e424699e4e6d5faa2", mode:"play"}"
  "Map ready: /p/cloud-4e84ee7ef626058f-imported-2"
  "Local user log in: C6 玩家"
容器重启后再开同一张图（预烘焙缓存命中）：attempt=4 http=200 t=7.189 s，"Total startup time = 1.25 seconds"
```
- **单图冷启动：首见 10.77 s（含迁移+预烘焙）/ 二次 7.19 s（缓存命中，`/app/play-runtime-cache` 495,348 B）；引擎自报纯服务端启动 1.40 s / 1.25 s。**
- 第一次我用 `containerName=c6join<n>`（乱填）→ 39 次全 **400 `An error occurred`**，容器日志给出真因是内部 `POST …/__local_runtime/start` **404**（`local-runtime-session.ts:53-56`、`createSession.ts:331-352`：`containerName` 就是运行时路径/地图 id）。这是**我自己踩的参数错**，不是引擎缺陷，但它同时证明：`createSession` 对未知 `containerName` **不返回 4xx 语义码而是 400 "An error occurred"**（可诊断性缺陷，§5-D5）。

### 1.6 `onPlayerJoin`：**UNVERIFIED**（本轮唯一没拿到的关键证据）

- 图里确实有：demo 工程 `source/blobs` 中 **22 个文件命中 `onPlayerJoin`、共 58 处**（出厂那张 v1.0.1 的 `data/blobs` 命中 4 处）。
- 但 `HTTP createSession 200` 只到"发牌"这一步：引擎把 `sessionProof` 交给客户端，**真正入局要客户端拿 proof 去连 mudb WebSocket**，服务端才会派发 join 事件。日志里能拿到的最强证据只到 `Local user log in: C6 玩家`，`grep -rila onPlayerJoin` 在容器日志/数据目录 **0 命中**（脚本默认不 print）。
- 要拿到它必须有一次真实浏览器入局（= ROADMAP 的 **D7**）。我没有假装：**G3 的 L3 层目前状态 = 「进图链路服务端全通 + 运行时真起 + 身份真入，唯 `onPlayerJoin` 事件本身未证」。**

---

## 2. 全维度对比表（出厂 7 容器 vs 轻量 4 容器）

采样时刻：RSS 行 = `c6-04` 3 轮 ×12 样本（uptime 4852–5401 s，00:51–01:00，**demo 尚未导入、栈纯熟态空闲**）；其余行 = 01:11–01:21。
「口径」列写明是 `docker stats`（= memory.current − inactive_file）、`cgroup cur`（含可回收 page cache）还是 `anon`（去掉 cache 的真常驻）。

| 维度 | 出厂 `box-local-engine` | 轻量 `box3-lite` | 差 | 口径/原文 |
|---|---|---|---|---|
| 常驻容器数 | **7 running**（+3 个 exited `*-storage-init`） | **4 running**（+1 exited） | −43% | `c6-07` §[1] |
| 宿主端口数 / 绑定 | **9 条**：`127.0.0.1:3127,9966,9967,80,3123,3124,8080,5432` + **`0.0.0.0:3130`** | **4 条**：`127.0.0.1:4121,4124,4125,4132` | −56%，且 0 条对外网卡 | `c6-07` §[1]/§[4]、`c6-22` |
| 挂 `docker.sock` | **1**（server-manager） | **0** | −1 | `c6-07` §[2] |
| 常驻 root 进程 | **2**（server-manager uid=0 ×2；postgres 进程 uid=70，其余 uid=1000） | **0** | −2 | `c6-17` §[c] |
| 容器内存名义限额合计 | 6+4+1+0.25+0.125+0.128+0.5 GiB = **11.94 GiB** | 4+1+0.125+0.5 = **5.63 GiB** | −53% | `c6-07` §[1] `HostConfig.Memory` |
| 进程数（整套，idle） | 19（creator3 play3 voxa2 ps2 portal2 mgr2 pg7…见原文 pids） | 14（play3 ps2 portal2 pg7） | −5 | `c6-04` pids 列 / `c6-19` |
| 进程数（**每图**） | 不可测（不能进现网图） | idle=**3 进程** → 开 1 图=**5 进程**（+2：`dist/src/launch.js --useProdBundle` 游戏服 + `ivmp-process-entry` 脚本 VM）；tasks 19→43 | +2/图 | `c6-19` §[A]、`c6-15` |
| 分发 gz | 6 归档 = **1,060,646,139 B = 1011.5 MiB** | 3 归档 = **531,307,786 B = 506.7 MiB** | **−49.9%** | `c6-17` §[a]（`find -printf %s` 与 catalog `size` 字段一致） |
| `docker load` 后 content | 6 镜像 = **2,736,210,446 B = 2609.45 MiB** | 3 镜像 = **1,358,827,262 B = 1295.88 MiB** | **−50.3%** | `c6-16` §[4] `docker image inspect .Size` |
| `du -sb /app` | creator 691,850,643 / play 373,668,042 / voxa 233,452,355 / ps 528,021,844 / portal 363,173 / mgr 8,655,365 = **1,835,711,422 B** | play 402,098,657（含 2 张图） / ps 263,153,254 / portal 363,173 = **665,615,084 B** | **−63.7%** | `c6-16` §[3] |
| **空闲 RSS（3 轮×12 样本）** | stats **376.14 MiB** / cur 446.09 / anon **284.14** | stats **258.74 MiB** / cur 304.04 / anon **166.38** | **−31.2% / −31.8% / −41.4%** | `c6-10`（含逐容器 mean/min/max/stdev/pids） |
| 重启后"冷态"idle（同刻对照） | creator 被我的导入 page-cache 污染（190→219 MiB），**不可用作对照** | **166.63 MiB**（01:20，4 容器全部 healthy 2 分钟）；12.8 s 前的值 196.39 MiB | — | `c6-21` / `c6-19` §[C] |
| TTFB 中位 / p95（`/api/health-check`，20 样本） | creator 3.3/4.4 ms · play 3.2/4.2 · voxa 3.3/**69.9** · ps 4.4/6.4 · portal 1.6/2.2 · server-manager **1.3/2.3** | play 3.1/4.4（熟）3.3/5.0（冷） · ps 4.3/5.8 · portal 1.3/2.1 | **基本持平（±0.4 ms）** | `c6-16` §[2]、`c6-19` §[D] |
| TTFB 业务端点 | play `/api/play-worlds` 4.1/**8.4** ms | play `/api/play-worlds` 3.3/4.5（熟）3.0/3.9（冷）；`/` 首页 **9.8/19.6 ms** | −20% 左右 | 同上 |
| 全栈 → 全 healthy | **UNVERIFIED**（不许重启现网；只有"容器创建时间互相差 <100 ms"这一条旁证） | **12.79 s**（`docker stop`×4 → `docker start`×4 → 4 个 healthy；逐容器 7.67 / 8.37 / 9.96 / 10.44 s） | — | `c6-19` §[C] |
| 单图冷启动 | UNVERIFIED | 首见 **10.77 s**（6 次轮询，含迁移+预烘焙）；二次 **7.19 s**（缓存命中）；引擎自报 1.40 s / 1.25 s | — | `c6-15`、`c6-18` |
| 进图首包 / 总字节 | UNVERIFIED | `/p/<id>` **149,616 B**（TTFB 2.81 s，冷）；`createSession` 响应 **9,331 B** | — | `c6-15`、`c6-21` |
| **每图增量 RSS** | UNVERIFIED | anon **+146.4 MiB**（104.3→250.7）· cur **+156.7 MiB**（111.2→267.9）· 新增 2 进程 Pss 合计 **152.6 MiB** · VmRSS 合计 249.0 MiB · 峰值 cur **+254 MiB** | — | `c6-19` §[A]、`c6-18` |
| **56 MB/图（A5 待证项）** | 见 §2.1 | 见 §2.1 | 下修 **~3.4×** 且**未部署** | `c6-21`、`c6-19` |
| 内存预算日志（`runtime-memory`） | 部署镜像里 **没有这个模块**：`ls /app/apps/local-engine/src/runtime-memory*` → 空；`BOX_RUNTIME_MEMORY_BUDGET_PATH` → 空；creator/play/lite-play 三个容器全量日志 grep `budget` → **0 条** | 同 | **实测 0 条** | `c6-22` |
| W5 每图前置成本（`w5-launchcost.sh` 首次落盘） | materialize 6.2–34.7 ms；validateProjectSource 0.3–0.8 ms；**cold tar 0.9–2776.1 ms**（warm 0.6–1.4 ms）；getLaunchTarget 10.6–40.5 ms；isolate tier=512 MB（voxels 524,288 / 2,097,152） | 不适用（lite 无 creator） | tar 是唯一大头 | `c6-20` |
| 公网入口 | box3.cdk.lat → `127.0.0.1:80`（**200**） | 未接隧道 | — | §5 |

### 2.1 关于"省 56 MB/图"——本轮实测结论（三层，逐层给数）

1. **改动根本没部署。** 部署镜像 `/app/apps/local-engine/src/launcher.js` = 压缩产物 **34,542 B / 3 行**，里面
   `occurrences_of_--runtime-only = 6`，并含原文
   `[…path.join(packageRoot,"src/launcher.js"),…,"--runtime-only","--runtime-mode",mode,"--project",project.id]`
   ⇒ **现网 creator 仍然是"每图再入一个 `--runtime-only` 监督子进程"**。
   工作树那份（A5 改的）= 67,636 B / 1536 行、`--runtime-only` 10 处、注释写着 *"the retired `--runtime-only`"*，sha256 与镜像完全不同。
   ⇒ "改前/改后各起一图"**在当前部署下不可能实测**（要做必须重建镜像＝D3，或重启现网 creator＝我不做）。
2. **同类进程的真实成本被 VmRSS 口径夸大了。** play 容器里那个 launcher 进程实测：
   `VmRSS 61,880 kB（=60.4 MiB，另一轮 63,360 kB）` / **`Pss 16,816 kB（=16.4 MiB）`** / 7 线程。
   旧口径"56 MB/图"正是 VmRSS 一类数字（`E-runtime-baseline.md` §2 的 56.6 MB 同类），
   而 VmRSS 会把父子进程**共享的 libnode/V8 映射重复计入**（该文档 §1 自己也注明过）。
   ⇒ **去重后每图能省 ≈ 17 MiB（Pss），不是 56 MiB；10 图上界 ≈ 0.17 GB，不是 0.55 GB。收益方向为正，但幅度下修约 3.4×。**
3. **每图总成本终于有实测了（原来只是 INFERRED 150–200 MB）**：
   增量 = **+146.4 MiB anon / +152.6 MiB Pss（游戏服 102.9 + 脚本 VM 53.3）**，坐落在那个带的**下沿**。
   即"监督进程"只占每图成本的 **~10–11%**，不是主项；真要砍内存应该动那 152 MiB 的两个进程（`--useProdBundle` 游戏服 + ivmp 宿主）。

---

## 3. 与 ROADMAP / 旧文档口径的出入（照实记账）

| # | 旧数字/旧主张（出处） | 本轮实测 | 判定 |
|---|---|---|---|
| 1 | 出厂空闲 RSS **313.67 MiB**（`E-runtime-baseline.md` §1，12 样本）；同刻 **328.05 MiB**（`impl/W4-play-lite-package.md` §4.2）；G2 门 ≤320 | 同一台机器、同一套栈、**连续 3 轮 36 样本 = 376.14 MiB**（uptime 80–90 min） | **两个旧口径都偏低 14–20%**。差异是"运行时长"：逐容器比 old→new：pg 23.0→42.6、portal 13.2→24.9、play 85.5→97.5、creator 92→98.8，全部随 uptime 单调上升（cache/连接累积）。⇒ **G2 的 ≤320 门必须显式绑定采样窗口（如"启动后 ≤30 min"），否则同一台机器可以同时"过门"和"不过门"。** |
| 2 | lite 空闲 **156.88 MiB**（3 容器、单次值，ANALYSIS §5） | 4 容器熟态 **258.74**，冷态（重启后 2 min）**166.63** | 旧值**作废**（容器数变了，且它是冷态单次值）。⇒ 旧"−52.2%"不能再用：熟态同刻 **−31.2%（stats）/ −41.4%（anon）** |
| 3 | lite **−52%** 的主要归因不明 | 逐容器拆：lite 少了 creator(98.8)+voxa(46.1)+mgr(6.5) 三个服务，且 play/ps/portal/pg 四项与出厂同名服务几乎相等（104.7 vs 97.5、112.6 vs 59.8*、14.8 vs 24.9、26.7 vs 42.6） | 收益**几乎全部来自"少 3 个服务"**，不是"同一服务变轻"。`*lite player-service 熟态 112.6 MiB 高于出厂 59.8`，但它 **anon 58.0 vs 出厂 55.3 基本相同** ⇒ 高出的是可回收 page cache（该容器限额 1 GiB vs 出厂 256 MiB，`NODE_OPTIONS` 里出厂有 `--max-old-space-size=192`、lite 没有）。**这是一条真实的口径陷阱：docker stats 口径下 lite 看着更"重"。** |
| 4 | 分发 **423.8 MiB**（2 归档）vs **531,307,786 B = 506.7 MiB**（3 归档） | 3 归档实测逐档相加 = 531,307,786 B（与 catalog `size` 字段完全一致），6 归档 = 1,060,646,139 B | **506.7 MiB 是对的**，423.8 是门户加入前的旧形态；ROADMAP 的"−49.9%" 复现 |
| 5 | 归档清单**都不含数据库镜像** | `postgres:16-alpine` content = 116,084,812 B，出厂/lite 两边都需要它 | 两口径同样遗漏（可比），但**"离线包 = 零外部依赖"这句话不成立**：DB 镜像在目录 A 的 0.2.0 单包里（707,806,289 B 含 6 镜像），2026.1.4 的逐镜像 catalog 里没有它 |
| 6 | "4983 个数据文件"（HANDOVER §46） | 实测 **4981**（4073 + 908） | 口径差 2，需在 baseline 里钉死计数方式 |
| 7 | "每图增量 RSS 150–200 MB（INFERRED）" | 实测 anon +146.4 / Pss +152.6 MiB | **从 INFERRED 升为实测**，落带下沿 |
| 8 | "省 56 MB/图（待证）" | 未部署；去重后同类进程仅 **16.4 MiB Pss** | **改判：收益存在但被高估 ~3.4×，且现网 0 收益**（§2.1） |
| 9 | "creator 双前门 = 每图最多 2×512 次端口试探"（`scan/O1` C25） | 未测（需要真实 creator 起图权限） | 保持 UNVERIFIED |
| 10 | W5 内存预算日志"至今没有一条运行日志" | 不但没有日志，**部署镜像里没有 `runtime-memory` 模块**，env 路径也是空 | 结论升级：该改动**源码态存在、部署态不存在**，与 #8 同因（未重建镜像） |
| 11 | "`tools/w5-launchcost.sh` 输出未落盘" | 本轮第一次跑通并落盘（4 工程 ×5 步计时，§2 表最后一行） | 已闭合 |

---

## 4. 隧道与 `box3.cdk.lat`

### 4.1 现状核查（只读，动之前）

```
$ cloudflared --version          → cloudflared version 2026.9.1 (built 2026-09-10T13:52 UTC)   （仅宿主有，WSL 内无）
$ tasklist | grep -i cloudflared → NO-CLOUDFLARED-PROCESS                                     ← 根因
$ cloudflared tunnel list        → 16a9e8c3-db1e-48e4-a206-7e3bd4994729 box3-engine  (CONNECTIONS 空)
                                   cf38da1d-6b5f-4ae8-81bd-2d685d10e1a2 loli-new     1xhkg01,09,10,11（别的项目，未碰）
$ cloudflared tunnel info 16a9e8c3… → "Your tunnel … does not have any active connection."
$ cloudflared route dns list cdk.lat → "use `cloudflared tunnel run` to start tunnel 16a9e8c3…"（DNS 记录在，指向该隧道）
$ curl -I https://box3.cdk.lat   → HTTP/1.1 530  Server: cloudflare  CF-RAY: a4c0d1c17b04e8cc-SJC   ← 修复前真实状态码
```
`~/.cloudflared/config.yml`（**改前已备份**：`box3-re/tmp/c6-05-config.yml.bak`，1482 B，mtime Sep 26 23:32）：
```
tunnel: 16a9e8c3-db1e-48e4-a206-7e3bd4994729
ingress:
  - hostname: box3.cdk.lat        → service: http://127.0.0.1:80     （出厂 play）
  - hostname: box3-auth.cdk.lat   → service: http://127.0.0.1:8080   （auth 门户）
  - service: http_status:404
metrics: 127.0.0.1:49321 / loglevel: info / no-autoupdate: true
```
**为什么不通**：不是配置错、不是 DNS 错、不是端口没起（`curl http://127.0.0.1:80/api/health-check` = 200，宿主经 WSL localhost 转发可达），
**纯粹是 cloudflared 进程没在跑**（隧道 0 条连接）⇒ CF 回源失败返回 **530**。

### 4.2 处置（只新增，不删不改）

```
# 未修改 config.yml 一个字：隧道 id / ingress / 凭据文件全部沿用既有配置
$ "C:\Program Files (x86)\cloudflared\cloudflared" tunnel --config %USERPROFILE%\.cloudflared\config.yml run
  （后台常驻，日志 box3-re/tmp/c6-06-cloudflared.log）
2026-10-17T16:54:10Z INF precheck complete hard_fail=false suggested_protocol=quic
2026-10-17T16:54:15Z WRN Failed to dial a quic connection … connIndex=3   ← 首条边超时后自动重试
2026-10-17T16:54:35Z INF Registered tunnel connection connIndex=3 location=lax13 protocol=quic
```
暴露面判断（对应 A8 的越权取证）：**只暴露游玩面**——`box3.cdk.lat→:80`（play）、`box3-auth.cdk.lat→:8080`（门户）。
creator(3127/9966/9967)、server-manager(3130)、postgres(5432)、voxa(3123)、player-service(3124) **一个都没进 ingress**，
所以 §5-D2 的 `bxc_` 越权面**没有被公网放大**（这是"保持原配置"的最大理由，我没有为了"能进图"去把 creator 挂上域名——那需要用户决策，见 §5-D1）。

### 4.3 公网侧验证（原文，`curl` 直连、无代理）

```
https://box3.cdk.lat/                                  http=200 bytes=51,535  ttfb=2.919 s
https://box3.cdk.lat/api/health-check                  http=200 bytes=33      ttfb=2.067 s
https://box3.cdk.lat/api/play-worlds                   http=200 bytes=439     ttfb=3.126 s   （列表含用户那张 起床战争 v1.0.1）
https://box3.cdk.lat/p/cloud-4e84ee7ef626058f-imported http=307 ttfb=1.252 s
        redirect=http://127.0.0.1/api/player-login/start?returnUrl=http%3A%2F%2F127.0.0.1%2F   ← 问题在这
https://box3.cdk.lat/api/local-projects                http=404
https://box3.cdk.lat/api/local-projects/import         http=404（POST 同样 404）
https://box3.cdk.lat/api/creator/v1/projects           http=404 bytes=0
https://box3.cdk.lat/api/server-manager                http=404
https://box3.cdk.lat/api/play-admin/worlds             http=401 bytes=32   ← 可达但 owner-token 门（见 §5-D3）
https://box3-auth.cdk.lat/                             http=200 bytes=466
https://box3-auth.cdk.lat/api/health-check             http=200 bytes=46
```
**当前真实状态码：`200`（首页/健康检查/地图列表都通），"通过域名能进图"这一步 = 307 但回跳地址是 `http://127.0.0.1` ⇒ 公网访客进不去。**

根因（配置而非代码）：出厂 play 容器 env 实测 `BOX_PLAY_PUBLIC_URL=http://127.0.0.1`、`BOX_PLAYER_LOGIN_URL=http://127.0.0.1:8080`（`c6-08`），
引擎按这个变量拼回跳地址（正是 `config.yml` 注释里"硬编码 `http://${publicHost}:${port}`"那条踩过的坑）。
**要修就得改现网 `.env` + 重启现网 play/portal 容器，并把 cookie 域设成 `.cdk.lat`（会同时发给同 zone 的其它站点如 LoliBox）** ——
这属于"动现网用户栈 + 跨域 cookie 面"，超出我的授权，**停下来交回用户决策（§5-D1）**。隧道本身我已经修好。

---

## 5. 回归发现 / 需用户决策

**兼容性判定：本轮无回归。** 依据（全部可复跑）：
既有 4073 工程文件 + 908 play-worlds 文件 sha256 全量比对 `DIFF=EMPTY`；出厂 play 那张 `起床战争 v1.0.1` 仍 `playEnabled:true` 且 `digest/manifest.sha256/scriptBlobs` 在闸里全 PASS；
3 个既有工程 id/`permanentMapId`/`releaseCount=0` 未变；我只新增了 1 个工程目录 + 1 个 `.boxplay` + lite 侧 1 个 world + lite 侧 1 个测试账号（**没往现网账号库写任何东西**）。

需用户决策（我按纪律没做）：
- **D1 公网进图**：改现网 `.env`（`BOX_PLAY_PUBLIC_URL=https://box3.cdk.lat`、`BOX_PLAYER_LOGIN_URL=https://box3-auth.cdk.lat`、`BOX_CREATOR_ALLOWED_HOSTS`、cookie 父域）+ 重启现网 play/portal。不改则 `box3.cdk.lat` 只能看首页、不能入图。
- **D2 授权面**：`bxc_` 任意 scope 可达 create/publish/export/package/import（`creator-api-security.ts:105` 而非 `:141`）。今天没被公网放大（creator 未上域名），但**本地任何进程/任何 token 都能用**。修 = 20 行显式化 `projects.manage`。我没碰。
- **D3 play-admin 面已公网可达**：`/api/play-admin/*` 经域名返回 401，唯一防线是 32 字符 owner token（lite）/64 字符（出厂），有 `10 次/5 分钟` 的 IP 级失败限流（`play-admin-security.ts:4-7`），但没有 Cloudflare Access 兜底。建议给它加 CF Access 或把 owner token 提到 ≥48 字符。
- **D4 兼容性闸语义**：`compat-check.sh` 把"合法新增第 4 张图"判成 2 条 FAIL（`drift.map.projects.count`、`drift.map.scriptBlobs.total`）。安全网应该区分"新增"与"被改"。属我自己的 `tools/`，建议下一轮我改（不在本轮范围，避免与 A9 泳道撞车）。
- **D5 引擎可诊断性**：`POST /api/createSession` 参数错（`containerName` 未知）→ **400 `{"message":"An error occurred"}`**，真实原因（内部 `/__local_runtime/start` 404）只在容器日志里。建议把内部错误码透出（1 行级改动）。
- **D6 现网 server-manager 绑 `0.0.0.0:3130`** 且挂 `docker.sock`、进程 uid=0 ⇒ 同局域网任何设备可直接打管理面并可经 docker.sock 提权到宿主。lite 形态天然没有这一项。建议把出厂 compose 的该端口改 `127.0.0.1` 绑定。
- **D7 一次真实浏览器入局**（ROADMAP 同名决策）：`onPlayerJoin` 就差这一步。
- **D8 交付主线**：`.boxproject` 只能进 creator（§1.1）⇒ 若要"lite 当开服机 + demo 当基准素材"，要么在 lite 包里加一个 creator profile，要么固定一条"出厂 creator 打包 → lite 导入"的双栈流水线。

## 6. UNVERIFIED 清单（本轮跑不出/没跑的）

1. `onPlayerJoin` 事件触发原文（需真实 WebSocket/浏览器入局，D7）。
2. 出厂栈"全栈 → healthy 耗时"、"单图冷启动"、"每图增量 RSS"、"进图字节"：都要求重启现网或进现网图，均越权。
3. `bxc_` 真 token 打五个"浏览器端点"（需签发 token，属变更动作）→ 沿用 A8 的 U2。
4. creator 路径改前/改后每图差值：改动不在任何镜像里，不重建不重启就测不了（§2.1）。
5. WSL 冷启动态下的 RSS（本轮只有"熟态"和"重启后 2 分钟"两种；VM 冷 ≤40 min 的数据我按要求没采）。
6. 客户端真实下载量（首屏 JS/字体/地图 blob 的浏览器侧字节）：本轮只做服务端侧（149,616 B 首页 + 9,331 B 会话体）。
7. `compat-check.sh` 里 `http.*`/`topo.*` 探针在 Windows Git Bash 下的假红问题（ROADMAP §3.2）——我只在 WSL 内跑，没复现，保持原样。
8. 并发多图的 RSS/CPU 曲线（`MAX_RUNTIMES`、`SCRIPT_MEMORY_LIMIT=512` 上界）：本轮只开 1 图。

测量干扰（透明记账）：① 3 轮 RSS 的第 29 样本前后我跑过一次 `docker exec printenv` 探测（4 容器各一个瞬时 `sh`，<1 s），
表现为部分容器 `pids` 出现 `8/16`、`12/20`、`19/27` 两种值——**较低值是健康检查子 shell 的常态抖动，均值/min 不受影响**；
② 01:00–01:20 我对 creator 做了 import/publish/exportPlayBundle，其 page cache 让 creator 的 `docker stats` 从 98.8→219.5 MiB、`cur` 从 117.7→300.3 MiB（`anon` 仅 84.3→91.1），
所以**同刻对照表里出厂那一列在 01:18–01:20 不可信**，我以 00:51–01:00 的 3 轮熟态数为权威值；
③ 同一 WSL 里常驻 `mysqld` RSS ≈ 399 MB、`dockerd` 111 MB、`containerd` 77 MB，均与 box 栈无关（`c6-17` §[d]），解释 `free` 的 used≈1757 MB 的大头。

## 7. 现场终态与隧道持久性（01:24，uptime=6868 s）

```
$ docker ps → 11 个全部 healthy：box3-lite-*「Up 6 minutes」（被我重启 2 次）、box-local-engine-*「Up 2 hours」（现网未重启过，0 次）
creator 工程列表 = cloud-3a043df55e5057a5-imported / cloud-4e84ee7ef626058f-imported / cloud-4e84ee7ef626058f-imported-2(我新增) / yunhai-xiantu
出厂 play  /api/play-worlds → 1 张：起床战争 v1.0.1 playEnabled:true（原样）
轻量 play  /api/play-worlds → 2 张：v1.0.1 + demo 1.0.0 playEnabled:true
$ tasklist | grep -i cloudflared → cloudflared.exe 12568 Console 40,508 K   ← 我起的这个进程
$ curl https://box3.cdk.lat/ → http=200 ttfb=1.20 s
$ curl https://box3.cdk.lat/api/play-worlds → 200，内容 = 出厂那张 v1.0.1
```
两点必须说清：
1. **隧道进程是我从本会话后台拉起的（PID 12568，Console 会话）**，它只在**这个会话/这台机器不关机**的前提下持续服务。
   要开机自启得 `cloudflared service install`（会写 Windows 服务 + 复制 config），属系统级变更，**我没做**，交回用户（可与 §5-D1 一起定）。
2. **demo 那张图在轻量栈（4121），而 `box3.cdk.lat` 指向出厂 play（80）** ⇒ 公网访客看到的仍是用户原来那张 v1.0.1。
   想让 demo 走公网，要么把 ingress 就地改成 `http://127.0.0.1:4121`（新增一条 ingress 是我有权做的，但会让 lite 成为公网面），要么在出厂 play 也导入 `.boxplay`（需出厂 owner token，属现网写操作）。两者都不在"最小动作"里，**留给用户选**。

## 8. 可复跑命令（本文所有数字的入口）

```bash
# 3 轮 ×12 样本空闲 RSS（约 9 分钟，需独占 WSL）
wsl -d Ubuntu-24.04 -- bash -lc 'cat > /tmp/c6-rss.sh' < box3-re/tmp/c6-rss.sh
wsl -d Ubuntu-24.04 -- bash -lc 'bash /tmp/c6-rss.sh'                      # 原文 → tmp/c6-04-idle-rss-3rounds.txt
python box3-re/tmp/c6-rss-stats.py                                          # 统计 → tmp/c6-10-idle-rss-stats.txt

# 静态清单 / 归档字节 / root 进程 / TTFB / du /app / 镜像 content
wsl -d Ubuntu-24.04 -- bash -lc 'bash /tmp/c6-static.sh'    # tmp/c6-07
wsl -d Ubuntu-24.04 -- bash -lc 'bash /tmp/c6-m1.sh'        # tmp/c6-16
wsl -d Ubuntu-24.04 -- bash -lc 'bash /tmp/c6-m2.sh'        # tmp/c6-17
wsl -d Ubuntu-24.04 -- bash -lc 'bash /tmp/c6-m4.sh'        # tmp/c6-19（含 stop→start→healthy 计时）
wsl -d Ubuntu-24.04 -- bash -lc 'bash /tmp/c6-m5.sh'        # tmp/c6-21（监督进程取证）
wsl -d Ubuntu-24.04 -- bash -lc 'bash /tmp/c6-m6.sh'        # tmp/c6-22（内存预算日志 grep）
wsl -d Ubuntu-24.04 -- bash -lc 'bash /tmp/c6-w5.sh'        # tmp/c6-20（tools/w5-launchcost.sh 落盘）

# demo 导入链
wsl -d Ubuntu-24.04 -- bash -lc 'bash /tmp/c6-import-pre.sh'   # tmp/c6-09 快照+端点探针
wsl -d Ubuntu-24.04 -- bash -lc 'bash /tmp/c6-import.sh'       # tmp/c6-11 导入
wsl -d Ubuntu-24.04 -- bash -lc 'bash /tmp/c6-verify.sh'       # tmp/c6-12 回归复核 + compat-check
wsl -d Ubuntu-24.04 -- bash -lc 'bash /tmp/c6-playA.sh'        # tmp/c6-13 publish→bundle→lite 导入→开放
wsl -d Ubuntu-24.04 -- bash -lc 'bash /tmp/c6-playC.sh'        # tmp/c6-15 进图 + 每图 RSS
wsl -d Ubuntu-24.04 -- bash -lc 'bash /tmp/c6-m3.sh'           # tmp/c6-18 二次冷启动（注：脚本里 DONE 计时有 bug，以 c6-19 为准）

# 隧道
"C:/Program Files (x86)/cloudflared/cloudflared" tunnel --config "$USERPROFILE/.cloudflared/config.yml" run
curl -sSI https://box3.cdk.lat ; curl -sS https://box3.cdk.lat/api/play-worlds
```
