# BOX3 —— 轻量化 × 页面自定义 × AI 接管地图开发：统一路线图

生成：2026-10-17 22:30 ｜ 作者：本轮主控 agent
输入：10 条泳道交付（`impl/` 8 篇 + `plan/` 2 篇 + `poc/` 原文）＋ 主控亲自复跑取证
纪律：本文只收录**有原文证据**的结论；未证的显式标 `待证`/`UNVERIFIED`。
**刷新（2026-10-18）**：§0 结论章节已按 C6 串行实测轮（`scan/O6-benchmark-comparison.md`）重写。**§1 及之后各节的内存/进程数字若与 §0.1 冲突，以 §0.1 为准**；§7 的测量清单大部分已被 C6 闭合。

---

## 0. 结论（2026-10-18 串行实测轮之后）

### 0.1 唯一有效的对比数字

C6 串行轮（`scan/O6-benchmark-comparison.md`）在同一台 WSL 里让出厂 7 容器与轻量 4 容器**同时在跑**，
熟态连续 3 轮 12×10 s 采样。**本文与所有旧文档里的内存/进程主张，一律以下面这组数替换，不得混用旧口径**：

| 维度 | 出厂 | 轻量 | 差 | 口径 |
|---|---|---|---|---|
| 空闲 RSS | 376.14 MiB | 258.74 MiB | **−31.2%** | `docker stats`（memory.current − inactive_file），36 样本均值 |
| 空闲 RSS | 284.14 MiB | 166.38 MiB | **−41.4%** | cgroup `anon`（去掉可回收 page cache） |
| `/api/health-check` TTFB 中位 | 3.2 ms | 3.1 ms | **基本持平** | 20 样本；不宣称接口变快 |
| 分发 | 1,060,646,139 B（6 归档） | 531,307,786 B（3 归档） | **−49.9%** | gz，catalog `size` 字段 |
| `docker load` 后 content | 2,736,210,446 B | 1,358,827,262 B | **−50.3%** | `docker image inspect .Size` |
| `du -sb /app` 合计 | 1,835,711,422 B | 665,615,084 B | **−63.7%** | 轻量列含 2 张图 |
| 常驻容器 / 宿主端口 | 7 / 9（含 `0.0.0.0:3130`） | 4 / 4 全 `127.0.0.1` | −43% / −56% | `docker ps`、`ss -ltnp` |
| `docker.sock` / 常驻 root | 1 / 2 | 0 / 0 | 归零 | inspect、进程 uid |
| 每开 1 张图 | — | 进程 **+2**、anon **+146.4 MiB**（Pss +152.6） | 成本 | idle 3 → 起图 5 进程 |

三条读法约束：**降幅几乎全部来自"少跑 3 个服务"，不是同一服务变轻**（逐服务 `/app` 反而更大：轻量 play 402,098,657 > 出厂 play 373,668,042）；
**G2 的 ≤320 MiB 门必须显式绑定采样窗口**，否则同一台机器可以同时过门与不过门（313.67 / 328.05 / 376.14 是同一套栈的不同运行时长）；
**表中"轻量"数字用的是官方 3 个归档，本仓改动一次都没进镜像**。

### 0.2 被推翻的旧主张（照实记账，别再引用旧数）

