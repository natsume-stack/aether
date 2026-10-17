# S1 · 构建与发行产物链（泳道：为什么出厂镜像这么胖，改哪一行）

> 车道目标：把 `rush build → docker buildx bake → docker save → CDN 包` 这条产物流水线拆开，**逐字节定位** B 车道量到的可删内容在源码里的产生点，给出「改哪一行」级清单与可复算数字；评估去重/打包/基础镜像方案的可行性与半径；设计可自动化产出的「轻量开服包」。
> 输入依赖（只引用不重复）：`box3-re/A-docs.md`（版本/发行机制）、`box3-re/B-size-audit.md`（出厂镜像实测体积/跨镜像重复）、`box3-re/E-runtime-baseline.md`（运行时基线：空闲 RSS 313.67 MiB）。
> 方法：全程**只读**源码（Read/Grep/Glob/静态 wc/du），未运行 rush/docker，未触碰 `~/box3` 与运行中容器。标签：`INFERRED`=据代码/产物推断，`UNVERIFIED`=无法在本车道非侵入验证。
> 仓库：`D:\desktop\神奇代码岛\box3-local-engine` @ tag v2026.1.4（commit a35455d814）。所有 path:line 均相对该根。

---

## 0. 一句话流水线（Q1）

`rush build` 只编译 workspace 依赖；真正的产品镜像由 **`docker buildx bake`（compose 驱动的 6 个 build target）** 产出 → `docker image save | gzip -1` 打成**单一 tar.gz** → `split-image-archive.py` 按服务切分成 6 个带 sha256 的 per-service 归档 + `BOX3-IMAGE-CATALOG.json` 清单 → CI（release.yml）上传阿里云 OSS（`local-engine/v<ver>/`）并把「正式包」重传到 `local-engine/` + 写 `latest.txt` 指针；发行侧默认 **slim 模式**（服务器 ZIP 只含清单，5 个业务镜像按需下载），`local` 模式才把 tar 打进 ZIP。

关键结构判定（全部 `path:line` 实证）：

| 问题 | 结论 | 证据 |
|---|---|---|
| creator/play/player-service/voxa 是同一 Dockerfile 的 4 个 target 吗？ | **是**，同一个多阶段 `apps/local-engine/Dockerfile` | `docker-compose.yml:103/286/469/556` 四个 service 全部 `dockerfile: apps/local-engine/Dockerfile` + `target: creator\|play\|player-service\|voxa` |
| server-manager / auth-portal 呢？ | **各自独立 Dockerfile** | `apps/server-manager/Dockerfile`、`apps/player-auth-portal/Dockerfile`（compose `:226/:172`） |
| 谁生成 `.next/standalone` | Next.js `output:'standalone'` 在 build 阶段产出 | `apps/game/next.config.js:37 output:'standalone'`；build 见 `apps/local-engine/src/build.js:230-233`（`next build`），由 `rushx build:creator/build:play` 触发（`apps/local-engine/package.json` scripts） |
| 谁 COPY 进镜像 | 最终 runtime 层整块 COPY standalone | `apps/local-engine/Dockerfile:236`（creator）、`:315`（play）、`:374`（ps）、`:410`（voxa）`COPY --from=<build> /app/apps/*/.next/standalone` |
| 镜像 layer 结构 | **胖层 = 单次 COPY 整个 standalone**（creator 257MB/play 220MB/ps 178+76/voxa 190+15，均见 B §1），其后是 ~35 个 per-file `src/*.js` COPY（`Dockerfile:240-260`）与 `apis-runtime`/`game-server` COPY（`:238/:239`） | 直接可读 |
| build arg 真实结构 | 每个 target 重复声明 4 个 ARG（VERSION/COMMIT/DATE/SOURCE）写进 LABEL，`NODE_IMAGE` 是全局唯一基础镜像 ARG | `Dockerfile:1-5`、`docker-compose.yml:104-109` |

多阶段图（`apps/local-engine/Dockerfile`，实测 432 行）：

