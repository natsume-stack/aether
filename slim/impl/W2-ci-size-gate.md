# W2 · CI 体积门接线（A2 泳道交付）

泳道：BOX3 本地引擎轻量化 / A2 CI 体积门
时间：2026-10-17 22:00（本地）
仓库：`D:\desktop\神奇代码岛\box3-local-engine` @ 分支 `slim/local-deploy`（未提交，遵守纪律未做任何 git 写操作）
运行环境：Windows + Node `v24.18.0`（`node -v` 实测），**未使用 Docker**（A3/A4 占用），**未使用 rush**

我实改的文件（全部在本泳道所有权内）：

| 文件 | 动作 |
| --- | --- |
| `scripts/lib/budget.mjs` | 修 1 个致命 SyntaxError（详见 §0.1） |
| `scripts/check-image-budget.mjs` | 修 REPO_ROOT、补黑名单消费者、堵 3 处 fail-open、加 4 个 CLI 开关 |
| `common/config/box3-image-budget.json` | **新增 `ratchet` 档**（数值 = `basis.observed` 原值）；`transition`/`target` 12 格数值逐字节未动（程序断言，见 §3.1） |
| `common/config/box3-image-blacklist.json` | 只读审查，**未改一个字节**（缺陷照实标注于 §3.3） |
| `.github/workflows/verify.yml` | 新增 `image-size-gate` job，裸 `node` 接线 |
| `scripts/check-image-budget.test.js` | 新增，19 条用例，`node --test` 直接可跑 |

---

## 0. 动手前必须先说的三个发现（别人的代码有缺陷，照实标注）

### 0.1 体积门此前**一次都没跑通过**：`lib/budget.mjs` 是语法错误状态

交接文档说"代码已在工作区但没接线"。实际情况更糟：**门连加载都失败**。

`scripts/lib/budget.mjs:146-150` 的 JSDoc 里写了 `` * which is what makes a leading `**/` mean ...``——注释文本里的 `*/` **提前闭合了块注释**，后面的注释正文被当代码解析，直到 180 行的模板字符串才炸：

```
$ node scripts/check-image-budget.mjs --self-test
file:///D:/.../box3-local-engine/scripts/lib/budget.mjs:180
    const compiled = new RegExp(`${source}$`);
                                 ^

SyntaxError: Unexpected identifier '$'
EXIT=1
```

最小复现（`C:\Users\Natsume\AppData\Local\Temp\box3-a2\repro.mjs`，4 行）：

```
/**
 * a leading `**/` means x
 */
const a = 1;
$ node --check repro.mjs
SyntaxError: Unexpected end of input
```

我把那段 JSDoc 改写为不含 `*/` 的措辞（只动注释，不动逻辑），现在：

```
$ node --check scripts/lib/budget.mjs && node --check scripts/check-image-budget.mjs
BUDGET_LIB_OK
CLI_OK
```

旁证：同一批新增的其它 `.mjs` 没有这个问题（`prune-standalone.mjs`/`subset-fonts.mjs`/`tag-images-from-catalog.mjs`/`runtime-memory.mjs` 全部 `node --check` OK）——只有这条共享库中招，所以整条 W1/W2 产物链此前是死的。这也解释了为什么"没有 .test.js"是致命的：一条语法错误活了两天没人发现。

### 0.2 裸 `node scripts/check-image-budget.mjs` 原样必红：默认配置路径算错一层

`REPO_ROOT = path.join(import.meta.dirname, '..', '..')` → 解析到 **仓库外**的 `D:\desktop\神奇代码岛`，默认预算表因此永远找不到：

```
$ node scripts/check-image-budget.mjs --catalog D:/.../box3-re/_manifest/BOX3-IMAGE-CATALOG.json
体积门无法运行：缺少文件：D:\desktop\神奇代码岛\common\config\box3-image-budget.json
EXIT=2
```

改为 `'..'`（`scripts/` 的父目录即仓库根）后同一命令正常求值。

### 0.3 黑名单表**没有任何消费者**

`common/config/box3-image-blacklist.json`（106 行、10 条规则）在全仓 grep 只出现在 3 处：它自己、`lib/budget.mjs` 的文件头注释、以及预算表的一句说明文字。注释里提到的 `check-image-blacklist.mjs` **文件不存在**：

```
$ ls scripts | grep -iE "budget|blacklist"
check-image-budget.mjs
budget.mjs（在 scripts/lib/）
```

