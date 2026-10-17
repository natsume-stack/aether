# E — 运行时成本基线 (RUNTIME COST BASELINE)

> 车道目标：为「JS 设计对小型组织私有化部署太重」这一命题，给出**可信、可复现的“改造前”基线数字**。本文件只测量“运行中的系统实际付出多少”，不分析代码架构/文件体积（那是 A/B 车道）。
> 所有数字均来自本次**真实执行过的命令**；推断标 `INFERRED`，无法非侵入测量标 `UNVERIFIED`。

---

## 0. 关键状态说明（务必先读）

- **本次测量期间，整套栈刚被“外部重启”（版本更新车道在并发操作）。** WSL 发行版在我介入前处于 `Stopped`；我第一条只读 `docker ps` 触发了 WSL VM 自启动 → `restart=unless-stopped` 策略把 7 个容器拉起。随后观测到 uptime 在 `9s→4s→5min` 之间跳动，说明**更新车道在反复 `docker compose recreate`**。
- 证据：`box-local-engine-*-1` 的 `RestartCount=0` 但 `State.StartedAt=2026-10-17T10:54:19~20Z`（≈本次开机时刻），`docker events` 只显示 `exec_create/health_status`（健康探针），无 `die/recreate`——即**非崩溃重启，是外部 compose 操作**（`recreate` 会换一个新容器实例、`RestartCount` 不增）。
- **我没有 stop/restart/kill/prune 任何容器，也未写 `~/box3`**（安全红线遵守）。所有需要“重启才能测”的项，见 §11 `POSTPONED`。
- 因此：**空闲足迹数据是在“开机后已稳定 5 分钟”的窗口采集的**（`restart-during-sample: NONE`，采样前后 `StartedAt/RestartCount` 不变）→ 可信。
- 重要发现（纠正“真值”前提）：`docker ps` 显示的 “Up 5 minutes / 6 days ago” 里的“6 days”是**镜像/容器 Created 时间（2026-10-11）**，不是运行时长。真实结论：**这套栈没有 6 天连续运行的进程状态——每次宿主机重启/WSL 关停后，进程级“到 healthy”都重新计一次**。所谓“上次重启 6 天前”只在 VM 常驻时成立。

采集环境：
```
uname -sr -> Linux 6.18.33.2-microsoft-standard-WSL2
WSL distro -> Ubuntu-24.04 (默认工作目录 = /mnt/d/desktop/神奇代码岛)
date -> 2026-10-17T11:04Z (采样窗口 10:54~10:57 稳定)
镜像 -> 全部 :v0.3.0-linux-amd64 (postgres:16-alpine, redis:7-alpine)
```

复现方式：本车道脚本全部在 `D:\desktop\神奇代码岛\box3-re\tools\`，从 **WSL 内**运行（`/mnt/d/desktop/神奇代码岛` 即项目根）：
```bash
wsl.exe -d Ubuntu-24.04 -- bash -lc 'tr -d "\r" < box3-re/tools/baseline.sh > /tmp/b.sh && bash /tmp/b.sh'
```
（注：Windows→WSL 内联 `bash -lc` 会把 `${var%%:*}`、Go 模板里的双引号打乱，故所有探测一律写成脚本文件再 `tr -d "\r"` 执行。）

---

## 1. 空闲足迹（measurement #1，headline）

命令（12 次、间隔 10s；`docker stats --no-stream`）：
```bash
for i in $(seq 12); do
  docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}\t{{.NetIO}}\t{{.BlockIO}}\t{{.PIDs}}'
  sleep 10