```
source-base  (apt python3/make/g++/ca-certs + COPY . .)            :7-21
  └ engine-build-base (rush install --to 4个app + rebuild --to-except + deploy @box/apis --prod + prepare-assets)  :23-52
      ├ creator-build        next build:creator + deploy game-server --prod + 深度 prune(/opt/game-server)  :54-93
      ├ play-build           next build:play   + deploy game-server --prod + prune + 额外删 @ai-sdk/edit/deploy  :95-141
      └ player-service-build build player-admin + next build + prune-player-build.js + 删 .ts/.map/test  :143-173
  source-base → voxa-build (rush install --to @box/voxa + next build)                              :175-179
runtime-base (node:22-slim; apt tini/ca-certificates/iproute2/iptables; COPY deployment-routing+LICENSE; ENTRYPOINT tini)  :181-199
  ├ creator          COPY standalone(未 prune) + game-server + apis + 35×src + runtime-data(cp -al)  :201-284
  ├ play             COPY standalone(未 prune) + game-server + apis + 15×src + runtime-data           :286-350
  ├ player-service   COPY standalone(已 prune) + static + public                                      :352-387
  └ voxa             COPY standalone + static + public + 删 .ts/.map                                  :389-431
```

`package-images` 入口链：`rush package-images` → `scripts/rush-command.js:25-26` → `scripts/package-offline-images.js` → `docker buildx bake --load --set <svc>.platform=... <svc>`（`:70-85`，逐服务）→ `docker image save <6 images> | gzip -1`（`:108-119`）。`package-web/desktop` → `scripts/package-release.js` → `package-offline-images.js` + `build-headless-server-package.js`/`build-desktop-offline-installer.js`。

`Dockerfile.routing`（`apps/local-engine/Dockerfile.routing`，仅 8 行）是**派生层机制**：给定 `BOX_RUNTIME_IMAGE`，只 `COPY packages/deployment-routing` 覆盖路由适配层并换 `BOX_BUILD_DATE`——即"改 base-path 路由不重编前端"。这已是官方给的薄层范例（见 §3a）。

---

## 1. 每一块可删字节的源码产生点（Q2，「改哪一行」级）

对标 B §0/§4 的 154MB/镜像构建期工具与 613MB 跨镜像重复。核心结构性发现先说：

> **Dockerfile 对 `/opt/game-server`（后端 deploy 产物）做了极尽细致的 prune（`:66-93`/`:106-141`：删 `*.ts/*.map/@types/test/docs/README/CHANGELOG`，play 还额外删 `@ai-sdk/@openrouter/ai`、`dist/src/edit|deploy`），但对最大的那层——`.next/standalone`——creator/play 完全未 prune 就整块 COPY**（`:236`/`:315`）。只有 player-service 跑了 `prune-player-build.js`（`:158`）且只删 `.ts/.map/.test.js/密钥`（`:166-173`），**没删任何构建期工具**。这就是 154MB 的直接来源。