| 旧主张 | 现结论 | 出处 |
|---|---|---|
| lite 空闲 156.88 MiB / **−52.2%**、出厂 313.67 或 328.05 MiB | 全部作废，改用 §0.1 | O6 §3 #1/#2 |
| 「删递归监督进程省 **56 MB/图**」 | 同类进程 VmRSS 61.9 MiB 但 **Pss 16.4 MiB** → 56 是 VmRSS 父子重复计入，去重约 **17 MiB/图，高估 ~3.4×**；10 图上界 0.17 GB 而非 0.55 GB | O6 §2.1 |
| 上述改动与内存预算已生效 | **未部署**：镜像内 `launcher.js` 34,542 B / 3 行、含 6 处 `--runtime-only` 再入 spawn；`runtime-memory` 模块不在镜像里，三容器 grep `budget` = **0 条** → **现网收益 0** | O6 §2.1/§2 表 |
| 「play 镜像已无 Monaco `static/vs`，收益作废」 | **证伪**：play 自带 standalone 树 `static/vs` = **12,560,595 B**（未压缩），play + player-service 各一份 → 恢复为 P0 头号候选，规则必须 byService 限 play/ps | `scan/O1` C01 |
| 进程模型收窄 | **反向信号**：每图 **+2 进程**（游戏服 `--useProdBundle` + `ivmp-process-entry`），监督进程只占每图成本 ~10–11%，真要砍内存得动那两个进程 | O6 §2.1 |
| 「4983 个数据文件」 | 实测 **4981**（projects 4073 + play-worlds 908），计数方式需在基线里钉死 | O6 §1.2 |
| 「离线包 = 零外部依赖」 | 归档清单不含数据库镜像；`postgres:16-alpine` content 116,084,812 B 两边都要 | O6 §3 #5 |

冷启动侧首次落盘的实测：`spawnSync tar` 全工程快照 **0.9–2776 ms**（warm 0.6–1.4 ms）是单图冷启动唯一大头；
lite 全栈 → 4 个 healthy **12.79 s**；单图冷启动首见 **10.77 s**、缓存命中后 **7.19 s**（引擎自报纯服务端 1.40 s / 1.25 s）。
兼容性闸 C6 轮 **54 PASS / 2 FAIL**，两条红都是"合法新增第 4 张图"的计数漂移（`drift.map.projects.count` 3→4、
`drift.map.scriptBlobs.total` 36→58），原图逐字节仍 PASS → **判定无回归**，但闸的语义缺陷要修（§3.2、D4）。

### 0.3 三条新需求的定性（结论不变，准入条件变了）

用户的第 3 条不是"一个功能"，而是**前两条与全部瘦身工作的准入门**：

> "以上内容，包括各个优化，轻量化，提速等等，都要建立在对原有地图支持的基础上进行，不能说你对其优化了，原有地图就不能正常运行了，地图各个功能也异常了，这是不能接受的。"

所以排期上它是 **Wave 0**：护栏不成立之前，任何 prune/进程改造/依赖挪动都不得合入。本轮已把它从口头原则变成可执行闸（§3），
并且**当场抓出一处会打破构建校验的回归**（§3.3）——这正是要它存在的理由。
C6 之后准入门多了一条硬条件：**任何"收益"必须先在部署态可测**，源码态的字节与内存数字不再单独算成果（§0.2 三条未部署）。

**新增的产品级缺口（C6 实测）**：`.boxproject` 的导入面只存在于 creator 模式
（`apps/game/server/creator-api-security.ts:42` 要求 `BOX_DEPLOYMENT_MODE=creator`，play/lite 侧 404）
→ **轻量形态今天无法自助导入地图**，素材必须先进出厂 creator，再走 `publish → .boxplay → play-admin/import`（该链已实测 201/201，`confirm` 自动置 `playEnabled=true`）。
这直接改写 D5（是否把 play-lite 定为交付主线）：要么 lite 包里加 creator profile，要么固定双栈流水线，二选一。

需求 1（play 页面自定义）与需求 2（AI 接管 edit 端）互相咬合得很紧：
- A7 取证：每张已发布地图的 `manifest.json` **早就带了一套 4 值 `theme` 设计令牌**（`apps/local-engine/src/project-manager.js:2442` `theme: metadata.theme || 'sunset'`），但 play 侧**从来没读它**（`apps/game/server/play-worlds.ts:22-73` 的字段清单不含 theme）。
- A8 取证：引擎**已内置一套 15 个 zod 校验的 AI 工具**（`services/game-server/src/edit/ai/entity-tools.ts`，经 `replica.projectTransaction()` 写同一棵 `EntitiesTreeRDA`，完全不依赖 LLM），但其中 **0 个体素、0 个 UI**。

