# O2 · 全局代码质量与可复用性体检（C2 泳道）

生成：2026-10-18 ｜ 作者：C2 agent（全局代码质量 / 可复用性度量）
取证对象：`D:\desktop\神奇代码岛\box3-local-engine`（分支 `slim/local-deploy`，`git status --porcelain` = **0 行**，工作树干净）
上游版本：`package.json:3` `"version": "2026.1.4"`，MIT（`LICENSE.md`）

**纪律自证**：本轮 **未修改任何源码**（`git status` 干净 + 只读命令）；未装工具链、未 `rush/pnpm install`、未起容器、未打负载、未联网。所有度量用 `git ls-files` + `grep` + `awk` + `wc` + `md5sum` + 一个临时 node 脚本（`%TEMP%/o2-fnlen.cjs`，非仓库文件）完成。**每条度量后面都跟可复跑命令。**

先读对齐：`box3-re/ANALYSIS-AND-PLAN.md` §2.2 §3.3、`box3-re/C-architecture.md` §10、`box3-re/src/S2-runtime-hotpath.md` §4 §9、`box3-re/impl/GATES.md` §1 §9、`box3-re/impl/G3-map-compat-baseline.md` §2.4。

---

## 0. 口径：什么叫"源码"

仓库 8,623 个 tracked 文件里混了四类东西，不分开的话所有度量都是假的：

```bash
cd /d/desktop/神奇代码岛/box3-local-engine
git ls-files | wc -l                                                     # 8623
git ls-files | grep -E '\.(ts|tsx|js|jsx|mjs|cjs)$' | wc -l              # 4509  全部代码文件
```

| 口径 | 定义 | 文件 | 行 |
|---|---|---|---|
| **全代码** | 所有 tracked `.ts/.tsx/.js/.jsx/.mjs/.cjs` | 4,509 | **678,009** |
| **手写源码（本文口径）** | 减去 `build/` `dist/` `generated/`、`packages/icons`、`packages/regl`、`packages/voxa-project`、`packages/vb-parser`、`packages/utils`、`packages/sdk`、`packages/content-server`、`packages/mesher`、`packages/ao-mesher`、`packages/box-design`、`packages/rewgpu` 的 `build/dist`、`internals/build-system/squoosh/codecs`、`apps/game/scripts/assets/{api,client_api}`、`services/game-server/src/assets/isolate`、`types/*.d.ts` | **2,989** | **449,057** |
| 生成/入库产物 | 上面被减掉的部分 | 1,520 | 228,952 |
| 其中：**入库的编译产物**（`build/`+`dist/` 目录） | — | 1,067 | **109,274** |

```bash
git ls-files | grep -E '\.(ts|tsx|js|jsx|mjs|cjs)$' | xargs -d '\n' -n 400 wc -l \
  | grep -v ' total$' | awk '{s+=$1} END{print s}'                       # 678009
# 手写口径的清单文件（后文统称 $H）
git ls-files | grep -E '\.(ts|tsx|js|jsx|mjs|cjs)$' \
 | grep -vE '(^|/)(build|dist|generated|node_modules)/' | grep -v squoosh \
 | grep -vE '^packages/(icons|regl|voxa-project|vb-parser|utils|sdk|content-server|mesher|ao-mesher|box-design|rewgpu)/' \
 | grep -vE 'scripts/assets/(api|client_api)/' | grep -vE 'src/assets/isolate/' | grep -vE '^types/' > $H
wc -l < $H; xargs -a $H -d '\n' -n 400 wc -l | grep -v ' total$' | awk '{s+=$1} END{print s}'   # 2989 / 449057
```

**任务书里"47 万行 / 34 project / 8486 文件"复核**：手写源码 449,057 行 ✅（≈47 万）；`rush.json` projects = **34** ✅；tracked 文件 8,623（8486 是镜像内口径，差 137 = 我们 fork 新增的 `slim/` 123 + `.gitattributes` 等）。

### 0.1 每模块行数与文件数（手写口径，含上游引擎）

| 行 | 文件 | 模块 | 本轮复核 |
|---|---|---|---|
| 202,216 | 1,204 | `apps/game` | 与 §2.2 的 202,211 一致（±5 = 我们 fork 的改动） |
| 83,417 | 287 | `services/game-server` | vs 83,357 ✅ |
| 59,975 | 328 | `apps/voxa` | vs 59,961 ✅ |
| 40,536 | 439 | `packages/mudb` | vs 40,536 ✅ —— **但见 §2.7：其中 15,902 行是入库 JS** |
| 36,337 | 158 | `internals/schema` | ✅ |
| 34,933 | 104 | `packages/voxa-project` | vs 34,886 ✅（几乎全是 `build/`） |
| 31,892 | 432 | `internals/build-system` | ✅ |
| 11,540 | 51 | `apps/local-engine` | launcher+project-manager 全在这里 |
| 11,109 | 141 | `packages/utils` | 公共库（§2.6：被绕开） |
| 6,640 | 35 | `packages/script-api` | **契约包** |
| 5,714 | 63 | `apps/deployment-manager` | 自有 JS（非 TS） |
| — | 115 | `scripts/` | 仓库级工具/CI，全部 owned |
| — | 13 | `slim/` | **我们 fork 新增**（§5.6） |

```bash
xargs -a $H -d '\n' -n 400 wc -l | grep -v ' total$' | awk -F: '{p=$2;n=split(p,a,"/");
 k=((a[1]=="apps"||a[1]=="packages"||a[1]=="internals"||a[1]=="services")&&n>1)?a[1]"/"a[2]:a[1];
 c[k]+=$1;f[k]++} END{for(k in c) printf "%8d %5d %s\n",c[k],f[k],k}' | sort -rn
```

---

## 1. 可度量质量基线

### 1.1 关键数字（一张表看完）

| # | 指标 | 数字 | 判定 |
|---|---|---|---|
| 1 | 手写源码行 / 文件 | **449,057 / 2,989** | 基线 |
| 2 | 入库编译产物行 | **109,274**（1,067 文件） + mudb 根级 JS 15,902 + isolate bundle 35,008 | 🔴 生成物入库无闸 |
| 3 | 最大单文件 | **`services/game-server/src/assets/isolate/ivm2-script-entry.js` = 35,008 行 / 1.30 MB** | 🔴 rollup 产物放在 `src/` 里 |
| 4 | `any` 命中 | **1,823 行 / 454 文件**（TS 共 2,512 文件 = 18% 文件带 any） | 🟡 集中在 mudb 464 / game-server 450 / game 395 / schema 226 |
| 5 | 抑制注释 | `@ts-ignore` **7**、`@ts-nocheck` **1**、`@ts-expect-error` **0**、`eslint-disable` **19**（多数在 vendored wasm glue） | 🟢 极少 → 因为 lint 根本没铺（§3.6） |
| 6 | `TODO/FIXME/XXX/HACK` | **170 / 26 / 4 / 14**（合计 214） | 🟡 密度 0.48/千行 |
| 7 | 空吞 `catch {}` | **31 处 / 18 文件**（剔除 squoosh） | 🟡 |
| 8 | 同步 fs API 调用 | **1,778 处**（手写口径）；`apps/game/server` **162** 处、`project-manager.js` **142** 处 | 🔴 在用户点击链路上 |
| 9 | ≥200 行的函数/类块 | **153 个**；最长 **1,091 行** | 🔴 |
| 10 | 深嵌套（行首 ≥16 空格） | **18,169 行**；top `internals/schema/keyframes/keyframe-binding.ts` **613** | 🟡 |
| 11 | 超长行（>400 字符） | **125 个文件**；top `packages/utils/src/swears/CN_U18.ts:2` = **22,040 字符** | 🟡 数据当代码 |
| 12 | 字节级重复文件组 | **25 组 / 64 份冗余副本**（空白归一后 **29 组**） | 🔴 含 10 组跨端协议 |
| 13 | 跨 ≥3 文件的重复 5 行块 | **248 个**（182×3 文件、33×4、27×5、6×6、8×8） | 🔴 |
| 14 | 三态自禁用 handler | **72 文件 / 126 处** `BOX_DEPLOYMENT_MODE`；`pages/api` **39/97** 个路由自我 404 | 🔴 |
| 15 | 测试文件 | **196** 个 `*.test.*` + **52** 个 `regression-*`；其中 **13 个 scripts 测试零引用**、**41 个 mudb 测试（7,701 行）从未被跑** | 🔴 |
| 16 | 覆盖率配置 | **0**（全仓无 `collectCoverage`/`coverageThreshold`/`--coverage`） | 🔴 |
| 17 | 格式化/lint 覆盖率 | 61,050 / 449,057 = **13.6%** | 🔴 |
| 18 | `debugger` 语句 | **0** | 🟢 |

```bash
# 3 最大文件
xargs -a $H -d '\n' -n 400 wc -l | grep -v ' total$' | sort -rn | head -15
git ls-files | grep -E '\.(ts|tsx|js)$' | xargs -d '\n' wc -l | sort -rn | head -5
# 4 any
git ls-files | grep -E '\.tsx?$' > $TS
xargs -a $TS -d '\n' -n 200 grep -cE "(^|[^A-Za-z0-9_$.])any([^A-Za-z0-9_.]|$)" | grep -v ':0$' | awk -F: '{s+=$2}END{print s}'
# 6/7/8
for p in TODO FIXME XXX HACK; do xargs -a $H -d '\n' -n 200 grep -c $p | grep -v ':0$' | awk -F: '{s+=$2}END{print p=$1, s}'; done
xargs -a $H -d '\n' -n 200 grep -oE 'catch\s*(\([^)]*\))?\s*\{\s*\}' | wc -l
xargs -a $H -d '\n' -n 200 grep -oE '\b(existsSync|readFileSync|writeFileSync|readdirSync|mkdirSync|rmSync|unlinkSync|statSync|renameSync|copyFileSync|appendFileSync|openSync|cpSync|spawnSync|execSync)\b' | wc -l
```

### 1.2 最大单文件 Top 15（含生成物，`wc -l`）

```
35008  services/game-server/src/assets/isolate/ivm2-script-entry.js   ← rollup 产物
14383  packages/voxa-project/build/index.js                            ← rollup 产物
14332  packages/voxa-project/build/index.es.js                         ← rollup 产物
13015  packages/vb-parser/build/index.js                               ← rollup 产物
13013  packages/vb-parser/build/index.es.js                             ← rollup 产物
10898  packages/regl/dist/regl.js                                      ← 三方 fork 入库
10768  internals/apis/src/generated/openapi.ts                         ← openapi-typescript 产物
 5366  apps/game/scripts/assets/client_api/lib.es5.d.ts                ← TS lib 副本（§4.2）
 5366  apps/game/scripts/assets/api/lib.es5.d.ts                       ← 同上
 4603  packages/script-api/dts/box3-server-api.d.ts                    ← 契约，build-server-types 产物
 3783  apps/game/scripts/assets/api/js/api/js/api.d.ts                 ← tsc 产物
 3702  packages/regl/lib/core.js                                       ← 三方 fork
 3481  internals/schema/api/js/api.ts                                  ← 手写：服务端 API 声明主源
 3098  types/gl-matrix.d.ts                                            ← 三方 typings
 3084  internals/schema/keyframes/keyframe-binding.ts                  ← 手写
```

