# P0 · `prune-standalone.mjs` 等价性验证与字节实测（A4 泳道）

> 泳道目标：把 154 MB/镜像「构建期工具」这一最大瘦身主张的地基——`scripts/prune-standalone.mjs`——用现网 play 镜像**自己的** standalone 树做真实等价性验证，拿到裁剪字节数、启动等价、响应字节校验和一致、MODULE_NOT_FOUND 计数四类证据，据此推算 G1，并逐类核对删除规则覆盖度。
> 时间：2026-10-17。方法：WSL2 Ubuntu-24.04 + 本地镜像 `box-local-engine-play:v2026.1.4-linux-amd64`（**无 --pull、无 docker.io**）。只读现网 7 个 `box-local-engine-*` 与 3 个 `box3-lite-*`，仅创建脚本自有的 `eq2-src` / `e2-control` / `e2-pruned` 临时容器（用完已清理，实测 `NONE`）。
> 纪律：**本轮不报任何 RSS / TTFB / 冷启动数字**（WSL 冷，只报字节与等价性）。规则未改动（验证结果为等价，见 §结论）。

---

## 0. 一句话结论

**等价（EQUIVALENT）**。用真实工具裁剪 play 镜像自带 standalone 树、删掉 **88,176,940 B（84 MiB，未压缩）** 后，裁剪树与出厂树在 5 个采样路径上的**状态码、字节数、校验和逐项完全一致**，两棵树 `/api/health-check` 均 `UP 200`，两棵树 `MODULE_NOT_FOUND` 计数均为 **0**。工具规则**无需修改**，`prune-standalone.mjs` 保持原样。

---

## 1. 命令原文

复跑入口（本轮实际执行的一条命令）：

```bash
wsl -d Ubuntu-24.04 -- bash -lc \
  'bash "/mnt/d/desktop/神奇代码岛/box3-re/tools/eq2-play-tree-prune.sh"'
```

脚本内部关键动作（`box3-re/tools/eq2-play-tree-prune.sh`，35 行，逐行读后确认）：
1. `docker create eq2-src $IMG` → `docker cp eq2-src:/app/apps/game/.next/standalone $SCRATCH/pruned` → 取镜像**自己的** standalone 树，`cp -a` 出 `$SCRATCH/control`。
2. 用同一镜像的 node 跑真实工具：`node /scripts/prune-standalone.mjs /s/pruned --apply --json`（scripts 目录以 `:ro` 挂进来）。
3. `boot control` 挂 `$SCRATCH/control`、`boot pruned` 挂 `$SCRATCH/pruned`，各自 `PORT=3999 node server.js`（容器内端口，**不发布宿主端口**，不撞现网/box3-lite），轮询 `/api/health-check` 至多 30×2s，再对 5 个路径算 `status / 字节数 / ck(hash)`，并 `grep -cE 'MODULE_NOT_FOUND|Cannot find module' /tmp/s.log`。

环境前置实测（`tmp/a4-env.txt`）：挂载路径可达；`prune-standalone.mjs` 存在（31000 B）；镜像在本地（616 MB）；`/var/tmp/eq2` 起初不存在（= 本轮首次跑）。

---

## 2. 四类证据

### 2a. 裁剪字节数（du -sb 原文）

来源 `tmp/eq2_out.txt`（脚本 stdout 原文）：

```
== 1. take the play image's own standalone tree ==
  control tree = 220118536 B (210M)
== 2. prune the copy with the real tool ==
  tool exit=0  err=
APPLIED: removed 88176940 bytes (tools 88176940, trimmed 0, embedded static 0); 0 candidate(s) kept; total 226663944 -> 138487004
  pruned tree  = 132576476 B  removed=87542060 B (84M)
```

两个 du 口径都记录如下（差异来自宿主 9P 挂载 vs 容器 ext4 的块/符号链接记账，权威口径取容器内与工具自身）：

| 口径 | control (B) | pruned (B) | removed (B) | 备注 |
|---|---|---|---|---|
| 宿主 `du -sb`（9P 挂载 `$SCRATCH`） | 220,118,536 | 132,576,476 | **87,542,060** | 脚本 line 17/27/28 原文 |
| 容器内 `du -sb $SA`（boot 时打印） | 226,663,944 | 138,487,004 | **88,176,940** | 脚本 line 44 原文（`tree=` 字段） |
| 工具 `sizeOf` 自报 | 226,663,944 | 138,487,004 | **88,176,940** | `APPLIED:` 行，与容器 du 完全吻合 |