→ 两条需求的公共底座是同一件事：**把"作者意图"变成服务端可读写的结构化数据，并给它一个可编程入口**。页面自定义是先接线，AI 接管是先扩面。分开做会各写一套 schema 然后打架；合起来做只加一份。

---

## 1. 本轮推翻/收窄的既有主张（照实记账，不含糊）

| 原主张 | 本轮结论 | 依据 |
|---|---|---|
| `−154 MB/镜像` 构建工具可删 | **收窄为 play 自带 standalone 树实测 removed 88,176,940 B（≈84 MiB）**。差额是**结构性够不着**：AMP 4 MB 与 babel 大头 31 MB 在 `next/dist/compiled/*`（Next 内建，非 store 条目）；sql.js debug 22.7 MB 与 isolated-vm 在 `/opt/game-server` 后端树，本轮 eq2 只挂 standalone | `impl/P0-prune-standalone.md` §2/§4 |
| prune 规则"从未验证" | **已验证且等价**：control 与 pruned 的 5 个路径 status/bytes/校验和**逐字节相同**，两棵树 `MODULE_NOT_FOUND=0`，两边 `/api/health-check` 均 UP 200 | 同上 |
| CI 体积门"代码已在树里、只是没接线" | **它此前连加载都会 SyntaxError**（源头 `scripts/lib/budget.mjs:146-150`）、默认配置路径算错一层、黑名单表**无任何消费者**。修完才第一次跑通；新增 `ratchet` 档让门今天就能阻断上游字节回归 | `impl/W2-ci-size-gate.md` |
| `release_channel.rs` +261 行"未验证" | **原本根本编不过**：两处 `E0277`（`?` 用在返回非 Result/Option 的函数）。A1 在所有权内修复后 `rustc --test` → 4 passed / 0 failed。整 crate 的 `cargo check --offline` 仍失败（缓存缺 tar/urlencoding/zip）→ 仍 `UNVERIFIED` | `impl/W6-offline-selfhost.md` |
| §3.4 "headless 缺口 = 五个端点只认浏览器 Cookie、CLI Token 封顶 9 项 → 今天无法 CI 建图→发布→上服" | **源码层被推翻**。任意 scope 的 `bxc_…` Bearer 会被同一身份链接受，只看**用户级 creatorPermissions**；`:141` 才做 9 项 scope 校验。真正的零写入口是**地形(voxels) 与 UI 树(uiTree)**。→ 这条"缺口"同时是一个**越权面**，不是便利 | `plan/N2-mcp-ai-map-authoring.md` §2 |
| "398 个服务端可调用" = 契约面 | **数字精确可复现**（183 = method 98 + ctor 52 + get/set 23 + 索引签名 10；215 = arrow 204 + callsig 11），**但语义口径只有 313**：52 个 constructor 是 new 位点、10 个索引签名不可调用、23 个 get/set 按属性读写且这批行在 398 与 1234 里**被重复计了一次**。客户端宣称 32、**实测 30** | `impl/G3-map-compat-baseline.md` §2 |
| play-lite = 3 容器 / 3 端口 / 423.8 MiB | 补回登录门户后是 **4 容器 / 4 端口 / 仍零 docker.sock、零常驻 root**；分发 = 3 个归档 = **531,307,786 B（−49.9% vs 出厂 1,011.5 MiB）**。真实代价是 +86,925,875 B gz 的 portal | `impl/W4-play-lite-package.md` §11 |

另有一处**内部不自洽**须记下：`G3-map-compat-baseline.md` §2.1 那行 awk 原样跑出 **450** 而非 398（因 M 桶含 ctor）；313 可复现，权威口径是互斥分桶 / `members.tsv`。

---

## 2. 需求 1 —— play 页面自定义

