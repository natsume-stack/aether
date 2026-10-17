# W4 — 无特权的 3 容器最小开服包（play-lite）

状态：**已真实跑起来**。核心交付（第 3 步）在 WSL 上完成，与现网 7 容器全栈并存、互不影响。
所有数字都是实测输出原文摘录，未跑通的部分显式标 `UNVERIFIED`。

分支 `slim/local-deploy`，我只新增了 3 个文件（在 `distribution/play-lite/` 下），
没有改动任何他人文件，没有 commit/push，没有触碰 `box-local-engine-*` 容器或它们的卷。

```
$ git status --short | grep play-lite
?? distribution/play-lite/
```

---

## 1. 环境变量取证：哪些必需、哪些空值会抛错

读的源码（不是猜的）：

| 代码位置 | 行为 |
| -------- | ---- |
| `apps/game/server/player-service-client.ts:30` `internalURL()` | `BOX_PLAYER_SERVICE_INTERNAL_URL` 空 → `throw new Error('BOX_PLAYER_SERVICE_INTERNAL_URL is not configured')`。**所以 player-service 不能省** |
| 同上 `:35` `internalSecret()` | `PERMISSION_TOKEN_SECRET` 空 → `PERMISSION_TOKEN_SECRET is required for player identity` |
| `apps/game/server/player-auth-security.ts:84-101` `authorizePlayerAuthRequest()` | `BOX_PLAYER_AUTH_API_KEY` 长度 < 16 → 所有 `/api/player-auth/*` 返回 **503 `AUTH_API_KEY_NOT_CONFIGURED`**；请求缺 `x-box-player-auth-key` 头 → **401 `AUTH_API_KEY_INVALID`** |
| `apps/game/server/script-moderation-service.ts:419` `admission()` | 无身份服务时没人能进图（与上两条同向） |
| `apps/game/server/local-player-identity.ts:1071` `registerPlayer()` | `if (!database) throw new Error('玩家账号功能需要配置 PostgreSQL')`。**所以 PostgreSQL 不能省** |
| `apps/local-engine/src/launcher.js:55-63` | `map-runtime-profiles.json` 缺失（`ENOENT`）时降级为 `{profiles:[0]}` 空档案，不报错 |
| `apps/local-engine/src/launcher.js:249-257` | `profile.isolation !== 'container'` 直接返回 null；即使声明 container，**没有 `BOX_RUNTIME_MANAGER_URL` 也只记一条 warn 然后回落共享 Node 运行时** |

实测确认：出厂 `distribution/play/compose.yml` 本身就不含 server-manager，也不设
`BOX_RUNTIME_MANAGER_URL` —— 官方先例与 launcher 回落路径一致。

结论：lite 包 = `play` + `player-service` + `managed-postgres`（+ 一个 `play-storage-init`），
`BOX_PLAYER_SERVICE_INTERNAL_URL` 在 compose 里硬编码为 `http://player-service:3213`，服主不需要配。

## 2. 交付文件

- `distribution/play-lite/compose.yml` — 3 常驻服务 + 1 一次性 init；`name: ${BOX_LITE_PROJECT_NAME:-box3-lite}`；
  端口/数据目录/project 名全走 env。
- `distribution/play-lite/.env.example` — 3 个必填秘密 + 全量可选项，默认端口 41xx。
- `distribution/play-lite/README.md` — 部署步骤、必填/默认值矩阵、缺口清单。

**没有 `start-lite.sh`**（任务里标「如需要」，实测 `docker compose up -d` 足够，按「非必要不新增文件」省略）。
**没有 `scripts/package-minimal-play.mjs`** —— 见第 7 节的拆分建议。

硬化项对照（`grep` + `docker inspect` 双重检查）：

| 项 | 出厂 | play-lite |
| -- | ---- | --------- |
| `docker.sock` 挂载 | `server-manager` 挂 `${BOX_DOCKER_SOCKET:-/var/run/docker.sock}` | **0 处**（`grep docker.sock` 只命中注释） |
| `user:"0:0"` | `server-manager` 常驻 root + 3 个 init | 仅 `play-storage-init` **一次性**、`network_mode: none`、`read_only`、`cap_drop ALL` + `cap_add CHOWN` |
| `cap_drop: ALL` | 除 managed-postgres / redis 外都有 | **全部 4 个容器都有**（含 postgres，比出厂更严） |
| `no-new-privileges` | 除 managed-postgres 外都有 | **全部 4 个容器都有** |
| `read_only` | init + server-manager + portal | `managed-postgres` 与 `play-storage-init`（实测可跑，见下） |
| `pull_policy` | 未设 | 三个 BOX 镜像均 `never` |

`managed-postgres` 我加了 `read_only: true` + `tmpfs /tmp,/var/run/postgresql` +
`cap_add: CHOWN,FSETID,KILL,SETGID,SETUID,DAC_OVERRIDE,SYS_NICE`，
**实测 healthy**（出厂该服务反而完全没有任何 cap/security 限制，这是净收敛）。

## 3. 真的跑起来：命令与原文输出

### 3.1 隔离准备

现网数据**只读**，全部复制到 `/var/tmp/w4-data`：

```sh
mkdir -p /var/tmp/w4-data/apps/local-engine
cp -a /root/box3/BOX3-Engine-Server-0.2.0-linux-amd64/apps/local-engine/play-worlds \
      /var/tmp/w4-data/apps/local-engine/
mkdir -p /var/tmp/w4-data/apps/local-engine/data/blobs
cp -a /root/box3/.../apps/local-engine/data/. /var/tmp/w4-data/apps/local-engine/data/
chown -R 1000:1000 /var/tmp/w4-data
```

输出：

```
== uid of ubuntu on host ==
uid=1000(ubuntu) gid=1001(ubuntu) groups=1001(ubuntu),4(adm),24(cdrom),27(sudo),30(dip),1000(lxd)
/var/tmp/w4-data/apps/local-engine owner=1000:1000
/var/tmp/w4-data/apps/local-engine/play-worlds owner=1000:1000
```