**采用值：removed = 88,176,940 B 未压缩（≈84.09 MiB / ≈88.18 MB）**，= play 镜像自带 standalone 树从 226,663,944 B 降到 138,487,004 B。全部来自 `tools`（构建期工具整包删除），`trimmed`（sql.js/isolated-vm 文件级裁剪）与 `embedded static` 本轮均为 0（原因见 §5）。

### 2b. 启动等价

| 树 | `/api/health-check` | 状态码 |
|---|---|---|
| control（出厂树） | `UP` | `200` |
| pruned（裁剪树） | `UP` | `200` |

原文：`[control] boot=UP 200  tree=226663944 B` 与 `[pruned] boot=UP 200  tree=138487004 B`。**两棵树都启动成功、状态码一致。**

### 2c. 响应字节校验和一致（5 路径逐项）

| 路径 | control: status / bytes / ck | pruned: status / bytes / ck | 一致? |
|---|---|---|---|
| `/api/health-check` | 200 / 33 / `443842c1` | 200 / 33 / `443842c1` | ✅ |
| `/api/play-worlds` | 200 / 13 / `0a52ea1b` | 200 / 13 / `0a52ea1b` | ✅ |
| `/_next/static/chunks/main-277ff2fbd803da65.js` | 200 / 138,777 / `64909b0f` | 200 / 138,777 / `64909b0f` | ✅ |
| `/_next/static/chunks/framework-7c5d5949242e9ab4.js` | 200 / 189,786 / `8dc346be` | 200 / 189,786 / `8dc346be` | ✅ |
| `/logo512.png` | 200 / 14,027 / `8299fd15` | 200 / 14,027 / `8299fd15` | ✅ |

**5/5 路径状态码、字节数、校验和逐项完全一致。** 未出现任何裁坏迹象。

原文（`tmp/eq2_out.txt`）：
```
  [control]
    200        33 B ck=443842c1 /api/health-check
    200        13 B ck=0a52ea1b /api/play-worlds
    200    138777 B ck=64909b0f /_next/static/chunks/main-277ff2fbd803da65.js
    200    189786 B ck=8dc346be /_next/static/chunks/framework-7c5d5949242e9ab4.js
    200     14027 B ck=8299fd15 /logo512.png
    MODULE_NOT_FOUND=0
  [pruned]
    200        33 B ck=443842c1 /api/health-check
    200        13 B ck=0a52ea1b /api/play-worlds
    200    138777 B ck=64909b0f /_next/static/chunks/main-277ff2fbd803da65.js
    200    189786 B ck=8dc346be /_next/static/chunks/framework-7c5d5949242e9ab4.js
    200     14027 B ck=8299fd15 /logo512.png
    MODULE_NOT_FOUND=0
```

### 2d. MODULE_NOT_FOUND 计数（原文）

- control：`MODULE_NOT_FOUND=0`（`grep -cE 'MODULE_NOT_FOUND|Cannot find module' /tmp/s.log`）
- pruned：`MODULE_NOT_FOUND=0`
- 前两条命中日志：两棵树均**无命中**（脚本 `grep ... | head -2` 输出为空，日志无 `Cannot find module` 行）。

---

## 3. 等价性结论

**等价。** 裁剪掉 88,176,940 B 构建期工具后，被删模块（`@swc/core`、`typescript`、`esbuild`、`sass`、`@babel/*`、`webpack`/`terser`/`uglify-js`/`jest-worker` 等 17 个 .pnpm store 条目）**在 play 运行时没有任何 require/懒加载路径命中它们**——否则启动会 `MODULE_NOT_FOUND` 或响应校验和会变。据此，「COPY standalone 前跑 prune-standalone.mjs 删构建工具」这条 P0 主张的**地基已被现网镜像自身证据证实**（非源码静态推断）。

**规则未改动、未复跑。** 校验未放松。

---

## 4. 删除规则覆盖度核对（§3.1 的 7 类工具 + sql.js 变体）

本轮工具命中 17 个 .pnpm store 条目，按包族归类（字节求和精确等于 88,176,940，`tmp/a4-clean.txt` 复核）：