**对任务书"已知线索"的纠正**：`local-project-state.js` **不是 6,600+ 行**。源码只有一个：`services/game-server/src/project/local-project-state.ts` = **653 行**。`C-architecture.md` §10-3 写的是 `local-project-state.js:1@6596` —— **line 1、column 6596**，是镜像里 minified bundle 的字符偏移，被后续文档误读成"6600 行"。真正 >6,600 行的文件只有 5 个，且**全部是生成物**。这条要回写进 ANALYSIS §3.3。

**最大手写文件 Top 10**（生成物全剔）：

```
3481  internals/schema/api/js/api.ts                 （服务端 API 声明）
3075  apps/local-engine/src/project-manager.js        （88 KB，同步 IO 重灾区）
2965  apps/game/src/views/edit/components/fileSystemPanel/index.tsx
2956  apps/game/pages/index.tsx
2786  services/game-server/src/edit/replica/replica-server.ts
2739  apps/game/server/local-player-identity.ts
2263  internals/schema/physics/constraint/obb/obb-collide.ts
2023  apps/game/src/client/edit/game-ui-editor/ui-tree-controller.ts
1868  services/game-server/src/script/bindings/binding-factory.ts
1692  services/game-server/src/script/bindings/entity-synchronizer.ts
```

### 1.3 超长块 / 深嵌套证据（≥200 行块共 153 个，Top 12）

命令：`node %TEMP%/o2-fnlen.cjs $H "$(cygpath -w .)" 200`（剥字符串与行注释后做花括号配对；输出 `跨度<TAB>文件<TAB>起行<TAB>止行<TAB>起始深度`）

| 跨度 | 位置 | 性质 |
|---|---|---|
| 1,091 | `apps/game/src/engine/gpu/postprocess-legacy.ts:47-1138` | 🔴 **整个文件零引用**（§2.8 死代码） |
| 882 | `services/game-server/src/createServer.ts:117-999` | 单函数装下整个 HTTP/WS 装配 |
| 766 | `apps/local-engine/src/launcher.js:759-1525` | P2-1 监督进程删除的作用区（`impl/P2-1-supervisor-removal.md`） |
| 726 | `apps/voxa/src/views/nav-bar/index.tsx:61-787` | React 巨组件 |
| 708 | `apps/game/src/engine/gl/ui3d.ts:177-885` | WebGL 后端 |
| 697 | `packages/box-design/src/tree/index.tsx:318-1015` | 入库包 |
| 664 | `services/game-server/src/entry.ts:144-808` | 启动装配 |
| 625 | `apps/game/src/engine/gl/postprocess.ts:10-635` | 与 gpu 版并行实现 |
| 560 | `services/game-server/src/edit/ai/entity-tools.ts:252-812` | 15 个 zod AI 工具挤在一个块里（§4.5 相关） |
| 446 | `packages/mudb/src/schema/struct.ts:76-522` | 单个 `diff`/`patch` 方法体 |
| 413 | `apps/game/server/local-player-identity.ts:1601-2014` | 身份校验 413 行一坨 |
| 396 | `apps/game/src/engine/voxel/voxel-mesher.ts:191-587` | 体素网格化 |

深嵌套 Top 5（行首 ≥16 空格的行数）：`internals/schema/keyframes/keyframe-binding.ts` **613** ｜ `apps/game/src/views/edit/components/fileSystemPanel/index.tsx` **567** ｜ `apps/game/pages/index.tsx` **374** ｜ `apps/game/components/project-management/dialogs/project-editor-dialog.tsx` **333** ｜ `packages/mudb/src/rda/map.ts` **316**（其入库镜像 `packages/mudb/rda/map.js` = 314，逐行同构 → §2.7 证据）。

```bash
xargs -a $H -d '\n' -n 100 grep -c '^                ' | grep -v ':0$' | sort -t: -k2 -rn | head
```

### 1.4 `any` 分布（TS 2,512 文件 / 1,823 命中行）

| 命中 | 文件 | 模块 |
|---|---|---|
| 464 | 98 | `packages/mudb` |
| 450 | 97 | `services/game-server` |
| 395 | 151 | `apps/game` |
| 226 | 31 | `internals/schema` |
| 129 | 33 | `internals/build-system` |
| 72 | 22 | `apps/voxa` |
| 52 | 9 | `packages/script-api` |

Top 文件：`packages/mudb/src/schema/test/json.ts` 88 ｜ `internals/schema/keyframes/keyframe-binding.ts` 61 ｜ **`services/game-server/src/script/bindings/binding-factory.ts` 38**（沙箱绑定工厂 = 契约的心脏）｜ `packages/script-api/dts/box3-server-api.d.ts` 36。

**根因不是写码的人懒，是 tsconfig**（§1.5）：`apps/game/tsconfig.json` `strict:false` + `noImplicitAny:false` + `alwaysStrict:false`；`services/game-server/tsconfig.json` 不 extends `tsconfig.base.json`（base 里是 `strict:true`）并自带 `noImplicitAny:false`；`packages/mudb/tsconfig.json` `noImplicitAny:false` + `strictPropertyInitialization:false` + `removeComments:true`。**所以"类型收紧"是 B 类改动，不是 A 类**——收紧会让 `rush build`/`next build` 直接红，改一处的爆炸半径是 400k 行。

### 1.5 静态检查能力盘点（只用仓库已有的）

| 能力 | 入口 | 真实覆盖面 |
|---|---|---|
| ESLint 根配置 | `.eslintrc.cjs`：`eslint:recommended` + `prettier`，`parserOptions.sourceType:'script'`，**无 TS parser** | 只能 lint **JS**；`.ts/.tsx` 由根配置解析会直接报错 |
| ESLint 每项目 | `apps/game/.eslintrc.js`（`@typescript-eslint/parser@5.18.0` + `next/core-web-vitals`），`apps/voxa/.eslintrc.js`，`packages/box-design` | 5 条规则被**降为 warn**（`react-hooks/rules-of-hooks`、`react-hooks/exhaustive-deps` 系、`react/display-name`…）+ `eslint . --cache` |
| lint 接线 | `scripts/repo-tasks.js:26-30` `lint()` = 只有 3 个调用：`tools/repo-tooling lint:root`（`apps/local-engine/{src,scripts}` + `scripts`，`--ext .js,.cjs`）、`apps/game lint`、`apps/voxa lint` | **`services/game-server`、`packages/mudb`、`internals/schema`、`packages/utils`、`packages/script-api` 无 lint** |
| typecheck 接线 | `repo-tasks.js:32-35` `typecheck()` = 只有 `apps/player-admin` + `apps/player-auth-portal` | **引擎核心 0 次仓库级 typecheck** |
| Prettier | `.prettierrc.cjs`（`semi:false, printWidth:100, singleQuote`）+ `scripts/lib/owned-code-config.cjs`（15 个 owned 目录，`tabWidth:4, semi:true`）；`.prettierignore` **显式整目录排除** `apps/game/`、`apps/voxa/`、`services/game-server/`、`internals/`、`packages/*`（3 个白名单除外）、`types/` | 门禁覆盖 **61,050 / 449,057 = 13.6%**；排除是**有意的**（`.prettierignore` 注释：避免 formatter 造出巨大的兼容性 diff）→ 别去推翻它 |
| 结构/契约自研闸 | `scripts/check-engine-wire-protocols.js`（8 个文件的 token 顺序断言）、`internals/apis/scripts/check-openapi.mjs`、`apps/game/scripts/check-editor-types.ts`、`apps/game/scripts/check-http-compatibility.ts`、`scripts/check-core-module-structure.js` | 见 §3.7：其中一个（`check-editor-types`）和一个（`check-core-module-structure`）**不在任何流水线里** |
| CI | `.github/workflows/verify.yml`（`verify` job 跑 `rush verify` = format-check + lint；`image-size-gate` job 裸 node 跑体积门 + `node --test scripts/check-image-budget.test.js`）、`release.yml`、`package-server.yml`、`player-launcher-release.yml` | `verify.yml:24-28` 的 `if:` **跳过所有 base 为 main/staging/release/v\* 的 PR**；且 `verify.yml:44-47` 注释自陈 `pnpm-lock.yaml` 与 `package.json` 不同步 → **`rush install` 现在是红的 → `verify` job 走不到 `rush verify`** |

```bash
cat .eslintrc.cjs; cat apps/game/.eslintrc.js; sed -n '20,36p' scripts/repo-tasks.js
tail -15 .prettierignore; sed -n '22,48p' .github/workflows/verify.yml
```

---

## 2. 重复与可复用性

### 2.1 三态 bundle：共享面 100%，分叉面只有 env

creator / play / player-service 三个镜像是**同一个 `apps/game` Next standalone 构建的三次实例化**（`ANALYSIS §2.2`）。源码层的分叉只有三类：

| 分叉机制 | 位置 | 数量 | 构建期可否消除 |
|---|---|---|---|
| handler 内自我 404 | `apps/game/pages/api/**`、`apps/game/pages/api/player-internal/**` | **39 / 97** 个路由文件带 `BOX_DEPLOYMENT_MODE`；40 处 `res.status(404).end()` | ✅ 可以（运行时门 → 构建期路由裁剪） |
| SSR 分支 | `getServerSideProps`/`getStaticProps` 里判 mode | **13 处 / 8 个文件**（`pages/index.tsx:2919,2922`、`pages/p/[gameName]/index.tsx:49,55,69,96`、`pages/play-launch.tsx:21`、`pages/play-system.tsx:134`、`pages/projects/index.tsx:42`、`pages/projects/launch.tsx:19`、`pages/_app.tsx:62`、`app/e/[container]/page.tsx:14,17`） | ✅ 可以（`next.config.js` 用 `env` 内联常量 → webpack DefinePlugin 死支消除） |
| 反代/rewrite | `apps/game/next.config.js:63-90`（`playerAdminAtRoot`）、`packages/deployment-routing`、`apps/local-engine/src/{play,edit}-library.js` | 3 处 | 部分 |
| 全量 env 读取 | `BOX_DEPLOYMENT_MODE` | **72 文件 / 126 处**（`apps/game/server` 15 文件） | — |

**可提取的公共层（具体到 path:line 的重复块对照）**

对照 1 —— **同一条门重复 31 遍**（字节级相同，只差分号）：
```
apps/game/pages/api/creator-logout.ts:12                      !== 'creator'
apps/game/pages/api/player-auth/login.ts:15                   !== 'player-service'   (17 处带分号变体)
apps/game/pages/api/player-auth/logout.ts:7                   同上
apps/game/pages/api/player-internal/profile.ts:6              同上
apps/game/pages/api/player-internal/runtime-identity.ts:12    同上
apps/game/pages/api/play-admin/players/index.ts:13            同上
apps/game/pages/api/play-library.ts:12                        !== 'play'             (7 处无分号变体)
apps/game/pages/api/play-worlds.ts:5                          同上
```
`grep -rho "BOX_DEPLOYMENT_MODE !== '[a-z-]*') *return res\.status(404)\.end();*" apps/game/pages | sort | uniq -c` → `17 + 7 + 4 + 2 + 1 = 31`（player-service 带分号 17 / play 无分号 7 / player-service 无分号 4 / play 带分号 2 / creator 带分号 1）。
→ 抽 `withMode(mode, handler)` HOF。**A 类**（返回 404 的语义逐字节不变）。

