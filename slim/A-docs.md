# A · BOX3 本地引擎官方文档全量取证（文档车道）

- 取证时间：2026-10-17（UTC+8）
- 取证方式：`curl` 抓取 VitePress 静态 HTML → 去标签存文本；GitHub REST（release / git tree / contents raw）取版本与清单文本；`curl -sSI` 取 CDN 精确字节数。**未下载、未运行任何引擎二进制或 Docker 镜像。**
- 本地证据缓存（均为文本，供其他车道复用）：
  - `box3-re/_txt/`（53 个文档页纯文本，文件名即 URL 路径）
  - `box3-re/_manifest/`（Linux 服务器发行包内的**纯文本清单**：`compose.yml`、`.env.example`、`BOX3-IMAGE-CATALOG.json`、`README.md` 等，整包仅 25 KB）
  - `box3-re/_repodocs/`、`_repodocs2/`、`_repodocs3/`、`_repodocs4/`（仓库 `docs/*.md`、各模块 README、Dockerfile、LICENSE 原文）
  - `box3-re/_tree.out`（`v2026.1.4` 全仓库 git tree 文件清单，9,616 条目）
- 官方文档站：`https://docs.box3lab.com/`，主体由 `深圳奇梦岛科技有限公司`（Copyright © 2021–2026）发行；引擎仓库 `https://github.com/box3lab/box3-local-engine`（**MIT**，GitHub 元数据语言 = TypeScript，仓库 git size = 68,698 KB，创建于 2026-08-03，最新推送 2026-10-16）。文档源码镜像在 Gitee：`https://gitee.com/box3lab/box3-product-document`（raw 接口返回 403，不可直接取原文）。

---

## 1. 完整文档地图

### 1.1 `local-engine` 树（**18 页，已 100% 全量抓取**）

侧边栏分组共 4 组、17 个子页 + 1 个首页，与首页卡片对应关系：`电脑安装 → desktop-installation`、`服务器安装 → linux-installation`、`我只想玩游戏 → player-launcher`（已从 HTML 原文验证：`<a href="/local-engine/guide/player-launcher.html">我只想玩游戏</a>`）。

| # | 页面标题 | 真实 URL | 一句话内容 |
|---|---|---|---|
| 1 | BOX3 本地引擎（首页） | `https://docs.box3lab.com/local-engine/` | 「在自己的设备上创作和开服」，三张入口卡（电脑安装/服务器安装/我只想玩游戏）+ 首次使用/创作/访问三段引导 |
| 2 | 本地引擎介绍 | `.../local-engine/guide/introduction.html` | 用表格定义 7 个应用（部署管理器、Creator/ARENA、VOXA、Play、登录页面、玩家管理后台、玩家启动器）各自职责，给出最短使用路线 |
| 3 | 安装前准备 | `.../local-engine/getting-started/requirements.html` | 三种安装方式选择表 + **CPU/内存/磁盘建议表（4核8G30G / 8核16G50G）** + Docker 前置说明，明确「普通安装不需要下载源码，也不用安装 Node.js 或 Rust」 |
| 4 | 桌面安装 | `.../local-engine/getting-started/desktop-installation.html` | 开 Docker Desktop → 从 GitHub 发布页下载 `BOX-Local-Engine ZIP`（按 5 平台标识选择）→ 解压打开 `BOX3 Engine Launcher` → 首次配置；强调「安装包不需要提前包含所有服务，管理器会按你的选择下载需要的组件」 |
| 5 | Linux 服务器安装 | `.../local-engine/getting-started/linux-installation.html` | 一行 `curl -fsSL https://assets.box3.fun/local-engine/install.sh \| sudo bash`；保存两种密钥；默认管理端口 3130；SSH 隧道变体；`/opt/box3-engine` 下 status/start/logs/stop 脚本 |
| 6 | 首次启动 | `.../local-engine/getting-started/first-start.html` | 5 步流程（配数据/设地址/启服务/准备账号/开始使用）+ **默认端口表 3121/3123/3124/3125/3127 + 管理器 3130**；PostgreSQL 选内置、Redis 可关；服主密钥授权创作 |
| 7 | 局域网与公网访问 | `.../local-engine/guide/network-access.html` | 本机/局域网/公网（共用地址带路径前缀，或独立地址）四种场景的具体填法、Nginx 内置下载、`/play` 根路径 404 的坑 |
| 8 | 创作、预览与发布 | `.../local-engine/guide/create-and-play.html` | 完整创作闭环：新建作品 → 导出 `.boxproject` → 主地图导出游戏包（填 `v1.0.0`、选「仅本地资源」）→ 后台导入 `.boxplay` → 开放地图组 → 邀请玩家 |
| 9 | 作品管理 | `.../local-engine/guide/works.html` | 作品=可编辑地图工程；导入/导出（本地图 vs 地图组）、`.boxplay` 不能代替工程、删除前必须先导出 |
| 10 | 地图组与地图 | `.../local-engine/guide/maps-and-groups.html` | 一个主地图 + 若干副地图，共用组资源与组数据；传送需手工配置；区分地图 ID / 名称 / 访问 ID |
| 11 | 玩家启动器 | `.../local-engine/guide/player-launcher.html` | 玩家侧 App（`player-v*` 标签）：下载选择表、添加服务器要填 Play 首页地址（保留 `/play` 路径）、首次下载资源、缓存管理；明确**不代表可以离线运行** |
| 12 | 游玩地图管理 | `.../local-engine/guide/play-maps.html` | 后台导入 `.boxplay`、核对预览（包内脚本预览时不运行）、更新流程、关闭/删除地图组 |
| 13 | 玩家管理后台 | `.../local-engine/guide/player-admin.html` | 三种身份表（玩家 / 服主 / 管理员）、创作权限授予流程、权限组、封禁与安全记录、CLI Token 创建、与部署管理器的分工 |
| 14 | 登录门户与模板 | `.../local-engine/guide/login-portal.html` | 登录门户=Play/Creator 共用注册登录页；模板仓库定制；管理器里填的是**Docker 镜像名**（不是仓库链接）；自定义镜像不随引擎升级 |
| 15 | 地图运行与资源管理 | `.../local-engine/guide/maps-and-containers.html` | 容器管理页看 CPU/内存/房间；两种运行方式表（**共享 Node** vs **独立 Docker**）；可调参数（玩家上限、房间上限、空闲回收、资源组）；「销毁」的语义 |
| 16 | 备份与更新 | `.../local-engine/operations/backup-and-update.html` | 4 类备份数据表（`.boxproject` / `.boxplay` / 管理器文件备份 / 单独 PostgreSQL）；手动备份、自动备份参数、恢复流程、「关于 → 检查更新」升级流程与渠道差异 |
| 17 | 账号与访问安全 | `.../local-engine/operations/security.html` | 不分享两类管理密钥、公网必须 HTTPS、只导入可信 `.boxplay`（运行时会执行脚本）、保留可恢复备份 |
| 18 | 常见问题 | `.../local-engine/operations/troubleshooting.html` | 9 类故障（管理器打不开/Docker、域名解析但打不开现象表、登录回环、三种登录失败、DB 连接失败、导入失败、启动器卡校验、备份 Permission denied、组件下载失败要能访问 `assets.box3.fun`）；「关于 → 导出诊断包」 |

其他发现的外部链接（首页/各页 footer）：`https://github.com/box3lab/box3-local-engine/releases`、`.../issues`、`https://github.com/box3lab/box3-engine-player-auth-template`、QQ 群 `1107448537`（「Box3Local秘密基地」）、`https://www.docker.com/products/docker-desktop/`。
`sitemap.xml` / `robots.txt` 在 `docs.box3lab.com` 上均为 **404**，文档树只能靠侧边栏穷举（已穷举，无遗漏页）。

