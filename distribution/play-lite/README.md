# BOX3 最小开服包（play-lite）：4 容器、零特权

只跑「玩家能进图开玩」这条链路：**Play + Player Service + 登录门户（player-auth-portal）+ PostgreSQL**。
与出厂全栈（7 常驻容器 / 9 宿主端口 / `server-manager` 挂 Docker socket 并常驻 root）相比：

| 指标                        | 出厂全栈 | play-lite | 变化      |
| --------------------------- | -------- | --------- | --------- |
| 常驻容器                    | 7        | 4         | −3（−43%）|
| 宿主端口                    | 9        | 4         | −5（−56%）|
| 挂载 `/var/run/docker.sock` | 1 个容器 | 0         | 归零      |
| 常驻 `user:"0:0"` 容器      | 1 个     | 0         | 归零      |
| 一次性 init 容器            | 3        | 1         | −2        |
| 空闲合计 RSS（3 容器基线实测同刻） | 328.05 MiB | 156.88 MiB（4 容器值 UNVERIFIED，待串行轮复测） | 见实施报告 |
| 镜像分发（gz，按目录清单字段） | 1,060,646,139 B | 531,307,786 B | −49.9%  |

复现命令与逐条原文输出见仓库实施报告
`box3-re/impl/W4-play-lite-package.md`（§3 为 3 容器基线，§11 为补门户后的 4 容器验证）。

## 为什么不需要 server-manager

`apps/local-engine/src/launcher.js` 只在地图 profile 声明 `isolation: container` 时才向
`BOX_RUNTIME_MANAGER_URL` 申请隔离容器；**没有配置该变量时记一条告警并回落到共享 Node 运行时**。
出厂 `docker-compose.yml` 把 `BOX_RUNTIME_MANAGER_URL` 默认指向 `http://server-manager:3130`，
所以边车被连带拉起。本包**故意不设置这两个变量**，实测效果：

- `createSession` 返回 200，地图运行时是 Play 容器内的普通 Node 子进程
  （`node dist/src/launch.js --useProdBundle` 及其 `ivmp-process-entry` 脚本子进程），
  全部以 UID 1000 运行；
- `box-local-engine-runtime` 隔离镜像本机根本没安装，去掉 server-manager 没有损失任何已在工作台的功能。

`distribution/play/compose.yml` 是同一结论的官方先例：它本来就不含 server-manager。

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

mkdir -p data/apps/local-engine/play-worlds data/apps/local-engine/data/blobs
# 地图：把完整发布目录放进 data/apps/local-engine/play-worlds/<作品ID>/
#       或用玩家后台导入 .boxplay
docker compose pull 2>/dev/null; docker compose up -d
docker compose ps
```

`play-storage-init` 跑完显示 `Exited (0)` 属正常；它是包里唯一 root 容器，且只做一次属主修正。

- Play：`http://127.0.0.1:4121/`
- 玩家登录门户：`http://127.0.0.1:4125/`（注册/登录页；`BOX_PLAYER_LOGIN_URL` 默认已指向它）
- 玩家后台：`http://127.0.0.1:4124/players`
- PostgreSQL：`127.0.0.1:4132`（**永远不要暴露到公网网卡**）

端口、监听地址、数据目录、project 名全部走 env：`BOX_PLAY_PORT`、`BOX_PLAYER_SERVICE_PORT`、
`BOX_AUTH_PORTAL_PORT`、`BOX_MANAGED_POSTGRES_HOST_PORT`、`BOX_BIND_IP`、
`BOX_LITE_DATA_DIRECTORY`、`BOX_LITE_PROJECT_NAME`。改 project 名即可在同机并存多套（卷名前缀随之隔离）。

## 必填 vs 有默认值的环境变量

空值会**直接抛错/拒绝服务**的（compose 里用 `${VAR:?}` 强制）：

