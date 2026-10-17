# GATES — BOX3 轻量化改造验收门记分板（A6 泳道）

生成：2026-10-17 ｜ 作者：A6 agent（门记分板 + PoC 结论落盘）
**刷新记录**：本文件初稿完成后，A1（`impl/W6-offline-selfhost.md`）、A3（`impl/W4-play-lite-package.md` §11）、A4（`impl/P0-prune-standalone.md`）、A7（`plan/N1-play-page-customization.md`）四条泳道的证据在 21:43–21:46 落盘，**已就地并入本表**（G5/G6/G7 与矩阵 #1/#13–#20、§3 行位、§6 矛盾 11–18、§7.2 决策 10–13）。~~仍开放：A2、A5、A8、A9。~~
**A10 终局修订（2026-10-18）**：A2（`impl/W2-ci-size-gate.md`）、A8（`plan/N2-mcp-ai-map-authoring.md`）、A9（`impl/G3-map-compat-baseline.md`）三份一手交付落盘，**A5/A5b 仍在执行**。A6 初稿里被这三条**推翻或大幅修正**的格子已就地改写（状态值 + 来源文件），原主张以 `~~原文~~ → 修订为` 形式保留在 **§9 本轮终局修订**，逐条可回溯；本节 §9 另记 **6 处"主控转述 / 既有文档口径与一手文档不符"** 与 **2 处一手文档内部不自洽**（均照实标注，不改他人文档）。**引用本表时：门状态以 §9.3 的 G1–G9 最新表为准，修订依据与"原主张 → 修订为"全在 §9.1。**
适用范围：分支 `slim/local-deploy`（`box3-local-engine`）工作区的 **20 项未提交改动**（HANDOVER §2.3 口径；本轮复核 git 实为 **22 项**，漂移说明见 §2 开头）+ `box3-re/` 取证文档。

**本文件的规则（硬）**
1. 只承认**带原文数字与来源文件路径**的主张。没有自己跑出来的 = `待证`，不是"应该能行"。
2. 一格只有四种状态：`实` / `部` / `待` / `未`；另有 `进` = **本轮对应泳道正在执行，行位已留，待其证据回填**。
3. 文档之间互相矛盾时**照实列出**（§6 矛盾清单），不选一个悄悄采信。
4. 本泳道源码目录 `box3-local-engine/` **全程只读**，一行未改。

图例：

| 记号 | 含义 | 要求 |
|---|---|---|
| `实` | **已实测** | 必须能指到原文数字 + 来源文件（本文每条都给了） |
| `部` | **部分** | 明确写出"测到了哪一段 / 还缺哪一段" |
| `待` | **待证** | 代码已在树里，但一条相关测量都没有 |
| `未` | **未开工** | 既无代码也无测量 |
| `进` | 本轮泳道执行中 | 行位保留，主控汇总后替换为前四值之一 |

---

## 1. 九个门的总览（先给结论）

| 门 | 定义（原文见 §4.3 of ANALYSIS-AND-PLAN.md） | 状态 | 关键实测数字（含来源） | 距离"过门"还差什么 |
|---|---|---|---|---|
| **G1 体积** | `docker load` 后 content 总和 ≤ 目标值；`du /app` 逐项复算 | **部** | **prune 首次拿到实测字节并证明等价**：play 镜像自带 standalone 树 **226,663,944 → 138,487,004 B，removed = 88,176,940 B（≈84.09 MiB 未压缩）**（来源 `impl/P0-prune-standalone.md` §2a/§3，宿主 9P 口径为 220,118,536 → 132,576,476 / 87,542,060 B，两个口径都记）；lite 两镜像 **444,381,911 B = 423.8 MiB**（−58.1%，`impl/W4-play-lite-package.md` §4.3），**补回门户后三镜像 531,307,786 B = 506.7 MiB（−49.9%）**（`impl/W4-...md` §11.5，catalog `size` 字段口径）；字体第二副本真删 **省 22,949,789 B**（`impl/W3-fonts-and-prod-deps.md` §2.3，对象是目录副本非镜像）；**A2 新增：CI 体积门本轮首次跑通** —— 真实出厂 catalog 打 `ratchet` 档 **exit=0 全绿**（六项 + 合计 `1,060,646,139 B` 逐行 `+0.0% OK`），同一 catalog 打 `transition`（−40%）档 **7 项违规、exit=1、超标 +66.7%**（`impl/W2-ci-size-gate.md` §2 绿 1 / 红 (a)），`node --test scripts/check-image-budget.test.js` → **19 tests / 19 pass / 0 fail**、`--self-test` 4 场景全 PASS exit 0 | **一次都没重建过镜像**。三项 P0 目标（≤550 MiB / ≤1.4 GB / ≈190 MB）全部 `UNVERIFIED`；`−154 MB/镜像` 的原主张**已被 A4 收窄**为 **88,176,940 B 实测可达**，差额按 A4 §4 逐族核对属**结构性够不着**（AMP **4 MB → store 命中 0 B**、babel 主张 31 MB → store 只有 **4,478,924 B**，大头是 `next/dist/compiled/*` Next 内建非 store 条目；sql.js debug **22.7 MB** 与 isolated-vm、后端 typescript 副本 **~24 MB** 在 `/opt/game-server` 后端树、本 eq2 只挂 standalone 故 `trimmed=0`；swc 实测 **50,398,488 B** 反比主张 48 MB 多约 2 MB），见 §6 矛盾 11；被 `pnpm-lock.yaml` 未 re-lock 卡死（§5 阻塞链）；**A2 遗留**：`contentBytes` 半边要靠 `docker image inspect`，`verify.yml` 不建/不 load 镜像 → 该项在 CI 里**永远 SKIP**，真按 content 阻断须挂 `release.yml`（W2 §5 U3，不在 A2 所有权内）；门与计划书 P0 目标不是同一个数（门 `transition` 合计 **636,387,683 B = 606.91 MiB** vs 计划书 **≤550 MiB**，W2 §3.2 第 3 条 + U8） |
| **G2 运行** | `tools/baseline.sh` 空闲总 RSS ≤ **320 MiB** 且 TTFB 中位 ≤ **7 ms** | **部（有条件通过）** | 出厂栈 **313.67 MiB**（12 样本均值，`restart-during-sample: NONE`，来源 `E-runtime-baseline.md` §1）**≤ 320 达标**；TTFB JS 中位 **6.9 ms**（区间 2–11 ms，来源 同上 §5）**≤ 7 达标**（**只剩 0.1 ms 余量**）；lite 栈空闲 **156.88 MiB**（来源 `impl/W4-play-lite-package.md` §4.2 run3） | **同一时刻 W4 量到出厂 328.05 MiB，> 320 门** → 两个口径互相矛盾（§6 矛盾 3），门是否通过取决于哪次采样；lite 侧 **TTFB 从未测过**；**补门户后的 4 容器空闲 RSS = UNVERIFIED**（A3 按纪律未测，`impl/W4-...md` §11.6 #1；只给出"门户出厂同刻实测约 10.43 MiB、预期增量小"的**推断**，不可当数）；`runtime-memory.mjs` 的实测预算与三层旧上限对齐**一条日志都没有** |
| **G3 功能** | 「起床战争」导入 → 开放 → 浏览器进图 → 脚本 `onPlayerJoin` 触发 | **部（断在最后一厘米，但登录链已通）** | **A3 已把"真实玩家自助注册"打通**（全程**不带** `x-box-player-auth-key`，密钥只在门户容器进程内）：`/p/<publicId>` 未登录 → **307** → `/api/player-login/start` → **302** 到门户 4125（带 `transferState`/`transferChallenge`）→ 门户 `POST /api/auth/register?...&source=play` **201** → play 回调 **303** + `Set-Cookie: box_local_player_session` → **`GET /p/cloud-4e84ee7ef626058f-imported` http=200 size=149594**；负对照：绕过门户直连 player-service 注册 = **401 `AUTH_API_KEY_INVALID`**（来源 `impl/W4-play-lite-package.md` §11.4）；既有链：`/api/health-check` `{"status":"ok","runtime":"ready"}`、`/api/play-worlds` 返回「起床战争」、`createSession` **202 `RUNTIME_STARTING` → 200**、冷重启 `attempt=2 http=200 elapsed=7s`、`docker top` 见 `ivmp-process-entry` 子进程 UID 1000（§3.3/§3.5）；prune 后树的 **5/5 路径 status/bytes/ck 逐项一致**（`impl/P0-prune-standalone.md` §2c，**但注意**：其中 `/api/play-worlds` 只有 `200 / 13 B`（临时容器未挂 `play-worlds`，返回空列表）→ 等价性覆盖的是"静态资源 + 无数据端点"，**不含真实地图渲染**）；**A9 素材盘点**：唯一可用图 `cloud-4e84ee7ef626058f-imported`「起床战争」v1.0.1 = **908 文件 / 27,992,660 B**（`du -sb`），manifest sha256 `85f95434…`、世界目录 digest `721ffb34…`、含 `onPlayerJoin` 的脚本 blob **2 个**（主脚本 **452,046 B**）；`/api/play-worlds` 真实响应 **200 / 439 B**、sha256 `26158180…`、`playEnabled:true` = **1**、字段 **14 键**；3 个 creator 工程（起床战争工程 **2969 文件 / 68M**、混沌神域 **658 / 38M**、`yunhai-xiantu` **446 / 75M**）全部 `releases: []`（来源 `impl/G3-map-compat-baseline.md` §1.2 / §4.2） | **仍未做**：真浏览器渲染客户端、建立 WebSocket 入局、`world.onPlayerJoin` 回调触发（W4 §6 UNVERIFIED #1 + §11.6 #2「curl 走协议但未开浏览器点 UI」）；`.boxplay` 自助导入未跑（§11.6 #5）；导入→开放这一段只有"已存在的地图被列出并play成功"的证据，**没有一次真正的导入动作**；**A9 新增两条硬事实**：① **G3 目前只有 1 张可用图**（`map.playWorlds.count = 1`，另 3 个工程全 `releases: []` 进不了 play）→ 单张图压不起"各个功能都正常"这句话，**样本量本身是风险**（§6 缺口 1）；② **L3 全层 UNVERIFIED**（`GET /p/<publicId>`、`createSession`、首屏字节校验和、`onPlayerJoin` 触发证据**一项都没跑出数**，§6 缺口 2）；L1 日志判据本轮**样本无信息量**（play/creator `docker logs` error 行数 = 0、join = 0，容器刚重启，§6 缺口 4）；L0 的 require 干跑是**静态解析非真跑**（WSL 内 `node: command not found`，§6 缺口 5） |
| **G4 契约** | ~~398 个服务端可调用全部有实现~~ + 独立 `box3-pack` 产物被出厂 reader 接受 → **A9 把锚改为契约指纹**：**① `contract.server.fingerprint.sha256` 与基线逐字节相等 ② 兼容检查脚本 0 FAIL ③ `.boxplay` 被出厂 reader 读回** | **部（锚已钉死，静态半边首轮全绿）** | **A9 首轮实跑**：`impl/G3-map-compat-baseline.md` §4.2 → `== PASS pass=52 fail=0 skip=0 ==`（基线 **56 个 key**），指纹 `sha256 = 5bcc18f8c8434ca4b73bdefaa84861ecab12d9c9c4701d096a79336676352865`，清单 `box3-re\baseline\contract-server-api.members.tsv` **2730 行**（本泳道复算 `cut -f1 \| uniq -c` = method 98 / ctor 52 / arrow 204 / accessor 23 / index 10 / callsig 11 / prop 1007 + other 1325 = 2730 ✅）；检查器 `box3-re\tools\compat-check.sh` 全量 **10.032 s**、`--skip-http --skip-docker` **1.557 s**；**红绿自测**：篡改 4 项基线 → **4 项准确报红、exit=1**，原样重跑 → PASS exit 0（§4.3）；**口径已钉死**：~~398 这个数从未逐项审计过~~ → 398 **精确可复现**（方法式 183 = method 98 + ctor 52 + get/set 23 + 索引签名 10；箭头式 215 = arrow 204 + callsig 11；属性 1234 = prop 1007 + arrow 204 + accessor 23）**但语义可调用只有 313** = method 98 + arrow 204 + callsig 11（52 个 constructor 是 `new` 位点、10 个索引签名不可调用、23 个 get/set 按属性读写**且在 398 与 1234 里重复计了一次**）；静态实现覆盖 `impl.coverage.missing = 0`（分母 **225** distinct pairs、host 豁免 **14**、impl 文件 **13**）；客户端声明面**宣称 32 / 实测 30**（method-style 21 含 ctor 11 + arrow-style 9）→ 差 2 **UNVERIFIED** | **`.boxplay` 往返 = 0 次**（G4 后半，需能跑 import 的栈，A9 §6 缺口 3）；**两条必须进设计的实测事实**：① 真实地图在 API 对象上挂了 **86 个未声明自定义属性**（`world.Quanjujiaoyi`、`player.wearables`…；含假阳性，**86 只当量级**）、**55 个声明面被实际调用**（可信下限）→ 任何 `Object.freeze`/`seal`/Proxy 白名单/收窄注入会**直接打死老地图**；② 10 个"类型为具名函数别名的属性"（`log: GameLoggerMethod;` 类）被 398 口径**漏掉**（可调用面其实还有下限外的项）；客户端 DTS 断链是 **2 条 include 死 1 条**（~~include 指向 0 命中的旧路径~~ → `src/engine/script/apis/*.ts` 不存在、`../../internals/schema/api/common.ts` **存在**，`git ls-files` = 1），**修 1 行**即可再生成（§2.5 / §7-#4） |
| **G5 安全** | 默认 profile 下无容器挂 `docker.sock` / 无常驻 `user:"0:0"` | **部（lite 过、出厂不过）** | lite 补门户后 **仍是零特权**：常驻容器 **4**、宿主端口 **4 且全 127.0.0.1**（`ss -ltnp` 原文 4121/4124/4125/4132，`any non-127.0.0.1 published port in lite stack? -- OK: all published ports bound to 127.0.0.1`）、**`docker.sock` 0 处**、**常驻 root 0 个**、新增门户 `User=node Readonly=true CapDrop=[ALL] Privileged=false` + `pull_policy: never`（来源 `impl/W4-play-lite-package.md` §11.3）；原 3 容器版数据同样成立（§3.6 inspect 原文 `Config.User=[node]`、`id -u/-g → 1000:1000`；出厂对照 `server-manager-1 Config.User=[0:0] Binds=["/var/run/docker.sock:..."]`、`0.0.0.0:3130`，§4.1 表 7→3、9→3、cap_drop 覆盖率 5/7→4/4） | 门只对"默认 profile"成立，**出厂主 `docker-compose.yml` 一行未改**（HANDOVER §3 第 7 条）→ 今天过门的是旁路 lite 包不是产品本体；lite 仍有 **1 个一次性 `play-storage-init` `Config.User=[0:0]`**（`network_mode: none` + `read_only` + `cap_drop ALL`，属可解释但必须写进交付说明）；**A3 已复测"加门户后"这一格 = 通过**（4 容器口径），但**计数从 3 变 4**，所有引用"7→3 / 9→3"的地方必须同步（§6 矛盾 13） |
| **G6 离线** | 断网环境完成 安装 → 开服 → 进图（`BOX3_RELEASE_CDN_URL` 指内网） | **部（静态/分支级已实跑；端到端 0 次）** | **A1 已交 `impl/W6-offline-selfhost.md`**：`bash -n` ×3 全 `0`、`node --check` ×2 全 `0`、`tauri.conf.json` JSON parse OK；**关键发现：`release_channel.rs` 的 +261 行根本编不过**（`rc.rs:93`、`:111` 两处 **E0277** `?` 用在返回 `bool` 的 `valid_mirror_base()` 里，该函数在 `:44`）→ A1 已修并跑通该模块 **4/4 单测**（`test result: ok. 4 passed; 0 failed`，并行连跑 5 次全 PASS）；**A10 复核源码现状**：`box3-local-engine/apps/manager-core/src/release_channel.rs:93` 现为 `let Ok(port) = port.parse::<u32>() else {`、第二处现为 **`:113`**（A1 引的 `:111` 是**修复前**行号；两处各 +2 行 → A1 引用的下游行号整体 +4，如 `release_base()` A1 记 `:151-157`，现实测 **`:155-160`**，文件现 360 行）；`validDownloadBase()` 策略矩阵实跑（`optin+pinned http-ROUTABLE => false`，明文公网即使钉死也拒）；**三层判定一致**（`release_channel.rs:44` / `build-image-downloads.js:96` / `install.sh:95`，ACCEPT/REJECT 逐条对齐）；`install.sh:136-164` 分支实跑 **CASE A exit=1 / CASE B exit=0**。既有旁证：lite 起栈 **全程未联网未 `--pull`、`real 0m13.508s`**（`impl/W4-...md` §3.2） | **端到端断网演练 = 0 次**（A1 §5-2 自陈）；**8 条 G6 缺口**（G6.1–G6.8），其中 2 条要命：G6.1 编译错（已修但**整 crate `cargo check --offline` 因离线缓存缺 `tar`/`urlencoding`/`zip` 三个 crate 而 exit=101 → 整 crate 集成 UNVERIFIED**，504 crate 缓存里没有这三个，按纪律未 `cargo fetch`）、**G6.2 `bootstrap.sh` 与 `server/install.sh` 的 opt-in 口径不一致**（前者只看 `BOX3_RELEASE_CDN_URL`，后者额外要求 `…_ALLOWLIST` 精确钉死否则 exit 1 → `curl bootstrap\|bash` 指内网会在内层挂）；G6.3 `server-manager-rust` 的 `release_base()`（A1 记 `:151-157`，现 `:155-160`）**恒返回硬编码 CDN（返回类型是 `&'static str`），完全不认自建镜像**（消费者 `server-manager-rust/src/platform/configuration.rs:535`、`http/commands.rs:473,478`）；G6.4 桌面前端写死 base（`deployment-manager/src/utils/releases.js:28`）+ WebView fetch（`src/infrastructure/releases.js:7`）；G6.5 CSP 不放行内网主机；G6.6 `server/install.sh:161` 默认写死（可覆盖）；G6.7 `latest.txt` 缺失 fail-loud；G6.8 linux 默认归档名写死 0.2.0 |
| **G7 供应链** | 每个归档带 sha256 + size + 源提交 + SBOM + 签名 | **部（按门内 5 要素 = 3 绿 1 黄 2 红；A1 另把"digest 钉死"计为第 7 要素 → A1 原文写"3/7 具备"）** | **A1 §3 逐要素定性 + `path:line`**：sha256 达标（`split-image-archive.py:126` + 归档名嵌 sha `:129` + `server/install.sh:169,176,189,206` 下载后复算 + `verify.sh` `sha256sum -c`）、size 达标（`:127` + `build-image-downloads.js:158-159` + `install.sh:171,210` `wc -c == expected_size`）、digest 钉死达标（`build-image-downloads.js:144-151` 逐镜像 `sha256:<64hex>`）、**源提交 = 部分**（`split-image-archive.py:69` 记 `sourceRevision` 但**缺省 `'unknown'`**，`validateCatalog`（`build-image-downloads.js:125-166`）**不校验它**）；升级期实测：**6 个 tar.gz 合计 1,060,646,139 B，sha256 与 catalog 双校验 6/6 VERIFIED**（`ANALYSIS-AND-PLAN.md` §1） | **SBOM 缺**：全仓 `scripts/.github/apps/common` grep `sbom\|syft\|cyclonedx\|spdx` = **0 命中**（原文 `No matches found`）；**签名/真实性 缺**：grep `cosign\|sigstore\|minisign\|gpg\|signature\|attest\|in-toto` = **0 命中**；**provenance/attestation 缺**：5 条 workflow（`package-server` / `player-launcher-release` / `release-branch-created` / `release` / `verify`）**无一步骤**；A1 明确点出后果：**`server/verify.sh` 只校完整性不校真实性（`:5-9` 仅 `sha256sum -c`），SHA256SUMS 本身未签名 → 镜像主机被控者可重算 SHA256SUMS 悄悄替换归档**；A1 无法产出可验物（§5-3：仓库根本不存在 SBOM/签名环节）→ **G7 从 3/7 → 5/7 只能靠排期**（决策 D3） |
| **G8 页面（新增）** | play 页面自定义改造**不得破坏现有地图渲染** | ~~未开工~~ → **部（取证完成，方案待批：档一接线优先、档二待评估、档三否决；代码 0 行）** | A7 已把"锁死在哪一层"查实：版式与配色烤在 `apps/game/pages/index.tsx` 单文件 styled-jsx（`<style jsx>:1491` 起一路到 `:2900+`；`.playerGrid:1663,2593`、`.card:1826`、`.cover:1853`），实下证据 `GET /` HTML **51,535 B**、类名 `jsx-58b7e53ea0fd451e`（来源 `plan/N1-play-page-customization.md` §1.1/§1.2）；**现成扩展点已存在**：`theme:'sunset'\|'ocean'\|'forest'\|'violet'` 已持久化并**已写进发布 manifest**（`project-manager.js:2442 theme: metadata.theme \|\| 'sunset'`），只是 play 端没读（§1.3）；**A10 逐字复核源码（只读）**：`:2442` 原文即 `theme: metadata.theme \|\| 'sunset',`（其上下文 `:2437 projectName / :2438 author / :2439 description / :2440 cover / :2441 loadingCover`）；赋值确为**自动轮询** `project-manager.js:1118 const themes = ['sunset','ocean','forest','violet']` → `:1127 theme: themes[listProjects().length % themes.length]`；`play-worlds.ts:22` 起的读盘字段清单（`:37 description / :38 cover` 等）**无 `theme`**，`pages/index.tsx` 全文 grep `theme` = **0 命中**；`play-admin.ts:858` `const protectedFields = ['name','author','description','cover','loadingCover']` → `:859-861` 命中即抛 **"游玩端不允许修改地图封面、标题、作者或简介"**（服主侧**主动禁止**）；`creator-cli-policy` 无关；回归硬断言已存在：`server/project-editor-dialog-ui.test.ts:152` 硬断言 `.playerGrid{grid-template-columns:repeat(auto-fill,minmax(208px,224px));justify-content:start}` → 改栅格**必连带改这条断言**（N1 §4.2） | 零代码零回归。基线口径已有：认证后 `/p/<publicId>` = **200 / 149,594 B**、首页 wire **315,903 B**。风险点已标注：给 manifest 增 `pageConfig` 键**是否触碰 `permissionHash` 校验 = UNVERIFIED**（`plan/N1` §6-#6，生成处未定位），且档一/档二都要**重建镜像**（§7-#1）→ 与 G1 共用同一条 re-lock 阻塞链；档一最小切片 = **4 文件 ~40–80 行**（N1 §5，不新增服务/不碰 Postgres/不需 re-lock，但**要重打 Next standalone bundle**）；N1 §6 另有 6 条 UNVERIFIED（含 `>8 MB destroy` 落点、creator 弹窗是否已暴露 theme） |
| **G9 headless（新增）** | AI/MCP 接管地图开发链路可 **headless 跑通** | ~~未~~ → **部（既有地基比记的厚得多；真缺口换成"地形/UI 无服务端写入口"；端到端 0 次）** | ~~缺口已取证：CLI token 能力集 9 项封顶…**不含 create/publish/export/package/play-import**；这 5 个端点只认浏览器会话 Cookie~~ → **A8 源码级推翻**：证据链已逐字复核（本泳道只读源码核对，行号全对）——`apps/game/server/player-service-client.ts:87-89`（`Authorization` 以 `Bearer ` 开头就转发为 `X-Box-Creator-Authorization`）→ `apps/game/pages/api/player-internal/runtime-identity.ts:21-24`（该头 `startsWith('Bearer ')` 走 `resolveCreatorCliTokenIdentity`，否则走 Cookie）→ `apps/game/server/local-player-identity.ts:923`（SQL **同时 SELECT `u.creator_permissions`**）→ `apps/game/server/creator-api-security.ts:105`（浏览器路由查的是**用户级 `creatorPermissions`**）；**`:141` 才是 9 项 scope 的校验处**，而它只在 `allowAuthenticatedCreatorCliApi` 里被走 → **任意 scope 的合法 `bxc_…` Bearer 都能借同一身份链行使该账号的全部 UI 级创作权限**，create/publish/export/package 四条路由**今天就能 headless 打通**（`play-admin/import` **从来不是 Cookie 门**，而是 `allowPlayLibraryAdmin` = `Authorization: Bearer $BOX_PLAY_ADMIN_TOKEN`）。**现网只读反证（无凭据探针）**：bogus Bearer 打 `POST /api/local-projects/nope/publish` → `401 {"code":"AUTH_REQUIRED","message":"请先注册或登录账号"}`（浏览器门文案），打 `GET /api/creator/v1/projects` → `401 {"code":"AUTH_REQUIRED","message":"CLI Token 无效或已撤销"}`（CLI 门文案）——两条不同文案互证"同一身份链、两个不同判定门"。**既有地基（记分板此前完全没记）**：引擎**已内置 15 个 zod AI 工具**，`services/game-server/src/edit/ai/entity-tools.ts:31-812` 经 `edit/edit-server.ts:192-202`（`this.ai = new AiServer({... replica, state, logger ...})`）挂载，走 `replica.projectTransaction()` → `RDATransaction.commit()` 写**与浏览器同一棵 `EntitiesTreeRDA`**，**不依赖 LLM**（`createEntityTools(replica, state, gameId, logger)` 可直接复用）；本泳道实测 `grep -c ": tool({"` = **15**（`createEntityTools` 10 个 + `createScriptTools` 5 个），**其中体素写入 0 个、UI 0 个**（全文 `voxel` 命中数 = **0**，唯一相关是 `:737 AssetType.VOXEL_MODEL` 资产类型常量）；内置 AI 系统提示 `edit/ai/ai-server.ts:70` 原文 **"Client Scripts: The entry file is 'clientIndex.js'. Do NOT generate client scripts. The client API is currently not supported."**；已 headless 可用的能力集 = `creator/v1` 9 scope（`creator-cli-policy.ts:5-15` 实测逐项：projects.list / resources.list / scripts.read / scripts.update / storage.read / storage.write / runtime.view / runtime.control / scene.capture）+ `scripts.update`（**纯磁盘，不开运行时也能写**）+ `storage.write` + `runtime.control` + `play-admin/*` Bearer；类型门**仓库已有**：`apps/game/scripts/check-editor-types.ts`（`ts.createLanguageService`，对 20+ 段真实作者代码断言 `diagnostics()===0` **并做反向断言**） | **真阻塞（不再是鉴权）**：地形（voxels）与 UI 树（uiTree）的**服务端可编程写入口为零** —— 体素只能走 mudb `VoxelProtocol`（需带 runtime identity 的编辑器会话，且 `checkProjectActionSequence` **明确禁止** project 级 voxel 动作，`validate-project-action.ts:14-21`）、`entity-tools.ts` 无 UI 工具、`creator/v1` 9 scope 无 UI → 唯一解是改造项 **R1**（`createServer.ts:557-633` 同段加 `/internal/ai-tool` + 4 个同族工具 ~400 行）。**鉴权侧最小改动 ≈20 行**（新增 1 个 `projects.manage` scope + 5 条路由各 1 行），A8 建议**用它同时修掉越权面**（D2 之②）。**这条借道本身是越权面，不是便利**：9 项 scope 的"最小权限"承诺在这 5 条路由上不成立，一个只给 `projects.list` 的只读 token 也能发布/删图。**端到端 = 0 次**：用真 `bxc_…` token 打 publish 是否 2xx = **UNVERIFIED（U2）**，因签发 token 属写操作（`player-admin/players/[subjectId].ts` 的 `create-cli-token`）本轮禁止；借道路径还额外**硬依赖 PostgreSQL**（本泳道复核 `local-player-identity.ts:915` `if (!database) throw new Error('玩家身份服务需要配置 PostgreSQL')`）；`/internal/*` 是否被 `localOnly` 403（U1）、真玩家进图（V4/R3）、`scene.capture` 要浏览器在场授权（`creator-scene-session.ts:111-125`）均 UNVERIFIED |

