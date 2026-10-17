# F 线报告 · BOX3 Local Engine 新版本 2026.1.4 差异分析与升级方案

执行环境：WSL2 Ubuntu-24.04（root），Docker 29.1.3 + Compose v2.40.3，`docker system df` 时点镜像总量 11.25GB。
本线所有数字均来自本人在 `/root/re-release`（持久目录）下实测的命令输出；证据日志保存在
`/root/re-release/evidence/{download.log,repo.log,repo2.log,p26.log,p28.log,p29.log}`，脚本副本在 `/root/re-release/scripts/`。
工作目录：`/tmp/re-release`（注意：WSL 在 19:24 被其它线重启，`/tmp` 被清空过，所以已迁到 `/root/re-release`；这条事实本身是后文“升级gotcha”的证据之一）。

标记约定：`实测`=我跑过命令；`INFERRED`=由实测文件名/字段推断；`UNVERIFIED`=本环境无法测量。

---

## 1. 2026.1.4 制品清单（实测 URL / HTTP / 字节 / sha256）

### 1.1 入口对象

| 对象 | URL | HTTP | 字节 | sha256 |
|---|---|---|---|---|
| 版本指针 | `https://assets.box3.fun/local-engine/latest.txt` | 200 | 9 | `c74193fe152ec2566709a734ea6bcbb3f3f72beed98c4d8ae252f7de6657d0ec` |
| 版本说明（新） | `.../latest.json` | 200 | 3049 | `04280a074988d367aabb202edb0f0350cbc0b3219e14aeb830dd3b7853604bf2` |
| 引导安装器 | `.../install.sh` | 200 | 19752（497 行） | `20c5cf46c0be6b2fe30ed3fdfae89d0d9e4b98fc1c040c5e140b9d10fccced08` |
| 发行包 amd64 | `.../BOX3-Engine-Server-2026.1.4-linux-amd64.zip` | 200 | 25294 | `ce410d28fbb04692ff241d610e4e24b085330c801f14aab2ba6962f57082db76` |
| 发行包 arm64 | `.../BOX3-Engine-Server-2026.1.4-linux-arm64.zip` | 200 | 25306 | `64ec7ee35e229148be80b58c776533d3455a040db3ff329ad3afa868cce2e5f6` |

`latest.txt` 内容 = `2026.1.4`；`last-modified: Fri, 16 Oct 2026 16:22:34 GMT`；zip 的 `last-modified: 16 Oct 2026 16:21:40 GMT`。
CDN 头是阿里云 OSS+CDN（`server: Tengine`、`x-oss-request-id`、`etag`、`content-md5`、`x-oss-version-id`），**没有签名对象**：
`.../latest.txt.sig`、`latest.json.sha256`、`BOX3-Engine-Server-2026.1.4-linux-amd64.zip.sha256`、`.asc`、`.minisig` 全部 **404**（实测，见 download.log）。
对比参照：本机保存的 0.2.0 时代旁边文件 `/mnt/d/desktop/local-engine/official-package/BOX3-Engine-Server-0.2.0-linux-amd64.zip.sha256`（107B，内容是一行 `<sha256> *BOX3-...-0.2.0-linux-amd64.zip`）——即老版本曾提供 zip 级 sha256 旁车文件，2026.1.4 不再提供（404 实测）。
其它探测均 404：`PACKAGE-MODE.json`、`SHA256SUMS`、`manifest.json`、`version.json`、`index.json`、`releases.json`、`CHANGELOG.md`、`README.md`、`BOX3-Engine-Server-0.2.0/0.3.0-linux-amd64.zip`、`box3-engine-play-server-images-v2026.1.4-linux-amd64.tar.gz`、`box-local-engine-images-v2026.1.4-linux-amd64.tar.gz`、`2026.1.4.json`、`v2026.1.4.json`、`BOX3-Engine-Server-2026.1.{0,1,2,3}-linux-amd64.zip`（**历史版本在 CDN 上不可寻址**，只有 latest 指向的版本，见 §1.4）。

### 1.2 zip 内容（slim 清单包，解包 15 个文件 / 71910 字节）

```
BOX3-Engine-Server-2026.1.4-linux-amd64/
  BOX3-IMAGE-CATALOG.json 5514  BOX3-MANAGER-IMAGE.json 482  BOX3-PACKAGE-MODE.json 141
  compose.yml 27547  .env.example 4457  README.md 5305  SHA256SUMS 1033
  bootstrap.sh 19752  install.sh 6569
  start.sh 525  stop.sh 127  status.sh 125  logs.sh 146  verify.sh 187
```
在解包目录执行 `sha256sum -c SHA256SUMS` → 13/13 `OK`（实测 p29.log）。`SHA256SUMS` 只覆盖包内文本文件，**不覆盖任何镜像归档**。
`bootstrap.sh`(19752B) 与 CDN 根 `install.sh` 逐字节相同（`diff` 无输出，实测），即“CDN 上那份 497 行脚本”=包内 `bootstrap.sh`；包内 `install.sh`(6569B) 是新的“瘦安装器”。

`BOX3-PACKAGE-MODE.json`：`mode=slim`, `channel=production`, `version=2026.1.4`, `imageTag=v2026.1.4-linux-amd64`, `platform=linux/amd64`（arm64 包对应 `v2026.1.4-linux-arm64`）。

### 1.3 六个镜像归档（真正需要下载的字节）

命名规律：`https://assets.box3.fun/local-engine/box-local-engine-image-<组件>-<arch>-<sha256>.tar.gz`，文件名里就带 sha256，`sha256` 与 `size` 来自 `BOX3-IMAGE-CATALOG.json`。6 个 URL 全部 `HTTP 200 / content-type: application/gzip / last-modified 2026-10-16 16:20–16:21 GMT`，且 `content-length` 与 catalog 的 `size` **逐条相等**（实测 p5.sh 输出）。