即 §3.1 那份 154 MB 构建工具清单（@swc/core 48 / typescript 33 / babel 31 / esbuild 11 / sass 4 / AMP 4 / sql.js debug 22.7）此前只是 JSON 里的数字，**没有代码会去镜像树里核对**。由于 `check-image-blacklist.mjs` 不在我的文件所有权内，我没有新建它，而是把黑名单子门实现进了我拥有的 `check-image-budget.mjs`（`loadBlacklist` / `scanBlacklistTree` / `runBlacklist`），并复用 `budget.mjs` 里原本**无人调用**的 `globToRegExp` / `walkTree` / `subtreeBytes` 三个helper——它们本来就是为这件事写的。

---

## 1. 接线路径

### 1.1 为什么必须是新 job、且绝不能碰 rush

`package.json` 改了 prod/dev 而 `common/config/rush/pnpm-lock.yaml` 没同步（交接文档 §3.3），任何 `rush install` 都会红。体积门如果挂在既有 `verify` job 的第 3 步之后，就永远不会有输出——门会被一条坏掉的依赖链焊死。所以：

- **既有 `verify` job 一行没动**（含 `jobs.verify.if` 与 `on.push.branches`，`verify-workflow.test.js` 依赖这两处）；
- 新 job `image-size-gate` 只有 `checkout` + `setup-node` + **裸 `node`**，全 job 正文不含 `install-run-rush.js` / `rush install`（这条断言被写成了测试，防回潮）。

### 1.2 一个入口、两道子门

```
node scripts/check-image-budget.mjs   ← CI 里唯一被调用的门脚本
├─ 体积子门（size）      吃 --docker / --catalog / --images-dir / --measurements
│                        逐服务比 contentBytes/archiveBytes，另跑 basis 棘轮比较
└─ 黑名单子门（blacklist）吃 --tree / --trees-dir（已解包的 /app 目录树）
                           按 glob 命中构建工具，按 byService 定上限
退出码：0 通过 / 1 违规 / 2 配置错误 / 3 无可测输入
```

### 1.3 verify.yml 的 10 个 step（`image-size-gate`）

| # | step | 阻断性 | 本机是否验证过 |
| --- | --- | --- | --- |
| 1 | Checkout | — | 不适用 |
| 2 | Set up Node.js（`node-version-file: .node-version` = 22.17.0） | — | 不适用 |
| 3 | `node --test scripts/check-image-budget.test.js` | **阻断** | ✅ 19/19 绿 |
| 4 | `node scripts/check-image-budget.mjs --self-test` | **阻断** | ✅ exit 0 |
| 5 | 定位 catalog（`BOX3_IMAGE_CATALOG` 或 `release/BOX3-IMAGE-CATALOG.json`） | — | ✅ 本地用真实清单验证 |
| 6 | `--catalog … --tier ratchet --require size` | **阻断**（出厂态必绿、任何增长必红） | ✅ 见 §2 |
| 7 | `--catalog … --tier transition --require size` | `continue-on-error`（W1/W3 落地前对出厂字节必然为红，只做进度指示） | ✅ 见 §2 红(a) |
| 8 | 定位镜像树（`BOX3_IMAGE_TREES_DIR` 或 `release/image-trees`） | — | ✅ 本地用合成树验证 |
| 9 | `--trees-dir … --require blacklist` | **阻断** | ✅ 见 §2 红(b) |
| 10 | 汇报本次究竟有没有真实产物输入（`::notice::`） | 非阻断 | 逻辑分支已覆盖 |

**关键取舍（不是偷懒）**：出厂 v2026.1.4 的真实字节**超不过 transition 档**（超 +66.7%，见 §3.2），所以过渡档一接上就是每 PR 全红——那种门三周内就会被当成噪音关掉。我的接法是：**棘轮档阻断**（今天就能拦住"上游把字节涨回来"，且出厂态为绿），**过渡档报告**（把 -40% 的差距量化成进度，W1/W3 落地后把它切成阻断）。两档并存，谁在挡什么写得很明白。

### 1.4 本泳道顺手堵掉的 3 处 fail-open（原代码逻辑，非我引入）