对照 2 —— **同一条错误尾巴重复 14 个文件**：`res.status(400).json({ message: (error as Error).message })`
```
apps/game/pages/api/local-projects/index.ts:19
apps/game/pages/api/local-projects/[id].ts:39
apps/game/pages/api/local-projects/[id]/export.ts:39
apps/game/pages/api/local-projects/[id]/maps.ts:18
apps/game/pages/api/local-projects/[id]/package.ts:50
apps/game/pages/api/local-projects/[id]/publish.ts:52
apps/game/pages/api/local-projects/[id]/snapshots.ts:25
apps/game/pages/api/local-projects/asset-distribution.ts:22
apps/game/pages/api/play-admin/identity-bans.ts:33
apps/game/pages/api/play-admin/players/batch.ts:33
apps/game/pages/api/play-admin/worlds/[id].ts:21
apps/game/pages/api/play-admin/worlds/status.ts:15
apps/game/pages/api/player-login/callback.ts:77
apps/game/pages/api/player-login/start.ts:56
```
→ 与对照 1 合成同一个 `withLocalProjectHandler`。**注意 C 类风险**：这 14 个 handler 里有 `publish.ts`/`export.ts`/`package.ts`，是 `ANALYSIS §3.4`（A10 修订）指出的**越权面**——把门抽成公共层时**不许**顺手把 `creatorPermissions` 校验（`apps/game/server/creator-api-security.ts:105`）和 CLI scope 校验（`:141`）合并，否则改掉的是授权语义。

对照 3 —— **权限检查在 3 个文件里重复 18 遍**：`!this._editServer.replica.getSessionPermissions(client.sessionId)`
```
services/game-server/src/edit/code-editor/code-editor-server-controller.ts:98,117,136,159,197,215,228,237,250 (9 处)
services/game-server/src/edit/code-editor/replica/server.ts:110
services/game-server/src/edit/replica/replica-server.ts:683,708,746,784 (18 站点合计)
```
→ **B 类**（改内部结构，WS 报文与错误码不变）。

对照 4 —— **同一个 27 重守卫在单文件里**：`if (!node || !node.value || !isUIElement(node.value)) {`
```
apps/game/src/client/edit/game-ui-editor/ui-tree-controller.ts:451,487,523,554,599,623,651,675,703,729,755,777,802,824 … 共 27 处
```
→ 抽 `resolveUIElement(node)`。**A 类**。

对照 5 —— **同一份 mesh 字节打包写 12 遍**：
```
internals/schema/mesh/modelMeshSchema.ts:101,111,121,131,141,151,161,171,181,191,204,214
（meshBuffer[ptr+4..7] = material[m_idx].rgb[..] / normal_code 序列）
```
→ **C 类禁区**：这是**地图存档的二进制布局**（`.mesh` 走 `boxEncode`，见 §5 地雷 3）。可以抽函数，但**必须逐字节比对**旧输出。

对照 6 —— **同一套天气/天空/粒子接口在两个地方**：
```
internals/schema/api/js/api.ts:190-232  vs  internals/schema/api/js/api.ts:369-432
packages/script-api/dts/box3-server-api.d.ts:363-432 vs :428-449
```
（`snowTexture/snowColor/snowSpinSpeed/snowFallSpeed/snowSizeHi/snowSizeLo/snowDensity` 9 次重复窗口，`skyTopLight/skyBottomLight/…` 9 次）→ 见 §4.1，这是**两条并行声明树**的症状，不是纯 A 类。

对照 7 —— **同一个 murda partial 包装器写 6 遍**：
```
internals/schema/project/murda-tree.ts:911,912,913,914,945,946,947,948,978,979
internals/schema/project/murda-union.ts:509,510
（const keys = Object.keys(meta.table); for(...){ const key = keys[i]; result[key] = wrapPartialRec(...) }）
```
→ **B 类**（RDA 是同步协议核心，见 §5 地雷 2）。

对照 8 —— **同一份身份/会话安全头**：`applyPlayerAdminSecurityHeaders(res)` 12 次 import+调用（`apps/game/pages/api/play-admin/*.ts`、`player-auth/*.ts`）—— 这条**已经抽好了**，是对照 1 的正确形态示范。

### 2.2 字节级重复文件（最强可复用性证据）

```bash
# 精确字节
xargs -a $H -d '\n' -n 200 md5sum | sort | awk '{h[$1]=h[$1]" "$2;c[$1]++}END{for(k in c)if(c[k]>1)print c[k],h[k]}' | sort -rn
# 只改缩进/换行的"假装不同"
while read f; do h=$(tr -d ' \t\r\n' < "$f" | md5sum | cut -c1-32); echo "$h $f"; done < $H | sort
```
**25 组 / 64 份冗余副本**（空白归一后 29 组）。全部列出：

| 组 | 成员 | 严重度 |
|---|---|---|
| 4 | `internals/schema/keyframes/codegen.ts` ≡ `packages/utils/src/script/codegen.ts` ≡ `services/game-server/src/script/codegen.ts` ≡ `services/game-server/src/utils/codegen.ts` | 🔴 **4 份代码生成器**（§1.3 那个 35,008 行 bundle 就是它生成的） |
| 4 | `apps/game/src/engine/gui/promise-wrapper.ts` ≡ `apps/game/src/engine/rtc/promise-wrapper.ts` ≡ `packages/utils/src/promise-wrapper.ts` ≡ `services/game-server/src/rtc/promise-wrapper.ts` | 🔴 **canonical 就在 `packages/utils`**，其余 3 份是复制粘贴 |
| 3 | `apps/game/src/client/edit/code-editor-replica/schema.ts` ≡ `services/game-server/src/edit/code-editor/replica/schema.ts` ≡ `services/game-server/src/edit/replica/schema.ts` | 🔴🔴 **RDA schema 跨端复制**（§5 地雷 1） |
| 3 | `apps/game/server/utils/type.ts` ≡ `internals/schema/types/node-type.ts` ≡ `packages/utils/src/http-fetch/type.ts` | 🟡 |
| 2 | `apps/game/src/client/edit/replica/transaction/transaction.ts` ≡ `services/game-server/src/edit/replica/transaction/transaction.ts` | 🔴 编辑事务协议 |
| 2 | `apps/game/src/client/edit/rpc/rpc-schema.ts` ≡ `services/game-server/src/edit/rpc/rpc-schema.ts` | 🔴 |
| 2 | `apps/game/src/client/edit/code-editor/rpc/schema.ts` ≡ `services/game-server/src/edit/code-editor/rpc/schema.ts` | 🔴 |
| 2 | `apps/game/src/engine/rtc/rtc-protocol.ts` ≡ `services/game-server/src/rtc/rtc-protocol.ts` | 🔴 线协议 |
| 2 | `apps/game/src/engine/href/href-protocol.ts` ≡ `services/game-server/src/href/href-protocol.ts` | 🔴 线协议 |
| 2 | `apps/game/src/engine/href/href-client-state.ts` ≡ `services/game-server/src/href/href-client-state.ts` | 🔴 |
| 2 | `apps/game/src/engine/gui/gui-protocol.ts` ≡ `internals/schema/gui/gui-protocol.ts` | 🔴 |
| 2 | `apps/game/src/engine/utils/safe-url.ts` ≡ `services/game-server/src/href/safe-url.ts` | 🟡 安全校验被复制 → 一份改了另一份不改 = 绕过 |
| 2 | `packages/utils/src/script/safe-eval.ts` ≡ `services/game-server/src/script/safe-eval.ts` | 🔴 沙箱求值 |
| 2 | `packages/utils/src/script/pairing-heap.ts` ≡ `services/game-server/src/script/pairing-heap.ts` | 🟡 |
| 2 | `internals/build-system/utils/box-encode.ts` ≡ `services/game-server/src/voxel/box-encode.ts` | 🔴 **存档编码**（§5 地雷 3） |
| 2 | `internals/schema/utils/sorted-array-remove.ts` ≡ `services/game-server/src/utils/sorted-array-remove.ts` | 🟡 |
| 2 | `apps/voxa/src/utils/relative-array.ts` ≡ `internals/schema/utils/relative-array.ts` | 🟡 |
| 2 | `apps/voxa/src/utils/rbush/schema.ts` ≡ `internals/schema/utils/rbush-schema.ts` | 🟡 |
| 2 | `apps/game/src/engine/utils/init-array.ts` ≡ `packages/utils/src/init-array.ts` | 🟡 |
| 2 | `apps/game/shared/websocket-url.ts` ≡ `packages/realtime-client/src/websocket-url.ts` | 🟡 |
| 2 | `packages/utils/src/fill.ts` ≡ `packages/utils/src/voxle-fill.ts` | 🟡 **同一个包内部两份** |
| 2 | `apps/game/src/views/components/edit/switch/index.tsx` ≡ `.../play/components/basic/switch/index.tsx` | 🟡 |
| 2 | `apps/game/src/views/components/edit/radio/index.tsx` ≡ `.../play/components/basic/radio/index.tsx` | 🟡 |
| 3 | `packages/{rewgpu,vb-parser,voxa-project}/example/{pages/_app.tsx,next.config.js}` | 🟢 脚手架 |
| 2 | `packages/{rewgpu,voxa-project}/rollup.config.mjs` | 🟢 |
| 5/6 | `packages/mudb/socket/{child_process,local,net,web,worker}/test/{server,client}.d.ts` | 🟡 mudb 产物 |
| 2 | `apps/game/public/box-resource-cache-worker.js`（`Object.defineProperty(exports…)` 也在 mudb 根级 JS 出现 **139 个文件**） | 见 §2.7 |

**"字节级重复的 10 组跨端协议/存档 schema"是本文最重要的一条结论**：客户端与服务端各自持有同一份协议的私有副本，**没有任何 gate 保证两份一致**（`scripts/check-engine-wire-protocols.js` 只做字符串顺序断言，不比对内容）。合并到 `@box/schema` / 新 `packages/wire` 是 **B 类**（外部报文不变），收益是消掉一整类"只改一端"的静默不兼容。

### 2.3 跨 ≥3 文件的重复块

`248 个 5 行块出现在 ≥3 个不同文件`（182×3 / 33×4 / 27×5 / 2×6 / 4×8）。复跑：

```bash
xargs -a $H -d '\n' -n 100 awk 'function norm(s){sub(/^[ \t]+/,"",s);sub(/[ \t]+$/,"",s);return s}
 {buf[FNR%6]=norm($0); if(FNR>=6){w="";ok=1;for(i=0;i<5;i++){x=buf[(FNR-1-i)%6]; if(length(x)<18) ok=0; w=w x "#"} if(ok) print w "\t" FILENAME "\t" (FNR-4)}}' > $W
cut -f1 $W | sort | uniq -c | awk '$1>=3' | wc -l
```
高频家族（除 §2.1 的对照 1/2/3/4 外）：
- `__awaiter`/`__generator`/`step(result)` TS 降级前奏：×8 → **又是入库 JS**（§2.7）
- `Object.defineProperty(exports, "__esModule", { value: true });`：**179 站点 / 139 文件** → §2.7
- `fs.rmSync(temporaryRoot, { recursive: true, force: true })`：12 站点 / 8 文件（`apps/local-engine/scripts/regression-*.js` ×6 + `project-manager.js:883,1352,1716,1767,2841`）→ A 类抽 `withTempDir()`
- `vec2.fromValues(1,0)/(0,0)/(1,1)…` 字面量块：×6（`apps/game` 动画/IK 侧）

