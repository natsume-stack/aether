# BOX3 本地引擎（轻量改造 fork）

当前源码版本：`2026.1.4` ｜ 许可证：[MIT](LICENSE.md) ｜ 分支：`slim/local-deploy`
基线：`box3lab/box3-local-engine` v2026.1.4（上游提交 `a35455d814`）。本仓是 **fork-and-slim 改造版**，不是独立实现，改动全部基于官方开源源码白盒进行，不含逆向产物。

## 这是什么

引擎能力与上游一致：浏览器创作（Creator / ARENA）、模型与皮肤（VOXA）、发布与多人游玩（Play）、玩家账号与登录门户（player-auth-portal）、PostgreSQL 持久化，服务以 Docker 运行。

本 fork 只改三类东西：

1. **交付形态**——出厂是「7 常驻容器 / 9 宿主端口 / 1 个挂 `docker.sock` 的常驻 root 进程 / 1011.5 MiB 分发」；本仓提供 4 容器、4 端口全回环、零特权的轻量开服包 `distribution/play-lite/`。
2. **打包纪律**——构建期裁剪器、CI 体积回归门、字体清单，用来拦住"上游每次升级只会加字节"这件事（v0.3.0 → v2026.1.4 六个镜像 content 合计 +120 MB）。
3. **离线与自建镜像**——发布通道改成可显式 opt-in 的内网基址（`apps/manager-core/src/release_channel.rs`、`distribution/{linux-amd64,server}/install.sh`、`scripts/build-image-downloads.js`、`scripts/tag-images-from-catalog.mjs`）。**该链路端到端断网演练 0 次**，见下。

一条硬前置贯穿全部改动：**优化之后现有地图必须照常运行、功能不得异常**。判据是可执行回归闸（见「兼容性闸」），不是口头承诺。

## 与原版差异（实测）

测量条件：2026-10-18 00:44–01:21，同一台 WSL（Ubuntu-24.04 + Docker 29.1.3，`.wslconfig memory=8GB processors=8`），出厂 7 容器与轻量 4 容器**同时在跑**、连续 3 轮 12×10 s 采样（容器已连续运行 80–90 分钟的熟态空闲，非预热值）。原文与逐条复跑命令见改造资产工作副本的串行独占测量轮报告（`scan/O6-benchmark-comparison.md`，正在同步进 `slim/`；门状态汇总在 [slim/impl/GATES.md](slim/impl/GATES.md)）。

| 维度 | 出厂 | 轻量 play-lite | 差 | 口径 |
| --- | --- | --- | --- | --- |
| 常驻容器 | 7 | 4 | −43% | `docker ps`；另有 3 / 1 个一次性 `*-storage-init` |
| 宿主端口 | 9（含 `0.0.0.0:3130`） | 4，全部 `127.0.0.1` | −56%，0 条对外网卡 | `ss -ltnp` |
| 挂 `/var/run/docker.sock` | 1 个容器 | 0 | 归零 | `docker inspect` |
| 常驻 root 进程 | 2 | 0 | 归零 | 进程 uid |
| 分发 | 1,060,646,139 B（6 归档） | 531,307,786 B（3 归档） | **−49.9%** | gz；`slim/_manifest/BOX3-IMAGE-CATALOG.json` 的 `size` 字段 |
| `docker load` 后 content | 2,736,210,446 B | 1,358,827,262 B | **−50.3%** | `docker image inspect .Size` |
| `du -sb /app` 合计 | 1,835,711,422 B | 665,615,084 B | **−63.7%** | 容器内实测；轻量列含 2 张图 |
| 空闲 RSS | 376.14 MiB | 258.74 MiB | **−31.2%** | `docker stats`（memory.current − inactive_file），36 样本均值 |
| 空闲 RSS（anon） | 284.14 MiB | 166.38 MiB | **−41.4%** | cgroup `anon`（去掉可回收 page cache 的真常驻） |
| 接口 TTFB 中位 | play 3.2 ms | play 3.1 ms | **基本持平** | `/api/health-check`，20 样本；瘦身没有让接口变快，也不宣称变快 |
| 每开 1 张图 | — | 进程 **+2**、anon **+146.4 MiB**（Pss +152.6） | 负向/成本项 | 轻量栈 idle 3 进程 → 起图 5 进程 |