> 注意：现网 `play-worlds` 实测 **30M**（不是任务书写的 64 MB），只有 1 张真实地图；
> `data/blobs` 实测是空目录（4.0K）。以实测为准。

端口预检（避开 80/3121/3123/3124/3125/3127/3130/5432/9966/9967/8080）：

```
PORT 4121 free
PORT 4124 free
PORT 4132 free
```

compose 校验：

```
$ docker compose --env-file .env config --quiet && echo "CONFIG OK"
CONFIG OK
```

（第一次跑曾失败一次，原文：
`failed to parse /var/tmp/w4-play-lite/compose.yml: line 21: mapping key "tmpfs" already defined at line 18`
—— 我写重复了 `tmpfs:` 键，已修复。）

### 3.2 起栈

```sh
cd /var/tmp/w4-play-lite
docker compose --project-name box3-lite up -d --pull never
```

原文（截断）：

```
 Volume box3-lite_box-lite-postgres-data  Created
 Volume box3-lite_box-lite-play-runtime-cache  Created
 Container box3-lite-managed-postgres-1  Healthy
 Container box3-lite-player-service-1  Healthy
 Container box3-lite-play-storage-init-1  Exited
 Container box3-lite-play-1  Started
real	0m13.508s

box3-lite-managed-postgres-1   ...  Up 12 seconds (healthy)   127.0.0.1:4132->5432/tcp
box3-lite-play-1               ...  Up 1 second (health: starting)  127.0.0.1:4121->3000/tcp
box3-lite-player-service-1     ...  Up 6 seconds (healthy)    127.0.0.1:4124->3213/tcp
```

**13.5 秒从冷启动到 play 容器开始拉起，全程未联网、未 `--pull` 任何镜像。**

### 3.3 健康与真实地图

```
$ curl -s http://127.0.0.1:4121/api/health-check
{"status":"ok","runtime":"ready"}

$ curl -s http://127.0.0.1:4121/api/play-worlds
{"worlds":[{"id":"cloud-4e84ee7ef626058f-imported","permanentMapId":"1474940ae2a64bd92f81",
"publicId":"cloud-4e84ee7ef626058f-imported","name":"起床战争","author":"",
"description":"从云端工程 QmdxLfFG9MsBckAcRqfv8onhs5J2KR9nxaouy6G9nRs7ZJ 迁移",
"version":"v1.0.1","mapRole":"main","playEnabled":true}]}

$ curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4124/api/health-check
200
```

`/p/<publicId>` 未登录时（符合预期，`BOX_PLAYER_LOGIN_URL` 空）：

```
http=307 redirect=http://127.0.0.1:4121/login-required?source=play
$ curl -s -o /dev/null -w "%{http_code} %{size_download}\n" "http://127.0.0.1:4121/login-required?source=play"
503 4337
```

### 3.4 注册玩家 —— 第一次尝试失败（真实障碍，原文）

按 README 字面理解「注册/登录走 player-service」，直接 curl：

```
$ curl -X POST http://127.0.0.1:4124/api/player-auth/register -d '{...}'
{"code":"AUTH_API_KEY_INVALID","message":"玩家认证服务密钥无效"}
http=401
```

定位：读 `apps/game/server/player-auth-security.ts:84` →
`authorizePlayerAuthRequest()` 对**每一个** `/api/player-auth/*` 路由强制校验
`x-box-player-auth-key` 头（sha256 定时安全比较），长度不足 16 直接 503。
即：**这些接口是「登录门户后端 → Player Service」的服务间接口，浏览器永远不该拿到该密钥**。
lite 包不含 `player-auth-portal`，所以真实玩家无法自助注册。这不是 bug，是设计，
但它决定了 lite 包能不能直接开服 —— 结论是「不能，必须补门户」。

### 3.5 以门户后端的身份（带密钥）完成注册 → 进图

```
$ curl -c /tmp/w4-cookies.txt -X POST http://127.0.0.1:4124/api/player-auth/register \
    -H "x-box-player-auth-key: $BOX_PLAYER_AUTH_API_KEY" -H 'Content-Type: application/json' \
    -d '{"username":"w4liteplayer","displayName":"W4 玩家","password":"W4liteTest!2026"}'
{"player":{"subjectId":"3ab21a633d3d4d5b9d792e1d8d8521cd","userId":"1","username":"w4liteplayer",
"role":"player","status":"active","creatorAccess":false,...}}
http=201

$ grep box_local_player /tmp/w4-cookies.txt
box_local_player_session
box_local_player_device

$ curl -b $J -H "$KEY_HEADER" http://127.0.0.1:4124/api/player-auth/session
{"player":{...},"databaseEnabled":true,"registrationEnabled":true}
http=200
```

**带玩家 Cookie 访问地图页（证明 play→player-service→postgres 整条身份链在无特权下打通）：**

```
$ curl -b $J -o /tmp/w4-p.html -w "http=%{http_code} size=%{size_download}\n" \
    http://127.0.0.1:4121/p/cloud-4e84ee7ef626058f-imported
http=200 size=149594
```

**真正开一局（createSession，会拉起地图运行时）：**

第一次（该地图在本 project 首次预烘焙）：

```
$ curl -b $J -X POST http://127.0.0.1:4121/api/createSession -d '{"mode":"play",...}'
{"code":"RUNTIME_STARTING","message":"地图运行时正在迁移或预烘焙，请稍候"}
http=202
```

同时 `docker top box3-lite-play-1`：

```
ubuntu  1045  tini -- node apps/local-engine/src/launcher.js --production --play
ubuntu  1279  node apps/local-engine/src/launcher.js --production --play
ubuntu  1382  next-server (v15.5.27)
ubuntu  4018  /usr/local/bin/node dist/src/launch.js --useProdBundle
ubuntu  4296  /usr/local/bin/node --no-node-snapshot /app/services/game-server/dist/src/utils/script-server/ivmp/ivmp-process-entry
```