### 2.4 已存在但被绕开的复用点（"有人复制粘贴而没 import"）

| canonical（应被 import） | 实际复制到了 |
|---|---|
| `packages/utils/src/promise-wrapper.ts` | `apps/game/src/engine/{gui,rtc}/`、`services/game-server/src/rtc/` |
| `packages/utils/src/script/{safe-eval,pairing-heap,codegen}.ts` | `services/game-server/src/script/`、`services/game-server/src/utils/codegen.ts` |
| `packages/utils/src/init-array.ts` | `apps/game/src/engine/utils/init-array.ts` |
| `packages/mudb/src/util/stringify.ts` 的 `export function stableStringify` | `apps/local-engine/src/project-manager.js:176 function stableStringify(value)` **自带一份** |
| `internals/schema/gui/gui-protocol.ts` | `apps/game/src/engine/gui/gui-protocol.ts` |
| `packages/realtime-client/src/websocket-url.ts` | `apps/game/shared/websocket-url.ts` |

### 2.5 各模块自研的同一件工具（跨模块重复实现）

| 工具 | 独立实现数 | 位置 |
|---|---|---|
| **base58 / CIDv0**（`0x12,0x20 + sha256 + base58`） | **3 套** | `apps/local-engine/src/project-manager.js:190 encodeBase58()` + `:219`（`Buffer.concat([Buffer.from([0x12,0x20]),digest])`）+ `:56 cidV0Pattern=/Qm[1-9A-HJ-NP-Za-km-z]{44}/g` ｜ `apps/voxa/server/local-voxa-store.ts:100 base58()` + `:127` 同一拼接 ｜ `apps/game/public/box-resource-cache-worker.js:94 base58Bytes()`（解码）+ `:122`；另有 `apps/local-engine/src/runtime-assets.js:12` 第四份 CID 正则 |
| **sha256 摘要助手** | **5 套** | `apps/local-engine/src/asset-distribution.js:123`、`apps/local-engine/src/distribution-metadata.js:135`、`scripts/build-desktop-offline-installer.js:126`、`scripts/build-headless-server-package.js:22`、`scripts/verify-desktop-offline-package.js:9` |
| **contentHash** | **3 套** | `project-manager.js`、`local-voxa-store.ts`、`packages/content-server/src/file-system-store-node.ts` |
| **escapeHtml** | **2 套** | `apps/deployment-manager/src/ui/html.js:1`、`apps/player-launcher/src/views/html.ts:1`（都在 owned 目录 → 可直接抽 `scripts/lib/html-escape.cjs`） |
| **debounce/throttle** | **3 套** | `apps/game/src/utils/debounce-throttle.ts`(67)、`apps/voxa/src/utils/debounce-throttle.ts`(38，同源不同形)、`apps/game/src/utils/react-hooks/common.ts` |
| **深度克隆** | mudb 一处（`packages/mudb/src/schema/json.ts` deepClone）+ `apps/game/src/engine/utils/pool.ts` / `internals/schema/keyframes/mu-array-union.ts` 各写 `clone` | 🟡 |

→ **`packages/box3-pack` 的落地证据**：CID/base58/sha256/stableStringify 四件套在 4 个不同顶层模块各写一遍，正是 `ANALYSIS §3.4`"包格式可独立复刻、估 <1,500 行"的动机与可行性。抽成一个包是 **B 类**，但 **CID 字符串是对外存档标识**（§5 地雷 4），必须做逐摘要比对。

### 2.6 死代码 / 未引用模块

确认 **零引用**（`grep -rn` 覆盖 `apps services packages internals scripts distribution slim` + `docker-compose.yml`，node_modules 与 .next 除外）：

| 行 | 文件 | 证据 |
|---|---|---|
| **1,138** | `apps/game/src/engine/gpu/postprocess-legacy.ts` | 名字带 legacy，**全仓 0 命中**；活跃实现是 `apps/game/src/engine/gpu/postprocess/` 目录 + `apps/game/src/engine/gl/postprocess.ts` |
| **763** | `apps/game/src/views/edit/components/settingPanel/gameDetailEdit.tsx` | 0 命中 |
| **365** | `apps/game/src/components/ai-elements/open-in-chat.tsx` | 0 命中 |
| 402（仅被自己的 build 产物引用） | `internals/build-system/utils/color_table.ts` | 只有 `build/utils/color_table.{d.ts,js,map}` 引用 |
| 1 | `services/game-server/src/script/bindings/entity-bindings.ts:1039` `// bindPlayerServer.bool('muted','muted')` + `:1038 TODO 禁言功能暂时无用` | 已核实 `muted` 不在 `box3-server-api.d.ts` → 是死注释，不是契约缺口 |
| — | `apps/game/scripts/build-llm-context.ts:15-17`（注释掉的 rimraf）、`:46`（注释掉的 client tsc） | §4.2/§4.5 |
| — | `apps/game/tsconfig.json:77` 的 `../../services/game-server/src/edit/ai/llm-context.d.ts` 把**后端生成物**当**前端 include** → apps/game 每次 typecheck 都吃一份不属于它的 d.ts | 🟡 |

合计可安全移除 ≈ **2,266 行手写 TS**（另 `color_table.ts` 402 行需连带其 `build/` 产物才能删）。

```bash
for n in postprocess-legacy gameDetailEdit open-in-chat color_table; do echo "--- $n"; grep -rn "$n" apps services packages internals scripts distribution slim docker-compose.yml 2>/dev/null | grep -v node_modules; done
```

**并行双后端（最大的一笔结构性重复）**：`apps/game/src/engine/gl/`（WebGL，42 个 `.ts` / 7,431 行）与 `apps/game/src/engine/gpu/`（WebGPU，41 个 / 10,067 行）**同名文件 16 个**：`bake-shadow, break, main, mesh, model, outline, particles, player, postprocess, quad, rain, seed, shadow, skybox, snow, texture, voxel`。共 17,498 行、两套 GLSL/WGSL 着色器、零共享抽象层。→ **B 类（且视觉输出属作者可感面 → 实质近 C）**。这不是本轮该动的地方，但必须在清单里挂号，因为它把 §4.2 客户端 DTS、`ui3d`、体素渲染的每一次改动都翻倍。

### 2.7 生成物入库（可复用性的隐性成本，也是 fork 工作树脏的来源）

| 类型 | 规模 | 命令 |
|---|---|---|
| `**/build/`、`**/dist/` 目录 | **1,067 文件 / 109,274 行** | `git ls-files \| grep -E '(^/)(build\|dist)/' \| wc -l` |
| **`packages/mudb/tsconfig.json` 的 `outDir: "."`** → tsc 把 CJS 直接吐到**包根** | **140 个 `.js` / 15,902 行**（同包 `src/**/*.ts` 手写只有 298 文件 / 24,269 行）→ **"mudb 40,536 行"里 39% 是编译器输出** | `git ls-files packages/mudb \| grep '\.js$' \| xargs wc -l \| tail -1` |
| `packages/mudb` 的 `clean` 脚本 | `ls -F src \| grep / \| xargs rm -rf coverage *.d.ts *.js *.js.map` —— **`npm run link`/`build` 会删掉 140 个 tracked 文件** | 这是 `git status` 会莫名变脏、以及 `impl/GATES.md §2` 的"20 vs 22 项改动"漂移的一个候选解释 |
| `services/game-server/src/assets/isolate/ivm2-script-entry.js` | **35,008 行 / 1.30 MB**，源在 `src/utils/script-server/ivm2/`（7 个 ts / 1,656 行）+ rollup（`scripts/script-server/rollup.config.mjs:12`），由 `package.json` `build_isolate` 生成 | **没有任何闸校验它和 src 一致**；改 `binding-factory.ts` 忘记跑 `build_isolate` → 出厂沙箱跑旧码 |
| `internals/apis/src/generated/{openapi.ts(10,768), client.ts(3,078)}` | 生成物 | ✅ **有闸**：`repo-tasks.js:47` → `internals/apis check:openapi` → `generate-openapi.mjs --check` + `generate-client.mjs --check` |
| `apps/game/scripts/assets/{api,client_api}/**` | 76 文件（46+30），含 TS lib 的 5,366 行 `lib.es5.d.ts` 两份 | 生成物且入库 |
| `packages/script-api/dts/*.dts` | `client-api-types.dts` 14,904 B / `server-api-types.dts` 38,101 B（**非标准 `.dts` 扩展名**，`rollup.config.mjs:9` 用 `[name]-api-types.dts`） | `package.json` 的 `files:["./dts/*"]` → 属**已发布包格式**（§5 地雷 5） |

**唯一值得立刻做的 A 类机械化改进**：给 `ivm2-script-entry.js` 加一个"重跑 `build_isolate` 后必须无 diff"的闸（等价于 `internals/apis` 的 `--check` 惯例），否则 §5 的所有沙箱契约结论都可能对着一份过期 bundle。

### 2.8 `packages/icons` 与 `slim/`：两处体量不小的"非代码"入库

`packages/icons` 616 文件 / 6,951 行（`build/` + `output/icon/*.tsx`，`IconBlockNumber.tsx` 单行 2,237 字符）。`slim/` 123 文件里 **9 个 md 与 `box3-re/*.md` 字节级相同**（`ANALYSIS-AND-PLAN.md` f6716289、`C-architecture.md` da719879、`HANDOVER.md` a77953fb、`ROADMAP.md` 9193b03d、另 `A-docs/B-size-audit/E-runtime-baseline/F-release-diff` 同）+ `slim/poc/*.mjs` 12 个文件 869 行。→ 我们 fork 自己造的第二份真相（§6 条目 A-14）。

```bash
for f in ANALYSIS-AND-PLAN.md C-architecture.md HANDOVER.md ROADMAP.md; do md5sum slim/$f ../../神奇代码岛/box3-re/$f; done
```

---

## 3. 测试覆盖现实

### 3.1 数字

| 指标 | 数字 |
|---|---|
| `*.test.*` tracked 文件 | **196** |
| ├ `apps/game` | 81（jest，`testEnvironment:'node'`，无 coverage） |
| ├ `scripts/` | 52（`node:test`） |
| ├ `apps/player-launcher` | 31（`tsx --test`） |
| ├ `services/game-server` | 10（全部在 `scripts/anticheat-*.test.ts` + `net-state-operations.test.ts`） |
| ├ `apps/player-auth-portal` 7 / `packages/deployment-routing` 5 / `apps/local-engine` 4 / `internals/apis` 3 / `packages/{realtime-client,player-policy,cli}` 各 1 | — |
| `regression-*` 脚本（另一种测试形态） | **52**：`services/game-server/scripts` 24、`apps/local-engine/scripts` 16、`apps/voxa/scripts` 5、`apps/game/scripts` 4、`packages/content-server/scripts` 2 |
| `packages/mudb/src/**/test/*.ts` | **41 文件 / 7,701 行**（tape） |
| 覆盖率配置 | **0** |

### 3.2 `rush test` 到底跑什么（关键事实）

`common/config/rush/command-line.json:111` 的 `test` **不是 bulk 命令**，是 global：`shellCommand: node scripts/repo-tasks.js test`。