| 可删块 | 字节 | 产生点（path:line） | 为什么会进生产镜像 | 「改哪一行」 |
|---|---|---|---|---|
| `@swc/core-linux-x64-gnu.node` | **48 MB** | devDep：`internals/apis/package.json`（`@swc/core 1.4.13`）+ 各 app 的 swc；被 Next standalone 追踪 | `next.config.js:45 outputFileTracingRoot=__dirname/../..`（追踪根=整仓）→ 把 `common/temp/node_modules/.pnpm` 整棵搬进 standalone | 在 creator/play COPY 前对 standalone 加 prune（见 §3c）；或收紧 tracing root；`@swc/core` 已是 devDep，standalone 仍带它=追踪副作用 |
| `typescript` | **33.3 MB**（8.93MB×2 份：standalone + game-server） | **prod 依赖**：`services/game-server/package.json` `dependencies` 含 `typescript`；`apps/game` 也依赖 | `dist` 运行时 `require('typescript')`=**0 命中**（`grep -rniE "require\(.typescript|from .typescript" services/game-server/src`=空），仅 `build.js:276` 编译期用 | **一行**：`services/game-server/package.json` 把 `typescript` 从 `dependencies` 移到 `devDependencies` → `pnpm deploy --prod`（`Dockerfile:64/103`）自动剔除 `/opt/game-server/node_modules/typescript`（−8.9MB×后端）；standalone 那份靠 §3c prune |
| `babel`（`@babel/*`+`next/dist/compiled/babel`） | **30.9 MB** | Next 内建 + transitive；`build.js:230 next build` 编译期 | 同 tracing root 过宽；`next/dist/compiled/babel*` 是 Next 自带不可去 | standalone prune 命中 `.pnpm/@babel+*`；Next 自带那份只能随 Next 走 |
| `sql.js` debug+冗余 asm 变体 | **22.7 MB**（4 变体只加载 1） | prod 依赖：`services/game-server/package.json` `sql.js`；B §4 实测 `worker.sql-asm-debug.js`/`sql-asm-debug.js` 各 11MB | game-server prune（`:68-83`）用 `find -delete` 但**不含 sql.js 变体白名单** | **一行级**：`Dockerfile:68` 后追加 `&& rm -f /opt/game-server/node_modules/sql.js/dist/*-debug.js /opt/game-server/node_modules/sql.js/dist/worker.sql-asm.js /opt/game-server/node_modules/sql.js/dist/sql-asm-memory-growth.js`（保留实际加载的那一个变体，加载点 `INFERRED` 在 `@box/mudb`） |
| `esbuild` 二进制 | **11.5 MB** | devDep（Next/rollup 追踪）；`apps/voxa`、`apis` 用 rollup+swc | tracing root 过宽 | §3c prune 命中 `.pnpm/@esbuild+*` |
| `sass/sass.dart.js` | **4.3 MB** | devDep（`apps/game` 大量 `.scss`，见 `views/edit/components/monaco/index.module.scss`）编译期 | 追踪进 standalone | §3c prune 命中 `.pnpm/sass@*` |
| `amphtml-validator/validator_wasm.js` | **4.0 MB** | `next/dist/compiled/amphtml-validator` | Next 自带，AMP 校验与体素游戏无关 | 无法在不魔改 Next 的前提下去；`INFERRED` 属 Next 内建，收益有限 |
| 重复字体（ChillRoundGothic 12MB×2 + MiSans 等，58.6MB/镜像） | ~30–58 MB | 源：`apps/game/assets/fonts/*.ttf|woff|woff2`（实测存在 ChillRoundGothic-Bold.ttf/woff、MiSans-*、Montserrat-*、DoulosSILR.ttf、Code-New-Roman-Bold.woff） | Next 同时 emit 到 `.next/static/media` 与 `.next/server/chunks/static/media`（B §2 双拷贝） | `build.js:244` 只把外层 `.next/static` 覆盖进 standalone，未去 server/chunks 副本；改为 woff2-only + 子集化 + 单副本（改 `apps/game/assets/fonts` 内容 + 一处 copy 逻辑） |
| Monaco `static/vs`（tsWorker.js 4.6MB+editor.main 3.5MB…12.6MB） | ~12 MB/play,ps | **prod 依赖**：`apps/game/package.json:53 @monaco-editor/react 4.7.0`、`:95 monaco-editor 0.46.0`；仅 `src/views/edit/**`、`src/client/edit/**` 引用（`grep` 命中全在 `/edit` 下） | creator/play 用同一 Next build；`prunePlayerServiceBuild` 删 `server/app`+`static/chunks/app`（`prune-player-build.js:177-179`）但 **play 根本没调用它**，且两者都不删 `static/vs` | **play 侧**：`Dockerfile:95` play-build 里 `build:play` 后（其实 `build.js:235-238` 已对 play 调 `prunePlayerBuild`，只删特定 route）→ 增补删 `apps/game/.next/standalone/apps/game/.next/static/vs`（play 无编辑器）。player-service 同理加一行 `rm -rf .../static/vs` |
| 跨镜像 613 MB 字节级重复 | **613 MB** | 结构性：每个 target 各 COPY 一份 `standalone`(143M node_modules+102M 嵌套 .next)+`game-server .pnpm`(125M)，`split-image-archive.py:113-115` 把共享 layer **逐镜像各写一份**进 per-service tar | `outputFileTracingRoot` 整仓 + 不共享 app-base | 见 §3（唯一真正的结构解） |

**per-file COPY 碎片层**：creator 用 19 个 `COPY .../src/*.js`（`Dockerfile:240-258`）、play 15 个（`:319-334`），每层 24–111KB（B §1 "~35 tiny layers"）。改法：把这些 src 打成 1 个 COPY 或用 `COPY apps/local-engine/src /app/apps/local-engine/src`（但需确认 launcher 只 require 同目录兄弟模块，`INFERRED` 可行）。半径=改 1 文件。

---

## 2. 镜像层共享/去重可行性评估（Q3）

现状基线（引 B + 任务前提）：6 镜像 content ≈2.6GB、跨镜像重复 613MB、单胖镜像构建期工具 154MB（/app 39%）、node 基础 ≈266MB×5、auth-portal 应用仅 280KB 却 230MB。E 已证明**执行期只需 313.67 MiB RSS**——胖全在磁盘/分发/构建。

