# BOX3 最小开服包（play-lite）：4 容器、零特权

只跑「玩家能进图开玩」这条链路：**Play + Player Service + 登录门户（player-auth-portal）+ PostgreSQL**。
不含创作端（Creator）、模型编辑器（VOXA）与服务管理器（server-manager）。

## 与出厂全栈的差异（2026-10-18 同机实测）

两套栈在同一台 WSL（Docker 29.1.3，`.wslconfig memory=8GB`）里同时运行，RSS 为熟态连续 3 轮 12×10 s 均值（容器已跑 80–90 min）。

| 指标 | 出厂全栈 | play-lite | 差 | 口径 |
| --- | --- | --- | --- | --- |
| 常驻容器 | 7 | 4 | −43% | 另有 3 / 1 个一次性 `*-storage-init` |
| 宿主端口 | 9（含 `0.0.0.0:3130`） | 4，全部 `127.0.0.1` | −56%，0 条对外网卡 | `ss -ltnp` |
| 挂 `/var/run/docker.sock` | 1 | 0 | 归零 | `docker inspect` |
| 常驻 root 进程 | 2 | 0 | 归零 | 进程 uid（本包唯一 root 容器是一次性 init） |
| 镜像分发 | 1,060,646,139 B（6 归档） | 531,307,786 B（3 归档） | **−49.9%** | gz，`_manifest/BOX3-IMAGE-CATALOG.json` 的 `size` 字段 |
| `docker load` 后 content | 2,736,210,446 B | 1,358,827,262 B | **−50.3%** | `docker image inspect .Size` |
| `du -sb /app` 合计 | 1,835,711,422 B | 665,615,084 B | **−63.7%** | 轻量列含 2 张图；**逐服务没有变小**，降幅来自少跑 3 个服务 |
| 空闲 RSS | 376.14 MiB | 258.74 MiB | **−31.2%** | `docker stats`（memory.current − inactive_file） |
| 空闲 RSS（anon） | 284.14 MiB | 166.38 MiB | **−41.4%** | cgroup `anon`，去掉可回收 page cache |
| `/api/health-check` TTFB 中位 | 3.2 ms | 3.1 ms | 基本持平 | 20 样本；本包不宣称接口变快 |
| 全栈 → 4 个 healthy | 未测（不许重启现网） | **12.79 s** | — | 逐容器 7.67 / 8.37 / 9.96 / 10.44 s |
| 每开 1 张图 | — | 进程 **+2**、anon **+146.4 MiB**（Pss +152.6） | 成本项 | idle 3 进程 → 起图 5 进程；单图冷启动首见 10.77 s、二次 7.19 s |

复现命令与逐条原文输出见 `slim/impl/W4-play-lite-package.md`（§3 为 3 容器基线、§11 为补门户后的 4 容器验证）与串行测量轮报告 `slim/scan/O6-benchmark-comparison.md`（正在同步进 `slim/`）。

## 为什么不需要 server-manager

`apps/local-engine/src/launcher.js` 只在地图 profile 声明 `isolation: container` 时才向 `BOX_RUNTIME_MANAGER_URL` 申请隔离容器；该变量未配置时记一条告警并回落到共享 Node 运行时。出厂 `docker-compose.yml` 把 `BOX_RUNTIME_MANAGER_URL` / `BOX_RUNTIME_MANAGER_TOKEN` 默认指向 `http://server-manager:3130`（`:319-320`、`:493-494`），所以边车被连带拉起。**本包故意不设置这两个变量**（compose 内 `:210` 有注释钉住这个决定），实测：

- `createSession` 200，地图运行时是 Play 容器内的普通 Node 子进程（`dist/src/launch.js --useProdBundle` 游戏服 + `ivmp-process-entry` 脚本 VM），全部 UID 1000，不创建任何容器；
- `box-local-engine-runtime` 隔离镜像本机根本没安装 → 去掉 server-manager 没损失任何已在工作台的功能。

官方 `distribution/play/compose.yml` 是同一结论的先例：它本来就不含 server-manager。

## 前置条件

Docker Engine + Compose v2。不需要源码、不需要 Node.js。加地图不重建镜像。

## 部署

