# A9 · G3/G4 地图兼容性回归基线（把口头硬性要求变成可执行的闸）

生成：2026-10-17 ｜ 泳道：A9 ｜ 工作目录：`D:\desktop\神奇代码岛`
纪律：**本文所有数字都来自本轮亲自执行的命令**；跑不出的标 `UNVERIFIED`。
`box3-local-engine\` 全程只读，未改动一行；未新建容器；未执行任何 stop/start/rm/prune/写型 exec。

---

## 0. 一句话结论

用户的硬性要求「一切优化/轻量化/提速都必须建立在原有地图能正常运行的基础上」，现在有了资产：

- **可跑的门**：`box3-re\tools\compat-check.sh` —— 56 个检查项，纯 shell、零依赖、默认只读，全量 10.0 s、静态模式 1.6 s。
- **可比的锚**：`box3-re\baseline\g3-baseline.tsv`（56 个 key 的基线）+ `box3-re\baseline\contract-server-api.members.tsv`（2730 行契约成员清单，sha256 `5bcc18f8…`）。
- **红绿已自测**：篡改基线 → 4 项准确报红并退出码 1；原样重跑 → PASS 退出码 0。
- **一个必须纠正的前提**：文档里的「398 个可调用」**数字能精确复现，但口径有缺陷** —— 它把 52 个 `constructor(`、23 个 get/set 访问器、10 个索引签名都算进了「可调用」，其中 get/set 还在「1234 属性」里被重复计了一次。语义上作者脚本真能调用的面是 **313**。
- **一条新发现的隐藏契约**：现存真实地图在 API 对象上挂了 **86 个未声明的自定义属性**（`world.Quanjujiaoyi`、`player.wearables`…）。这是任何「收紧 API 面 / 冻结对象 / 换 Proxy」的改动会直接打死老地图的地方，必须写进设计约束。

---

## 1. 兼容性资产清单（实测，不猜）

### 1.1 真实安装目录与地图根

只读取证命令原文（WSL 侧，root 身份）：

```bash
wsl -d Ubuntu-24.04 -- bash -c 'docker inspect box-local-engine-play-1 \
  --format "{{range .Mounts}}{{.Type}} {{.Source}} -> {{.Destination}} rw={{.RW}}{{println}}{{end}}"'
```

原文输出（去掉 UTF-16 空字节后）：

```
bind /root/box3/BOX3-Engine-Server-0.2.0-linux-amd64/apps/local-engine/data -> /app/apps/local-engine/data rw=true
volume /var/lib/docker/volumes/box-local-engine_box-play-runtime-cache/_data -> /app/play-runtime-cache rw=true
bind /root/box3/BOX3-Engine-Server-0.2.0-linux-amd64/apps/local-engine/play-worlds -> /app/play-worlds rw=true
```

→ **真实地图宿主落点 = `/root/box3/BOX3-Engine-Server-0.2.0-linux-amd64/apps/local-engine/`**
（目录名仍写 0.2.0，实际跑 v2026.1.4 —— 这是 §「已知三向失配」的残留，见 ANALYSIS-AND-PLAN.md §1）

### 1.2 可回归素材总表

取数命令原文：

```bash
B=/root/box3/BOX3-Engine-Server-0.2.0-linux-amd64/apps/local-engine
ls -la $B/play-worlds $B/projects $B/data
find $B/play-worlds -type f | wc -l
du -sb $B/play-worlds/cloud-4e84ee7ef626058f-imported
find $B/projects -maxdepth 1 -mindepth 1 -type d -exec du -sh {} \;
cat $B/play-worlds/cloud-4e84ee7ef626058f-imported/manifest.json
grep -rl "onPlayerJoin" $B/projects $B/play-worlds | wc -l
```

实测结果（本轮亲自跑出）：

| 素材 | id / publicId | 名称 | 文件数 | 体积 | 发布状态 | 能用于什么 |
|---|---|---|---|---|---|---|
| **play-world** | `cloud-4e84ee7ef626058f-imported` | 起床战争 v1.0.1 | **908** | **27,992,660 B**（du -sb）≈30M | `playEnabled: true`，`immutable: true`，`sharedRevision 4` | **G3 唯一可用素材**：已发布+已开放，可直接进图 |
| project | `cloud-4e84ee7ef626058f-imported` | 起床战争（工程） | **2969** | 68M | `releases: []` | 只能静态比对（未发布，进不了 play） |
| project | `cloud-3a043df55e5057a5-imported` | 混沌神域 | **658** | 38M | `releases: []`，`permanentMapId 47c8398c96d350f5c5f6` | 只能静态比对 |
| project | `yunhai-xiantu` | 云海仙途（author `opencode`，`templateId blank`，`mapSize [128,128,128]`） | **446** | 75M | `releases: []` | 只能静态比对；是唯一非云端迁移来的本地原创图，对「新图也跑得起来」有价值 |
| data/blobs | — | — | **0** | 4.0K | 空 | 无内容 |
| 全素材 | — | 含 `onPlayerJoin` 的 blob | **36** | — | — | 真实 API 调用面的分母（见 §2.4） |

**起床战争脚本文件清单**（内容寻址、无扩展名，用 `grep -rl onPlayerJoin` 识别）：

```
23509	…/play-worlds/cloud-4e84ee7ef626058f-imported/data/blobs/QmQjaSNyTeNuWj1PRq2qAfsqjFTAtAbeZhUbFyHRXwBwBp
452046	…/play-worlds/cloud-4e84ee7ef626058f-imported/data/blobs/Qmatq2icuFSSBaoQhPvHAs5Be8BocYNUzBMReDwhLpVXnr
```

→ 出厂地图**只有 2 个含 `onPlayerJoin` 的脚本 blob**，主脚本 452 KB。
`Qmatq2icuFSSBaoQhPvHAs5Be8BocYNUzBMReDwhLpVXnr` 同时出现在 3 个 project 与 play-world 里 —— 跨图共享 blob。

manifest 关键字段（丢失任何一项都算地图元数据回归）：
`id, permanentMapId, permanentMapGroupId, publicId, projectName, version, permissionHash, immutable, mapGroupId, mapRole, mainProjectId, sharedRevision, theme, formatVersion`

### 1.3 WSL 本地副本（不需要容器的取证目标）

```bash
du -sh /var/tmp/re-arch /var/tmp/w3/standalone /var/tmp/w4-data /var/tmp/w4-play-lite \
       /var/tmp/pruned-standalone /var/tmp/smoke-standalone /var/tmp/w1-recheck /var/tmp/w1b /var/tmp/box3-dl
find /var/tmp/w4-data -type f | wc -l
ls /var/tmp/re-arch
```

| 路径 | 体积 | 内容 | 能否当 L0 目标 |
|---|---|---|---|
| `/var/tmp/w4-data` | 30M / **908 文件** | play-world 的**逐字节副本**（同起床战争） | 可当 L2 静态比对目标，无需容器 |
| `/var/tmp/re-arch` | **428M** | 出厂 `/app` 真实副本：`creator-services/game-server` 128M（**含 node_modules 24 项 + dist/src/entry.js**）、`play-local-engine` 24M（含 `src/launcher.js`）、`creator-local-engine` 24M、`auth-portal`、`server-manager`、`runtime-compose.yml`、`manifests` | **可当 L0 目标**（本轮 compat-check.sh 就是扫它） |
| `/var/tmp/w3/standalone` | 224M | 源码树（apps/internals/packages/services/common） | **不可**：`ls node_modules` → `No such file or directory`，无依赖就无从谈 require |
| `/var/tmp/w4-play-lite` | 40K | 只有 `compose.yml` / `.env` / `compose.yml.bak-before-a3` | A3 的编排物，非地图素材 |
| `/var/tmp/pruned-standalone`、`/var/tmp/smoke-standalone` | — | A4 的剪枝/冒烟现场 | 结构同 w3，`apps/common/internals/packages/services` |
| `/var/tmp/w1-recheck` 246M、`/var/tmp/w1b` 161M、`/var/tmp/box3-dl` 1012M | — | 别的泳道中间物 | 未核验内容，标 UNVERIFIED |

**结论：本机只有 1 张图能真跑 G3（起床战争，已发布）。** 这是整个安全网最薄的一环 —— 见 §6 缺口 1。

---

## 2. 契约指纹实测

### 2.1 计数方法与为什么必须是「行级」

`packages/script-api/dts/box3-server-api.d.ts` = **4603 行**（`wc -l`），`awk END{print NR}` = 4604（文件无末尾换行）。

> **关键取证**：我先写了括号配平的解析器（模拟 AST 语义），实测只能数到 **255 / 279 / 322** —— 全部对不上。
> 追因后定位到结构缺陷：`box3-server-api.d.ts` **第 1065 行** 是
> ```
>     constructor(
>     /** … */ url: URL,
>     /** … */ entityQuota: () => number,
>     /** … */ createEntity: (…) => GameEntity | null,
> ```
> `fix-declaration.js` 把 **GameWorld 的整段成员列表塞进了一个不闭合的 `constructor(`**，于是从 611 行 `declare class GameWorld {` 往后约 400 行里，所有成员都在 `pd=1` 的状态下用**逗号**分隔，而不是分号。任何「括号配平才切句」的解析器都会把几十个成员塌成一条语句。
> 所以契约指纹**必须走行级分类**（与 S6 泳道当初用 awk 的原因一致），不是偷懒，是被实测逼出来的。

最终口径（写死在 `compat-check.sh` 的 `contract_members()` 里，互斥、有优先级、一行只进一个桶）：

| 桶 | 行级正则（去缩进后） | 实测 |
|---|---|---|
| `method` | `^NAME\??(` 且 NAME≠constructor | **98** |
| `ctor` | `^constructor(` | **52** |
| `arrow` | `^NAME\??[[:space:]]*:[[:space:]]*(` | **204** |
| `accessor` | `^(get\|set)[[:space:]]+` | **23** |
| `index` | `^[` | **10** |
| `callsig` | `^[<(]` | **11** |
| `prop` | `^NAME\??[[:space:]]*:` 其余 | **1007** |

可复跑命令（一行，任何人可验）：

```bash
awk '{ind=$0; sub(/^[[:space:]]+/,"",ind);
 if(ind==""||ind ~ /^\*/||ind ~ /^\/\//) next;
 if(ind ~ /^[A-Za-z_$][A-Za-z0-9_$]*\??\(/){M++; if(ind ~ /^constructor\(/)C++}
 else if(ind ~ /^[A-Za-z_$][A-Za-z0-9_$]*\??[[:space:]]*:[[:space:]]*\(/){A++}
 else if(ind ~ /^(get|set)[[:space:]]+/){GS++} else if(ind ~ /^\[/){IX++}
 else if(ind ~ /^[<(]/){CS++} else if(ind ~ /^[A-Za-z_$][A-Za-z0-9_$]*\??[[:space:]]*:/){P++}}
 END{printf "method=%d ctor=%d arrow=%d getset=%d index=%d callsig=%d prop=%d | 398公式=%d | 语义可调用=%d\n",
  M,C,A,GS,IX,CS,P,(M+C+GS+IX+A+CS),(A+CS+M-C)}' box3-server-api.d.ts
```

原文输出：

```
method=98 ctor=52 arrow=204 getset=23 index=10 callsig=11 prop=1007 | 398公式=398 | 语义可调用=313
```

### 2.2 与文档「398」的对账：**数字复现，口径不成立**

ANALYSIS-AND-PLAN.md §3.4 称「**398 个可调用**（方法式 183 + 箭头式 215）+ 1234 属性」。逐桶对账：

| 宣称 | 实测拆解 | 是否复现 |
|---|---|---|
| 方法式 **183** | `method(98) + ctor(52) + accessor(23) + index(10)` = **183** | ✅ 精确 |
| 箭头式 **215** | `arrow(204) + callsig(11)` = **215** | ✅ 精确 |
| 合计 **398** | 183 + 215 = **398** | ✅ 精确 |
| 属性 **1234** | `prop(1007) + arrow(204) + accessor(23)` = **1234** | ✅ 精确 |

**但正是这个「精确」暴露了口径缺陷：**

1. **52 个 `constructor(` 不是成员可调用**，是 `new GameVector3(…)` 的构造位点，混进「可调用」虚增了 52。
2. **10 个索引签名 `[…]` 根本不可调用**，虚增 10。
3. **23 个 get/set 访问器按属性读写（`obj.foo`），不是 `obj.foo()`**，虚增 23；**而且这 23 行同时又被计入了「1234 属性」**（1234 = 1007+204+23）—— 同一批行在 398 和 1234 里各算一次，**重复计数**。
4. 反过来，**10 个「类型是具名函数别名的属性」被漏掉**（`log: GameLoggerMethod;` 这类），它们其实可调用。

→ **可调用性的语义口径实测为 313** = `method(98) + arrow(204) + callsig(11)`（剔 ctor / index / accessor）。
→ **G4 验收门应该钉「398 这个数」还是钉「指纹」？答案是钉指纹**（§2.3）。一个口径有缺陷的整数，既容易在瘦身时被「凑数」误导，也无法告诉你**具体哪一项**丢了。

对客户端面的复现（同法）：

| 文件 | 行数 | 398 公式口径 | 文档宣称 | 判定 |
|---|---|---|---|---|
| `client-api-types.dts`（546 行） | 546 | **30**（method 21 + ctor 11 + arrow 9） | 32 | **差 2，未复现** —— 标 UNVERIFIED，且该文件已无法再生成（§2.5） |
| `server-api-types.dts`（1020 行，血统 B） | 1020 | **52** | 文档未给数 | 仅作旁证：`packages/script-api` 手写镜像面(52) 远窄于运行时权威面(398)，两套血统并存 |

### 2.3 契约指纹（G4 的锚）

指纹 = **全量成员行按 `bucket \t owner \t 规范化成员行` 排序后的 sha256**。owner 由「最近一次出现的 col-0 `declare class/interface/const/…` 名」推断，因此形如 `world`、`GamePlayer`。

- 清单文件：`box3-re\baseline\contract-server-api.members.tsv` —— **2730 行**
- 指纹：`sha256 = 5bcc18f8c8434ca4b73bdefaa84861ecab12d9c9c4701d096a79336676352865`
  （实测 `sort members.tsv | sha256sum` 与脚本内 `contract.server.fingerprint.sha256` 完全一致 → `contract.server.members.matchFile = yes`）
- 客户端指纹：`contract.client.fingerprint.sha256 = 70236fc57676142dfafd957fba96a565aa5e44f2538b82f85000009d698bbc7f`

> 为什么指纹比 398 更有价值：任何一次 prune / 挪 devDep / 改打包链导致 **dts 少一个成员、多一个成员、签名变一个字符**，sha256 必变；而「398」这种整数在 23 个访问器被误删、恰好别处多算 23 个时会假绿。

### 2.4 新发现：真实地图的「隐藏契约面」

只读取证（在现网地图 blob 仓里 grep，不改任何文件）：

```bash
B=/root/box3/BOX3-Engine-Server-0.2.0-linux-amd64/apps/local-engine
grep -rhoE "\b(world|game|player|entity|voxels|storage|db|http|gui|rtc|resources|remoteChannel)\.[A-Za-z_$][A-Za-z0-9_]*" \
     $B/projects $B/play-worlds 2>/dev/null | sort -u
```

实测：**146 个 `接收者.成员`**，去重成员名 **138 个**。与 dts 声明集交叉后：

- **55 个是声明过的、真实被调用的面**（这是 G3/G4 最小必须保留集）：

| 接收者 | 命中数 | 成员 |
|---|---|---|
| `entity` | 19 | addTag, b, data, destroy, destroyed, enableDamage, friction, hp, id, maxHp, player, position, say, showHealthBar, text, ticks, time, velocity, voxelContacts |
| `world` | 16 | addCollisionFilter, addZone, airFriction, ambientSound, createEntity, nextPlayerJoin, **onPlayerJoin**, onChat, onPlayerLeave, onTick, projectName, querySelector, querySelectorAll, say, searchBox, teleport |
| `player` | 10 | addWearable, cancelDialogs, dialog, directMessage, kick, name, player, userId, userKey, wearables |
| `voxels` | 4 | getVoxelId, name, setVoxel, setVoxelId |
| `remoteChannel` | 3 | broadcastClientEvent, onServerEvent, sendClientEvent |
| `storage` | 2 | getDataStorage, getGroupStorage |
| `db` | 1 | sql |

- **86 个不在 dts 声明里** —— 作者把自定义状态直接挂在 API 对象上：`world.Quanjujiaoyi`、`world.TKSY_ADMIN`、`world.Kp_top100`、`player.wearables`、`world.chatkg`、`world.drawSummer`、`world.dressUp`、`world.jykg`…

> **这条必须进设计约束**：398/313 是「下限」而不是「上限」。现存地图依赖的是「API 对象**可任意读写扩展属性**」。
> 任何「为了瘦身而 Object.freeze / seal / 加 Proxy 白名单 / 收窄注入面」的改动，都会立刻打死起床战争。
> `ANALYSIS-AND-PLAN.md` §5 的风险清单里没有这一条，建议补进去。
>
> 精度声明：86 这个数含假阳性（`entity.b`、`entity.data`、`entity.text` 这类可能来自压缩后的 JSON 数据 blob，不是脚本）。
> **55 是可信下限；86 是量级指示，不宜当硬阈值用。**

### 2.5 已知断链复验（对文档的一处纠正）

`apps/game/client-api-tsconfig.json:6-9` 原文：

```json
  "include": [
    "src/engine/script/apis/*.ts",
    "../../internals/schema/api/common.ts"
  ]
```

实测（`ls` + `git ls-files`）：

| include 条目 | 是否存在 | 证据 |
|---|---|---|
| `src/engine/script/apis/*.ts` | ❌ 不存在 | `ls apps/game/src/engine/script/apis` → `No such file or directory`；`git ls-files "apps/game/src/engine/script/apis/*" \| wc -l` → **0** |
| `../../internals/schema/api/common.ts` | ✅ **存在** | `git ls-files internals/schema/api/common.ts` → **1** |

→ **纠正 ANALYSIS-AND-PLAN.md §3.4 的表述**：不是「include 指向 0 命中的旧路径」，而是 **2 条里死 1 条**（`apis/` 少了一段 `ses/`）。
客户端 API 源**确实在**：`apps/game/src/engine/script/ses/apis/`，实测 **9 个 .ts**（`compat-check.sh` 的 `contract.client.realApiDir = 9`）。
→ **修复成本 1 行**：`src/engine/script/apis/*.ts` → `src/engine/script/ses/apis/*.ts`，客户端 DTS 即可再生成。这是 G4 唯一有明确单价的缺口。

---

## 3. 回归套件规格（L0–L4）

图例：🟢 本轮已跑通并出数 ｜ 🟡 需容器（只读，本轮已跑或可直接跑）｜ 🔴 需用户授权起测试栈

| 层 | 检查项 | 判据阈值 | 取数命令 | 耗时 | 失败时定位方法 | 状态 |
|---|---|---|---|---|---|---|
| **L0 静态** | `contract.server.fingerprint.sha256` | 与基线**完全相等** | `compat-check.sh` 内 `contract_members()` | <0.1 s | `diff <(sort baseline/members.tsv) <(脚本重跑输出)` → 直接看是哪一行桶/owner/成员变了 | 🟢 |
| L0 | `l0.moduleResolution.relativeUnresolved` | **必须 0** | 从 `entry.js`/`launcher.js` 抽 `require("…")`，相对位点试 `.js/.json/index.js` | ~1 s | 非 0 → 列出的就是被剪掉的 dist 文件；`worst` 样本直接给「哪个入口 <- 哪个 spec」 | 🟢（=0） |
| L0 | `l0.moduleResolution.externalUnresolved` | **必须 0** | 裸包名试 `node_modules/<spec>` | 同上 | 非 0 → 就是被挪进 devDep 或被 prune 的**运行时**依赖（typescript 那条改动的靶心） | 🟢（=0） |
| L0 | `l0.moduleResolution.workspaceUnresolved` | 有工作区根时必须 0，否则 SKIP | `@box/*` 试 `node_modules/@box/<pkg>`、`packages/`、`services/`、`apps/` | 同上 | SKIP 表示本地副本无 `/app` 工作区布局 → 需对真 `/app` 副本跑 | 🟢（当前 SKIP→本轮 ws_known=1，实测 0） |
| L0 | `impl.coverage.missing` | **必须 0** | dts 每个 `owner.name` 可调用位点，在 `internals/schema/api/js/*.ts` 词级命中 | ~1 s | 非 0 → 打印 `owner.name` 清单，即「声明还在、实现被删」的确切项 | 🟢（=0，分母 225，host 豁免 14） |
| **L1 启动** | `http.health.play.code` | **=200** | `curl -s -o /dev/null -w %{http_code} http://127.0.0.1:<port>/api/health-check` | <1 s | 非 200 → `docker logs box-local-engine-play-1`；端口从 `docker ps` 现取不硬编码 | 🟡🟢（=200） |
| L1 | `topo.containerList.digest` | 变更需**显式声明理由** | `docker ps --format '{{.Names}}\|{{.Image}}\|{{.Ports}}' \| sort \| sha256sum` | <1 s | `docker ps -a` 对照基线，diff 出多/少哪个 service、哪个端口没发布 | 🟢（11 个在跑） |
| L1 | `topo.mountList.digest` | 「去 docker.sock」「挪 volume」类改动的靶心 | `docker inspect` 全部 `.Mounts` 排序取 sha256 | <1 s | `docker inspect <c> --format '{{range .Mounts}}…'` 逐个对比 | 🟢 |
| L1 | `topo.dockerSockMounts` / `userZeroZero` | 现状各 =**1**；P1「去 docker.sock」后应为 0 | 同上 | <1 s | — | 🟢 |
| L1 | 日志无新增 error 指纹 | **error 行数不增加** | `docker logs <c> 2>&1 \| grep -icE "error\|MODULE_NOT_FOUND\|cannot find module"` | ~1 s | `… \| sort -u` 看新增的那一行的第一个栈帧 | 🟡 本轮实测 play/creator 均 **0** 行（容器刚重启，日志为空），**判据成立但样本无信息量 → UNVERIFIED** |
| **L2 数据** | `http.playWorlds.body.sha256` | **与基线完全相等（字节级）** | `curl -s http://127.0.0.1:80/api/play-worlds \| sha256sum` | <1 s | `curl … > a.json`；改动后 `> b.json`；`diff <(python -m json.tool a) <(python -m json.tool b)` 定位字段 | 🟢 `26158180…`（439 B） |
| L2 | `http.playWorlds.publicIds` | **集合不得缩水**（现存 1 个） | 同上，`grep -oE '"publicId":"[^"]+"'` | <1 s | 集合差 = 消失的图 | 🟢 |
| L2 | `http.playWorlds.fields` | 字段集合不得丢 | 同上取键名并集 | <1 s | 逐项 diff 键名 | 🟢（14 键） |
| L2 | `http.playWorlds.playEnabledTrue` | **≥1**（有图处于开放态） | `grep -c '"playEnabled":true'` | <1 s | — | 🟢（=1） |
| L2 | `map.world.<id>.files` / `.digest` | 文件数与 `relpath\|size` 清单 sha256 均相等 | `find $W -type f -printf '%s\t%p\n' \| sort \| sha256sum` | ~3 s | `diff <(基线清单) <(现清单)` → 直接列出丢失/新增的 blob 路径 | 🟢（908 / `721ffb34…`） |
| L2 | `map.project.<id>.digest` | 未发布工程：静态比对用 | 同上 | ~3 s | 同上 | 🟢（3 个工程） |
| **L3 进图** | `GET /p/<publicId>` = 200 + 首屏字节校验和 | 与基线相等 | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:80/p/cloud-4e84ee7ef626058f-imported`（需会话 Cookie） | — | 非 200 → 先看是不是 302 到 auth-portal（会话问题）而非 500（引擎问题） | 🔴 **UNVERIFIED：ANALYSIS §3.4 已证 create/publish/play-import 只认玩家浏览器会话 Cookie，CLI Token 无此能力** |
| L3 | `createSession` | 返回可用会话 | 需登录态 | — | — | 🔴 UNVERIFIED |
| L3 | **`onPlayerJoin` 触发证据** | 运行时日志出现加入事件 | 候选命令：`docker logs -f box-local-engine-play-1 2>&1 \| grep -iE "onPlayerJoin\|player.*join"`；或地图主脚本 `grep -c onPlayerJoin` 已证存在（2 个 blob） | — | 进图后无触发 → 查 `Qmatq2ic…` 这个 452 KB 主脚本是否被 link/解包，再查 isolate 启动日志 | 🔴 **UNVERIFIED：本轮禁止新建容器、且需真实浏览器进图** |
| **L4 契约** | 逐项有实现（静态） | `impl.coverage.missing = 0` | 见 L0 | ~1 s | 打印的 `owner.name` 清单 | 🟢 |
| L4 | `.boxplay` 被出厂 reader 接受 | 出厂 `project-manager` 能 import | 需跑 `box3-pack` + 导入 | — | — | 🔴 属 A9 范围外的 G4 另一半，见 §6 缺口 3 |

**运行时实测**：

```
compat-check.sh 全量（含 HTTP+docker 只读）：real 0m10.032s   user 0m0.934s  sys 0m1.646s
compat-check.sh --skip-http --skip-docker ：real 0m1.557s   user 0m0.470s  sys 0m0.440s
```

→ 静态模式 1.6 s，可放进任何 PR；全量 10 s，可放进每夜与「发版前」闸。

---

## 4. `compat-check.sh` 与首轮原文输出

### 4.1 文件与用法

| 文件 | 说明 |
|---|---|
| `box3-re\tools\compat-check.sh` | 检查器本体。纯 bash+awk+curl+coreutils，**零依赖**（WSL 里没有 node，实测 `node: command not found`，所以全部用 shell 实现） |
| `box3-re\baseline\g3-baseline.tsv` | 基线，**56 个 key**，`key<TAB>value` |
| `box3-re\baseline\contract-server-api.members.tsv` | 契约成员清单，**2730 行**，`bucket<TAB>owner<TAB>成员行` |

调用（中文路径必须整体加引号，且需要禁掉 Git Bash 的路径转换）：

```bash
S="/mnt/d/desktop/神奇代码岛/box3-re/tools/compat-check.sh"
MSYS_NO_PATHCONV=1 wsl -d Ubuntu-24.04 -- bash "$S"                      # 人类可读 + 比对基线
MSYS_NO_PATHCONV=1 wsl -d Ubuntu-24.04 -- bash "$S" --json               # CI 用，合法 JSON
MSYS_NO_PATHCONV=1 wsl -d Ubuntu-24.04 -- bash "$S" --update-baseline    # 重新立基线
MSYS_NO_PATHCONV=1 wsl -d Ubuntu-24.04 -- bash "$S" --skip-http --skip-docker   # 纯静态 1.6s
```

选项：`--json` `--human` `--baseline <f>` `--update-baseline` `--repo <dir>` `--install <dir>` `--skip-http` `--skip-docker` `--quiet`。
环境变量：`APP_ROOT`（指向容器 `/app` 的真实副本以增强 L0）、`PLAY_PORT`。
退出码：`0`=PASS，`1`=有 FAIL。

**豁免规则（避免假绿也避免假红）**：`drift.*`、`baseline.exists`、`contract.server.members.matchFile`、`http.skipped` 不参与比对（元信息）；`topo.*`、`http.health.play.*` 只 WARN 不 FAIL（A3/A4 正在启停容器）；**`http.playWorlds.*` 和全部 `map.*`、`contract.*` 是硬判据，故意不豁免**。

### 4.2 首轮原文输出（`--update-baseline`，2026-10-17，PASS）

```
[PASS] contract.server.dts.lines                      4603
[PASS] contract.server.doc398.formula                 398
[PASS] contract.server.doc398.methodStyle             183
[PASS] contract.server.doc398.arrowStyle              215
[PASS] contract.server.callable.semantic              313
[PASS] contract.server.bucket.method                  98
[PASS] contract.server.bucket.ctor                    52
[PASS] contract.server.bucket.arrow                   204
[WARN] contract.server.bucket.accessor                23
[WARN] contract.server.bucket.index                   10
[PASS] contract.server.bucket.callsig                 11
[PASS] contract.server.bucket.prop                    1007
[PASS] contract.server.fingerprint.sha256             5bcc18f8c8434ca4b73bdefaa84861ecab12d9c9c4701d096a79336676352865
[PASS] contract.server.members.matchFile              yes
[PASS] contract.client.dts.lines                      546
[WARN] contract.client.doc398formula                  30
[PASS] contract.client.fingerprint.sha256             70236fc57676142dfafd957fba96a565aa5e44f2538b82f85000009d698bbc7f
[WARN] contract.client.tsconfig.brokenInclude         1
[PASS] contract.client.realApiDir                     9
[PASS] impl.coverage.missing                          0
[PASS] impl.coverage.distinctPairs                    225
[PASS] impl.coverage.hostExcluded                     14
[PASS] impl.coverage.implFiles                        13
[PASS] l0.moduleResolution.entries                    1
[PASS] l0.moduleResolution.relativeUnresolved         0
[PASS] l0.moduleResolution.externalUnresolved         0
[PASS] l0.moduleResolution.workspaceUnresolved        0
[PASS] map.playWorldsRoot                             /root/box3/BOX3-Engine-Server-0.2.0-linux-amd64/apps/local-engine/play-worlds
[PASS] map.world.cloud-4e84ee7ef626058f-imported.files 908
[PASS] map.world.cloud-4e84ee7ef626058f-imported.digest 721ffb3494f06a751f01a0a5ce716077d27e7b4e882cf069b0aa0b163cb2e89d
[PASS] map.world.cloud-4e84ee7ef626058f-imported.manifestKeys author,cover,createdAt,description,formatVersion,id,immutable,loadingCover,mainProjectId,mapGroupId,mapRole,notes,permanentMapGroupId,permanentMapId,permissionHash,projectName,publicId,sharedRevision,theme,version
[PASS] map.world.cloud-4e84ee7ef626058f-imported.manifest.sha256 85f9543479abac263579096e4276029c147b1405f4b2a7a467df8495d67870f3
[PASS] map.world.cloud-4e84ee7ef626058f-imported.scriptBlobs 2
[PASS] map.playWorlds.count                           1
[PASS] map.project.cloud-3a043df55e5057a5-imported.files 658
[PASS] map.project.cloud-3a043df55e5057a5-imported.digest 662de8047a4a4b1c413b97c7d330c010d340d2db32a7dd8c699aa85934ad5e23
[PASS] map.project.cloud-4e84ee7ef626058f-imported.files 2969
[PASS] map.project.cloud-4e84ee7ef626058f-imported.digest 8fde20c0fa87f5dac1136ef007c7596cf153dbd50abe5a75550a85dcebeace87
[PASS] map.project.yunhai-xiantu.files                446
[PASS] map.project.yunhai-xiantu.digest               f44740e998315780b3e38a89e9553e90c983e3a452bf825976f87cc440abed9d
[PASS] map.projects.count                             3
[PASS] map.scriptBlobs.total                          36
[PASS] http.health.play.code                          200
[PASS] http.health.play.body.sha256                   36bf1f1ed27dbfecab3bf2321f6779cfa30eb5c2160a7cacd978a3275bc81140
[PASS] http.playWorlds.code                           200
[PASS] http.playWorlds.body.sha256                    26158180a7c46a36748627ce78ecfce8a669572449a69bb0b06975aa0fffd6c2
[PASS] http.playWorlds.body.bytes                     439
[PASS] http.playWorlds.publicIds                      cloud-4e84ee7ef626058f-imported
[PASS] http.playWorlds.fields                         author,cover,description,id,loadingCover,mainProjectId,mapGroupId,mapRole,name,permanentMapId,playEnabled,publicId,version,worlds
[PASS] http.playWorlds.playEnabledTrue                1
[PASS] topo.runningCount                              11
[PASS] topo.containerList.digest                      b717e4f430b19847d5875e06ecd518e2fc25ec4c3ec1ea8316cae0ad84519059
[PASS] topo.dockerSockMounts                          1
[PASS] topo.userZeroZero                              1
[PASS] topo.mountList.digest                          d347e120534b93cd963b71c46f8a7600d5b2c216eb80ef1d04b51a68a579ad21
[PASS] baseline.exists                                present

WARN  contract.server.bucket.accessor = 23 | get/set —— 按属性访问，不是可调用；在 398 与 1234 两个桶里被重复计入
WARN  contract.server.bucket.index = 10 | [k: T] 索引签名，不是可调用
WARN  contract.client.doc398formula = 30 | 文档称客户端声明面 32 个可调用；实测 method-style=21、arrow-style=9、合计 30（客户端 DTS 已无法再生成，见 brokenInclude）
WARN  contract.client.tsconfig.brokenInclude = 1 | 已知红（非回归信号）：…/apps/game/client-api-tsconfig.json 的 include 有 1/2 条不存在: src/engine/script/apis/*.ts → 客户端 DTS 无法再生成

== PASS  pass=52 fail=0 skip=0  baseline=/mnt/d/desktop/神奇代码岛/box3-re/baseline/g3-baseline.tsv ==
```

### 4.3 红绿自测（证明这道闸真的会拦）

**没有红测的门等于没有门。** 用篡改基线（模拟 4 类真实回归：契约指纹变、地图 digest 变、图数量变、play-worlds 响应体变）跑一次：

```bash
cp $B /var/tmp/a9-tampered.tsv
sed -i 's#^\(map.world.cloud-4e84ee7ef626058f-imported.digest\t\).*#\1deadbeef#' /var/tmp/a9-tampered.tsv
sed -i 's#^\(contract.server.fingerprint.sha256\t\).*#\10000000000#' /var/tmp/a9-tampered.tsv
sed -i 's#^\(http.playWorlds.body.sha256\t\).*#\11111111111#' /var/tmp/a9-tampered.tsv
sed -i 's#^\(map.playWorlds.count\t\)1#\10#' /var/tmp/a9-tampered.tsv
compat-check.sh --baseline /var/tmp/a9-tampered.tsv
```

原文输出：

```
FAIL  drift.contract.server.fingerprint.sha256 = now=5bcc18f8… base=0000000000 | 回归：与基线不一致
FAIL  drift.map.world.cloud-4e84ee7ef626058f-imported.digest = now=721ffb34… base=deadbeef | 回归：与基线不一致
FAIL  drift.map.playWorlds.count = now=1 base=0 | 回归：与基线不一致
FAIL  drift.http.playWorlds.body.sha256 = now=26158180… base=1111111111 | 回归：与基线不一致
== FAIL  pass=52 fail=4 skip=0  baseline=/var/tmp/a9-tampered.tsv ==
```

→ **4 类注入回归全部命中，退出码 1。** 随后 `rm /var/tmp/a9-tampered.tsv` 已清理。

开发期还抓到并修掉 3 个真 bug（都是脚本自身缺陷，非环境问题，值得留档）：
1. `pairs: unbound variable`（`set -u` 下 `local pairs` 未初始化）；
2. `http.playWorlds.body.sha256` 曾被误列入豁免 → 削弱 L2 核心判据，已移出；
3. `--json` 因 detail 里含裸双引号（`user:"0:0"`）产出非法 JSON，已改为删除 `\`/`"`；`node JSON.parse` 复验 **合法，56 checks**。

---

## 5. 改动 × 必过检查项映射表

约定：**必过**列里的项全部为 `PASS` 且 `drift.*` 无 fail，才允许合入。基线在改动前先跑一次 `--update-baseline` 存档，改动后必须能对回旧基线（除非该改动本身就声明了某项会变，需在 PR 里逐项写明哪一项、为什么、变成什么）。

| 改动 | 必过项（硬性） | 额外关注项（值会变但需在 PR 里显式声明） | 回归失败时的回滚方式 |
|---|---|---|---|
| **prune-standalone**（剪 `@swc/core`/typescript/esbuild/sass/babel/sql.js debug） | `l0.moduleResolution.externalUnresolved=0`、`l0.moduleResolution.relativeUnresolved=0`、`impl.coverage.missing=0`、`map.world.*.digest`、`http.playWorlds.body.sha256`、`contract.server.fingerprint.sha256` | `topo.mountList.digest`（不改挂载应不变） | **文件级恢复**：剪枝清单是纯文本 → 把被剪项加回保留名单重跑；因 L0 只读磁盘，无需回滚镜像。备份基线：`/var/tmp/pruned-standalone` 原样不动 |
| **launcher 删 creator 递归监督进程**（`launcher.js:1024` → 抄 `:911-983`） | `contract.server.fingerprint.sha256`、`map.world.cloud-4e84ee7ef626058f-imported.scriptBlobs`（≥1）、`http.health.play.code=200`、`http.playWorlds.*`、`l0.moduleResolution.relativeUnresolved=0`；**并必须补跑 L3（进图 + onPlayerJoin）** | `topo.containerList.digest`、`l0.moduleResolution.entries`（入口文件被换） | **半径 1 文件**：`launcher.js` 是单文件改动 → 保留 `launcher.js.bak-<ts>`，`cp` 回来 + 重启 creator 容器即可。因该改动只影响 creator 侧起进程路径，不动 play-worlds 数据，数据侧零风险 |
| **typescript 挪 devDependencies** | `l0.moduleResolution.externalUnresolved=0`（**这一条就是它的靶心**）、`impl.coverage.missing=0`、`contract.server.fingerprint.sha256`、`l0.moduleResolution.workspaceUnresolved=0` | `contract.server.dts.lines` 应保持 4603（生产包不再能重新生成 dts，需确认没有运行期依赖 tsc 生成类型） | **package.json 回滚 + 重新安装**：改回 `dependencies` 后 `docker build`；若已发行，用 `docker image load` 旧归档回退。**验收前必须先跑一次 `compat-check.sh --skip-http`，红即不发包** |
| **subset-fonts**（woff2-only + 去 `server/chunks` 双拷贝） | `map.world.*.digest`（地图数据不应变）、`http.playWorlds.body.sha256`、`contract.server.fingerprint.sha256`；**并必须补跑 L3：首屏字节校验和 `GET /p/<publicId>`**（字体缺失是**渲染层**回归，L0/L2 抓不到） | `topo.*` | **资源目录级恢复**：`apps/game/assets/fonts` 是纯资产目录 → 从 `/var/tmp/re-arch` 对应副本 `cp -a` 回去重建。字体裁剪**不影响服务端契约**，所以它的主要风险全部集中在 L3 首屏 —— 这一项本轮无法覆盖（§6 缺口 2） |
| **play-lite 加 portal**（A3） | `http.playWorlds.*`、`http.health.play.code=200`、`map.playWorlds.count`、`topo.runningCount`、`topo.containerList.digest`；**L3 的会话链**（`createSession` 必须能在 lite 栈里走通） | `topo.runningCount`（这正是改动目标，预期从 N 变少）、`http.playWorlds.body.sha256`（若响应里带了服务信息则预期变，需声明） | **compose 回滚**：`/var/tmp/w4-play-lite/compose.yml.bak-before-a3` 已在场，`cp` 回去重起 lite 栈即可。**注意：这是唯一自带回滚工件的改动** |
| **去 docker.sock**（P1，走 shared-Node / systemd-run） | `topo.dockerSockMounts` 从 **1 → 0**（这是目标，不是回归）；`contract.server.fingerprint.sha256`、`map.world.*.digest`、`http.playWorlds.body.sha256`、`impl.coverage.missing=0` 必须**全部不动**；**并必须补跑 L3 —— 地图起不来是这项改动最致命的失败模式** | `topo.containerList.digest`、`topo.mountList.digest`（挂载结构必变）、`topo.runningCount` | **compose 回滚**：保留 `compose.yml` 原件（`box3-re/_manifest/compose.yml` 是出厂件，已在校验范围内）+ `.env` 回退；`docker compose up -d` 即恢复。风险最高的是**运行时起图失败但不报错**，所以 L3 不能省 |
| **冷启动去同步 IO**（`spawnSync tar`、blob 全量 link、自旋锁） | `map.world.*.digest`、`map.project.*.digest`、`map.scriptBlobs.total`、`impl.coverage.missing=0` —— **blob 是否被完整 link 是这项改动的死穴，靠 digest 而非靠计时判断** | `l0.moduleResolution.*`（入口路径若改） | **代码级回滚**：这三处是独立函数（`project-manager.js:2543-2569`、`map-group-manager.js:125-146`、`local-project-state.js:6596`），按点位保留 `.bak` 逐个回退。**blob 一旦写坏会污染地图** → 回滚前先用 `/var/tmp/w4-data`（908 文件逐字节副本）比对确认地图仓未损，再决定是否回灌 |

补充：**任何**改动的通用红线 —— 若 `contract.server.fingerprint.sha256` 或 `map.world.cloud-4e84ee7ef626058f-imported.digest` 变化，且 PR 里没有逐行说明，**直接判定不通过**，无需再跑后面的层。

---

## 6. 本轮无法覆盖的缺口（诚实清单）

1. **G3 只有 1 张可用图。** 实测 `map.playWorlds.count = 1`。3 个 project 全部 `releases: []`（未发布），进不了 play。1 张图撑不起「各个功能都正常」这句话 —— 起床战争主要压 `world/entity/player/chat` 路径，`gui`/`http`/`rtc`/`dialog` 的真实使用只有个位数命中（见 §2.4，`gui`/`http`/`rtc` 各 1）。**样本量本身是风险。**
2. **L3 全层 UNVERIFIED。** `/p/<publicId>`、`createSession`、首屏字节、`onPlayerJoin` 触发证据，本轮**一项都没跑出数**。根因是双重的：(a) ANALYSIS §3.4 已证这些端点只认浏览器会话 Cookie，CLI Token 能力封顶 9 项不含它们，CI 里做不到「建图→发布→上服」；(b) 用户本轮禁止新建容器，而真实进图需要一个能接受会话的运行时。**→ 这是安全网上唯一但致命的大洞。**
3. **G4 的后半没有覆盖：`.boxplay` 被出厂 reader 接受。** 本轮只做了「契约声明面 ↔ 实现真源」的静态双向对齐，没做「独立 box3-pack 产物 → 出厂 import」的往返。需要一个能跑 import 的栈。
4. **L1 日志判据无样本。** 实测 `docker logs` play/creator 的 error 行数 = **0**、join 相关 = **0**（容器刚被 A3/A4 反复重启，日志为空）。判据本身写好了，但**这次没验到它真的能抓到东西**。安装目录下 `find -name "*.log"` 也是 0 命中 → 运行期日志目前只在容器 stdout。
5. **L0 的 require 干跑是静态解析，不是真跑。** WSL 内 `node: command not found`（实测）。静态解析能抓「文件/包没了」，抓不到「文件在但初始化期抛异常」。真正的 `node -e require` 需要在**有 node 的目标环境**（容器内）执行。
6. **L0 的 `@box/*` 工作区项只在一个副本上验过。** 实测 `l0.moduleResolution.entries = 1`（只有 `creator-services/game-server` 有 `dist/src/entry.js` + `node_modules`）。`play-local-engine` 的 `src/launcher.js` 不在同布局里，工作区项靠 `WSROOT` 向上探测命中。覆盖面偏窄。
7. **86 个未声明自定义属性含假阳性，未清洗。** 见 §2.4 精度声明。需要区分「脚本 blob」与「JSON 数据 blob」才能给准数。
8. **负载敏感指标本轮一律未测**（RSS/TTFB/冷启动）。按纪律执行 —— WSL 刚重启、A3/A4 在用 Docker，数字不可信。G2 门留给下一轮静默期。

---

## 7. 需用户授权项（按价值排序）

| # | 请求 | 为什么必须要 | 预期成本 |
|---|---|---|---|
| 1 | **授权一次受控的真实进图**：在现网 play（127.0.0.1:80）用浏览器打开 `cloud-4e84ee7ef626058f-imported`，进图后允许我从 `docker logs` 只读取 `onPlayerJoin` 痕迹 | L3 是 G3 判据的核心，**目前 4 层里唯一整层空白的一层**。没有它，「地图功能不异常」这句话无法证伪 | 用户手动点击约 2 分钟；我只做只读 `docker logs` |
| 2 | 授权起**一次性测试栈**（独立 `--project-directory` + 独立 volume，跑完即 `down -v`） | 才能做 G4 后半（`.boxplay` 往返）和 L1 的「有日志样本」验证；现网栈不能动、A3/A4 在共用 | 一次镜像导入 + 一次 up/down |
| 3 | 授权把 `yunhai-xiantu` 或 `cloud-3a043df55e5057a5-imported` 之一**发布成第 2 张 play-world** | 把 G3 样本从 1 张提到 2–3 张，覆盖 `gui/http/dialog` 路径 | 需在 creator 里点发布（受 Cookie 限制，只能人工） |
| 4 | 授权**1 行修复**：`apps/game/client-api-tsconfig.json:7` 的 `src/engine/script/apis/*.ts` → `src/engine/script/ses/apis/*.ts`（实测真源目录存在，9 个 .ts） | 解锁客户端 DTS 再生成，把「客户端 32 vs 实测 30」这个 UNVERIFIED 变成可复算 | 改 1 行 + 跑一次生成；A9 无权动源码仓 |
| 5 | 授权在一个**静默窗口**（A3/A4 结束后）跑一次 `tools/baseline.sh` | 让 G2（RSS ≤320 MiB、TTFB ≤7 ms）与 G3/G4 在**同一次改动**上同时成立，否则「体积省了但图跑不了」仍可能被漏掉 | 约 2 分钟只读采样 |
| 6 | 授权把 `compat-check.sh --skip-http --skip-docker`（1.6 s）接进 `verify.yml` | A2 已在做体积门；兼容性门是同一位置的另半张网。纯静态项不需要容器 | 一次性接线 |

---

## 附 · 本文所有结论的复跑入口

```bash
S="/mnt/d/desktop/神奇代码岛/box3-re/tools/compat-check.sh"
# ① 一次性静态取证（1.6s，不碰容器）
MSYS_NO_PATHCONV=1 wsl -d Ubuntu-24.04 -- bash "$S" --skip-http --skip-docker
# ② 全量（10s，只读现网端点）
MSYS_NO_PATHCONV=1 wsl -d Ubuntu-24.04 -- bash "$S"

# ③ 契约数字单独复算（把 §2.1 那段 awk 存成 /tmp/c.awk 后执行；两者必须给出 398 / 313）
MSYS_NO_PATHCONV=1 wsl -d Ubuntu-24.04 -- awk -f /tmp/c.awk \
  "/mnt/d/desktop/神奇代码岛/box3-local-engine/packages/script-api/dts/box3-server-api.d.ts"

# ④ 指纹自证：入库清单 sort 后 sha256，应等于脚本里的 contract.server.fingerprint.sha256
MSYS_NO_PATHCONV=1 wsl -d Ubuntu-24.04 -- bash -c \
  'sort "/mnt/d/desktop/神奇代码岛/box3-re/baseline/contract-server-api.members.tsv" | sha256sum'
# → 5bcc18f8c8434ca4b73bdefaa84861ecab12d9c9c4701d096a79336676352865
```

原始取证输出（WSL UTF-16 已用 `tr -d '\000'` 清洗）留在 `box3-re\tmp\`：
`a9.txt`（docker ps）、`a9-mnt.txt`（挂载）、`a9-inv.txt`/`a9-src.txt`（地图清点）、
`a9-scripts.txt`/`a9-ps.txt`（manifest、project.json）、`a9-jscripts.txt`（脚本 blob）、
`a9-usage.txt`/`a9-hits.txt`（§2.4 API 使用面）、`a9-logs.txt`（L1 日志判据）、
`a9-final-human.txt`/`a9-final-json.txt`（首轮输出）。