| 方案 | 机制与证据 | 可省（估） | 半径 | 风险/限制 |
|---|---|---|---|---|
| **(a) 单一 app-base + thin layer** | 官方已有雏形：`Dockerfile.routing` 就是在已有 runtime 上只覆盖 `deployment-routing` 一层（`Dockerfile.routing:2-8`）；`runtime-base`（`Dockerfile:181`）已把 4 个 JS target 的共同层抽出。缺的是把**依赖树+standalone 也沉到共享层** | 613 MB 重复 → 若走 registry digest 层复用则 pull 端去重（content 已在宿主去重，B §1；真正省的是**分发 tar**）；per-service 归档仍各存一份（`split-image-archive.py:113`），需改为引用式 | creator∩play 288.9 / play∩ps 169.3 / 三镜像 169.2 → 两两合并可省 ~300–600 MB 传输 | **改构建系统**（新增 base 镜像 + 各服务 FROM 它）。OCI registry 部署后天然层复用；但离线 tar 模式无法去重（docker save 每 tar 自带） |
| **(b) `output:'standalone'` 正确用法** | 现把依赖树实体化两次（143M node_modules + 嵌套 102M .next，B §3）。`build.js:240-246` 又删又覆盖 standalone 内 `.next/static` | ~140 MB/镜像（去掉嵌套第二次物化） | **改 1 文件**（`next.config.js:45` tracing root 收窄到 `apps/game`；`outputFileTracingExcludes` `:48-56` 补 node_modules 构建工具 glob） | Next standalone 本身必带一棵 runtime node_modules；只能减不能清零。改 tracing root 可能破坏 monorepo 跨包 require（`INFERRED` 需回归） |
| **(c) 真打包 `--bundle` 服务端** | 范例已在仓内：`apps/player-auth-portal` 用 `standalone-manifest.cjs`+`npm run build` 把后端全打成**单 `server.cjs`**，运行镜像**零 node_modules**（`Dockerfile.standalone:20-22` 注释明说）→ auth app 只 280KB | game-server 125M `.pnpm` → 数十 MB（若可 bundle） | **改运行时代码**（game-server 引入 esbuild/nft） | **native/WASM 硬限制**：`isolated-vm`（.node，脚本 VM）、`sharp`+libvips(18M)、`sql.js`(WASM) **不可 bundle**（`grep require` 在 `game-server/dist` 见 sql.js/isolated-vm/@ai-sdk）；`@vercel/nft` 只剪可达子集不产单文件。可行路径=nft 剪枝 + native 依赖 external 保留，**不是** esbuild --bundle 全量。半径大 |
| **(d) 多阶段 + `--prod` 安装** | `deploy --prod` **已经在用**（`Dockerfile:46/64/103 --prod`）；但 standalone 是 Next build 产物、不受 deploy --prod 管辖 | creator/play standalone 里 154MB 工具 | **改 1 文件**（在 `Dockerfile:236/315` COPY 前加一段 standalone prune `find -delete .pnpm/{@swc+core,typescript,esbuild,sass,@babel,amphtml}*`）| 需确认 standalone 运行时不 require 之（B §4 grep `@swc/core` in dist=0）；`@swc/core` 若被 Next 运行时懒加载会坏（`INFERRED`，需冒烟 server.js） |
| **(e) 基础镜像 slim→distroless/alpine** | `NODE_IMAGE=node:22.17.0-bookworm-slim`（`Dockerfile:1`、compose 五处）。runtime-base apt 装 `tini iproute2 iptables`（`Dockerfile:192`） | auth 230→~90MB；266×5 base 变薄 | 改 1 文件（换 BASE）+ 改运行时代码（去 apt） | **`iproute2`+`iptables` 在全部 shipped 代码里 grep 调用点=0**（`grep -rniE "iptables\|ip route\|execFile.*'ip'"` 命中全是 NetState 误报）→ 疑为遗留/为 in-container 网络（`runtime.rs:140-160` 走 docker inspect 拿 IP，非 iptables）。distroless 无 apt/sh，需先把 ENTRYPOINT tini 改静态（`INFERRED`）。alpine=musl 与 `isolated-vm`/`sharp` 预编译 glibc 二进制不兼容（需重编译）——**成本高于收益**，建议 glibc distroless 而非 alpine |

`node:22-slim` 内 `ca-certificates` bootstrap 有巧思（`Dockerfile:189` 先用 Node 内建 rootCertificates 写 `/etc/ssl/certs` 再 apt 装）——换 distroless 要保留 TLS。

---

## 3. 构建系统职责与可移植/离线复现（Q4）