| §3.1/§0 主张块 | 主张字节 | 本 standalone 树实测命中 | 命中包（原文 dirName） | 覆盖判定 |
|---|---|---|---|---|
| `@swc/core` | 48 MB | **50,398,488 B** | `@swc+core-linux-x64-gnu@1.4.13`(50,342,387) + `@swc+core@1.4.13_...`(56,101) | ✅ 规则命中，量级吻合（比主张还多 2 MB） |
| `typescript` | 33 MB | **8,947,551 B** | `typescript@5.6.3` | ⚠️ **部分**：standalone 仅带 8.9 MB；另 ~24 MB 在 `/opt/game-server`（后端 deploy 树，不在本测试挂载范围） |
| `babel` | 31 MB | **4,478,924 B** | `@babel+types`(564,217) `@babel+helper-validator-identifier`(36,700) `@babel+helper-string-parser`(29,098) `babel-plugin-react-compiler@1.0.0`(3,848,909) | ⚠️ **部分**：.pnpm 里 babel 只 4.5 MB；主张的 31 MB 大头是 `next/dist/compiled/babel`（Next 内建，非 store 条目，本工具删不掉） |
| `esbuild` | 11 MB | **11,570,793 B** | `@esbuild+linux-x64@0.28.2`(11,448,804) + `esbuild@0.28.2`(121,989) | ✅ 命中，量级吻合 |
| `sass` | 4 MB | **5,445,892 B** | `sass@1.93.3` | ✅ 命中（比主张略多） |
| `AMP`（amphtml-validator） | 4 MB | **0 B** | 无 `amphtml*` store 目录被删 | ❌ **未命中**：`CORE_RULES` 含 `amphtml` 但 4 MB 实际是 `next/dist/compiled/amphtml-validator`（Next 内建），非 pnpm store 条目，本工具结构上无法删（须魔改 Next，S1 §1 已判定不可行） |
| webpack/terser/uglify/jest 簇 | （主张里未单列） | **7,335,292 B** | `webpack@5.102.1`(5,150,499) `webpack-sources`(183,913) `terser@5.51.2`(1,128,523) `terser-webpack-plugin`(137,727) `html-minifier-terser`(88,896) `uglify-js@2.8.29`(571,431) `jest-worker@27.5.1`(74,303) | ✅ 由 tier `all` 的 `EXTENDED_RULES` 命中（脚本用的 `--tier` 默认 all）。self-contained 簇一起走，安全 |
| `sql.js` debug+asm 变体 | 22.7 MB | **0 B（trimmed=0）** | — | ❌ **本测试未触及**：`TRIM_RULES` 的 `sqljs-variants` 只作用于 store 里**存活**的 sql.js，而 sql.js 在 `/opt/game-server`（后端树），本 eq2 只挂载/裁剪 standalone，故未命中。该块需 Dockerfile 后端 `find -delete`（S1 §1 #3 的一行 rm）另证 |
| `isolated-vm` 原生源文件 | （主张未列） | **0 B** | — | 同上：在 game-server 后端树，非 standalone |

**结论**：`prune-standalone.mjs` 对「standalone 树里的 pnpm store 构建工具」这一类**覆盖完整且等价安全**（swc+ts+esbuild+sass+babel+webpack 簇）。对 §3.1 主张 154 MB 里的三块——**AMP(4MB) 属 Next 内建不可删**、**sql.js(22.7MB) 与后端 typescript 副本(24MB) 在 game-server 树不属本工具管辖**——本工具结构上够不着。这三块合起来 ~50 MB 需靠「后端 `find -delete` + Next 内建另行处理」，不能算进 prune-standalone 的收益。

---

## 5. G1 推算（明确标注口径与前提）

**测量基底**：本节所有字节 = **本地 play 镜像自带 standalone 树实测**（未压缩 du），外推 = **「每镜像 COPY 整块 standalone 且不 prune」这一结构性事实**（`apps/local-engine/Dockerfile:236` creator、`:315` play、`:374` ps、`:410` voxa，见 S1 §0/§3c）。**未重建任何镜像**（重建属用户决策 + 被 re-lock 阻塞）。

### 5.1 content（docker load 后，未压缩）收益推算

单棵 play standalone 树 prune 实测省下 **88.18 MB（未压缩）**。据 S1 §0「creator/play 各自 COPY 一份未 prune 的 web standalone」+ ANALYSIS §3.1「ps 再带 203 MB 同一份 web standalone、voxa 带 120.9 MB」，跨镜像承载这棵工具树的镜像：

| 承载镜像 | standalone 是否含同一份 game .pnpm 工具树 | 推算 prune 收益（未压缩） |
|---|---|---|
| creator | 是（`build:creator`，tracing root=整仓 → 同一 `.pnpm`） | ≈ 88.18 MB（**UNVERIFIED**，本泳道未测 creator 树） |
| play | 是（本轮**实测** 88.18 MB） | 88.18 MB ✅ 实测 |
| player-service | 部分：其 standalone 走 `prune-player-build.js`（只删 .ts/.map，不删构建工具），工具树大概率仍在 | ≈ 88 MB（**UNVERIFIED**） |
| voxa | 独立 app build，是否携带同一工具树未知 | **UNVERIFIED** |