| 组件（catalog `image`） | gz 字节 | 归档内 sha256 | 构建时间(UTC) | sourceRevision | buildSource |
|---|---:|---|---|---|---|
| box-local-engine-creator | 263,029,978 | `04391d8c…ad7c25ec` | 2026-10-16T13:49:11Z | `06b0b47cb…61318b` | github-actions |
| box-local-engine-play | 240,669,370 | `73d67495…97b5f43` | 2026-10-16T13:52:43Z | 同上 | github-actions |
| box-local-engine-player-service | 203,712,541 | `3d7f4a04…2e2fd26` | 2026-10-16T13:41:52Z | 同上 | github-actions |
| box-local-engine-voxa | 182,383,424 | `4fc669cd…c2ac6312` | 2026-10-16T13:55:11Z | 同上 | github-actions |
| box-local-engine-player-auth-portal | 86,925,875 | `7ba95b42…b4b24a9` | 2026-10-16T13:42:24Z | 同上 | github-actions |
| box-local-engine-server-manager | 83,924,951 | `4cb908ce…73322179` | 2026-10-16T13:44:54Z | 同上 | github-actions |

**发行总量（头条数字）**
- amd64 全部镜像 gz：`1,060,646,139 B = 1011.5 MiB`；加 zip `25,294 B` → **1,060,671,433 B ≈ 1.01 GiB**（全新机首次全量下载成本）。
- 首次 `install.sh` 实际只需要 `server-manager` 一个归档：**83,924,951 B ≈ 80.0 MiB**（包内 install.sh 第 79–138 行：先校验 sha256+size 才 `docker load`）。其余 5 个由 Web 管理端（launcher）按需下载，落到 `<安装目录>/cache/engine-images/`（实测本机 v0.3.0 就是这样，见 §3.2）。
- 未压缩镜像层大小（`docker image inspect --format {{.Size}}`，2026.1.4 用 catalog `imageId` 直接取）：6 镜像合计 **2,736,210,446 B ≈ 2.55 GiB**（对比 v0.3.0 合计 2,616,071,009 B、v0.2.0 合计 2,803,029,337 B）。
- arm64 同步可用：6 个 arm64 归档存在（文件名已实测），合计 **1,036,006,087 B**（creator 258,795,038 / play 236,455,214 / player-service 199,549,170 / voxa 176,497,471 / auth-portal 85,396,706 / server-manager 79,312,488）。
- 真实链路成本（本机 CDN 实测）：creator 归档 263,029,978 B 用时 367 s，均值 **699 KB/s**；按此速率全量 1.01 GiB ≈ **25–27 分钟**，仅管理端 ≈ 2 分钟。

### 1.4 包模式结论

- **当前生产模式 = slim（清单 + 分镜像归档，镜像不在 zip 里）**：`BOX3-PACKAGE-MODE.json.mode=slim`；zip 只有 25 KB；镜像是独立 flat 对象，文件名自带 sha256（可断点续传、可复用、可镜像站复制）。
- 同时存在另一种模式 **`local`**：包内 `install.sh` 第 101–104 行在 `mode=local` 且本地归档缺失时报“本地镜像归档缺失或损坏，请重新生成本地测试包。”并退出——即官方支持“把镜像打进包里”的本地/离线包形态，只是 **不在公开 CDN 上发布**（我按名字猜的 4 个 full/offline 包名全部 404，见 §1.1）。公开源码里对应实现可见 `scripts/launcher-package-modes.test.js`、`scripts/package-offline-images.js`、`scripts/build-desktop-offline-installer.js`（文件名实测，内容未读）。
- 老模式（0.2.0 的“单包全量”）已被取代：本机 `BOX3-OFFLINE-IMAGE.json` 是 `formatVersion:1` + 单个 707,806,289 B 的 `box3-engine-play-server-images-v0.2.0-linux-amd64.tar.gz`（含 6 镜像）；2026.1.4 改为 `formatVersion:2` 的 `BOX3-IMAGE-CATALOG.json` 逐镜像清单。

---

## 2. 0.2.0 → 0.3.0 → 2026.1.4 变更重建

### 2.1 版本轴（全部实测自镜像 OCI label / catalog / 文件时间戳）

| 版本 | sourceRevision | 构建时间 | `licenses` label | 载体 |
|---|---|---|---|---|
| v0.2.0 | `690fe9a492ef350c2a4d6cfac569714a991e6d01` | 2026-09-25T17:14:53+08:00 | **`LicenseRef-Proprietary`** | 单个 707.8 MB tar.gz（全量） |
| v0.3.0 | `edeab9d0af553592e65a91cec6667840962c1c40` | 2026-10-09T20:26:26+08:00 | **`MIT`** | slim：`cache/engine-images/` 6 个 per-image 归档（本机已实测存在，961 MB） |
| 2026.1.4 | `06b0b47cbcdfae610c87b77833153b48ce61318b` | 2026-10-16T13:41–13:55Z | （归档未 load 前不可读；GitHub `LICENSE.md` 为 MIT，见 §2.4） | slim：CDN 6 个 per-image 归档 |

要点：**MIT 化发生在 v0.3.0，不是 2026.1.4**；2026.1.4 只是把“移除激活/设备绑定/到期”正式写进变更说明（`latest.json` 的“使用与许可”条目）。这修正了文档线的表述。

### 2.2 服务清单 / compose.yml 差异（以“本机在跑的 v0.3.0 compose.yml 27132 B” 对比 “2026.1.4 compose.yml 27547 B”）

