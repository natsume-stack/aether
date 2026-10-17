# S7 — 外部对标 + Cloud-Native 化可行性研究

> 泳道：外部对标 + cloud-native 化可行性。研究日期 2026-10-17。
> 本文不重复源码取证，只做"业界怎么做 / BOX3 能不能搬"。引用现状硬事实来自其它泳道，并在本文用仓库只读核实的关键行号交叉验证。
> 可信度标注：**[VERIFIED]** = 官方文档/仓库文件直接核对；**[SECONDARY]** = 第三方博客/会议分享，数字可用但非一手；**[UNVERIFIED]** = 逻辑推断或无法在 2026-10 核到一手源，需实测。

---

## 0. 现状锚点（本文用于对比的基线，只读核实）

| 维度 | BOX3 出厂形态 | 核实来源 |
|---|---|---|
| 交付字节 | 归档 1,060,646,139 B ≈ 1011.5 MiB gz；docker content ≈2.6 GB | 现状事实 |
| 镜像 | 6 个（Node 22.17-bookworm-slim ×5 + Rust ×1） | `apps/*/Dockerfile` |
| Service | 11 个 / 7 常驻容器 / 9 宿主端口 | `docker-compose.yml`（profiles: infra/player-service/auth-portal/creator/play/voxa/desktop-postgres/desktop-redis） |
| 特权常驻 | `server-manager` `user:"0:0"` + 挂 `/var/run/docker.sock` | `docker-compose.yml:238,268`；`apps/server-manager-rust/src/platform/configuration.rs:519,528` |
| 其它 root 容器 | creator 一次性 init `user:"0:0"`、play `user:"0:0"`、voxa init `user:"0:0"` | `docker-compose.yml:400,435,597` |
| 安全基线（已有） | `no-new-privileges:true` + `cap_drop`（推断 ALL）+ 多数 `read_only:true` | `docker-compose.yml:111-113,185-187,239-241,294-296,419-421,447-449,567-569,606-608` |
| 安全基线（缺） | 无 `seccomp_opt` / 无 `unconfined→RuntimeDefault` / 无网络策略 / manager 非 user-namespace | 全文 grep 无 seccomp 命中 **[VERIFIED]** |
| 沙箱 | `isolated-vm@5.0.4` | `services/game-server/package.json:51`，`pnpm-lock.yaml:11192` |
| 前端 | Next 15.5.24 `output:standalone`；`.next/static` 73MB + 字体 58.6MB + Monaco 12.6MB | 现状事实 |
| 运行态 | 空闲 RSS 313.67 MiB（manager 仅 2.16MiB；next-server 每进程 92–122MiB）；WSL2 vmmem 索取 5.3–6.1GB | 现状事实 |
| 每图进程 | 递归 spawn launcher + game-server + IVMP 脚本子进程 = 3 进程/图；启动超时预算 30min；prewarm=0 | 现状事实 |
| podman | **安装器显式拒绝**：`distribution/server/bootstrap.sh:190-191` 检测到 podman-docker 即 `fail` | **[VERIFIED]** |
| 版本机制 | `latest.txt`=2026.1.4；slim 包 25,294B 纯清单 + 按需下载；`BOX3_RELEASE_CDN_URL` 可整体替换（自托管后门） | 现状事实 |

**核心矛盾（贯穿全文）**：真实执行成本极低（313MB RSS / 毫秒 TTFB / manager 2.16MB），交付重量 100% 来自"分发方式税"——6 个 glibc 镜像 + 每镜像 39% 构建期工具 + docker.sock 特权 supervisor + WSL2 VM 保留。因此"更轻更快 cloud-native"的主战场是**交付形态与 supervisor 模型**，不是代码性能。

---

## 1. 业界"本地/私有化开服"轻量交付先例对比

### 1.1 候选与关键数字