**现状钉死在哪（A7 取证）**
- 版式全部烤进 bundle：`apps/game/pages/index.tsx:1491` 起的 `<style jsx>`（`.playerGrid:1663`、`.card:1826`、根布局 `.playWorkCenter.page:2518`，色值如 `#ffdb00` 散写），**运行期无样式钩子**。
- creator 侧**已有**对应预设 `.coverSunset/Ocean/Forest/Violet`（`pages/projects/projects.module.css:19`）——同一套设计语言，play 没接。
- `theme` 是自动轮询赋值（`project-manager.js:1118-1127`），**作者选不了**。
- 服主侧被**主动禁止**改展示字段：`apps/game/server/play-admin.ts:858-861` 只允许 `publicId`/`playEnabled`，name/cover/description/author 一律拒改。

**三档方案（A7 已否决第三档）**
| 档 | 做法 | 改动半径 | 判断 |
|---|---|---|---|
| 一 | 把已有 `theme` 接进 play 首页 + 让作者可选（补 `play-worlds.ts` 字段 + `updateProject` 的 theme 分支 + `index.tsx` 读它） | 3 处，首屏增量数 KB | **先做这个**。零新机制，与 lite 形态零冲突 |
| 二 | 每地图一份**白名单设计令牌 JSON**（栅格/圆角/字号/配色），服务端注入 | 需 schema + 校验 + 落盘字段 | 一档骨架之上叠加 |
| 三 | 作者自定义 HTML/CSS/组件 | 大 | **否决**：XSS/模板注入 + 与现有"HTML 基路径 monkey-patch `http.ServerResponse.prototype`"正面冲突 + 破坏无特权 CSP；档一/档二已覆盖大多数诉求 |

**兼容性硬约束**：`apps/game/server/project-editor-dialog-ui.test.ts:152` 硬钉了 `.playerGrid` 的栅格值 —— 改列表栅格**必须同步改这条断言**，否则构建校验红。

---

## 3. 需求 3 的工程化 —— 地图兼容性回归闸（Wave 0）

已产出：`box3-re/tools/compat-check.sh`（492 行，纯 bash+awk，零依赖，WSL 内无 node 也能跑）、`box3-re/baseline/g3-baseline.tsv`、`box3-re/baseline/contract-server-api.members.tsv`（2730 行，sha256 `5bcc18f8…`）。

**主控亲自复跑（22:2x，WSL 内，脚本声明的标准姿势）**
```
$ wsl -d Ubuntu-24.04 -- bash -lc 'bash "/mnt/d/desktop/神奇代码岛/box3-re/tools/compat-check.sh" --quiet'
== PASS  pass=52 fail=0 skip=0  baseline=/mnt/d/desktop/神奇代码岛/box3-re/baseline/g3-baseline.tsv ==
```
含 `contract.server.fingerprint.sha256 5bcc18f8…`、`impl.coverage.missing 0`（分母 225）、`l0.moduleResolution 0/0/0`、真实地图 `cloud-4e84ee7ef626058f-imported` 908 文件 + digest `721ffb34…`。
**且这一轮是在 launcher.js 已被 A5 改掉之后跑的 → 静态契约与地图资产面未被破坏。**

### 3.1 必须记住的一条硬事实（决定 AI 接管与瘦身的边界）
真实地图在 API 对象上挂了 **86 个未声明自定义属性**（`world.Quanjujiaoyi` 之类），另有 55 个声明面被实际调用。
→ **任何 `freeze`/`seal`/收窄注入的"优化"都会直接打死老地图。** 这条要写进后续每一个改动的设计约束里。

### 3.2 闸自身的两个缺陷（我复跑时撞上，已定位，未修）
1. **探针不可用时报 FAIL 而非 SKIP**：从 Windows Git Bash 跑（或加脚本自己声明的 `--skip-http/--skip-docker`）时，http/topo 探针取不到值，drift 比较器把它当"检查项被删"，**造出 36 条假红**（`pass=19 fail=36`）。一个会狼来了的安全网比没有更安全网更糟。
2. **文档写的调用方式不通**：头注释推荐 `wsl -- bash "/mnt/d/…"`，实测被 Git Bash 路径转换吃掉（`No such file or directory`），必须 `wsl -- bash -lc 'bash "/mnt/d/…"'`。
→ 归入 Wave 1 第一个动作（改 `tools/compat-check.sh`，属我们自己的 re 目录，不碰源码仓）。