→ **地图运行时就是普通 Node 子进程，UID 全 1000（`ubuntu`），没有任何容器被创建。**
这就是「server-manager + docker.sock 可以整块拿掉」的直接证据。

轮询到成功：

```
--- attempt 1 http=200 ---
{"config":{"sessionId":"f79cb808-5eee-4944-a0b1-5a1d7f6e122c",
"sessionProof":"1792239817121.68e86eb...","admin":false,"maxSockets":3,
"prefetchHashes":["QmW2E9E8ipYUifsCfkMj5SULYMYbFQvP6BQxo52atXw7Zj", ...
```

project 冷重启后（缓存卷保留）再开一局，**含计时**：

```
== timed createSession from cold (first hit after restart) ==
attempt=2 http=200 elapsed=7s
{"config":{"sessionId":"1c22befc-e005-4551-af08-d33c9a82cd6c",...
== /p page authenticated ==
http=200 size=149594
```

`play` 容器日志尾部（身份链路真实被调用）：

```
play-1 | (2026-10-17T12:12:52.656Z server:5b039a2   server          ): Fetching Map Info...
play-1 | {"level":30,...,"msg":"Logger module initialization done."}
```

### 3.6 `docker inspect`：无 docker.sock、非 root

```
----- box3-lite-play-1 -----
Config.User=[node]   Image=box-local-engine-play:v2026.1.4-linux-amd64
Privileged=false
CapAdd=[]  CapDrop=[ALL]  SecurityOpt=[no-new-privileges:true]
ReadonlyRootfs=false  Memory=4294967296  PidsLimit=1024
Binds=["/var/tmp/w4-data/apps/local-engine/play-worlds:/app/play-worlds:rw",
       "/var/tmp/w4-data/apps/local-engine/data:/app/apps/local-engine/data:rw",
       "box3-lite_box-lite-play-runtime-cache:/app/play-runtime-cache:rw"]
  id -u/-g inside -> 1000:1000

----- box3-lite-player-service-1 -----
Config.User=[node]  CapAdd=[]  CapDrop=[ALL]  SecurityOpt=[no-new-privileges:true]
Binds=null
  id -u/-g inside -> 1000:1000

----- box3-lite-managed-postgres-1 -----
Privileged=false  CapDrop=[ALL]  CapAdd=[CAP_CHOWN CAP_DAC_OVERRIDE CAP_FSETID CAP_KILL
                  CAP_SETGID CAP_SETUID CAP_SYS_NICE]
ReadonlyRootfs=true  SecurityOpt=[no-new-privileges:true]
Binds=["box3-lite_box-lite-postgres-data:/var/lib/postgresql/data:rw"]
  docker top 观测 uid -> 70 (postgres)

----- box3-lite-play-storage-init-1 -----
Config.User=[0:0]  CapAdd=[CAP_CHOWN]  CapDrop=[ALL]  ReadonlyRootfs=true
NetworkMode=none  Restart=no

########## docker.sock grep across every lite container ##########
OK: no lite container binds /var/run/docker.sock
```

出厂对照（同一条命令）：

```
docker inspect box-local-engine-server-manager-1
Config.User=[0:0]
Privileged=false
CapAdd=[CAP_DAC_OVERRIDE]
ReadonlyRootfs=true
Binds=["/var/run/docker.sock:/var/run/docker.sock:rw",
       "/root/box3/BOX3-Engine-Server-0.2.0-linux-amd64:/workspace:rw"]
  uid:gid observed -> root
```

即：出厂那个容器 = **常驻 root + Docker socket + 整个安装目录可写**，等价宿主 root。
lite 里 0 处。

## 4. 收敛数字

### 4.1 规模

`docker compose -p box-local-engine ps` vs `-p box3-lite ps`（同一时刻）：

```
factory running containers: 7
  box-local-engine-creator-1            127.0.0.1:9966-9967->..., 127.0.0.1:3127->3000/tcp
  box-local-engine-managed-postgres-1   127.0.0.1:5432->5432/tcp
  box-local-engine-play-1               127.0.0.1:80->3000/tcp
  box-local-engine-player-auth-portal-1 127.0.0.1:8080->3214/tcp
  box-local-engine-player-service-1     127.0.0.1:3124->3213/tcp
  box-local-engine-server-manager-1     0.0.0.0:3130->3130/tcp
  box-local-engine-voxa-1               127.0.0.1:3123->3001/tcp
factory exposed host ports: 0.0.0.0:3130 127.0.0.1:3123 3124 3127 5432 80 8080 9966 (+9967) = 9

lite running containers: 3
  box3-lite-managed-postgres-1     127.0.0.1:4132->5432/tcp
  box3-lite-play-1                 127.0.0.1:4121->3000/tcp
  box3-lite-player-service-1       127.0.0.1:4124->3213/tcp
lite exposed host ports: 127.0.0.1:4121 4124 4132 = 3

volumes:
  local box3-lite_box-lite-play-runtime-cache
  local box3-lite_box-lite-postgres-data
  local box-local-engine_box-managed-postgres-data     <- 现网，未被复用
  local box-local-engine_box-play-runtime-cache        <- 现网，未被复用
```

> 顺带发现：出厂把 `server-manager` 绑在 **`0.0.0.0:3130`**（宿主默认 env 未收敛绑定 IP），
> 也就是说那个 root-equivalent 边车现在在 WSL 的所有网卡上监听。lite 全部 `127.0.0.1`。