### 1.2 导航栏兄弟树（首页顶栏 4 个链接）

| 顶栏名 | URL | 实际状态 |
|---|---|---|
| ARENA 手册 | `https://docs.box3lab.com/arena/` | 200，站点标题「ArenaEdit 用户手册」，**共 88 个内部页面** |
| VOXA 手册 | `https://docs.box3lab.com/voxa/` | 200，「VoxaEdit 用户手册」，**共 32 个页面** |
| 创作 CLI | `https://docs.box3lab.com/arenapro/zh/cli/` | 200，「ArenaPro CLI」；整个 `arenapro/zh` 树 **53 个页面** |
| **脚本 API** | `https://docs.box3lab.com/api/` | **404（死链）** —— 见下方 §7.1 |

ARENA 树中与本地引擎/脚本直接相关（已逐页取文）：
- `.../arena/editor/code.html` 代码编辑器（明确「支持使用 JavaScript 语言直接操作地图中的物品逻辑」）
- `.../arena/core/client-server-modules.html` 客户端与服务端脚本架构（MJS vs CJS，最关键的一页）
- `.../arena/javascriptDaoAPI/02-getting-started.html` API 入门：编写你的第一个游戏脚本（全局对象 `world`/`ui`/`storage`）
- `.../arena/javascriptDaoAPI/03-creating-entities.html` 创建第一个实体
- `.../arena/javascriptDaoAPI/04-creating-ui.html` 创建第一个 UI
- `.../arena/javascriptDaoAPI/05-client-server-communication.html` 客户端与服务器通信（`remoteChannel`）
- `.../arena/getting-started/create.html`、`.../helloWorld-code.html`、`.../helloWorld-models.html`、`.../publish.html`（发布第一个地图＝导出 `.boxplay`）
- `.../arena/features/**`（地形/方块/模型/玩家/皮肤/虚拟按键/2D UI 与 `UiNode`…`UiScreen` 7 个元素参考页）
- `.../arena/javascriptEntry/**`：**约 45 页纯 JavaScript 语言教程**（变量、控制流、函数、对象数组、类、异步、事件循环、Proxy/Reflect、BigInt、Intl…）——即官方给创作者的「先学 JS」教材体量

VOXA 树相关页：`/voxa/`、`getting-started/{create,models-one,two,three,publish}.html`、`advanced/models.html`（模型对性能的影响，**限制单模型部件数 128，不建议超过 50**）、`advanced/help.html`、`editor/**`（部件/体素/动画/物理/换肤模式界面 22 页）。

ArenaPro（CLI/TS 工具链）树关键页：`/arenapro/zh/`、`guide/01-introduction/00-toolbox-introduction.html`（**宣布 VSCode 插件版停止迭代**）、`guide/02-getting-started/{01-install,02-create-project,03-connect-to-cloud}.html`、`guide/03-basic-tutorial/{01-hello-world-tutorial,02-whats-different,typescript-vs-javascript}.html`、`guide/04-development-workflow/{compilationPrinciple,debug,debugger,hmr}.html`、`guide/05-best-practices/*`、`guide/06-advanced-topics/*`（资源同步、npm 包、Zod、jest、webpack 插件、i18n…）、`guide/07-publishing/createNPMProject.html`、`cli/guide/cli-commands.html`（APC 全命令）、`authority/storage.html`、`difference/*`（7 篇与 Arena 的差异）、`community/release-notes.html`、`mcp/`（插件 MCP）。

---

## 2. 两条部署路线的差异

### 2.1 桌面（Windows / macOS / Linux 桌面）

| 项 | 文档原文/数值 |
|---|---|
| 前置 | 「Windows、macOS 打开 Docker Desktop，等待它显示正在运行，再打开引擎」；「Windows 需要启用虚拟化和 WSL 2」；Linux 桌面需 Docker Engine + Compose v2 |
| 下载入口 | 「打开 BOX3 本地引擎发布页，选择引擎正式版本中的 `BOX-Local-Engine ZIP` 文件，**不要下载页面底部的源码压缩包**」 |
| 平台标识表 | `windows-amd64` / `windows-arm64` / `macos-arm64` / `linux-amd64` / `linux-arm64`（实际可用文件以发布页为准） |
| 实际体积（GitHub assets，精确字节） | `BOX-Local-Engine-2026.1.4-windows-amd64.zip` = **6,249,492 B（5.96 MiB）**；`macos-arm64` = 6,162,096 B；`windows-arm64` 5.7 MB；`linux-amd64` 6.1 MB；`linux-arm64` 5.6 MB |
| 启动 | 解压后打开 **`BOX3 Engine Launcher`**（Mac 需放入「应用程序」） |
| 关键机制 | 「安装包不需要提前包含所有服务。管理器会按你的选择下载需要的组件，**首次启动时间取决于网速**」 |
| 渠道 | 「普通使用选择正式版；带 staging 的是预发布测试版，带 dev 的是本地开发包」 |
| 数据目录 | 仓库文档：桌面部署数据在「系统应用数据目录中的 `runtime/`」（`runtime/apps/local-engine/`） |

### 2.2 无图形 Linux 服务器

| 项 | 文档原文/数值 |
|---|---|
| 系统 | 「准备 Ubuntu、Debian 或 Alibaba Cloud Linux 3 / 4，以及有 sudo 权限的账号。支持常见的 AMD64、ARM64 架构」；发行包 README 追加「**需稳定的 `/etc/machine-id`**」 |
| 一行命令 | `curl -fsSL https://assets.box3.fun/local-engine/install.sh \| sudo bash` |
| 安装器行为 | 「安装器会准备 Docker、下载服务器包并启动 Web 管理器。此时还没有启动全部创作和游玩服务」；`bootstrap.sh` 注释：「Public bootstrap installer for headless Linux hosts. … the **full offline package** keeps its own installer for image verification and service startup」 |
| 服务器包真实体积 | `https://assets.box3.fun/local-engine/BOX3-Engine-Server-2026.1.4-linux-amd64.zip` = **25,294 B（24.7 KiB）**（`arm64` = 25,306 B）。解压只有 14 个文本文件：`.env.example`、`compose.yml`(27,547 B)、`bootstrap.sh`(19,752 B)、`install.sh`、`start/stop/status/logs/verify.sh`、`SHA256SUMS`、`README.md`、`BOX3-IMAGE-CATALOG.json`、`BOX3-MANAGER-IMAGE.json`、`BOX3-PACKAGE-MODE.json`。**零镜像。** |
| 密钥 | `BOX_SERVER_MANAGER_TOKEN`（登录 Web 部署管理器）、`BOX_PLAY_ADMIN_TOKEN`（登录玩家管理后台），「两种密钥不能互换，也不要发到群聊或公开截图中」 |
| 端口 | 「默认管理端口为 3130。云服务器需在安全组和系统防火墙中允许你的电脑访问这个端口」 |
| 仅 SSH 访问变体 | `curl -fsSL https://assets.box3.fun/local-engine/install.sh -o install.sh` + `sudo BOX3_MANAGER_BIND_IP=127.0.0.1 sh install.sh`，然后本机 `ssh -L 3130:127.0.0.1:3130 用户名@服务器IP` |
| 部署目录与脚本 | 默认 `/opt/box3-engine`；`./status.sh`、`./start.sh`（只启动 Web 管理器）、`./logs.sh play`、`./stop.sh`（停止服务，保留数据） |
| 安装器额外做的事 | 通过 `https://api-ipv4.ip.sb/ip`、`https://ipv4.icanhazip.com` 探测公网 IP；自动 `ufw allow 3130/tcp` 或 `firewall-cmd --add-port=3130/tcp`；Docker 安装源走阿里云镜像（`mirrors.aliyun.com/docker-ce`）；显式拒绝 `podman-docker` 兼容包 |