三条必须一起读的结论，否则上表会被误读：

- **收益几乎全部来自"少跑 3 个服务"（creator / voxa / server-manager），不是"同一个服务变轻"**。逐容器对比时轻量侧的 play/ps/portal/postgres 与出厂同名服务几乎相等，个别 `docker stats` 口径下甚至更高（可回收 page cache，其内存限额也更宽）。
- **单个容器的 `/app` 没有变小**：轻量 play 402,098,657 B > 出厂 play 373,668,042 B（含 2 张图）。`−63.7%` 是"合计"口径。
- **表中所有"轻量"数字都是镜像未重建的现网归档形态**（复用的是官方 3 个归档），本仓的构建期裁剪与依赖改动**尚未进任何运行态镜像**。

## 怎么起

### A. 轻量开服包（只要玩家能进图开玩）

4 容器：Play + Player Service + 登录门户 + PostgreSQL。不需要源码、不需要 Node.js，加地图不重建镜像。完整说明与变量表见 [distribution/play-lite/README.md](distribution/play-lite/README.md)。

```sh
cd distribution/play-lite
cp .env.example .env                    # 必填三个秘密，用 openssl rand -hex 32 生成
# 官方逐服务归档命名：box-local-engine-image-<service>-<arch>-<sha>.tar.gz
docker load -i box-local-engine-image-play-*.tar.gz
docker load -i box-local-engine-image-player-service-*.tar.gz
docker load -i box-local-engine-image-player-auth-portal-*.tar.gz
node ../../scripts/tag-images-from-catalog.mjs --catalog ../../slim/_manifest/BOX3-IMAGE-CATALOG.json
# 数据库镜像不在这三个归档里：postgres:16-alpine 需另行准备（compose 默认走 daocloud mirror 拉取）
docker compose up -d
```

`tag-images-from-catalog.mjs` 是离线部署的第一个坑的补丁：官方归档 `docker load` 后只有 `launcher-content-<imageId>` tag，而 compose 引用 `v<版本>-linux-<架构>`，缺 tag 时 Docker 会去 docker.io 拉一个不存在的镜像并超时。

起来后：Play `http://127.0.0.1:4121/`、门户 `:4125`（自助注册/登录）、玩家后台 `:4124/players`、PostgreSQL `127.0.0.1:4132`。全栈到 4 个 healthy 实测 **12.79 s**。

### B. 出厂全栈（需要创作 / 模型 / 容器隔离）

根 `docker-compose.yml` 里**每个服务都挂在 profile 后面**（`creator`、`play`、`voxa`、`player-service`、`auth-portal`、`desktop-postgres`、`desktop-redis`、`infra`），而 `.env.docker.example` **不含 `COMPOSE_PROFILES`** → 直接 `up -d` 一个服务都不会起。

```sh
cp .env.docker.example .env
# .env 里至少补：
#   COMPOSE_PROFILES=creator,play,voxa,player-service,auth-portal,desktop-postgres
#   BOX_IMAGE_TAG=<已 load 的镜像 tag>
docker compose --env-file .env up -d
```

`server-manager` 故意不设 profile（creator 的每图运行时调度依赖它），所以只要起 creator 就会带出这个**挂 `docker.sock`、常驻 root、默认发布到 `0.0.0.0:3130`** 的边车——同一局域网任何设备都能打管理面，并可经 socket 提权到宿主。自用请改回环绑定，或直接用形态 A。

镜像来源：官方逐服务归档 `docker load` 后只有 `launcher-content-<imageId>` tag，需要 `scripts/tag-images-from-catalog.mjs` 补版本 tag（同形态 A）。

### C. 源码开发

Node.js `22.17.x`，提前启动 Docker；工作区由 Rush 管理。

```sh
npm run install:all
cp .env.docker.example .env
npm run check:workspace
npm run dev:infra
```

常用入口：Creator `127.0.0.1:3127`、Play `127.0.0.1:3121`、VOXA `:3123`、门户 `:3125`、玩家后台 `:8000`。开发数据统一落在仓库根 `.local-data/`（Git 与镜像构建均忽略）。提交前跑 `npm run verify`（格式 + 语法 + 风格；注意 `verify` 目前因 `pnpm-lock.yaml` 与 `package.json` 不同步而红，见下）。详见 [docs/developer-guide.md](docs/developer-guide.md)。