### 3.3 本轮抓到的真回归（阻塞合入）
A5 删掉 `--runtime-only` spawn 后，仓库自身的构建校验脚本 **`scripts/check-standalone.js:1501-1506`** 那条 `requirePattern` 正则锚定的是被删的 spawn 参数行。
主控复核：`grep "production ? \['--production'\]" apps/local-engine/src/launcher.js` → **0 命中**，锚已消失 → **该检查现在必 FAIL**（A5b 实测记为 25 条唯一红项）。
`scripts/` 不属任何在跑泳道，按纪律**我没改**。两个选项见 §6 决策 D4。

### 3.4 G3 目前最弱的一环
**只有 1 张可用真实图**（`playWorlds.count=1`；3 个 creator 工程全部 `releases:[]`）。L3 全层（浏览器进图 / `createSession` / `onPlayerJoin` 触发）**UNVERIFIED**。兼容性闸的分母太小，这是需求 3 真正的风险，不是体积数字。

---

## 4. 需求 2 —— AI/MCP 全自动接管 edit 端

**已存在的地基（比原计划乐观）**
- 引擎内置 15 个 zod AI 工具（实体 CRUD / 脚本写入等），走 `replica.projectTransaction()`，**MCP 可直接复用 `createEntityTools()`，不需要 LLM 参与**。
- 鉴权今天就能过：CLI Bearer 即达 create/publish/export/package/import（但**硬依赖 PG**，`server/local-player-identity.ts:915`）。
- 类型门已现成：`check-editor-types.ts:12-54` 的 `ts.createLanguageService`。

**真缺口（A8 钉死的三条）**
1. **地形零写入口**：`voxels` 只能走需登录会话的 mudb `VoxelProtocol`；`validate-project-action.ts:14-21` **禁止**客户端 project 动作携带 `voxels`；`validate-voxel-action.ts:12` 是 `// TODO` 恒 true（**无校验**）；`replica-server.ts:1602` `if (!gameState.replica.running)` → **预览在跑就不记录 voxel chunk hash**，即"改完地形必须停预览再存盘"是硬顺序。
2. **UI 树零外部面**：`uiTree` 没有任何可编程入口。
3. `ai-server.ts:70` 原文 **"Do NOT generate client scripts"** —— 出厂 AI 面是**故意**不让写客户端脚本的。

**切片 A（A8 建议先做，引擎 0 改、不扩权、2–3 天）**
`box3-map-mcp`：8 个只读工具（`engine_health/map_list/map_resources/script_list/script_read/runtime_status/runtime_events_tail`，全部映射到现有 `creator/v1`，scope 都在 9 项内）+ **唯一写工具 `script_write`**（`scripts.update`，`project-manager.js:2056-2189` 纯磁盘写，自带 `branch.headHash` revision 比对做乐观锁）+ 现成类型门。
端到端可自动判定三件事：AI 改代码 → 读 `runtime_events_tail` 断言**无 `exception`、无 `MODULE_NOT_FOUND`** → 类型不过就不许落盘。
**这已经是"AI 自动写 + 自动验收"的闭环雏形**，且完全不碰兼容性红线。
地形/UI 属切片 B（需 §6 的 D1 授权）。

**回滚能力**：工程级 revision（`branch.headHash`）已存在，可作为 AI 误操作的安全网；但**地形没有等价 revision**（见缺口 1）→ 切片 B 落地前必须先把快照补上，否则 AI 批量改地形是不可回退的。

---

## 5. 统一排期（三轮）