| 漏洞 | 原行为 | 现行为 |
| --- | --- | --- |
| `--services play` 子集仍去比 `aggregate`（6 服务总预算） | 1 个服务的字节 vs 6 个服务的额度 → **永远绿** | 子集时合计档只打印 `SKIP(子集)`，不参与判定 |
| 测到了字节、但该档位没写上限 | `Number.isSafeInteger(budget)` 为假 → 静默 OK | 红：`NO-BUDGET`，"测到 X B 却没有预算可比"（显式写 `null` 才是"只报告"） |
| catalog 里出现预算表未声明的镜像 | `notes.push('…忽略')` 后 `continue` | 红：`产物里出现了预算表未声明的镜像 …`。这条最要命：**上游加一个新镜像、没人改预算表，门就对它完全没有约束**，正是"只会加不会减"的形态 |
| 请求了 6 个服务但只测到 5 个（镜像漏 load / catalog 漏条目） | 缺的那个当 `SKIP`，整体可绿 | 红：`体积子门数据不完整：…`（要放行需显式 `--allow-partial`） |
| 子门因缺输入没跑 | 无提示 | `--require size,blacklist` 时变违规；不 require 时打 `::warning::`，绝不静默 |

另：无任何输入源时原代码返回退出码 3 但**一行都不打印**，CI 里只看到"红了但不知道为什么"。现在会明确输出原因。

---

## 2. 红 / 绿演示（原文命令 + 原文输出 + 退出码）

真实输入用的是只读的 `box3-re\_manifest\BOX3-IMAGE-CATALOG.json`（**未改**，文件时间戳仍是 `2026-10-17 00:07`、5,514 B）。合成临时输入都在系统临时目录 `C:\Users\Natsume\AppData\Local\Temp\box3-a2\`，仓库里没有留下任何垃圾文件。

### 🟢 绿 1 —— 真实出厂 catalog + 棘轮档，退出码 0

```
$ cd D:/desktop/神奇代码岛/box3-local-engine
$ node scripts/check-image-budget.mjs --catalog "D:/desktop/神奇代码岛/box3-re/_manifest/BOX3-IMAGE-CATALOG.json" --tier ratchet --require size
体积门 tier=ratchet，服务=creator, voxa, play, player-service, player-auth-portal, server-manager，体积子门=RUN，黑名单子门=SKIP
  · catalog: D:/desktop/神奇代码岛/box3-re/_manifest/BOX3-IMAGE-CATALOG.json（imageTag=v2026.1.4-linux-amd64）
  · UNAVAILABLE blacklist: 没有 --tree / --trees-dir，黑名单子门未运行
服务                  指标            实际                    实际字节  预算                    预算字节    超标%  结果
------------------  ------------  -----------  -------------  -----------  -------------  -----  ----
creator             archiveBytes  250.84 MiB     263,029,978  250.84 MiB     263,029,978  +0.0%  OK
voxa                archiveBytes  173.93 MiB     182,383,424  173.93 MiB     182,383,424  +0.0%  OK
play                archiveBytes  229.52 MiB     240,669,370  229.52 MiB     240,669,370  +0.0%  OK
player-service      archiveBytes  194.28 MiB     203,712,541  194.28 MiB     203,712,541  +0.0%  OK
player-auth-portal  archiveBytes   82.90 MiB      86,925,875   82.90 MiB      86,925,875  +0.0%  OK
server-manager      archiveBytes   80.04 MiB      83,924,951   80.04 MiB      83,924,951  +0.0%  OK
合计(6)               archiveBytes  1011.51 MiB  1,060,646,139  1011.51 MiB  1,060,646,139  +0.0%  OK

体积回归：全部在预算内，且没有黑名单命中。
exit=0
```

（contentBytes 全是 `SKIP/未测量`：本 workflow 不 `docker load`，见 §4 未证项 U3。）

### 🟢 绿 2 —— 测试套件与自检

```
$ node --test scripts/check-image-budget.test.js
ℹ tests 19
ℹ pass 19
ℹ fail 0
TEST_EXIT=0