```js
// scripts/repo-tasks.js:150-160
function test() {
  prepareTestDependencies();
  npmScript('apps/local-engine', 'test');
  npmScript('services/game-server', 'test');     // 21 个 regression-*.ts 串成一条 && 链
  npmScript('apps/game', 'test', ['--runInBand']);// jest
  npmScript('apps/player-launcher', 'check');
  npmScript('services/game-server', 'check:anticheat');
  check();                                       // 再叠一整轮
}
```
→ `rush test` **只跑 5 个项目的 test 脚本 + `check()` 白名单**。`check()` 里显式点名 35 个 `scripts/*.test.js`（分 5 段 `node --test`）+ 3 个 packages 的 test + `internals/apis` + `cargo test` ×2。

`command-line.json:9` 的 `build` 有 `ignoreMissingScript: true` —— 缺脚本的项目**静默跳过**，不报错。

### 3.3 本轮新增的 `scripts/check-image-budget.test.js`（复核"repo-tasks.js 缺 1 行"）

- 文件存在，**617 行、19 个 test**：`grep -c "test('" scripts/check-image-budget.test.js` → 19 ✅（GATES §1 的"19 tests / 19 pass"口径一致）。
- **`scripts/repo-tasks.js` 全文 0 次出现 `check-image-budget`**：`grep -c check-image-budget scripts/repo-tasks.js` → 0。
- 被引用于 **`.github/workflows/verify.yml:69`**（`node --test scripts/check-image-budget.test.js`）与 `:72/:96/:110/:139`（`--self-test` 与三档 CLI）。
- **判定：`rush test` 跑不到它；CI 的 `image-size-gate` job 跑得到它。** 遗留确认为"repo-tasks.js 的 `check()` 里缺 1 行"。
- **修法（A 类，1 行）**：把它追加进 `repo-tasks.js:120` 那一组 `run(process.execPath, ['--test', …])` 的末尾（`export-current-images.test.js` 之后）。**理由**：`scripts/check-image-budget.test.js` 头部注释自陈"不许依赖 rush install"，而 `check()` 的入口 `prepareTestDependencies()` 会先 `rush install` 依赖链——所以只能挂在已经存在、且已用裸 `node --test` 的那一段里，不能新建依赖它的 job。
- 风险：`repo-tasks.js` 自身被 `scripts/repo-tasks.test.js`（211 行，**已在 `check()` 白名单里**）测着 → 改完跑 `node --test scripts/repo-tasks.test.js` 就能证。

### 3.4 17 个 `scripts/*.test.js` 不在 `rush test` 路径上（**13 个零引用**）

`scripts/*.test.js` 共 **52** 个，`repo-tasks.js` 点名 **35** 个。未点名的 17 个及其外部归宿：

| 归宿 | 文件 |
|---|---|
| `apps/deployment-manager/package.json` 的 test 脚本 | `deployment-manager-auth.test.js`、`deployment-manager-configuration-scenarios.test.js`、`deployment-manager-event-permissions.test.js`（3 个） |
| `.github/workflows/verify.yml` | `check-image-budget.test.js`（1 个） |
| **零引用（任何流水线/任何 package.json 都不跑）** | **`code-diagnostics-lifecycle`(36)、`code-editor-eol-offset`(26)、`creator-player-identity`(22)、`launcher-package-modes`(163)、`local-player-identity`(79)、`moderation-runtime-auth`(54)、`packaging-context`(74)、`player-self-service`(331)、`project-import-large-archive`(50)、`project-snapshot-restore-exdev`(71)、`release-branches`(137)、`verify-workflow`(40)、`worker-public-path`(76)（13 个，合计 **1,159** 行断言）** |

**其中 3 个正好测的是本轮红线相关的面**：`local-player-identity.test.js`（79 行，身份链）、`creator-player-identity.test.js`（22 行，`ANALYSIS §3.4` A10 越权面那条链）、`launcher-package-modes.test.js`（163 行，**launcher 的三态模式**——P2-1 删监督进程的直接靶子）。→ 这 13 个不是"要不要写测试"的问题，是"已有测试接上电"的问题。**A 类**（只加 CI/repo-tasks 行，不改被测码）。

### 3.5 mudb：41 个测试 / 7,701 行，一次都没跑过

`packages/mudb/package.json` `"test": "f(){ tape -r ts-node/register src/${1:-\\*}/test/${2:-\\*}.ts; }; f"`（要 shell 传参、要 `ts-node`）。
`grep -c mudb scripts/repo-tasks.js` → **0**；`grep -rn mudb .github/` → **无输出**。
→ **自研二进制 diff 协议（地图状态同步的心脏）有 7,701 行 tape 测试，但没有任何自动化路径执行它们。** 这是本轮最高价值的一条接线（A 类）。

### 3.6 核心引擎有没有测试：有，但覆盖面很不均

| 模块 | 测试实况 |
|---|---|
| `services/game-server`（83,417 行） | ✅ **有**：`package.json` `test` 串 **21** 个 `regression-*.ts`（storage/teleport/voxa-fallback/project-model/mesh-assets/map-group-lock/script-url-policy/script-moderation…）+ `check:anticheat` 10 个 `*.test.ts`。全部通过 `-r @swc-node/register` 直接跑 TS。**没有** unit test 覆盖 `script/bindings/`（binding-factory 1,868 / entity-synchronizer 1,692 / entity-bindings 1,343）与 `edit/replica/replica-server.ts`（2,786）——**即沙箱与 RDA 编辑层是裸奔的** |
| `packages/mudb` | ❌ 41 个测试存在但零接线（§3.5） |
| `internals/schema`（36,337 行，含全部 RDA/存档 schema） | ❌ **连 `test` 脚本都没有**（`internals/schema/package.json` 无 `scripts.test`） |
| `packages/utils` / `packages/content-server` / `packages/script-api` | ❌ `"test": "echo \"Error: no test specified\" && exit 1"` —— **3 个包的 test 脚本恒红**（`script-api` 是发布契约包） |
| 无 `test` 脚本的项目（16 个） | `packages/{box-design,dsbridge,icons,iframe-event-bus,mesher,regl,rewgpu,vb-parser,voxa-project}`、`internals/{build-system,env,schema,vb}`、`apps/{player-admin,server-manager,voxa}` |
| `apps/voxa`（59,975 行） | 无 jest；只有 5 个 `check:*` 脚本，其中 4 个在 `repo-tasks.js:check()` 里被点名（`model-library-scope`/`model-project-bundle`/`local-cors`/`model-management-permission`） |
| **`apps/game` 的契约闸** | `test:script-types`（`node -r ts-node/register scripts/check-editor-types.ts`）**只被 `build:script-types` 调**；`grep -rn check-editor-types .github scripts/repo-tasks.js` → **0 命中** → 全仓唯一一份真正在跑 TypeScript LanguageService 校验 API 契约的闸，**不在任何流水线里** |
| **`scripts/check-core-module-structure.js`** | 同样 **零接线**（`grep -rn check-core-module-structure scripts/ .github/` → 只有它自己） |

### 3.7 一句话总结测试现实

**252 个测试载体（196 test + 52 regression）中，接线可跑的约 60%；41 个 mudb 测试（7,701 行）、13 个 scripts 测试（**1,159** 行）、1 个契约闸（`check-editor-types.ts`）、1 个结构闸（`check-core-module-structure.js`）= 共 56 个可执行检查文件处于"写了但没人跑"状态。覆盖率概念在本仓不存在。**

```bash
git ls-files | grep -cE '\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$'      # 196
git ls-files | grep -cE 'regression-'                                   # 52
ls scripts/*.test.js | wc -l; grep -oE "scripts/[a-z0-9._-]+\.test\.js" scripts/repo-tasks.js | sort -u | wc -l
comm -23 <(ls scripts/*.test.js | xargs -n1 basename | sort) <(grep -oE 'scripts/[a-z0-9._-]+\.test\.js' scripts/repo-tasks.js | sed 's|scripts/||' | sort -u)
grep -rn "check-editor-types\|check-core-module-structure" .github scripts/repo-tasks.js   # 空
grep -rn "collectCoverage\|coverageThreshold" --include=*.json --include=*.js --include=*.yml . | grep -v node_modules   # 空
```

---

## 4. 契约与类型健康

### 4.1 一个服务端契约，三棵并行声明树 + 一棵运行时树

| 树 | 规模 | 角色 | 同步机制 |
|---|---|---|---|
| `internals/schema/api/js/**` | 15 个 `.ts` / **5,362 行**（`api.ts` 3,481） | **事实源头**（引擎类型） | `apps/game/api-tsconfig.json` `include: ../../internals/schema/api/**/*.ts` |
| `packages/script-api/src/server/**` | 19 个 `.ts` / **1,313 行** | 第二份手写声明 | ⚠️ **仅 3 个模块有生成器**：`scripts/sync-moderation-types.js` 同步 `anticheat.ts`/`error.ts`/`moderation.ts`（文件头自陈 "Generated by … Edit internals/schema/api/js/… instead"）。`world.ts`(266)、`storage.ts`(159)、`motion.ts`(144)、`player.ts`(134)、`entity.ts`(**26**) 全手写 |
| `packages/script-api/dts/box3-server-api.d.ts` | **4,603 行** | **对外发布的作者契约** | `apps/game/scripts/build-server-types.ts:5-22` 把 `scripts/assets/api/**.d.ts` concat 成单文件；`if (!fs.existsSync(target) || content !== existing) writeFileSync` |
| `packages/script-api/dts/server-api-types.dts` | 1,020 行 | **另一个**对外契约（`.dts` 扩展名，rollup 产物） | `packages/script-api/package.json` `rollup` |
| `services/game-server/src/script/bindings/**` | binding-factory 1,868 + entity-synchronizer 1,692 + entity-bindings 1,343 + world-synchronizer 687 + … | **真正被调用的实现** | 无 |

`ANALYSIS §3.4` 的"398 可调用 / 1234 属性"来自第一/第三行；`impl/G3-map-compat-baseline.md §2.2` 已判定"数字复现，口径不成立"。本文补一条**结构性原因**：三棵声明树的粒度差 4 倍（`api.ts` 3,481 行 vs `src/server` 1,313 行），**所以任何"按 d.ts 收窄"的动作对齐的是错的树**。

`packages/script-api/rollup.config.mjs:6` 的作者注释是硬证据：
```js
client: './dist/types/client/global.d.ts', // 目前输出dts是有问题的，需要手动删除最后一行export
```
→ 发布的两个 `.dts` 里，客户端那份**官方自陈需要人工补救**才能用。

### 4.2 客户端 DTS 断链：A9 结论复核（**部分纠正**）

A9/`ANALYSIS §3.4` 说：`client-api-tsconfig.json` 的 include 有 1/2 条指向不存在路径 → 客户端 DTS 无法再生成；改 1 行可再生。

**复核结果**：

```bash
cat apps/game/client-api-tsconfig.json
# include[0] "src/engine/script/apis/*.ts"            → ls: No such file or directory  ✅ 死
# include[1] "../../internals/schema/api/common.ts"   → 存在（117 字节，只 export JSONValue）✅ 活
```