**Wave 0 ✅ 本轮完成**：11 篇文档落盘；prune 等价性证真；CI 门首次可运行并红绿各演示一次；play-lite 补齐门户闭环；删监督进程实现 + argv/env 逐字段等价验证；记分板 G1–G9 + 18→26 条矛盾记账；兼容性闸上线；三条新需求全部取证到位。

**Wave 1（1 周，串行、需用户放行 4 项决策）**
1. 修 `compat-check.sh` 的 SKIP/FAIL 语义与调用文档（§3.2）→ 让闸可信。
2. 处置 `check-standalone.js:1501` 正则回归（§3.3，D4）。
3. **串行测量独占轮**（负载敏感指标只此一条泳道）：eq2 复跑 → lite 栈空闲 RSS 复测（连续 3 轮 12×10s，含门户后 4 容器形态）→ creator 改前/改后各起一图实测"56 MB/图 + 0.4–3 s/图" → `tools/w5-launchcost.sh` 落盘 W5 预算日志。
4. 需求 1 档一实现（theme 三处接线 + 同步 `project-editor-dialog-ui.test.ts:152` 断言）→ 出 G8 首份实测。
5. 需求 2 切片 A（`box3-map-mcp`，只读 8 工具 + `script_write`）→ 出 G9 首份实测。
6. 把 A9 的"改动 × 必过检查项"映射表挂进 CI。

**Wave 2（需联网 + 重建，全部卡在 D1/D2）**
`rush update` re-lock（G1 全部体积主张的前置）→ 重建 1 个 play 镜像证真 G1 → 6 个包把 typescript 挪 devDep（W3 证据链已备好）→ 冷启动去同步 IO → 主 compose 出 lite 形态（D3）。

**Wave 3**：需求 1 档二（白名单设计令牌 JSON，与需求 2 的 uiTree 写入口合并设计）→ 需求 2 切片 B（terrain/ui 四工具 + 地形 revision）→ G6 真离线演练 → G7 SBOM/签名（当前全仓 0 命中）。

---

## 6. 需要用户决策（我不替你决定）

| # | 决策 | 为什么必须你定 |
|---|---|---|
| **D1** | **是否批准 A8 的 R1**：新增 loopback 内部 AI 工具端点 + terrain/ui 四个写工具（约 400 行、2 个文件） | 这是唯一能让 AI **真正全自动接管地形与界面**的路；但它给引擎开新的写入口，直接与需求 3 的兼容性红线相邻 |
| **D2** | **越权面怎么处置**：借道 CLI Bearer 到达 create/publish/export/package/import 是既有缺陷（scope 校验在 `:141` 而非入口）。A8 建议 20 行把它显式化为 `projects.manage` 并顺带修 | 这既是安全修复也是功能前置；改鉴权面属高风险，需你点头 |
| **D3** | **是否联网 `rush update` re-lock + 重建镜像** | G1 的体积真数、镜像端 19.5 MB、`/app`≈190 MB 全部卡在这；会改 `pnpm-lock.yaml`，成本高 |
| **D4** | **`check-standalone.js:1501` 正则回归怎么解**：(a) 改那 1 行正则适配新 spawn 形态；(b) 保留 `--runtime-only` 参数形态兼容旧锚；(c) 先回退 A5 改动 | `scripts/` 不属任何泳道，我按纪律没动。当前树里有一条**已知的构建校验红项** |
| **D5** | **是否把 play-lite 定为交付主线**（正式放弃 server-manager 与容器隔离），还是保留双形态；顺带：是否改主 `docker-compose.yml` 让出厂 compose 自己出 lite 形态 | W4/W6 都建议优先走主 compose 这条，play-lite 会退化成薄壳；但这是产品级取舍 |
| **D6** | **是否 checkpoint commit 到 `slim/local-deploy`（不 push）** | 现在有 **20+ 项未提交改动**（含 launcher.js +434/−251、release_channel.rs 已修编译错误），一次误操作 `git checkout .` 就全丢。我全程按纪律未提交 |
| **D7** | **是否授权一次真实进图实测**（对一次性克隆图做 `POST /internal/save-local-project` / 浏览器入局触发 `onPlayerJoin`） | 兼容性闸最大的洞就是 G3 只有 1 张图、L3 全层未证；且 A8 指出容器 IP 与 loopback 校验**理论上互斥**，不实测则整个落盘方案是猜 |
| **D8** | 需求 1 是否按"档一接线优先、档三否决"推进 | 我给的推荐基于既有 `theme` 令牌与 monkey-patch/CSP 冲突取证，但产品形态归你 |