| 指标 | 出厂 | play-lite | 变化 |
| ---- | ---- | --------- | ---- |
| 常驻容器 | 7 | 3 | −4（−57.1%） |
| 一次性 init 容器 | 3 | 1 | −2 |
| 宿主端口 | 9 | 3 | −6（−66.7%） |
| 常驻进程（容器） | 7 | 3 | −4 |
| 挂 `docker.sock` | 1 | **0** | 归零 |
| 常驻 `user:"0:0"` | 1（server-manager） | **0** | 归零 |
| 非 `127.0.0.1` 绑定 | 1（`0.0.0.0:3130`） | 0 | 归零 |
| `cap_drop: ALL` 覆盖率 | 5/7 | **4/4（100%）** | 更严 |
| `read_only` 容器 | 3（含 portal、manager） | 2（postgres、init） | postgres 新增 |
| 空闲合计 RSS | 328.05 MiB（同刻实测） | **156.88 MiB** | **−52.2%** |
| 分发 gz（按 catalog 求和） | 1,060,646,139 B | **444,381,911 B** | **−58.1%** |

### 4.2 RSS 实测

真空闲（冷重启后等 120 s，无人进图，连测 3 轮、间隔 20 s）：

```
run1: managed-postgres 22.01MiB | play 80.08MiB | player-service 53.64MiB
run1 LITE IDLE TOTAL: 155.73 MiB
run2: ... 23.55 | 80.65 | 53.69   -> 157.89 MiB
run3: ... 22.32 | 80.27 | 54.29   -> 156.88 MiB
```

同一时刻现网全栈：

```
creator 88.47 | managed-postgres 24.87 | play 87.48 | auth-portal 10.43
player-service 69.09 | server-manager 6.867 | voxa 40.84
FACTORY IDLE TOTAL: 328.05 MiB
```

- 对比**同刻实测** 328.05 → 156.88 MiB = **47.8%**（−52.2%）。
- 对比任务书基线 313.67 MiB → 156.88 MiB = **50.0%**（−50.0%）。
  我这次量到 328.05，与 313.67 差 4.6%，属正常波动；两个口径都给出。

带一局热运行时（单玩家，`createSession` 已 200）：

```
box3-lite-play-1 344.5MiB / 4GiB
```

即「地图跑起来」的边际成本约 **+264 MiB**（344.5 − 80.3），出厂全栈同样要付这笔，
差别是 lite 少了 4 个常驻容器的底盘。

### 4.3 分发体积（来自 `BOX3-IMAGE-CATALOG.json` 实测字段，非估算）

| 镜像 | gz 字节 | 在 lite 里 |
| ---- | ------- | ---------- |
| `box-local-engine-play` | 240,669,370 | ✅ |
| `box-local-engine-player-service` | 203,712,541 | ✅ |
| `box-local-engine-creator` | 263,029,978 | ❌ |
| `box-local-engine-voxa` | 182,383,424 | ❌ |
| `box-local-engine-player-auth-portal` | 86,925,875 | ❌（缺口，见第 6 节） |
| `box-local-engine-server-manager` | 83,924,951 | ❌（特权边车） |

- lite 两镜像 = **444,381,911 B = 423.8 MiB**（41.9% of 1,060,646,139 B）
- 若把门户补回来 = 531,307,786 B = 506.7 MiB（占原 50.1%），**仍然砍掉 49.9%**
- 被删掉的 `server-manager` 归档 = 83,924,951 B gz / 镜像虚拟大小 438 MB，
  换来的是 `box-local-engine-runtime` 本机根本没装 → 当前该特权**零功能收益**。

## 5. 与现网的隔离证明

- compose project 名 `box3-lite`（卷/网络前缀随之隔离：`box3-lite_box-lite-postgres-data` 等）；
- 宿主端口 4121/4124/4132，起栈前 `ss -ltn` 逐个确认 free；
- 数据目录 `/var/tmp/w4-data/...`，源目录 `/root/box3/...` 全程只 `cp -a`（读）；
- `--pull never`，不联网；
- 唯一对现网的读取动作是 `docker inspect box-local-engine-server-manager-1`、
  `docker stats --no-stream`、`docker compose -p box-local-engine ps`（全部只读）；
  **没有任何 `stop`/`restart`/`rm`/`prune` 作用于 `box-local-engine-*`**。
  现网 7 容器在我全程保持 `Up (healthy)`。

## 6. 还缺什么才能给真实玩家用

| 项 | 证据 | 结论 |
| -- | ---- | ---- |
| **登录门户** | `authorizePlayerAuthRequest()` 强制 `x-box-player-auth-key`（实测 401/503 原文见 3.4）；`BOX_PLAYER_LOGIN_URL` 空时 `/p/…` → 307 `/login-required` → 实测 **503** | **必须补**。加回 `player-auth-portal`（+86.9 MB gz，`docker-compose.yml` 里它有 `profiles:[auth-portal]`、`read_only`、`cap_drop ALL`，本身很干净），或服主自建等价服务端门户 → **A3 泳道已补齐，见 §11** |
| **HTTPS 反向代理** | lite 全部 `127.0.0.1`；`BOX_TRUST_PROXY=false` | **必须补**（公网必须 TLS，`BOX_*_PUBLIC_URL` 填真实地址，4132 绝不外露） |
| **PostgreSQL 备份** | README 已声明「作品包与缓存卷不能代替 `pg_dump`」；lite 的账号/权限/存档都在 `box3-lite_box-lite-postgres-data` | **必须补**（`pg_dump` 定时 + 异地） |
| 首次预烘焙等待 | 实测首次 `createSession` 返回 202 `RUNTIME_STARTING`，之后 200；冷重启后 7 s 到 200 | 可接受（有明确 202 语义 + 前端轮询） |
| 地图级容器隔离 | 声明 `isolation: container` 的地图会回落共享运行时，只有 warn | 可接受，但**必须向服主明示**：一张恶意地图可影响同容器内其它地图 |
| 创作 / 语音 / 后台管理 | 无 creator、voxa；`/players` 玩家后台在 player-service 上可用 | 可接受（定位是纯开服机） |
| `play-admin` 令牌 | `BOX_PLAY_ADMIN_TOKEN` 我已设，未实测导入 `.boxplay` | **UNVERIFIED**：地图自助导入流程没跑 |