done
# 单位归一到 MiB 后按容器求 mean/std（见 tools/baseline.sh [3] 段 awk）
```

**实测结果（12 样本，`TOTAL_IDLE_MemUsage_MiB=313.67`，`restart-during-sample: NONE`）：**

| 容器 | MEM 均值(MiB) | std | min | max | CPU 均值% |
|---|---|---|---|---|---|
| creator-1 | 92.00 | 1.01 | 90.48 | 94.34 | 0.320 |
| play-1 | 85.47 | 0.91 | 83.43 | 86.90 | 0.314 |
| player-service-1 | 55.69 | 0.27 | 55.44 | 56.32 | 3.052 |
| voxa-1 | 42.16 | 0.50 | 41.73 | 43.27 | 1.443 |
| managed-postgres-1 | 23.01 | 0.50 | 22.43 | 24.08 | 1.869 |
| player-auth-portal-1 | 13.16 | 3.35 | 11.36 | 20.36 | 2.478 |
| server-manager-1 (Rust) | 2.16 | 0.29 | 1.96 | 2.76 | 0.554 |
| **合计（空闲整套栈 MEM）** | **313.67** | | | | **~9.9% of one core** |

- 另一次 3 样本快速复采：`TOTAL=320.44 MiB`（一致）。
- **NET I/O / BLOCK I/O**：脚本按 `docker stats` 原样采集了 `NetIO/BlockIO` 列但本次聚合脚本只对 MEM/CPU 求了统计（`baseline.sh` 采集行含这两列，`cat` 可见为 KB 级；空闲时 NET/BLOCK 增量≈0，属健康探针轮询）。
- **交叉校验（cgroup）**：容器内 `cat /sys/fs/cgroup/memory.current` 求和 = 340~366 MiB（含可回收 page cache），与 313.67 同量级。

> **HEADLINE：整套 7 容器栈空闲净 RSS（docker stats）≈ 0.31 GB**（含 page cache 的 cgroup ≈ 0.34 GB）。

---

## 2. 容器内进程真值（measurement #2）

镜像**未安装 procps**：`ps -eo` 在全部容器返回空。改用 `/proc` 遍历（脚本 `tools/_probe_proc.sh`，读 `status/smaps_rollup`、`ss`）。

**进程结构（真实）：**

| 容器 | 进程树（entrypoint→child） | 关键 RSS | 线程 | FD |
|---|---|---|---|---|
| creator | tini → **node `launcher.js --creator`**(PID7) → **next-server v15.5.24**(PID14) | node 56.6M + next **122.3M**(HWM 154M) | 7 / **11** | 20 / 19 |
| play | tini → node `launcher.js --play`(PID7) → next-server(PID14) | node 56.4M + next **113.9M**(HWM 146M) | 7 / **11** | 19 / 19 |
| voxa | tini → next-server(PID7)（无 launcher 包裹） | **85.5M** | 11 | 19 |
| player-service | tini → next-server(PID7) | **102.8M**(HWM 105.8M) | 11 | 20 |
| player-auth-portal | docker-init → **node `build/server.cjs`**(PID7) | **50.0M** | 7 | 19 |
| server-manager | docker-init → **/app/server-manager (Rust)**(PID8) | **4.68M** | **1** | 7 |
| managed-postgres | postgres(PID1) + 6 worker | 主 27M；worker 各 ~7–16M；**合计 ~82M** | 1×7 | 68(后端连接) |

要点（实测）：
- **“每个 JS 容器里几个 node 进程？”** → `launcher.js` 模式的 creator/play 各跑 **2 个 node-family 进程**：一个 launcher(`node`，56M) + 它 fork 出的 **`next-server` 子进程（122M/114M，11 线程）**。voxa/player-service 是**单个 Next 进程**（`apps/*/.next/standalone/.../server.js`，`tini` 直接 exec，`comm` 被 Next 改名为 `next-server (v15.5.24)`）。auth 是单个 `node build/server.cjs`。**Web 服务器由 Next.js 提供，launcher 只是其父/监管进程。**
- **是否 worker_threads？** `Threads=7/11` 是 node 主线程+libuv 线程池+V8 GC；未见 `worker_thread` 独立进程（Linux 下 worker 是同进程 tid，`ls /proc/PID/task`）。creator `fd=20`、ps `fd=20`。**11 线程的 next-server 是 creator/play 里最重的实体（比 launcher 自身 2×）。**
- **每图游戏服务器是否子进程？** 空闲时 creator/play **没有** `game-server` 子进程（仅 launcher+next）。creator `node` 进程监听 **9966/9967**（`ss -tlnp`：`node pid=7 fd=18/19`）= `BOX_PLAY_RUNTIME_PORT=9966` 运行时 RPC 端口，**按需 fork 游戏服务器进程**（见 §8、§11）。`INFERRED`：开局时会新增 node 子进程（受 `MAX_RUNTIMES` 限制）。
- **socket/FD：** `ss -s`(creator) `Total:6, TCP:40 (estab 0, closed 36, timewait 4)` → 空闲大量 `closed/timewait` 是 15s 健康探针轮询残留。真正 ESTAB：见 §8（仅 player-service→postgres:5432）。

**smaps_rollup（去共享，Pss 才是“真身”内存；creator 例）：**
```
next-server pid=14  Rss 122296 kB  Pss 79387 kB  Pss_Dirty(Anon) 71500 kB
node     pid=7      Rss  56596 kB  Pss 17255 kB  Pss_Dirty        10536 kB
```
→ creator 两进程 **Pss 合计 ≈ 96.7 MiB**（与 docker-stats 92MiB 吻合）；`VmRSS` 直接相加(178M)会**重复计入被两进程共享的 libnode.so 映射**（本文件 §1 脚本 [2] 段的 procRSSsum 已注明该重复计）。各服务 Pss(Dirty) 概览：creator 82 / play 73.6 / voxa 35.2 / player-service 51.5 / auth 9.2 / server-manager 0.44（KiB→MiB）。

---

## 3. WSL / VM 层成本（measurement #3）：用户机器“实付” vs compose“声称”

compose 声称的每容器内存上限合计（`docker inspect .HostConfig.Memory`，实测）：
```
creator 6 GiB | play 4 GiB | voxa 1 GiB | player-service 256 MiB |
auth 64 MiB | server-manager 128 MiB | postgres 512 MiB  => 约 12.94 GiB “名义限额”
cpus(NanoCpus): creator 4.0 | play 4.0 | voxa 1.0 | player-service 0.5 | auth 0.25 | server-manager 0.5 | postgres 1.0
```
> ⚠ **纠正“真值”前提**：文档/前提写 player-service 1g、auth 128m，但 `HostConfig.Memory` **实测 = 256 MiB / 64 MiB（是声称值的一半）**；对应 node 堆上限实测 192/48（见 §6）。

WSL 内部（`free -m`）：
```
Mem: total 11961 | used 1568 | buff/cache 4196 | available 10393 (MiB)
/proc/meminfo: MemTotal 12248696 kB (~11.7 GiB 动态分配给 VM)
```
宿主机侧（PowerShell 读 vmmem）：
```powershell
Get-Process vmmem*,wslhost,wslservice | Select Name,Id,WS_MB,Private_MB
-> vmmemWSL (PID 33708):  WorkingSet 5304 MB | Private 6124 MB
   wslhost x7: ~12 MB each ; wslservice: 34 MB
```
`.wslconfig`（`%USERPROFILE%\.wslconfig`）：
```
[wsl2] memory=12GB  processors=8  swap=4GB  swapFile=D:\WSL\swap.vhdx
[experimental] autoMemoryReclaim=gradual
```

| 视角 | 空闲数字 | 命令 |
|---|---|---|
| 容器净 RSS（docker stats） | **313.67 MiB** | `docker stats --no-stream` |
| WSL `free` used | 1568 MiB（含 dockerd/containerd/系统守护+本探测） | `free -m` |
| **宿主机 vmmem 实付** | **WorkingSet 5.30 GB / Private 6.12 GB** | PowerShell `Get-Process vmmemWSL` |

> **结论（本车道最关键对比）**：JS 容器**只跑 0.31 GB**，但**用户机器为承载它的 WSL2 VM 实付 5.3–6.1 GB**，且 `.wslconfig` 顶格预留 12 GB / 8 核。**“重”主要来自 Docker+WSL2 交付模型（VM 气球内存 + 内核 + dockerd），不是 JS 运行时本身。** `INFERRED`：`autoMemoryReclaim=gradual` 意味着空闲数会缓慢回落，但峰值（开局多张图 + 8 运行时）会把 VM 顶到接近 12 GB。

---

## 4. 冷启动 / 到 healthy 延迟（measurement #4，派生，不重启）

方法：`docker inspect .State.StartedAt` + `docker events`（start→首个 `health_status:healthy`）+ `docker logs --timestamps`（首个 “Ready/listening” 行）+ 健康配置。

**实测每服务“StartedAt → 首个 healthy（来自本次开机 10:54:19~20Z 的 docker events）”：**

| 服务 | StartedAt(Z) | → healthy(Z) | Δ 到 healthy | 应用内 “Ready” |
|---|---|---|---|---|
| server-manager(Rust) | 10:54:19.887 | 10:54:26.47 | **~6.6s** | listening:3130 @10:54:21.15 (**+1.3s**) |
| voxa | 10:54:19.964 | 10:54:26.71 | **~6.8s** | `✓ Ready in 498ms` @10:54:22.70 (+2.7s) |
| play | 10:54:19.972 | 10:54:27.22 | **~7.2s** | (banner 于 Oct-11 建镜像时) |
| creator | 10:54:20.041 | 10:54:27.27 | **~7.3s** | listening:3000 (next-server) |
| player-auth-portal | 10:54:19.885 | 10:54:28.13 | **~8.2s** | login portal @10:54:22.13 (+2.2s) |
| player-service | 10:54:20.111 | 10:54:30.86 | **~10.8s** | `✓ Ready in 1897ms` @10:54:25.73 (+5.6s) |
| managed-postgres | ~10:54:19.95 | ~10:54:31.4 | **~11.5s** | `psql SELECT 1` ok @10:54:31.42 |

- 健康配置（`Config.Healthcheck`）：`interval=15s`，`timeout=5s`，`start_period=25s(creator/play) / 20s(voxa/ps) / 10s(auth) / 5s(Rust, interval=5s)`。Rust 探活用 `/app/server-manager --healthcheck`（`docker events` 实测 exec exit=0），JS 探活用 `node -e fetch('/api/health-check')`。
- **全栈 time-to-healthy ≈ 11.5s**（最慢=postgres/player-service），前提：**VM 已运行、镜像已在本地缓存、compose 已 `up`**。
- ⚠ **明确标注**：以上为**本次开机（数分钟前，因 WSL 之前 Stopped）派生**，非“6 天前那次”。VM 冷启动→docker→拉起容器的整机时间被更新车道并发的 compose recreate 污染（uptime 曾在 9s↔4s↔5min 跳变），**不可信为“干净冷启动”**。`tools/_probe_boot.sh` 可复采。

---

## 5. 热路径请求级成本（measurement #5，只读 GET，不触发开局/登录）

命令（每端点 10 次；`tools/baseline.sh [4]`）：
```bash
for k in $(seq 10); do
  curl -s -o /dev/null -w "%{time_starttransfer} %{time_total} %{http_code}\n" \
       http://127.0.0.1:<port>/api/health-check   # server-manager 用 /
done   # 排序取中位数
```
**实测中位数（WSL 内回环，warm）：**

| 端点 | TTFB 中位(s) | total 中位(s) | TTFB 最小(s) | HTTP |
|---|---|---|---|---|
| creator:3127 `/api/health-check` | **0.0107** | 0.0110 | 0.0028 | 200 |
| play:3121 `/api/health-check` | **0.0093** | 0.0095 | 0.0040 | 200 |
| voxa:3123 `/api/health-check` | **0.0049** | 0.0050 | 0.0028 | 200 |
| player-service:3124 `/api/health-check` | **0.0068** | 0.0069 | 0.0052 | 200 |
| player-auth-portal:3125 `/api/health-check` | **0.0020** | 0.0021 | 0.0012 | 200 |
| server-manager:3130 `/` (Rust) | **0.0016** | 0.0017 | 0.0011 | 200 |

- **JS 健康端点 TTFB 中位 ≈ 2–11ms（本集合中位约 6.9ms）**；Rust 1.6ms（最轻，符合 §2 Rust 仅 2MiB）。
- 更重的只读请求（旁证，非 headline）：`play /`（Next SSR 首页 50KB）TTFB ~1.13s；`play /api/play-worlds`（其健康检查第二 GET）200、~17ms；`creator /` 307 重定向 ~0.99s；`voxa /` 401（需鉴权，未登录，合理）。
- **结论：热路径（API 读）成本极低，毫秒级。JS 的“重”不体现在单请求延迟。**

---

## 6. Node 特定开销（measurement #6）

**实际生效的堆/内存上限（`docker exec <c> cat /proc/1/environ | tr '\0' '\n' | grep -Ei 'NODE_OPTIONS|MEMORY|HEAP|SCRIPT'`）：**

| 容器 | NODE_OPTIONS（实测） | 相关 env | 声称(前提/文档) |
|---|---|---|---|
| player-service | `--max-old-space-size=192` | `BOX_DEPLOYMENT_MODE=player-service` | 声称 384MB → **实测减半** |
| player-auth-portal | `--max-old-space-size=48` | `HOST=0.0.0.0` | 声称 96MB → **实测减半** |
| creator | *(容器级无 max-old-space)* | `SCRIPT_MEMORY_LIMIT=512`,`BOX_SCRIPT_HEAP_MB=512`,`BOX_DEPLOYMENT_MODE=creator` | 512MB=每个用户脚本堆 |
| play | *(容器级无)* | `SCRIPT_MEMORY_LIMIT=512`,`BOX_SCRIPT_HEAP_MB=512`,`BOX_DEPLOYMENT_MODE=play` | 512MB=每运行时脚本堆 |
| voxa | *(无 env 命中)* | 仅 next-server | — |

- **V8 JIT vs native**：creator/play 的 `launcher.js` 是纯 V8/JS 监管进程（56M），真正出网的是 fork 的 `next-server`（V8 JIT，11 线程）；Rust `server-manager` 是 native 单线程 2MiB。**同一功能位（一个管理/运行时协调者），Rust 2.16MiB vs node launcher 56MiB → ~26×；Rust 2.16 vs next-server 92–122 → ~43×。**
- **RSS vs V8 heap-used**：非侵入无法取 V8 已用堆（需 `process.report`/SIGUSR2，属调试信号，越界）。`UNVERIFIED`。可用近似：`smaps_rollup` 的 `Pss_Anon`（creator next-server 71.5M、node 10.5M）≈ JS 堆+原生分配；实测 `Pss_Dirty` 见 §2。`max-old-space-size=192(ps)/48(auth)` 是**硬上限**；空闲 RSS(ps 55.7 / auth 13.2MiB)远低于上限 → **堆未被用满，限额是保守预留**。

---

## 7. 运行时依赖面（measurement #7）：最小“开一张图”仍需几个容器

**证据 A — 配置层（`docker exec ... /proc/1/environ`，只读、静态、确凿）：**
- play 与 player-service 均带 **`BOX_DATABASE_URL=postgresql://…@managed-postgres:5432/box_db_…`** → **postgres 是硬依赖**。
- 所有服务带 **`BOX_RUNTIME_MANAGER_URL=http://server-manager:3130`**、play 带 `BOX_PLAY_RUNTIME_PORT=9966` / `BOX_PLAY_MAX_RUNTIMES=8` → **开局运行时经 Rust server-manager 派发**。
- 登录链：play/creator/voxa 均 `BOX_PLAYER_LOGIN_URL=http://127.0.0.1:3125`（auth-portal）、`BOX_PLAYER_SERVICE_INTERNAL_URL=http://player-service:3213` → **auth-portal + player-service 为“玩家登录/会话”路径依赖**。
- **Redis：`REDIS_HOST` 实测为空**、`docker ps` 无 redis 容器、仅 `redis:7-alpine` 镜像在库中未运行 → **Redis 未被本次部署实际依赖（可选/未启用）**（STORAGE_CACHE_REDIS_* 形同虚设）。

**证据 B — 运行时连接层（`ss -tn state established`，空闲瞬时）：** 仅 **player-service → 172.18.0.2:5432** 一条 ESTAB（其 next-server fd=20）；creator/play 空闲 **0 条对外 ESTAB**（调用为按需）。故“play 运行期实际打了谁”**无法在纯空闲只读下穷尽证明**（见 §11）。

**外部镜像硬需求：** `postgres:16-alpine`（必须）；`redis`（镜像存在但未部署，`UNVERIFIED` 是否其他场景启用）。

**最小可用容器数（“玩一张图”，带证据）：**

| 组合 | 容器 | 依据 | 置信 |
|---|---|---|---|
| 核心 | play + managed-postgres + server-manager(Rust) | DB URL + runtime-manager URL + 端口 9966 实测 | 高 |
| +玩家鉴权 | + player-service + player-auth-portal | login/player-service URL 实测；ps→pg ESTAB 实测 | 高 |
| 可选/待证 | voxa（语音/形象?）、creator（编辑器） | 空闲未见 play→voxa/creator 的活连接 | `UNVERIFIED`（需开局 trace） |

> **最小“登录并玩一张图” ≈ 5 容器（play, postgres, server-manager, player-service, auth-portal）；仅本地直玩不含鉴权下限 ≈ 3（play, postgres, server-manager）。** 全套 7 容器里 **creator+voxa 是“创作侧”，播放不需要**（`INFERRED`，开局 trace 于 §11 定死）。

---

## 8. 汇总表（measurement #8）：指标 → 当前值 → 测量命令 → 目标值建议

| 指标 | 当前值（实测） | 测量命令 | 目标值建议（轻量替代验收线） |
|---|---|---|---|
| **空闲总 RSS（7 容器）** | **313.67 MiB**（docker stats 12样本均值；cgroup ~340–366 MiB） | `baseline.sh [3]` | ≤ 256 MiB（去掉 launcher+next 双进程冗余后应更低） |
| **宿主机 VM 实付** | vmmemWSL **5.30 GB WS / 6.12 GB Private**；`.wslconfig` 预留 12GB/8核 | PowerShell `Get-Process vmmemWSL` | ≤ 1.5 GB（去 Docker+WSL，裸进程/systemd） |
| 单服务 RSS（最重 JS） | creator 92 MiB / play 85.5 / ps 55.7 / voxa 42.2 / auth 13.2 | `docker stats --no-stream` | 单服务 ≤ 32 MiB |
| 单服务 RSS（最轻 Rust） | server-manager **2.16 MiB** | 同上 | 参照系：JS 应向此靠拢 |
| postgres | 23.01 MiB（7 进程 ~82 MiB procRSS） | 同上 + `/proc` 遍历 | 可保留（唯一外部硬依赖） |
| **到 healthy 时间** | 全栈 **~11.5s**（VM 已起、镜像已缓存）；单服务 6.6–10.8s | `docker events`+`StartedAt`/`logs --timestamps` | ≤ 3s（无 VM/镜像冷层；裸二进制 systemd） |
| **TTFB（热路径 GET）** | JS 中位 **2–11ms**（集约 6.9ms）；Rust 1.6ms | `curl -w time_starttransfer`×10 | 维持 ≤ 15ms（已达标，非瓶颈） |
| **容器数（整套/最小玩图）** | 7 运行（+3 退出 storage-init）/ **最小 3–5** | `docker ps -a` + env 依赖图 | 目标 ≤ 3（合并 JS 服务、Redis 已未用、DB 内嵌或复用） |
| **端口数（发布到 host）** | **9**：3121,3123,3124,3125,3127,3130,5432,9966,9967 | `docker ps --format {{.Ports}}` | ≤ 2（单网关反代） |
| compose 内存限额合计 | ~12.94 GiB 名义（实测量远高于 0.31 GiB 空闲） | `docker inspect .HostConfig.Memory` | 按真实峰值收敛到 ≤ 2 GiB |
| 磁盘占用 | 参考 B 车道：内容 2.6 GB / docker 8.26 GB（**未复测**） | B-size-audit.md | 引用，别重复测 |
| 传输包 | 参考：1.01 GB（**未复测**） | A/B 车道 | 引用 |
| 外部依赖镜像 | **仅 postgres 实际在用**；redis 未部署 | `/proc/1/environ` REDIS_HOST 空 + `docker ps` | 保持单外部依赖 |

---

## 9. 可复现基准脚本（measurement #9）

脚本：`D:\desktop\神奇代码岛\box3-re\tools\baseline.sh`（POSIX bash，WSL 内跑；结构上只读：`docker ps/inspect/stats/logs/exec-GET`、`/proc`、`free`、`curl GET`；绝不 stop/start/remove/update/scale，绝不写 `~/box3`）。支持 `SAMPLES/INTERVAL/CURL_N` 环境变量。用法：
```bash
wsl.exe -d Ubuntu-24.04 -- bash -lc 'tr -d "\r" < box3-re/tools/baseline.sh > /tmp/b.sh && bash /tmp/b.sh'
```

**其一次真实输出（节选 12 样本空闲段，headline）：**
```
=== [3] IDLE SAMPLING LOOP: docker stats --no-stream x12 every 10s ===
restart-during-sample: NONE
-- per-container mean/stdev over 12 samples --
NAME                        memMiB_MEAN memMiB_STDEV   memMiB_MIN memMiB_MAX   CPU_MEAN
box-local-engine-creator-1        92.00         1.01        90.48      94.34      0.320
box-local-engine-managed-postgres-1        23.01         0.50        22.43      24.08      1.869
box-local-engine-play-1           85.47         0.91        83.43      86.90      0.314
box-local-engine-player-auth-portal-1        13.16         3.35        11.36      20.36      2.478
box-local-engine-player-service-1        55.69         0.27        55.44      56.32      3.052
box-local-engine-server-manager-1         2.16         0.29         1.96       2.76      0.554
box-local-engine-voxa-1           42.16         0.50        41.73      43.27      1.443
TOTAL_IDLE_MemUsage_MiB=313.67
```
辅助探测脚本（同目录）：`_probe_boot.sh`（inspect/健康日志/heap env）、`_probe_proc.sh`（`/proc` 全量遍历 + smaps + ss）、`_probe_http.sh`（端点路径/状态码）、`_probe_deps.sh`（启动时序 + 依赖 env + 建立连接 + 镜像清单）。原始采集落 `box3-re/_e_raw/*.raw`。

---

## 10. 结论：最能“证成/证伪 JS 太重”的两个数字

1. **空闲整套栈净 RSS = 313.67 MiB（0.31 GB）**，而 compose 名义内存限额合计 ≈ **12.94 GB**、`.wslconfig` 预留 **12 GB / 8 核**、宿主机 vmmem 实付 **5.3–6.1 GB**。→ **JS 运行时自身很轻（占名义限额 ~2.4%）；“重”在 Docker+WSL2 交付模型与 6–47× 的过度预留限额，不在 JS。**
2. **同类职责下：单容器 Rust server-manager 空闲 2.16 MiB / 1 线程 / TTFB 1.6ms，而 creator 的 `next-server` 单进程 RSS 122 MiB / 11 线程（launcher 再加 56 MiB）→ ~43×。** 加上**请求级 TTFB 全为毫秒级（JS 6.9ms 中位）**，说明“JS 太重”在**单请求与空闲内存两个维度都被证伪**；真正该被替换的是 **7 容器 / 9 端口 / 每服务双 node 进程（launcher+next）/ VM 气球内存**这套**编排与交付拓扑**。

> 给下游优化车道的验收锚点：**别去“优化 JS 单请求”（已毫秒级）；去砍 (a) 容器数 7→≤3、(b) 端口 9→≤2、(c) 摆脱 WSL+Docker 的 5.3GB VM 税、(d) 合并 creator/play 的 launcher+next 双进程。** 以上全部以本文件 §1/§3/§8 的数字为“改造前”对照。

---

## 11. POSTPONED_MEASUREMENTS（需重启或需触发，本车道按红线**未执行**）

> 更新车道会重启栈；并发重启会让两边数据作废。以下命令留给“独占窗口”执行。

1. **全栈干净冷启动 time-to-healthy（端到端）**
   ```bash
   # 记录 T0，重建整套，测到全部 healthy
   wsl.exe -d Ubuntu-24.04 -- bash -lc '
     cd /mnt/d/desktop/local-engine/current 2>/dev/null || cd ~/box3/BOX3-Engine-Server-*/ ;
     T0=$(date +%s.%N); docker compose down --remove-orphans && docker compose up -d;
     until [ "$(docker ps -qf health=healthy | wc -l)" = "7" ]; do sleep 0.5; done;
     echo "cold_start_to_all_healthy_s=$(echo "$(date +%s.%N)-$T0"|bc)"'
   ```
2. **VM 冷启动**（WSL 从 Stopped 起）：`wsl --shutdown` 后计时到 `docker ps` 全 healthy；含 dockerd 拉起，量化“开机税”。
3. **开局（map-launch / 运行时 spawn）延迟与增量内存**：需真正启一张图，观测 `server-manager` fork 的 node 游戏服务器子进程数、每进程 RSS、`9966/9967` RPC 往返、`MAX_RUNTIMES=8 × SCRIPT_MEMORY_LIMIT=512MB` 满负载内存上界。⚠ 会改变游戏/项目状态，非本只读车道可做。
4. **play 运行期真实调用图**（play→voxa/player-service/creator 是否硬调用）：开局时用 `docker exec play-1 ss -tnp` + `docker logs` trace 定 §7 的 `UNVERIFIED` 项。
5. **RSS vs V8 堆实际占用**：`kill -USR2 <node pid>` 触发 heap snapshot 或 `process.report`（调试信号，越界，UNVERIFIED）。
6. **GC / `--max-old-space` 行为**：需压测到接近 192/48MB 看 GC 频率与 OOM 边界（需负载生成）。