| 主题 | 事实（path:line） |
|---|---|
| `internals/build-system` 到底做什么 | **游戏内容资产编译器**，非 Docker/CI。`build-system.ts`(184 行)+`tasks/`（voxel/skin/texture/anim/bloom-filter/audio/migrations）。被 `prepare-assets.js`（`apps/local-engine/src/prepare-assets.js:61-80` new BuildSystem + buildResources）调用，产出内容寻址 IPFS 风格 blob（`Qm[1-9A-Ha-z]{44}`）落 `apps/local-engine/data/blobs`（=B 的 24MB runtime-data），并 `bundleEditorApiDeclarations` 绑 API DTS blob（`:25-34`） |
| openapi.json 是否生成 | **是**。`internals/apis/openapi/openapi.json`（本仓实测 491,261 B）**不在 git tree**（`box3-re/_tree.out` grep `apis/openapi` = 0）= 生成物。`api:generate`→`command-line.json:51`→`rush-project-command.js:12 api-generate=['@box/apis','generate']`→`internals/apis/package.json:generate`：`generate-openapi.mjs`（**扫描 `apps/game/pages/api/**`+`apps/voxa/pages/api/**` 路由文件** + manualRoutes，`generate-openapi.mjs:14-40` 实证）→ openapi-typescript 出 `src/generated/openapi.ts` → `generate-client.mjs`。137 path/多 tag 皆由源码派生 |
| 与 `@box/schema` 关系 | schema（`internals/schema/`）是运行时**实体/UI 结构定义**（entity/voxel/game-ui/…），脚本 API DTS 在 `internals/schema/api/js/`；apis 不 require schema 生成 openapi（`generate-openapi.mjs` 不 import @box/schema，`INFERRED` 两者解耦） |
| Rush variants / 发布锁 | **无**：`common/config/rush/` 仅 command-line/common-versions/pnpm-config/pnpm-lock/repo-state；**无 version-policies.json、无 publish.json、无 *.variant.json**；全包 `private:true`（`apps/local-engine/package.json:4`），版本靠 `scripts/sync-root-version.js`（release.yml:120）统一刷，不用 Rush 发布机制 |
| lockfile 与源绑定 | `common/config/rush/pnpm-lock.yaml` **已提交**（实测 37,358 行）→ 依赖可复现。镜像溯源在 LABEL：`org.opencontainers.image.revision=${BOX_BUILD_COMMIT}`（`Dockerfile:209`），CI 传 `github.sha`（release.yml:93），split 后写入 catalog `sourceRevision`（`split-image-archive.py:69`）。`server-image-plan.js:56-83 sourceFingerprint` 用 git ls-files+sha256 逐服务指纹（排除 build/dist/node_modules）→ **增量重建判定** |
| 能否 `--filter` 只建 play 子图 | **部分**：`rush package-images --architecture amd64 --service play`（`command-line.json:212-215`；`package-offline-images.js:31/47` 支持单 service）只 bake+save play 一个 target。但 Dockerfile 内 `engine-build-base` 仍 `rebuild --to-except`（`:36-41`）编全套依赖，**不随 --service 缩减**；且 play 依赖 game-server+apis+standalone，子图本就大。真正的最小图需拆 Dockerfile（见 §5） |

可离线复现结论：**构建侧强复现**（pnpm-lock+源指纹+`BOX_DOCKER_NODE_IMAGE` 全可覆盖，见 compose 每处 `${BOX_DOCKER_NODE_IMAGE:-...}`）。但 Dockerfile 内**硬钉国内镜像源**：`NODE_IMAGE=docker.m.daocloud.io/...`（`Dockerfile:1`）、`npm_config_registry=https://registry.npmmirror.com`（`Dockerfile:26/62/101`）、`sharp_libvips_binary_host=npmmirror`（`:63`）、Cargo `rsproxy.cn`（`server-manager/Dockerfile:20`）。离线需镜像这些到私有源（`INFERRED`，可全换，无写死唯一域名）。

---

## 4. 版本与更新链在构建侧 + 自托管仓库是否真离线（Q6）