---

## 2. 矩阵：每条改动 × 每个门

改动清单按 `HANDOVER.md` §2.3 的 20 项逐条列（10 新增 + 10 改动）。**注意计数已漂移**：本轮复核 `git status --short` 得 **11 个 ` M ` + 11 个 `??` = 22 项**（A10 于 2026-10-18 复跑 `git status --short | wc -l` → **22**，`11 ??` / `11 M`，与 A6 初稿一致）—— A2 在执行中新增了 `scripts/check-image-budget.test.js` 并改了 `.github/workflows/verify.yml`，A1 修了 `release_channel.rs`（原已计）。下表仍按 HANDOVER 的 20 项骨架，新增项以 #2 行的注记体现。**A2/A8/A9 三份一手交付现已全部落盘**（`impl/W2-ci-size-gate.md`、`plan/N2-mcp-ai-map-authoring.md`、`impl/G3-map-compat-baseline.md`），#2/#3/#11/#12 的 `进` 已按其实测原文替换；`impl/GATES.md` 里所有引用 A8/A9 的格子见 §9 终局修订。**仍 `进` 的行：#7 `launcher.js`（A5b 正在改，本泳道未碰）。**

| # | 改动（文件 · 行数） | G1 | G2 | G3 | G4 | G5 | G6 | G7 | G8 | G9 | 证据锚点 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `scripts/prune-standalone.mjs`（新 935 行） | 实(字节)/部(镜像) | 未 | 部 | 未 | 未 | 未 | 未 | 未 | 未 | **A4 已交付** `impl/P0-prune-standalone.md`：removed **88,176,940 B 未压缩**、control/pruned **均 boot=UP 200**、**5/5 路径 status+bytes+ck 一致**、**MODULE_NOT_FOUND=0/0** → 等价成立、规则未改；缺：creator/ps/voxa 三棵树未测、content/`/app`/gz 需重建镜像 |
| 2 | `scripts/check-image-budget.mjs`（新 621 行）+ `scripts/check-image-budget.test.js`（新增，19 用例）+ `.github/workflows/verify.yml`（新增 `image-size-gate` job，10 step） | 部 | 未 | 未 | 未 | 未 | 未 | 未 | 未 | 未 | **A2 已交付** `impl/W2-ci-size-gate.md`。~~代码已在树里（不可运行）~~ → **代码在树里且不可运行，本轮首次跑通**：动手前该 CLI **连加载都 SyntaxError** —— 错误源在它 import 的共享库 `scripts/lib/budget.mjs:146-150` 的 JSDoc 里写了 `**/`，**提前闭合块注释**，直到 `:180 const compiled = new RegExp(\`${source}$\`)` 才炸（原文 `SyntaxError: Unexpected identifier '$'` / `EXIT=1`，另有 4 行最小复现）；第二个缺陷：裸跑默认配置路径**算错一层**（`REPO_ROOT = join(import.meta.dirname, '..','..')` → 解析到仓库**外**的 `D:\desktop\神奇代码岛` → `体积门无法运行：缺少文件：…\common\config\box3-image-budget.json`，`EXIT=2`）；第三个缺陷：黑名单表**无任何消费者**（注释点名的 `check-image-blacklist.mjs` 文件不存在）。修完后四连：**绿** `--tier ratchet --require size` 真实 catalog → 六服务 + 合计 `1,060,646,139 B` 全 `+0.0% OK`、**exit=0**；**红(a)** `--tier transition` → **7 项违规 / exit=1 / +66.7%**；**红(a′)** 回放上游 `+120,139,437 B`（2,736,210,446 → 2,856,349,883）→ 7 项违规 exit=1；**红(b)** 合成镜像树黑名单 → **10 项违规 exit=1**；`--self-test` 4 场景全 PASS（+1 MiB 垃圾必红）、`node --test` **19 tests/19 pass/0 fail**。既有 `verify` job 一行未动（`jobs.verify.if` 与 `on.push.branches` 保持）→ **门不依赖 rush**。**仍 `待证`/遗留**：GitHub 真实运行（U1，禁 push）、`contentBytes` 半边需 `docker image inspect` 而 `verify.yml` 不建/不 load 镜像 → **真按 content 阻断须挂 `release.yml`（U3，非 A2 所有权）**、`scripts/repo-tasks.js` 无所有权 → **`rush test` 目前不会跑该测试**（U4，补 1 行）、既存 `release-context.test.js` CRLF 红测会连带把 `verify.yml` 打红（矛盾 17）、node 22.x 未实跑（U6，`.node-version`=22.17.0 而 A2 本机 24.18.0）、门内 `transition` 合计 **606.91 MiB** ≠ 计划书 **≤550 MiB**（U8）；**G7 侧 A2 未产出任何供应链证据**，但 `.github/workflows` 归属与 A1 的 D3（SBOM/签名/attestation）是**同一块冲突面**，排期时须一并定（§7.2 #12） |
| 3 | `scripts/lib/budget.mjs`（新 320 行） | 部 | 未 | 未 | 未 | 未 | 未 | 未 | 未 | 未 | 同 #2：`node --check` → `BUDGET_LIB_OK`。**A2 复核：这一批新 `.mjs` 里只有它中招**（`prune-standalone.mjs` / `subset-fonts.mjs` / `tag-images-from-catalog.mjs` / `runtime-memory.mjs` 全部 `node --check` OK）→ 整条 W1/W2 产物链此前是死的；原本**无人调用**的 `globToRegExp` / `walkTree` / `subtreeBytes` 三个 helper 现被 A2 的黑名单子门复用 |
| 4 | `scripts/subset-fonts.mjs`（新 359 行） | 部 | 未 | 待 | 未 | 未 | 未 | 未 | 待 | 未 | 子集化真跑：ChillRound **7,925,528 → 6,047,012 B（−23.7%）**、仅拉丁 **12,356 B（−99.8%）**、MiSans **−43.8%/−42.5%**（`impl/W3-...md` §3.3）；**发布子集 = UNVERIFIED**（§3.3 末） |
| 5 | `scripts/font-manifest.json`（新） | 部 | 未 | 待 | 未 | 未 | 未 | 未 | 待 | 未 | 逐格式引用证据链：中文 web 只加载 woff/woff2、`DoulosSILR.ttf`+KaTeX ttf 是 live（`impl/W3-...md` §3.4）；0 引用可删 `MiSans-Regular.ttf` **8,073,152 B**、Rusty-only 挂起 **12,928,712 B** |
| 6 | `apps/local-engine/src/runtime-memory.mjs`（新 401 行） | 未 | 待 | 待 | 未 | 未 | 未 | 未 | 未 | 未 | **无一条运行日志**：它算出什么数、与 voxel 阶梯/`mem_limit`/`--max-old-space-size` 三层旧上限是否对齐，全部 `UNVERIFIED`（HANDOVER §3 第 12 条）；`tools/w5-launchcost.sh` 输出未落盘 |
| 7 | `apps/local-engine/src/launcher.js`（改 +81 行） | 未 | 待 | 进 | 未 | 未 | 未 | 未 | 未 | 未 | +81 = 内存预算改实测（`src/S2-runtime-hotpath.md` §3.3 方案），验证缺；`launcher.js:1091` 递归监督进程**仍在**，A5 在同文件执行中（不得回退 +81） |
| 8 | `apps/local-engine/src/build.js`（改 +7 行） | 部 | 未 | 待 | 未 | 未 | 未 | 未 | 待 | 未 | `removablePaths` 加删 `.next/server/chunks/static`；真删真量 **235,604,933 → 212,655,144 B（−22,949,789 B）**，7 个被删文件与保留副本 **md5 逐一相同**（`impl/W3-...md` §2.2/§2.3）。缺：重建镜像后的 `/app` 复算 + 中文渲染回归（§4 第 5 条） |
| 9 | `services/game-server/package.json`（typescript → devDeps） | 部 | 未 | 待 | 未 | 未 | 未 | 未 | 未 | 未 | 五路 grep 运行时命中 **0**（src/dist/整个 node_modules/`@box/*`，`impl/W3-...md` §1.1）；出厂镜像内 typescript 实占 **19,492,846 B**（§1.2）。缺：**另有 6 包仍 prod 声明它** + 未 re-lock → **镜像端 −19.5 MB = UNVERIFIED** |
| 10 | `scripts/tag-images-from-catalog.mjs`（新 268 行） | 未 | 未 | 待 | 未 | 未 | 待 | 部 | 未 | 未 | tag 机制本身有成功先例：升级期"6 个版本 tag 的 `Id` 与 catalog 完全一致"（`ANALYSIS-AND-PLAN.md` §1）。缺：新脚本自身一次真实运行输出 |
| 11 | `common/config/box3-image-blacklist.json`（新 106 行，10 条规则） | 部 | 未 | 未 | 未 | 未 | 未 | 未 | 未 | 未 | ~~归 A2（红/绿各一次自测待产出）~~ → **A2 已交**：此前该表**零消费者**，A2 把黑名单子门实现进自己拥有的 `check-image-budget.mjs`（`loadBlacklist` / `scanBlacklistTree` / `runBlacklist`，只吃 `glob`），红 (b) 10 项违规 exit=1、合规树 `trees/creator/` 单独扫 exit=0；命中按**目录单元折叠**（一个 `.pnpm/@swc+core@1.4.13` 只算 1 项）；`maxEntries: null` = 只报告、`byService` 覆盖为 0 即红。**A2 只标注未改的两个缺陷**：① 各规则 `measured` 加总 ≠ 预算表 `basis.measuredRemovableBytes`（creator 145,230,998 vs 138,393,952；**play 132,277,187 vs 声称 138,393,952，声称值比自身规则总和还大 +6,116,765**；ps 101,451,631 vs 88,497,820）且 **play 与 creator 的 `measuredRemovableBytes` 完全相等**（都 138,393,952，差值 12,953,811 恰是 Monaco 大小）→ 高度疑似复制粘贴；② 每条规则的 `glob` 与 `find` 是**两份真相**，`find` 无任何代码消费（已降为文档字段）；③ 注释声称的"W2 在现役镜像内实测"**不是 A2 做的**（禁 Docker，一次没扫真镜像）→ U2 待 A4 用 `--trees-dir` 证 |
| 12 | `common/config/box3-image-budget.json`（新 74 行） | 部 | 未 | 未 | 未 | 未 | 未 | 未 | 未 | 未 | 同 #11：A2 新增 **`ratchet` 档**，数值 **= 配置里已有的 `basis.observed` 原值**（12 格全等，程序断言 `ratchet ≡ observed`），**未发明任何一个字节**；`transition == floor(observed×0.60)`、`target == floor(observed×0.45)` **12/12 精确成立**且 **transition/target 12 格数值逐字节未动**（`EXISTING_TIERS_UNCHANGED= true`，因该文件是 `??` 从未提交、`git diff` 拿不到旧值 → 用改动前读到的数字做程序断言）。`aggregate archiveBytes ratchet = 1,060,646,139` = 六归档之和 ✅。**口径坑**：`aggregate.transition` 与六分项之和差 **2 B**（content `1,641,726,267` vs `…265`；archive `636,387,683` vs `…681`），两处 `measuredRemovableBytes` 见 #11；auth-portal / server-manager 的 `measuredRemovableBytes = 0` → 这两格的 −40% **只能靠换 distroless base**，与 prune 无关 |
| 13 | `distribution/play-lite/{compose.yml, .env.example, README.md}`（新 3 文件，A3 已续写门户） | 实 | 部 | 部 | 未 | **实** | 部 | 未 | 未 | 未 | 见 §1 各行原文数字（`impl/W4-play-lite-package.md` §3–§4 + **§11**）。**A3 后形态已变：3→4 常驻容器、3→4 端口（新增 `127.0.0.1:4125`）、分发 423.8 → 506.7 MiB**（**531,307,786 B**，catalog `size` 字段三项相加 `240,669,370 + 203,712,541 + 86,925,875`，A10 复算吻合 ✅；较出厂 6 归档 **−49.9%**、较 3 容器口径 **+19.6%**）→ 矛盾 ⑬ **已判定**；缺：门户后的 RSS/TTFB（A3 按纪律未测，§11.6 #1）、断网演练、真浏览器入局、`.boxplay` 自助导入（§11.6 #5） |
| 14 | `distribution/linux-amd64/install.sh`（改） | 未 | 未 | 未 | 未 | 未 | 部 | 部 | 未 | 未 | **A1 已交**：`bash -n` → `0`；`:38-44` archive-list 分支**隔离实跑 4 例**（默认无文件 → `Missing box-local-engine-images-0.2.0-linux-amd64.tar.gz` exit=1；覆盖 2 包齐 → loop OK exit=0）。缺口 G6.8：默认归档名写死 **0.2.0** 与 2026.1.4 逐服务归档不匹配（有意 legacy） |
| 15 | `distribution/server/install.sh`（改） | 未 | 未 | 未 | 未 | 未 | 部 | 部 | 未 | 未 | `bash -n` → `0`；从文件**抽取真实校验器** `valid_release_base()`（`:95-134`）喂同批 URL：明文公网 `http://203.0.113.9` REJECT、路径穿越 REJECT、`javascript:alert(1)` REJECT、**八进制补零 IP `http://010.0.0.1` REJECT**；`:136-164` 分支实跑 CASE A `exit=1` / CASE B `exit=0`。缺口 G6.6：`:161` 默认仍写死 `assets.box3.fun`（可被 opt-in+pin 覆盖） |
| 16 | `distribution/server/bootstrap.sh`（改） | 未 | 未 | 未 | 未 | 未 | **部（有致命不一致）** | 部 | 未 | 未 | `bash -n` → `0`；`bootstrap.sh:10` 注释自述的放宽口径经实跑**与内层 `server/install.sh:145-153` 不一致** = **G6.2（高）**：`curl bootstrap\|bash` 指内网会在内层 exit=1。**未改**（属策略选择，A1 留决策 D1）。G6.7：`:275-289` `latest.txt` 缺失 fail-loud（可接受） |
| 17 | `apps/manager-core/src/release_channel.rs`（改 +261 行 → A1 又修 2 行） | 未 | 未 | 未 | 未 | 未 | **部（曾根本编不过，已修）** | 部 | 未 | 未 | **硬发现**：原 +261 行有 **2 处 E0277**（`:93`、`:111` 在返回 `bool` 的函数里用 `?`）→ `cargo build` 必红；A1 修好后 `rustc --emit=metadata` exit=0、`--test` 构建 0、**4/4 单测绿**（含 `self_hosted_base_is_inert_without_the_explicit_opt_in`）。缺口 **G6.3**：`release_base()`（`:151-157`）恒返回硬编码 CDN → **server-manager 更新链完全不认自建镜像**（他人文件，仅标注）。整 crate `cargo check --offline` **失败于缺 `tar`/`urlencoding`/`zip`** → 集成 `UNVERIFIED` |
| 18 | `scripts/build-image-downloads.js`（改 +125 行） | 未 | 未 | 未 | 未 | 未 | 部 | **部** | 未 | 未 | `node --check` → `0`；`node --test scripts/build-image-downloads.test.js` → **2/2 绿**；`:107 validDownloadBase()` **不再无条件拒绝自建域名**（须 `BOX3_ALLOW_CUSTOM_DOWNLOAD_BASE=1` + 精确出现在 `…_ALLOWLIST` + 过 `:96`），G7 侧 `:144-151` 强制逐镜像 `sha256:<64hex>`、`:157-159` 强制 sha256+size |
| 19 | `scripts/release-context.js`（改 +32 行） | 未 | 未 | 未 | 未 | 未 | 部 | **部（仅 staging）** | 未 | 未 | `node --check` → `0`；`:61,67` **只有 staging 路径嵌 40-hex `GITHUB_SHA`** → production 归档无提交绑定（G7"源提交 = 部分"）。**红旗照实记**：`node --test scripts/release-context.test.js` → **1 FAIL**，原因是 `Cargo.lock` 在 Windows 以 **CRLF** 检出而断言用 `\n`；属环境差异、文件不在 A1 所有权内故未修，**LF 下是否绿 = UNVERIFIED** |
| 20 | `apps/deployment-manager/src-tauri/tauri.conf.json`（改） | 未 | 未 | 未 | 未 | 未 | **部（有拦截风险）** | 未 | 未 | 未 | JSON parse OK；`connect-src = ipc: http://ipc.localhost https://assets.box3.fun http://localhost:* http://127.0.0.1:*` → **G6.5（中）**：CSP **不放行任何内网镜像主机**，WebView 直连非回环镜像会被拦（后端 reqwest 不受 CSP 约束，走哪条 = UNVERIFIED，A1 §5-6）；`tauri build` 从未跑过 |