```sh
cp -r compose.yml .env.example ./
cp .env.example .env
# 填 .env 的三个必填秘密
openssl rand -hex 32   # -> PERMISSION_TOKEN_SECRET
openssl rand -hex 32   # -> BOX_PLAYER_AUTH_API_KEY
openssl rand -hex 24   # -> BOX_MANAGED_POSTGRES_PASSWORD
# 并把 BOX_DATABASE_URL 里的口令换成同一个 BOX_MANAGED_POSTGRES_PASSWORD

docker load -i box-local-engine-image-play-*.tar.gz              # 官方归档命名：
docker load -i box-local-engine-image-player-service-*.tar.gz    # box-local-engine-image-<service>-<arch>-<sha>.tar.gz
docker load -i box-local-engine-image-player-auth-portal-*.tar.gz
node <仓库根>/scripts/tag-images-from-catalog.mjs --catalog <仓库根>/slim/_manifest/BOX3-IMAGE-CATALOG.json
docker pull docker.m.daocloud.io/library/postgres:16-alpine       # 或从自己的镜像仓准备

mkdir -p data/apps/local-engine/play-worlds data/apps/local-engine/data/blobs
docker compose up -d
docker compose ps
```

`tag-images-from-catalog.mjs` 不可省：官方逐服务归档 `docker load` 后只有 `launcher-content-<imageId>` tag，而 compose 引用 `box-local-engine-<service>:v2026.1.4-linux-amd64`，缺 tag 时 Docker 会去 docker.io 拉一个不存在的镜像并 i/o timeout。

**"离线包 = 零外部依赖"不成立**：三个引擎归档不含数据库镜像，`postgres:16-alpine`（content 116,084,812 B）必须自己准备。

`play-storage-init` 跑完显示 `Exited (0)` 属正常；它是包里唯一 root 容器，且只做一次属主修正。

入口（全部只绑回环）：

- Play：`http://127.0.0.1:4121/`
- 玩家登录门户：`http://127.0.0.1:4125/`（注册/登录页；`BOX_PLAYER_LOGIN_URL` 默认已指向它）
- 玩家后台：`http://127.0.0.1:4124/players`
- PostgreSQL：`127.0.0.1:4132`（**永远不要暴露到公网网卡**）

端口、监听地址、数据目录、project 名全部走 env：`BOX_PLAY_PORT`、`BOX_PLAYER_SERVICE_PORT`、`BOX_AUTH_PORTAL_PORT`、`BOX_MANAGED_POSTGRES_HOST_PORT`、`BOX_BIND_IP`、`BOX_LITE_DATA_DIRECTORY`、`BOX_LITE_PROJECT_NAME`。改 project 名即可同机并存多套（卷名前缀随之隔离）。

## 地图怎么进来（重要缺口）

| 归档 | 能否进本包 | 说明 |
| --- | --- | --- |
| `.boxplay`（游玩包） | **能** | `POST /api/play-admin/import?mode=preview` → `mode=confirm`，鉴权是 `Authorization: Bearer $BOX_PLAY_ADMIN_TOKEN`（实测 201/201）。`confirm` 这一步自动置 `playEnabled=true`，不需要额外"开放"动作 |
| 直接放盘 | **能** | 把完整发布目录放进 `data/apps/local-engine/play-worlds/<作品ID>/` |
| `.boxproject`（可编辑工程） | **不能** | 导入端点 `POST /api/local-projects/import` 第一行要求 `BOX_DEPLOYMENT_MODE=creator`（`apps/game/server/creator-api-security.ts:42`）。本包只有 play（`=play`）与 player-service（`=player-service`），没有 creator → 实测 **404**。想进轻量栈必须先导入**出厂 creator**，再走 `publish → .boxplay` |

结论：**本包是纯开服机，服主无法在此自助导入或编辑地图**。这是产品级缺口（`slim/ROADMAP.md` 决策 D5/D8），不是配置能绕开的。

## 必填 vs 有默认值的环境变量

空值会**直接抛错/拒绝服务**的（compose 里用 `${VAR:?}` 强制）：

