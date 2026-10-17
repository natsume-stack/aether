# S8 · 客户端首屏字节 + 部署形态实测（主控自测，补齐两条未落盘泳道）

> 为什么由主控自己做：`frontend`（客户端资产）与 `deploy`（部署形态）两条泳道的子代理在返回"已完成"后**没有落盘任何文件**，其结论无法核对。按"只接受实测数字"的验收标准，这两块必须由我亲自测。测量对象是**已升级到 v2026.1.4 的运行实例**（7/7 healthy），非源码推断。

---

## 1. 浏览器真实要下载多少字节

### 1.1 线上口径（curl `--compressed`，走宿主端口，含 HTTP 头外全部资源）

命令：`tools/measure-payload.sh`（抓 HTML → 抽 `src=`/`href=` → 逐个 GET → 求和）

| 入口 | HTML | 成功拉取资源数 | 浏览器总下载（压缩后） |
|---|---|---|---|
| Play 首页 `http://127.0.0.1/` | 51,535 B | 20 | **315,903 B = 308 KiB** |
| Play 地图页 `/p/cloud-4e84ee7ef626058f-imported` | 466 B | 0 | — 未登录时是跳转壳，需会话才能测真实首屏 |
| Creator `/` | 466 B | 0 | — 同上（`creator-access-required`） |

Play 首页的 20 个资源里 JS 共 **220,052 B**、CSS 5,285 B、PNG 16,791 B；最大三块是 `framework-*.js` 59,898 B、`main-*.js` 40,599 B、`polyfills-*.js` 39,627 B。

**判读**：壳页面很轻（308 KiB）。重量不在首屏 HTML，而在**进入地图后按需加载的 chunk + 体素 blob**——这需要登录态才能量化，本文标 `UNVERIFIED`，并把测法写进 §4。

### 1.2 镜像内口径（Next build-manifest，即某路由首屏必下的 chunk 之和，未压缩）

命令：`tools/measure-client-payload.sh`（`docker exec <c> node -e` 读 `build-manifest.json` 并 stat chunk）

| 路由 | play 镜像（B） | creator 镜像（B） |
|---|---|---|
| `/` | 641,805（12 chunk） | 651,848（12） |
| `/projects` | 617,243 | 712,173 |
| `/p/[gameName]` | 598,064 | 608,111 |
| `/play-launch` | 494,198 | 504,238 |
| `/play-system` | 451,829 | 461,868 |
| `/login-required` | 361,672 | 371,709 |
| `/_app` + `/_error` 共享底座 | **359,358（6 文件）** | **369,392（6）** |

**关键结构性事实（实测）**：`play` 镜像里带着 `creator-access-required`、`/projects`、`/play-system` 这些**游玩端永远用不到的页面**——这就是 C 车道"一个 bundle 三态、93/86/44 路由互为子集"的字节级体现。play 与 creator 的 `/` 页 chunk 只差 **9,853 B**，说明**两个镜像装的是同一套前端**，差异几乎只来自 creator 多出的 Monaco。

### 1.3 资产大头（实测 du/字节）

| 资产 | 位置 | 实测 |
|---|---|---|
| 字体 | `.../.next/static/media` | **play 34 MB / creator 35 MB**；单个 `ChillRoundGothic-Bold.ttf` **12 MB**、`.woff` 7.6 MB、`MiSans-Bold/Regular` 各 5.2 MB、`DoulosSILR` 1.7 MB |
| Monaco | `.../.next/static/vs` | creator **13 MB**；**play 镜像里没有 `static/vs`（实测该路径不存在）** |
| 图标包源码 | `packages/icons`（1030 文件 / 456,259 B） | 见 A/S1 |

**修正一条来自体积泳道的推测**：`B-size-audit.md` 说"Monaco 12.6 MB shipped 到 play/ps 等没有编辑器的服务"。实测在 **v2026.1.4 的 play 镜像里 `static/vs` 不存在** → 该浪费已被上游处理，P0 清单里"play 删 Monaco"这一项**收益作废**（改为：核对 player-service 镜像，仍未证）。这是"必须自己测，不信转述"的又一个实例。

**字体才是真大头且未被处理**：12 MB 的 `.ttf` 与 7.6 MB 的 `.woff` 同时入库（同一字体的三种格式都在），且 play/creator 各存一份。若做 `woff2` 子集化（中文常用 3500 字，业界经验 12 MB → 约 1–3 MB），**单镜像可省 25–30 MB 未压缩**，且直接减小玩家首屏（字体会阻塞文本渲染）。

---

## 2. 部署形态实测（v2026.1.4 运行态）