---

## 3. 本轮并行泳道行位（证据回来后由主控替换）

| 行位 | 泳道 | 直接影响门 | 当前格子 | 证据 / 需回填的原文数字 |
|---|---|---|---|---|
| **A1** | 离线/自托管核验 | G6、G7 | **已交付（本轮 21:46 落盘）** | `impl/W6-offline-selfhost.md`：`bash -n` ×3 / `node --check` ×2 全 0、`release_channel.rs` **E0277 ×2 已修 + 4/4 单测绿**、三层策略矩阵一致、**G6 8 条缺口表 + G7 逐要素表**（SBOM/签名 grep 全仓 0 命中）。仍缺：整 crate 编译、端到端断网演练、D1–D4 四项决策 |
| A2 | CI 体积门接线 | G1、G7 | **已交付（本轮 22:00 落盘）** | `impl/W2-ci-size-gate.md`：**动手前门根本不可运行**（`lib/budget.mjs:146-150` JSDoc 里的 `**/` 提前闭合注释 → 加载即 `SyntaxError`；`REPO_ROOT` 少一层 → 默认配置找不到；黑名单表 0 消费者）；本轮首次跑通并给出 **红/绿各多次原文**（棘轮绿 exit=0 / `transition` 红 **+66.7%** / 上游 +120 MB 重放红 / 黑名单 10 项违规红 / `--self-test` 4 场景 PASS / `node --test` **19/19**）；新增 `ratchet` 档（数值 = `basis.observed`，未发明字节）；**遗留**：`contentBytes` 须挂 `release.yml`（U3）、`repo-tasks.js` 无所有权 → `rush test` 不跑它（U4）、CRLF 红测（矛盾 17）、与计划书 ≤550 MiB 口径不一致（U8） |
| **A3** | play-lite 补登录门户 | G3、G5、G1、G6 | **已交付（本轮 21:44 落盘）** | `impl/W4-play-lite-package.md` **§11**：`CONFIG OK`、`ALL HEALTHY after 5s`、4 常驻容器 / 4 端口全 127.0.0.1、`docker.sock` 0、常驻 root 0、门户 `http=200 {"status":"ok","service":"player-auth-portal"}`、**无密钥自助注册 201 → 回调 303 → `/p/<publicId>` 200 / 149,594 B**、负对照 401、分发 **531,307,786 B = 506.7 MiB（−49.9%）**。RSS/TTFB **按其纪律留串行轮**（§11.6 #1） |
| **A4** | prune 等价与字节 | G1、G3 | **已交付（本轮 21:43 落盘）** | `impl/P0-prune-standalone.md`：removed **88,176,940 B**、两树 `boot=UP 200`、5/5 校验和一致、`MODULE_NOT_FOUND=0/0`、逐包字节精确吻合；G1 推算与不可达块（AMP/sql.js/后端 ts）已列 §4/§5。原始 stdout 在 `box3-re/tmp/eq2_out.txt` |
| A5 | 删 creator 递归监督进程 | G2、G3 | `进` | 交付文档 `impl/P2-1-supervisor-removal.md` **尚未出现**。需回填：`node --check` + 最小启动桩；**−56 MB/图 必须保持 `待证`**（56.6 MB 是同类 node 进程空闲实测值，非删前删后差值） |
| **A7** | play 页面自定义（G8 前置） | G8 | **已交付（本轮 21:43 落盘，规划非代码）** | `plan/N1-play-page-customization.md`：锁定点 `path:line`（`pages/index.tsx:934-949/1491+/2918`、`server/play-worlds.ts:22/69`）、现成 `theme` 令牌链（`project-types.ts:30` → `project-manager.js:2442` → `project-card.tsx:37`）、档一最小切片 4 文件 ~40–80 行、6 条 UNVERIFIED（含 `permissionHash` 与 `>8 MB destroy` 落点）、5 条待用户决策 |
| A8 | AI/MCP 全接管（G9 前置） | G9 | **已交付（本轮 21:55 落盘，规划非代码）** | `plan/N2-mcp-ai-map-authoring.md`：**推翻 A6 记的"五端点只认 Cookie"**（证据链 `player-service-client.ts:87-89` → `runtime-identity.ts:21-24` → `local-player-identity.ts:923` → `creator-api-security.ts:105`，`:141` 才是 scope 校验处）；**新缺口 = 地形 + UI 树的服务端可编程写入口 0 个**（`entity-tools.ts` 全文 `voxel` 命中 0、无 UI 工具；`validate-project-action.ts:14-21` 禁 project 级体素动作）；**记明借道即越权面**（只读 `projects.list` 的 token 也能发布/删图）；**15 个内置 zod 工具 = 既有地基**；给出 MCP 工具面（L1 读 10 个 0 引擎改动 / L2 改 / L3 验 / L4 发）、验收闭环 V0–V6、改造项 **R1–R9**、切片 A/B/C、7 条"今天做不到"、6 条 U（U1 `/internal/*` 是否被 `localOnly` 403、U2 真 token 打 publish 是否 2xx…）与 7 条决策 D1–D7 |
| A9 | 地图兼容性回归基线 | G3、G4 | **已交付（本轮 22:03 落盘，工具+基线已可跑）** | `impl/G3-map-compat-baseline.md`：`box3-re\tools\compat-check.sh`（**56 检查项**，纯 shell、零依赖，WSL 内 `node: command not found` 故全用 shell）+ `box3-re\baseline\g3-baseline.tsv`（**56 key**）+ `contract-server-api.members.tsv`（**2730 行**，指纹 `5bcc18f8…`）；首轮 **PASS pass=52 fail=0 skip=0**、篡改 4 项 → **4 项准确报红 exit=1**；全量 **10.032 s** / 静态 **1.557 s**；**398 数字精确复现但语义口径 313**（拆解见 §1 G4 行）；**86 个未声明自定义属性 + 55 个声明面被实际调用**；**G3 只有 1 张可用图**、L3 全层 UNVERIFIED；客户端 tsconfig **2 条 include 死 1 条**（修 1 行）、客户端 **30 vs 宣称 32**；§5 给了"改动 × 必过检查项"映射表（含 prune / launcher / typescript devDep / 字体 / lite+portal / 去 docker.sock / 冷启动去同步）；§7 列 6 条需用户授权项 |