| 机制 | 实现位置 | 离线/自托管可行性 |
|---|---|---|
| `latest.txt` 指针 | 构建侧生成：`release.yml:496 printf version > latest.txt`，`publish` 阶段**最后**上传（`:522-523`，注释保证原子性）；`package-server.yml:259/271` 同款 | 内容仅版本号，无域名硬编码 |
| `BOX3-PACKAGE-MODE.json` | `build-headless-server-package.js:166-178` 写 `{mode,channel,version,imageTag,platform}`；mode=`slim`（清单）或 `local`（打进 cache/engine-images） | — |
| slim 模式按需下载 | ZIP 不含 5 个业务镜像（`:195-197` 删 splitRoot；只有 `local` 才 `:179-194` 把 tar 拷进 cache）。运行时 Rust server-manager 读 catalog 按需拉 | 见下 |
| `BOX3_RELEASE_CDN_URL` 后门 | **运行时生效**：`distribution/server/bootstrap.sh:10 RELEASE_CDN_URL=${BOX3_RELEASE_CDN_URL:-https://assets.box3.fun/local-engine}`，用于拉 server **ZIP**（`:215 latest.txt`、`:321 package_url`）；Rust 也把它写进 compose（`apps/server-manager-rust/src/platform/configuration.rs:535`） | ZIP 层可自托管 ✅ |
| 联网**硬编码点**（挡住全流程离线） | ① `distribution/server/install.sh:123 curl ... "https://assets.box3.fun/local-engine/$archive"`（server-manager 归档拉取**写死域名**，不读 BOX3_RELEASE_CDN_URL）② `scripts/build-image-downloads.js:15-24 validDownloadBase()` **只接受** `assets.box3.fun/local-engine` 或 `local-engine-staging` 正则 → **自建 CDN 的 per-image downloadBaseUrl 会被 validateCatalog 拒绝**（`:61`）③ `scripts/release-context.js:44 downloadBaseUrl=https://assets.box3.fun/...`（永远 box3）④ Rust `apps/manager-core/src/release_channel.rs:2-3 PRODUCTION_BASE/STAGING_BASE` const 写死 ⑤ Tauri CSP `apps/deployment-manager/src-tauri/tauri.conf.json:26 connect-src ... https://assets.box3.fun` | 综合：**Linux 服务器路线可半自托管**（bootstrap.sh+BOX3_RELEASE_CDN_URL 能换 ZIP 源），但 **per-image 归档下载与桌面管理器**仍锁死 box3.fun；要全离线需改 ①②③④ 四处 + 用 `local` 模式把 6 tar 打进包（`package-web --mode local`，A §4.5 实证该模式存在）。`INFERRED` |

slim 模式默认把胖分发推到「首次联网拉 1,011.5 MiB」；`local` 模式则是完整离线包（CDN 上 `-full-` 已 404，但构建能力在：`package-offline-images.js`+`build-headless-server-package.js --local`）。→ **自托管部署应走 `local` 模式或私有 registry + 放宽 validDownloadBase**。

---

## 5. 最小发行形态设计（Q5，对标官方两-tar 先例）

官方先例实证：`distribution/play/compose.yml` 只定义 **player-service + play（+play-storage-init）** 两镜像 + 外部 PostgreSQL，README 明说「无需源码/Node.js，增加地图不重建镜像」（`distribution/play/README.md:3`）。**关键：该 compose 不配 `BOX_RUNTIME_MANAGER_URL`**（对比主 compose `:493`），而 `launcher.js:254` 实锤「BOX_RUNTIME_MANAGER_URL 未配置→用 shared Node runtime」→ **play 以进程内 spawn `game-server/dist/src/launch.js`（`:173/355`）跑地图，不需要 server-manager、不需要 docker.sock**。E §7「最小 3–5 容器」与此吻合。

轻量开服包（可自动化产出）设计：