1. ✅ **"2 条死 1 条"成立**（`1/2` 也成立）。
2. ⚠️ **不是"无法再生成"，是"能生成但生成的是空壳"**。`apps/game/scripts/assets/client_api/` 现有 **30 个入库文件**，其中 **29 个是 TypeScript 自带 lib.\*.d.ts**，唯一真声明 = `js/common.d.ts`（一个 `JSONValue`）。**声明面 = 1 个类型，0 个 API。** tsc 只在"include 全部无匹配"时报 `No inputs were found`，这里恰好有 1 条命中 → **退出 0**。
3. 🔴 **所以它每次都"成功"，这就是它烂了三年没人发现的原因**。`apps/local-engine/src/build.js:218-229` 在**每次产品构建**里真的在跑 `tsc -p client-api-tsconfig.json` + `fix-declaration.js`，全绿。
4. ✅ **"改 1 行"是必要条件**，真实源目录 = `apps/game/src/engine/script/ses/apis/`。**但 glob 必须同时升级**：
   - `ses/apis/*.ts`（照旧"平铺"写法）= 只有 **9** 个文件（`console, events, http, index, media-support, media, navigator, remote, screen`）
   - `ses/apis/**/*.ts` = **26** 个文件（多出 `gui/` 11 个、`audio/`、`input/`、`math/`、`context/`）
   → **只改路径不改 glob，会把整个 GUI / Audio / Input / Math 族（地图脚本最常调的 `screen.createBox`、`ui.*`）再次丢掉**，症状和现在一样。正确的 A 类改动是把 include[0] 换成 `"src/engine/script/ses/apis/**/*.ts"`（1 行）。
5. 🔴 **改完之后不是 A 类**。它下游有两个消费者，都是**对外可见物**：
   - `apps/local-engine/src/build.js:229` → `prepare-assets.js` → **内容寻址的 API_RES blob**（`ANALYSIS` 的"已发布包格式"）→ 重生成会**换 hash**、换包。
   - `apps/game/scripts/resources/client_api.json` + `build-llm-context.ts:46`（当前**被注释掉**）→ AI 上下文。
   → 判定：**A9 说的"2 条死 1 条、改 1 行可再生"数字上对，但"可再生 = A 类"不成立。修复本体是 A 类；落地是 B 类（换 API_RES hash）+ 需要 §6 的 B-6 两步走。**

### 4.3 版本漂移（全部实测）

| 项 | 值 | 出处 | 问题 |
|---|---|---|---|
| 根产品版本 | `2026.1.4` | `package.json:3` | 基准 |
| `openapi.json` `info.version` | **`0.2.0`** | `internals/apis/openapi/openapi.json:5` | 🔴 **不是从 package.json 读的**，是 `internals/apis/scripts/generate-openapi.mjs:324` 里的**字面量 `version: '0.2.0'`** → **A 类 1 行修**（改为读 `package.json` 或读 `@box/apis` version） |
| `@box/apis` 包版本 | `0.2.0` | `internals/apis/package.json:3` | 与 openapi 一致，但和产品差 4 年 |
| 版本同步闸覆盖 | **6 个 package.json + 3 个 Cargo.toml + 2 个 compose + 2 个 Cargo.lock** | `scripts/sync-root-version.js:11-25` | 🔴 **`internals/apis`、`apps/game`、`services/game-server`、`packages/*`、`internals/*` 全部不在同步集里** → 32 个有 version 的包里 **0 个等于 2026.1.4**（完整版本表见下） |
| 一致性策略 | `rush.json` `"ensureConsistentVersions": false` | `rush.json:6` | 🟡 上游有意放开 → 同一依赖跨项目多版本，lockfile 漂移的温床 |
| 32 个包的版本 | `0.0.0 … 2.1.0`（`@box/utils`/`@box/regl` 2.1.0，`@box/voxa-project` 1.3.5，`@box/mudb` 1.0.4，`@box/game`/`@box/game-server` **1.0.0**，`@box/apis` **0.2.0**，`@box/deployment-routing` 0.1.0） | `git ls-files "*/package.json" \| xargs node -e …` | `workspace:` 引用是钉版本的（如 `@box/schema": "workspace:~0.4.3"`）→ **改包 version 是 C 类**（会红 `rush check`） |
| 文档站 | `docs.box3lab.com/api/` = 404（`ANALYSIS §3.4`） | — | 已在案 |

**3 个 package.json 的 `test` 脚本是 `echo "Error: no test specified" && exit 1`**（`packages/{utils,content-server,script-api}`）：`command-line.json` 的 `build` 有 `ignoreMissingScript:true`，但 `test` 走 repo-tasks 白名单，所以这三条恒红脚本目前**没人触发**——一旦有人把 `rush test` 改回 bulk，它们会立刻变成假失败。

### 4.4 dts ↔ 实现漂移的检测建议（按成本排序，全部复用已有能力）

| 成本 | 手段 | 用哪个已有件 | 能抓到什么 |
|---|---|---|---|
| 极低 | **接线** `npm run test:script-types`（`apps/game/scripts/check-editor-types.ts`） | 已有：它建 `ts.LanguageService`，对 `api-declarations.dts`+`server-api-types.dts` 与 `box3-server-api.d.ts` 两套库各跑一遍，**断言 completion 含 9 个 anticheat 方法、7 个 moderation 方法，且断言 `world.anticheat`/`mapId`/`scope` **不**出现**、断言"合法调用 0 诊断 / 非法调用 >0 诊断" | dts 少写/多写/签名漂移、客户端 SDK 泄漏服务端 API（这是**安全**断言） |
| 极低 | 给 `check-openapi.mjs` 加 2 行：`assert.equal(document.info.version, require('../package.json').version)` | 已在 `prepareTestDependencies()` 里跑 | §4.3 的 0.2.0 |
| 低 | 把 §2.2 的 md5 重复组清单**做成一份 allowlist 文件**，然后加一个闸：**同一组内文件必须字节相同**（漂移即红） | 一条 `md5sum \| sort \| uniq -d` | 10 组跨端协议/存档 schema 的"只改一端" |
| 低 | 生成物新鲜度闸：重跑 `build_isolate` / `build-apis` 后 `git diff --exit-code` | 复用 `internals/apis` 的 `--check` 惯例（`generate-openapi.mjs --check`） | §2.7 的 35,008 行 bundle 过期 |
| 中 | 数 d.ts 里的可调用面并与 G3 指纹对账（G3 已有 `contract.server.fingerprint.sha256 = 5bcc18f8…2865`） | `box3-re/impl/G3-map-compat-baseline.md` 附录①③④ | 声明面数量漂移（398→?） |
| 中 | 对 `@box/schema` 补 `test` 脚本并接进 `check()`（它连 test 都没有） | `packages/mudb` 的 41 个 tape 测试可作模板 | 全部 RDA/存档 schema |

**注意**：`impl/GATES.md` 的门是"地图还能不能玩"，上面这些闸量的是"声明和实现是不是同一件事"——两者互补，不互相替代。

### 4.5 AI 上下文断链的因果（本轮新串起来的一条）

```
apps/game/client-api-tsconfig.json:7  include 指向已删除的 src/engine/script/apis/*.ts
        ↓ tsc 静默通过，只产出 js/common.d.ts
apps/game/scripts/build-llm-context.ts:46   // runTsc('client-api-tsconfig.json', …TEMP_DIR/client_api)   ← 被注释掉
        ↓
services/game-server/src/edit/ai/llm-context.d.ts (1,533 行, 入库生成物) 只含 api/* 服务端族
        grep -cE "ClientWorld|GameUIScreen|client" → 3（全是服务端文件里的名字碰巧带 client）
        ↓
services/game-server/src/edit/ai/ai-server.ts:70
  "- Client Scripts: The entry file is 'clientIndex.js'. Do NOT generate client scripts. The client API is currently not supported."
```
→ 这条链把 `ANALYSIS §3.4`（A10 修订）里"地形/UI 服务端可编程写入口为零 + AI 不产客户端脚本"从"产品选择"降级为**一处死 include + 一行注释导致的可修复退化**。`impl/N2-mcp-ai-map-authoring.md` 的切片 A/B 若打算让 AI 产客户端脚本，**前置任务就是 §6 的 B-6**，且成本主要在 API_RES 重算而不是模型侧。

---

## 5. C 类禁区：地图兼容地雷清单（主动标注）

用户红线 = **优化不得破坏现有地图功能**。以下六处**任何"看起来更干净/更严格/更快"的改动都会直接打死老地图**，本轮及后续都不得触碰语义。

**地雷 1 —— `world` / `player` / `entity` 对象没有也不该有 freeze/seal/preventExtensions。**
实测：全仓 `Object.freeze` 手写命中只有 **7 个文件**，全部在 `services/game-server/src/anticheat/`（`action-data.ts`、`anticheat-script.ts`、`message-categories.ts`、`player-tracker.ts`、`tracker-snapshot.ts`）+ `apps/game/shared/creator-{cli-,}policy.ts`。它们冻的是**反作弊事件载荷**（`check-editor-types.ts` 里就有断言"tracker history 必须只读"）。
而 `impl/G3-map-compat-baseline.md §2.4` 实测真实地图在 API 对象上挂了 **86 个未声明自定义属性**（`world.Quanjujiaoyi`、`world.TKSY_ADMIN`、`world.Kp_top100`、`player.wearables`、`world.chatkg`、`world.drawSummer`、`world.dressUp`、`world.jykg`…），§2.4 另注明**含假阳性未清洗**。
→ **禁止**：给 `world/player/entity/voxel/gui` 加 `Object.freeze`/`seal`/严格 `Proxy` 的 get/set 白名单/"未声明属性即抛错"。`binding-factory.ts:509` 的 `schema()` 生成分支甚至**主动**在脚本对象上 `if (typeof … !== 'object') { … = {} } Object.assign(…)` —— 往脚本对象挂东西是设计意图。
**证明手段**：`impl/GATES.md` G3 + `impl/G3-map-compat-baseline.md` 的 `compat-check.sh`（86 属性清单为基线），加 `node --test scripts/local-player-identity.test.js`。

**地雷 2 —— mudb 的 numeric protocol ID 按注册顺序分配。**
`scripts/check-engine-wire-protocols.js:26-28` 原文注释：**"MuDB assigns numeric protocol IDs by registration order. Even disabled local features need matching transport slots on both sides of the engine socket."** 该闸用 `indexOf` 顺序断言去比对 8 个文件里的 token 出现次序（`apps/game/src/engine/game-client.ts`、`src/client/play/play-client.ts`、`src/client/index.ts`、`src/engine/teleport/teleport-client.ts`、`services/game-server/src/script/script-host.ts`、`src/createServer.ts`、`src/teleport/teleport-server.ts`、`apps/local-engine/src/launcher.js`）。
→ **两个方向的禁止**：(a) 不许"重排/整理注册顺序"、不许把注释掉的 `entity-bindings.ts:1039` 那种死绑定顺手删掉；(b) **反过来，§2.1 对照 1/3 那种"跨文件抽公共层"的 A 类重构，一旦把 token 从被闸盯住的 8 个文件里搬走，`check-engine-wire-protocols.js` 会红** —— 这条必须在 refactor 前确认：搬的到底是 8 个文件里的 token，还是 `pages/api/**` 里的（后者安全）。
`packages/mudb/src/schema/sorted-array.ts:54` 的 `// FIXME: use diff instead` 与 `src/socket/net/util.ts:10` 的 `// TODO minimize buffer allocation` 都在这颗雷上。