### 2.3 资源建议值（两处文档数值不同！）

| 来源 | 场景 | CPU | 内存 | 磁盘 |
|---|---|---|---|---|
| `requirements.html` | 小规模游玩服务器 | 4 核 | 8 GB | **30 GB 起** |
| `requirements.html` | 同时运行创作、模型编辑和游玩 | 8 核以上 | 16 GB 以上 | **50 GB 起** |
| 发行包 `README.md` | **仅管理端** | 1 核 | 1 GB | **10 GB** |
| 发行包 `README.md` | 小规模 Play + 玩家服务 | 4 核 | 8 GB | 30 GB |
| 发行包 `README.md` | Creator、VOXA、Play | 8 核以上 | 16 GB 以上 | 50 GB 起 |

> 文档原话：「这些是起步建议，复杂地图和较多在线玩家需要更多资源。镜像、地图、备份会持续占用磁盘。」

### 2.4 纯玩家路线（第三条）
`/local-engine/guide/player-launcher.html`：玩家「不需要安装 Docker，也不需要部署引擎」，下载 `BOX3-Player-Launcher`（标签 `player-v*`）。实测单平台安装包：**Windows x64 `.exe` = 103,363,024 B（98.6 MiB）**（GitHub 精确字节：linux-amd64 AppImage 93.3 MB、linux-arm64 88.2 MB、macos-arm64 dmg 102.0 MB、windows-arm64 92.6 MB；整个 release 16 个 asset 合计 474.6 MB）。仓库文档解释体积来源：「**Electron/Chromium 是主要包体**，工作区依赖会被打包，不复制整个 node_modules」。

---

## 3. 服务拓扑（来自 `compose.yml` + `.env.example` + `first-start.html` 端口表 + `architecture.md`）

Compose 项目名 `box-local-engine`，共定义 **11 个 service**（8 个常驻/按需 + 3 个 `restart: "no"` 的一次性 `*-storage-init` 初始化任务）。默认 `COMPOSE_PROFILES=player-service,auth-portal,creator,play,voxa,server-manager`。

| 服务 | 镜像名 | 容器内端口 | 宿主机映射 | 用途（文档措辞） | mem/CPU/pids 默认 |
|---|---|---|---|---|---|
| `server-manager` | `box-local-engine-server-manager:<tag>` | 3130 | `${BOX_SERVER_MANAGER_BIND_IP:-127.0.0.1}:3130` | **Linux Web 部署管理器**（无 profile，**强制常驻**；注释：「Creator's per-map runtime scheduler depends on this service… otherwise removes it from the project and makes Creator invalid」）；挂载 `/var/run/docker.sock` | 128m / 0.5 / 64 |
| `creator` | `box-local-engine-creator` | 3000（+ 9966/9967） | `127.0.0.1:3127`，另固定 `127.0.0.1:9966`、`127.0.0.1:9967` | **创作端 Creator**（ARENA 地图/脚本/UI 编辑、预览、导出） | 6g / 2.0 / 1024 |
| `play` | `box-local-engine-play` | 3000 | `:3121` | **游玩端 Play**：展示与运行已导入地图，`/p/<publicId>` | 4g / 2.0 / 1024 |
| `player-service` | `box-local-engine-player-service` | 3213 | `:3124` | **身份与权限服务**（账号、封禁、审计、玩家后台 API 宿主） | 256m（compose 兜底 1g）/ 0.5 / 256，`--max-old-space-size=192`（兜底 384） |
| `player-auth-portal` | `box-local-engine-player-auth-portal`（可被 `BOX_AUTH_PORTAL_IMAGE` 替换） | 3214 | `:3125` | **登录门户**（注册/登录/退出/昵称/改密） | 64m / 0.25 / 64，heap 48m |
| `voxa` | `box-local-engine-voxa` | 3001 | `:3123` | **模型编辑器 VOXA** | 1g / 1.0 / 256 |
| `managed-postgres` | `docker.m.daocloud.io/library/postgres:16-alpine` | 5432 | `127.0.0.1:5432` | 内置 PostgreSQL（profile `desktop-postgres`） | 512m / 1.0 / 256 |
| `managed-redis` | `docker.m.daocloud.io/library/redis:7-alpine` | 6379 | `127.0.0.1:6379` | 内置 Redis（profile `desktop-redis`，**可选**） | 256m / 0.5 / 128 |
| `creator-storage-init` / `play-storage-init` / `voxa-storage-init` | 复用各自主镜像 | 无网络（`network_mode: none`） | — | 一次性 chown/mkdir（宿主 bind mount UID 1000 修复），成功后 `Exited (0)` | — |
| 内置 Nginx | 管理器按需下载（**镜像名未在文档中给出 = UNVERIFIED**） | 443 | 「保存配置，按提示安装并启动内置 Nginx」 | 公网共用地址 + HTTPS 证书终结 | — |
| 地图运行时子容器 | 复用 `box-local-engine-play`（`BOX_PLAY_IMAGE=...`；Creator 侧 `BOX_PLAY_IMAGE_ARCHIVE: /app/apps/local-engine/dist/images/play-image.tar`） | 内部 9966（play）/ 9967（edit） | 不对外 | 「独立 Docker」模式时每张地图/房间一个容器；「共享 Node」模式共享进程 | 由「资源组」控制 |

内部 HTTP 依赖（compose 硬编码的 Docker DNS）：`http://play:3000`、`http://creator:9967`、`http://player-service:3213`、`http://voxa:3001`、`http://server-manager:3130`。
源码开发栈额外入口：玩家管理后台开发端口 `http://127.0.0.1:8000/`（`developer-guide.md` / `first-project.md`），登录门户模拟预览 `127.0.0.1:4325`，game-server 调试器 `9223`。
端口速查（发行包 README）：`3130` 管理器 / `3121`+`3125` 游玩与登录门户 / `3124` Player Service / `3127`+`3123` Creator+VOXA / `5432`+`6379` 数据库与 Redis / 「内部运行时端口：地图状态与脚本，不直接对外开放」。

**权威运行时**（`docs/architecture.md`）：`Creator/Play → game-server（权威实体与体素、脚本隔离、storage、反作弊）`；`Play/Creator/VOXA/门户 → Player Service → PostgreSQL`；`部署管理器 → Docker → 子运行时`。管理器界面是 Tauri（桌面）+ Rust HTTP 后端（Web），共享规则在 Rust 库 `manager-core`。

---

## 4. 许可证机制

**决定性结论：当前发行版已没有任何许可证/激活机制。**

1. GitHub Release `v2026.1.4`（发布时间 2026-10-16，正文日期 2026-10-17）第「使用与许可」节原文：
   > 「**采用 MIT 许可，移除激活、设备绑定和到期限制。**」
   
   即：激活（activation）、设备绑定（device binding）、到期（expiry）**在旧版本中确实存在，v2026.1.4 起被移除**。这是本车道对「能否私有化部署」最重要的结论。