$ node scripts/check-image-budget.mjs --self-test
1) 干净副本（预算内 1 MiB 余量）                        20,905,984  20,905,984  GREEN  GREEN  PASS
2) 故意塞进 1 MiB 垃圾到 content 测量值                 21,954,560  20,905,984  RED    RED    PASS
3) 1 MiB 垃圾只进了 tar.gz，catalog.size 未同步（完整性） 20,905,984  21,954,560  RED    RED    PASS
4) 未超预算但比基线长大（回归棘轮）                       20,905,985  20,905,984  RED    RED    PASS
自测通过：+1 MiB 垃圾一定会让门变红。
SELFTEST_EXIT=0
```

### 🔴 红 (a) —— 总和超预算：把上游 `v0.3.0 → v2026.1.4` 的 +120 MB 原样重放一遍

输入 `Temp/box3-a2/upstream-growth.json` 由**配置自己的字段**推导，不是我编的数：每个服务的 `contentBytes = basis.observed + (observed − previousReleaseObserved)`，即"下一次升级再涨同样的量"。回放增量合计 **+120,139,437 B**（2,736,210,446 → 2,856,349,883）。

```
$ node scripts/check-image-budget.mjs --measurements "C:/Users/Natsume/AppData/Local/Temp/box3-a2/upstream-growth.json" --tier ratchet
合计(6)               contentBytes  2.66 GiB     2,856,349,883  2.55 GiB     2,736,210,446  +4.4%  OVER
合计(6)               archiveBytes  1011.51 MiB  1,060,646,139  1011.51 MiB  1,060,646,139  +0.0%  OK

体积回归：7 项违规
  ✗ creator contentBytes 699,771,478 B 超过 ratchet 预算 678,713,391 B（超 21,058,087 B，+3.1%）
  ✗ voxa contentBytes 522,771,758 B 超过 ratchet 预算 483,753,236 B（超 39,018,522 B，+8.1%）
  ✗ play contentBytes 636,983,041 B 超过 ratchet 预算 615,942,850 B（超 21,040,191 B，+3.4%）
  ✗ player-service contentBytes 532,602,748 B 超过 ratchet 预算 512,534,379 B（超 20,068,369 B，+3.9%）
  ✗ player-auth-portal contentBytes 230,446,802 B 超过 ratchet 预算 230,350,033 B（超 96,769 B，+0.0%）
  ✗ server-manager contentBytes 233,774,056 B 超过 ratchet 预算 214,916,557 B（超 18,857,499 B，+8.8%）
  ✗ aggregate contentBytes 2,856,349,883 B 超过 ratchet 预算 2,736,210,446 B（+4.4%）
exit=1
```

同一份真实 catalog 打在 **transition 档**（第 7 步，报告性质）也是红，量化了"瘦多少才算达标"：

```
$ node scripts/check-image-budget.mjs --catalog "…/BOX3-IMAGE-CATALOG.json" --tier transition --require size
creator archiveBytes 263,029,978 B 超过 transition 预算 157,817,986 B（超 105,211,992 B，+66.7%）
…
aggregate archiveBytes 1,060,646,139 B 超过 transition 预算 636,387,683 B（+66.7%）
体积回归：7 项违规
exit=1
```

### 🔴 红 (b) —— 镜像树里含黑名单构建工具

合成树 `Temp/box3-a2/trees/play/`（刻意造出"上游把工具带回来"的样子）：

```
node_modules/.pnpm/@swc+core@1.4.13/node_modules/@swc/core-linux-x64-gnu/core.node
node_modules/.pnpm/typescript@5.6.3/lib/tsc.js
node_modules/.pnpm/@babel+core@7.24.0/lib/index.js
node_modules/.pnpm/esbuild@0.21.5/bin/esbuild
node_modules/.pnpm/sass@1.70.0/sass.dart.js
node_modules/sql.js/dist/{sql-asm-debug.js, sql-asm.js, sql-asm-memory-growth.js, sql.js.zip}
apps/game/.next/server/chunks/static/media/ChillRoundGothic-Bold.ttf   ← 字体双拷贝
apps/game/.next/static/media/ChillRoundGothic-Bold.ttf
apps/game/.next/static/vs/editor/editor.main.js                        ← Monaco
```

```
$ node scripts/check-image-budget.mjs --trees-dir "C:/Users/Natsume/AppData/Local/Temp/box3-a2/trees" --require blacklist
play     swc-core                1    0  4.00 KiB    4,096  BLACKLIST
play     typescript              1    0  2.00 KiB    2,048  BLACKLIST
play     esbuild                 1    0  512 B         512  BLACKLIST
play     sass                    1    0  2.00 KiB    2,048  BLACKLIST
play     babel                   1    0  512 B         512  BLACKLIST
play     sqljs-debug             1    0  4.00 KiB    4,096  BLACKLIST
play     sqljs-asm-variants      3    1  12.00 KiB  12,288  BLACKLIST
play     sqljs-zips              1    0  512 B         512  BLACKLIST
play     next-font-double-copy   1    0  4.00 KiB    4,096  BLACKLIST
play     monaco-vs               1    0  2.00 KiB    2,048  BLACKLIST

