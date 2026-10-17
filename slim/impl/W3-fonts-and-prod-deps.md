# W3 — 字体单副本/子集化 + typescript 挪出 prod（P0）

分支 `slim/local-deploy` @ `D:\desktop\神奇代码岛\box3-local-engine`。
所有数字来自真实执行；做不到/未做的以 **UNVERIFIED** 标注。度量基底：WSL `/var/tmp/re-arch`（428 MB 出厂 `/app` 真实副本），删除实验在 `/var/tmp/w3/standalone`（`cp -a` 自 `/var/tmp/re-arch/creator-next/standalone`）。

## 交付物清单

| 文件 | 动作 |
|---|---|
| `services/game-server/package.json` | `typescript: 5.6.3` 从 `dependencies`（原 61 行）挪到 `devDependencies`（现 83 行） |
| `apps/local-engine/src/build.js` | `cleanStandaloneArtifacts()` 的 `removablePaths` 新增删除 `.next/server/chunks/static`（字体第二副本的根） |
| `scripts/font-manifest.json` | 新建：每个字族每种格式的引用状态 + 实测字节证据 |
| `scripts/subset-fonts.mjs` | 新建：`analyze/plan/tools/apply` 四模式（详见 §3） |
| `common/config/rush/pnpm-lock.yaml` | **未改**（见 §1.3，待维护者有网 re-lock） |

自检：`node --check apps/local-engine/src/build.js` 通过；`node --test scripts/package-manifest-order.test.js` → fail 0；`node scripts/subset-fonts.mjs analyze` 在本仓库真实跑通（输出见 §3）。未触碰 `apps/local-engine/Dockerfile`、`apps/game/next.config.js`、CI。

---

## 1. typescript 挪出 prod

### 1.1 运行时证据（全部真实 grep，命中 0）