`diff` 结果：111 行，删 27 / 增 31（实测 p15.log）。服务集合与 profiles **完全一致**，无新增/删除服务：
`managed-redis(profile desktop-redis)`, `managed-postgres(desktop-postgres)`, `player-service(player-service)`, `player-auth-portal(auth-portal)`, `server-manager`(常驻), `creator`+`creator-storage-init`, `play`+`play-storage-init`, `voxa`+`voxa-storage-init`；卷 `box-managed-redis-data` / `box-managed-postgres-data` / `box-play-runtime-cache`；顶层仍是 `name: box-local-engine`（三代都一样，实测）。
实质差异（逐条来自 diff）：
1. 所有 `image:` 与 `BOX_BUILD_VERSION`/`BOX_IMAGE_TAG` 默认值 `0.3.0 → 2026.1.4`（11 处）。
2. **CPU 配额下调**：`cpus: ${BOX_CREATOR_CPU_LIMIT:-4.0} → :-2.0}`，`${BOX_PLAY_CPU_LIMIT:-4.0} → :-2.0}`（默认值，.env.example 同步改）。内存限额默认值未变。
3. **每服务独立反代开关**新增：`BOX_CREATOR_TRUST_PROXY` / `BOX_PLAY_TRUST_PROXY` / `BOX_AUTH_PORTAL_TRUST_PROXY` / `BOX_PLAYER_SERVICE_TRUST_PROXY`，均回退到全局 `BOX_TRUST_PROXY`；auth-portal 旧写法 `AUTH_DEMO_TRUST_PROXY: ${BOX_TRUST_PROXY}` 变为 `BOX_AUTH_PORTAL_TRUST_PROXY` 优先。
4. **公网地址推导方式改变**：`BOX_SERVER_PUBLIC_URL` 默认由空串改为分别取 `BOX_CREATOR_PUBLIC_URL`（默认 `http://127.0.0.1:3127`）与 `BOX_PLAY_PUBLIC_URL`（默认 `http://127.0.0.1:3121`）。
5. **storage-init 容器新增 `cap_add: [DAC_OVERRIDE]`**（注释说明备份/恢复需访问 UID 1000 私有文件）；`cap_add` 出现次数 3→4、`DAC_OVERRIDE` 2→3（实测 grep 计数）。与 0.2.0 的 compose.yml 计数（`DAC_OVERRIDE=3`）一致，即 **2026.1.4 恢复了 0.2.0 曾有、0.3.0 丢掉的一条权限**。
6. 端口集合无变化（实测在跑容器：creator 127.0.0.1:3127→3000、9966-9967；play 3121→3000；voxa 3123→3001；player-service 3124→3213；auth-portal 3125→3214；server-manager 0.0.0.0:3130；managed-postgres 127.0.0.1:5432）。

### 2.3 环境变量差异

`.env.example`：v0.3.0 4454 B/89 个键 → 2026.1.4 4457 B/89 个键；**键名集合完全相同**（`comm` 实测：added=空、removed=空），只有 3 个默认值变了：`BOX_IMAGE_TAG=v0.3.0-linux-amd64→v2026.1.4-linux-amd64`、`BOX_PLAY_CPU_LIMIT=4.0→2.0`、`BOX_CREATOR_CPU_LIMIT=4.0→2.0`。
0.2.0→0.3.0 的键差异（本机实测）：**删除** `BOX_LICENSE_INSTALL_SECRET`（激活/设备 ID 相关，`.env.example` 里三条相关中文注释一并删除）；**新增** `BOX_AUTH_PORTAL_IMAGE`（自定义登录页镜像）、`BOX_MODERATION_SIGNING_SECRET`（反作弊签名）。
本机 `~/box3/…0.2.0…/.env`（5809→5814 B）里由运维手工加的键（不在任何 example 中）：`BOX_AUTO_BACKUP_*`（4 个）、`BOX_SCRIPT_MEMORY_MB`/`BOX_SCRIPT_HEAP_MB`、`BOX_TELEPORT_MAX_ROOMS`/`BOX_TELEPORT_ROOM_IDLE_TIMEOUT_MS`、`BOX_PLAYER_REGISTRATION_ENABLED`/`BOX_PLAYER_COOKIE_DOMAIN`/`BOX_PLAYER_LOGIN_URL_OVERRIDE`/`BOX_PLAY_PUBLIC_URL_OVERRIDE`、`BOX_MANAGED_POSTGRES_{USER,PASSWORD,DATABASE}`、`BOX_CREATOR_HOST`、`BOX_PLAY_PUBLIC_HOST`、`BOX_{CREATOR,PLAY}_NETWORK_MODE` 等；在跑的目录（§3.1）`.env` 只有 4 个键是 example 之外的（`BOX_CREATOR_HOST`、`BOX_CREATOR_NETWORK_MODE`、`BOX_PLAY_NETWORK_MODE`、`BOX_PLAY_PUBLIC_HOST`），**全部在 2026.1.4 中仍被 compose 引用，升级不丢配置**（实测 comm 结果：“新 example 缺的键”=0 条）。

### 2.4 许可 / 激活差异（最重要）

- 0.2.0 时代：`install.sh` 强制校验 `/etc/machine-id`（“Missing /etc/machine-id; a stable Linux machine identity is required for licensing.”，本机 `~/box3/…/install.sh` 第 20–22 行实测存在），`BOX3_MACHINE_ID_FILE` 环境变量存在；本机有 `license/{box3-license.boxlic(653B), device-id(68B), trusted-time.json(108B)}`，且存在被人为打补丁的镜像 tag `box-local-engine-server-manager:v0.2.0-linux-amd64-patched`（Id `41ce88e90e47`，403 MB）与同目录 `patches/`（空）、`~/box3/credentials.txt`，以及同项目里 `BOX3-许可证实现分析与绕过评估.md`、`BOX3-激活完成报告.md`、`install-license.sh`、`call-license.sh` —— 说明当年确实做过激活绕过。
- 2026.1.4：包内 `install.sh` **不再出现** machine-id / 许可证 / 设备 任何字样（`grep -iE 'license|许可证|激活|设备|machine-id'` 计数见 README 同类实测：包 README 中 `MIT`=1、`激活`/`许可证`/`设备`/`离线`=0，`machine-id` 从 0.3.0 的 2 次降到 1 次）；`BOX3_MACHINE_ID_FILE`、`BOX3_REPOSITORY_URL` 两个 bootstrap 变量在新 `bootstrap.sh` 中**消失**（实测 env 名集合对比：0.2.0 有 `BOX3_MACHINE_ID_FILE`/`BOX3_REPOSITORY_URL`，2026.1.4 有 `BOX3_UPDATE_HELPER_NAME`/`BOX3_WEB_UPDATE` 而 0.2.0 没有）。
- `latest.json`（=官方 changelog）“使用与许可”条目原文含义：**采用 MIT 许可，移除激活、设备绑定与到期限制**。