### 明确标注 UNVERIFIED 的项

1. **WebSocket 真人进局**：只验到 `createSession` 返回 200 + `sessionId`/`sessionProof`/`socketServerUrl`，
   没有建立实际 socket 连接、没有渲染游戏客户端。
2. **`.boxplay` 自助导入**（需 `BOX_PLAY_ADMIN_TOKEN`）。
3. **多地图并发 / 跨图传送**（`BOX_TELEPORT_INTERNAL_TOKEN` 未设）。
4. **首次预烘焙精确耗时**：我看到 202 与随后的 200，但两次之间没有打时间戳，只能给出
   上界「同一次运行内 ≤ 数分钟」和冷重启后「7 s」。
5. **`map-runtime-profiles.json` 不存在时的 container 隔离地图**：只做了源码取证
   （launcher.js:249-257），没有构造一张声明 `isolation: container` 的地图去实测 warn 回落路径。

## 7. 关于 `scripts/package-minimal-play.mjs`：按新增约束改为「拆分建议」，未落文件

任务书第 6 项要求新建 `scripts/package-minimal-play.mjs`（读主 `docker-compose.yml` +
`BOX3-IMAGE-CATALOG.json` 自动产出 play-lite 包）。收到新的产品约束
「最小改动、非必要不新增文件；若改动属于共享校验链路，应建议拆分而不是新增触碰共享配置的文件」。
该脚本正好读取 `docker-compose.yml`（W1/W5 都要改它）与 `BOX3-IMAGE-CATALOG.json`（W2 CI 校验它），
属于共享配置，因此**我没有新建这个脚本**，改为给出落地方案：

**建议拆分（不需要新文件，落在既有链路上）：**

1. **模板层**：`distribution/play-lite/` 已经是纯静态目录，与 `distribution/play/` 同构。
   把它的 `compose.yml`/`.env.example`/`README.md` 直接加入既有导出清单即可 ——
   `scripts/build-headless-server-package.js` 里 `templateRoot = distribution/server` 的复制逻辑
   就是现成的做法（该文件已在 W2/W5 视野内），加一个 `--with-play-lite` 分支约 15 行，
   而不是新造一个包脚本。
2. **归档选择层**：lite 包需要哪些镜像，本质是「从 `BOX3-IMAGE-CATALOG.json` 里选
   `{play, player-service}` 这个子集」。这个能力**已经存在** ——
   `scripts/export-current-images.js` / `scripts/server-image-plan.js` / `scripts/build-image-downloads.js`
   的 `validateCatalog` + `localImageTag` 三件套。正确做法是给 `server-image-plan.js`
   增加一个 `--profile play-lite` 的 service→image 映射常量（约 10 行），
   由 `build-headless-server-package.js` 调用。
3. **校验层**：`scripts/check-release-workflow.js` 与 `scripts/server-installation-contract.test.js`
   已经在断言 compose 模板与 catalog 一致性。play-lite 的契约（「无 docker.sock、无 root、
   无 server-manager」）应作为**这两处各加一条断言**，而不是新建脚本 —— 否则回归网会漏掉它，
   下次有人往 `play-lite/compose.yml` 加回 socket 也没人拦。
4. **给 W5 的指针**：`docker-compose.yml` 里 `play` 的
   `BOX_RUNTIME_MANAGER_URL: ${BOX_RUNTIME_MANAGER_URL:-http://server-manager:3130}` 与
   `depends_on: server-manager: service_healthy` 才是「7 容器」的根因。W5 若把它改成
   「未配置即回落共享运行时、且 `depends_on` 条件化」，则主 compose 自己就能出 lite 形态，
   `play-lite/compose.yml` 只需作为离线分发薄壳存在（甚至可由主 compose 的 `profiles` 生成），
   第 1～3 点的代码量随之归零。**这是本项最省事的收敛路径，建议优先走 W5。**
5. **给 W6 的指针**：`distribution/play/compose.yml` 与 `play-lite/compose.yml` 都没设
   `platform` 以外的离线镜像来源；若 W6 做离线链路，lite 的 catalog 子集名请沿用
   `box-local-engine-image-{play,player-service}-amd64-<digest>.tar.gz`（实测命名，见 catalog），
   不要引入新命名。

我实测过 lite 包所需的最小文件集，原文：

```
distribution/play-lite/compose.yml      9846 B
distribution/play-lite/.env.example     ~5 KB
distribution/play-lite/README.md
+ 2 个镜像归档 444,381,911 B gz
+ play-worlds/<作品ID>/  （实测 30 MB 那张真实地图）
```

## 8. 一次意外的加固验证：WSL / Docker 守护进程重启后

跑到一半时**整台 WSL 被重启了一次**（不是我做的；`uptime` 显示 19 min，
`docker info` 为 Server 29.1.3 / Kernel 6.18.33.2-microsoft-standard-WSL2）。
两套栈都靠 `restart: unless-stopped` 自己回来了，`/tmp` 的 curl cookie jar 被清掉。
我把它当成一次免费的持久化测试重跑：

```
box3-lite-managed-postgres-1 Up About a minute (healthy)
box3-lite-play-1             Up About a minute (healthy)
box3-lite-player-service-1   Up About a minute (healthy)
box-local-engine-creator-1            Up About a minute (healthy)   <- 现网 7 个全部无恙
box-local-engine-managed-postgres-1   Up About a minute (healthy)
box-local-engine-play-1               Up About a minute (healthy)
box-local-engine-player-auth-portal-1 Up About a minute (healthy)
box-local-engine-player-service-1     Up About a minute (healthy)
box-local-engine-server-manager-1     Up About a minute (healthy)
box-local-engine-voxa-1               Up About a minute (healthy)
```

