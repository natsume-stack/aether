# BOX3 本地引擎轻量化改造 —— 任务交接文档

交接时间：2026-10-17 21:10
交接人：上一轮会话主控 agent（本文里 ✅ 标记 = 本轮我亲自跑出来的；📄 = 继承自泳道文档，数字为该泳道实测原文，但未由我复算）

---

## 0. 一句话定位

**分析阶段 100% 完成，实施阶段完成约 60% 代码 / 25% 验证。**
分支 `slim/local-deploy` 工作区里有 **20 项未提交改动**（10 个文件被改 + 10 个新文件，`642 insertions(+), 51 deletions(-)`），其中只有 W3、W4 两条泳道留下了带实测数字的交付文档；W1/W2/W5/W6 的代码已在树里但**没有交付文档、没有测量记录**。
本轮已**冻结 6 条泳道契约并建好 6 个任务，但一个 agent 都还没派出**（用户在派出前打断）。

---

## 1. 环境与资产地图

| 路径 | 内容 | 权限 |
| --- | --- | --- |
| `D:\desktop\神奇代码岛\box3-local-engine` | 官方源码克隆，tag `v2026.1.4`（commit `a35455d814`，MIT），当前在分支 `slim/local-deploy`，**工作区未提交** | 可改（按泳道所有权） |
| `D:\desktop\神奇代码岛\box3-re\ANALYSIS-AND-PLAN.md` | 终稿：结论、基线、诊断、P0/P1/P2 计划、G1–G7 验收门 | 可改（追加/修正） |
| `box3-re\{A-docs,B-size-audit,C-architecture,E-runtime-baseline,F-release-diff}.md` | 取证文档 | 只读参考 |
| `box3-re\src\S{1,2,6,7,8}-*.md` | 白盒源码取证（产物流水线/运行时热路径/脚本契约/云原生对标/客户端字节与拓扑） | 只读参考 |
| `box3-re\impl\W3-fonts-and-prod-deps.md`、`impl\W4-play-lite-package.md` | 仅有的两条已完成泳道交付文档 | W3/W4 泳道续写 |
| `box3-re\poc\` | P2 生死判定的 PoC：`out-poc1..4*.txt` + `poc{1..4}-*.mjs` + `raw3/` | 可续跑 |
| `box3-re\tools\` | 40 个脚本：`baseline.sh`（可复跑基线）、`eq-pruned-boot.sh`、`eq2-play-tree-prune.sh`（**已写未跑**）、`w1..w5-*`、`upgrade-inplace-2026.1.4.sh`、`tag-images-2026.1.4.sh` | 可跑 |
| `box3-re\_manifest\BOX3-IMAGE-CATALOG.json` | 6 镜像 gz 字节 + sha256 + imageIds（体积主张的权威来源） | 只读 |
| WSL2 `Ubuntu-24.04`，Docker 29.1.3 ✅ | 现网 7 容器 `box-local-engine-*`（用户真实数据）+ 测试栈 3 容器 `box3-lite-*`；本轮 21:05 观察到两者都在 `health: starting`（WSL 刚重启） | 现网**只读** |
| `C:\Users\Natsume\.wslconfig` ✅ | 已改为 `memory=8GB processors=8 swap=4GB swapFile=D:\WSL\swap.vhdx autoMemoryReclaim=gradual`；备份 `.wslconfig.bak-20261017-2028` | 谨慎 |
| WSL 内测量基底 | `/var/tmp/re-arch`（428 MB 出厂 `/app` 真实副本）、`/var/tmp/w3/standalone`、`/var/tmp/w4-data`、`/var/tmp/w4-play-lite` ✅ 存在；`/var/tmp/eq2` **不存在 → eq2 从未跑过** ✅ | — |

**WSL 内存上限已实际生效**：`/proc/meminfo` `MemTotal: 8132228 kB ≈ 7.76 GiB` ✅（12GB 时会是 ~12.3M kB），`nproc=8`。

外部信息获取路径见项目记忆 [[reference-box3-release]]（`latest.txt`、CDN、GitHub 需走 `127.0.0.1:7890` 代理、归档缺版本 tag、`COMPOSE_PROFILES` 必须含 `desktop-postgres`）。

---

## 2. 已完成（有实测数字）

### 2.1 分析基线（G0 之前的地基）📄
- 空闲整栈 RSS **313.67 MiB**、TTFB 中位 **6.9 ms**；`vmmem` 宿主实收 **5.3–6.1 GB**
- 分发 **1,060,646,139 B = 1011.5 MiB gz**（6 归档）；`docker load` 后 content **2.74 GB**；`/app` 398 MB
- 跨镜像字节重复 **613 MB**；单镜像 39%（≈154 MB）是构建期工具
- 7 常驻容器 / 9 宿主端口 / 19 进程；每图 3 进程、增量 RSS 150–200 MB
- 作者契约面：**服务端 398 个可调用、客户端声明面 32 个**
- 升级到 v2026.1.4 已完成并验证（7/7 healthy、数据 4983 文件逐字节一致、回滚快照在 WSL `/root/box3/upgrade-snapshot-20261017-192455/`）

### 2.2 W4 play-lite：3 容器无特权开服包 —— **已真实跑起来** 📄（文档内含命令原文输出）
| 指标 | 出厂 | play-lite |
| --- | --- | --- |
| 常驻容器 | 7 | **3** |
| 宿主端口 | 9（含 `0.0.0.0:3130`） | **3，全 127.0.0.1** |
| 挂 `docker.sock` / 常驻 `user:"0:0"` | 1 / 1 | **0 / 0** |
| 空闲合计 RSS | 同刻实测 328.05 MiB | **156.88 MiB（−52.2%）** |
| 分发 gz | 1,011.5 MiB | **423.8 MiB（−58.1%）** |

功能链已通：`/api/health-check` ok、真实地图「起床战争」`/api/play-worlds` 200、带玩家 Cookie 的 `/p/<publicId>` **200 / 149,594 B**、`createSession` 200 且**地图运行时以 UID 1000 的普通 Node 子进程跑起、没有创建任何容器**（这就是"server-manager + docker.sock 可整块拿掉"的直接证据）。WSL 被意外重启一次后两套栈都自愈，账号 `loginCount` 跨重启累加。

### 2.3 P0 代码已落进工作区 ✅（`git status` 实测）
新增：`scripts/prune-standalone.mjs`(935 行)、`scripts/check-image-budget.mjs`(621)、`scripts/lib/budget.mjs`(320)、`scripts/subset-fonts.mjs`(359)、`apps/local-engine/src/runtime-memory.mjs`(401)、`scripts/tag-images-from-catalog.mjs`(268)、`common/config/box3-image-blacklist.json`(106)、`box3-image-budget.json`(74)、`scripts/font-manifest.json`、`distribution/play-lite/`（3 文件）
改动：`launcher.js`(+81，内存预算改实测)、`build.js`(+7，删 `.next/server/chunks/static` 字体第二副本)、`services/game-server/package.json`(typescript→devDeps)、`install.sh`×3 + `bootstrap.sh`、`release_channel.rs`(+261)、`build-image-downloads.js`(+125)、`release-context.js`(+32)、`tauri.conf.json`

### 2.4 W3 字体/prod 依赖（部分实测）📄
- `typescript` 运行时 0 命中证据链完整（源码/dist/整个 node_modules/`@box/*` 五路 grep 全 0），挪 devDep 安全性有证据
- 字体第二副本删除在 `/var/tmp/w3/standalone` 上实测
- **镜像端 19.5 MB 移除 = UNVERIFIED**（需 6 个包同改 + re-lock + 重建镜像）
- 出厂镜像里 `typescript@5.6.3` 实测 **19,492,846 B**

### 2.5 P2 PoC 已跑完，结论未落盘 ✅（我本轮读了 `out-poc3-sweep.txt`、`out-poc4.txt` 原文）
isolate 池（每图 1 进程）**两项硬指标都不合格**：

**CPU 公平性**（16 isolate，async，被殃及者的最差 p99）：
| 配置 | victim worst_during_p99 | 主循环 p50/p99/max (ms) |
| --- | --- | --- |
| H=0（无挂死） | **6.25 ms** | 20.19 / 22.48 / 25.56 |
| N16 H=1 | **127.28 ms** | 20.61 / 96.21 / 224.79 |
| N16 H=4 | **57.8 ms** | 20.37 / 46.2 / 110.89 |
| N32 H=8 | **152.8 ms** | 20.32 / 86.84 / 108.27 |

计划书定的门是"抖动 >20 ms 就放弃 isolate 池"→ **一个挂死 isolate 就把同伴的 tick 从 6.25 ms 打到 57.8~152.8 ms，全部超门 3~7 倍**。
（H=1 反而比 H=4 差：127.28 > 57.8，非单调 → **待证，需复测确认采样窗口**。）

**崩溃半径与内存**（`out-poc4.txt`）：
- 顶层未捕获异常：主机存活、4/4 兄弟健康、同 isolate 仍可用（56.6 MB）→ 隔离性合格
- 单次 OOM：抛 `Array buffer allocation failed`，兄弟 4/4 健康，RSS 峰值 592.3 MB，dispose 后回收 **537.9 MB** → 合格
- **4 个 isolate 并发 OOM：峰值 HWM 2200.7 MB，dispose 后 RSS 仍 2173.6 MB（只回落 ~27 MB）** → 不合格，且这远低于 play 容器 4 GiB 限额，属"抬上去就下不来"
- 注意 `isolateV8Heap_MB: 0.7`：爆掉的是 V8 堆外的 Array buffer，`isolate.getHeapSizeSync()` 看不到它 → 用 heap 采样做内存闭环的方案对它无效

**→ P2 决策：否决 isolate 池 / 每图单进程化。** 现有 ivmp（每图独立进程）模型的隔离性正是本质复杂度，呼应"换语言/换架构省不掉 74%"。
P2 剩余可做的只有两项低风险：删 creator 监督进程、冷启动去同步 IO。

---

## 3. 未完成 / 待证（按优先级）

### P0
1. **`prune-standalone.mjs` 从未做过等价性验证** ✅（`/var/tmp/eq2` 不存在，测试脚本 `tools/eq2-play-tree-prune.sh` 已写好待跑）。这是 154 MB/镜像 这一最大单项收益的地基。
2. **CI 体积门没接线** ✅：`.github/workflows/verify.yml` 里 grep `budget|check-image|size` **零命中**，门仍然只是 `check-image-budget.mjs` 一个孤立脚本；且新脚本一个 `.test.js` 都没有（仓库有 `scripts/*.test.js` 惯例，如 `build-image-downloads.test.js`）。
3. **re-lock 阻塞（最危险的隐性依赖）** 📄：`services/game-server/package.json` 改了 prod/dev，但 `common/config/rush/pnpm-lock.yaml` **未改**。在 re-lock 前，任何跑 `rush install` 的构建（含 Docker builder 阶段）都会红 → **所有"重建镜像实测体积"的 G1 主张都被这条卡住**。需要联网环境执行 `node common/scripts/install-run-rush.js update --to @box/game-server`。
4. **6 个包仍把 typescript 声明在 dependencies** 📄（`internals/{build-system,schema,env,vb}`、`packages/{utils,content-server}` 的 `package.json`），W3 无权改，证据链已备好。
5. 分发/content/`/app` 三项目标值（≤550 MiB / ≤1.4 GB / ≈190 MB）**全部 UNVERIFIED**，一次都没重建过镜像。

### P1
6. **play-lite 缺登录门户**：`authorizePlayerAuthRequest()` 强制 `x-box-player-auth-key`（实测 401/503），浏览器拿不到该密钥 → 真实玩家无法自助注册。必须加回 `player-auth-portal`（+86,925,875 B gz）。
7. **主 `docker-compose.yml` 未改** 📄：W4 指出根因在 `play` 的 `BOX_RUNTIME_MANAGER_URL: ${...:-http://server-manager:3130}` + `depends_on: server-manager: service_healthy`；改这里能让主 compose 自己出 lite 形态，play-lite 退化为薄壳。W4/W6 都建议优先走这条，未做。
8. **离线自托管链（W6）未验证**：`install.sh`×3 / `bootstrap.sh` / `release_channel.rs`(+261) / `build-image-downloads.js`(+125) 全在工作区，没有 `bash -n`、没有 `node --check`、没有 `cargo check` 记录，**G6 完全没跑过**。
9. **供应链（G7）**：digest 钉死 / SBOM / cosign attest 一条都没有。
10. **HTTPS 反代、`pg_dump` 备份**：文档已声明必须补，未做。

### P2
11. **creator 递归监督进程仍在** ✅：`launcher.js:1091` 至今还在 spawn `--runtime-only` 子进程。省 56 MB/图 + 0.4~3 s/图 未动。
12. **`runtime-memory.mjs` 实测预算未验证**：+81 行改动写完了，但没有一条运行日志证明它在容器里算出了什么数、与三层旧上限（voxel 阶梯 / `mem_limit` / `--max-old-space-size`）对齐没有。`tools/w5-launchcost.sh` 是最后一个动作，输出没落盘。
13. 冷启动同步 IO（`spawnSync tar` 全工程快照、blob 全量 link、`Atomics.wait` 自旋锁）未动。
14. 健康检查进程内化（`node -e fetch` / docker CLI shell）未动。

### 全局缺口
15. **W1/W2/W5/W6 四条泳道没有交付文档**（`impl/` 下只有 W3、W4）。
16. **没有 G1–G7 记分板**，无法一眼看出"哪些数字已实测、哪些是承诺"。
17. **20 项改动全部未提交**，一次误操作 `git checkout .` 就全丢（本轮我按纪律没有 commit/push）。

---

## 4. 已冻结的泳道契约（所有权互不重叠，直接可用）

| ID | 泳道 | 独占文件（只这些可写） | 资源约束 | 交付物 |
| --- | --- | --- | --- | --- |
| A1 | 离线/自托管核验 | `distribution/linux-amd64/install.sh`、`distribution/server/{bootstrap.sh,install.sh}`、`scripts/build-image-downloads.js`、`scripts/release-context.js`、`apps/manager-core/src/release_channel.rs`、`apps/deployment-manager/src-tauri/tauri.conf.json` | **禁用 Docker**（纯静态/CPU） | `box3-re/impl/W6-offline-selfhost.md` |
| A2 | CI 体积门 | `scripts/check-image-budget.mjs`、`scripts/lib/budget.mjs`、`common/config/box3-image-{blacklist,budget}.json`、`.github/workflows/verify.yml`、新增 `scripts/check-image-budget.test.js` | CPU | `impl/W2-ci-size-gate.md` + 红/绿各一次自测原文 |
| A3 | play-lite 补门户 | `distribution/play-lite/{compose.yml,.env.example,README.md}` | WSL，**只碰 `box3-lite-*`**；本轮只报结构事实（config OK/healthy/http 码），RSS 留到串行轮 | 续写 `impl/W4-play-lite-package.md` §6 |
| A4 | prune 等价与字节 | `scripts/prune-standalone.mjs` | WSL，**只建临时 `e2-*` 容器**，现网只读 | `impl/P0-prune-standalone.md`，实测字节 + G1 推算 |
| A5 | 删监督进程 | `apps/local-engine/src/launcher.js` | CPU（**不得回退已有的 +81 内存预算改动**） | `impl/P2-1-supervisor-removal.md`，56 MB/图 标待证 |
| A6 | 门记分板 + PoC 结论落盘 | `box3-re/impl/GATES.md`、修正 `ANALYSIS-AND-PLAN.md` §4.2 的 isolate 池主张 | 源码只读 | 记分板 + PoC 决策文档 |

**红线（每个 agent 必须遵守）**
- 现网 `box-local-engine-*` 7 容器与其卷、`/root/box3/**` 用户数据：只读。禁止 `stop/restart/rm/prune/volume rm/compose down`。
- 禁止 `git commit` / `git push` / 任何改远程的动作（除非用户明确要求）。
- 禁止 `--pull`、禁止访问 docker.io（离线镜像已在本地，版本 tag 已按 catalog 补齐）。
- 不改 `docker-compose.yml`、不改 `BOX3-IMAGE-CATALOG.json`、不改 `pnpm-lock.yaml`（共享配置，re-lock 需联网且属用户决策）。
- RSS / TTFB / 冷启动时间这类**对负载敏感的数字，一次只允许一条泳道测**；有其它 agent 在用 Docker 时，只报结构事实。
- 每条主张必须附可复跑命令与原文输出；没有就跑出来，跑不出来写 `UNVERIFIED`。

---

## 5. 建议的执行顺序

**第 1 批（并行 6 个 agent，A1/A2/A5/A6 无 Docker，A3/A4 用互不重叠的栈）** —— 即上一轮冻结的契约，任务 ID #1–#6 已在任务列表里（状态仍 pending）。

**第 2 批（串行，独占 WSL 做测量）**：
1. `tools/eq2-play-tree-prune.sh` 复跑（若第 1 批 A4 修过规则）
2. `tools/baseline.sh` + lite 栈空闲 RSS 复测（无其它负载时，连续 3 轮 12×10s）
3. A5 的 56 MB/图 实测（creator 路径改前/改后各起一张图）
4. `tools/w5-launchcost.sh` 落盘 W5 的预算日志
5. 联网 + re-lock + 重建 1 个镜像（play）→ 才能出 G1 的真数

**第 3 批**：主 compose 出 lite 形态（#7）、真离线安装演练（G6）、SBOM/签名（G7）。

---

## 6. 坑清单（都会咬人）

1. **镜像归档没有版本 tag**：出厂归档只有 `launcher-content-<imageId>`，compose 引用的 `v2026.1.4-linux-amd64` 要自己补 → `tools/tag-images-2026.1.4.sh`。不补就 `up` 会去 docker.io 拉并超时。
2. **`COMPOSE_PROFILES` 必须含 `desktop-postgres`**，否则带 `--remove-orphans` 时内置 Postgres 被回收，而 Player Service 硬依赖 PG（进图会 `map-admission` false）。
3. **WSL 会自己重启**（本轮 21:05 就撞上 uptime 0 min）。跨 `/tmp` 的 cookie jar、`/var/tmp` 临时目录可能丢；`restart: unless-stopped` 会让两套栈自愈，但要等 healthy 再测，否则数字全是预热值。
4. **GitHub 需走宿主代理**：`git -c http.proxy=http://127.0.0.1:7890 ...`；WSL 侧直连不稳。
5. **`isolated-vm@5.0.4` 非 N-API** → 单二进制/Bun 路线永久关闭，别再评估。
6. **内存采样盲区**：作者脚本 OOM 爆的是 V8 堆外的 Array buffer（`isolateV8Heap_MB: 0.7` 时 RSS 592 MB），`getHeapSizeSync()` 和 cgroup 前的 heap 阶梯都看不见它。
7. **`rush install` 会因 package.json 与 lockfile 不一致而红**（第 3 节 #3）。
8. **上游只会加不会减**：v2026.1.4 相比 0.3.0 内存上限砍了但 6/6 镜像字节全涨（+120 MB）。没有 CI 体积门，任何一次升级都会吃掉瘦身成果。

---

## 7. 需要用户回答的开放问题（别替用户臆造）

1. **两条"下版本新需求"原文仍未传达**（W4 文档 §10 记录了这条提示）。缺原文，任何据此的范围调整都是猜。
2. **是否允许联网 + `rush update` re-lock + 重建镜像**？这是 G1 全部体积主张的前置条件，成本高、且会改 `pnpm-lock.yaml`。
3. **是否把 20 项未提交改动 checkpoint commit 到 `slim/local-deploy`**（不 push）？现在有整轮工作丢失的风险。
4. **是否把 play-lite 定为交付主线**（即正式放弃 server-manager 与容器隔离），还是保留双形态？
5. isolate 池已被实测否决 —— 确认后我把 `ANALYSIS-AND-PLAN.md` §4.2 的 B 选项与 P2 表格改成"已否决（附数据）"。

---

## 8. 给下一个 AI 的交接提示词

（下面这段可整块粘贴。它自带全部上下文与纪律，不依赖本会话记忆。）

```text
你是接手 BOX3 本地引擎轻量化改造的主控 agent。工作目录 D:\desktop\神奇代码岛。

【先读，别先做】
1. D:\desktop\神奇代码岛\box3-re\HANDOVER.md —— 本交接文档，含资产地图、已完成/待证、泳道契约与坑清单。
2. box3-re\ANALYSIS-AND-PLAN.md —— 方向、基线数字、P0/P1/P2 计划、G1–G7 验收门。
需要细节再读 box3-re\impl\W3/W4 交付文档与 box3-re\src\S*.md 取证。

【处境】
- 引擎 v2026.1.4 起 MIT 全量开源，已排除逆向；路线是白盒 fork-and-slim，不重写。
- 源码在 box3-local-engine\，分支 slim/local-deploy，工作区有 20 项未提交改动（10 改 + 10 新）。
- 已完成且有实测数字：升级到 2026.1.4、W4 play-lite（3 容器/3 端口/零特权，空闲 RSS 156.88 MiB −52.2%，分发 423.8 MiB −58.1%，真实地图进图链已通）、W3 部分。
- P2 的 isolate 池 PoC 已跑完：16 isolate 中 1 个挂死 → 同伴 tick p99 从 6.25 ms 恶化到 127.28 ms（4 挂死 57.8 ms、32/8 组合 152.8 ms），门是 20 ms；4 isolate 并发 OOM → 峰值 2200.7 MB、dispose 后残留 2173.6 MB 不回落。结论：否决单进程 isolate 池，只保留"删 creator 监督进程"和"冷启动去同步 IO"。
- 最大未验证项：prune-standalone.mjs（对应 154 MB/镜像 这一最大单项收益）从未做过等价性验证，测试脚本 box3-re\tools\eq2-play-tree-prune.sh 已写好但没跑（WSL 里 /var/tmp/eq2 不存在即为证据）。
- 隐性阻塞：package.json 改了 prod/dev 但 pnpm-lock.yaml 没改 → 任何 rush install / Docker builder 都会红，G1 的体积数字全部被卡在这里。

【本轮任务：并行派 6 个 agent，严格按下述所有权，不得越界】
A1 离线/自托管核验：只可写 distribution/linux-amd64/install.sh、distribution/server/{bootstrap.sh,install.sh}、scripts/build-image-downloads.js、scripts/release-context.js、apps/manager-core/src/release_channel.rs、apps/deployment-manager/src-tauri/tauri.conf.json。跑 bash -n / node --check / cargo check，列出 G6/G7 真实缺口（path:line），写 box3-re\impl\W6-offline-selfhost.md。禁用 Docker。
A2 CI 体积门：只可写 scripts/check-image-budget.mjs、scripts/lib/budget.mjs、common/config/box3-image-{blacklist,budget}.json、.github/workflows/verify.yml，并按仓库 scripts/*.test.js 惯例补一个测试。必须演示"红/绿各一次"：构造超预算与含黑名单构建工具的输入证明门会 fail。写 impl\W2-ci-size-gate.md。
A3 play-lite 补登录门户：只可写 distribution/play-lite/*。把 player-auth-portal 加回（+86,925,875 B gz），保持无 docker.sock、无常驻 root、全 127.0.0.1。用 WSL 验证 compose config OK、全栈 healthy、带密钥注册→登录→/p/<publicId> 200。本轮只报结构事实，不报 RSS。续写 impl\W4-play-lite-package.md 的缺口章节。
A4 prune 等价与字节：只可写 scripts/prune-standalone.mjs。在 WSL 跑 box3-re\tools\eq2-play-tree-prune.sh，取"裁剪字节数 + control 与 pruned 启动等价 + 响应字节校验和一致 + MODULE_NOT_FOUND 计数"。不等价就修规则并复跑，直到等价或给出"该块不可裁"的证据。写 impl\P0-prune-standalone.md，据此推算 G1。不做任何 RSS 主张。
A5 删 creator 递归监督进程：只可写 apps/local-engine/src/launcher.js（该文件已有 +81 行实测内存预算改动，绝对不要回退它）。依据 impl 与 src 文档里 launcher.js:1024 监督路径 vs :911-983 play 直起路径的取证，把 creator 改为直起 game-server，保持端口试探、环境变量、健康检查语义。node --check + 最小启动桩验证；"省 56 MB/图"本轮标待证。写 impl\P2-1-supervisor-removal.md。
A6 记分板与决策落盘：只读源码，写 box3-re\impl\GATES.md（G1–G7 × 每条改动 = 已实测[附原文数字与来源文件]/部分/待证/未开工），并把上面 PoC 结论写进文档、修正 ANALYSIS-AND-PLAN.md §4.2 里 isolate 池的主张。

【纪律，违反即返工】
- 现网 7 个 box-local-engine-* 容器、/root/box3/** 用户数据、WSL 回滚快照：只读。禁止 stop/restart/rm/prune/compose down、禁止 --pull、禁止访问 docker.io。
- 禁止 git commit/push 与任何改远程的动作，除非用户明确要求。
- 不改主 docker-compose.yml、不改 BOX3-IMAGE-CATALOG.json、不改 pnpm-lock.yaml（这三处是共享配置或需联网决策）。
- 只报你自己跑出来的数字，并附可复跑命令与原文输出；转述、估算、"应该能省"一律不许。没验的一律写 UNVERIFIED 或 待证。疑似缺陷照实标注，不要悄悄修或掩盖。
- RSS / TTFB / 冷启动等对负载敏感的指标一次只允许一条泳道测；其它泳道在用 Docker 时只报结构事实。
- 非必要不新增文件；改动属于共享校验链路时，建议拆分而不是新建触碰共享配置的文件。
- 速度是硬要求：先用已在本地的镜像和数据取证，不要为了拿一个数字去做多分钟的联网或重建；需要重建类操作先问用户。
- WSL2 Ubuntu-24.04，Docker 29.1.3，.wslconfig 现为 memory=8GB processors=8。WSL 可能自行重启，动手前先确认容器都 healthy（health: starting 时的数字全是预热值，不可用）。
- 坑：镜像归档无版本 tag（用 tools\tag-images-2026.1.4.sh 补）；COMPOSE_PROFILES 必须含 desktop-postgres 否则内置 PG 被回收；isolated-vm 非 N-API，单二进制/Bun 路线永久关闭；Array buffer OOM 不进 V8 heap，heap 采样看不见。

【交付给我】
1. 6 条泳道各自的交付文档路径 + 一句话结论 + 关键实测数字（含原文命令输出）。
2. 更新后的 GATES.md 记分板：哪些门已过、哪些还差什么。
3. 明确列出需要我/用户决策的事项（已知：两条未传达的新需求；是否联网 re-lock 并重建镜像以解锁 G1；是否 checkpoint commit；是否把 play-lite 定为交付主线）。
4. 下一轮串行测量清单（eq2 复跑、lite 空闲 RSS 复测、56 MB/图 实测、W5 预算日志落盘）。
```