### 2.5 官方 changelog 重建（2026.1.1–2026.1.4）

新渠道把变更说明做成了机器可读对象：`latest.json`（`schemaVersion=1`，`version/date/summary/sections[].title+items[]`）。公开仓库里对应源文件 `distribution/release-notes.json`（7199 B，实测）包含 **4 个版本**：
- `2026.1.1`（2026-09-04）本地部署版首次发布：创作端/游玩端分离、地图工程+游玩包+VOXA 工程导入导出与备份、地图组与传送房间、账号服务与 PostgreSQL 数据空间、桌面启动器与 Linux Web 管理端。
- `2026.1.2`（2026-09-11）渲染/脚本 API：服务端脚本新增 `world.globalLight`、`world.gamma`；外部数据服务状态与连接校验；数据空间兼容 PostgreSQL 表结构；若干登录来源误报修复。
- `2026.1.3`（2026-09-23）玩家管理后台（玩家/封禁/创作权限/CLI Token/游玩地图与容器资源组，权限组查看-编辑细分、审计记录）；**Creator CLI**（TypeScript 管理工程/资源/共享脚本/数据空间，控制预览运行时、实时调试输出、按视图截屏；CLI Token 能力化授权）；地图容器化（CPU/内存/网络策略/进程上限/带宽、空闲回收）；Linux 一键安装脚本（自动装 Docker、优先从 BOX3 CDN 取包）。
- `2026.1.4`（2026-10-15/16 发布、10-17 更新 latest）：轻量启动器按需+并行+断点续传下载组件、检测更新并重启升级、**识别并复用已有镜像**、服主密钥查看、**证书管理/多服务共用公网地址/外部 Nginx 手动模式与语法校验**、恢复备份前可选择是否还原环境配置、开发地图/模型/备份/缓存集中存放并与引擎内置资源分离、**反作弊与行为记录 + 设备封禁 + 地图脚本的玩家管理授权**、登录页改密与自定义、截图/状态/在线人数实时同步优化、地图缓存与内存占用优化、统一 dev/staging/prod 打包命令、**年份版本号并与源码提交固定对应**、MIT+移除激活/绑定/到期。
（以上为我依据 `latest.json` + `distribution/release-notes.json` 字段做的中文归纳；逐字原文在这两个 JSON 里，需要引用请直接读 `/root/re-release/pkg/latest.json`。）
**0.2.0/0.3.0 没有公开 changelog**（CDN 无 `CHANGELOG.md`，404），这两段的差异只能靠上面的 label/文件/diff 实测重建。

### 2.6 逐服务镜像大小变化

| 服务 | v0.2.0 未压缩 | v0.3.0 未压缩 | 2026.1.4 未压缩 | v0.3.0 gz | 2026.1.4 gz | Δgz |
|---|---:|---:|---:|---:|---:|---:|
| creator | 720,028,597 | 657,655,304 | 678,713,391 | 253,806,758 | 263,029,978 | +9,223,220 |
| play | 657,324,283 | 594,902,659 | 615,942,850 | 231,466,119 | 240,669,370 | +9,203,251 |
| voxa | 444,708,611 | 444,734,714 | 483,753,236 | 164,705,466 | 182,383,424 | +17,677,958 |
| player-service | 555,231,618 | 492,466,010 | 512,534,379 | 194,660,421 | 203,712,541 | +9,052,120 |
| player-auth-portal | 230,274,503 | 230,253,264 | 230,350,033 | 86,901,144 | 86,925,875 | +24,731 |
| server-manager | 195,461,725 | 196,059,058 | 214,916,557 | 75,989,013 | 83,924,951 | +7,935,938 |
| 合计 | 2,803,029,337 | 2,616,071,009 | 2,736,210,446 | 1,007,528,921 | 1,060,646,139 | **+53,117,218** |

结论：0.2.0→0.3.0 全量瘦身 −187 MB（−6.7%）；0.3.0→2026.1.4 回涨 +120 MB（+4.6% 未压缩）/ +53 MB（+5.3% gz），涨幅主要来自 voxa（+17.7 MB gz）与 server-manager（+7.9 MB gz，launcher/证书/反作弊逻辑进面板）。server-manager 未压缩从 196 MB→215 MB（+9.6%）是 2026.1.4 唯一“显著变胖”的面板。

### 2.7 安装脚本三代变化

`bootstrap.sh` 字节：18,164（0.2.0）→ 20,148（0.3.0，本机 `updated/install.sh` 与 `current/bootstrap.sh`）→ 19,752（2026.1.4）。0.3.0→2026.1.4 的 diff：259 行、−131/+105，**改动集中在 Docker 仓库/密钥安装路径**（`rm -f "$docker_key/keyring/installer"` → `rm -rf "$docker_repositories"`，即从单文件清理改为目录清理），业务侧逻辑（latest.txt 取版本、`package_url=${RELEASE_CDN_URL%/}/$package_name.zip`、镜像复用、`rm -f` 旧 tar.gz、`docker image rm` 旧 tag）三代同构。
`install.sh` 字节：4,336（0.2.0：`docker load` 单个全量 tar.gz）→ 6,351（0.3.0）→ 6,569（2026.1.4：只下载+校验+load **server-manager** 一个归档，`docker tag <contentTag> box-local-engine-server-manager:$BOX_IMAGE_TAG`，起 `up -d --wait server-manager`，然后交给 Web 管理端按需下载）。
注意 bootstrap 里两处破坏性动作（升级前必须知道）：第 393–394 行 `rm -f` 安装目录内所有 `box-local-engine-images-v*-linux-*.tar.gz` 与 `box3-engine-play-server-images-v*-linux-*.tar.gz`（本机 0.2.0 的 707.8 MB 归档会被删）；第 422/426/441 行 `docker image rm` 旧服务/旧面板 tag。**我的脚本不做这两类删除**，以保证可回滚。