| 项目 | 交付形态 | 分发字节 | 冷启动 | 内存/房间 | 端口数 | 无 Docker 可运行 | 签名/SBOM | 离线安装 |
|---|---|---|---|---|---|---|---|---|
| **Gitea**（Go）| 单静态二进制 + 内嵌静态资源 | 二进制 ~50–60MB（docker 镜像 300+MB） | 亚秒 | 单进程，几十 MB 级 | 1（HTTP 3000）+ 可选 SSH | ✅ 直接跑 | ✅ `.asc` GPG 签每个架构 | ✅ 下二进制即可 **[VERIFIED]** |
| **Caddy**（Go）| 单静态二进制 | ~15–20MB | <50ms | 单进程 | 1–2 | ✅ | ✅ 官方 cosign 签 | ✅ |
| **restic**（Go）| 单静态二进制 | ~15MB | <30ms | — | 0 | ✅ | ✅ | ✅ |
| **Nakama**（Go 游戏服）| 单二进制（官方"生产建议装 binary"）| 二进制 + 外部 DB | 秒级 | 官方最低 2C/4GB 单节点 | 7349/7350/7351/9100 + DB 5432/26257 | ✅（binary）| ✅ | 需 CockroachDB/Postgres **[SECONDARY]** |
| **OpenRA 专用服**（C#/.NET）| deb/AppImage + dotnet | 客户端包 ~325MB；服务端轻 | 秒级 | 空载 150–300MB，8 人 <400MB | 1（ListenPort 1234）| ✅ systemd 直接跑 | 发行版包签 | ✅ **[SECONDARY]** |
| **BOX3**（现状）| 6 镜像 + compose + tar.gz | 1011.5MiB gz / 2.6GB content | 分钟级（compose up + 首次建表）| 空闲 313MB，每图 +3 进程 | 9 | ❌（拒绝 podman，强制 docker.sock）| 无镜像签名 / 无 SBOM / 无 provenance | 需 Docker Engine **[VERIFIED]** |

### 1.2 我们最该抄的 3 个做法（附出处）