**地雷 3 —— 存档/包二进制：`box-encode` + `stableStringify` + CIDv0。**
`internals/build-system/utils/box-encode.ts` ≡ `services/game-server/src/voxel/box-encode.ts`（字节相同）。`internals/schema/mesh/modelMeshSchema.ts:101-221` 的 12 处 `meshBuffer[ptr+N]` 手工字节写位是 `.mesh` 布局。CIDv0 = `sha256 → Buffer.concat([0x12,0x20,digest]) → base58`，**3 处独立实现**（§2.5），且 CID 字符串出现在 blob 文件名里（`apps/local-engine/data/blobs/Qm…` 44 位 base58 与 `-4Z3u_…` URL-safe sha256 两套命名共存，见 `project-manager.js:53-56` 注释）。
→ **禁止**任何"顺手统一编码工具/换个更稳的 stringify"。可以抽函数，但**必须逐字节比对旧输出**（G4 的包 hash 基线）。

**地雷 4 —— 10 组跨端字节级重复的协议/schema（§2.2）。**
合并到公共包本身是 B 类，但**必须先建"两端字节相同"闸再合并**；否则改 `apps/game/src/client/edit/replica/schema.ts` 而 `services/game-server/src/edit/replica/schema.ts` 不动 = **编辑会话静默错列**（RDA 列顺序变 → 老地图的 `EntitiesTreeRDA` 全错位）。

**地雷 5 —— 已发布包格式与作者可见契约面。**
`packages/script-api/package.json` 的 `"files":["./dts/*","./libs/*"]` + `exports["./dts/*"]` + **非标准 `.dts` 扩展名**（`client-api-types.dts` / `server-api-types.dts`）是对外发布物。`box3-server-api.d.ts` 是 398 个可调用的载体。`@box/schema` 等被 `workspace:~0.4.3` 钉住 → **改包 version 会红 `rush check`**。
→ **禁止**：改 dts 文件名/扩展名/导出路径、从 `box3-server-api.d.ts` 删任何成员、把 `packages/script-api/dts/client-api-types.dts` 的 surface 收窄（`ANALYSIS §3.4`：客户端声明面只有 32 个可调用，运行时实现约 156 个 → **声明面比实现面窄，收窄声明就是删地图脚本正在用的运行时能力的解释文档**）。

**地雷 6 —— 按地图**名字**正则改行为。**
`apps/game/server/map-info.ts:14-50`：`CUSTOMIZE_CONFIGS` 用 `/digitalblockland/i`、`/fantour/i` 匹配**地图名**来发不同 `customizeType`，上面就是 `// TODO: 移除这个怪异的东西` + `// FIXME Redirect the legacy map`（`:52`）。
→ 这条看着像死代码、像"商业合作方硬编码可以清掉"，但它是**输入=地图标题、输出=行为**的隐藏契约：删掉它，任何名字含 `fantour`/`digitalblockland` 的现存地图行为会变。**禁止顺手清理**；若要清，需要先把两条分支的行为差异测出来（G3）。

**其它值得挂号的"看起来像优化实则改语义"**：
- `apps/game/src/engine/script/scheduler.ts:49-52`：`_setTimeout` 把 delay 夹到 `MIN_TIMESTEP_MS`，注释写明是"防止 `setTimeout(x,0)` 递归打死服务器"，并 `TODO remove this when we deal with infinite time consumtion better` → 这是**每张地图所有 client 脚本的定时器语义**。
- `apps/game/src/engine/script/ses/apis/index.ts:129-133`：`// ses 去掉了 Math.random … 不过我们本来就要暴露时间 … 安全性问题我们通过审核来避免` 然后把 **`Math` 和 `Date`** 注入客户端脚本全局。→ 把这两项从注入面里"收紧"会打死所有用 `Math.random()` 的地图脚本（且这是有意的安全换可用的取舍）。
- `apps/game/pages/api/local-projects/[id]/{publish,export,package}.ts`：见 §2.1 对照 2 的授权面警告（`ANALYSIS §3.4` A10 越权面）。

---

## 6. 优先级重构清单（18 条，按 收益/半径 排序）

> **改动半径**：文件数 / 行数，尽量给实测值。**证明手段**一律优先复用仓库已有闸。

### A 类 —— 零行为变更，可直接做

| # | 动作 | 半径 | 风险 | 用什么检查证明行为没变 |
|---|---|---|---|---|
| **A-1** ⭐ | **`scripts/repo-tasks.js` 的 `check()` 里补 1 行 `scripts/check-image-budget.test.js`**（挂在 `:120` 那段裸 `node --test` 末尾） | 1 文件 / +1 行 | 极低 | `node --test scripts/repo-tasks.test.js`（已在白名单，211 行）+ `node --test scripts/check-image-budget.test.js`（19 tests） |
| **A-2** ⭐ | **把 13 个零引用的 `scripts/*.test.js` 接进 `check()`**（§3.4 全名） | 1 文件 / +13 行；激活 **1,159** 行断言 | 低（测试本身可能已红 → 先逐个 `node --test` 试跑再入清单） | 每个文件自身 `node --test <file>`；`rush verify` 不受影响 |
| **A-3** ⭐ | **把 `packages/mudb` 的 41 个 tape 测试接进 `check()`**（`npmScript('packages/mudb','test')`，或先只接 `src/{schema,rda,stream}/test`） | 1 文件 / +1 行；激活 7,701 行断言 | 低-中（`tape -r ts-node/register` 慢；先跑一次量时间） | 直接 `cd packages/mudb && npm test` 记录 pass 数；再进 `check()` |
| **A-4** | **抽 `withDeploymentMode(mode, handler)` 消掉 31 处一行门 + 14 处错误尾巴**（§2.1 对照 1/2） | ~39 个 `apps/game/pages/api/**` 文件 / ~300 行换 ~60 行 | 低（404/400 报文逐字节等价） | `node scripts/check-public-routing-structure.js` + `apps/game/scripts/check-http-compatibility.ts` + `node scripts/check-standalone.js`；**且必须先确认这 39 个文件不在 `check-engine-wire-protocols.js` 盯的 8 个文件里（它们不在）** |
| **A-5** | **`client-api-tsconfig.json:7` include 改为 `"src/engine/script/ses/apis/**/*.ts"`**（1 行，glob 必须带 `**`，§4.2） | 1 文件 / 1 行 | 低（**但产物变** → 落地属 B-6） | `git diff --stat apps/game/scripts/assets/client_api` 只应新增；**不许**在同一 PR 跑 `prepare-assets` |
| **A-6** | **删 4 个零引用死文件**：`gpu/postprocess-legacy.ts`(1,138)、`settingPanel/gameDetailEdit.tsx`(763)、`ai-elements/open-in-chat.tsx`(365) + `entity-bindings.ts:1038-1039` 死注释 | 3 删 1 改 / **−2,266 行** | 低（0 引用已实测） | 删除前后各跑 `node scripts/check-standalone.js`（§4.3 已知 `:1501` 有回归需先处置，见 pending D4）；`next build` 通过 |
| **A-7** | **`generate-openapi.mjs:324` 的 `version:'0.2.0'` 改为读包/根版本**，并在 `check-openapi.mjs` 加 2 行断言 | 2 文件 / ~4 行 | 低（openapi 文档字符串变，paths/operations 不变） | `cd internals/apis && npm run check:openapi` + `npm run test` |
| **A-8** | **建"跨端 schema 双胞胎必须字节相同"闸**：把 §2.2 的 25 组白名单落一份 allowlist + 一个 `node scripts/check-duplicate-sources.js`（复用 `check-core-module-structure.js` 的写法） | 2 新文件 / ~120 行；**不改被测码** | 极低（纯新增闸） | 自己就是证明；红→说明已存在漂移，需先修漂移 |
| **A-9** | **给 `ivm2-script-entry.js` / `scripts/assets/api` 加"重生成后 git diff 必须为空"新鲜度闸**（§2.7） | 1 新脚本 / 1 行接进 `check()` | 低（首跑可能红 → 红了说明 bundle 已过期，那才是重点） | `npm --prefix services/game-server run build_isolate` + `git diff --exit-code services/game-server/src/assets/isolate/` |
| **A-10** | **把 `packages/mudb/tsconfig.json` 的 `outDir: "."` 改成 `outDir: "build"`** —— ⚠️ 本条虽纯机械但**会改 `package.json` `main`**，见"注意"；降级为 **B-7** | — | — | — |
| **A-11** | **`ui-tree-controller.ts` 27 处守卫抽 `resolveUIElement()`** | 1 文件 / ~120 行→~15 行 | 极低（纯本地私有函数） | `cd apps/game && npm run lint`（唯一真带 TS parser 的 lint 门）+ `npm test`（jest 81 文件） |
| **A-12** | **`fs.rmSync(temporaryRoot,{recursive:true,force:true})` 12 站点抽 `withTempDir()` 助手**（`apps/local-engine/scripts` 6 + `project-manager.js:883,1352,1716,1767,2841`） | 8 文件 / ~40 行 | 低 | `node --test apps/local-engine/src/{build-metadata,runtime-assets}.test.js` + `node apps/local-engine/scripts/regression-project-storage-identity.js`（**project-manager.js 属 `check-editor-types` 之外的重点，G3 的存档链必须过**） |
| **A-13** | **删 `slim/*.md` 的 9 份字节级副本**（§2.8），只留 `slim/README.md` 指向 `box3-re/` | 9 删 / −约 2,600 行文档 | 极低 | 不需要证明（非代码） |
| **A-14** | **`slim/` 补进 `.prettierignore` 或 `owned-code-config.cjs.directories`** —— 现状是**两处都没写**（`grep -c slim scripts/lib/owned-code-config.cjs` = 0，`grep -c slim .prettierignore` = 0），而 `slim/poc/*.mjs` 用分号+2 空格、根 prettier 是 `semi:false` → **`rush format-check` 对我们自己的 12 个 PoC 文件是红的** | 1 文件 / 1 行 | 极低 | `node scripts/format-owned-code.js`（76 行，零依赖）；⚠️ 本轮 `rush install` 红，需在能跑时装上验证 |

### B 类 —— 改内部结构、保持外部契约，**需兼容性闸背书**