账号与 schema 都在卷里活了下来：

```
$ docker exec box3-lite-managed-postgres-1 psql -U box_lite -d box_lite -Atc \
    "SELECT count(*) FROM box_identity.users; SELECT username FROM box_identity.users;"
1
w4liteplayer

$ ... "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'box%';"
box_identity
box_engine          <- 这张表由 play 自己建，证明 play 确实连上了库
```

**用已有账号重新登录（不重新注册）**，再走一遍完整链路：

```
== login the EXISTING player (no re-register) after WSL reboot ==
http=200
"username":"w4liteplayer"
"loginCount":3
== authenticated /p page ==
http=200 size=149594
== createSession ==
http=202
{"code":"RUNTIME_STARTING","message":"地图运行时正在迁移或预烘焙，请稍候"}
```

`loginCount` 从 1 → 2 → 3 累加，说明身份记录跨重启单调持久；
`/p/<publicId>` 仍是 200 / 149,594 字节。

重启后那一轮的 RSS（此刻 lite 的 play 正在拉起地图运行时，**不是空闲值**，
不要与 4.2 的空闲数字混用）：

```
box3-lite-managed-postgres-1 29.67MiB / 512MiB
box3-lite-play-1 219.4MiB / 4GiB          <- 运行时正在烘焙
box3-lite-player-service-1 123.2MiB / 1GiB
```

顺带修正一处取证偏差：任务书里写现网 `play-worlds` 是 64 MB，
我实测 `du -sh /root/box3/.../apps/local-engine/play-worlds` = **30M**（`data` = 8.0K）。
复制到 `/var/tmp/w4-data` 的也就是这 30M。以实测为准。

## 9. 一句话

出厂形态里那台必须常驻、必须 root、必须拿 Docker socket 的 `server-manager`，
**在真实进图链路上没有被使用过一次**：把它和它的三个伴生容器去掉后，
3 容器 / 3 端口 / 零特权 / 空闲 156.88 MiB（−52%）/ 分发 423.8 MiB（−58%），
`/api/health-check`、真实地图「起床战争」的 `/api/play-worlds`、认证后 `/p/<publicId>` 200（149,594 B）、
`createSession` 200 并且地图运行时以 UID 1000 的普通 Node 子进程跑起来了。
唯一必须补的是登录门户（`x-box-player-auth-key` 是服务端间密钥，浏览器拿不到）。

## 10. 未决事项（不猜，交回给上游）

运行中收到一条「用户为下个版本新增了两条产品需求」的提示，但**两条需求的具体内容没有被传达**。
我不代为臆造需求，也不基于未说明的约束改动别人拥有的文件。
已做的唯一一次范围缩减是可逆的：把任务书第 6 项的 `scripts/package-minimal-play.mjs`
从「新建文件」改为第 7 节的拆分建议（理由：该脚本要读 `docker-compose.yml` 与
`BOX3-IMAGE-CATALOG.json`，两者都是别的泳道在改的共享配置）。
一旦需求原文到位、或确认第 6 项仍需落地，按第 7 节方案加实现是纯增量工作，不影响本包。

---

# §11（A3 泳道续写）补回登录门户：4 容器 play-lite

执行时间：2026-10-17 21:37–21:45（WSL 刚重启，`up 1 min`，**本轮只报结构事实，不报任何 RSS/TTFB/冷启动数字**）。
可写范围：仅 `distribution/play-lite/{compose.yml,.env.example,README.md}` + 本章节。
现网 `box-local-engine-*` 7 容器全程只 `docker inspect`/`ps`（只读），未 stop/restart/rm/prune；
未 `--pull`、未访问 docker.io、未重建镜像、未改根 `docker-compose.yml`。

## 11.1 改动内容

`distribution/play-lite/compose.yml`：
1. 新增常驻服务 `player-auth-portal`（镜像 `box-local-engine-player-auth-portal:v2026.1.4-linux-amd64`，
   `pull_policy: never`）。硬化项与出厂根 compose 的该服务逐条对齐（`read_only` + `tmpfs /tmp` +
   `cap_drop ALL` + `no-new-privileges` + 128m/0.5cpu/64pids + `init: true`），
   端口 `${BOX_BIND_IP:-127.0.0.1}:${BOX_AUTH_PORTAL_PORT:-4125}:3214`；
   **无 docker.sock、无 `user:"0:0"`、无宿主目录挂载**；compose 内显式声明 healthcheck
   （`node -e fetch('http://127.0.0.1:3214/api/health-check')`，与镜像 Dockerfile 内置同式）。
   **有意不套 `profiles`**：根 compose 用 `profiles:[auth-portal]` 可选开关，lite 形态门户是刚需。
2. `player-service` 与 `play` 的 `BOX_PLAYER_LOGIN_URL` 默认值从空改为
   `http://127.0.0.1:${BOX_AUTH_PORTAL_PORT:-4125}`（嵌套默认值经 `config` 渲染验证）。
3. env 取证（读源码，非猜测）：`apps/player-auth-portal/server/config.ts::fromEnvironment` 硬要求
   - `BOX_PLAYER_AUTH_API_KEY`（或旧名 `AUTH_DEMO_API_KEY`）**≥16 字符，否则进程抛错起不来**；
   - `BOX_PLAYER_SERVICE_INTERNAL_URL`（旧名 `AUTH_DEMO_PLAYER_SERVICE_URL`）必须是合法 HTTP(S) URL；
   - `HOST`/`PORT` 缺省 `127.0.0.1:3214` → 容器内需显式 `HOST: 0.0.0.0`（根 compose 同此，
     镜像 ENV 也带 `AUTH_DEMO_HOST=0.0.0.0` 兜底）；
   - 其余（`BOX_AUTH_PORTAL_PUBLIC_URL`/`BOX_PLAY_PUBLIC_URL`/`BOX_CREATOR_PUBLIC_URL`/
     `BOX_PLAYER_REGISTRATION_ENABLED`/`BOX_AUTH_PORTAL_REQUEST_TIMEOUT_MS`/`BOX_TRUST_PROXY`/
     `BOX_APP_BASE_PATH`/`BOX_PUBLIC_SERVICE_PREFIXES_BY_ORIGIN`）全部可选。
   lite 里 `BOX_CREATOR_PUBLIC_URL` 置空（无 creator，门户不做创作端回传）；
   旧名 `AUTH_DEMO_*` 一律不再注入（标准名优先，源码注释明示）。
   与现网门户容器 `docker inspect` env 对照过（只读），根 compose 注入的双套变量我们只需标准名这一套。