**已被数据关掉的路（不用你再决策）**：Node 单进程 isolate 池已实测否决 —— 16 isolate 中 1 个挂死即把同伴 tick p99 从 6.25 ms 打到 127.28 ms（门 20 ms），4 isolate 并发 OOM 后 RSS 2173.6 MB 不回落；`isolated-vm@5.0.4` 非 N-API → 单二进制/Bun 路线永久关闭。

---

## 7. 下一轮串行测量清单（负载敏感指标必须独占 WSL）

1. `tools/eq2-play-tree-prune.sh` 复跑（确认 A4 结论可复现，并补 creator/player-service 两棵树的同类口径）
2. `tools/baseline.sh` + lite 栈空闲 RSS **连续 3 轮 12×10s**（含门户后的 4 容器形态；注意出厂基线本身就有 313.67 vs 328.05 MiB 两个口径并存）
3. creator 改前/改后各起一图 → 实测 **56 MB/图 + 0.4–3 s/图**（A5 的两项待证）
4. `tools/w5-launchcost.sh` 落盘 W5 内存预算日志（`runtime-memory.mjs` +81 行至今**没有一条运行日志**证明它算出了什么、与三层旧上限是否对齐）
5. A8 的 loopback-vs-容器-IP 互斥性实测（D7）
6. G6 端到端断网安装→开服→进图（当前静态核验全绿但**端到端 0 次**）

---

## 8. 文档索引

| 文件 | 泳道 | 内容 |
|---|---|---|
| `impl/GATES.md` | A6/A10 | G1–G9 × 20 项改动记分板、26 条矛盾、决策日志、本轮终局修订 |
| `impl/P0-prune-standalone.md` | A4 | prune 等价性与 88.18 MB 实测 |
| `impl/W2-ci-size-gate.md` | A2 | CI 体积门接线 + 红绿演示 |
| `impl/W6-offline-selfhost.md` | A1 | 离线/自托管静态核验 + G6/G7 缺口 8 条 |
| `impl/W4-play-lite-package.md` §11 | A3 | 登录门户补回与功能链闭环 |
| `impl/P2-1-supervisor-removal.md` | A5b | 删监督进程 + argv/env 等价验证 + 缺陷清单 |
| `impl/G3-map-compat-baseline.md` | A9 | 兼容性闸规格、契约指纹、L0–L4 |
| `plan/N1-play-page-customization.md` | A7 | 页面自定义现状与三档方案 |
| `plan/N2-mcp-ai-map-authoring.md` | A8 | AI/MCP 接管可编程面取证与切片设计 |
| `tools/compat-check.sh` + `baseline/` | A9 | 52 项检查脚本与基线 |

---

## 11. 主控轮次写回（O23–O27 + N6/N7，2026-10-18 17:0x，分支 `slim/local-deploy` = `29939f5`）

上一轮把 7 条泳道硬中断在半成品状态；本轮 6 条全部收口。定损与逐条证据在 `box3-re/HANDOVER-3.md`，本节只写门状态与数字口径。