---

## 4. 决策：P2「isolate 池 / 每图单进程化」→ **否决**

### 4.1 判据（门是计划书自己定的）

`ANALYSIS-AND-PLAN.md` §4.2 原文：**"抖动 >20 ms 就放弃 isolate 池，只做前两项。"**

### 4.2 CPU 公平性（PoC-3，16 isolate，`HANG_MODE=async`，8 核宿主，`isolated-vm@5.0.4`，`node v22.17.0`）

被殃及者（victim）的**最差 p99 抖动**，原文数字与来源文件 `box3-re/poc/out-poc3-sweep.txt`（逐条可回溯到 `out-poc3-N16-H0-async.txt` / `-N16-H1-` / `-N16-H4-` / `-N32-H8-async.txt` 的 `victim_summary` + `mainEventLoopDelay_ms`）：

| 配置（N isolate / 挂死数 H） | victim `worst_during_p99` | 门 20 ms | 宿主主循环 p50 / p99 / max (ms) | victim `worst_before_p50` |
|---|---|---|---|---|
| N16 **H=0**（无人挂死） | **6.25 ms** | 通过 | 20.19 / 22.48 / **25.56** | 1.73 |
| N16 **H=1** | **127.28 ms** | **超 6.4×** | 20.61 / 96.21 / **224.79** | 4.88 |
| N16 **H=4** | **57.8 ms** | **超 2.9×** | 20.37 / 46.2 / 110.89 | 1.94 |
| N32 **H=8** | **152.8 ms** | **超 7.6×** | 20.32 / 86.84 / 108.27 | 1.81 |

→ **单个挂死 isolate 就能把同伴的 tick 从 6.25 ms 打到 127.28 ms。** 一个 `while(true)` 挂死就足以让"同进程 N isolate"违反 G2 的毫秒级响应前提。

**两条必须诚实标注的数据问题（不掩盖）**
- **非单调**：H=1（127.28）**比** H=4（57.8）更差；`hanger_summary.worst_during_p99` 却是 H=4（3043.58）> H=1（2993.02）符合直觉。→ 结论方向不变（两者都远超 20 ms），但**"恶化倍数与 H 的关系"标 `待复测`**。
- **同配置复现性差**：`box3-re/poc/raw3/` 的 N 扫描（另一套参数 `HANG_FROM=1200 HANG_MS=2500 DURATION_MS=6000`，每 N 两个 rep）给出的 victim `worst_during_p99`：

| N | rep1 | rep2 | N | rep1 | rep2 |
|---|---|---|---|---|---|
| 2 | 6.03 | **24.04** | 12 | 8.12 | 13.07 |
| 4 | 8.92 | 18.36 | 16 | **19.85** | 13.82 |
| 6 | 4.78 | 15.11 | 24 | **49.36** | 19.38 |
| 8 | 3.76 | 15.59 | | | |

  同一 N、同一 H=1 的两个 rep 相差最多 **4.4×**（N24: 49.36 vs 19.38）；N16/H=1 在这里只有 **19.85 ms**（刚好在门内），与 sweep 的 **127.28 ms** 不可互换。**这套抖动数不可复现到 ±20 ms 级别，只能当"量级证据"，不能当"精确承诺"。**
- **按计划书原 PoC 规格（N=3, async）其实是过门的**：`out-poc3-async.txt` 两个 victim `jitter_during_ms.p99` = **8.41 / 3.07 ms**（宿主主循环 max 50.69）。但 **`HANG_MODE=sync` 立刻崩**：`out-poc3-sync.txt` 三个 isolate 全 `jitter_during_ms.p99 ≈ 2964.68 / 2965.1 / 2964.77 ms`，宿主主循环 max **3011.51 ms**。
  → **真正的否决力来自"同步宿主调用形态 + N 变大"两个方向**，而不是"N=3 就炸"。这与 `src/S2-runtime-hotpath.md` §2.2-4 的源码预判（"isolate 与宿主共享同一事件循环线程 ⇒ 一次脚本同步段超时 = 该进程全体玩家掉帧"）**一致**。

### 4.3 崩溃半径与内存（PoC-4，来源 `box3-re/poc/out-poc4.txt` 原文 JSON）

| 场景 | 原文字段 | 判定 |
|---|---|---|
| 顶层未捕获异常 | `hostAlive: true`、`siblingsHealthy: "4/4"`、`sameIsolateStillUsable: true`、`rss_MB: 56.6`、`catastrophicCallbacks: 0` | **隔离性合格** |
| 单次 OOM | `err: "Array buffer allocation failed"`、`rssBefore 56.8 → rssDuring 592.3 MB`、`peakHWM_MB: 592`、**`isolateV8Heap_MB: 0.7`**、`rssReclaimed_MB: 537.9`、`siblingsHealthy "4/4"` | **合格**（能抛、能回收） |
| **4 isolate 并发 OOM** | `launched: 4`、`rssBefore_MB: 59`、**`peakHWM_MB: 2200.7`**、**`rssAfterDispose_MB: 2173.6`**（只回落 ≈27 MB）、`finalHostRSS_MB: 2174.2` | **不合格** —— "抬上去就下不来"，且 2200.7 MB 远低于 play 容器 `Memory=4294967296`（4 GiB，来源 `impl/W4-play-lite-package.md` §3.6 inspect） |

**方法论致命点**：`isolateV8Heap_MB: 0.7` 时宿主 RSS 已 **592.3 MB** → 爆的是 **V8 堆外的 Array buffer**，`isolate.getHeapSizeSync()` / `getHeapStatisticsSync()` **看不见它**。
推论：`src/S2-runtime-hotpath.md` §3.3-2 提的"运行期用 `isolate.getHeapSizeSync()` 采样做内存闭环预算"这条路**对作者脚本 OOM 无效**；PoC-2 里也可见同一盲区（`out-poc2.txt` K=1 loaded：`v8heap_used_KB 563.1` 但 `dRSS_steady_KB 2748`）。

### 4.4 内存收益侧（唯一"P2 主张里被实测支撑的部分"，但不构成翻案理由）

PoC-2 斜率测量（`box3-re/poc/poc2-rss.mjs`，每档起一个新进程，脚本 3,982 B、40 tick，MEM=512 MB）：

| 模式 | K | `dRSS_steady_KB`（总） | `perIsolate_dRSS_KB` |
|---|---|---|---|
| bare（空 isolate） | 16 | 19,692 | **1,230.8** |
| loaded（跑作者脚本） | 16 | 72,532 | **4,533.3**（≈4.4 MiB） |
| loaded | 1 | 12,844 | 12,844（基座首 isolate 最贵） |

→ 同进程 K isolate 的**边际内存确实低**（K=16 合计 ≈71 MiB），比"每图 150–200 MB"小一个数量级，`ANALYSIS-AND-PLAN.md` §4.2 的 "15–25 MB/图" 甚至偏保守。
**但这救不了这条路**，因为：(a) 测的是 **3,982 B 合成脚本**，不含真实地图的 mudb 缓冲/体素镜像缓冲；(b) §4.3 证明**堆外分配不受 isolate 配额约束且 dispose 不回落**；(c) CPU 侧已按门否决。

### 4.5 冷启动侧（PoC-1，来源 `box3-re/poc/out-poc1.txt`）

V8 code cache 对"第 2+ 图"的帮助**没有拿到**：`delta_pct.total = −2.6%`（NOCACHE p50 13.96 ms → CACHE 13.596 ms），且 `cachedData produced = -1 bytes (kind=[object Object])`。分项 create −83.9% / compile −76.3% 好看，但 **run +3.1% / firstCall +6.5% / total −2.6%**。
→ `src/S2-runtime-hotpath.md` §7-2/§9 的"code cache 省 −0.2~0.8 s/进程 + −0.3~1.2 s/图"**没有 PoC 支撑**，标 `待证`（且它属"删监督进程/去同步 IO"之外的第三条腿，别顺手并进 P2 承诺）。

### 4.6 决策（本轮落盘）

1. **否决 P2 的 isolate 池 / 每图单进程化路线**；`ANALYSIS-AND-PLAN.md` §4.1 选项 B、§4.2 P2 表格第 4 行、§0.6 的 P2 目标、§5 风险行已**就地标注否决 + 数据**（原判断形成过程保留）。
2. **P2 只保留两项低风险**：(a) 删 creator 递归监督进程（A5，`−56 MB/图` 保持 `待证`），(b) 冷启动路径去同步 IO（`spawnSync tar` / blob 全量 link / `Atomics.wait` 自旋锁）。
3. **现有 ivmp（每图独立进程）的隔离性 = 本质复杂度**，不是债务。呼应 §0.3/§0.5"换语言省不掉 74%"。
4. **任何池化/共享进程形态的前置安全修复**仍未做：`ivmp-vm-controller.ts:112-124/403` 把 `ivm` 本体注入 jail（`src/S2-runtime-hotpath.md` §2.5 列为池化前置）。既然池化已否决，此项**降级为普通安全修复**，不再阻塞任何路线。
5. **`HANDOVER.md` §7 第 5 条（"isolate 池是否确认否决"）→ 已决：否决**（见 §7 决策日志）。
6. **PoC 数不可复现到 ±20 ms**：若要重启这条路，第一动作是**把抖动采样改成可复现口径**（固定 CPU 亲和、多 rep 取中位、区分 sync/async 宿主调用形态、单独度量堆外 Array buffer）。当前证据只支持"量级否决"。

---

## 5. 阻塞链（谁卡住谁，照实记）

```
services/game-server/package.json 改了 prod/dev
        └─→ common/config/rush/pnpm-lock.yaml 未 re-lock（需联网 + 用户决策）
                └─→ 任何 rush install（含 Docker builder 阶段）会红
                        └─→ 镜像无法重建
                                └─→ G1 的 −154 MB/镜像（A4 已收窄为 88,176,940 B 实测 + ~50 MB 结构性够不着）、
                                    −19.5 MB typescript、contentBytes 半边体积门（A2 U3）、
                                    ≤550 MiB / ≤1.4 GB / ≈190 MB 三条目标全部无法转成实测
```
**A10 补充：这条链上还挂着三件本轮新发现的事**
- `scripts/repo-tasks.js` 不在 A2 所有权内 → **`rush test` 不会跑 `check-image-budget.test.js`**；而 `scripts/verify-workflow.test.js` 本机 **`Cannot find module 'js-yaml'`**（`node_modules` 空、re-lock 未做）→ A2 改完 `verify.yml` 后**该既有测试一次都没跑过**（W2 U5，需 re-lock 后由 `rush test` 验）。
- `contentBytes` 半边门要 `docker image inspect`，`verify.yml` 不建/不 load 镜像 → **真正的按 content 阻断必须挂进 `release.yml` 的 images job**，该文件不在 8 条泳道任何所有权内（W2 U3）。
- A9 的 `compat-check.sh --skip-http --skip-docker`（**1.557 s**）已可接 CI，但接线同样落在 `verify.yml`（A2 已拥有、A9 §7-#6 请求授权）→ **兼容性门与体积门是同一位置的另半张网，当前都卡在"谁来改 workflow"**。

另两条独立阻塞（**第 2 条本轮已被 A3 解开**）：
- ~~**G3/G5 的最后一厘米卡在登录门户**~~ → **A3 已闭环**：门户加回后浏览器侧（curl 扮演，不带密钥）走完整 transfer 协议链拿到 **`/p/<publicId>` 200 / 149,594 B**（`impl/W4-play-lite-package.md` §11.4）。原始取证仍保留：`authorizePlayerAuthRequest()`（`apps/game/server/player-auth-security.ts:84-101`）强制 `x-box-player-auth-key`，缺密钥 **503 `AUTH_API_KEY_NOT_CONFIGURED`**、绕过门户直连 **401 `AUTH_API_KEY_INVALID`**（§3.3/§3.4/§11.4-F）；门户镜像代价 **+86,925,875 B gz**（§11.5 catalog `:95`）。**剩余 G3 缺口只剩"真浏览器渲染 + WebSocket 入局 + `onPlayerJoin`"**（§11.6 #2 明示未做）。
- ~~**G6/G7 卡在"从未运行过"（仍开放，A1 进行中）**：离线链与供应链的代码全在树里，验证为零。~~ → **A1 已交付静态/分支级核验**（`bash -n` ×3、`node --check` ×2、`rustc --test` 4/4 绿），但 **G6 端到端断网演练仍 = 0 次**、G7 的 SBOM/签名 **无物可验**（仓库根本不存在该环节）→ 该条改为："**G6 端到端 / G7 产出物 = 0 次，且都需用户授权或跨 `.github/workflows` 排期**（决策 D1/D2/D3）"。
- **新增一条依赖（G8/G9 共用）**：`plan/N1` §7-#1 指出 play 页面自定义要改 `pages/*`/`server/*` → **必须重建镜像** → 同样落在上面那条 re-lock 链上；~~G9 的 CLI capability 扩项改 `apps/game/shared/creator-cli-policy.ts` 也在 Next bundle 内~~ → **A8 修正**：G9 的"建图→发布→上服"**今天就可借道打通（0 行）**，故 G9 的首块绿**不被 re-lock 卡**；但 A8 建议的"把借道显式化成 `projects.manage`"（≈20 行：`creator-cli-policy.ts` + 5 条路由 + zod 枚举派生）**确实在 Next bundle 内** → 仍受 re-lock 约束；而 G9 真正的缺口（地形/UI 写入，改造项 **R1** ~400 行）落在 `services/game-server`，需重建 game-server 树。`ANALYSIS-AND-PLAN.md` §3.4 的"headless 部署缺口"段已同步改写（见 §9.1 修订 1）。**修订后的口径：G1 / G8 两个门仍被同一个"是否允许联网 re-lock + 重建"决策卡住；G9 的鉴权侧不再卡它（借道 0 行即可），只有工具侧（R1）卡重建。**

---

## 6. 发现的文档矛盾（不选边，照实列）