体积回归：10 项违规
  ✗ play (…) 黑名单 swc-core（@swc/core 原生二进制（编译期工具，运行期用不到））命中 1 项，上限 0，合计 4,096 B：node_modules/.pnpm/@swc+core@1.4.13
  ✗ play (…) 黑名单 sqljs-asm-variants（…只能留 1 个）命中 3 项，上限 1，合计 12,288 B：…
exit=1
```

对照：同目录下的 `trees/creator/` 是合规树（只留 1 个 sql.js 变体 + 单副本字体），单独扫它 `exit=0`；`monaco-vs` 在 creator 上 `maxEntries: null` 生效为"只报告"，在 play 上被 `byService` 覆盖成 0 → 红。命中按**目录单元折叠**：一个 `.pnpm/@swc+core@1.4.13` 包只算 1 项，不会把包内每个文件重复计数。

---

## 3. 阈值审查：是拍的脑袋还是从 1011.5 MiB 基线推的？

### 3.1 结论：**数值是从基线机械推导的，但"打几折"这个折扣本身没有证据链**

程序化核对（12 格全过，断言已固化进测试）：

```
transition == floor(basis.observed * 0.60)   ← 12/12 精确成立
target     == floor(basis.observed * 0.45)   ← 12/12 精确成立
ratchet    == basis.observed 原值             ← 12/12 精确成立（我新增的档）
aggregate archiveBytes ratchet == 1,060,646,139 == 六归档之和（= 交接文档的 1011.5 MiB）
```

所以"从 1011.5 MiB / 2.74 GB 基线推的"这半句成立；"-40% / -55%"这两个折扣是**目标倒推**（对齐 `ANALYSIS-AND-PLAN.md` 的 ≤550 MiB / ≤1.4 GB），不是" identified 可省字节加总等于这个数"。

我**没有修改任何既有阈值**：

```
$ node -e "…逐格比对改动前的 12 组 transition/target 数字…"
EXISTING_TIERS_UNCHANGED= true
```

注：`common/config/box3-image-budget.json` 在 `git status` 里是 `??`（W1 新建、从未提交），所以 `git diff` 拿不到旧值，我用改动前读到的 12 组数字做了程序断言而非依赖 diff。

### 3.2 阈值与"已证明能删掉的字节"严重不匹配（最重要的一条）

`过渡档要求删的 contentBytes` vs `basis.measuredRemovableBytes`（黑名单逐规则 `measured` 所支撑的那部分）：

| 服务 | 现状 content | transition 档 | 要求删除 | 已证明可删 | **缺口** | 可删占比 |
| --- | --- | --- | --- | --- | --- | --- |
| creator | 678,713,391 | 407,228,034 | 271,485,357 | 138,393,952 | **133,091,405** | 20.4% |
| voxa | 483,753,236 | 290,251,941 | 193,501,295 | 128,358,637 | **65,142,658** | 26.5% |
| play | 615,942,850 | 369,565,710 | 246,377,140 | 138,393,952 | **107,983,188** | 22.5% |
| player-service | 512,534,379 | 307,520,627 | 205,013,752 | 88,497,820 | **116,515,932** | 17.3% |
| player-auth-portal | 230,350,033 | 138,210,019 | 92,140,014 | **0** | **92,140,014（100%）** | 0.0% |
| server-manager | 214,916,557 | 128,949,934 | 85,966,623 | **0** | **85,966,623（100%）** | 0.0% |

三个后果，写死在这里免得日后互相甩锅：

1. **过渡档目前不可达**。四个 JS 镜像里，黑名单能证明的部分只覆盖要求删除量的 17–27%；剩下要靠 `outputFileTracingRoot` 收窄、跨镜像去重、distroless base —— 全都不是 prune 一条能解决的。W1/W3 之后如果只做了 prune 就把 step 7 切成阻断，CI 会红且没人能当场解释。
2. **auth-portal / server-manager 的 40% 全靠换基础镜像**。这两个服务 `measuredRemovableBytes = 0`（黑名单 10 条规则对它们一条都不命中），要达标只能走 `S1 §2(e)` 的 distroless。这跟 `B-size-audit` 那句"应用本体 280 KB、镜像 230 MB"是同一件事：**它们的胖不在 app 层，在 base 层。**
3. **过渡档比计划书的 P0 目标还松**。`aggregate.archiveBytes.transition = 636,387,683 B = 606.91 MiB`，而 `ANALYSIS-AND-PLAN.md` 写的是"分发 ≤550 MiB"（=576,716,544 B）；`target` 档 477,290,762 B = 455.17 MiB 反而比计划更紧。门与计划书的目标值不是同一个数，**得由用户/A6 敲定以哪个为准**，我没有擅自改。

另外两处口径小坑：
- `aggregate.transition` 与六个分项之和差 2 B（`floor(总量×0.6)` vs `Σfloor(单项×0.6)`）：content `1,641,726,267` vs `1,641,726,265`；archive `636,387,683` vs `636,387,681`。无害（合计档略松 2 B），但它说明两个数是分别算的，将来改单项忘了改合计不会有人发现。
- `basis.measuredRemovableBytes` 的注释写"**W2 在现役镜像内实测到的**黑名单命中字节"。这条主张**不是我做的**：本泳道禁 Docker，我一次都没扫过真镜像。它要么是 W1/B 泳道的转述，要么是冒名，见 U2。

### 3.3 黑名单表自身的两处可疑（只标注，未改）

1. **`measured` 加总 ≠ 预算表声称的可删字节**：

| 服务 | Σ(黑名单各规则 measured) | basis.measuredRemovableBytes | 差 |
| --- | --- | --- | --- |
| creator | 145,230,998 | 138,393,952 | −6,837,046 |
| voxa | 128,358,637 | 128,358,637 | 0 |
| play | 132,277,187 | 138,393,952 | **+6,116,765（声称值比自身规则总和还大）** |
| player-service | 101,451,631 | 88,497,820 | −12,953,811 |

   且 play 与 creator 的 `measuredRemovableBytes` **完全相等**（都是 138,393,952），而两份镜像的规则命中集合明显不同（creator 有 Monaco 12,953,811、play 没有）→ 高度疑似复制粘贴。差值 12,953,811 恰是 Monaco 的大小，进一步支持这个判断。

2. **每条规则里 `glob` 与 `find` 是两份真相**。扫描器只吃 `glob`（文件系统扫描，纯 CPU，能在 CI 跑）；`find`（容器内 `find -type d -name …` 规格）**没有任何代码消费**。改了 `find` 忘了 `glob`（或反之）不会有任何检查发现。我没有删 `find`（它是有用的容器侧对照），但把它标成"文档字段"。

3. `monaco-vs` 规则的 `note` 里写"creator 与 player-service 仍各有一份 12,953,811 B"——`measured.player-service = 12,953,811` 与之一致；但 `S1 §1` 与 `ANALYSIS-AND-PLAN §3.1` 对 play 的结论是"v2026.1.4 已无 static/vs"，`measured.play = 0` 一致。这两条不冲突，**但交接文档 §2.2 说 play-lite 已实测，本泳道无法复用其镜像**（禁 Docker），所以我只能确认配置内部自洽，不能确认真镜像里没有。

### 3.4 这道门现在到底拦不拦得住"上游把字节涨回来"？

**拦得住，但有一个时间窗口的洞，且洞不在我以为的地方。**

| 回归形态 | 拦得住吗 | 靠什么 | 证据 |
| --- | --- | --- | --- |
| 已有 6 个镜像各自变大（0.3.0→2026.1.4 这种） | ✅ | `ratchet` 档 + `growthToleranceBytes: 0` 棘轮 | §2 红(a)：+120 MB 重放 → 7 项违规、exit 1 |
| 单个镜像涨 1 字节 | ✅ | 同上（棘轮是逐服务逐指标的） | 测试「回归棘轮：比基线大 1 字节也必须红」✔ |
| 裁剪后又把构建工具塞回来（@swc/core/typescript/babel/esbuild/sass/sql.js debug） | ✅ | 黑名单子门 | §2 红(b)：10 项违规、exit 1 |
| **上游新增第 7 个镜像** | ✅（原本 ❌ 静默忽略） | 我加的"未声明镜像即红" | 测试「上游新增一个预算表没有的镜像必须红」✔ |
| **瘦身后不再继续瘦身（停在 500 MB 就躺平）** | ❌ | 棘轮的参照是**出厂** 678 MB，不是"历史最优" | 见下方薄弱点 W1 |
| **content 字节涨、但 tar.gz 归档字节没涨**（层结构变化/压缩率变化） | ❌（在只喂 catalog 的路径下） | `contentBytes` 需 `docker image inspect`，本 workflow 拿不到 | 见 U3 |

**薄弱点 W1（最需要用户决策的一条）**：`basis.observed` 钉死在出厂值，棘轮**不会随瘦身自动下移**。W1/W3 把 play 从 615 MB 砍到 400 MB 之后，棘轮的参照还是 615 MB —— 下次升级涨回 500 MB 依然是绿灯。真正在守线的是 `transition` 档预算（绝对天花板）。所以：
- **每次瘦身落地，必须同步下移 `basis.observed`（以及 `ratchet`/`transition`/`target` 三档）**，这是一次可评审的配置提交，不是自动行为。当前没有 `--update-basis` 之类的工具，我建议**故意不做**（自动改预算表 = 让回归门自己给自己放水），改由人工 + 测试断言兜住（`ratchet === observed` 已经是断言）。

---

## 4. 测试覆盖矩阵（`scripts/check-image-budget.test.js`，19 条，`node --test` 全绿）

跑法与仓库惯例一致（`build-image-downloads.test.js` 同款：CommonJS + `node:test` + `node:assert/strict`，临时文件落 `os.tmpdir()`，CLI 契约用子进程取**真实退出码**）：

```
node --test scripts/check-image-budget.test.js     # 19 tests / 19 pass / 0 fail，exit 0
```

| # | 用例 | 断言的失败模式 | 期望退出码 |
| --- | --- | --- | --- |
| 1 | 超预算必须红 | 逐服务 + 指标 + 超出字节点名 | 1 |
| 2 | 合规输入必须绿 | 正向路径不假红 | 0 |
| 3 | 回归棘轮：+1 B 即红 | "只准减不准加" | 1（等值时 0） |
| 4 | 命中黑名单构建工具 | @swc/core、typescript、babel、esbuild、sass、sql.js debug/变体/zip、字体双拷贝、Monaco 全中；目录单元折叠不重复计数 | 1 |
| 5 | 合规镜像树必须绿 | 单变体 + 单副本不误伤 | 0 |
| 6 | `maxEntries: null` 只报告；`byService` 覆盖后上 0 即红 | 规则粒度可被绕过 | 0 / 1 |
| 7 | **配置缺失必须明确报错** | 预算表缺、黑名单缺、树目录缺、无输入源 | 2 / 2 / 1 / 3，且必须打中文原因 |
| 8 | **预算表字段非法** | schema 错/缺、无 transition 档、services 空、负数、非整数、无指标、未知档位 | 全 2；一律 `assert.notEqual(code, 0)` 防"静默通过" |
| 9 | **黑名单字段非法** | schema 错、规则空、glob 不以 `**/` 开头、重复 id、maxEntries 非整数、缺 label | 全 2 |
| 10 | 档位缺上限不得静默放行 | `NO-BUDGET` | 1 |
| 11 | catalog 漏一个镜像不得变绿 | `--allow-partial` 是唯一逃生口 | 1 / 0 |
| 12 | `--services` 子集不能蒙混合计档 | 子集时 aggregate 不参与判定 | 0 且无 aggregate 违规 |
| 13 | `--require` 把"子门没跑"变违规 | 静默跳过 | 1；`--require oops` → 2 |
| 14 | `--out` 机读报告 | 其它泳道可消费 | 报告 schema/violations/images 齐全 |
| 15 | `--self-test` 本身为绿且 4 个场景全 PASS | 门坏了但没人知道 | 0 |
| 16 | **仓库默认配置自洽** | ratchet≡observed、transition≡floor(×0.6)、target≡floor(×0.45)、aggregate≡Σ、黑名单 measured/byService 服务名合法、154 MB 清单里的 5 个工具都在表内 | 0 |
| 17 | 真实出厂 catalog：ratchet 绿 / transition 红 | 接线方向没反（-40% 尚未达成是事实，不是 bug） | 0 / 1 |
| 18 | **CI 已接线** | verify.yml 里没有 `image-size-gate`、缺任一 node 命令、出现 `install-run-rush.js` / `rush install`、`jobs.verify` 被动过 | 0（任一不满足即红） |
| 19 | 上游新增未声明镜像必须红 | 免检通道（§1.4 第 3 行） | 1 / 0 |

未覆盖（诚实列出）：`--docker` 路径没有测试（本泳道禁 Docker，无法产生可信的镜像桩）；`--images-dir` 只测了"归档在磁盘不存在"的分支。

---

## 5. 未证项 / 遗留（UNVERIFIED，需主控或用户处置）

| ID | 未证内容 | 为什么这轮没做 | 需要谁 |
| --- | --- | --- | --- |
| U1 | GitHub Actions 上的真实运行结果 | 本机不是 runner，只验证了每个 step 命令在本地 node 24 下的**输出与退出码**（§1.3 表 5 列已逐项标 ✅） | 需 push（本泳道禁） |
| U2 | `basis.measuredRemovableBytes` 注释声称的"W2 实测" | 本泳道禁 Docker、一次没扫过真镜像；我给的黑名单证据是**合成树**。真镜像里逐规则命中字节 == 配置 `measured` 数字，未证 | A4（有镜像树）跑 `--trees-dir` 即可证 |
| U3 | `contentBytes` 半边门从未被真实求值 | `contentBytes` 来自 `docker image inspect`；verify.yml 不建镜像也不 load 镜像 → 本 workflow 里它永远 `SKIP`。**真正的按 content 字节阻断必须挂进 `release.yml` 的 images job**（`--docker --catalog`），该文件不在我所有权内 | 主控决定：授权我/他人改 release.yml |
| U4 | `scripts/repo-tasks.js` 的测试清单没有我的测试文件 | 该文件不在我所有权内（8 泳道并行）。现在 `rush test` **不会**跑 `check-image-budget.test.js`，只有 CI 新 job 直跑。需在 `repo-tasks.js:110` 那一组 `--test` 里加一行 `'scripts/check-image-budget.test.js'` | 主控/有该文件所有权者（1 行） |
| U5 | 既存 `scripts/verify-workflow.test.js` 会不会被我改动打红 | 本机跑不了：`Cannot find module 'js-yaml'`（`node_modules` 空，re-lock 未做）。我用 python-yaml 解析器核过 YAML 合法、`jobs.verify.if` 与 `on.push.branches` 原文未变，**但该测试本身未跑过** | re-lock 后由 `rush test` 验 |
| U6 | `.node-version` = 22.17.0，我本机 node 是 24.18.0 | 门脚本只用 `node:fs/os/path/process/url` + `import.meta.dirname`（node 20.11+）与 `node --test`，22.x 应可用，**但没在 22.x 上实跑过** | CI 首跑即证 |
| U7 | 是否把第 7 步（transition 档）切成阻断 | 取决于 W1/A4 的 prune 实际字节；切成阻断前需先确认 §3.2 的 133 MB 缺口怎么补 | 用户在 GATES 记分板后决策 |
| U8 | `ANALYSIS-AND-PLAN.md` §4.2 写的 P0 目标 ≤550 MiB 与门里 606.91 MiB 不一致 | 我**没有**动任何一边：门与计划书的数字谁向谁对齐，属跨泳道口径决策 | A6 记分板 + 用户 |
| U9 | 新增 `ratchet` 档是我加的**新数值档**（12 格 + 2 格合计） | 数值全部等于配置里已有的 `basis.observed`，没发明任何一个字节，且 §3.1 有程序断言；但"新增一档"仍属配置面变更，需主控知情。`transition`/`target` 12 格经断言逐字节未变 | 主控确认 |

纪律自证：全程未用 Docker、未跑 `rush install`/`update`、未 `git commit`/`push`/`checkout`、未改 `docker-compose.yml`、未改 `BOX3-IMAGE-CATALOG.json`（时间戳仍 2026-10-17 00:07、5,514 B）、未改 `pnpm-lock.yaml`、未改任何 `package.json`、未改 `box3-image-blacklist.json` 一个字节。`git status --porcelain` 里除我 6 个文件外全是别的泳道的改动，我没有触碰。

---

## 6. 一键复跑（红/绿四连）

```bash
cd D:/desktop/神奇代码岛/box3-local-engine
CAT="D:/desktop/神奇代码岛/box3-re/_manifest/BOX3-IMAGE-CATALOG.json"

# 绿：真实出厂 catalog 打在棘轮档
node scripts/check-image-budget.mjs --catalog "$CAT" --tier ratchet --require size      # exit 0
# 红 (a)：过渡档（-40% 尚未达成）
node scripts/check-image-budget.mjs --catalog "$CAT" --tier transition --require size   # exit 1
# 红 (a')：回放上游 +120 MB（先按 §2 的命令生成 measurements，或直接把 observed 当测量值再加 delta）
node scripts/check-image-budget.mjs --self-test                                          # exit 0（4 场景全 PASS）
# 绿/红 (b)：黑名单
node --test scripts/check-image-budget.test.js                                           # 19/19 绿
```