2. 仓库与发行包均为 MIT：`LICENSE.md` = 「MIT License / Copyright (c) 2026 深圳奇梦岛科技有限公司」；发行包内 `distribution/LICENSE.txt` 同一文本，并被 `COPY` 进每个运行镜像（`/app/LICENSE`），镜像 label `org.opencontainers.image.licenses="MIT"`。GitHub API `license` 字段 = `{"key":"mit","spdx_id":"MIT"}`。
3. 官方仓库 README 的许可声明原文：「本仓库采用 MIT License。第三方组件、字体、图片、模型和其他资源可能受各自许可约束，不会仅因存放在本仓库中就自动获得 MIT 授权。**BOX3 名称、品牌、图标及相关商标也不包含在 MIT 授权内**。」另外：「本项目基于 BOX3 UGC 平台的引擎研发基础拆分整理。平台（内部称为 `boxs`）**不是本仓库的开源依赖，也不属于本仓库的发行内容**。」
4. `machine-id`：**唯一残留**。`distribution/server/README.md` 原文「推荐 Ubuntu、Debian 或 Alibaba Cloud Linux 3 / 4，**需稳定的 `/etc/machine-id`**」。但在 `bootstrap.sh`、`install.sh`、`compose.yml`、`.env.example` 全文检索 `machine` **零命中**，用途与读取方（推测为 Rust server-manager 或 player-service 的部署实例身份）在文档中没有说明 → **UNVERIFIED**。
5. 离线镜像：`BOX3-PACKAGE-MODE.json` = `{"mode":"slim","channel":"production","version":"2026.1.4","imageTag":"v2026.1.4-linux-amd64","platform":"linux/amd64"}`；`install.sh` 逻辑区分 `"local"` 模式（缺归档直接报「本地镜像归档缺失或损坏，请重新生成本地测试包」）与联网模式；脚本还会 `rm -f box-local-engine-images-v*-linux-*.tar.gz box3-engine-play-server-images-v*-linux-*.tar.gz`，注释「**New server packages keep only manifests. Remove full archives left by older packages**」→ 历史上存在「完整离线包」，现在改为 slim + 按需下载。CDN 上 `BOX3-Engine-Server-2026.1.4-full-linux-amd64.zip`、`box-local-engine-images-v2026.1.*-linux-amd64.tar.gz` **均 404**（已实测）。仓库中存在离线打包脚本入口（文件名即文档级证据）：`scripts/build-desktop-offline-installer.js`、`scripts/package-offline-images.js`、`scripts/verify-desktop-offline-package.js`、`scripts/check-windows-offline-installer.js`。
6. 密钥体系（非许可，是运维密钥）：`install.sh` 用 `openssl rand -hex 32`（无 openssl 则 `od -An -N32 -tx1 /dev/urandom`）一次性生成 5 个 256-bit 随机密钥写入 `.env`（权限 `chmod 600`）：`PERMISSION_TOKEN_SECRET`、`BOX_PLAYER_AUTH_API_KEY`、`BOX_PLAY_ADMIN_TOKEN`、`BOX_SERVER_MANAGER_TOKEN`、`BOX_RUNTIME_MANAGER_TOKEN`（后者另加 `BOX_MODERATION_SIGNING_SECRET`）。`ensure_secret()` 在升级时会为缺失/占位/短于 32 字符的值重新生成。
7. 会话与令牌有效期（架构文档）：一次性登录码 **60 秒、仅兑换一次**；浏览器校验状态 **5 分钟**；`BOX_SESSION_TTL_MS=60000`；`BOX_RUNTIME_IDENTITY_TTL_MS=300000`；`BOX_SERVER_MANAGER_TOKEN` 在 compose 注释里被描述为「independent 256-bit management token」。
8. **能否纯离线运行？——服务端可以，玩家端不行。**
   - 服务端：`distribution/play/README.md` 给出完全离线的「独立 Play 分发」路径：`docker image load --input play-image.tar` + `docker image load --input player-service-image.tar` + `docker compose up -d`，**无需源码、无需 Node.js**，且「两个镜像可独立更新」。
   - 玩家侧限制：`root-README.md`「**首次安装和镜像下载需要联网**；完全离线的地图应选择『仅本地资源』，引用对象存储的地图仍需访问相应资源地址」；`player-launcher.html`「**缓存用于加快加载，不代表可以离线运行游戏**」；`troubleshooting.html`「**缓存加速不等于离线游玩；服务器必须保持运行**」；启动器 README「启动器不支持离线导入 `.boxplay`」。
   - 安装器强绑外网：`install.sh` 需 `assets.box3.fun`（包+镜像）、`mirrors.aliyun.com`（Docker CE）、`api-ipv4.ip.sb` / `ipv4.icanhazip.com`（公网 IP 探测）。

---

## 5. 创作 → 导出 → 导入 → 开服 → 玩家连接（数据流与文件格式）

官方 mermaid 原文（`docs/first-project.md`）：
```
Account[注册玩家并授予创作权限] -> Edit[Creator 编辑 / VOXA 建模]
Edit -> Preview[预览与运行脚本]
Preview -> Backup[导出 .boxproject：可编辑备份]
Preview -> Publish[导出 .boxplay：发布快照]
Publish -> Import[玩家后台导入 Play]
Import -> Play[两名玩家进入同一地图]
```

| 对象 | 名称/扩展名 | 定义（文档原话） | 生成入口 | 消费入口 |
|---|---|---|---|---|
| 可编辑工程 | **`.boxproject`** | 「Creator 的工程」/「导入 Creator，继续编辑」/「以后继续编辑和迁移的备份」 | Creator 作品列表「更多操作 → 导出」→「导出本地图工程」或「导出地图组工程」 | Creator「导入工程」，可选「作为独立地图组」 |
| 发布游玩包 | **`.boxplay`** | 「导入 Play，供玩家游玩」/「保存的是发布时的**快照**，后续编辑不会自动更新它」/「**不含可编辑 `source/`**」 | 主地图「更多操作 → 导出 → 导出游戏包」，填版本号（首次 `v1.0.0`），选「仅本地资源」（无需对象存储） | 玩家后台「游玩管理 → 游玩地图 → **导入游玩包**」 |
| 模型工程 | **`.voxaproject`** | 「`.voxaproject` 用于模型工程导出；旧包缺少 mesh 等资源时，需打开后重新保存」（`apps/voxa/README.md`） | VOXA 保存 / 导出 | VOXA 导入；模型经项目模型库被地图引用 |
| 地图组 | 主地图 + 副地图 | 「一个地图组包含一个主地图，以及按需添加的副地图」，「同组地图可以共用组资源和组数据」 | Creator 内创建 | Play 侧以地图组为单位「开放」 |
| 资源单元 | **blob** | 「按内容哈希定位的资源或序列化数据」；HTTP 接口 `GET /block/{hash}` | 引擎内置 `apps/local-engine/data/blobs/` | 运行时 `/block/:hash`；Play 资源存储只读，`POST /block` 返回 403 |
| 标识 | 工程 ID / **永久地图 ID** / 访问 ID(publicId) | 「永久地图 ID = 稳定的地图与存储标识」；「访问 ID / publicId = `/p/<publicId>` 中可修改的 URL 名称」；CLI 强调「不能用地图名称、临时 hash 或展示 ID 代替」 | Creator/后台 | `apc project bind <permanentMapId>`；游玩地址 `http://127.0.0.1:3121/p/<publicId>` |
| 格式版本 | **play-format `7`** | 镜像 label：`org.box.local-engine.play-format="7"`、`org.box.local-engine.player-service-format="7"` | 构建期写入 | 兼容性判定 |

磁盘目录（Docker 部署，`BOX_DATA_DIRECTORY` 即 `/opt/box3-engine`）：
`apps/local-engine/{projects,play-worlds,data,backups,dist}`、`apps/voxa/data`；命名卷 `box-play-runtime-cache`、`box-managed-postgres-data`、`box-managed-redis-data`。源码开发则统一在 `.local-data/`（Git 与镜像构建都忽略）。

**文档中所有与「大小」相关的硬限制**（`.boxplay` / `.boxproject` 本身**没有**体积上限，→ UNVERIFIED）：
- `apc script upload` 「内容最大 **20 MiB**」（CLI 文档原文）
- 登录门户后端「JSON 限 **32 KiB**」
- `VOXA_MAX_BLOB_BYTES` 默认 **268435456 = 256 MiB**
- 单个体素模型部件数上限 **128**（建议 ≤50）；斜面「尽量少于 5 格像素」
- 地图尺寸新建时可选「小（**32×32×32**）」（first-project 教程示例）
- 玩家账号约束：用户名 3–32 位字母开头；昵称 1–32 位；新密码 10–128 位；管理员初始密码 ≥12 位；服主令牌 ≥16 字符
- 数据空间记录：`apc storage list --limit` 取值 1–100，默认 50；`--scope project|group`