---

## 3. 现场版本漂移：0.2.0 目录 / v0.2.0 tag / 在跑 v0.3.0 是怎么来的

### 3.1 真实拓扑（实测 `docker inspect` mounts + compose label）

存在**两个**安装目录，且 compose 项目名都是 `box-local-engine`（因为 `compose.yml` 首行硬编码 `name: box-local-engine`，三代一样）：

- **目录 A** `/root/box3/BOX3-Engine-Server-0.2.0-linux-amd64`（0.2.0 全量离线包，`BOX3-OFFLINE-IMAGE.json` sourceRevision `690fe9a4…`，707,806,289 B tar.gz 的 `sha256sum -c` = **OK**）。数据在这里：`apps/local-engine/projects` **4073 文件 / 175,013,372 B（3 个工程：`yunhai-xiantu`、`cloud-3a043df55e5057a5-imported`、`cloud-4e84ee7ef626058f-imported`）**、`play-worlds` 908 文件 / 27,992,660 B、`data`/`dist`/`backups` 0 文件、`apps/voxa/data` 2 文件 / 10,512 B、`license/` 3 文件 / 829 B；`.env` 0600 + 7 个 `.env.bak-*`。
- **目录 B（真正在跑的那套）** `/mnt/d/desktop/local-engine/current`（v0.3.0 slim 包，`BOX3-PACKAGE-MODE.json` 不存在但 `BOX3-IMAGE-CATALOG.json` imageTag=`v0.3.0-linux-amd64`、rev `edeab9d0…`；`cache/engine-images/` 6 个归档合计 961 MB）。5 个业务容器 + server-manager 全部由这里的 `bind /mnt/d/desktop/local-engine/current/… -> /app/…` 提供数据，`config_files=/workspace/.runtime-compose.yml`、`environment_file=/workspace/.runtime.env`、`working_dir=/mnt/d/desktop/local-engine/current`；其 `apps/local-engine/projects` 只有 **456 文件 / 23,360,502 B（1 个工程 `project-mv355ah6` + `.runtime-cache`）**，`play-worlds`/`data`/`dist`/`backups` 全空。
- **例外**：`box-local-engine-managed-postgres-1` 的 `working_dir=/root/box3/BOX3-Engine-Server-0.2.0-linux-amd64`、`config_files=/workspace/compose.yml`、`created=2026-09-26T14:24:14Z`、`config-hash=a21141d72a97…d864`，即**数据库容器至今仍是目录 A 创建的**，数据在命名卷 `box-local-engine_box-managed-postgres-data`（项目级命名，跨目录共享，所以换目录不会丢库）。两边 `BOX_DATABASE_URL` 的用户/库名一致（`box_user_eef1d3bc4a5ccea2` @ `managed-postgres:5432/box_db_cd3373a00502d05c`，实测正则抽取）。
- `managed-redis` 容器不存在（`docker ps -a` 无匹配），`.env` 里 `REDIS_HOST=` 空 → profile `desktop-redis` 未启用。

### 3.2 “三个版本不一致”的因果链（结论）

1. 2026-09-26：用 0.2.0 **全量离线包**装到目录 A，`install.sh` `docker load` 6 个 v0.2.0 镜像、`.env` 写入 `BOX_IMAGE_TAG=v0.2.0-linux-amd64`；随后手工做过激活绕过（`…-patched` tag、`license/`、7 个 `.env.bak-*`）。
2. 2026-10-09/10/11：换用 v0.3.0 **slim 发行**，在 Windows 侧 `/mnt/d/desktop/local-engine/`（`updated/install.sh` 20148 B = v0.3.0 bootstrap）安装到目录 B；6 个 v0.3.0 归档被 launcher 下到 `current/cache/engine-images/`，并**同时保留 `launcher-content-<imageId>` 与 `v0.3.0-linux-amd64` 两套 tag**（实测 `docker images` 每个镜像都有这两条同 Id 的 tag）。
3. 因为 `compose.yml` 里 `name: box-local-engine` 固定、卷是项目级命名卷，10-11 那次从目录 B 起栈时 compose 复用了目录 A 已存在的 `managed-postgres` 容器（没重建），于是出现：**磁盘目录版本 0.2.0 / 目录 A 的 `.env` tag v0.2.0 / 实际在跑镜像 v0.3.0** 三者不同步。目录 A 从“运行目录”退化成“数据 + 老包 + 数据库容器来源”。
4. **本线执行期间的并发变更（重要）**：`stat`/`find` 实测目录 A 在 19:26:23 被写入——`compose.yml` 变成 27547 B（=2026.1.4）、新增 `bootstrap.sh`/`install.sh`/`BOX3-IMAGE-CATALOG.json`/`SHA256SUMS` 全套 2026.1.4 文件（时间戳 2026-10-17 00:07，即包内原始时间戳），`.env` 的 `BOX_IMAGE_TAG` 已被改成 **`v2026.1.4-linux-amd64`**；同时 Docker 存储里出现了 6 个 `launcher-content-<2026.1.4 imageId>` tag（Id 与 catalog 的 `imageIds[0]` 逐条相同：creator `f897ebfd4a55`、play `17e19af276fe`、player-service `173dba6c4e8b`、auth-portal `38231c1674a8`、voxa `386b82144129`、server-manager `a073810d2cb4`），但**还没有任何 `:v2026.1.4-linux-amd64` release tag**（`docker images | grep -c 2026.1.4` 为空）。另有其它线建的快照目录 `/root/box3/upgrade-snapshot-20261017-192455/`（含 `.env`、`compose.yml`、`data-inventory.txt` 602771 B、7 个容器 inspect JSON、`license/`、`patches/`）。
5. 同一时刻（19:24:40Z≈19:24:40+08 的 UTC 记录为 11:24:39–40Z）WSL/Docker 被重启，**整栈目前是 Exited 状态**（server-manager `Exited (143)`，其余 `Exited (0)`），`docker ps` 数量为 0。
   → 所以任何“升级脚本”都必须运行时重测、幂等、并且能处理“镜像已 load、tag 未建”的半完成态。我的 `tools/upgrade-2026.1.4.sh` 正是按这个语义写的（`ensure_tag` 会优先复用已存在的 content tag）。

