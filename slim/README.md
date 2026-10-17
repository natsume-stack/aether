# box3-lite-engine —— BOX3 轻量引擎

本仓库是 **box3lab/box3-local-engine v2026.1.4**（MIT，上游提交 `a35455d814`）的 fork-and-slim 改造版，
不是独立实现，也不含逆向产物：全部改动基于官方开源源码白盒进行。

改造目标：把出厂形态的「7 常驻容器 / 9 宿主端口 / 1 个挂 `docker.sock` 的常驻 root 进程 / 1011.5 MiB 分发」
收敛成个人与小组织可自托管的轻量引擎，**且不得破坏现有地图的运行与功能**（这是硬性前置，见 `slim/ROADMAP.md` §3）。

## 布局

```
/                     引擎源码（官方 v2026.1.4 + 本地改动，分支 slim/local-deploy）
  distribution/play-lite/     轻量开服包：4 容器 / 4 端口全 127.0.0.1 / 零特权
  scripts/prune-standalone.mjs        构建期工具裁剪器（等价性已实测）
  scripts/check-image-budget.mjs      体积回归门  + scripts/lib/budget.mjs
  apps/local-engine/src/launcher.js   去递归监督进程 + 实测内存预算
  apps/manager-core/src/release_channel.rs   离线/自托管发布通道
slim/                 改造资产（分析、取证、记分板、工具、基线）
  ROADMAP.md          总排期与三条新需求的落地路线 —— 先读这个
  GATES.md            验收门记分板（G1–G9 × 每条改动，标注 已实测/部分/待证/未开工）
  ANALYSIS-AND-PLAN.md 方向、基线数字、P0/P1/P2 计划
  HANDOVER.md         轮次交接（环境地图、坑清单）
  impl/ plan/ src/    分泳道交付文档与白盒取证
  poc/                P2 生死判定的 PoC 原始输出
  tools/compat-check.sh + baseline/   地图兼容性回归闸（52 项）
  _manifest/          6 官方镜像归档的字节与 sha256（体积主张的权威来源）
```

## 兼容性闸（任何改动合入前必须过）

`slim/tools/compat-check.sh` 是"优化不得破坏现有地图"的可执行判据。**只支持在 WSL/Linux 内运行**
（实测：同一份源码在 Git Bash 的 gawk 5.4.0 与 WSL 的 gawk 5.2.1 下会算出不同的契约指纹，
一个换 shell 就换红绿的闸不可信，所以它直接拒绝出结论）。

```bash
wsl -d Ubuntu-24.04 -- bash -lc 'bash "/mnt/d/desktop/神奇代码岛/box3-local-engine/slim/tools/compat-check.sh"'
# 退出码：0=PASS（全部测到且与基线一致） 1=FAIL（真回归/检查项被删/无基线） 2=PARTIAL（有 N 项因环境未测，不算通过）
```

工作副本布局（`box3-re/tools/` 与已合仓布局 `slim/tools/`）都能跑，仓库根靠 `packages/script-api/dts` 锚点自动识别。

## 当前状态（诚实版）

**G1–G9 没有任何一门完全通过。** 有实测数字的部分：

| 项 | 实测 |
|---|---|
| 轻量开服包 | 4 容器 / 4 端口全 127.0.0.1 / 零 docker.sock / 零常驻 root；自助注册→登录→进图 `200 / 149,594 B` |
| 分发体积 | 3 归档 = **531,307,786 B**（出厂 1,011.5 MiB → **−49.9%**），口径来自 `_manifest/BOX3-IMAGE-CATALOG.json` 字段 |
| 打包裁剪 | play 自带 standalone 树 removed **88,176,940 B**，且与出厂树**逐字节等价**（5 路径校验和一致、`MODULE_NOT_FOUND=0`） |
| 体积门 | 已接入 CI，19 项测试通过，红/绿各演示一次 |
| 进程模型 | creator 递归监督进程已删，改前后传给 game-server 的 argv/env 逐字段等价（152 项零差异） |
| 兼容闸 | WSL 内 **52 PASS / 0 FAIL** |

已用数据否决的路线：**单进程 isolate 池**（1 个挂死 isolate 把同伴 tick p99 从 6.25 ms 打到 127.28 ms，门 20 ms；
4 isolate 并发 OOM 后 RSS 2173.6 MB 不回落），数据在 `slim/poc/`。
`isolated-vm@5.0.4` 非 N-API → 单二进制 / Bun 路线永久关闭。

主要未闭合项：镜像**一次都没重建**（G1 真数卡在联网 re-lock，`pnpm-lock.yaml` 与 `package.json` 尚不一致）；
离线安装**端到端 0 次**；SBOM/签名全仓 0 命中；可用真实回归图**只有 1 张**。
`scripts/check-standalone.js:1501` 的正则仍锚定被删除的 spawn 参数行 → 该构建校验当前为红（待处置）。