---

## 6. 网络与访问（三种场景，文档给出的具体做法）

全部入口在「数据配置 → 访问设置」，「保存后，以服务卡片显示的最终地址为准」。

1. **本机**：「选择『本机』。浏览器和引擎运行在同一台电脑上即可，不需要域名或证书。**127.0.0.1 只能指向正在使用的这台电脑，不能发给其他玩家**。」
2. **局域网**：确认在同一 Wi-Fi/内网/互通 VPN → 选「局域网」→ 核对显示的是引擎电脑的内网 IP → 保存 → **重新启动受影响的服务** → 其他设备用形如 `http://192.168.1.20:3121` 的 Play 地址；「打不开时检查电脑防火墙」。实现细节：`BOX_LAN_IP` 由 install.sh 用 `ip route get 1.1.1.1` / `hostname -I` 探测后写入 `.env`，容器内无法自探测。
3. **公网**（先决条件）：有外网可达的服务器；**域名解析到公网 IP**；**准备覆盖该域名的 HTTPS 证书与私钥**；安全组+系统防火墙放行入口端口（HTTPS 通常 443）。文档反复强调「域名解析只负责把域名指向服务器，**不会自动配置 HTTPS 或启动网站**」。
   - **方式一：公网共用地址**（推荐首次开服）：填 `https://engine.example.com` + 上传证书私钥，为每个服务分配**入口路径**：

     | 服务 | 入口路径 | 最终地址示例 |
     |---|---|---|
     | Play | `/play` | `https://engine.example.com/play` |
     | Creator | `/creator` | `https://engine.example.com/creator` |
     | VOXA | `/voxa` | `https://engine.example.com/voxa` |
     | 玩家管理后台 | `/admin` | `https://engine.example.com/admin` |
     | 登录页面 | `/login` | `https://engine.example.com/login` |
     
     然后「保存配置，按提示**安装并启动内置 Nginx**，再次保存应用公网配置」。坑：「如果配置了 `/play`，只打开域名根可能返回 404 … 需要直接打开域名就进入 Play 时，可以将 Play 的入口路径留空；**同一入口下不能给多个服务都留空**」。
   - **方式二：公网独立地址**：Play 用 `https://play.example.com`、门户用 `https://login.example.com`，各自配证书；「登录门户、Play 和 Creator **不必使用同一个域名**」；跨源登录靠浏览器顶层跳转 + 一次性登录码，**不依赖第三方 Cookie**。
   - 外部 Nginx 属于高级配置（v2026.1.4 起支持「指定证书路径、自动检测证书变更并重载」「直接编辑 Nginx 配置，保存前校验语法」）；「首次部署建议使用内置模式」。
4. **改地址后的核对清单**：用卡片显示的**完整地址**（保留 `https://`、端口和入口路径）→ 玩家账号登录 → 打开 Play/Creator → 「地址改动后，重新登录；**玩家启动器里保存的服务器地址也要更新**」→ 提示「配置已保存但入口尚未生效」时先启动 Nginx 再保存。
5. **给玩家发哪个地址**（`play-maps.html`）：浏览器玩家可发某张地图的完整游玩地址；玩家启动器只发 Play **首页**地址（如 `https://engine.example.com/play`）；「**不要发送部署管理器、玩家后台或数据库地址**」，也不要发管理器的 3130 或某地图的 `/p/…` 链接。
6. 安全边界（`security.html` + README 端口表）：管理端口 3130 应限制为自己 IP 或 SSH 隧道；「**不要为了方便连接而开放数据库、Redis 或 Docker 管理接口**」；「管理器可访问 Docker Socket，**管理权限等同于控制宿主机**」；`BOX_TRUST_PROXY` 默认 `false`；Creator/VOXA 的 `*_BIND_IP` 默认 `127.0.0.1`，9966/9967 只绑 `127.0.0.1`（注释：「Never expose raw edit/preview sockets on LAN/public interfaces」）。

---

## 7. 脚本 / API 面 —— 本车道核心结论：**游戏逻辑本身就是 JavaScript**

### 7.1 「脚本 API」官方文档站是死链
顶栏「脚本 API」指向 `https://docs.box3lab.com/api/`，实测 `/api`、`/api/`、`/api/index.html`、`/api.html`、`/apis/`、`/sdk/`、`/reference/`、`/arena/api/`、`/arenapro/zh/api/`、`/openapi.json` **全部 404**。真实的脚本 API 文档分散在 `arena/javascriptDaoAPI/*` + `arena/javascriptEntry/*`，HTTP API 契约以生成物 `internals/apis/openapi/openapi.json` 形式存在。API 参考文档目前只能本地生成：`npm run api:docs`（「启动本机参考文档，地址以日志为准」）。→ **公开 API 文档缺位 = UNVERIFIED 项较多。**

### 7.2 脚本语言与模块系统（`arena/core/client-server-modules.html` 原文）
> 「在 Arena 地图中进行游戏开发时，你需要与两种不同的脚本环境进行交互：客户端（Client）和服务端（Server）。这两种环境使用不同的 JavaScript 模块系统」
> - 「客户端：运行在玩家的设备上…**它使用 ES Modules (MJS)**。」
> - 「**服务端：运行在服务器上，处理核心游戏逻辑，如玩家数据、物理计算和游戏规则。它使用 CommonJS (CJS)。**」

对照表（原文照抄）：

| 特性 | ES Modules (MJS) - 客户端 | CommonJS (CJS) - 服务端 |
|---|---|---|
| 导入 | `import ... from '...'` | `const ... = require('...')` |
| 导出 | `export` / `export default` | `module.exports = ...` |
| 加载方式 | 异步 | 同步 |
| 环境 | 浏览器 / 现代 JS | **Node.js** / 传统服务端 |

服务端脚本示例文件为 `utils.cjs`、`player.cjs`，「CommonJS 是 **Node.js 环境中**传统的模块系统」。

### 7.3 脚本 API 契约（换运行时必须兼容的接口面）
- 入口文件名：服务端 **`index.js`**，客户端 **`clientIndex.js`**（`javascriptDaoAPI/02`）；文档前缀约定 **`S-`（服务器）/ `C-`（客户端）**。
- **注入的全局对象，创作者「不需要 import 或 require 任何东西」**：`world`（世界/实体/玩家/全局事件）、`ui`（客户端 UI）、`storage`（服务端持久化，「就像一个小型数据库」）、`remoteChannel`（C↔S 通信）。
- 文档中出现的具体 API 形状（必须逐条复刻的最小兼容集）：
  - `world.onPlayerJoin(({ entity }) => {})`、`world.onPlayerLeave`、`world.onChat`、`world.onTick(...)` 返回带 `.cancel()` 的订阅对象、`world.say(...)`、`world.createEntity()`、`world.voxels.setVoxel(x,y,z,0)`、`world.teleport(mapId, players, serverId?)`、`world.moderation`
  - `entity.destroy()`、`entity.isPlayer`、`entity.onVoxelContact(({x,y,z})=>{})`、`entity.player.name`、`entity.player.dialog<GameTextDialogParams>({type: GameDialogType.TEXT, title, content})`、`entity.player.directMessage(text)`
  - `remoteChannel.sendServerEvent({eventName, ...})` / `sendClientEvent(playerEntity, {...})` / `onServerEvent(handler)`（`event.entity`、`event.args`）/ `onClientEvent(handler)`
  - 客户端：`UiBox.create()`、`UiText.create()`、`.name`、`.textContent`、`.textFontSize`、`.textColor.copy(Vec3.create({r,g,b}))`、`.backgroundColor.copy(...)`、`.anchor.copy(Vec2.create({x,y}))`、`.position.offset.copy(...)`、`.size.offset.copy(...)`、`.parent = ui`、`.pointerEventBehavior = 2 // 2 = CLICK`、`.events.on("pointerdown", ...)`；元素类共 8 个（`UiNode`/`UiRenderable`/`UiBox`/`UiText`/`UiInput`/`UiImage`/`UiScrollBox`/`UiScreen`）；数学类型 `Vec2`/`Vec3`