### 3.3 目标状态（升级后“应该是”，以及绝不能变的东西）

| 项 | 目标值 | 依据 |
|---|---|---|
| 发行版本 | `2026.1.4`（`BOX3-PACKAGE-MODE.json.mode=slim`, `channel=production`） | 包内实测 |
| 镜像 tag（唯一权威口径） | `BOX_IMAGE_TAG=v2026.1.4-linux-amd64`，6 个 `box-local-engine-{creator,play,voxa,player-service,player-auth-portal,server-manager}:v2026.1.4-linux-amd64`，Id 必须等于 catalog `imageIds` 中其一 | catalog + `docker image inspect` |
| 安装目录 | 继续用**目录 B** `/mnt/d/desktop/local-engine/current`（在跑的那套，bind 源）；目录 A 只作数据/回滚源，不删不移 | mounts 实测 |
| compose/脚本 | 目录 B 内 `compose.yml` = sha256 `be0cf65731ffd28ad443a33f70af461217ff9e60bad509df567fa0b2d4eedf46`(27547B)，`.env.example`=`06a6bec9…`(4457B)，`SHA256SUMS` 13/13 OK | 包内实测 |
| 数据目录 | `${BOX_DATA_DIRECTORY:-.}` 默认=安装目录：目录 B 的 `apps/local-engine/{projects,play-worlds,data,dist,backups}`、`apps/voxa/data` 路径与内容**必须一字节不变**；目录 A 那 175 MB/4073 文件如要出现在新 UI 里，需显式设 `BOX_DATA_DIRECTORY=/root/box3/BOX3-Engine-Server-0.2.0-linux-amd64`（**这条改动需人工决策，我的脚本不会自动做**） | compose 17 处 bind 实测 |
| 数据库 | 命名卷 `box-local-engine_box-managed-postgres-data` 不动；`managed-postgres` 保持原凭据（`BOX_MANAGED_POSTGRES_USER/PASSWORD/DATABASE` 只在目录 A `.env` 有） | inspect 实测 |
| 端口 | 3121/3123/3124/3125/3127/3130（+127.0.0.1:5432）不变；`9966-9967` 不变 | `docker ps` 实测 |
| profile 集合 | `creator play voxa player-service auth-portal` + 常驻 `server-manager` + `desktop-postgres`（`desktop-redis` 维持关闭） | profiles+容器实测 |
| 秘密 | `.env` 中所有 token/secret/`BOX_DATABASE_URL` 逐行不变；升级只允许改 `BOX_IMAGE_TAG` 一行，且改后必须 `diff` 只有 1 行变化，否则自动还原 | 脚本实现 |
| 禁止 | 不得 `docker load` 后删除旧 tag；不得 `rm -f` 目录 A 的 707.8 MB tar.gz 或 `cache/engine-images/*.tar.gz`；不得 `docker volume rm` / `system prune` / `builder prune`；不得动 `apps/**` | 本线约束 |

---

## 4. 源码是否已公开（MIT）——**是，本条为最重要发现**

匿名 `git ls-remote` 成功 + 匿名浅克隆成功 = 公开仓库，无鉴权：