**抄法 #1 — Gitea 模型："单二进制内嵌静态资源 + SQLite 默认 + 全架构签名"**
Gitea 官方明确：所有下载"自带 SQLite/MySQL/PostgreSQL 支持，且网站静态资源均已嵌入可执行文件"，并对每个二进制发布配套 `.asc` GPG 签名可 `gpg --verify`。
出处：[docs.gitea.com Installation from binary](https://docs.gitea.com/installation/install-from-binary)、[docs.gitea.cn 1.26 二进制安装](https://docs.gitea.cn/1.26/installation/install-from-binary/) **[VERIFIED]**。
**为什么适合 BOX3**：BOX3 的 creator/play 已是 Next standalone，可被一个 Go/Rust supervisor 用 `embed.FS`/`include_dir` 内嵌静态 chunk；SQLite 作默认（见 §6）；一张 `.wslconfig` 之外的产物退化为"1 supervisor 二进制 + 2 运行时 tarball + 按需下载的镜像"。签名体系现成（§3）。

**抄法 #2 — systemd Quadlet + systemd-run 原生 cgroup 监督，替代 docker.sock supervisor**
Podman 自带 **Quadlet**：一个 systemd generator，把 `.container` 单元文件直接生成 rootless systemd service；`podman generate systemd` 也可为 rootless/rootful 生成 unit。
出处：[Rocky Linux Podman guide（Quadlet）](https://docs.rockylinux.org/zh/gemstones/containers/podman/)、[Gentoo Wiki Podman](https://wiki.gentoo.org/index.php?title=Podman) **[SECONDARY-官方文档]**。
**为什么适合 BOX3**：BOX3 `server-manager`（Rust，2.16MB）本质只是个进程监督器 + 动态起子运行时。用 systemd `.wants` + `systemd-run --user --scope -p MemoryMax= -p CPUQuota=` 完全能替代"经 docker.sock 动态起容器"，**顺带把最大的安全税（user:0:0 + docker.sock = 宿主 root 等价）清零**（§2d、§3）。

**抄法 #3 — Sigstore keyless + GitHub artifact attestations 替代 tar.gz+latest.txt**
GitHub 官方 `actions/attest@v4` 一键给容器镜像/二进制生成签名 provenance 与 SBOM attestation（`id-token:write attestations:write`）；cosign v2.0+ 支持 OIDC+Fulcio keyless 签镜像，签名以 OCI artifact `tag.sig` 存 registry；syft 生成 SBOM。
出处：[docs.github.com 使用项目证明确立来源](https://docs.github.com/zh/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations) **[VERIFIED]**、[Sigstore cosign](https://github.com/sigstore/cosign)。
**为什么适合 BOX3**：BOX3 已用 GitHub Actions 构建、`sourceRevision` 已在清单里——**离签名供应链只差几个 workflow step**。把分发从"1GB tar.gz + latest.txt"改成"推 OCI registry + cosign 签 + attestation"，自托管组织 `cosign verify` 即可信拉取，天然断网镜像。

---

## 2. 去 Docker 化的现实路径

### 2a. 单静态二进制 + 内嵌静态资源能覆盖哪些服务
- **可覆盖**：`server-manager`(Rust, 已是单二进制)、auth-portal / player-service（无 native addon 的纯 Node，可用 Node SEA + VFS 内嵌，见 §5）、静态 chunk（`embed.FS`/`include_dir` 装进 supervisor）。
- **不能纯静态覆盖**：`game-server` / `creator` / `voxa` —— 因 `isolated-vm@5.0.4`。isolated-vm **不是 N-API 稳定 ABI**，它直接链 V8 内部符号，靠 node-gyp 每 Node 大版本重编译、且 glibc-bound；`.node` 无法塞进 SEA 的 VFS（Node 官方：native addon 的 `process.dlopen()` 需真实文件系统，只能落临时文件再加载）。出处：[Node.js SEA 官方文档 § Limitations](https://nodejs.org/api/single-executable-applications.html) **[VERIFIED]**。
- **结论**：game-server 路线只能是"supervisor 内嵌 JS，运行时 Node 二进制 + 预编译 isolated-vm.node 作 side-car 随架构下发"，做不到 Gitea 式纯单文件。**[SECONDARY 判断]**

### 2b. rootless podman / systemd-nspawn 替代代价
- **现状**：安装器**显式拒绝** podman-docker（`bootstrap.sh:190`），且有契约测试锁死该行为（`scripts/server-installation-contract.test.js:333` `/podman-docker/`）**[VERIFIED]**。这意味着去掉 docker.sock 前，BOX3 官方立场不会支持 podman。
- **代价评估**：podman rootless 与 docker.sock 模型不兼容（podman 无常驻 docker daemon socket，需 `podman system service` 暴露兼容 socket；且 rootless 下挂"自己的 socket 再动态起容器" = rootless-in-rootless，官方 issue 明确不支持，见 [containers/podman#20812](https://github.com/containers/podman/issues/20812)）。**因此 podman 不是"换 runtime"能救的，必须先把 supervisor 从"经 socket 起容器"改成"起进程"（§2d）。**

### 2c. `systemd --user` + `.wants` 直接跑 Node 的可行性
- **可行**：Node 22 官方 linux-x64 tarball 约 50MB（解压后），glibc 要求与 Debian 12 bookworm 一致。rootless user unit 天然带 cgroup 限额（`MemoryMax`/`CPUQuota`/`TasksMax`）。
- **native addon ABI/glibc 约束**：isolated-vm 与 sharp 需 per-distro 预编译产物；一旦目标机不是 bookworm 同 glibc（如 Ubuntu 24.04 musl/alpine）就 `ELF ABI invalid`。sharp/libvips 亦 glibc 优先。→ 印证现状选 `node:22-bookworm-slim` 正确（§5）。
- **结论**：对个人组织"单台 Linux 机 systemd --user 跑"是 P1 的正解，但**必须随包锁 Node 小版本 + 附带匹配 glibc 的 `.node`**，不能假设目标机自编译。**[SECONDARY]**

### 2d. 混合：Rust manager 变纯 supervisor，去掉 docker.sock（最大安全赢面）
把"经 docker.sock 动态起子运行时"替换为"直接 fork/exec + systemd-run 资源限额"：
- **端口预分配**：manager 启动时按 `MAX_CONCURRENT_WORLDS` 预留一段端口池（如 41000–41063），每图分配一个，替代动态 `-p` 绑定。
- **限额**：`systemd-run --user --scope -p MemoryMax=256M -p CPUQuota=200% -p TasksMax=256 <game-server>`，cgroup v2 天然隔离；比 docker 少一层 daemon。
- **安全收益（量化）**：消除 `user:"0:0"` + `/var/run/docker.sock` 挂载。docker.sock 等价于**免认证 root 访问宿主**（可挂载任意宿主目录/逃逸），这是全文风险最高项；去掉后常驻特权进程从 **1 → 0**。
- **代价**：失去容器文件系统的隔离与"干净依赖打包"，需自己保证 isolated-vm/glibc/端口冲突；每图隔离性下降（编辑态本就不隔离，现状事实）。

### "无 Docker 最小部署"目标形态（预计值，需实测）
| 指标 | 现状 | 目标（P1 单机 systemd） |
|---|---|---|
| 常驻容器/进程 | 7 容器 | **1 supervisor(Rust) + N 服务进程**（creator/play/voxa/auth 各 1 常驻 Node，可合并）|
| 特权进程 | 1（manager 0:0+sock）| **0** |
| 宿主端口 | 9 | **3 固定（creator 3127 / play 3121 / voxa 3123）+ 每图 1 动态端口**（现状 9 可压到 3+活跃图数）|
| 交付字节 | 1011.5 MiB gz | **预计 150–260 MB**：supervisor ~20MB + node22 运行时 tarball ~50MB + isolated-vm/sharp 预编译 ~10MB + Next standalone ~80–120MB + SQLite 引擎（无 PG）。**[UNVERIFIED 估算，需 build 实测]** |
| DB | Postgres 必须 | SQLite/libSQL 默认可选（§6）|

---

## 3. Cloud-Native 化清单（面向已有 K8s 的小组织）

### 3.1 compose → Helm/Kustomize 的映射障碍
- **头号障碍**：现状强依赖 docker.sock **动态起子运行时**（一张图在跑 = 递归 spawn）。K8s 里没有"进程内调 docker 起容器"的合法等价物，只能改成 **Operator 动态建 Pod/Job**。这是把 manager 从"监督器"升级为"控制器 + CRD"的工程量级，非平铺翻译。
- **领域专用等价物 = Agones**：Agones 是"为 K8s 设计的专用游戏服托管"，用 CRD `GameServer/Fleet/FleetAutoscaler` 表达"一个房间=一个 Pod + 端口分配 + 健康 + 生命周期状态机"，恰与 BOX3"每图一进程/一房间"同构。出处：[Agones](https://agones.dev/site/docs/) **[SECONDARY]**。
  - **代价**：要引入 Agones controller、给 game-server 打 Agones SDK sidecar（健康/分配回调），且每图一 Pod 的调度/网络开销对"个人/≤几图并发"完全不划算。

### 3.2 HPA/KEDA 与"每图一进程"的分片矛盾
- CPU 型 HPA 不适配：房间负载不是 CPU 曲线，是"活跃房间数/在房人数"。需要**自定义指标 scaler**：Agones `FleetAutoscaler` capacity webhook，或 **KEDA external scaler / OpenKruise GameServerSet**（官方示例即 Minecraft 用 KEDA `ScaledObject`+external scaler 扩游戏服）。出处：[OpenKruise GameServer 伸缩](https://openkruise.io/zh/kruisegame/user-manuals/gameservers-scale) **[SECONDARY]**。
- 矛盾点：现状 prewarm=0、启动预算 30min → 任何自动扩缩在冷启动上会抖动；集群化前**必须先解决 prewarm**（属运行态，非本泳道，但清单要写死为前置条件）。

### 3.3 StatefulSet + PVC 与 bind mount / `box_engine` 动态建表
- `play-worlds` 是宿主 bind mount（且跨进程共享目录）。K8s 里等价是 PVC；但**多 Pod 共享一份卷**需 `ReadWriteMany`（NFS/CephFS），而 WSL 现状已暴露"共享文件系统 + 同步 IO"问题（§4）。SQLite 在网络文件系统上 WAL **明确要求所有进程共享内存、同主机**（[sqlite.org/wal](https://sqlite.org/wal.html) **[VERIFIED]**）→ 进一步否定"SQLite 跨 Pod 共享 PVC"。Postgres 单实例 + 连接池是集群态唯一稳的选择。
- `box_engine` 由 manager **运行时动态建表**：这与 GitOps/声明式迁移（Flyway/atlas 受控迁移）范式冲突——动态 DDL 让"从空集群可复现拉起"和回滚变得脆弱。集群化前需把动态建表纳入受控迁移或声明式 schema。

### 3.4 容器安全基线补齐（现状已有 vs 缺）
- **已有** **[VERIFIED]**：`no-new-privileges:true`、`cap_drop`、多服务 `read_only:true`、绑 `127.0.0.1`。
- **缺 / 补**：
  1. **seccomp**：全仓无 seccomp 配置。K8s `securityContext.seccompProfile.type: RuntimeDefault`，Docker `--security-opt seccomp=unconfined→默认 profile`。低代价高收益。
  2. **非 root**：manager/creator-init/play/voxa-init 现 `user:"0:0"`。目标降到非 root + 免 docker.sock（§2d）。
  3. **NetworkPolicy**：现状纯靠 bind 127.0.0.1；集群需 Cilium/Calico 默认拒绝 + 显式放行。
  4. **Pod Security Standards = restricted** 作为命名空间准入。

### 3.5 镜像签名 / SBOM / provenance 落地成本（低）
GitHub Actions 已就绪 → 加 3 类 step：`actions/attest@v4`（provenance，`subject-digest` 用 build-push digest）、`anchore/sbom-action`(syft) + attest `sbom-path`、可选 `sigstore/cosign-installer@v3` keyless 签。**落地成本：几十行 YAML，无需改代码。出处同 §1 抄法#3。**

### 3.6 OCI artifact 替代 tar.gz 分发（中）
用 `oras` 推归档为 OCI artifact 到 registry，或直接推镜像 + cosign 签；`latest.txt` 换成 registry tag/digest 解析。收益：内容寻址、断网镜像、签名一体。成本：改 `BOX3_RELEASE_CDN_URL` 消费端逻辑（已有自托管后门，改动面可控）。

### 3.7 分阶段建议 + **P2 是否值得为个人组织做**
- **P0（本地优先，最高性价比）**：① 去 docker.sock（§2d，安全清零）；② `seccomp=RuntimeDefault`；③ cosign+attestation+SBOM 上 Actions；④ `.wslconfig` 调优（§4）。全是配置/少量代码，**不动架构**。
- **P1（单机 systemd）**：supervisor 走 `systemd --user` + cgroup 限额；SQLite 默认；交付退化为二进制+运行时 tarball（§2d 目标形态）。个人/小组织**甜点区**。
- **P2（集群 Helm/Agones）**：**结论：不值得为个人组织/≤ 少数并发房间做**。理由：docker.sock 动态起子运行时 → 必须重写为 Agones/Operator；PVC 共享与 SQLite/动态建表冲突（§3.3）；每图一 Pod 冷启动 + prewarm=0 使自动扩缩抖动（§3.2）。**工程量 > 所有收益**，只在"组织本就运营 K8s 且需百级并发房间"时启动。

---

## 4. WSL2 作为本地部署目标的专业调优（用户当前环境）

### 4.1 vmmem 5.3–6.1GB 之税 → 内存回收
`autoMemoryReclaim`（`[experimental]`）三值：`disabled`/`gradual`/`dropCache`。WSL 默认缓存 page cache 不主动归还宿主，导致 vmmem 远超容器真实 RSS（313MB）。设 `gradual` 让 WSL 空闲时缓慢把 cache 还给 Windows，是"交付方式的税"的直接解药。`pageReporting=true`（默认）配合 balloon driver 也回收空闲页。出处：[Microsoft WSL 高级配置](https://learn.microsoft.com/zh-tw/windows/wsl/wsl-config)、[oneuptime 调优](https://oneuptime.com/blog/post/2026-02-08-how-to-configure-docker-desktop-memory-and-cpu-limits-on-windows/view) **[VERIFIED]**。
- **注意 [SECONDARY]**：有博客称 WSL 2.7+ 该选项迁移到 WSL Dashboard GUI、纯文本 `instanceIdleTimeout` 可能失效——落地后需 `wsl --version` 核对，别盲信。

### 4.2 网络：mirrored + DNS tunneling
`networkingMode=mirrored`（Win11 22H2+ / WSL 2.0+）让 WSL 与宿主共享网络栈：BOX3 绑 `127.0.0.1:3121/3123/3127` 的 9 端口在镜像模式下**宿主浏览器直接可达**，消除 NAT 模式 localhost 转发的抖动与端口漂移。`dnsTunneling=true` + `autoProxy=true` 修 DNS 卡顿。出处：Microsoft WSL networking **[VERIFIED]**。

### 4.3 9P 跨系统调用惩罚（呼应 S2 同步 IO/自旋锁）
微软官方明确性能表：**Linux 进程读 `/mnt/c/…`（9P/drvfs）= 慢；Windows 进程读 `\\wsl$\…`（9P）= 慢；避免用于构建/`node_modules`/Git**；建议把仓库放 Linux ext4（`~/projects`）。出处：[Microsoft WSL interop](https://learn.microsoft.com/zh-cn/windows/dev-environment/wsl-interop) **[VERIFIED]**。
- **量化惩罚 [SECONDARY]**：多个来源称 9P 每次 `stat`/`open`/`read` 跨 VM 边界，小文件密集场景单次延迟可达 200–500ms、`npm install`/`node_modules` 慢 3–10×；`\\wsl$` 是只读映射、写仍走 9P，不解决问题。
- **对 BOX3 的落地判定**：`projects/`、`play-worlds/`、`data/`(PG) 若 bind mount 源指向 `/mnt/c/…` 或 `\\wsl$`，就是 S2 观测到"同步 IO + 自旋锁"的根因放大器。**必须把这些路径全部落在 WSL 发行版的 ext4.vhdx（`~/box3/…`）内**，让 docker bind mount 源与容器都在同一 ext4。微软正在用 **virtiofs 替代 9P**（公测，实测再快约一倍）[SECONDARY]。

### 4.4 可直接落地的 `.wslconfig`（放 `%UserProfile%\.wslconfig`，改后 `wsl --shutdown`）
```ini
[wsl2]
memory=6GB                 # 12GB 保留是税；给 6GB 已远大于 313MB RSS + 若干 next-server 进程
processors=4
swap=8GB
pageReporting=true         # 主动把空闲页还给 Windows
localhostForwarding=true
networkingMode=mirrored    # Win11 22H2+：宿主浏览器直连 BOX3 的 127.0.0.1 端口
dnsTunneling=true
autoProxy=true
# 关键：projects/play-worlds/data 一律放 WSL ext4，不放 /mnt/c
[experimental]
autoMemoryReclaim=gradual  # 缓解 vmmem 5.3–6.1GB：空闲缓还 page cache
sparseVhd=true             # ext4.vhdx 可收缩，删除/重建镜像后回收宿主空间
```
**目录放置建议**：`wsl` 内 `~/box3/{projects,play-worlds,data,pgdata}`；Docker Desktop 后端切 WSL2 engine 且镜像存储留在 WSL ext4；Windows 侧只在编辑器（VSCode Remote-WSL）访问，绝不用 `\\wsl$` 做构建循环。出处同 §4.1/4.3。

---

## 5. 替代运行时与打包工具前沿（2025/2026）

- **Bun 与 isolated-vm**：**不可用（强结论）**。Bun 运行时是 **JavaScriptCore**（非 V8），而 isolated-vm 直接嵌 V8 并链其内部符号——引擎的脚本沙箱（ivmp/ivm2）无法在 Bun 下工作。Bun 的 Node 兼容层覆盖 `node:*` 与部分 Node-API addon，但不覆盖依赖 V8 私有 API 的 addon。出处：[Bun Node.js Compatibility Layer](https://bun.sh/docs/runtime/nodejs-apis)、isolated-vm 绑定 V8 的事实。→ **game-server 排除 Bun**；无沙箱的纯 Node 服务（auth-portal/player-service）理论可试，但收益要压过"多一套运行时 ABI"成本，**[UNVERIFIED，不建议]**。
- **Node SEA / V8 snapshot（快启动单文件）** **[VERIFIED 一手 Node 文档]**：
  - SEA 版本史：v19.7.0/v18.16.0 引入；v20.6.0 加 `useSnapshot`/`useCodeCache`；**v25.5.0 内置 `--build-sea`**（不再需 postject）；**v26.9.0 加 VFS `useVfs`**（`node_modules` 可在虚拟挂载点解析）。当前稳定性仍是 `1.1 积极开发`。
  - **硬限制**：native addon（`.node`）不能从 VFS 载（`process.dlopen` 要真实 FS）；`useSnapshot` 不能与 `useVfs` 或 `mainFormat:"module"` 并存。→ **game-server 因 isolated-vm 无法纯 SEA**。
  - **启动数字 [SECONDARY，需本地实测]**：阿里 Noslate/Aworker 工程分享称 Node 用 startup snapshot 有 2–5× 效果（约 100ms→20ms），内建模块 snapshot 后裸启动约 10ms；Deno 2.9 把 hello-world 冷启动 34ms→17ms。可用于**缩短 auth/player 冷启**，但对 92–122MB 常驻 next-server 的**稳态 RSS 无解**。→ 与用户"宁可换架构也不接受多秒计算"直接相关：prewarm/常驻才是战场，snapshot 只优化冷启那一跳。
- **`@vercel/nft` / esbuild 裁剪**：Next standalone 已用 `outputFileTracing`(nft) 只拷用到的文件；官方 Vercel 限制单函数解压后 250MB 也靠 tracing 兜。esbuild `--bundle` 对 ESM 可再压，但对 isolated-vm/动态 require 有副作用，需回归测试。数字：某 Next 项目 standalone 后 `.next/standalone` 常 5–10MB 级、生产镜像从"整包 node_modules 200MB+"降到几十 MB **[SECONDARY]**。
- **distroless/node、`node:22-slim` vs alpine** **[SECONDARY-官方镜像语义]**：
  - `gcr.io/distroless/nodejs22-debian12`：无 shell、无 apt，攻击面最小，但 `docker exec` 调试不可用，且需把 sharp/libvips `.so` 手拷。
  - `node:22-alpine`（musl）：体积约 slim 的 1/3，但 **sharp / sqlite3 / isolated-vm 等 glibc 预编译产物在 musl 下 `ELF ABI invalid`**，需 `python3/make/g++` 现场重编译且常失败。→ **BOX3 现选 `bookworm-slim` 是正确权衡**：既有 glibc 兼容 isolated-vm+sharp，又不背全工具链。真正该做的是**多阶段构建只拷运行时**，而非换 alpine。
  - 现状"单镜像 39% 是构建期工具 / 跨镜像字节重复 613MB"→ 用共享 base 层 + `--mount=type=cache` + 最终 `COPY --from=builder` 只留 prod 依赖即可显著削减，**不改基础镜像**。

---

## 6. SQLite/libSQL 作私有化默认存储

- **WAL 能力边界 [VERIFIED]**：`Readers do not block writers and a writer does not block readers`，但**同一时刻只有一个 writer**，且**所有进程必须共享内存、在同一主机**（禁用网络文件系统）。→ 契合"单机私有化"，但**直接否定跨 Pod 共享 PVC（§3.3）与把 db 放 /mnt/c（§4.3）**。
- **PGLite**（ElectricSQL，WASM 版 Postgres，约 3MB、GitHub 13.9k★）：**单连接/单上下文**、官方 `status: alpha`，复杂查询/高并发写弱于原生 PG。→ **不适配 BOX3"每图一进程"多连接写模型**（各 game-server 进程需独立连接）。出处：[PGlite](https://pglite.dev/) 及相关评测 **[SECONDARY]**。
- **libSQL**（Turso 的 C fork，生产就绪）：加嵌入式副本/HTTP 访问/复制；多写者/MVCC 仍在演进；Turso 的 **Rust 重写（原 Limbo）仍 beta，未生产就绪**。sqlite-vec（纯 C 向量扩展，跨平台/WASM）仍"活跃开发、生产谨慎"。出处：[libSQL/Turso 现状](https://github.com/tursodatabase/libsql) **[SECONDARY]**。
- **迁移工具**：Drizzle（TS-first，SQLite+PG 双驱，便于渐进迁移）、Kysely（类型安全查询构建器）、**Atlas**（声明式 schema + 受控迁移，正好治 §3.3"动态建表"痛点）。**[SECONDARY]**。
- **对 S5 结论的外部校验：`box_engine` 动态建表搬到 SQLite 的真实障碍** **[UNVERIFIED，需 S5/代码取证]**：
  1. **动态 DDL**：SQLite `ALTER TABLE` 能力受限（无 drop column 旧版、约束改动需 rebuild），运行时按用户地图动态建表会更频繁触发放回/重建。
  2. **PG 专有特性**：若 `box_engine` 用了 JSONB、数组类型、`RETURNING`、部分索引、生成列，SQLite 需改写（JSONB→TEXT+json1、数组→JSON）。
  3. **并发写模型**：compose 有 `BOX_GROUP_STATE_LOCK_TIMEOUT_MS/STALE_MS`（`docker-compose.yml:350-351`）暗示用 **PG advisory lock / 行锁做房间组状态锁**；SQLite **无 advisory lock**，`BEGIN IMMEDIATE` + WAL 单写者能替代但要重设计锁语义。**[需核实]**
  4. **LISTEN/NOTIFY**：若实时链路依赖 PG 逻辑复制/`LISTEN`，SQLite 无等价物。**[需核实]**
- **外部判断**：SQLite **技术上能承接单机私有化默认存储**（WAL 足够单机），但对 BOX3 的真实门槛不是体积而是**动态建表 + advisory-lock + 可能的 PG 专有类型/通知**。建议：**PG 仍为写模型；SQLite 作"编辑态/单玩家离线/零依赖试用"档**，而非一刀切替换。

---

## 7. 前端瘦身可抄的做法

- **静态导出 `output:export` 替代 SSR** **[VERIFIED-官方]**：官方限制清单——**不支持 middleware、API Routes、Server Actions、ISR、需自定义 image loader（`images.unoptimized`）**；纯 `out/` 可丢任意静态服务器/Caddy。→ BOX3 若用了 middleware 鉴权 + server routes（auth-portal/player-service），**整站静态导出不可行**；但 `.next/static` chunk 与字体本就是纯静态，可由 **Caddy/单二进制内嵌静态服务**代劳，SSR 只保留真正需要动态的路由（§1 抄法#1 的内嵌资源思路）。
- **字体子集化 unicode-range（58.6MB 的头号靶）** **[VERIFIED/SECONDARY]**：
  - 业界样板：**鸿蒙开发者官网把同一字体拆 96 个 `unicode-range` 子集**，完整 WOFF2 8.1MB，首屏只按需请求 44 个子集 = 1.1MB。
  - 格式收益：TTF→WOFF2 平均 **-40%**（Brotli），思源黑体某字重实测 8.2MB→子集后 <1.3MB（**-80%**）。
  - **对 BOX3 的关键约束**：引擎是 **UGC 编辑器，运行时要显示任意用户输入字符** → **不能用 pyftsubset 只留页面用到的字**（会缺字形）。正解 = **Google-Fonts-CJK 式 `unicode-range` 分片 + `font-display:swap` + 首屏仅拉拉丁/常用字块**，把 58.6MB 变成"浏览器按字符命中、分片懒载"。可分片把首屏字体从"整包下载"降到 1–2MB 级 **[需实测]**。
- **Monaco vs CodeMirror 6（12.6MB）** **[VERIFIED 一手博客]**：
  - **Sourcegraph** 搜索页从 Monaco(6MB) 迁 CodeMirror(3.4MB) → **下载 JS -43%**。
  - **Replit**：Monaco 及库给 bundle 贡献 **51.17MB（parse+gzip 5.01MB）**，遂转 CodeMirror 6。
  - CodeMirror 6 核心 minify 仅 ~70KB、按需加语言；Monaco 全量 ~2MB+worker。
  - **对 BOX3 的判断**：BOX3 是"网页版游戏编辑器"，Monaco 的 IntelliSense/LSP 体验有真实产品价值，**不建议整体替换**（迁移代价高、能力倒退）；正解是**仅在编辑器路由 `dynamic(()=>import(...),{ssr:false})` 懒载 Monaco**，把它从首屏 chunk 摘出——首屏字节可去掉 12.6MB 的常驻成本。
- **Next 客户端 chunk 拆分** **[VERIFIED-官方]**：Next 14.2 的 Server↔Client 边界 tree-shaking 让 `react-aria-components` 单测 **bundle -51.3%**。→ 开启边界 tree-shaking + `optimizePackageImports` + 减少 `"use client"` 面，是 BOX3 现成可吃的收益。

---

## 8. 组织视角："fork 自建" vs "推上游 PR" 成本模型

**资产盘点（fork 漂移风险源）**：源码 ~47万行、34 个 project、Rush 版本锁 + `pnpm-lock.yaml`（改动牵一发动全身，见 `common/config/rush/`）、6 条 CI workflow。这是**大型单体 monorepo**，fork 后 rebase 成本随上游提交数线性上升，且 Rush lock 是主要冲突热区。

**成本模型（[UNVERIFIED 定性 + 业界 trunk-based/inner-source 常识]）**：
- **纯 fork 自建**：每次上游发版需 rebase；改到被上游重构的模块 → 冲突；改 Rush/lock/CI → 几乎必冲。维护成本 ∝ 上游改动 × fork 改动重叠面。个人组织**几乎无力长期承担**。
- **推上游 PR**：上游是 MIT 全量开源、有 CONTRIBUTING.md → 接纳路径存在；但评审周期、设计取向未必合"更轻/去 docker"诉求。

**建议（把改动做成"配置而非代码"以最小化漂移）——优先级即 fork 安全度**：
1. **零代码冲突层（首选，直接可做）**：`.wslconfig`、目录放 ext4、compose overlay（`profiles` 已存在，可加 `compose.override.yml` 关 Redis/合并服务）、env（`BOX3_RELEASE_CDN_URL` 自托管后门、`BOX_*_BIND_IP=127.0.0.1`）。这些**不进仓库源码，永不冲突**。
2. **构建产物层（低冲突）**：加 CI step（cosign/attestation/SBOM）、Dockerfile 多阶段瘦身——改的是 `apps/*/Dockerfile` 与 `.github/workflows`，与业务代码正交。
3. **架构层（高冲突，必须走上游 PR 而非本地 fork）**：去 docker.sock 的 supervisor 改造、`seccomp=RuntimeDefault` 进 compose、SQLite 可选存储——**这些动 `server-manager-rust` 与 compose 主干，fork 硬改会在 rebase 时反复爆冲突**。策略：**提上游 PR**，把 §2d/§3.4 作为"给社区的安全增强"，一旦被合并即零维护成本。
4. **rebase 节奏**：建议**跟随 `latest.txt` 每个 minor 版 rebase 一次**（当前 2026.1.4），不攒大 diff；每次只 patch 上述"配置层 + 构建层"，架构诉求走 PR 排队。

**净结论**：对**个人/小组织**——**不要整仓 fork 魔改**。正确姿势是"**薄 overlay 配置 + 构建流水线增强 + 把去 docker/签名/SQLite 提到上游**"。fork 只用于锁住你自己的 compose override 与 `.wslconfig`，把不可配置的行为尽量上交，使漂移面收敛到"非源码"层。

---

## 9. 汇成给主控的取舍要点

1. **交付税 >> 执行税**：真实执行只需 313MB/毫秒 TTFB，重量全在 6 镜像 + docker.sock supervisor + WSL VM 保留。**先动交付与监督模型，别动业务代码。**
2. **最该抄**：Gitea 单二进制内嵌资源 + 签名（§1#1）、systemd Quadlet/systemd-run 取代 docker.sock（§1#2/#2d）、Sigstore+GitHub attestations 取代 tar.gz（§1#3）。
3. **安全最大赢面 = 去 docker.sock**（常驻特权进程 1→0），代价最小、收益最高，P0 就做。
4. **P2 集群不值得为个人组织做**（docker.sock→Operator 重写、PVC 共享与 SQLite/动态建表冲突、每图一 Pod 冷启动 + prewarm=0）。
5. **isolated-vm 是去 Docker/SEA/Bun 路线的统一硬约束**：V8-bound + glibc-bound，决定 game-server 永远带 side-car 运行时，不要幻想纯静态单文件。
6. **WSL2 立即生效两招**：`autoMemoryReclaim=gradual`（治 vmmem）+ 把 projects/play-worlds/data 移进 ext4（治 9P 惩罚）。
7. **前端**：字体走 unicode-range 分片（非激进子集）、Monaco 懒载不替换、吃 Next 边界 tree-shaking。