- 脚本类型声明（DTS）来源与同步机制：`packages/script-api`（`src/client/` 12 个模块：`dom, events, http, input, math, media, navigator, pointer-lock, remote, screen, ui, world`；`src/server/` 13 个模块：`anticheat, entity, error, events, http, math, moderation, motion, navigator, player, rtc, storage, world`）；`world.moderation` 从 `internals/schema/api/js/moderation.ts` 同步。创作者用 `apc map resource --type dts` 拉取「客户端与服务端 DTS」（**不需要 Profile 或 Token**）。
- **脚本在隔离环境中执行，且明确不是通用 Node/浏览器**：`internals/schema/api/js/README.md` 原文「地图脚本响应玩家与世界事件，修改服务端实体和体素状态，**在隔离环境中执行**」；「**不能将浏览器 DOM 或任意 Node.js 模块当作脚本环境能力**」。脚本堆内存 `BOX_SCRIPT_HEAP_MB=512` / `SCRIPT_MEMORY_LIMIT=512`。
- 安全语义（多处强调）：「包内脚本在**预览时不会运行**；玩家进入地图后，游戏才会按脚本运行」；「导入 `.boxplay` 前，查看地图与脚本预览。预览不会执行脚本，但**运行游戏时会执行**」。
- ArenaPro 官方 TS 工作流（`typescript-vs-javascript.html` 原文）：「**游戏引擎只认识 .js**」；按下 Alt+Q 后 ArenaPro「把我们所有的 .ts 代码编译、打包成一个游戏引擎认识的、合并好的 JavaScript 文件，通常命名为 **`_server_bundle.js` 或 `_client_bundle.js`**」→ 自动上传 → 在 `index.js` 里写 `require("./_server_bundle.js");` 来加载。HMR 与完整构建的区别：完整构建 = 「TypeScript 编译 (TSC) → **Webpack 打包**」。脚手架本身基于 **Vite**（`apc project create` 生成「BOX Creator Vite 工程」）。**纯 JavaScript 仍然被支持**：「你完全可以只编写 .js 文件。ArenaPro 的编译工具链同样支持纯 JavaScript」。

### 7.4 HTTP API 能力边界（`internals/apis/openapi/openapi.json`）
- 元信息：`title: "BOX3 Local Engine API"`，`version: "0.2.0"`，`description: "Creator、Play、Player Service 与玩家管理共用的本地引擎 HTTP 接口。"`，文件 **475,841 B**，**137 个 path**。
- 按 tag 分组：`服务器管理`（`/api/health`、`/api/commands/{name}`、`/api/backups/*`、`/api/diagnostics/*`、`/api/operations/{id}`、`/api/runtime/ensure`、`/api/runtime/{container_id}`、`/api/runtime/{id}/stats`、`/api/system/{backups,status}`）、`Creator CLI`（`/api/creator/v1/*`：health、projects、projects/{id}/{resources,runtime,runtime/events,scene/{session,capture,action,actions/{requestId}},scripts,scripts/{side}/{entry},storage/{scope}/{space}}）、`Creator 工程`（`/api/local-projects*`，含 `/{id}/{export,package,publish,maps,snapshots,runtime,asset-distribution}`）、`玩家管理`（`/api/play-admin/*` 30+ 条：admins/permission-groups/players(含 batch/export/overview)/worlds/containers/container-resource-groups/identity-bans/import/library/maintenance/owner-session/script-moderation/status/verify）、`游玩端`、`玩家认证`、`登录门户`（6 个 `/api/auth/*`）、`玩家内部接口`（`/api/player-internal/*`）、`地图运行时`（`/__local_runtime/{start,stop→destroy,status}`、`/api/session`、`/api/server-info`、`/api/createSession`、`/api/project-scripts`、`/block/{hash}`）、`VOXA`（`/api/local/{models,blobs,default-skin,project-models}`）、`Creator 模型`、`创作端`、`引擎公共接口`。
- 明确的能力边界（`services/game-server/README.md`）：健康检查 `/api/health-check`；资源读取 `/block/:hash`；「**Play 资源存储只读，`POST /block` 返回 403**」；「`/api/session`、`/api/server-info` 为兼容直连接口，仅在显式设置 `BOX_DIRECT_SESSION_API=true` 时开放」；「玩家浏览器必须下载场景可见资源；**秘密、授权与重要业务逻辑保留在服务端**」。
- 浏览器引擎构成（`apps/game/src/engine/README.md`）：`game-client.ts`、`net/`、`remote-channel/`、`gl/`、`gpu/`、`mesh/`、`voxel/`、`input/`、`camera/`、`player/`、`gui/`、`game-ui/`、`script/`、`sound/`、`environment/`、`effect/`（vendored 依赖含 `regl`、`ao-mesher`、`mudb`、`vb-parser`）。Play 构建「移除编辑器、Monaco 和工程写入入口」。
- 登录门户可独立实现/替换（`apps/player-auth-portal/docs/API.md`）：只代理固定 6 个操作 `/api/player-auth/{login,register,session,logout,profile,password}`，请求头 `X-Box-Player-Auth-Key`，转发 Cookie 名 `box_local_player_session` / `box_local_player_device`，必须逐条转发 `Set-Cookie`（Node 22 `headers.getSetCookie()`），镜像监听 `0.0.0.0:3214`，非 root、`read_only` + tmpfs，`GET /api/health-check`。

### 7.5 CLI 能力（`arenapro/zh/cli/guide/cli-commands.html`）
- CLI 名 **`apc`**（ArenaPro CLI），npm 包 **`@box3lab/arenapro-cli`**，最新 **0.7.0**，解压后 **1,413,641 B（1.35 MiB）**，依赖仅 9 个（`cac, axios, chalk, i18next, node-rsa, env-paths, form-data, eventsource-parser, @jridgewell/trace-mapping`）。
- 安装：`npm install -g @box3lab/arenapro-cli`（支持 pnpm/yarn/bun），「请确认你的电脑已安装 **Node.js 22 或更高版本**」，验证 `apc -v`。
- 命令面：`apc project create|bind|info`、`apc map list|resource`、`apc profile add|list|test|remove`、`apc script get|upload`、`apc storage list|get|set|delete`、`apc runtime status|start|restart|stop|logs`、`apc scene capture`、`apc package list`、`apc docs`。自动化建议加 `--json`。
- 连接本地引擎：**`apc profile add local --endpoint 127.0.0.1:3127 --token "$BOX_CREATOR_TOKEN"`**（局域网可省协议，公网必须 `https://`）；工程 `.env` 只存 `VITE_BOX_CREATOR_PROFILE` 与 `VITE_BOX_CREATOR_PROJECT_ID`，Token 存本机凭据或 CI Secret。
- `apc map resource --type dts|assets|all`（+ `--ui-prefix`）；`apc script upload <projectId> <side> <entry> --file <path>`（≤20 MiB，返回 `side/entry/revision`）；`apc runtime logs` 是「订阅实时 **SSE** 控制台」，CLI 会用本地 `dist/` 的 sourcemap 把异常堆栈**映射回 TypeScript**；`apc package list` 查询 npm 上 **`@dao3fun`** 组织的扩展包。
- 另有 **MCP 服务**：`http://localhost:25315/ap-mcp`（SSE 类型），可被 VS Code / Trae / Claude / Cursor / Windsurf / Cline / Cherry Studio 接入。