- 仓库：**`https://github.com/box3lab/box3-local-engine`**（描述“BOX3 本地引擎提供地图编辑、模型制作、地图脚本、多人游玩和服务管理。”；`git ls-remote` 返回 `refs/tags/v2026.1.4 → a35455d8143d4dc4c5909e78d6ddc6432090ef32`、`refs/tags/player-v2026.1.2 → e6d2cc2e…`）
- 标签/提交：**tag `v2026.1.4` = commit `a35455d8143d4dc4c5909e78d6ddc6432090ef32`**（tree `621c187a08ef116770b2e7ed6859924da9b02428`，`Sat Oct 17 00:01:24 2026 +0800`，“Merge pull request #22 from box3lab/dev”）。
- 镜像里的 `sourceRevision` **`06b0b47cbcdfae610c87b77833153b48ce61318b`** 也存在于该仓库（GitHub commit 搜索 API 命中该 commit，URL `https://github.com/box3lab/box3-local-engine/commit/06b0b47…` 返回 **HTTP 200**，页面 621,255 B；该 commit 与 tag `v2026.1.4` 的 commit 不同，说明 2026.1.4 镜像由 `06b0b47…` 构建、随后 `v2026.1.4` tag 指向 `a35455d…`。INFERRED：tag 是发布分支收尾提交）。
- 许可：**`LICENSE.md` 1090 B / 21 行 / 首行 `MIT License` / sha256 `9ac0cee6cdb22109e6e64d24d57c644a17b4be01b2377813bae2c27b86d69c30`**；镜像内捆绑的 `distribution/LICENSE.txt` 是**同一 sha256 同一长度**（即镜像 `/app/LICENSE` = 仓库 MIT 文本）。子包各自带 LICENSE：`packages/script-api/LICENSE`(1066 B)、`packages/mudb/LICENSE`、`packages/player-policy/LICENSE`、`packages/deployment-routing/LICENSE`、`packages/realtime-client/LICENSE`、`packages/regl/LICENSE`、`packages/ao-mesher/LICENSE`、`apps/player-auth-portal/LICENSE`。
- 规模：`git ls-tree -r` 共 **8486 个文件**；扩展名分布 `.ts 2841 / .png 1452 / .map 1097 / .js 944 / .tsx 659 / .json 158 / .scss 154 / .css 129 / .glsl 104 / .md 76 / .wgsl 67 / .rs 58 / .wasm 33`。
- 关键目录（文件计数实测）：`apps/game 1710`（创作端+游玩端 Next.js + 引擎渲染/体素）、`services/game-server 1644`、`apps/voxa 457`、`apps/local-engine 434`、`apps/deployment-manager 178`（Tauri 桌面启动器）、`apps/player-launcher 126`、`apps/server-manager-rust 17`、`apps/server-manager 2`、`apps/manager-core 32`、`apps/player-admin 60`、`apps/player-auth-portal 43`、`packages/mudb 749`、`packages/script-api 46`、`packages/sdk 40`、`packages/vb-parser 26`、`packages/ao-mesher 35`、`internals 925`、`scripts 110`、`distribution 35`、`docs 7`、`.github/workflows 5`。
- **`apps/local-engine/src` 确实公开**（434 个文件，src 下 34 个 js：`launcher.js`、`project-manager.js`、`project-compatibility.js`、`map-group-manager.js`、`map-identity.js`、`map-runtime-profiles.js`、`play-library.js`、`play-image.js`、`play-derived-resources.js`、`runtime-lifecycle.js`、`runtime-container-client.js`、`runtime-data-permissions.js`、`runtime-readiness.js`、`runtime-storage-namespace.js`、`runtime-upstream.js`、`stage-runtime-data.js`、`teleport-room-manager.js`、`moderation-credential.js`、`moderation-runtime-launch.js`、`asset-distribution.js`、`prepare-assets.js`、`sync-built-in-skins.js`、`prune-player-build.js` 等），`apps/local-engine/package.json` 的 name/version/description = `@box/local-engine` / `2026.1.4` / “Offline-first local runner for the Box engine”（实测）。
- **构建可复现**：`apps/local-engine/Dockerfile` 24657 B、11 个 `FROM`、11 个命名 stage，其中目标阶段为 `creator` / `play` / `player-service` / `voxa`（+ `source-base`/`engine-build-base`/`*-build`/`runtime-base`），另有 `apps/player-auth-portal/Dockerfile`(+`.standalone`)、`apps/server-manager/Dockerfile` → 与 CDN 上 6 个镜像一一对应。CI：`.github/workflows/{release.yml 26745B, package-server.yml 13760B, verify.yml, player-launcher-release.yml, release-branch-created.yml}`；`package-server.yml` 里出现 `assets.box3.fun`、`slim`、`BuildKit`、`BOX_IMAGE_TAG: v${{ inputs.version }}-linux-${{ matrix.architecture }}`、`BOX_DOCKER_NODE_IMAGE: node:22.17.0-bookworm-slim`、`scripts/server-image-plan.js`、`ossutil cp oss://…/$archive`（即 CDN 归档由该 workflow 从 OSS build 前缀搬运，`publish_stable` 需 `architecture=all` 才更新 `install.sh`/`latest.txt`）。
- **脚本 API 公开**：`packages/script-api` 含 `dts/box3-server-api.d.ts`、`dts/server-api-types.d.ts`、`dts/client-api-types.dts`、`src/client/modules/{dom,events,http,input,math,media,navigator,pointer-lock,remote,screen,ui}.ts`、`CHANGELOG.md`/`CHANGELOG.json`、`rollup.config.mjs`（46 文件）。
- **地图格式/写出侧**：仓库内有 `packages/mudb`（749 文件，含 `client.d.ts`/`client.js`/`example/{chatroom,ctf,puzzle}/{schema,client,server}.ts`）、`packages/vb-parser`(26)、`packages/ao-mesher`(35)、`apps/game/server/{player-launcher-map-packages.ts,play-worlds.ts,map-container-admin.ts,map-identity.ts,map-info.ts,creator-scene-session.ts,creator-scene-websocket.ts,admin-map-catalog.ts}`、`apps/game/pages/api/**/maps*` 与 `local-projects/[id]/{export,package,publish,snapshots}.ts`、`apps/voxa/src/models/parse-magica-voxel/src/chunkHandlers/*`。→ **INFERRED**：地图包/世界写出与 `.vox` 解析的公开入口就是这些路径；**UNVERIFIED**：`play-worlds` 落盘的二进制世界格式是否 100% 在该仓库（我只取了文件名清单，未读实现体，需下一步按文件核实 `apps/game/server/play-worlds.ts` 与 `packages/mudb` 的写盘分支）。
- 另注：仓库根有 `docker-compose.yml`、`.env.docker.example`、`distribution/{linux-amd64,server,play,windows-amd64,windows-arm64}/`（**CDN 上那几个 zip 的模板源**：`distribution/server/{bootstrap.sh 19752B, install.sh 6479B, compose? README 5305B, .env.example 4463B}`、`distribution/play/compose.yml 5912B`、`distribution/linux-amd64/*`、`windows-*/deploy.ps1 16622B`）。`docs/` 7 篇：`README.md, architecture.md, code-style.md, developer-guide.md, first-project.md, release-and-version.md, testing.md`。

**对整体计划的意义**：黑盒逆向的前提消失了。可用路径 = fork `box3lab/box3-local-engine` @ `v2026.1.4`（或 `06b0b47…`），按 `apps/local-engine/Dockerfile` 的 4 个 runtime stage + `distribution/` 模板做“删瘦”，而不是从 1.0 GB 镜像里挖格式。仍需注意：仓库里 `apps/game` 体素引擎、`services/game-server`、`packages/mudb` 体积大（1710+1644+749 文件），“保留地图写死/删 UI”这类决策必须以读码为准（本线只证明了**存在性**）。

---

## 5. 私有化 / 离线部署的坑（实测证据）