| # | 动作 | 半径 | 风险 | 证明 |
|---|---|---|---|---|
| **B-1** ⭐ | **合并 10 组跨端协议/schema 副本到 `@box/schema`（或新 `packages/wire`），两端 import 同一份** | ~18 文件 / ~2,000 行；消掉 10 组"只改一端" | 中-高：RDA 列顺序 / WS 帧槽位（地雷 2） | **前置 = A-8**。`node scripts/check-engine-wire-protocols.js` + G3 `compat-check.sh` + G4 包 hash + `services/game-server npm test` 的 21 个 regression + 打开真图跑 `world.entity` 读写冒烟 |
| **B-2** | 把 `apps/game/src/engine/{gl,gpu}` 双后端的公共数学/资源生命周期下沉到 `apps/game/src/engine/render-common/`（§2.6 末，17,498 行 / 16 个同名文件） | ~40 文件 | **高**：视觉输出属作者可感面（等于半颗 C 雷） | 逐帧截图比对（E 泳道基线）；`scripts/regression-empty-mesh-asset.js`；建议**推迟**，只在新增后端时做 |
| **B-3** | 拆 3 个 ≥700 行的装配函数：`createServer.ts:117-999`(882)、`entry.ts:144-808`(664)、`launcher.js:759-1525`(766) —— launcher 那条**必须等 P2-1（`impl/P2-1-supervisor-removal.md`）合完再做** | 3 文件 | 中（launcher 的 argv/env/端口/信号已被 A5b 逐字审计过） | `node --test scripts/launcher-package-modes.test.js`（**当前零引用 → 先做 A-2**）+ G3/G4 + `impl/P2-1-supervisor-removal.md` 的改前/改后 argv+env diff 桩 |
| **B-4** | `packages/utils` 作为唯一 canonical：`promise-wrapper`(×4)、`safe-eval`(×2)、`pairing-heap`(×2)、`init-array`(×2)、`codegen`(×4) 全部改成 `@box/utils/…` import | ~11 文件 | 中：`services/game-server` 已依赖 `@box/utils`（`package.json` 里 `"@box/utils":"workspace:*"`）✅；`apps/game` 需确认 dep | `npm --prefix services/game-server run build` + 21 regression；`check-editor-types` 不该变 |
| **B-5** | 抽 `sha256`/`base58`/`stableStringify`/CIDv0 成 `packages/box3-pack`（§2.5：3+5+1+2 套实现，`ANALYSIS §3.4` 估 <1,500 行） | ~8 文件 | **高**（地雷 3：CID 字符串 = blob 文件名 = 已发布包格式） | G4 包格式 hash；对 `apps/local-engine/data/blobs/` 现有样本做**逐摘要**比对；**禁止**在本轮做 `spawnSync tar` 替换（`project-manager.js:2543-2569`） |
| **B-6** ⭐ | **A-5 的落地半段**：重开 `build-llm-context.ts:46`，把新生成的 client DTS 真送进 `llm-context.d.ts` 与 API_RES，并**相应重训 `ai-server.ts:70` 那句"Do NOT generate client scripts"** | 3 文件 + 1 份生成物 | 中-高：换 API_RES hash、换 AI 行为（作者可感） | `apps/game/scripts/check-editor-types.ts` 的 `clientProbe`（**它已经在断言客户端不得暴露 `world.anticheat`**，正好是新 client DTS 的验收闸）+ 先接线（A 里那条 `build:script-types`）|
| **B-7** | 把 `packages/mudb` 的 `outDir:"."` 挪到 `build/`，并同步 `package.json` `main`/`browser`/`types` | mudb 全包 + 所有 `@box/mudb` 消费方 | 中-高：**`clean` 脚本 `rm -rf *.js` 会删 140 个 tracked 文件**（§2.7），改前必须先决定这 140 个入库 JS 的去留；`main:"index.js"` 是**已发布包入口** → 入口改属 C 边界 | `services/game-server` 21 regression + 打开真图看 mudb 同步；`rush check` |
| **B-8** | 把 `internals/schema` 补上 `test` 脚本并把已有 `packages/mudb/src/**/test` 的模式复制过来（它现在连 `test` 都没有，36,337 行） | 1 + N 文件 | 中（新写测试的工作量） | `npmScript('internals/schema','test')` 进 `check()` |

### C 类 —— **禁止**（除非同时给出向后兼容路径）

| # | 会被误当成优化的动作 | 为什么禁 | 唯一可接受的兼容路径 |
|---|---|---|---|
| **C-1** | 给 `world/player/entity/voxels/gui` 加 `freeze`/`seal`/`preventExtensions`/严格 Proxy 白名单 | 地雷 1：**86 个未声明自定义属性**直接写不进去，老地图当场报错 | 只做"观测型"改动：`Proxy` 的 `get/set` 记日志不拦截；灰度一版后再谈 |
| **C-2** | 从 `box3-server-api.d.ts`(4,603) / `client-api-types.dts` 删成员、改名、收窄重载 | 地雷 5 + §4.1：398 可调用是作者契约；`G3 §2.4` 另有 55 个"已声明且被真图实际调用"的最小保留集 | 只**加**不减；要减先按 G3 的 55 项最小集 + 86 项隐藏面做全量真图扫描 |
| **C-3** | 重排 mudb schema 注册顺序 / 删除注释掉的绑定 / 合并"多余的" transport 槽 | 地雷 2：`check-engine-wire-protocols.js` 明文"按注册顺序分配数字 protocol ID，禁用的特性也要占位" | 不许"整理"，只许**追加** |
| **C-4** | 统一 `box-encode` / `stableStringify` / mesh 字节写位 / CID 生成 | 地雷 3：改一个字节 = 所有已发布包与 `.mesh` 存档解引用 | 抽函数可以，**逐字节 diff 旧输出**可以，换算法/换字段序不可以 |
| **C-5** | 改 `packages/script-api/dts/*.dts` 的文件名、`.dts` 扩展名、`package.json` 的 `exports["./dts/*"]`/`files` | 地雷 5：**已发布包格式** | 加新导出、留旧导出为别名 |
| **C-6** | 删 `map-info.ts` 的 `fantour`/`digitalblockland` 名字正则（`// TODO 移除这个怪异的东西`） | 地雷 6：输入是**地图标题**，输出是行为 | 先把两条分支的行为差异测出来并确认可合并 |
| **C-7** | 收紧 `scheduler.ts` 的 `MIN_TIMESTEP_MS` 夹逼、或从 ses 注入面里去掉 `Math`/`Date` | §5 末两条：这是每张图的定时器语义 + 客户端脚本可用全局集（`ses/apis/index.ts:129` 注释表明**有意为之**） | 只能放宽或按地图版本双轨 |
| **C-8** | 顺手把 `publish/export/package/play-import` 的授权门并入 A-4 的公共 handler | §2.1 对照 2 警告 + `ANALYSIS §3.4` A10：`:105` 查用户级 `creatorPermissions`、`:141` 才是 9 项 CLI scope | 只并**404 门**，授权调用留在原处 |
| **C-9** | 推翻 `.prettierignore` 对 `apps/game/`、`services/game-server/`、`internals/`、`packages/*` 的整目录豁免去"全仓格式化" | 400k 行纯格式 diff = 无法 review，且注释已写明是为避免兼容性 diff（§1.5） | 只做 owned 目录；新写的引擎补丁单独 prettier |
| **C-10** | 把包 version 拉齐到 `2026.1.4` | §4.3：`workspace:~0.4.3` 一类钉版本会当场红 `rush check` | 只把 openapi/`@box/apis` 加进 `sync-root-version.js` 的 `jsonFiles`，别动被钉的那 32 个 |

---

## 7. 最划算的三条（一句话理由）

1. **A-1 + A-2 + A-3**：改 3 处、加 ≤15 行，一次激活 **13 + 41 = 54 个已经写好但从未执行的测试**（**7,701 + 1,159 = 8,860 行断言**），其中包含 P2-1 的靶子 `launcher-package-modes.test.js`、红线的 `local-player-identity.test.js`、以及整个 mudb diff 协议。**这是全仓性价比最高的一笔，且完全不碰源码语义。**
2. **A-4 + A-11 + A-12**：消掉 **31 + 27 + 12 + 14 = 84 个**可机械识别的重复站点，全部落在"报文/返回值逐字节等价"的范围内，且都能用仓库现成的 `check-public-routing-structure` / `check-http-compatibility` / `apps/game lint`（唯一带 TS parser 的门）证明。
3. **A-8 + A-9 + A-5/B-6**：先造"跨端 schema 双胞胎必须相同"和"生成物新鲜度"两道**新闸**（纯新增，0 风险），再修 client DTS，再让 AI 能看见客户端 API —— 这条链把一个三年没人发现的静默退化（§4.5）变成可回归的资产，并直接给 `N2` AI 接管切片铺前置。

---

## 附 · 一键复跑（只读，不碰容器/网络）

```bash
cd /d/desktop/神奇代码岛/box3-local-engine
export H="$(cygpath -u "$TMP")/o2-hand.txt"
git ls-files | grep -E '\.(ts|tsx|js|jsx|mjs|cjs)$' \
 | grep -vE '(^|/)(build|dist|generated|node_modules)/' | grep -v squoosh \
 | grep -vE '^packages/(icons|regl|voxa-project|vb-parser|utils|sdk|content-server|mesher|ao-mesher|box-design|rewgpu)/' \
 | grep -vE 'scripts/assets/(api|client_api)/' | grep -vE 'src/assets/isolate/' | grep -vE '^types/' > "$H"

echo "files: $(wc -l < "$H")  lines: $(xargs -a "$H" -d'\n' -n400 wc -l | grep -v ' total$' | awk '{s+=$1}END{print s}')"
echo "any: $(xargs -a "$H" -d'\n' -n200 grep -cE '(^|[^A-Za-z0-9_$.])any([^A-Za-z0-9_.]|$)' | grep -v ':0$' | awk -F: '{s+=$2}END{print s}')"
for p in TODO FIXME XXX HACK; do echo -n "$p: "; xargs -a "$H" -d'\n' -n200 grep -c $p | grep -v ':0$' | awk -F: '{s+=$2}END{print s+0}'; done
echo "empty-catch: $(xargs -a "$H" -d'\n' -n200 grep -oE 'catch\s*(\([^)]*\))?\s*\{\s*\}' | wc -l)"
echo "sync-fs: $(xargs -a "$H" -d'\n' -n200 grep -oE '\b(existsSync|readFileSync|writeFileSync|readdirSync|mkdirSync|rmSync|unlinkSync|statSync|renameSync|copyFileSync|appendFileSync|openSync|cpSync|spawnSync|execSync)\b' | wc -l)"
echo "deep-nest: $(xargs -a "$H" -d'\n' -n100 grep -c '^                ' | grep -v ':0$' | awk -F: '{s+=$2}END{print s}')"
echo "mode-guards: $(xargs -a "$H" -d'\n' -n200 grep -l BOX_DEPLOYMENT_MODE | wc -l)"
echo "byte-dup-groups: $(xargs -a "$H" -d'\n' -n200 md5sum | sort | awk '{h[$1]++}END{n=0;for(k in h)if(h[k]>1)n++;print n}')"
echo "unwired-scripts-tests: $(comm -23 <(ls scripts/*.test.js|xargs -n1 basename|sort) <(grep -oE 'scripts/[a-z0-9._-]+\.test\.js' scripts/repo-tasks.js|sed 's|scripts/||'|sort -u)|wc -l)"
echo "top15:"; xargs -a "$H" -d'\n' -n400 wc -l | grep -v ' total$' | sort -rn | head -15
```

未执行 / 需授权才能确认的项（诚实清单）：
1. `rush format-check` / `eslint .` / `tsc -p client-api-tsconfig.json` —— `node_modules` 未安装、`pnpm-lock.yaml` 与 `package.json` 不同步（`verify.yml:44-47` 自陈），本轮禁止 install → **A-14 的红、A-5 的产出规模均未实测**。
2. 153 个 ≥200 行块来自朴素花括号配对（剥了行注释与字符串），非 AST → 少数边界可能 ±10%；但 Top 12 已逐个 `sed` 目视核对。
3. §2.6 的"零引用"以 grep 为准；`apps/game` 里存在 `await import()` 动态拼路径的可能，删除前应对每个文件跑一次 `next build`。
4. G3 §2.4 自己声明 86 个隐藏属性"含假阳性未清洗"，本文按原数引用，未重新测量。