---

## 8. 量化「重」的全部文档级证据

### 8.1 镜像体积（权威数字：发行包 `BOX3-IMAGE-CATALOG.json` 的 `size` 字段 + CDN `HEAD Content-Length` 双向核对，二者一致；单位是 **.tar.gz 压缩归档字节**）

| 镜像 | 归档字节 | MiB |
|---|---|---|
| `box-local-engine-creator` | 263,029,978 | 250.8 |
| `box-local-engine-play` | 240,669,370 | 229.5 |
| `box-local-engine-player-service` | 203,712,541 | 194.3 |
| `box-local-engine-voxa` | 182,383,424 | 173.9 |
| `box-local-engine-player-auth-portal` | 86,925,875 | 82.9 |
| `box-local-engine-server-manager` | 83,924,951 | 80.0 |
| **六镜像压缩合计** | **1,060,646,139** | **1,011.5 MiB ≈ 0.99 GiB** |

- `docker load` 后未压缩占用 **UNVERIFIED**（文档未给；经验上 gzip tar 展开 2–3×，即约 2–3 GiB，需实测确认）。
- 6 个镜像的 `imageIds` 各含 **2 个** ID（说明每个服务镜像由内容镜像+派生标签组成）。
- 构建溯源信息全在清单里：`platform: linux/amd64`、`createdAt: 2026-10-16T13:4x~13:55Z`、`sourceRevision: 06b0b47cbcdfae610c87b77833153b48ce61318b`、`buildSource: github-actions`、`formatVersion: 2`。

### 8.2 安装包 / 下载体积
- 桌面部署管理器 ZIP：**5.6–6.1 MB/平台**（Tauri 壳，「安装包不需要提前包含所有服务」）。
- Linux 服务器 ZIP：**25,294 B**（纯清单）；`install.sh`：**19,752 B**；`latest.txt`：**9 B**。
- 首次联网实际要拉的总量 = **1,011.5 MiB 压缩镜像 + 24.7 KiB 清单 + 19.3 KiB 安装器**；服务器包**只内置 server-manager 一个镜像归档**（80.0 MiB），其余 5 个业务镜像「按需下载」（`running_application_services()` 只恢复 player-service/player-auth-portal/creator/play/voxa，注释「缺少的镜像会按需下载」）。
- 玩家启动器安装包：**88.2–102.0 MB**（Electron/Chromium 为主体）。

### 8.3 硬件与进程数量
- 最低配置档位：仅管理端 1 核/1 GB/10 GB；Play+玩家服务 4 核/8 GB/30 GB；全套创作 8 核/16 GB/50 GB 起。
- compose 声明的资源上限合计（全 profile 打开时）：Creator **6g** + Play **4g** + VOXA **1g** + Postgres **512m** + Player Service **256m** + Redis **256m** + server-manager **128m** + auth-portal **64m** = **≈12.06 GiB 内存上限**，CPU 上限合计 ≈ 7.75 核 —— 与「16 GB 以上」建议值相互印证（文档措辞：「资源上限以 `.env.example` 为准」）。
- pids_limit：Creator 1024、Play 1024、其余 64–256。
- 必须常驻：`server-manager`（**无 profile，唯一无条件服务**，且 Creator/Play 都 `depends_on: server-manager: condition: service_healthy`）+ Player Service（账号/权限）。地图运行时数：`BOX_PLAY_MAX_RUNTIMES=8`（Play）、`BOX_CREATOR_EDIT_MAX_RUNTIMES=6` + `BOX_CREATOR_PLAY_MAX_RUNTIMES=4`（Creator），`BOX_PLAY_PREWARM_RUNTIMES=0`（README 建议小服务器设 0），空闲回收 `BOX_RUNTIME_IDLE_TIMEOUT_MS=900000`（15 分钟），启动超时 `1800000`（30 分钟），房间上限 `BOX_TELEPORT_MAX_ROOMS=64`，`BOX_LOCAL_PLAYER_LIMIT=70`。
- 健康检查密度：每个镜像都有 `HEALTHCHECK --interval=15s --timeout=5s --start-period=20~25s --retries=5`（用 `node -e fetch(...)`，即**每个容器都跑一个 Node 进程**），server-manager 用 `/app/server-manager --healthcheck`（Rust 二进制，interval 5s / retries 12）。
- **是否要求 Docker**：**是。**「运行只需 Docker Engine 和 Compose v2，无需源码、Node.js 或 Rust」；`install.sh` 硬校验 `docker info` 与 `docker compose version`，拒绝 podman 兼容包；管理器需挂载 `/var/run/docker.sock`（「管理权限等同于控制宿主机」）。地图容器、Nginx、Postgres、Redis 全部以容器交付。桌面版还需 Docker Desktop + WSL 2。
- **是否必须 Postgres/Redis**：**PostgreSQL 必须**（`developer-guide.md`：「**Player Service 必须连接 PostgreSQL**」；`first-start.html`：「PostgreSQL 用于保存玩家账号和游戏数据」；内置或外部二选一，schema 分 `box_engine` / `box_identity`，`BOX_DATABASE_POOL_SIZE=4`）；**Redis 可选**（`BOX_REDIS_MODE=disabled` 默认；「Redis 首次使用可以关闭；有需要时再启用」；用途仅会话/限流/缓存，`STORAGE_CACHE_REDIS_TTL=240`；架构文档警示「**本地回退不能代替玩家身份数据库**」）。
- 独立轻部署出口：`distribution/play/README.md` 给出「**只要 Play + Player Service 两个 tar 镜像 + Compose + PostgreSQL**」的最小分发路径（不需要创作端、管理器、VOXA、Node、源码），并明确「**增加地图不重建镜像**」「两个镜像可独立更新」。这是文档自带的、唯一可引用的轻量化先例。
- 构建侧复杂度（佐证引擎体量）：Rush 单仓 **9,616 个 tree 条目 / 8,486 个 blob**，`apps/game + apps/local-engine + apps/voxa + apps/player-admin + apps/player-auth-portal + apps/deployment-manager(Tauri) + apps/server-manager-rust + apps/manager-core + apps/player-launcher(Electron) + services/game-server + internals/{apis,schema,env,build-system} + packages/{script-api,sdk,cli,mudb,regl,ao-mesher,vb-parser,player-policy,realtime-client,deployment-routing,voxa-project,box-design,content-utils…}`；基础镜像 `docker.m.daocloud.io/library/node:22.17.0-bookworm-slim`；`NODE_OPTIONS=--max-old-space-size=8192` 才能构建；运行镜像另装 `tini ca-certificates iproute2 iptables`（说明**地图容器需要容器内网络规则**）；Play 镜像 `org.box.local-engine.play-format="7"`。

---

## 9. 版本号与更新机制的全部线索