| 扫描对象 | 模式 | 结果 |
|---|---|---|
| `services/game-server/src` | `require('typescript')` / `from 'typescript'` / `ts.createProgram` | 0 代码命中（唯一命中是 `src/edit/ai/ai-server.ts:58` 的 \`\`\`typescript 文档围栏） |
| 出厂 dist `/var/tmp/re-arch/creator-services/game-server/dist` | 同上 | **0**（`hits: 0`） |
| 整个出厂 game-server 树（含全部 node_modules，排除 typescript 包自身） | `require("typescript")` | **0** |
| `internals/*`、`packages/*` 源码 | `from 'typescript'` / `ts.createProgram` / `transpileModule` / `createSourceFile` / `typescript/lib` | 0；唯一命中 `packages/script-api/scripts/fix-dts.js:3`（构建期 dts 工具，script-api 已把它放 devDeps） |
| 出厂 `node_modules/@box/*` 已安装代码 | `createProgram` / `transpileModule` / `require("typescript")` | **0** |

结论：引擎的作者脚本编译走 `@swc-node/register` + rollup（`@rollup/plugin-swc`），不碰 TypeScript compiler API；`tsc` 只在构建期被调用（`apps/local-engine/src/build.js:275-277` 用 `node_modules/typescript/bin/tsc`，builder 阶段 devDeps 齐全）。挪动是安全的。

### 1.2 诚实的关键限定：单改 game-server 不足以把 19.5 MB 挤出镜像

`apps/local-engine/Dockerfile:64,103` 用 `pnpm deploy --filter @box/game-server --prod` 生成运行时。以下 6 个 workspace 包同样把 `typescript` 声明在 **`dependencies`**，作为 game-server 的传递 prod 依赖仍会被装进 `/opt/game-server`（实测出厂镜像里 `node_modules/.pnpm/typescript@5.6.3` = **19,492,846 B** 就是这么来的）：

- `internals/build-system/package.json:47`（@box/build-system）
- `internals/schema/package.json:38`（@box/schema）
- `internals/env/package.json:49`（@box/env）
- `internals/vb/package.json:14`（@box/vb）
- `packages/utils/package.json:35`（@box/utils）
- `packages/content-server/package.json:41`（@box/content-server）

以上 6 个文件不在我的所有权内，未改动；它们同样有 §1.1 的 0 运行时命中证据支持挪动。另注：平行泳道已出现 `scripts/prune-standalone.mjs`（从 traced standalone 虚拟仓库里按规则剔除 typescript 工具链，作用于 next 镜像侧），与本改动互补、无文件冲突。

**因此：镜像端 19.5 MB 的移除 = UNVERIFIED**（需 6 包同改 + re-lock + 重建镜像后才能实测；装进去的体积 19,492,846 B 是实测，"移除后不炸运行时"有上面的 0 命中证据链支撑）。

### 1.3 lockfile：待维护者执行（故意不手改）

不跑 `rush update`（联网 + 海量 IO，契约禁止）。需要的步骤与影响面：

1. 有网环境执行 `node common/scripts/install-run-rush.js update --to @box/game-server`。
2. 预期 diff 仅落在 `common/config/rush/pnpm-lock.yaml` 的 importer `services/game-server` 段：`typescript` 从 `dependencies:` 移到 `devDependencies:`；`typescript@5.6.3` 包条目本身保留（§1.2 的 6 个 importer 仍声明 prod）。
3. **在 re-lock 完成前，任何跑 `rush install` 的构建（含 Docker builder 阶段）会因 lockfile 与 package.json 不一致而红** —— 这是给 W2 的显式预警。

---

## 2. 字体单副本：删 `server/chunks/static`（实测）

### 2.1 改动

`apps/local-engine/src/build.js` `cleanStandaloneArtifacts()` 的 `removablePaths` 增加
`path.join(standaloneGameRoot, '.next/server/chunks/static')`。creator/play 两种模式都经过该函数（build.js:256 调用），build.js 自身的 `.next/static` → standalone 的 copy 逻辑（240-246 行，保留的那一份）未动。

### 2.2 安全性证据

- 7 个被删文件与 `.next/static/media/` 同名文件 **md5 逐一相同**（实测输出：`IDENTICAL × 7`，如 `ChillRoundGothic-Bold.096e89c0.ttf = 77ba30fddce7c72c7e5c29da660746d6`）。
- server chunks 只是把 `static/media/...` 当**路径字符串**引用：`server/chunks/4992.js` 里 `c.p+"static/media/ChillRoundGothic-Bold.096e89c0.ttf"`；SSR 不读字体二进制。
- 浏览器所有 `/_next/static/*` 请求由 standalone 服务从 `.next/static/` 提供 —— 被保留的正是这一份（`static/media` 全量 106 文件、36,201,423 B，原样保留）。

### 2.3 实测（/var/tmp/w3，真删 + du）

```
cp -a creator-next/standalone → /var/tmp/w3/standalone
BEFORE  du -sb = 235,604,933 B   (du -sh 246M)
AFTER   du -sb = 212,655,144 B   (du -sh 224M)
节省    22,949,789 B ≈ 21.9 MiB（与目录 du -sb 22,949,789 完全吻合）
```

被删文件完整清单（均位于 `.next/server/chunks/static/media/`）：

| 文件 | 字节 |
|---|---|
| ChillRoundGothic-Bold.096e89c0.ttf | 12,364,772 |
| ChillRoundGothic-Bold.af6f1f22.woff | 7,925,528 |
| DoulosSILR.90757c6f.ttf | 1,721,928 |
| Code-New-Roman-Bold.8cda2b7e.woff | 356,433 |
| Code-New-Roman-Bold.007dc0b2.otf | 356,308 |
| Rubik-Regular.6bff33d9.ttf | 207,632 |
| rubik-v20-latin-regular.889af360.woff2 | 17,188 |

复测脚本：`box3-re/tools/w3-measure.sh`（连同 md5 证明）。注意：本次实测对象是 `.ttf+.woff` 双份全量（22.95 MB），不只是任务描述里的 ChillRound 两份（20.29 MB）。

---

## 3. 格式收敛 + 子集化（scripts/subset-fonts.mjs）

### 3.1 工具探测（`node scripts/subset-fonts.mjs tools` 真实输出）

Windows：`fc-scan: false, pyftsubset: true, python -m fontTools: true`。WSL：`pyftsubset MISSING, fc-scan OK, node MISSING`。**因为本机真有 fontTools，子集化做了真实实验（见 3.3），不是纯纸面。**

### 3.2 analyze 真实输出（仓库源码目录模式）

- `deleteNow`（全仓 0 引用，可删）：`apps/game/assets/fonts/MiSans-Regular.ttf` **8,073,152 B**。它没有进镜像（Next 不打包未引用资源），省的是仓库/打包源体积。脚本只列不删（apply 需 `--yes`，且 assets 不在我的所有权内，未执行）。
- `rustyBranchOnly`（有引用但仅 Rusty 分支，脚本**永不自动删**）：ChillRoundGothic-Bold.ttf 12,364,772 + Code-New-Roman-Bold.otf 356,308 + Rubik-Regular.ttf 207,632 = **12,928,712 B**。
- 其余 19 个 live 文件 21,500,637 B 保留。

### 3.3 子集化实测（pyftsubset，真实跑，输出在临时目录，未回写仓库）

取"全 CJK 通用范围"（U+0020-007E,00A0-00FF,2000-206F,2190-21FF,2460-24FF,25A0-27BF,2E80-33FF,4E00-9FFF,F900-FAFF,FE30-FE4F,FF00-FFEF）与拉丁对照：

| 字族 | 原文件 | 全 CJK→woff2 | 变化 | 仅拉丁→woff2 |
|---|---|---|---|---|
| ChillRoundGothic-Bold.woff（cmap 27,183 码位） | 7,925,528 | 6,047,012 | −23.7% | **12,356（−99.8%）** |
| MiSans-Regular.woff（cmap 28,967） | 5,369,488 | 3,018,328 | −43.8% | — |
| MiSans-Bold.woff | 5,396,884 | 3,103,380 | −42.5% | — |

同范围 woff→woff（不换压缩格式）：7,925,528→7,427,264（−6.3%），说明大头来自 woff2（brotli）+ 剔除假名/谚文/扩展区字形。**"按 unicode-range 分片可省 85-95%（首屏）"有业界数据支撑**：Google Fonts 官方文档称 `text=` 定制子集"最多可把字体文件缩小 90%"（[Google Fonts API 使用入门](https://developers.google.cn/fonts/docs/getting_started?hl=zh-cn)）；HarmonyOS Sans 用 unicode-range 拆 96 子集，完整 woff2 8.1 MB、首屏 44 个子集仅 1.1 MB（[盘点字体性能优化方案](https://m.blog.csdn.net/2301_79099499/article/details/152178316)）；3500 常用汉字覆盖日常汉字 99.82%（[前端字体截取](https://blog.csdn.net/weixin_34378922/article/details/87953858)）。
**发布子集字体 = UNVERIFIED**：需要产品定范围（上表的"全 CJK"仍不含 CJK 扩展 A U+3400-4DBF 与补充平面，作者地图里的人名/生僻字会掉回退字体），且要同步改 CSS `@font-face`/defs.ts 并回归中文渲染 —— 不在本泳道所有权内。脚本输出 `subsetPending`（含现成 pyftsubset 命令、标记 ready-to-run/UNVERIFIED）供后续执行。

### 3.4 关键正确性问题："删 .ttf 会不会弄坏中文渲染？" —— 逐格式引用证据

浏览器实际加载链（全部 `path:line` 实测核对）：

1. **页面 CSS**：MiSans 只引用 `.woff`（`apps/game/app/common.css:241,249`；`apps/game/pages/common.css:394,402`；`apps/voxa/pages/common.css:32,40`）。CSS 里没有任何 `url(*.ttf)` 指向 MiSans。→ 中文正文走 woff，**MiSans 无 ttf 进镜像**（media 目录实测只有 `MiSans-*.woff` 两个 5.4 MB woff；"MiSans ttf 双份"说法与实测不符，已在清单修正）。
2. **game-ui JS FontFace**（`apps/game/src/engine/game-ui/nodes/defs.ts`）：
   - `:101` Rubik：`process.env.RUSTY ? Rubik-Regular.ttf : rubik-...woff2` — web 走 woff2。
   - `:118` ChillRoundGothic：`process.env.RUSTY ? ttf : woff` — web 走 woff。
   - `:132` Code-New-Roman：`process.env.RUSTY ? otf : woff`。
   - `:146` DoulosSILR：**无条件 `src: DoulosSILR`（ttf）** — EN-Serif 是纯拉丁字体，web 真用 ttf，1.7 MB，**必须保留**（W2 断言里不能一刀切 `**/*.ttf`）。
3. **编译产物里的形态**：出厂 chunk（`static/chunks/8438.0f6893bc0998f354.js`）实测保留 `l=n.p+"static/media/ChillRoundGothic-Bold.096e89c0.ttf"` 与 woff 两个 URL，分支为运行时属性访问 `!!r.env.RUSTY`。Next 浏览器端只内联 `NEXT_PUBLIC_*`，本地引擎 web 构建不设 `RUSTY` → ttf 分支在 web 上是死代码，但**字符串引用仍存在于 bundle**，按"只删未引用格式"的铁律，ttf 不删，列入 rustyBranchOnly，等 defs.ts/构建标志的决策（非本泳道所有权）。
4. **KaTeX**：shipped CSS `2f46e0db0d4a3aed.css` 同时引用 woff2/woff/ttf 三格式（每格式都被 @font-face src 引用）→ 不删；由 katex 依赖自管。

**结论：删 `.ttf` 不会弄坏 web 中文渲染（中文 web 实际加载的全是 woff/woff2）；本改动一处 `.ttf` 都没删。** 会坏的场景只有 Rusty 原生客户端（`process.env.RUSTY` 为真时 `defs.ts:118` 加载 ttf），所以 ttf 收敛动作全部挂起、留给 manifest+脚本标记。

---

## 4. 给 W2 的成品镜像断言清单

creator / play next 镜像（`/app` 下）：

1. `**/.next/server/chunks/static/**` → **0 个文件**（本泳道 §2 的删除断言；当前出厂基线 7 文件 22,949,789 B）。
2. `**/static/media/MiSans-Regular.ttf`、`**/assets/fonts/MiSans-Regular.ttf` → 0（源文件删除后）。
3. **不许断言** `**/*.ttf → 0`：`DoulosSILR.90757c6f.ttf`（web live）与 KaTeX `*.ttf`（CSS 引用）必须保留；`ChillRoundGothic-Bold.*.ttf`、`Rubik-Regular.*.ttf`、`Code-New-Roman-Bold.*.otf` 保留在 `.next/static/media`（单份）直到 defs.ts 决策。
4. game-server 运行时树 `**/node_modules/.pnpm/typescript@*/**` → 0 —— **前置条件**：§1.2 的 6 包同改 + re-lock + 重建，否则该断言必红（当前基线 19,492,846 B）。
5. 回归：creator 镜像起服后浏览器加载含中文地图，Network 面板应只出现 `MiSans-*.woff` / `ChillRoundGothic-Bold.*.woff`，且 22,949,789 B 那批 URL 全部来自 `/_next/static/media/*`（200，非 404）。

---

## 5. 摘要（≤250 词）

- **字体单副本（实测）**：`build.js` 删除 standalone 里 `server/chunks/static`。`/var/tmp/w3` 真删真量：235,604,933 → 212,655,144 B，**省 22,949,789 B**；7 个被删文件与保留副本 md5 全同。字体全镜像实测合计 58,557,030 B，均在 creator-next 层。
- **typescript（挪动完成，镜像收益待 re-lock）**：dist/src/出厂 node_modules 运行时 `require("typescript")`/compiler API 命中 **0**；game-server 已挪 devDeps。出厂镜像里 typescript 实占 **19,492,846 B**；但另有 6 个 workspace 包仍 prod 声明它，单改不生效 —— 未改 lockfile，待有网 `rush update --to @box/game-server`，此前 CI `rush install` 会红（已预警 W2）。
- **格式收敛**：`subset-fonts.mjs` + manifest 落地。0 引用可删：`MiSans-Regular.ttf` 8,073,152 B（源目录，未进镜像）。Rusty-only 挂起：12,928,712 B。web 中文实际只加载 woff/woff2（CSS/defs.ts path:line 证据），DoulosSILR.ttf 与 KaTeX ttf 为 live 引用，**一个 ttf 都没删**。
- **子集化（真实 pyftsubset）**：MiSans woff→全 CJK woff2 **−43.8%/−42.5%**；ChillRound −23.7%；拉丁 12,356 B（−99.8%）。发布子集 UNVERIFIED（需产品定码位范围 + CSS/defs.ts 改动）。

**Sources**：
- [Google Fonts API 使用入门（text= 最多缩 90%）](https://developers.google.cn/fonts/docs/getting_started?hl=zh-cn)
- [盘点字体性能优化方案（HarmonyOS 96 子集 8.1M→首屏 1.1M）](https://m.blog.csdn.net/2301_79099499/article/details/152178316)
- [前端字体截取（3500 汉字覆盖 99.82%）](https://blog.csdn.net/weixin_34378922/article/details/87953858)
- [解决网页前端中文字体包过大的几种方案（pyftsubset 流程）](https://imgeek.net/article/825369554)