## 当前状态与已知缺口（诚实）

**G1–G9 九个验收门没有任何一门完全通过**，逐门状态与原文数字见 [slim/impl/GATES.md](slim/impl/GATES.md)。已知缺口按严重度：

| 缺口 | 事实 | 影响 |
| --- | --- | --- |
| **轻量形态无法自助导入可编辑地图** | `.boxproject` 的导入端点 `POST /api/local-projects/import` 第一行要求 `BOX_DEPLOYMENT_MODE=creator`（`apps/game/server/creator-api-security.ts:42`），play/lite 侧直接 **404**（实测） | 想进轻量栈必须先导入**出厂 creator**，再走 `publish → .boxplay → POST /api/play-admin/import`（该路由走 `Bearer BOX_PLAY_ADMIN_TOKEN`，lite 实测 201）。这是产品级缺口，不是配置问题 |
| **一次镜像都没重建** | `pnpm-lock.yaml` 与 `package.json` 不一致 → `rush install` 红 → 构建阶段进不去 | 裁剪 88,176,940 B、typescript 出 prod、字体第二副本 −22,949,789 B 等**全部是源码态/树态数字**，镜像端收益 UNVERIFIED |
| **进程模型改动未部署** | 部署镜像内 `/app/apps/local-engine/src/launcher.js` 仍是 34,542 B / 3 行的压缩产物，含 6 处 `--runtime-only` 再入 spawn；`runtime-memory` 模块在镜像里不存在，三个容器全量日志 grep `budget` = **0 条** | "删递归监督进程"与"实测内存预算"**现网收益 0**；旧文档「省 56 MB/图」已被证伪：同类进程 VmRSS 61.9 MiB 但 **Pss 仅 16.4 MiB**，去重口径约 17 MiB/图，高估约 3.4× |
| **兼容闸样本只有 1 张真实图** | 4 个 creator 工程里 3 个 `releases: []` 进不了 play；`map.playWorlds.count = 1`（本轮新增 demo 后为 2） | 单张图压不起"各功能都正常"这句话；L3 层的 `onPlayerJoin` 事件本身仍 **UNVERIFIED**（需一次真实浏览器入局） |
| **离线链端到端 0 次** | 静态核验全绿，但 `bootstrap.sh` 与 `server/install.sh` 的内网镜像 opt-in 口径不一致；`server-manager-rust` 的 `release_base()` 恒返回硬编码 CDN | 断网安装→开服→进图从未一次跑通；SBOM/签名/attestation 全仓 **0 命中** |
| **一条已知构建校验红项** | `scripts/check-standalone.js:1501` 的正则锚定被删的 spawn 参数行 | 处置方案未定；改 launcher argv 形态前必须先改锚 |
| **冷启动大头是同步 tar** | 模块顶层 `spawnSync tar -czf` 全工程快照实测 **0.9–2776 ms**（warm 0.6–1.4 ms），落在请求线程上 | 单图冷启动首见 10.77 s（含迁移与预烘焙）、二次 7.19 s（缓存命中）；引擎自报纯服务端启动 1.40 s / 1.25 s |

已被数据关掉、不再提议的路线：**Node 单进程 isolate 池**（1 个挂死 isolate 把同伴 tick p99 从 6.25 ms 打到 127.28 ms，门 20 ms；4 isolate 并发 OOM 后 RSS 2173.6 MB 不回落）；`isolated-vm@5.0.4` 非 N-API → **单二进制 / Bun 永久关闭**。数据在 `slim/poc/`。

一条不能碰的实测红线：真实地图在 API 对象上挂了 **86 个未声明自定义属性**，另有 55 个声明面被实际调用 → **任何 `freeze`/`seal`/收窄注入都会直接打死老地图**。

## 兼容性闸怎么跑

`slim/tools/compat-check.sh`（56 个基线 key，纯 bash + awk，零依赖）是"优化不得破坏现有地图"的可执行判据，基线在 `slim/baseline/g3-baseline.tsv`。**只支持在 WSL/Linux 内运行**：同一份源码在 Git Bash 的 gawk 5.4.0 与 WSL 的 gawk 5.2.1 下会算出不同的契约指纹，一个换 shell 就换红绿的闸不可信，所以它直接拒绝出结论。