| 维度 | 现状 | 目标 | 依据/半径 |
|---|---|---|---|
| target 数 | 6 | **2–3**：play + player-service（+可选 auth-portal） | 去掉 creator（编辑器）、voxa（建模）、server-manager（docker.sock+114MB docker CLI，`server-manager/Dockerfile:55-56`）。去掉 manager = 去掉 host root 等价权限（A §6.6） |
| server-manager/docker.sock | 主 compose 强制常驻（`:218-268`） | **移除** | 引用 E §7：shared Node 模式 manager 非硬依赖；`play` compose 已示范不依赖 manager 起图 |
| 前端 SSR/Next server | play 用 `next-server` 做 SSR + 大量 `rewrites` 代理 `/runtime/* /block/:hash /p/:world/__local_runtime/*`（`next.config.js:64-155`） | **不能完全静态化** | `INFERRED`：`/p/:publicId` 动态页 + 运行时 RPC 代理由 Next server 承担；静态导出（`package.json:export NEXT_PUBLIC_EXPORT_MODE`）会丢掉这些代理。可静态化的是纯静态资源，server 仍需 |
| 传输体积 | play 240.7 + ps 203.7 = **444.4 MB gz**（A §8.1 表） | **~150–200 MB gz** | 推算：(1) 两镜像共享一个 app-base（play∩ps 169.3MB 去重）；(2) standalone prune 构建工具（§1，−~90MB gz×2 未压前 154MB，`INFERRED` gz 后约 −50–80MB）；(3) sql.js 变体单副本（−35MB gz×2→−~40MB）；(4) distroless glibc base（−~50MB gz×2）；(5) play 去 static/vs Monaco（−12MB×2）；(6) 字体 woff2-only 单副本（−~30MB）。合计 444→~150–200（乐观 150，保守 200）。**UNVERIFIED**：需真跑一次瘦身 build 复算 |
| 单服最小 | — | play 单镜像 **~90–120 MB gz**（不含 ps 鉴权，本地直玩下限，呼应 E §7「≈3 容器」） | `INFERRED` |
| 产出自动化 | 需手工 `--service`+手拼 compose | 新增 `package-minimal-play` rush 命令（复用 `package-offline-images.js:47` 单 service + `build-headless-server-package.js` headlessCompose 抽两服务段，`:66-71`）+ 瘦身版 Dockerfile target | 半径=改构建系统（1 新脚本 + Dockerfile 加 prune） |

---

## 6. CI/发布流水线现状与缺口（Q7）

| workflow | 干什么 | 证据 |
|---|---|---|
| `release.yml` | validate→images（逐服务 `docker compose build`+`builder prune`，`:172-175`）→ split per-service→OSS→desktop(5目标)→headless-server(2架构)→publish(GitHub Release+latest.txt) | `release.yml:31/87/154-185/210/372/429` |
| `package-server.yml` | 只补打 Linux 服务器包，复用已发布 app 镜像（`server-image-plan.js plan-manager`，`:175`），仅重建 server-manager 镜像 | `:161-216` |
| `verify.yml` | **只 `rush verify`（格式/语法/风格），无 build/typecheck/test/镜像/体积** | `verify.yml:42-43` |
| `player-launcher-release.yml` / `release-branch-created.yml` | 玩家启动器与分支路由 | （兄弟 workflow） |

缺口（实证）：
1. **无镜像体积回归门**：`verify-headless-server-package.js` 只断言 catalog 结构/`size>0`（`:34`），无上限；`check-standalone.js`(1988 行) 全是**源码 pattern 断言**（如 `:982 VOXA_MAX_BLOB_BYTES`、`:1902 runtimeBlobHashes>0`），**不检查已构建镜像字节数**。
2. **无 attestation/SBOM/provenance**：release.yml 走 `docker save|gzip -1`（`:176-183`），全程**无 `docker build --push`、无 `docker attestation`、无 syft/cosign**；`--load` 而非 `--push`（`package-offline-images.js:76`），无 registry provenance。
3. `check-release-workflow.js` 校验 workflow 接线（`:73-76` image build loop），但不校验产物大小。

三条「发布即瘦身」CI 门建议（可挂进 verify.yml 新 job 或 release.yml images 后）：
- **体积预算断言**：`docker image inspect -f '{{.Size}}'` 求和，硬门 `creator content < 250MB / play < 220MB / player-service < 150MB / voxa < 150MB / auth-portal < 120MB`，任一超预算 exit 1（对标 B §0 现值 658/595/492/445/230 → 先设过渡阈值）。半径=改 1 workflow。
- **standalone 构建工具黑名单扫描**：CI 内 `docker create` 临时容器 + `du`/`find` 断言 `.next/standalone/**/node_modules/.pnpm/{typescript,esbuild,sass,@swc+core,@babel}*` **不存在**、`sql.js/dist` 仅 1 个非 `-debug` 变体、`static/vs` 不在 play/ps。把 §1 清单固化成回归门。
- **SBOM+provenance 产物门**：`docker buildx bake --push` 到带 provenance 的中间 registry，或在 images job 后 `syft dir:/app -o spdx-json` 随 catalog 上传并断言存在（补供应链可信，利于私有化审计）。

---

## 领域外发现（一行指针，交由对应泳道）