| 变量 | 谁读它 | 空值后果 |
| --- | --- | --- |
| `PERMISSION_TOKEN_SECRET` | play + player-service | Play 无法向 Player Service 解析身份（`internalSecret()` 抛 `PERMISSION_TOKEN_SECRET is required for player identity`） |
| `BOX_PLAYER_AUTH_API_KEY` | player-service + player-auth-portal | 缺失时注册/登录/会话全部 503 `AUTH_API_KEY_NOT_CONFIGURED`；短于 16 字符视为未配置。门户进程（`apps/player-auth-portal/server/config.ts`）在同一个值 < 16 字符时**直接启动失败** |
| `BOX_DATABASE_URL` | play + player-service | 身份与地图数据都在 PostgreSQL，缺失即无法开服 |
| `BOX_MANAGED_POSTGRES_PASSWORD` | managed-postgres | 容器不启动 |
| `BOX_PLAYER_SERVICE_INTERNAL_URL` | play | `createServer` 路径抛 `BOX_PLAYER_SERVICE_INTERNAL_URL is not configured`。**本包已硬编码为 `http://player-service:3213`，无需服主配置** |

其余（运行时数量、超时、资源上限、速率限制、schema 名、Redis）都有可用默认值；Redis 留空单机仍可跑。

## 给真实玩家用还缺什么（已知缺口）

| 缺口 | 说明 | 结论 |
| --- | --- | --- |
| ~~登录门户~~ | 已补：`player-auth-portal` 常驻服务在 compose 里，浏览器自助注册/登录经门户代带 `x-box-player-auth-key`（原文见 `slim/impl/W4-play-lite-package.md` §11.4） | **已闭环**（注册→登录 Cookie→`/p/<id>` 200 实测通过） |
| **地图导入面** | 见上节：`.boxproject` 只认 creator | **必须补**（加 creator profile 或固定"出厂 creator 打包 → lite 导入"双栈流水线） |
| **HTTPS 反向代理** | 公网必须 TLS；`BOX_TRUST_PROXY=true` 且 `BOX_*_PUBLIC_URL`、`BOX_PLAYER_LOGIN_URL`、`BOX_AUTH_PORTAL_PUBLIC_URL` 填真实 HTTPS 地址。**否则经域名进图会被 307 回跳到 `http://127.0.0.1`，公网访客进不去**（实测） | **必须补** |
| **数据库备份** | 卷与地图目录不能替代 `pg_dump` | **必须补** |
| **公网可达的管理面** | `/api/play-admin/*` 经域名返回 401，唯一防线是 32 字符 owner token（`10 次/5 分钟` IP 级失败限流），无 Cloudflare Access 兜底 | 建议加 Access 或把 token 提到 ≥48 字符 |
| 创作/编辑器 | 无 creator/voxa | 可接受（定位即「纯开服机」） |
| 地图级容器隔离 | 声明 `isolation: container` 的地图回落共享运行时（告警一条） | 可接受，需向服主明示风险 |
| 语音 | 无 voxa | 可接受 |

运行时侧仍未证：`onPlayerJoin` 事件触发原文需要一次真实浏览器入局；客户端真实下载量本轮只测到服务端首包。

## 更新与回退

```sh
docker compose down                # 只影响本项目容器与卷
docker compose up -d --pull never  # 现役镜像已在本地时避免联网
```

## 打包清单

离线分发需要：`compose.yml` + `.env.example` + 本文件 + `play-worlds/` + 三个引擎镜像归档 + `postgres:16-alpine`。
三个引擎归档 gz 字节数（catalog `size` 字段口径，非本机实测镜像大小）：
`240,669,370 + 203,712,541 + 86,925,875 = 531,307,786 B`。门户是三项里唯一的增量成本（+86,925,875 B），换来浏览器可自助注册。

## 登录链路（运维面变化）

- 未登录玩家访问 `/p/<id>`：play 307 → `/api/player-login/start` → 302 到门户（带 `transferState`/`transferChallenge`），玩家在门户页注册/登录，门户服务端带密钥调 player-service，回跳 play `/api/player-login/callback` 换回 `box_local_player_session`/`box_local_player_device` Cookie。
- 门户容器 `read_only` + `cap_drop ALL` + 非 root + 仅 `/tmp` tmpfs，无任何宿主目录挂载，上限 128 MiB / 0.5 CPU / 64 pids。多出的一个常驻容器与 4125 端口是本包唯一运维面增量。
- 密钥 `BOX_PLAYER_AUTH_API_KEY` 同时注入 player-service 与 portal 两个容器（本就同值），浏览器拿不到。