```bash
wsl -d Ubuntu-24.04 -- bash -lc 'bash "/mnt/d/desktop/神奇代码岛/box3-local-engine/slim/tools/compat-check.sh" --quiet'
# 退出码 0=PASS 1=FAIL（真回归 / 检查项被删 / 无基线） 2=PARTIAL（有 N 项因环境未测，不算通过）
```

最近两轮实测：改动合入前 **52 PASS / 0 FAIL**；C6 串行轮导入 demo 图后 **54 PASS / 2 FAIL**——两条红是 `drift.map.projects.count`（3→4）与 `drift.map.scriptBlobs.total`（36→58），即"合法新增一张图"造成的计数漂移，原图逐字节仍 PASS。**这是闸自身的语义缺陷（分不清"新增"与"被改"），已记录未修。**

体积门（阻断上游字节回归）：

```sh
node scripts/check-image-budget.mjs --catalog slim/_manifest/BOX3-IMAGE-CATALOG.json --tier ratchet --require size   # exit 0
node scripts/check-image-budget.mjs --self-test                                                                        # 4 场景必须全 PASS
node --test scripts/check-image-budget.test.js                                                                         # 19 tests
```

`--docker` 档需要本机 `docker image inspect` 才跑得动（CI 里没有镜像，该半边恒 SKIP）。

## 目录导航

| 位置 | 内容 |
| --- | --- |
| [distribution/play-lite/](distribution/play-lite/README.md) | 轻量开服包：compose + env 模板 + 用户向说明 |
| [slim/README.md](slim/README.md) | 改造资产总入口（分析、取证、记分板、工具、基线） |
| [slim/ROADMAP.md](slim/ROADMAP.md) | 总排期与轻量化 / 页面自定义 / AI 接管三条需求的落地路线 |
| [slim/impl/GATES.md](slim/impl/GATES.md) | G1–G9 记分板：每条改动 × 每个门的 实/部/待/未 |
| [slim/tools/](slim/tools/compat-check.sh) ＋ [slim/baseline/](slim/baseline/g3-baseline.tsv) | 兼容性回归闸与基线 |
| [scripts/prune-standalone.mjs](scripts/prune-standalone.mjs) | 构建期 standalone 树裁剪器（默认 dry-run） |
| [scripts/check-image-budget.mjs](scripts/check-image-budget.mjs) ＋ [scripts/lib/budget.mjs](scripts/lib/budget.mjs) | 体积/黑名单两道子门；配置在 `common/config/box3-image-{budget,blacklist}.json` |
| [scripts/subset-fonts.mjs](scripts/subset-fonts.mjs) ＋ [scripts/font-manifest.json](scripts/font-manifest.json) | 字体引用证据链与子集化待办 |
| [scripts/tag-images-from-catalog.mjs](scripts/tag-images-from-catalog.mjs) | 离线部署补打版本 tag（只读 + 追加） |
| [apps/local-engine/src/runtime-memory.mjs](apps/local-engine/src/runtime-memory.mjs) | 实测内存预算（cgroup v2 → v1 → totalmem），替换"按体素数猜上限" |
| [docs/README.md](docs/README.md) | 上游文档索引：[架构](docs/architecture.md)、[测试](docs/testing.md)、[发布与版本](docs/release-and-version.md)、[首个作品](docs/first-project.md) |
| [distribution/server/README.md](distribution/server/README.md) | 上游 Linux 服务器安装与运维 |

## 许可证与来源

本仓沿用上游 [MIT License](LICENSE.md)（Copyright (c) 2026 深圳奇梦岛科技有限公司）。第三方组件、字体、图片、模型和其他资源可能受各自许可约束，不会仅因存放在本仓库中就自动获得 MIT 授权；BOX3 名称、品牌、图标及相关商标不包含在 MIT 授权内。

引擎本体、上游文档与贡献流程遵循 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [docs/code-style.md](docs/code-style.md)；社区贡献统一向上游 `dev` 分支提交 Pull Request。改造侧的全部主张都在 `slim/` 里带原文与复跑命令，未证的显式标注 `UNVERIFIED`。