1. **latest.txt 不可签名、不可固定**：CDN 无 `.sig/.asc/.minisig`，只有 OSS 的 `etag`/`content-md5`（传输一致性，不是可验证签名）。想固定版本只能用 `BOX3_VERSION=2026.1.4`（bootstrap 第 215 行 `${RELEASE_CDN_URL%/}/latest.txt` 只在未给 `BOX3_VERSION` 时读取），并把 `latest.json`(3049B) 的 sha256 记录下来做“发布说明快照”。**历史版本不可回退下载**：`BOX3-Engine-Server-2026.1.{0..3}-linux-amd64.zip` 全 404；但 per-image 归档是 sha256 命名的，只要归档 URL（含 digest）留存，旧镜像仍可取回 → **私有镜像站要按 catalog 里的 archive 文件名逐条镜像，而不是只镜像 zip**。
2. **自托管 CDN 是按文档可用的**：`bootstrap.sh` 第 10 行 `RELEASE_CDN_URL=${BOX3_RELEASE_CDN_URL:-https://assets.box3.fun/local-engine}`，包名/路径全部由它拼接（第 321 行 `package_url=…/$package_name.zip`），`install.sh` 第 122–123 行镜像 URL 同样是 `${CDN}/${archive}`（archive 名来自包内 catalog）。所以镜像站只需 flat 目录 + 同名文件即可，无需 OSS API。**UNVERIFIED**：`install.sh` 里的 CDN 根是硬编码 `https://assets.box3.fun/local-engine`（第 123 行），**不读 `BOX3_RELEASE_CDN_URL`** —— 即“离线时直接跑包内 install.sh”走的是官方域名，自托管必须在 bootstrap 路径或提前把归档放进 `cache/engine-images/`（它先按 sha256 复用本地文件）。这是私有化的真实坑点。
3. **面板是下载器**：2026.1.4 的 `install.sh` 只保证 server-manager（80 MiB）；其余 5 个组件（978 MiB）由 Web 管理端按需下载/导入（`latest.json`“识别并复用已有服务镜像”+ 本机 v0.3.0 的 `cache/engine-images/` 实测）。离线环境要么预放 6 个归档到 `<目录>/cache/engine-images/`（文件名= catalog 名，`sha256` 会被核对），要么用 `mode=local` 的本地全量包（CDN 不提供，需自 build）。
4. **镜像可用 `docker save/load` 自由搬运**：归档就是 `docker save` 流；本机能读到 `tar -xzOf <archive> manifest.json` 的验证机会因下载未完成而缺失 → **UNVERIFIED**：归档内 `RepoTags` 究竟是 `:<imageTag>` 还是 `:launcher-content-<Id>`。但本机 v0.3.0 现状（content tag 与 release tag 并存、`install.sh` 主动 `docker tag …:$image_tag` 后 `docker image rm` content tag）说明 load 出来的是 **content tag**，必须由安装器/管理端补 release tag → 我的脚本用 catalog 的 `imageIds` 反查 Id 再打 tag，两种情况都能收敛。
5. **破坏性清理在 bootstrap 里**：`rm -f` 旧 tar.gz（393–394 行）、`docker image rm` 旧 tag（422/426/441 行）、`BOX3_UPDATE_HELPER_NAME` helper 容器（495 行 `docker rm -f`）。这些会毁掉“原地回滚”，脚本必须提前备份并跳过。
6. **`/tmp` 不是安全暂存区**：本会话 WSL 被重启 2 次（18:54、19:24），`/tmp/re-release` 一度消失。下载/暂存必须放持久路径（我脚本默认 `/root/box3-upgrade-staging`）。
7. **Windows 侧目录当 bind 源的性能/权限风险**：目录 B 在 `/mnt/d`（drvfs），容器 bind 读写；`projects` 只有 23 MB 而目录 A（ext4）有 175 MB。若把目标状态放 Windows 盘，导入大工程会显著变慢（本机实测：drvfs 上 `find+sha256` 清单 456 文件用 2.47 s，ext4 上 4073 文件用 0.09 s —— 约 **50×/文件** 的元数据差距）。目标状态建议迁到 ext4（`/root/box3/<new dir>` 或 `~/`）并把 `BOX_DATA_DIRECTORY` 固定，属于需要人工决策的迁移动作（本线不做）。
8. **`.env` 权限与备份习惯**：目录 A `.env` 0600 + 7 个 `.env.bak-*`；目录 B `.env` 0777（drvfs）。升级脚本必须只改一行并 `diff` 校验，且把 `.env` 快照到包目录之外（我的脚本做 `cp -a` + `chmod 600`）。

---

## 6. 交付物

- `tools/upgrade-2026.1.4.sh`：默认 **dry-run**，`--apply` 才动作；`--rollback` 显式回滚；幂等（已 load/已 tag/已换文件会跳过）；暂存在 `/root/box3-upgrade-staging`；备份在 `/root/box3-upgrade-backups/<UTC时间戳>/`（包目录之外）；只改 `.env` 的 `BOX_IMAGE_TAG` 一行并强校验；不执行任何删除（下载失败文件改名 `.corrupt-<ts>`）；`--no-deps` 起服务、保持同一 profile 集合；逐容器 `running+healthy` 与 6 个 HTTP 端口双通道健康检查（超时可配，默认 180 s）；数据清单（path|size|mtime + 每文件 sha256）前后对比。
- `tools/post-upgrade-check.sh`：只读。打印每个容器的镜像 tag/Id、health、RSS、监听端口、`.env` 的 `BOX_IMAGE_TAG`、包文件 sha256 对照、数据清单与备份快照对比结果、缺失 tag 列表。
- 两条命令都**不**做：`rm -rf`、`docker system/builder prune`、`docker volume rm`、删除 `apps/**` 与 `cache/engine-images/**`、`docker image rm` 任何旧 tag。

### 待办（本线无法完成，需下一位接手）
1. `tar -xzOf <2026.1.4 archive> manifest.json` 读 RepoTags，确认 §5.4 的未证点（只需已完成下载的 creator 归档即可测）。
2. 读 `apps/game/server/play-worlds.ts` + `packages/mudb` 写盘分支，把“地图格式写出是否公开”从 INFERRED 升级为实测。
3. 决定是否把安装目录/数据目录从 `/mnt/d` 迁到 ext4，并决定目录 A 的 175 MB 工程如何进入新栈（复制 `apps/` 或设 `BOX_DATA_DIRECTORY`）。
4. 并发线已把目录 A 改成 2026.1.4 且 `.env` tag 指向 `v2026.1.4-linux-amd64`（该 tag 尚不存在）——**此时若有人 `compose up` 会因镜像缺失失败**。要么先跑我的 `--apply`（建 tag + 起服务），要么先把目录 A `.env` 的 tag 还原为 `v0.3.0-linux-amd64`。