保守取 **3 个承载 web standalone 的镜像（creator+play+ps）× 88.18 MB ≈ 264.5 MB 未压缩**（play 为实测锚点，creator/ps 为同树外推）。这直接指向 G1 的 content 目标 `2.74 GB → ≤1.4 GB`（需砍 1.34 GB）——prune 构建工具是其中最大单项，但**单靠 prune standalone 到不了 1.4 GB**，须叠加字体单副本(~30–58 MB/镜像)、tracing root 收窄(−140 MB/镜像)、Monaco 删除(−12.6 MB×2) 等（见 ANALYSIS §4.2）。

### 5.2 分发 gz 与 `/app` 收益——本轮不下硬数字

- 88.18 MB 是**未压缩 du**。转 gz 需真重打包：`@swc/core-linux-x64-gnu.node`(50 MB 二进制) 与 `sass/terser/webpack` 压缩率差异极大，**分发 gz 收益 UNVERIFIED**（HANDOVER §2.1 口径 gz≈content/2.71 仅作数量级参考，不可当承诺）。
- `/app 398 → ≈190 MB` 属跨镜像 613 MB 去重 + prune 叠加后的结果，**单一 prune 不达成**；本轮无 content/`/app` 复算，标 **UNVERIFIED**。

### 5.3 仍需重建镜像才能证真的部分（用户决策项）

1. 把 prune 步骤接进 `Dockerfile:236/315`（COPY standalone 前 `RUN node .../prune-standalone.mjs --apply`），重建 creator+play+ps 三个镜像，`docker image inspect .Size` / `du /app` 复算 → 证 content 收益。
2. creator/ps/voxa 三棵 standalone 树的**各自 removed 字节**（本泳道只实测了 play）。
3. 后端 `/opt/game-server` 树的 sql.js 变体删除、typescript 挪 devDep 的实际字节（需 `rush install --prod` + re-lock，被 lockfile 不同步阻塞）。
4. gz 分发收益（需 `docker save | gzip` 重打）。

---

## 6. UNVERIFIED 清单

- **creator / player-service / voxa 三棵 standalone 树的 removed 字节**：本泳道只跑 play，未测其余（结构推断「同树」）。
- **content 2.74 GB→≤1.4 GB、/app 398→≈190 MB、分发 ≤550 MiB** 三项 G1 目标值：一次镜像都没重建 → 全部 UNVERIFIED（HANDOVER §3 #5 已列）。
- **gz 分发收益**：88 MB 为未压缩口径，未重打包 → UNVERIFIED。
- **AMP(4MB) 与 `next/dist/compiled/babel` 残留**：非 pnpm store 条目，prune-standalone 结构上删不掉，需另案。
- **响应采样的路径覆盖**：5 条路径（health/worlds/2 chunk/logo）已一致，但非全量路由；更深的进图功能链（G3/G4）不在本泳道范围，由其它泳道证。

---

## 7. 规则处置

**不改动 `scripts/prune-standalone.mjs`。** 等价性成立、校验和一致、零 MODULE_NOT_FOUND、无「放松校验换绿」。§4 的两处「未命中」（AMP、sql.js/isolated-vm）是**作用域/结构性限制**而非 bug（sql.js/isolated-vm 在 game-server 后端树、本测试只挂载 standalone；AMP 是 Next 内建），故不通过改删除规则来解决，已在 §5.3 列为需重建/后端 prune 另证。

---

## 8. 产物文件（本轮亲跑，可复跑）

- 原始 stdout：`box3-re/tmp/eq2_out.txt`（含四类证据全部原文）
- stderr：`box3-re/tmp/eq2_err.txt`（空）
- 工具逐包删除清单：`box3-re/tmp/a4-full-prune.txt`（17 条 `deleted ... via rule`）
- 家族字节复核：`box3-re/tmp/a4-clean.txt`（swc+ts+babel+esbuild+sass+webpack簇 = 88,176,940 精确）
- 环境前置：`box3-re/tmp/a4-env.txt`
- 临时容器 `eq2-src` / `e2-control` / `e2-pruned`：脚本自清理，实测 `NONE`；现网与 box3-lite 未触碰。