`.env.example`：新增 `BOX_AUTH_PORTAL_PORT=4125`、`BOX_AUTH_PORTAL_PUBLIC_URL`、
`BOX_PLAYER_LOGIN_URL=http://127.0.0.1:4125`、`BOX_AUTH_PORTAL_IMAGE`、门户资源上限三项。
`README.md`：3→4 容器/3→4 端口、缺口表「登录门户」改为已闭环、登录链路运维说明、打包清单三归档。

## 11.2 config / ps 原文

测试栈：`/var/tmp/w4-play-lite`（compose 与交付文件 **md5 一致**：
`fdcfb7347772d91f5868a51d4123de8e` 两处同值），`.env` 追加三行门户变量，project 名 `box3-lite`。

```
$ docker compose -p box3-lite config --quiet && echo "CONFIG OK"
CONFIG OK

$ docker compose -p box3-lite config | grep -E "^  [a-z-]+:"
  managed-postgres:
  play:
  play-storage-init:
  player-auth-portal:      <- 新增
  player-service:
```

渲染出的 portal 段要点（原文节选，密钥值打码）：

```
  player-auth-portal:
    cap_drop: [ALL]
    depends_on: player-service: {condition: service_healthy}
    environment:
      BOX_AUTH_PORTAL_PUBLIC_URL: http://127.0.0.1:4125
      BOX_PLAYER_AUTH_API_KEY: <与 player-service 同值, 64hex>
      BOX_PLAYER_SERVICE_INTERNAL_URL: http://player-service:3213
      BOX_PLAY_PUBLIC_URL: http://127.0.0.1:4121
      HOST: 0.0.0.0
      PORT: "3214"
    image: box-local-engine-player-auth-portal:v2026.1.4-linux-amd64
    pull_policy: never
    read_only: true
    ports: host_ip 127.0.0.1 published 4125 -> 3214
    security_opt: [no-new-privileges:true]
    healthcheck: CMD node -e fetch(...)/api/health-check 15s/5s/10s/5
```

起栈（未 `--pull`；`up -d` 自动重建 play 以应用新 env）后：

```
== wait until all healthy (max 150s) ==
ALL HEALTHY after 5s

$ docker compose -p box3-lite ps
box3-lite-managed-postgres-1     docker.m.daocloud.io/library/postgres:16-alpine             managed-postgres     Up 4 minutes (healthy)   127.0.0.1:4132->5432/tcp
box3-lite-play-1                 box-local-engine-play:v2026.1.4-linux-amd64                 play                 Up 35 seconds (healthy)  127.0.0.1:4121->3000/tcp
box3-lite-player-auth-portal-1   box-local-engine-player-auth-portal:v2026.1.4-linux-amd64   player-auth-portal   Up 35 seconds (healthy)  127.0.0.1:4125->3214/tcp
box3-lite-player-service-1       box-local-engine-player-service:v2026.1.4-linux-amd64       player-service       Up 40 seconds (healthy)  127.0.0.1:4124->3213/tcp

$ curl -s -w '\nhttp=%{http_code}\n' http://127.0.0.1:4125/api/health-check
{"status":"ok","service":"player-auth-portal"}
http=200
```

`ps -a` 全量：上表 4 个 running + `box3-lite-play-storage-init-1 exited (0)`（一次性，非常驻）。

## 11.3 计数复核（结构事实）

- 常驻容器：**4**（`docker compose -p box3-lite ps --format '{{.Name}}' | wc -l` → `4`）
- 宿主发布端口：**4，全 127.0.0.1**（`ss -ltnp` 原文）：

```
LISTEN 0 4096 127.0.0.1:4121  users:(("docker-proxy",pid=8977,fd=7))
LISTEN 0 4096 127.0.0.1:4124  users:(("docker-proxy",pid=8553,fd=7))
LISTEN 0 4096 127.0.0.1:4125  users:(("docker-proxy",pid=8951,fd=7))
LISTEN 0 4096 127.0.0.1:4132  users:(("docker-proxy",pid=1134,fd=7))

-- any non-127.0.0.1 published port in lite stack? --
OK: all published ports bound to 127.0.0.1
```

- docker.sock：**0 处**（遍历全部 lite 容器 inspect Binds 无命中，原文 `(no output above = zero docker.sock mounts)`）
- 常驻 root：**0 个**（原文 `(no output above = zero resident root containers)`；
  唯一 root 仍是 exited 的一次性 `play-storage-init`）
- 逐容器（`docker inspect --format` 原文）：

```
/box3-lite-play-1               User=node  Readonly=false CapDrop=[ALL] Privileged=false
/box3-lite-player-service-1     User=node  Readonly=false CapDrop=[ALL] Privileged=false
/box3-lite-player-auth-portal-1 User=node  Readonly=true  CapDrop=[ALL] Privileged=false
/box3-lite-managed-postgres-1   User=      Readonly=true  CapDrop=[ALL] Privileged=false
```

## 11.4 浏览器无密钥自助注册 → 登录 → 进图（核心，原文）