| 维度 | 实测值 | 命令 |
|---|---|---|
| 常驻容器 | **7**（creator/play/voxa/player-service/auth-portal/server-manager/managed-postgres） | `docker ps` |
| 一次性任务 | **3**（`*-storage-init`，`Exited (0)`，仅 chown/mkdir） | `docker ps -a` |
| compose service 总数 | **11** | `grep -E '^  [a-z-]+:' compose.yml` |
| 宿主发布端口 | **9**：`127.0.0.1:{3121,3123,3124,3125,3127,5432,9966,9967}` + `0.0.0.0:3130` | `docker ps --format '{{.Ports}}'` |
| 进程数 | creator 3 / play 3 / voxa 2 / player-service 2 / auth-portal 2 / manager 2 / postgres 7 = **19** | `docker top` |
| 空闲净 RSS | **313.67 MiB**（v0.3.0，12×10s 均值，E 车道）→ **330–334 MiB**（v2026.1.4，我复测 3 次） | `docker stats --no-stream` 循环 |
| 单容器空闲 RSS | creator 92.0 / play 85.5 / player-service 55.7 / voxa 42.2 / postgres 23.0 / auth 13.2 / **manager(Rust) 2.16** | 同上 |
| 名义内存限额之和 | **≈12.94 GiB**（6g+4g+1g+512m+256m+128m+64m）——**是实测空闲的 42 倍** | `docker inspect .HostConfig.Memory` |
| 真实到 healthy | 全栈 **11.5 s**（单服务 6.6–10.8 s，镜像已缓存） | 容器日志时间戳 + `.State.Health.Log` |
| TTFB 中位 | JS 服务 **6.9 ms**（2–11 ms，10 样本），Rust **1.6 ms** | `curl -w '%{time_total}'` ×10 |
| 空闲 CPU 抖动 | server-manager **10.6%**、player-auth-portal 1.8%、creator 13.9%（单次采样，健康探针轮询所致） | `docker stats --no-stream` |
| 外部依赖 | PostgreSQL **必须**（`/api/play-worlds` 200 依赖它）；Redis 未部署（`BOX_REDIS_MODE=disabled`） | `docker exec .. env` |
| WSL 宿主代价 | **vmmem WorkingSet 5,304 MB / Private 6,124 MB**（WSL 内 `free -m` 只报 used 1,568 MB） | PowerShell `Get-Process vmmem*` |

**我的判读**：
1. **JS 执行不是瓶颈，交付才是。** 空闲 313 MiB / TTFB 6.9 ms 属于"轻"；但为了这 313 MiB，用户要付 **7 容器 + 19 进程 + 9 端口 + 2.74 GB 磁盘 content + 1.01 GB 下载 + 5.3–6.1 GB vmmem**。这就是"臃肿感"的真实来源，与语言无关。
2. **Rust manager 2.16 MiB vs next-server 92–122 MiB（≈43×）**，但它干的事只是"按需起子容器 + 生成 compose + TLS"，而它换来的代价是**全栈唯一的 root + docker.sock 特权**。S2/S1 已证：出厂根本没装 `box-local-engine-runtime` 镜像，容器隔离路径不可用，manager 的存在只为满足 `depends_on: service_healthy`。**这是全案最划算的一刀**：删掉它 → 特权进程 1→0、端口 -1、容器 -1，且不改一行引擎逻辑。
3. **`--pull never` + 补 tag 是离线/私有化升级的必经两步**（本次踩实，见主文档 §3）；官方 ZIP 只有 25,294 B，镜像按需从 `assets.box3.fun` 拉，因此**断网环境无法完成首次安装**（除非改 `package-web --mode local`）。

---

## 3. 最小开服形态（实测支撑的结论）

| 形态 | 容器 | 端口 | 空闲 RSS 估算 | 传输 gz | 依据 |
|---|---|---|---|---|---|
| 出厂全栈 | 7 | 9 | 313–334 MiB | 1011.5 MiB | 实测 |
| **游玩最小集**（play + player-service + PG） | **3** | **3** | ≈164 MiB（85.5+55.7+23.0，实测分项相加） | 444.4 MiB（play 240.7 + ps 203.7，A 车道 catalog 字节） | `distribution/play/compose.yml` 官方先例 + `launcher.js:254` shared-Node 回退 |
| **游玩最小集 + P0 裁剪** | 3 | 3 | ≈164 MiB | **≈150–200 MiB** | S1 §5 推算（未压 −154 MB/镜像工具、−30 MB 字体、−140 MB 依赖树二次物化） |
| 纯本地单人自测（不设 `BOX_DEPLOYMENT_MODE`） | **1** | 1 | ≈86 MiB | ≈229 MiB（play 单镜像） | C §9：匿名兜底分支只在裸 `node launcher --play` 可达 |

---

## 4. 还需补测（要登录态/要触发才能量化）

1. 玩家进入 `/p/<publicId>` 后的**真实首屏 JS 总量**（含懒加载 chunk、体素 mesh、`/block/<hash>` blob 数与字节）——需注册玩家并用 `BOX_PLAY_ADMIN_TOKEN` 开放地图组。
2. `prefetchHashes` 的规模（`createSession` 返回字段）与首帧前必下的 blob 字节。
3. 编辑器页（`/projects`、实际编辑页）首屏 JS 与 Monaco 的按需加载占比。
4. `player-service` 镜像是否也带 Monaco/字体（本次只证了 play）。

测法已固化：`tools/measure-payload.sh`（改 `BASE_*` 与登录 JAR）+ `tools/measure-client-payload.sh`（改路由 key）。