| 变量 | 谁读它 | 空值后果 |
| ---- | ------ | -------- |
| `PERMISSION_TOKEN_SECRET` | play + player-service | Play 无法向 Player Service 解析身份（`internalSecret()` 抛 `PERMISSION_TOKEN_SECRET is required for player identity`） |
| `BOX_PLAYER_AUTH_API_KEY` | player-service + player-auth-portal | 缺失时注册/登录/会话全部 503 `AUTH_API_KEY_NOT_CONFIGURED`；短于 16 字符视为未配置。门户进程（`apps/player-auth-portal/server/config.ts`）在同一个值 < 16 字符时**直接启动失败** |
| `BOX_DATABASE_URL` | play + player-service | 身份与地图数据都在 PostgreSQL，缺失即无法开服 |
| `BOX_MANAGED_POSTGRES_PASSWORD` | managed-postgres | 容器不启动 |
| `BOX_PLAYER_SERVICE_INTERNAL_URL` | play | `createServer` 路径抛 `BOX_PLAYER_SERVICE_INTERNAL_URL is not configured`。**本包已硬编码为 `http://player-service:3213`，无需服主配置** |

其余（运行时数量、超时、资源上限、速率限制、schema 名、Redis）都有可用默认值；Redis 留空单机仍可跑。

## 给真实玩家用还缺什么（已知缺口）

| 缺口 | 说明 | 结论 |
| ---- | ---- | ---- |
| ~~登录门户~~ | 已补：`player-auth-portal` 常驻服务在 compose 里，浏览器自助注册/登录经门户代带 `x-box-player-auth-key`（验证原文见实施报告 §11.4） | **已闭环**（自助注册→登录 Cookie→`/p/<id>` 200 实测通过） |
| **HTTPS 反向代理** | 公网必须 TLS；`BOX_TRUST_PROXY=true` 且 `BOX_*_PUBLIC_URL`、`BOX_PLAYER_LOGIN_URL`、`BOX_AUTH_PORTAL_PUBLIC_URL` 填真实 HTTPS 地址 | **必须补** |
| **数据库备份** | 卷与地图目录不能替代 `pg_dump` | **必须补** |
| 创作/编辑器 | 无 creator/voxa：地图只能在别处做好后导入 | 可接受（本包定位即「纯开服机」） |
| 地图级容器隔离 | 声明 `isolation: container` 的地图会回落共享运行时（告警一条） | 可接受，需向服主明示风险 |
| 语音 | 无 voxa | 可接受 |

## 更新与回退

```sh
docker compose down          # 只影响本项目容器与卷
docker compose up -d --pull never   # 现役镜像已在本地时避免联网
```

## 打包清单

离线分发只需 `compose.yml` + `.env.example` + 本文件 + `play-worlds/` 与三个镜像：
`box-local-engine-play`、`box-local-engine-player-service` 与
`box-local-engine-player-auth-portal`（按 `BOX3-IMAGE-CATALOG.json` 对应归档，
共 240,669,370 + 203,712,541 + 86,925,875 = 531,307,786 字节 gz；目录字段口径，
非本机实测镜像大小）。生成脚本的落地方式与
对共享 `docker-compose.yml` 的影响评估见实施报告，未在本包内新增脚本。

## 登录链路（运维面变化）

- 未登录玩家访问 `/p/<id>`：play 307 → `/api/player-login/start` → 302 到门户
  （带 `transferState`/`transferChallenge`），玩家在门户页注册/登录，门户服务端带密钥
  调 player-service，回跳 play `/api/player-login/callback` 换回
  `box_local_player_session`/`box_local_player_device` Cookie。
- 门户容器 `read_only` + `cap_drop ALL` + 非 root + 仅 `/tmp` tmpfs，无任何宿主目录挂载，
  资源上限 128 MiB / 0.5 CPU / 64 pids。多出的一个常驻容器与 4125 端口是本包唯一运维面增量。
- 密钥 `BOX_PLAYER_AUTH_API_KEY` 现在同时注入 player-service 与 portal 两个容器（本就同值），
  浏览器仍然拿不到。