| # | 矛盾 | A 方原文 | B 方原文 | 本记分板处置 |
|---|---|---|---|---|
| 1 | **isolate 池状态** | `ANALYSIS-AND-PLAN.md` §4.1 B = "采纳（需 PoC）"、§4.2 P2 表仍写 "每图增量 150–200 MB → 15–25 MB" | `HANDOVER.md` §2.5 = "否决 isolate 池 / 每图单进程化" | **已修**：§4.1/§4.2/§4.3/§5 就地标注"已被 PoC 否决"+ 数据（本泳道职权） |
| 2 | **"每图增量 RSS 150–200 MB" 的置信级** | `ANALYSIS-AND-PLAN.md` §0.3/§2.1、`HANDOVER.md` §2.1 把它列在"已完成（有实测数字）" | `src/S2-runtime-hotpath.md` §1.4 写 **"INFERRED 150–200 MB"**，§10-1 把"每图真实增量 RSS"列入 **POSTPONED_MEASUREMENTS（本车道未执行）** | 记分板内该数一律写作 **`INFERRED`**，G2/G1 不用它做过门证据；实测责任在 A9/串行轮 |
| 3 | **空闲总 RSS 两个口径** | `E-runtime-baseline.md` §1：`TOTAL_IDLE_MemUsage_MiB=313.67`（12 样本均值）→ **≤320 过门** | `impl/W4-play-lite-package.md` §4.2 同刻现网全栈 **328.05 MiB** → **>320 不过门**；W4 自己也写"两个口径都给出"，并指出 4.6% 差属波动 | G2 记 **部**；引用时必须同时给 313.67 与 328.05，并在串行轮用 `tools/baseline.sh` 复跑定门 |
| 4 | **lite 空闲 RSS 用了单次值** | `impl/W4-...md` §4.2 三轮：155.73 / 157.89 / **156.88** MiB | 标题与 §4.1 表、`HANDOVER.md` §2.2 都用 **156.88 MiB（−52.2%）** = 第三轮单次值，非均值（均值 156.83） | 不改变结论；引用时注明"run3 单次值"。另 W4 内部还有一处写 **−52.2%**、一处写 **47.8%（同刻）/50.0%（对 313.67）**，三个百分比并存，须按口径标注 |
| 5 | **play-lite 分发 −58.1% 与 P1 目标 "150–200 MB"** | `ANALYSIS-AND-PLAN.md` §4.2 P1-2："传输 **444 MB → 150–200 MB**" | `impl/W4-...md` §4.3：lite 实测就是 **444,381,911 B = 423.8 MiB**（且补门户后 506.7 MiB） | 444 MB 是**已实现值**，不是中间态；"150–200 MB" 至今**零路径**（需 P0 prune 重建镜像才可能），G1 保持 `部` |
| 6 | **改动项数与文件名的口径** | `HANDOVER.md` §2.3 / 本任务书写 "install.sh**×3** + bootstrap.sh" | `git status` 实测：`distribution/linux-amd64/install.sh` + `distribution/server/install.sh` + `distribution/server/bootstrap.sh` = **2 个 install.sh + 1 个 bootstrap.sh** | 矩阵按 git 实况拆成 #14/#15/#16 三行；20 项总数不变（10 ` M ` + 10 `??`，与 HANDOVER 一致） |
| 7 | **Monaco 收益项** | `ANALYSIS-AND-PLAN.md` §3.1 已在文内自纠："早前判断被 v2026.1.4 实测否证，**该项收益作废**" | 该修正**未回写**到 §0.3/§4.2 P0 表（P0 表里没有 Monaco 行，故无残留） | 无冲突，但提醒汇总时别把 Monaco 再算进 G1 |
| 8 | **`play-worlds` 大小** | 任务书/HANDOVER 上下文多处按 **64 MB** 谈 | `impl/W4-...md` §3.1/§8 实测 **30M**（`du -sh`），`data` 8.0K | 以 30M 为准；G3 的"导入"体积基线随之改 |
| 9 | **字体子集"省 85–95%"** | `impl/W3-...md` §3.3 的 85–95% 来自 **外部业界数据**（Google Fonts / HarmonyOS 案例） | 同文件自测最大只有 **−43.8%**（MiSans 全 CJK）与 **−99.8%（仅拉丁，不可用于中文正文）** | G1 只收自测数；业界数不得写进承诺 |
| 10 | **398 契约"全有实现"** | `ANALYSIS-AND-PLAN.md` §0.5/§4.3 当作可依赖前提 | `src/S6-script-contract.md` 只核了**声明面计数**（183+215），**未逐项核对实现**；同文 §3 已证客户端 DTS 生成链断裂（include 路径 `git ls-files` 0 命中） | ~~G4 记 `未`，并把"声明面 398 ≠ 实现覆盖 398"写进缺口~~ → **A9 已判定**：① 398 **数字本身精确复现**（98+52+23+10 = 183、204+11 = 215、属性 1007+204+23 = 1234），**语义口径只有 313**（ctor/index/accessor 三类混入 + 23 行在 398 与 1234 **重复计数**）；② G4 的锚**从"398 全有实现"改为契约指纹 `5bcc18f8…`（members.tsv 2730 行）+ `compat-check.sh` 首轮 52 PASS/0 FAIL**；③ 静态实现覆盖 `impl.coverage.missing = 0`（分母 225）——**这是"词级命中"不是"逐项审计"**，仍不等于"398 全有实现"；④ S6 那句"include 路径 `git ls-files` 0 命中"**只对一半**（2 条里死 1 条，`../../internals/schema/api/common.ts` 命中 = 1）→ 见 §9.1 修订 6 / 矛盾 20 |
| 11 | **`−154 MB/镜像 构建期工具` 的可达性** | `ANALYSIS-AND-PLAN.md` §0.3/§3.1/§4.2 P0 表：**"单个 JS 镜像 39%（≈154 MB）是构建期工具"**，逐项列 `@swc/core` 48 / typescript 33 / babel 31 / esbuild 11 / sass 4 / AMP 4 / sql.js debug 22.7 | `impl/P0-prune-standalone.md` §4 用真实工具逐族核对：**本工具在 play standalone 只能删 88,176,940 B**；babel 在 .pnpm store 只有 **4,478,924 B**（主张的 31 MB 大头是 `next/dist/compiled/babel`，**结构上删不掉**）；**AMP 4 MB = 0 B 命中**（是 Next 内建）；**sql.js 22.7 MB 与另 ~24 MB typescript 在 `/opt/game-server` 后端树，不在管辖内**（`trimmed=0`）；swc 实测 **50,398,488 B**（比主张的 48 MB 还多约 2 MB） | ~~记分板把"−154 MB/镜像"降级为…~~ → **本条已判定（A4 一手证据）**：最大单项收益 **−154 MB/镜像 → −88,176,940 B（≈84.09 MiB 未压缩）实测可达 + 约 50 MB 结构性够不着**（AMP 4 MB 与 babel 大头 31 MB = `next/dist/compiled/*` Next 内建、非 store 条目；sql.js debug 22.7 MB 与 isolated-vm 在 `/opt/game-server` 后端树，本 eq2 只挂 standalone 故 `trimmed=0`）。`ANALYSIS-AND-PLAN.md` §3.1/§4.2 P0 表的预期列**已按此改写**（保留原主张）；`≤1.4 GB content` 目标继续 `UNVERIFIED`（一次镜像都没重建）；**A2 侧再补一刀**：真实出厂字节连 `transition`（−40%）档都超 **+66.7%**，故 `--tier transition` 目前**只能报告、不能阻断**（W2 §1.3/§3.2） |
| 12 | **Monaco 收益是否还在** | `ANALYSIS-AND-PLAN.md` §3.1 明文：**"该项收益作废，别再列进 P0"**（实测 play 镜像已无 `static/vs`） | `impl/P0-prune-standalone.md` §5.1 推算达 1.4 GB 的叠加项里又写回 **"Monaco 删除(−12.6 MB×2)"** | 照实列出，**不替 A4 修文**（该文件属 A4 所有权）；汇总时按 §3.1 的作废判定处理 |
| 13 | **play-lite 到底是 3 容器还是 4 容器** | `impl/W4-...md` §4.1 表 + `HANDOVER.md` §2.2 标题：**7→3 容器 / 9→3 端口 / 分发 423.8 MiB（−58.1%）** | `impl/W4-...md` §11（A3 续写）：**4 常驻容器 / 4 端口 / 分发 506.7 MiB（−49.9%）**，并声明"门户是刚需，有意不套 profiles" | ~~今后 headline 用 4 容器 / −49.9%；HANDOVER §2.2 的 3 容器口径需在下一轮回写~~ → **本条已判定（矛盾 ⑬ 关闭）**：两个数都对但**只有 4 容器是可交付形态** —— 3 容器版**没有登录门户、真实玩家无法自助注册**（§3.4 第一次尝试失败原文），A3 加回门户后浏览器无密钥链已实测走通（注册 201 → 回调 303 → `/p/<publicId>` **200 / 149,594 B**）。**容器数变化原因**：新增常驻服务 `player-auth-portal`（`pull_policy: never`、`User=node`、`Readonly=true`、`CapDrop=[ALL]`、`Privileged=false`），端口 `127.0.0.1:4125→3214`；**G5 的零 docker.sock / 零常驻 root 结论在 4 容器口径下复测通过**（§11.3 原文）。分发 **531,307,786 B**（catalog 三项 `240,669,370 + 203,712,541 + 86,925,875` 相加，A10 复算 ✅）。**唯一变未知**：4 容器空闲 RSS（A3 按纪律未测 → 矛盾 3 与矛盾 4 的 lite 侧数字**仍是 3 容器时代的数**） |
| 14 | **`prune` 等价样本能否算 G3** | `impl/P0-prune-standalone.md` §0：**"状态码、字节数、校验和逐项完全一致"**（易被读成"地图功能等价"） | 同文 §2c 原文里 `/api/play-worlds` 只有 **`200 / 13 B`**（临时容器未挂 `play-worlds`，返回空列表），且 §6 自陈"更深的进图功能链（G3/G4）不在本泳道范围" | G3 记 `部` 而非 `实`：等价性证据**不含真实地图渲染**，只有静态 chunk/logo/无数据端点 |
| 15 | **HTML 基路径改写机制落点** | `ANALYSIS-AND-PLAN.md` §3.3：**"monkey-patch `http.ServerResponse.prototype` 全量缓冲 + 正则改写（>8 MB 直接 destroy）"** | `plan/N1` §6-#2：A7 只读到 `res.destroy()` 出现在 **catch**、运行时代理为 `pipe`（`play-library.js:436/448`、`edit-library.js:458`），**"全量正则缓冲"的具体文件行 = UNVERIFIED** | 照实降级：§3.3 该条从"事实"降为 **"机制存在、落点未证"**，G8 档三方案不得引用它做安全论证 |
| 16 | **自托管要放宽"四处" vs 实际只动了三层** | `ANALYSIS-AND-PLAN.md` §4.2 P1-3：放宽 **四处** —— `build-image-downloads.js validDownloadBase()`、`install.sh:123`、`manager-core/release_channel.rs:2-3 常量`、**Tauri CSP** | `impl/W6-offline-selfhost.md` §2 G6.3/G6.4/G6.5：**真正挡住更新链的是 `server-manager-rust/src/platform/configuration.rs:535` + `http/commands.rs:473,478` 消费的 `release_base()`（恒返回 `&'static str` 硬编码 CDN）和桌面前端 `deployment-manager/src/utils/releases.js:28`** —— 这两处**不在任何泳道所有权内、一行未改**；Tauri CSP 也未放行内网主机 | G6 记 `部` 而非"接近完成"；**四处里有两处根本还没被触碰**，`ANALYSIS` 的 P1-3 清单需按 A1 的 8 条缺口表重写 |
| 17 | **树里有一条现成红测** | `ANALYSIS-AND-PLAN.md`/`HANDOVER.md` 均未提 | `impl/W6-...md` §1.6：`node --test scripts/release-context.test.js` → **1 FAIL**（`Cargo.lock` Windows CRLF vs 断言 `\n`），**非本轮改动引入**，属环境产物 | 照实记为**已知红**：CI 接线（A2）时若把它一起跑，门会因它变红；修复需碰 A1 所有权外的文件 → 交决策 |
| 18 | **"没有验证记录"是否还成立** | `HANDOVER.md` §3 第 8 条："**没有 `bash -n`、没有 `node --check`、没有 `cargo check` 记录，G6 完全没跑过**" | `impl/W6-...md` §1.1/§1.2/§1.4 已全部补齐（并发现 +261 行**当初根本编不过**） | 该条已在 GATES 里刷新为"已交付"；但**结论要留一句**：G6 的静态核验已做完、**端到端断网演练仍为 0 次**（A1 §5-2 自陈），二者不可混为一谈 |
| 19 | **G9 "五个端点只认浏览器会话 Cookie"** | `src/S6-script-contract.md` §5、`ANALYSIS-AND-PLAN.md` §3.4/§4.3 G9 段、本记分板 §1 的 G9 初稿：**五端点只认 Cookie、CLI Token 封顶 9 项 → 今天无法在 CI 里"建图→发布→上服"** | `plan/N2-...md` §1.4/§2.3/§8-M2：同一身份链会把 `Authorization: Bearer` 转成 `X-Box-Creator-Authorization`，`runtime-identity.ts:21-24` 优先按 CLI token 解析，`creator-api-security.ts:105` 查的是**用户级 `creatorPermissions`**（`:141` 才查 `creatorCliPermissions`）；`play-admin/import` **从来不是 Cookie 门**而是 `Bearer $BOX_PLAY_ADMIN_TOKEN` | **已判定：原主张在源码层不成立**（A10 逐字复核四处 path:line 全部对上）。但**这不是便利而是越权面**，且**端到端 0 次**（U2：真 token 打 publish 未测）→ G9 从 `未` 改 `部`，真缺口换成"地形 + UI 树服务端可编程写入口 = 0"。**仍开放**：`ANALYSIS-AND-PLAN.md` §4.3 的 G9 门定义行（"`src/S6 §5`：五端点只认 Cookie"）**不属 A10 可改范围**，按纪律未动，仅 §3.4 已改写 → 两处暂不一致，须主控下一轮统一 |
| 20 | **"客户端 DTS 无法再生成"的三条不同口径** | `ANALYSIS-AND-PLAN.md` §3.4/§5：include 指向 `git ls-files` **0 命中**的旧路径 → 客户端 DTS **无法再生成** | `impl/G3-...md` §2.5：**2 条 include 死 1 条**（`internals/schema/api/common.ts` 实测命中 1），修 1 行即可再生成；`plan/N2-...md` §8-M3：SDK 客户端链（`packages/script-api` → `rollup.config.mjs` → `dts/client-api-types.dts` 546 行）**完好且在用**，断的只是**编辑器 Monaco 那条**（`client-api-tsconfig.json:8`） | **不选边、只列口径**：三处说的**不是同一条链**。记分板采纳 A9 的实测（2 死 1 + 1 行修复成本）与 N2 的链路区分（Monaco 链断 / SDK 链活但只 546 行、覆盖面远小于运行时实现的"约 156 个"，后者 **U3 UNVERIFIED**）；`ANALYSIS-AND-PLAN.md` §3.4 该句**未由 A10 修改**（不在本次授权范围内） |
| 21 | **内置 AI 工具的数量** | 主控转述 + `plan/N2-...md` §1.1：**`createEntityTools` 11 个 + `createScriptTools` 4 个**（而 §1.1 的具名列举只有 **8 个**和 **5 个**，三处互不一致） | 本泳道只读实测 `grep -c ": tool({" entity-tools.ts` = **15**；逐行位：script 5 个（`:37/55/75/156/222`）+ entity **10 个**（`:254/321/346/446/468/501/609/655/676/685`，含 §1.1 漏列的 `searchPublicModels:655`、`addModelToProject:676`） | **总数 15 对、拆分错**：实测 **10 + 5** 而非 11 + 4。记分板按源码实测写入；N2 属 A8 所有权，A10 **不改他人文档**，仅照实标注 |
| 22 | **A9 §2.1 的"可复跑一行 awk"跑不出它自己声称的输出** | `impl/G3-...md` §2.1 命令 + 原文输出：`method=98 ctor=52 … 398公式=398 语义可调用=313` | 本泳道**原样照抄该 awk** 在 `packages/script-api/dts/box3-server-api.d.ts` 上实跑得：`M_incl_ctor=150 ctor=52 M_excl_ctor=98 arrow=204 getset=23 index=10 callsig=11 prop=1007 \| 398formula=450 \| semantic=313` | **一手文档内部不自洽**：那段 awk 的 `M` 把 constructor 也算进去了（`M++; if(/^constructor\(/) C++`），故 `M+C+…` 会重复计 52 → 得 **450 而非 398**；`semantic=313` 这一项**独立复现成功** ✅。**可信的权威口径是 `compat-check.sh` 的互斥分桶**：本泳道另用 `cut -f1 baseline/contract-server-api.members.tsv \| uniq -c` 复算 = method 98 / ctor 52 / arrow 204 / accessor 23 / index 10 / callsig 11 / prop 1007 + other 1325 = **2730 行** ✅，`sort members.tsv \| sha256sum` = `5bcc18f8c8434ca4b73bdefa…` ✅ 与文档一致。**→ 复现入口应引 `compat-check.sh`，不要引 §2.1 的一行式 awk。** |
| 23 | **A1 引用的 Rust 行号是"修复前"口径** | `impl/W6-...md` §2 G6.1/G6.3：`release_channel.rs:93`、`:111`、`release_base()` 在 `:151-157` | 本泳道读现网工作区源码（A1 已修后）：`:93` ✅ 仍是第一处修复位点；第二处现为 **`:113`**；`release_base()` 现为 **`:155-160`**（`:151-153` 是 `is_staging`）；文件现 **360 行** | **不是错误而是口径**：`?` → `let Ok(..) else` 各展开为 3 行、共 +4 行 → A1 全文行号为**修复前**基线。**引用时须注明"修复后 +4"**；E0277 的存在本身已由 A1 的 rustc 原文实证 |
| 24 | **play-lite 分发字节（主控转述 vs 一手）** | 主控转述："分发 = 3 个归档 = **531,307,875**…以 catalog 字段为准" | `impl/W4-...md` §11.5：**531,307,786 B = 506.7 MiB（−49.9%）**，三项 catalog `size` = `240,669,370 + 203,712,541 + 86,925,875`（本泳道相加 = **531,307,786** ✅） | **主控转述与一手文档不符（末三位 875 → 786）**；记分板一律采用一手数 + 复算式。**−49.9% 已复核成立**（531,307,786 / 1,060,646,139） |
| 25 | **"3 处 fail-open" vs 表列 5 行** | `impl/W2-...md` §1.4 标题："本泳道顺手堵掉的 **3 处** fail-open" | 同节表格实列 **5 行**（子集仍比 aggregate / 无上限静默 OK / 未声明镜像被忽略 / 6 请求只测到 5 当 SKIP / 子门没跑无提示），另有 §1.4 末"无输入源 exit 3 却一行不打"1 条 | 小口径瑕疵，**不影响任何字节主张**。记分板按 **5 处 fail-open + 1 处静默退出**记录；W2 属 A2 所有权，A10 不修 |
| 26 | **"SyntaxError 出在 `check-image-budget.mjs`"** | 主控转述："`check-image-budget.mjs` 此前连加载都 SyntaxError" | `impl/W2-...md` §0.1：报错栈在 **`scripts/lib/budget.mjs:180`**（源头 `:146-150` 的 JSDoc `**/` 提前闭合注释），CLI 只是 **import 它**才连带崩；同批其它新 `.mjs` 全 `node --check` OK | **症状成立、归属文件不同**：坏的是共享库 `lib/budget.mjs`（矩阵 #3），`check-image-budget.mjs` 自身另有 2 个缺陷（`REPO_ROOT` 少一层、黑名单无消费者）。记分板按 #2/#3 两行分别归属 |