| 主题 | 证据 |
|---|---|
| 版本格式 | 「正式版本取分支名，采用 **`YYYY.N.P`**：`release/v2026.1.5` 生成引擎与部署启动器 `2026.1.5`，`player-release/v2026.1.3` 生成玩家启动器 `2026.1.3`」。Release note 亦称「**版本号改用年份编号**，正式版本与源码提交固定对应」 |
| 当前版本 | 引擎 **2026.1.4**（`https://assets.box3.fun/local-engine/latest.txt` 内容 = `2026.1.4`，9 B）；Tag `v2026.1.4`（commit `a35455d814`），发布 2026-10-16；玩家启动器 **2026.1.2**（Tag `player-v2026.1.2`，commit `e6d2cc2ef967765ef4068a6c0b04d12f478b02ef`）。仓库只有这 2 个 tag |
| latest.txt 机制 | `bootstrap.sh` `resolve_version()`：`BOX3_VERSION` 环境变量可钉版本，否则 `curl -fsSL ${RELEASE_CDN_URL}/latest.txt` 并剥掉前导 `v`；校验字符白名单 `[0-9A-Za-z._-]`。CDN 基址可用 `BOX3_RELEASE_CDN_URL` 整体替换（**自托管镜像仓库的官方后门**） |
| 包名格式 | `BOX-Local-Engine-<ver>-<platform>.zip`（桌面，5 平台）、`BOX3-Engine-Server-<ver>-linux-<arch>.zip`（服务器，2 架构）、`BOX3-Player-Launcher-<ver>-<platform>.{exe,dmg,AppImage}`、镜像归档 `box-local-engine-image-<service>-<arch>-<sha256>.tar.gz`、镜像标签 `v<ver>-linux-<arch>`（`BOX_IMAGE_TAG`） |
| 渠道 | `production` / `staging` / `dev`；`BOX3-PACKAGE-MODE.json` 记录 `{mode, channel, version, imageTag, platform}`，`mode` 观测到 `slim` 与 `local`；`local-engine-staging/latest.txt` 实测存在（17 B）；「本机执行 `package:images`/`package:desktop`… 统一生成 `dev` 包，与当前检出分支无关。引擎版本为 `2026.1.4-dev`」；「带 dev 的开发包**不检查线上更新**」；「预发布后缀属于实际应用版本，不只是 ZIP 名称」 |
| OSS 目录隔离 | `local-engine/v<版本>/`（正式）、`local-engine-staging/v<版本>-staging/<commit>/`（预发布，**清单固定到源码提交**）、`local-engine/` 与 `local-engine-staging/` 为分发与 latest；玩家包 `box-player-launcher/player-v<版本>/`。实测 `https://assets.box3.fun/local-engine/v2026.1.4/BOX3-Engine-Server-2026.1.4-linux-amd64.zip` = **200** |
| 下载与校验 | 每个归档带 `sha256` + `size`，`install.sh` 走 `curl -fL --retry 2 --progress-bar -C -`（**断点续传**），下载后双校验「SHA 相同 **且** 字节数完全相等」，失败即 `rm` 重来；`verify.sh` = `sha256sum -c SHA256SUMS`（macOS 用 `shasum -a 256`）；导入后再次校验镜像 `Architecture` 与 `Id` 一致性（`docker image inspect`），并 `docker image rm` 临时 content tag |
| 更新入口 | 桌面/服务器：部署管理器「**关于 → 检查更新**」，「按提示下载并更新」，「等待更新和服务启动完成，**不要中途关闭 Docker**」；「Linux Web 管理端支持在线更新」（v2026.1.4 新增）；「支持检测、下载更新并重启升级，保留现有数据，**可选择清理旧镜像**」；「识别并复用已有服务镜像，减少重复下载和导入」；「本地镜像归档缺失或损坏，请重新生成本地测试包」（local 模式） |
| 升级注意事项 | 先做文件与数据库备份、**记录当前版本**；`cp -a` 覆盖安装**不覆盖 `.env`**（只更新 `BOX_IMAGE_TAG`、`BOX_PLAY_PLATFORM`，其余操作者状态保留），失败时回滚 `.env`；「不要为已有数据卷随意更换密码」「已有数据库卷的密码不会随 `.env` 修改而自动改变」；「不支持在线更新或需要换设备时，下载新的正式安装包，按提示迁移；**不要直接删除旧数据目录**」；「**引擎与玩家启动器独立更新**，登录门户使用自定义镜像时也需同步更新配套版本」；「自定义镜像不会随引擎更新自动换新版，需重新打包+新 tag+管理器替换」；「回滚前确认旧镜像与**数据格式**兼容」（play-format=7）；升级后会 `docker image rm` 上一版 5 个服务镜像与旧 manager 镜像，并由**分离式 update helper** 等 helper 退出后再回收层；若同版本同 SHA256SUMS 则「跳过镜像下载和更新，直接启动管理器」 |
| 发布流水线 | `release.yml`（引擎）、`player-launcher-release.yml`（玩家）、`verify.yml`（格式/语法/风格，不打包）、`package-server.yml`（补打 Linux 包，复用已发布应用镜像，只重建 Web 管理器镜像）、`release-branch-created.yml`（按分支名路由）；配置项 `ALIYUN_OSS_BUCKET/ENDPOINT/ACCESS_KEY_ID/ACCESS_KEY_SECRET`；「一个正式版本只能对应一个提交」 |
| 运维脚本 | `/opt/box3-engine`：`status.sh`、`start.sh`（仅管理器）、`stop.sh`（保留数据）、`logs.sh <服务名>`（可选 `server-manager`/`player-service`/`managed-postgres`…）、`install.sh`（校验+准备管理器镜像+启动，不覆盖配置） |
| Node/依赖版本钉 | `package.json` `"engines": {"node": "22.17.x"}`；compose 构建参数 `NODE_IMAGE=…/node:22.17.0-bookworm-slim`、`DOCKER_CLI_IMAGE=…/docker:27.5.1-cli`、`RUST_IMAGE=…/rust:1.93-bookworm`；README 徽章 `Node.js 22.17` / `Rust 1.93.0` / `Docker Compose v2`；Rush + pnpm 锁定（`common/config/rush/pnpm-lock.yaml`） |

---

## 10. 未确认项清单（UNVERIFIED，需其他车道或实测补齐）

1. `docker load` 后各镜像的**未压缩磁盘占用**与总占用（文档只给 tar.gz 压缩字节）。
2. `https://docs.box3lab.com/api/`「脚本 API」文档树整棵 **404**，公开 API 参考文档目前不存在；`/api/creator/v1/*` 之外的运行时私有协议（WebSocket/SSE 帧格式、`remoteChannel` 线协议、`/block/{hash}` 编码）文档层面无描述。
3. `.boxplay` / `.boxproject` 的**内部文件结构与体积上限**：文档只给扩展名、语义（快照 vs 可编辑、不含 `source/`）和「不要手工改包内清单」；单个游玩包最大字节数、地图体素总量上限均无文档数值。
4. `/etc/machine-id` 的**实际用途**（发行包 README 要求「稳定」，但 `bootstrap.sh`/`install.sh`/`compose.yml`/`.env.example` 全文零命中，读它的是 Rust 还是 Node 组件未知）；旧的「激活/设备绑定/到期」具体实现（v2026.1.4 之前的代码不在当前 tag 中，无法从文档取证）。
5. 内置 Nginx 的镜像名/版本、CPU/内存上限（`.env.example` 未列 Nginx 相关变量）。
6. 桌面版（Windows/macOS）的 `.env` / `compose.yml` 具体落盘路径与镜像存放位置（文档只说「系统应用数据目录中的 `runtime/`」，实测需另一车道验证）。
7. 各服务在**空载/典型负载**下的真实 CPU/内存占用（文档只有上限与推荐配置，无实测基线）。
8. 是否存在当前可用的「完整离线服务器包」：CDN 上 `*-full-*` 与旧 `box-local-engine-images-v*.tar.gz` 命名全部 404；仓库有 `scripts/{build-desktop-offline-installer,package-offline-images,verify-desktop-offline-package}.js`，说明离线包**构建能力存在**，但发行渠道未见成品 → 需实测/仓库深挖确认。
9. Redis 关闭后哪些功能会退化（文档只说「可用于会话、限流与缓存」+「本地回退不能代替玩家身份数据库」，无功能矩阵）。
10. `@dao3fun` npm 扩展包生态的实际数量与体积（`apc package list` 只查询 npm registry；registry 上 `@dao3fun/arenapro-cli` 404，说明组织名与包名需另行确认）。