- `launcher.js:254` shared-Node 回退 → 编排/拓扑车道（S?）：去 server-manager 后 play 仍可独立起图，与 E §7 一致。
- `Dockerfile:192 iproute2/iptables` 全代码零调用点（grep 命中皆 NetState 误报）→ 安全/运行时车道核实是否遗留。
- Rust `manager-core/release_channel.rs` 与 install.sh 写死 box3.fun → 私有化「自托管更新」车道。
- `apps/game/next.config.js:264 ignoreBuildErrors:true` + `typescript.js` 打进 prod → 质量/构建车道。

---

## 优先级表（改动项 | 省下 MB 或秒 | 实现半径 | 风险 | 证据行号）

| # | 改动项 | 省下的 MB / 秒 | 实现半径 | 风险 | 证据 path:line |
|---|---|---|---|---|---|
| 1 | creator/play COPY standalone **前加构建工具 prune**（删 .pnpm 里 @swc/core/typescript/esbuild/sass/@babel/amphtml） | ~154 MB×2 未压 → 估 **−60~100 MB gz**（creator+play） | 改 1 文件（Dockerfile 加一段 find -delete） | 中：需冒烟 server.js 确认无懒加载 | `Dockerfile:236,315`；B §4 154MB |
| 2 | `services/game-server/package.json` 把 **typescript 移 devDep** | −8.9 MB×(ps无/creator+play后端)≈**−18 MB 未压** | 改 1 文件 | 低：grep dist 运行时 require=0 | `game-server/package.json deps`；`grep=require(typescript)=空`；`build.js:276` |
| 3 | Dockerfile 后端 prune 追加 **sql.js 仅留 1 变体** | −22.7 MB×(creator+play+ps 后端，ps 无后端)≈**−45 MB 未压** | 改 1 文件（一行 rm） | 低-中：确认 mudb 加载的变体名 | `Dockerfile:68` 后；B §4/§6 |
| 4 | play/ps 增补 **删 `.next/static/vs`（Monaco）** + play 现未调 prunePlayerServiceBuild | −12.6 MB×2≈**−25 MB 未压** | 改 1–2 文件 | 低：monaco 仅 /edit 引用 | `package.json:53,95`；`prune-player-build.js:177`；grep monaco 全在 views/edit |
| 5 | **单一 app-base 镜像**（4 JS 服务 FROM 共享依赖层）→ 跨镜像 613MB 走 registry 层复用 | 分发端 **−~300~600 MB**（离线 tar 仍不去重）；pull 端 content 已去重 | 改构建系统（新 base + 4 FROM） | 中：CI/离线 split 逻辑需改引用式 | `Dockerfile:181 runtime-base`雏形；`split-image-archive.py:113`；`Dockerfile.routing` 范例 |
| 6 | 字体 **woff2-only + 单副本**（去 server/chunks 双拷贝） | −~30~58 MB×每镜像 未压 | 改 1 文件+资产 | 低 | `apps/game/assets/fonts/*`；`build.js:240-246`；B §2 |
| 7 | 收窄 **outputFileTracingRoot** / 补 outputFileTracingExcludes node_modules 工具 glob | 依赖树两次物化 −~140 MB/镜像 | 改 1 文件（next.config.js） | 中：可能断跨包 require | `next.config.js:45,48-56`；B §3 |
| 8 | **distroless(glibc) 基础镜像** 替 node:22-slim；去 iptables/iproute2 | base 266→~190 ×N；auth 230→~90 | 改 1–2 文件 | 高：isolated-vm/sharp 预编译需 glibc；tini 静态；无 apt/sh | `Dockerfile:1,181-193`；grep iptables 调用=0 |
| 9 | **CI 体积预算 + SBOM 门**（发布即瘦身） | 防回归（守住上述所有）；非直接省 MB | 改 1–2 workflow | 低 | `verify.yml:42-43`（现无门）；`verify-headless-server-package.js:34` |
| 10 | `package-minimal-play` 命令（play+ps 两镜像，去 manager/creator/voxa，去 docker.sock） | 开服包 **444 MB → ~150–200 MB gz**（叠加 1/3/5/6 后） | 改构建系统（复用现有单 service+compose 抽取） | 中：需 compose 裁剪正确性 | `distribution/play/compose.yml`；`launcher.js:254`；`package-offline-images.js:47` |
| 11 | 放宽 `validDownloadBase` + install.sh 用 BOX3_RELEASE_CDN_URL（全流程自托管/离线） | 使离线/私有 registry 可跑通（非体积） | 改 3 文件（js+sh+rust） | 中：需重签/重校验路径 | `build-image-downloads.js:15-24`；`install.sh:123`；`release_channel.rs:2-3` |