---

## 7. 决策日志

### 7.1 本轮已传达并生效的用户决策

**(a) 三条新需求原文到位**（`HANDOVER.md` §7 第 1 条 / `impl/W4-play-lite-package.md` §10 记录的"原文仍未传达"缺口 → **已消解**）。用户传达的三条原文：

> 1. **play 页面自定义**：当前 play 页面是固定模板固定样式展示各地图，希望支持自定义页面样式来展示地图而不是锁死。
> 2. **开发一个 MCP / 工具 / 插件，让 AI 可以完全接管 edit 端地图的开发**，包括地形搭建、界面按钮、代码编写、各个交互等内容全自动接管。
> 3. **以上所有内容（含各项优化、轻量化、提速）都必须建立在对原有地图支持的基础上**：优化后原有地图不能跑不起来、地图各功能不能异常。

对应的记分板变化：
- 新增 **G8**（§1 表最后一行）承接需求 1 → 状态 `未`，A7 泳道执行中。
- 新增 **G9** 承接需求 2 → 状态 `未`，缺口取证已在 `src/S6-script-contract.md` §5（CLI token 9 项封顶、5 个端点只认浏览器 Cookie），A8 执行中。
- 需求 3 是**约束而非门**：它把 G3（现有「起床战争」进图链）与 G4（398 契约实现覆盖）从"锦上添花"提升为**每条瘦身分支的强制回归门**——任何 G1 字节收益在 G3/G4 未过之前不得合入。W3 的字体断言清单（`impl/W3-...md` §4 第 3 条"不许一刀切断言 `**/*.ttf → 0`"，因为 `DoulosSILR.ttf` 与 KaTeX ttf 是 live 引用）正是这条约束的第一个具体体现，已并入 G8/G3 的回归要求。

**(b) `HANDOVER.md` §7 第 5 条（isolate 池是否确认否决）→ 已决：否决**，数据见 §4，主文修正见 §6 矛盾 1。

### 7.2 仍待用户决策（本泳道不臆造、不代答）

| # | 待决 | 卡住什么 |
|---|---|---|
| 1 | 是否允许**联网 + `rush update` re-lock + 重建 1 个镜像（play）** | §5 阻塞链 → **G1 全部体积主张** |
| 2 | 是否把 20 项未提交改动 **checkpoint commit 到 `slim/local-deploy`（不 push）** | 一次 `git checkout .` 就全丢（本泳道按纪律未动 git） |
| 3 | 是否把 **play-lite 定为交付主线**（正式放弃 server-manager 与容器隔离），还是保留双形态 | 决定 G5 的门禁对象是 lite 还是主 compose；也决定 §4.2 P1-1 要不要去改主 `docker-compose.yml`（W4 §7.4 指出那是"7 容器"的根因，最省事路径） |
| 4 | 需求 3 落到哪张地图上作**永久回归基线**（当前只有「起床战争」1 张，`play-worlds` 实测 30M） | G3/G4/G8 的回归样本量；单张地图不足以证明"原有地图都能跑" |
| 5 | **是否把 prune 步骤接进 `Dockerfile:236/315/374/410` 并重建 creator+play+ps 三镜像**（A4 §5.3 第 1 条） | content `/app` 复算与 gz 收益 → G1 从"字节推算"变"镜像实测" |
| 6 | **play 页面自定义走档一（4 套 `theme` 预设）还是档二（`pageConfig` 白名单令牌 + `manifest.formatVersion 1→2`）**（A7 §7-#2） | G8 的实现半径与是否需要 schema/哈希迁移 |
| 7 | **新增 manifest 字段是否触碰 `permissionHash` 校验**（A7 §6-#6 未定位生成处；`getPlayWorlds():40-47` 与 `importWorld` 都校验它） | G8 与 G3/需求 3 的兼容性地基：哈希变了 = 老地图可能导不进/开放不了 |
| 8 | **是否把"作者自助改封面/标题"从 creator-only 放开给 play 服主**（现 `play-admin.ts:858-861` **主动禁止**，A7 §7-#4） | 会改变现有安全语义，必须显式拍板 |
| 9 | **档三（作者写任意 HTML）是否彻底放弃**（A7 建议放弃：XSS/CSP/基路径三重冲突，需另立安全评审车道） | G8 的攻击面边界 |
| 10 | **D1（A1 G6.2）bootstrap 与 install.sh 的 opt-in 口径统一走哪条**：给 `bootstrap.sh` 也加 `…_ALLOWLIST` 要求（更安全）还是放宽 `server/install.sh`（更易用） | G6 端到端能否跑通；当前最小口径 = 运维必须**同时**导出两个变量（文档级补丁，不改代码） |
| 11 | **D2（A1 G6.3/G6.5）是否把 server-manager 更新链 + 桌面前端 + CSP 的内网镜像支持纳入本轮**（这三处都在他人所有权内） | G6 完整闭环；不纳入则"断网安装"只能覆盖 CLI 路径，桌面管理器与更新器仍指官方 CDN |
| 12 | **D3（A1 G7）SBOM/签名是否排期**（跨 `.github/workflows`，与 A2 冲突面）；A1 的最低门槛建议 = **先给 `SHA256SUMS` 附 cosign/minisign 签名**，把"完整性"升级为"真实性" | G7 从 3/7 → 5/7 |
| 13 | **`release-context.test.js` 的 CRLF 红测怎么处置**（改断言 = 碰他人文件；改 `.gitattributes`/检出方式 = 全仓影响） | A2 接线 CI 时会让 `verify.yml` 因它变红；A2 另有一处连带：`scripts/verify-workflow.test.js` 本机 `Cannot find module 'js-yaml'`（`node_modules` 空）→ **A2 改完 workflow 后该既有测试一次没跑过**（W2 U5） |
| 14 | **A8-D1：改造项 R1 是否批准**（`createServer.ts:557-633` 同段加 `/internal/ai-tool` + `entity-tools.ts` 加 `terrain_apply/terrain_read/ui_upsert/interaction_configure` 四个同族工具，~400 行、半径 2 文件、零新鉴权面）；选项：①批准 ②只做盘侧 `box3-terrain-pack`（引擎 0 改但禁止与编辑器同开）③只做切片 A 代码链。A8 建议 **①+②并行** | **G9 的"地形 + UI 全自动"只有这一条路**；不批则需求 2 只能做到"代码/存储/预览/发布链 headless"，地形与界面仍要人工 |
| 15 | **A8-D2：借道越权面怎么修**：①先借道打通 G9、把越权记为已知风险 ②立刻显式化（新增 1 个 `projects.manage` scope + 5 条路由各 1 行 + zod 枚举自动派生 ≈ 20 行，同时修掉漏洞）。A8 建议 **②** | 不批 = 一个只授予 `projects.list` 的只读 CLI token **今天就能发布/删图**（`creator-api-security.ts:105` 查用户级权限、`:141` 的 scope 承诺在这 5 条路由上形同虚设） |
| 16 | **A8-D3：U1 是否允许一次实测**（`POST /internal/save-local-project`，属容器内写入；可只在一次性克隆工程上做）。A8 建议 **允许，仅对新建克隆图** | MCP 的**落盘方案**全押在这条上（`runtime.rs:126-138` 给容器 IP vs `createServer.ts:609-619` 只认 loopback → 理论上 403）；不测则整个写链设计是猜 |
| 17 | **A8-D5/D6/D7：MCP 跑在哪（宿主 WSL / creator 容器 sidecar）、AI 写盘默认策略（每步强制快照 vs 批次末尾一次；`snapshotLimit=5` + `spawnSync tar` 未解决前 A8 建议后者）、要不要把 398 面做成 MCP 常驻资源并顺手修 R7 客户端类型断链** | G9 切片 A 能否开工；D7 同时是需求 3"AI 不破坏原有功能"与"界面按钮全自动"的共同前提 |
| 18 | **A9-#1：是否授权一次受控的真实进图**（浏览器打开 `cloud-4e84ee7ef626058f-imported`，允许只读 `docker logs` 取 `onPlayerJoin` 痕迹，成本约 2 分钟） | **L3 全层是 4 层里唯一整层空白的一层**；不批则 G3 的"地图功能不异常"无法证伪 |
| 19 | **A9-#2/#3：是否授权一次性测试栈**（独立 project-directory + volume，跑完 `down -v`）+ **是否把 `yunhai-xiantu` 或混沌神域之一发布成第 2 张 play-world** | 前者解锁 G4 后半（`.boxplay` 往返）与 L1 有样本验证；后者把 G3 样本从 1 张提到 2–3 张、覆盖 `gui/http/dialog` 路径（现各只有 1 次命中） |
| 20 | **A9-#4：是否授权那 1 行修复**（`apps/game/client-api-tsconfig.json:7` 的 `src/engine/script/apis/*.ts` → `…/ses/apis/*.ts`，真源目录实测 9 个 .ts） | 解锁客户端 DTS 再生成，把"客户端宣称 32 / 实测 30"从 UNVERIFIED 变可复算；G9 的客户端 UI 编写也依赖它（N2 R7） |
| 21 | **A2-U3/U4/U7/U8 四项 CI 侧决策**：①是否授权改 `release.yml`（把 `--docker --catalog` 的 **contentBytes 阻断**接进 images job）②是否在 `scripts/repo-tasks.js:110` 补 1 行让 `rush test` 跑新测试 ③`--tier transition` 何时切成阻断（现状：出厂字节超 **+66.7%**，切了就是每 PR 全红）④**门与计划书以谁为准**（门 `transition` 合计 **606.91 MiB** vs 计划书 **≤550 MiB**；`target` 档 455.17 MiB 反而更紧） | ①②不在 8 条泳道任何所有权内 → 门只守住了 archive 半边；③决定"防回归"是真阻断还是进度指示；④不统一则 G1 的"过门"没有唯一判据 |
| 22 | **A4-§5.3：creator / player-service / voxa 三棵 standalone 树是否一并 prune 并各自实测 removed 字节**（现只有 play 实测 88,176,940 B）+ 是否让 A4 用 `--trees-dir` 复扫真镜像以关掉 A2 的 U2（配置里 `measured` 声称"W2 实测"） | G1 的 264.5 MB（3 镜像 × 88.18 MB）推算里 **2 项仍是外推**；黑名单 `measured` 数字目前**无人在真镜像上验证过** |

---

## 8. 本泳道纪律自证

- 源码目录 `box3-local-engine/`：**只读**，仅执行 `git status --short` / `ls` / `wc -l`，**无一处写入**。矩阵 #17 记录的 `release_channel.rs` E0277 修复**由 A1 泳道在其所有权内完成**，本泳道只转述其原文输出。
- 未使用 Docker（A3/A4 独占）；未跑任何 RSS/TTFB（负载敏感指标留给串行轮）。
- 未 `git commit/push`，未改 `docker-compose.yml` / `BOX3-IMAGE-CATALOG.json` / `pnpm-lock.yaml`。
- 唯一写入：本文件 + `box3-re/ANALYSIS-AND-PLAN.md` 的 §0/§4.1/§4.2/§4.3/§5/§6 就地标注（isolate 池相关段落）。
- 所有数字均为**引用原文**；未自跑者一律 `待证` / `UNVERIFIED`；§4.2 的不可复现性与 §4.3 的门内结果已照实标注，未挑选有利数字。

---

## 9. 本轮终局修订（A10 记分板终局修订泳道）

**记录时间**：2026-10-17 22:29（宿主 `date` 原文；A1 交付文档自署 2026-10-18，两份文档的日期口径本就不同，照实并列）。
**执行泳道**：A10（记分板终局修订）。**可写文件**：本文件 + `box3-re/ANALYSIS-AND-PLAN.md`；`box3-local-engine/` 与 box3-re 下其它文档**全程只读**，未使用 Docker、未做任何 git 写操作、未联网。
**依据的一手交付文档（全部逐字读过再引用）**：`impl/P0-prune-standalone.md`（A4）、`impl/W2-ci-size-gate.md`（A2）、`impl/W6-offline-selfhost.md`（A1）、`impl/W4-play-lite-package.md` §11（A3）、`impl/G3-map-compat-baseline.md`（A9）、`plan/N1-play-page-customization.md`（A7）、`plan/N2-mcp-ai-map-authoring.md`（A8）、`poc/out-poc*.txt`（PoC 原文，本轮未改其结论）。
**规则**：① 被推翻的原主张一律以 `~~原文~~ → 修订为` 保留，不静默覆盖；② 凡引用数字一律带来源文件与原文单位/口径；③ 本泳道**自己复核过**的（读源码行号、复算加法、复跑 sha256/awk）标注"✅ 复核通过"或"❌ 与文档不符"；④ 核不到的写 `UNVERIFIED`；⑤ **不改任何他人所有权的文档**（A1/A2/A4/A8/A9 交付文档一行未动，缺陷只标注）。

### 9.1 八组修订（逐条：原主张 → 修订为 + 一手出处 + 复核）