| 泳道 | 状态 | 主控亲跑的数 | 交付物 |
|---|---|---|---|
| A MCP 写工具面 | **实** | `node --test test/*.test.js` → **178 tests / 178 pass / 0 fail** | `tools/box3-map-mcp/src/tools/index.js`、`src/errors.js`、`mock/authoring.js`；authoring 面 **12 → 37** 工具；`slim/scan/O23` |
| B/D AI 身份 | **实**（纠偏后） | bridge 28/28、security 13/13（`node --experimental-strip-types`） | `authoring.apply` 为第 10 个 scope（additive）+ `/api/creator/v1/authoring/*` 6 端点 + 审计行；`_guard.ts` 未动；`slim/scan/O24`、`slim/plan/N6` |
| C UI 事件绑定 | **实**（按决策 2 停在"不改形状"） | 49/49；生产图 blob `QmeE9eD…JHFNhV` 40,073 B / 61 节点 → 0 error 0 warning、输入逐字节不变 | `src/ui-binding.js` 10 条规则；结论：绑定只在客户端脚本正文（`ui.ts:41/:45/:16-28`、`defs.ts:816` TODO），**不扩 ui-rda**；`slim/scan/O25` |
| E DoD 机器闸 | **部**（模块绿、**未登记进工具面**） | 42/42；17 条可执行断言、46 个去重 (规则,码) 组合、54 次反例实测变红 | `src/dod.js` 57 码 + 12 步 playbook（8 步不可跳，`auditPlaybook()` 可审规程本身）；`slim/scan/O26` |
| G1b `/edit` 网关 | **实**（现网零改动） | 登录后 `/edit/e/<container>` **200 / 272,388 B**、`/_next` 13/13 命中、公网双层 **95,476 ms / earlyCloseCount=0** | `distribution/play-lite/gateway.js` 两道闸（internal 前缀拒绝 + Host/Origin 等值回写）；`/edit/app/e/*`=404 负例；O21 续章 G1b-1..5 |
| H2b 转换器 | **实**（语义层）| **48/48 pass** | 自产 canonical 升序键字节 + CIDv0 自指；体素逐 chunk 复现真箱 **64 个 CID**；`git init` 首推 `master=6fd74d3`；`slim/scan/O27` |

**四条既有闸本轮全绿**：`check-standalone.js` EXIT=0（35 modules / 377 blobs）、`compat-check.sh --quiet` **54/0**、MCP 178/178、转换器 48/48。

**本轮新增的口径变更（不许再按旧数引用）**
1. ~~MCP 只有 13 个工具~~ → authoring 面 37、readonly 面 21；但**引擎 headless 路由实测只挂载 17/22**（`ai-tool-route.ts:78-91` 未 spread `createScriptTools`），MCP 侧如实返回 `ENGINE_TOOL_NOT_MOUNTED` 而不是假装有。
2. ~~AI 身份可以给 `/internal/*` 加一把共享密钥~~ → 作废并 stash 退场（`stash@{0}`）。身份 = `bxc_` CLI Token + `authoring.apply`。
3. ~~UI 交互是能力空白、要新造事件模型~~ → 作废。事件名与枚举既有，缺的只是绑定校验门。
4. `signEncode` 的 **−16 与 +16 撞码**是引擎自身行为（`box-encode.ts:13-19` mod-32 折叠），转换器照抄不修。
5. `/edit` 公网化后 `/api/internal/**` **路由层照样命中**，只靠 loopback 判定挡 ⇒ 收紧责任在网关，不在"creator 不发布端口"这条部署不变量。

**仍待用户决策（6 条，原文见 `box3-re/HANDOVER-3.md` §3）**：mudb 闸门固化进镜像 / 公网 AI 创作面是否开门 / `box3-map-mcp` 进 `rush.json` 但从未进 `pnpm-lock.yaml`（frozen install 会红，本轮用 WSL 快照剔除该行绕开，未动仓库 lockfile）/ 是否补 2 行挂载 `createScriptTools` / 现网 player-service 256m 贴顶 / `status.ts` 的 `headlessWriteRoute:'unavailable'` 旧文案。

**下一步没开工的**：把 `map_dod_report` 与 UI 绑定门登记进 MCP 工具面（两模块均零依赖纯函数，就等这一步）；F 端到端闭环（只用 MCP 把空图做到可玩）。