curl 即「浏览器」角色：全程**不带** `x-box-player-auth-key` 头，密钥只在门户容器进程内。

```
== A. 未登录 /p 重定向链 ==
$ curl -s -D - http://127.0.0.1:4121/p/cloud-4e84ee7ef626058f-imported
HTTP/1.1 307 Temporary Redirect
location: http://127.0.0.1:4121/api/player-login/start?returnUrl=...

$ curl -s -c jar -D - http://127.0.0.1:4121/api/player-login/start?returnUrl=/p/<publicId>
HTTP/1.1 302 Found
Set-Cookie: box_player_login_<state>=<verifier...>; Max-Age=300; HttpOnly; SameSite=Lax
location: http://127.0.0.1:4125/?source=play&returnUrl=...&transferState=<43b64>&transferChallenge=<43b64>

== B. 门户自助注册（无密钥头）==
$ curl -s -b jar -c jar -X POST \
    "http://127.0.0.1:4125/api/auth/register?source=play&transferState=<S>&transferChallenge=<C>" \
    -H 'Content-Type: application/json' \
    -d '{"username":"a3portalplayer2","displayName":"A3 门户玩家2","password":"***"}'
http=201
{"player":{"subjectId":"fe6ec33c2c99497d86626d6b01c87a46","userId":"3","username":"a3portalplayer2",...
-- jar 内 Cookie --
box_local_player_device
box_local_player_session
（响应里 returnUrl = http://127.0.0.1:4121/api/player-login/callback?code=<43b64>&state=<S>）

== C. play 回调换会话 ==
$ curl -s -b jar -c jar "<callback URL>"
HTTP/1.1 303 See Other
Set-Cookie: box_local_player_session=pcwd58fA...; Max-Age=1209600; HttpOnly
Set-Cookie: box_local_player_device=_SbdHx70...; Max-Age=31536000; HttpOnly
location: http://127.0.0.1:4121/p/cloud-4e84ee7ef626058f-imported

== D. 带 Cookie 进图 ==
$ curl -s -b jar -o /dev/null -w 'http=%{http_code} size=%{size_download}\n' \
    http://127.0.0.1:4121/p/cloud-4e84ee7ef626058f-imported
http=200 size=149594
```

补充两条：

```
== E. 门户登录（已注册用户, 无密钥）==
$ curl -s -c jar2 -X POST http://127.0.0.1:4125/api/auth/login -H 'Content-Type: application/json' -d '{...}'
login http=200   （随后 /p 同一 jar2：http=200 size=149594）
$ curl -s -b jar -o /dev/null http://127.0.0.1:4125/api/auth/session
{"player":null,...,"registrationEnabled":true}   （无 Cookie 时如实返回未登录, http=200）

== F. 负对照：绕过门户直连 player-service 注册（无密钥）==
$ curl -s -X POST http://127.0.0.1:4124/api/player-auth/register -H 'Content-Type: application/json' -d '{...}'
http=401
{"code":"AUTH_API_KEY_INVALID","message":"玩家认证服务密钥无效"}
```

PG 侧账号数（只读 `psql -Atc`）：`a3portalplayer / a3portalplayer2 / w4liteplayer` 三行。

实测踩坑一条（设计使然，非缺陷）：门户 `/api/auth/register` 若带 `transferState/transferChallenge`
但**不带 `source=play`**，注册会在 player-service 侧成功建号（201 路径走完），随后门户回传校验
`AuthProxy.transfer()` 因 source 为空抛 400 `INVALID_LOGIN_TRANSFER`，浏览器看不到 201 响应体与
Set-Cookie（`auth.ts:315-321`）。真实门户前端总是带 source 跳转所以不触发；用 curl 复现必须带
`source`。首轮因此留下一个无会话账号 `a3portalplayer`（E 步改用 login 正常闭环）。

## 11.5 体积代价（catalog 字段口径，非实测镜像）

`box3-re/_manifest/BOX3-IMAGE-CATALOG.json` 只读取值（`size` 字段 = 归档 gz 字节）：

| 归档 | gz 字节 | 行号 |
| ---- | ------- | ---- |
| box-local-engine-image-play-amd64-73d674…tar.gz | 240,669,370 | catalog |
| box-local-engine-image-player-service-amd64-3d7f4a…tar.gz | 203,712,541 | catalog |
| box-local-engine-image-player-auth-portal-amd64-7ba95b…tar.gz | **86,925,875** | :95 |

play-lite 分发合计 = **3 个 BOX 镜像归档 = 531,307,786 B**（= 506.7 MiB；
较出厂 6 归档 1,060,646,139 B 为 **−49.9%**；较 §4.3 的 3 容器口径 444,381,911 B **+19.6%**）。
另有 `postgres:16-alpine` 基础镜像不含在此口径内（§4 同口径）。

## 11.6 仍未证 / 待办

1. **RSS（含 +门户后的 4 容器空闲值与 −52% 主张是否仍成立）**：UNVERIFIED。
   本轮 VM 冷（up 1 min）且并行泳道在用 Docker，按纪律只报结构事实。门户出厂实测约 10.43 MiB
   （§4.2 现网同刻值），预期增量小，**数字留串行轮**。
2. **真实浏览器渲染门户页做注册**：本轮以 curl 走完整 transfer 协议链（含 state/challenge/code），
   未开浏览器点 UI；门户根路径 `GET /?source=play&...` 返回 200/466 B（SPA 壳），
   JS 交互路径（`public/app.js`）UNVERIFIED。
3. **HTTPS 反代后的门户域名/`BOX_APP_BASE_PATH` 子路径挂载**：未演练（同 §6 既有缺口）。
4. **WSL 重启自愈**：`restart: unless-stopped` 已配，未在本轮实测（§8 已有 3 容器版先例）。
5. `.boxplay` 自助导入、WebSocket 真人进局、跨图传送：维持 §6.5 的 UNVERIFIED 状态，本轮未动。