**修订 1 ｜ G9 的 headless 主张被源码层推翻（同时是越权面）**
- ~~缺口已取证：CLI token 能力集 9 项封顶……**不含 create/publish/export/package/play-import**；这 5 个端点**只认浏览器会话 Cookie**……今天**无法在 CI 里完成"建图→发布→上服"**，必须模拟登录。零代码、零验证~~
- **修订为**：该判断在源码层**不成立**。任意 scope 的合法 `bxc_…` Bearer 会被**同一条身份链**接受，而 create/publish/export/package 这**四条**路由查的是**用户级 `creatorPermissions`**，**完全不看 CLI scope**（第 5 条 `play-admin/import` 本来就不走这条路）。证据链（A10 逐字读源码核对，四处 path:line **全部对上 ✅**）：`apps/game/server/player-service-client.ts:87-89`（`Authorization: Bearer …` → 转发为 `X-Box-Creator-Authorization`）→ `apps/game/pages/api/player-internal/runtime-identity.ts:21-24`（该头 `startsWith('Bearer ')` → `resolveCreatorCliTokenIdentity`，否则 `resolvePlayerIdentity`(Cookie)）→ `apps/game/server/local-player-identity.ts:923`（SQL **同时 SELECT `u.creator_permissions`**）→ `apps/game/server/creator-api-security.ts:105`（`hasCreatorCapability(identity.creatorPermissions, item)`）；**`creator-api-security.ts:141` 才是 9 项 scope 的校验处**（`identity.creatorCliPermissions?.includes(capability)`）。`play-admin/import` **从来不是 Cookie 门**，而是 `allowPlayLibraryAdmin` = `Bearer $BOX_PLAY_ADMIN_TOKEN`（A8 §1.4）。
- **真阻塞改判**：不是鉴权面，而是**地形（voxels）与 UI 树（uiTree）的服务端可编程写入口 = 0**（A8 §1.1/§1.2/§7：体素只能走需登录会话的 `VoxelProtocol`，且 `validate-project-action.ts:14-21` 明确禁止 project 级 voxel 动作；`entity-tools.ts` 无 UI 工具）。唯一解 = 改造项 **R1**（~400 行，半径 2 文件，零新鉴权面）。
- **定性**：借道**是越权面不是便利** —— 只授 `projects.list` 的只读 token 也能发布/删图；9 项 scope 的最小权限承诺在这 5 条路由上失效。**端到端仍 0 次**（U2：真 token 打 publish 是否 2xx 未测；A10 复核 `local-player-identity.ts:915` `if (!database) throw new Error('玩家身份服务需要配置 PostgreSQL')` → **借道路径硬依赖 PG**，这是文档没写透的前置条件，本轮补上）。
- 同步改写：`ANALYSIS-AND-PLAN.md` §3.4 "headless 部署缺口"段（已改，保留原句）。**§4.3 的 G9 门定义行不在 A10 授权范围，未改** → 两处暂不一致，见矛盾 19。

**修订 2 ｜ 引擎已内置 15 个 zod AI 工具：G9 的既有地基，记分板此前完全没记**
- **新增事实**：`services/game-server/src/edit/ai/entity-tools.ts:31-812` 定义的 zod 工具，经 `services/game-server/src/edit/edit-server.ts:192-202`（A10 实测 `:192` 原文 = `this.ai = new AiServer({`，其参数含 `state/replica/logger/gameId` ✅）挂载，走 `replica.projectTransaction()` → `RDATransaction.commit()` 写**与浏览器同一棵 `EntitiesTreeRDA`**，**不依赖 LLM**（`createEntityTools(replica, state, gameId, logger)` 可被 MCP 直接复用）。
- **数量复核**：`grep -c ": tool({" entity-tools.ts` = **15 ✅**；拆分实测 = **createEntityTools 10 个（`:254/321/346/446/468/501/609/655/676/685`）+ createScriptTools 5 个（`:37/55/75/156/222`）= 15** → **A8 §1.1 原文写的"11 个 + 4 个"是错的（且它自己列的具名清单是 8 + 5），三处互不一致**；总数 15 与主控转述一致 ✅（矛盾 21）。
- **体素/UI 覆盖**：`grep -c voxel entity-tools.ts` = **0 ✅**（唯一相关是 `:737 AssetType.VOXEL_MODEL` 资产类型常量，非地形写入）；无 UI 工具 ✅ → **0 个体素、0 个 UI** 成立。
- **内置 AI 提示原文**：`services/game-server/src/edit/ai/ai-server.ts:70` = `- Client Scripts: The entry file is 'clientIndex.js'. Do NOT generate client scripts. The client API is currently not supported.` ✅ 行号与文本逐字对上。

**修订 3 ｜ G1 最大单项收益 −154 MB/镜像 被实测收窄为 88,176,940 B，且等价性通过**
- ~~`−154 MB/镜像`~~ → **play 自带 standalone 树 `226,663,944 → 138,487,004 B`，removed = `88,176,940 B`（≈84.09 MiB 未压缩）**；宿主 9P 口径 `220,118,536 → 132,576,476 / 87,542,060 B`（两口径 A4 都记，采用工具自报 = 容器 du 的那条，两者**完全吻合**）。
- **等价性 ✅**：control 与 pruned 的 **5 个路径** `status/bytes/ck` 逐项相同（`/api/health-check 200/33/443842c1`、`/api/play-worlds 200/13/0a52ea1b`、`main….js 200/138,777/64909b0f`、`framework….js 200/189,786/8dc346be`、`/logo512.png 200/14,027/8299fd15`）；两树 `MODULE_NOT_FOUND = 0 / 0`；两树 `/api/health-check` 均 **UP 200**；**规则未改、校验未放松**。**边界照实**：其中 `/api/play-worlds` 只有 **13 B**（临时容器未挂 `play-worlds` → 空列表），等价性覆盖"静态资源 + 无数据端点"，**不含真实地图渲染**（矛盾 14 仍成立）。
- **154 与 88 的差额 = 结构性够不着**（按 A4 §4 逐族）：AMP 主张 4 MB → store 命中 **0 B**（`next/dist/compiled/amphtml-validator`，Next 内建）；babel 主张 31 MB → store 只有 **4,478,924 B**（大头 `next/dist/compiled/babel`，非 store 条目）；sql.js debug **22.7 MB** 与 isolated-vm、后端 typescript 副本 **~24 MB** 在 `/opt/game-server` 后端树（本 eq2 只挂 standalone → `trimmed=0`）；swc 实测 **50,398,488 B**（比主张 48 MB 多约 2 MB）、esbuild 11,570,793 B、sass 5,445,892 B、webpack/terser/uglify/jest 簇 7,335,292 B；逐包字节求和 = **88,176,940 精确吻合**（17 个 .pnpm store 条目）。
- 已同步：GATES §1 G1 行、矩阵 #1、矛盾 11（判为**已判定**）、`ANALYSIS-AND-PLAN.md` §3.1 与 §4.2 P0 表预期列（已改，保留原主张）。**仍 UNVERIFIED**：creator/ps/voxa 三棵树、content `/app` 复算、gz 分发收益（一次镜像都没重建）。

**修订 4 ｜ A2：CI 体积门此前根本不可运行，本轮首次跑通**
- ~~同 #2（预算库，无独立测量）/ 交付文档还不存在，故"红/绿各一次"与"门已在 CI 接线"两项仍按未证处理~~ → **修订为：代码在树里且不可运行，本轮首次跑通**。三个动手前缺陷（A2 §0）：① **加载即 SyntaxError**（源头是共享库 `scripts/lib/budget.mjs:146-150` 的 JSDoc 里写了 `**/` 提前闭合块注释，在 `:180` `new RegExp(\`${source}$\`)` 处炸，原文 `SyntaxError: Unexpected identifier '$'` / `EXIT=1`；**主控转述把它归到 `check-image-budget.mjs`，症状对、归属文件不对**，见矛盾 26）；② 裸跑默认配置路径 `REPO_ROOT` **少一层** → 解析到仓库外 `D:\desktop\神奇代码岛` → `缺少文件：…common\config\box3-image-budget.json`、`EXIT=2`；③ 黑名单表（106 行 / 10 规则）**无任何消费者**，注释点名的 `check-image-blacklist.mjs` 文件不存在。
- **红/绿原文数字**：棘轮档 `--tier ratchet --require size` 打真实 catalog → 六服务 + 合计 `1,060,646,139 B` 全 `+0.0% OK`、**exit=0**；`--tier transition` → **7 项违规、exit=1、+66.7%**（creator 超 `105,211,992 B`）；回放上游 +120 MB（`2,736,210,446 → 2,856,349,883`，+`120,139,437 B`）→ 7 项违规 exit=1；黑名单合成树 → **10 项违规 exit=1**；`--self-test` 4 场景 PASS；`node --test scripts/check-image-budget.test.js` → **19/19/0**。
- **`ratchet` 档新增的数值 = 配置里已有的 `basis.observed` 原值**（12 格全等，程序断言；**未发明任何一个字节**）；`transition`/`target` 12 格**逐字节未动**（`EXISTING_TIERS_UNCHANGED= true`）。
- **遗留（必须进记分板）**：`repo-tasks.js` 不在 A2 所有权 → **`rush test` 目前不会跑该测试**（U4，补 1 行）；**`contentBytes` 半边要靠 `docker image inspect`，`verify.yml` 不建/不 load 镜像 → 真阻断须挂 `release.yml`**（U3）；`verify-workflow.test.js` 本机 `Cannot find module 'js-yaml'` → A2 改 workflow 后该既有测试未跑（U5）；门 `transition` 合计 **606.91 MiB** ≠ 计划书 **≤550 MiB**（U8）。A6 初稿记录的旁证**仍然成立**：接线前 `verify.yml` grep `budget|check-image|size` 零命中。

**修订 5 ｜ A1：+261 行 `release_channel.rs` 原本编不过；G6 8 条缺口、G7 SBOM/签名全仓 0 命中**
- 两处 **E0277**（`?` 用在返回 `bool` 的 `valid_mirror_base()`，`release_channel.rs:44`）：修复前 `:93` `let port: u32 = port.parse().ok()?;`、`:111` `let value: u32 = octet.parse().ok()?;`。A1 在所有权内改为 `let Ok(..) = .. else { return false }`（语义不变）→ `rustc --emit=metadata` exit=0、`--test` 构建 0、**`test result: ok. 4 passed; 0 failed`**（含 `self_hosted_base_is_inert_without_the_explicit_opt_in`），并行连跑 5 次全 PASS。**`cargo check --offline` exit=101**（离线缓存 504 crate 里**没有 `tar`/`urlencoding`/`zip`**）→ **整 crate 集成 UNVERIFIED**。
- **A10 复核 ✅/⚠**：现网源码 `:93` 已是 `let Ok(port) = port.parse::<u32>() else {`；**第二处现落在 `:113`**（A1 引的 `:111` 是修复前行号）；`release_base()` 现落在 **`:155-160`**（A1 引 `:151-157`），文件现 360 行 → **A1 全文行号为"修复前"口径，引用须 +4**（矛盾 23）。
- **G6 = 部**：静态/分支级已实跑（`bash -n` ×3 = 0、`node --check` ×2 = 0、`tauri.conf.json` parse OK、三层策略判定一致 `release_channel.rs:44` / `build-image-downloads.js:96` / `install.sh:95`、`install.sh:136-164` CASE A exit=1 / CASE B exit=0、`linux-amd64/install.sh:38-44` 4 例隔离实跑）；**端到端断网演练 = 0 次**。8 条缺口 G6.1–G6.8，要命的是 **G6.2**（`bootstrap.sh:10/65-78/279` 只看 `BOX3_RELEASE_CDN_URL`，内层 `server/install.sh:145-153` 还要求 `…_ALLOWLIST` 精确钉死 → `curl bootstrap|bash` 指内网在内层挂）与 **G6.3**（`release_base()` 返回 `&'static str` 恒硬编码 CDN，消费者 `server-manager-rust/src/platform/configuration.rs:535`、`http/commands.rs:473,478` + 桌面 `deployment-manager/src/utils/releases.js:28`，两处**他人所有权、一行未改**）。
- **G7 = 部（3 绿 1 黄 2 红，A1 计 3/7）**：sha256 ✅ / size ✅ / digest ✅ / 源提交 🟡（`split-image-archive.py:69` 缺省 `'unknown'` 且 `validateCatalog:125-166` 不校验）/ **SBOM ❌、签名 ❌、attestation ❌**（grep `sbom|syft|cyclonedx|spdx` 与 `cosign|sigstore|minisign|gpg|signature|attest|in-toto` 均 **0 命中**；5 条 workflow 无 attestation 步骤）。后果照实：`server/verify.sh:5-9` 只 `sha256sum -c` → **校完整性不校真实性**，SHA256SUMS 未签名 → 镜像主机被控者可重算校验和悄悄换归档。

**修订 6 ｜ A9 钉死契约口径：G4 的锚从"398 全有实现"改为"指纹 + 兼容检查脚本"**
- ~~398 个服务端可调用全部有实现~~ → **锚 = ① `contract.server.fingerprint.sha256 = 5bcc18f8c8434ca4b73bdefaa84861ecab12d9c9c4701d096a79336676352865`（清单 `box3-re\baseline\contract-server-api.members.tsv`，**2730 行**）② `box3-re\tools\compat-check.sh` 首轮 `pass=52 fail=0 skip=0`（基线 56 key）③ `.boxplay` 被出厂 reader 读回（仍未做）**。
- **口径钉死（三种说法并存，全部落文档）**：398 **精确可复现**（方法式 183 = method 98 + ctor 52 + get/set 23 + 索引签名 10；箭头式 215 = arrow 204 + callsig 11；属性 1234 = prop 1007 + arrow 204 + accessor 23）；**语义可调用只有 313** = method 98 + arrow 204 + callsig 11（**52 constructor 是 `new` 位点、10 索引签名不可调用、23 get/set 按属性读写且这批行在 398 与 1234 里被重复计一次**）；另有 **10 个"类型为具名函数别名的属性"被 398 口径漏掉**。客户端**宣称 32 / 实测 30**（method-style 21 含 ctor 11 + arrow-style 9）→ 差 2 **UNVERIFIED**。
- **A10 独立复核**：`members.tsv` = **2730 行 ✅**、`cut -f1 | uniq -c` = 98/52/204/23/10/11/1007 + other 1325 ✅（**分桶与文档逐项一致**）、`sort | sha256sum` 前 24 位 = `5bcc18f8c8434ca4b73bdefa` ✅；`g3-baseline.tsv` = **56 key ✅**；但 **A9 §2.1 那行"可复跑 awk"原样照抄跑出 450 而不是 398**（`M` 含 ctor 重复计），只有 `semantic=313` 复现 ✅ → **复现入口应引 `compat-check.sh`，不要引 §2.1 的一行式 awk**（矛盾 22）。
- **必须进记分板的两条**：① 真实地图在 API 对象上挂了 **86 个未声明自定义属性**（`world.Quanjujiaoyi`…；含假阳性 → 量级指示）+ **55 个声明面被实际调用**（可信下限）→ **任何 `Object.freeze`/`seal`/Proxy 白名单/收窄注入会直接打死老地图**；② **G3 目前只有 1 张可用图**（`map.playWorlds.count = 1`，3 个 creator 工程全部 `releases: []`）→ **L3 全层（进图 / `createSession` / `onPlayerJoin`）UNVERIFIED**，且 `gui/http/rtc` 各只有 1 次命中。
- **附带纠正**：客户端 tsconfig 是 **2 条 include 死 1 条**（`src/engine/script/apis/*.ts` 不存在；`../../internals/schema/api/common.ts` 命中 1），**修 1 行**即可再生成 → ANALYSIS §3.4 的"0 命中"表述**只对一半**（该句 A10 未授权改，见矛盾 20）。

**修订 7 ｜ A3 让 play-lite 形态变了：4 容器 / 4 端口 / 531,307,786 B；矛盾 ⑬ 关闭**
- 加回登录门户后：常驻容器 **4**（`docker compose -p box3-lite ps --format | wc -l` → 4）、宿主端口 **4 且全 127.0.0.1**（`ss -ltnp` 原文 4121/4124/**4125**/4132，`OK: all published ports bound to 127.0.0.1`）、**docker.sock 0 处**、**常驻 root 0 个**；门户 `User=node Readonly=true CapDrop=[ALL] Privileged=false` + `pull_policy: never`；`CONFIG OK`、`ALL HEALTHY after 5s`、门户 `/api/health-check` → `{"status":"ok","service":"player-auth-portal"}` http=200。
- **分发** = 3 个 BOX 镜像归档 = **531,307,786 B = 506.7 MiB**（catalog `size`：`240,669,370 + 203,712,541 + 86,925,875`；A10 复算 ✅；**−49.9%** vs 1,060,646,139、**+19.6%** vs 3 容器口径 444,381,911）。**主控转述的 531,307,875 与一手文档不符**（矛盾 24）。
- **登录链 ✅ 实测**：`/p/<publicId>` 未登录 **307** → `/api/player-login/start` **302** 到门户 4125（带 `transferState`/`transferChallenge`）→ 门户 `POST /api/auth/register?…&source=play` **201** → play 回调 **303** + `Set-Cookie: box_local_player_session` → **`GET /p/cloud-4e84ee7ef626058f-imported` http=200 size=149594**；负对照（绕过门户直连 player-service）= **401 `AUTH_API_KEY_INVALID`**。全程 curl **不带** `x-box-player-auth-key`。
- **仍未证**：**RSS 未测（VM 冷 `up 1 min` + A3/A4 共用 Docker，按纪律只报结构事实）** → G2 的 lite 数字 156.88 MiB 仍是 **3 容器时代**的值；真浏览器点 UI（门户 SPA 壳 `GET /?source=play…` = 200/466 B，`public/app.js` 交互路径 UNVERIFIED）；HTTPS 反代 + `BOX_APP_BASE_PATH` 子路径；`.boxplay` 自助导入；WebSocket 真人进局。
- 踩坑一条（设计使然）：门户 register 带 `transferState/transferChallenge` 但**不带 `source=play`** → 建号成功但回传校验抛 400 `INVALID_LOGIN_TRANSFER`（`auth.ts:315-321`），浏览器看不到 201/Set-Cookie；首轮因此留下无会话账号 `a3portalplayer`。

**修订 8 ｜ A7：G8 从"未开工"改判"取证完成，方案待批"**
- ~~未开工（取证与规划已落盘，代码 0 行）~~ → **部（取证完成，方案待批：档一接线优先、档二待评估、档三否决；代码仍 0 行）**。
- **既有地基（A10 逐字复核源码 ✅）**：每张已发布地图的 `manifest.json` **已带 4 值 theme 令牌** —— `apps/local-engine/src/project-manager.js:2442` 原文 `theme: metadata.theme || 'sunset',`（上下文 `:2437 projectName`、`:2438 author`、`:2439 description`、`:2440 cover`、`:2441 loadingCover`）；赋值是**自动轮询**：`:1118 const themes = ['sunset','ocean','forest','violet']` → `:1127 theme: themes[listProjects().length % themes.length]`（作者选不了）。
- **play 侧不读（✅）**：`apps/game/server/play-worlds.ts:22` 起的读盘字段清单（`:37 description`、`:38 cover` 等）**不含 `theme`**；`apps/game/pages/index.tsx` 全文 grep `theme` = **0 命中**；版式烤死在 `apps/game/pages/index.tsx:1491` 起的 `<style jsx>{`（A10 实测该行原文 ✅）一路到 `:2900+`。
- **服主侧主动禁止（✅）**：`apps/game/server/play-admin.ts:858 const protectedFields = ['name','author','description','cover','loadingCover']` → `:859-861` 抛 **"游玩端不允许修改地图封面、标题、作者或简介"**。
- **档一最小切片 = 4 文件 ~40–80 行**（`play-worlds.ts` +3 / `pages/index.tsx` +~25 / `project-manager.js` +~3 / `project-editor-dialog.tsx` +~15），**不新增服务、不碰 Postgres、不需 re-lock，但要重打 Next standalone bundle**；**档三否决**理由 = XSS / 基路径 monkey-patch 冲突 / CSP 放宽三重（与 lite 的"无特权、面最小"直接对冲）。
- **新发现的真实回归门**：`server/project-editor-dialog-ui.test.ts:152` **硬断言** `.playerGrid{grid-template-columns:repeat(auto-fill,minmax(208px,224px));justify-content:start}` → 任何改栅格的档一/二 PR **必须连带改这条断言**（N1 §4.2），记分板此前未记。

### 9.2 矛盾清单判定状态汇总

| 判定 | 条目 |
|---|---|
| **本轮已判定（关闭）** | **⑬**（3 vs 4 容器 → 4 容器是唯一可交付形态，原因 = 门户刚需，§11.3 复测零 docker.sock/零常驻 root 仍成立，分发 531,307,786 B）；**⑪**（−154 MB → 88,176,940 B 实测 + ~50 MB 结构性够不着）；**⑩**（398 口径 → 锚改指纹，398 复现成立但语义 313）；**⑲**（G9 五端点只认 Cookie → 源码层推翻，真缺口 = 地形/UI，且借道 = 越权面）；**⑱**（"没有任何验证记录" → A1 已补齐静态核验，端到端仍 0 次） |
| **仍开放（不得当作已决）** | **①**（isolate 池：已决"否决"，但**抖动数不可复现到 ±20 ms**，恶化幅度与挂死数非单调 → 待复测）；**②**（每图增量 RSS 150–200 MB 仍 `INFERRED`）；**③**（空闲 RSS 313.67 vs 328.05 两口径并存，且**门户后 4 容器值 = UNVERIFIED** → 只能等静默串行轮）；**④**（lite 156.88 MiB 是 **3 容器 run3 单次值**，门户后失效）；**⑤**（"150–200 MB 传输目标"至今零路径）；**⑥⑦⑧⑨⑭⑮⑯⑰**（口径/作废提醒类，未变）；**⑳**（客户端 DTS "无法再生成"的三条链口径，须由主控统一）；**㉑㉒㉓㉔㉕㉖**（本轮新增的一手文档内部/转述缺陷，均**不改他人文档**，仅标注） |

### 9.3 G1–G9 最新状态（一行一状态，全量口径见 §1 各行）

| 门 | 状态 | 一句话依据 |
|---|---|---|
| G1 体积 | **部** | prune 实测 **88,176,940 B** + 等价 5/5、MODULE_NOT_FOUND 0/0；CI 门本轮首次跑通（棘轮绿 exit 0 / transition **+66.7% 红**）；**0 次镜像重建** → 三条 P0 目标全 UNVERIFIED |
| G2 运行 | **部（两口径并存）** | 出厂 313.67 MiB（同刻另一测 328.05 MiB > 320 门）+ TTFB 6.9 ms（余 0.1 ms）；**4 容器（含门户）空闲 RSS = UNVERIFIED** |
| G3 功能 | **部（最后一厘米未过）** | 门户链已通：无密钥注册 **201 → 303 → /p 200/149,594 B**；**但只有 1 张可用图**，真浏览器进图 + `onPlayerJoin` **0 证据**（L3 全层 UNVERIFIED） |
| G4 契约 | **部（锚已换成指纹）** | `compat-check.sh` 首轮 **52 PASS / 0 FAIL**、指纹 `5bcc18f8…`（2730 行，A10 复算 ✅）；398 复现成立但**语义 313**；`.boxplay` 往返 **0 次** |
| G5 安全 | **部（lite 过、出厂不过）** | 4 容器 / 4 端口全 127.0.0.1 / docker.sock 0 / 常驻 root 0；主 `docker-compose.yml` **一行未改**；仍有 1 个一次性 root `play-storage-init` |
| G6 离线 | **部（静态实跑、端到端 0 次）** | `bash -n`/`node --check`/`rustc --test 4/4` 全绿；**E0277 已修**；8 条缺口（G6.2 opt-in 口径不一致、G6.3 `release_base()` 恒硬编码）；整 crate UNVERIFIED |
| G7 供应链 | **部（3 绿 1 黄 2 红）** | sha256/size/digest 达标、6/6 双校验 1,060,646,139 B；源提交仅 staging；**SBOM/签名/attestation 全仓 0 命中**；verify.sh 只校完整性不校真实性 |
| G8 页面 | **部（取证完成，方案待批）** | `theme` 4 值已在 `manifest.json`（`project-manager.js:2442` ✅）但 play 不读（`index.tsx` grep theme = 0 ✅）；档一 4 文件 ~40–80 行待批；档三否决；**代码 0 行** |
| G9 headless | **部（真缺口换位 + 既有地基 15 工具）** | "五端点只认 Cookie"被源码推翻（`:105` vs `:141` ✅）；**15 个 zod 工具实测（10+5）、0 体素 0 UI**；`ai-server.ts:70` 拒客户端脚本 ✅；借道 = 越权面，端到端 **0 次**（U2）；地形/UI 写入需 **R1** |

### 9.4 主控转述与一手文档不符（A10 逐字核对结果，照实报告）

1. **分发字节**：转述 `531,307,875 B` → 一手文档 `impl/W4-...md` §11.5 = **`531,307,786 B`**（A10 用 catalog 三项复算 `240,669,370 + 203,712,541 + 86,925,875` = 531,307,786 ✅）。
2. **SyntaxError 归属文件**：转述"`check-image-budget.mjs` 连加载都 SyntaxError" → 一手 = 错误栈在 **`scripts/lib/budget.mjs:180`**（源头 `:146-150` JSDoc 的 `**/`），CLI 只是 import 它才被带崩；`check-image-budget.mjs` 自身的两个缺陷是 **`REPO_ROOT` 少一层** 与 **黑名单无消费者**。
3. **15 个工具的拆分**：转述"15 个"与源码 ✅，但一手 `plan/N2-...md` §1.1 自述"**11 个**（`createEntityTools`）+ **4 个**（`createScriptTools`）"，而其**具名列举**是 8 + 5 → 源码实测 **10 + 5 = 15**（`:254/321/346/446/468/501/609/655/676/685` + `:37/55/75/156/222`）。N2 该处需 A8 自纠。
4. **`compat-check.sh` 首轮"52 项 PASS"**：转述对（原文 `== PASS pass=52 fail=0 skip=0 ==`），但**检查项总数是 56**（基线 56 key，A10 复算 ✅），52 = 56 减去 4 条 WARN（accessor 23 / index 10 / client formula 30 / brokenInclude 1）→ 引用时两个数都要给，否则会被读成"只有 52 项"。
5. **`ANALYSIS-AND-PLAN.md` §3.4 那句"include 路径 `git ls-files` 0 命中"**（A6 初稿据此写下 G4 行）：一手 A9 实测是 **2 条 include 死 1 条**（另一条 `internals/schema/api/common.ts` 命中 1）→ 转述与一手不符之处已按 A9 写入 G4 行与矛盾 10/20。
6. **A1 的 Rust 行号是修复前口径**：转述照抄 `:93/:111`、`release_base():151-157` → 现网工作区（A1 修后）实测第二处修复落在 **`:113`**、`release_base()` 在 **`:155-160`**（+4 行位移）。
7. **一手文档内部不自洽 1 处（非转述问题）**：A9 §2.1 那行"任何人可复跑"的 awk，A10 原样跑出 `398formula=450`（`M` 含 ctor 重复计），与同文声称的 `398` 不符；`semantic=313` 复现 ✅。A2 §1.4 标题写"3 处 fail-open"而表列 5 行（小口径瑕疵）。**均未替他人圆场。**

### 9.5 仍开放、需要用户决策的事项（汇总；细目见 §7.2 #1–#22）

| # | 待决（不臆造、不代答） | 卡住 |
|---|---|---|
| 1 | **是否允许联网 + `rush update` re-lock + 重建镜像（至少 1 个 play）** | G1 的**全部**体积真数（88,176,940 B 目前只是未压缩 du，content/`/app`/gz 三口径一律 UNVERIFIED）+ G8 档一/二 + G9 的 R1 工具面 + A2 的 U5（`verify-workflow.test.js` 因 `js-yaml` 缺失根本没跑过） |
| 2 | **是否把 22 项未提交改动（实测 `11 M` + `11 ??`）checkpoint commit 到 `slim/local-deploy`（不 push）** | 一次误操作 `git checkout .` 就全丢；A1 的 E0277 修复、A2 的 6 个文件、A4 的验证现场都在未提交态 |
| 3 | **是否把 play-lite 定为交付主线**（4 容器 / 4 端口 / 零 docker.sock / 零常驻 root / 531,307,786 B −49.9%），还是保留双形态 | G5 的门禁对象（lite vs 主 compose）+ 矛盾 ⑬ 的 HANDOVER 回写 + 是否去改主 `docker-compose.yml`（7 容器根因） |
| 4 | **A8-D1：R1 是否批准**（引擎加 `/internal/ai-tool` + 4 个地形/UI 工具，~400 行） | G9"地形 + 界面全自动接管"唯一通路 |
| 5 | **A8-D2：借道越权面怎么修**（①先借道、记为已知风险 ②立刻显式化成 `projects.manage`，≈20 行同时修漏洞） | 9 项 scope 的最小权限承诺目前在这 5 条路由上**失效** |
| 6 | **A8-D3：U1（`/internal/*` 是否被 `localOnly` 403）是否允许一次实测**（可只在一次性克隆工程上做） | MCP 的落盘方式；不测则整个写链设计是猜 |
| 7 | **是否批准 G8 档一（4 套 theme 预设接线）**；档二（`pageConfig` 白名单令牌 + `formatVersion 1→2`）是否同时批 | G8 实现半径；且 `pageConfig` 是否触碰 `permissionHash` = UNVERIFIED（N1 §6-#6，生成处未定位）→ 与需求 3 的兼容性地基直接相关 |
| 8 | **是否把"作者自助改封面/标题"从 creator-only 放开给 play 服主**（`play-admin.ts:858-861` 现**主动禁止**，A10 已复核原文） | 改变现有安全语义，必须显式拍板 |
| 9 | **档三（作者写任意 HTML）是否彻底放弃**（A7 建议放弃：XSS / monkey-patch 基路径 / CSP 三重冲突） | G8 攻击面边界 |
| 10 | **A9-#1：是否授权一次受控真实进图**（人工点击约 2 分钟 + 只读 `docker logs` 取 `onPlayerJoin`）；**#2 是否授权一次性测试栈**；**#3 是否发布第 2 张 play-world**；**#4 是否授权那 1 行 tsconfig 修复** | L3 全层空白（G3 安全网唯一整层空白）；G4 后半 `.boxplay` 往返；单图样本撑不起"原有地图都能跑" |
| 11 | **是否授权把 `compat-check.sh --skip-http --skip-docker`（1.557 s）接进 `verify.yml`**（与体积门同一位置） | 兼容性门与体积门**当前都卡在"谁来改 workflow"**；A9 §7-#6 已请求 |
| 12 | **A2-U3/U4/U7/U8**：改 `release.yml`（contentBytes 阻断）、`repo-tasks.js` 补 1 行、`transition` 档何时切阻断（现超 **+66.7%**）、门与计划书以谁为准（**606.91 MiB vs ≤550 MiB**） | G1 防回归的**实际强度**与唯一判据 |
| 13 | **A1-D1/D2/D3**：bootstrap↔install.sh opt-in 口径走哪条、server-manager 更新链 + 桌面前端 + CSP 的内网镜像支持是否纳入本轮、SBOM/签名是否排期（A1 最低门槛建议：先给 `SHA256SUMS` 附 cosign/minisign） | G6 端到端闭环、G7 从 3/7 → 5/7 |
| 14 | **`release-context.test.js` 的 CRLF 红测处置**（改断言 = 碰他人文件；改检出方式 = 全仓影响） | 接 CI 后 `verify.yml` 会因它变红 |
| 15 | **4 容器 play-lite 的空闲 RSS / TTFB 何时在静默窗口复测**（A3/A9 均按纪律未测） | G2 的 lite 数字仍是 3 容器时代的 156.88 MiB；矛盾 ③④ 无法定门 |

### 9.6 本泳道纪律自证（A10）

- 可写文件**只有两个**：本文件（就地改写 + 追加 §9）与 `box3-re/ANALYSIS-AND-PLAN.md`（**只改** §3.4 headless 段、§3.1/§4.2 的 154 MB 预期列、§7 证据索引补条目；改动幅度刻意压到最小，原主张以删除线保留）。
- `box3-local-engine/` 源码目录：**全程只读**，仅执行 `grep -n` / `sed -n` / `wc -l` / `git status --short`（读）与一次 `awk` 只读复算 `box3-server-api.d.ts`；**未写入、未 commit、未 push、未 checkout**；A5b 正在改的 `apps/local-engine/src/launcher.js` **未触碰**。
- **未使用 Docker、未联网、未跑任何 RSS/TTFB/冷启动**；未改 `docker-compose.yml` / `BOX3-IMAGE-CATALOG.json` / `pnpm-lock.yaml`（catalog 与基线文件均为只读取值）。
- 他人交付文档（A1/A2/A4/A8/A9 的 impl 与 plan 文档）**一行未改**，其缺陷一律写在本记分板 §6/§9.4 里交回。
- 本泳道**亲自复核**并标注 ✅/❌ 的项：`creator-api-security.ts:105/141`、`player-service-client.ts:87-89`、`runtime-identity.ts:21-24`、`local-player-identity.ts:923`（+ `:915` PG 硬依赖）、`entity-tools.ts` 工具数 15（10+5）、`voxel` 命中 0、`ai-server.ts:70` 原文、`edit-server.ts:192`、`creator-cli-policy.ts:5-15` 九项、`project-manager.js:2442/1118/1127`、`play-worlds.ts:22+`（无 theme）、`index.tsx:1491` + `theme` 0 命中、`play-admin.ts:858-861`、`release_channel.rs` 修复后行位、`members.tsv` 2730 行与桶计数、`g3-baseline.tsv` 56 key、指纹 sha256 前缀、play-lite 三项 catalog 相加、A9 §2.1 awk 复跑（450）。**其余一律是引用他人原文或标 UNVERIFIED，未自跑者不冒充实测。**

