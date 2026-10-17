# O3 — BOX3 地图创作 MCP：切片 A 交付（C3 实现 + C3b 接续）

泳道：C3（实现）→ **C3b（接续被打断的最后一环：按真实数据修正两处假设 + 修完 map-local 磁盘链）**
被测物：`box3-local-engine/tools/box3-map-mcp/`（Node 标准库，零依赖，`"type":"module"`）
实测时间：2026-10-18
本文所有数字/输出都是**亲自跑出**的原文；跑不出的显式标 **UNVERIFIED**，不写"应该能过"。

---

## 1. 结论摘要

| 项 | 结果 |
|---|---|
| `node --check`（src 11 + mock 1 + scripts 1 + test 5 = 18 个文件） | **全部通过，0 语法错误** |
| `node --test test/*.test.js` | **tests 53 / pass 53 / fail 0 / skipped 0**（原文见 §9） |
| 接续前的现场 | tests 40 / pass 35 / **fail 3** / skipped 2 |
| 3 条失败的真实根因 | **代码错**（不是测试假设错）：`src/local-store.js` 调用了 `verifyBlobName` 却**没有 import**，`ReferenceError` 沿三条路径炸出来。详见 §3 |
| skipped 2 | **已补上真数据**，现在 0 skip：默认拿仓库自带的**真实出厂 blob 目录**（377 个真 blob）当权威，实测两种命名共存并逐字节复现。详见 §8 |
| C3 发现但未写完的两个真实数据结论 | 已落到代码 + 测试 + 本文：① blob 名是 **CIDv0 或 URL-safe base64 SHA-256**（不是最初以为的只有 CIDv0）；② **客户端脚本是 ESM**，服务端脚本才是 CommonJS。详见 §7 |
| 端到端（真图） | **仍未跑通，且本轮禁止跑**（导入/建图/publish/写真实图归 C6）。缺口清单见 §9 |
| 现网只读探针 | `GET http://127.0.0.1:3127/api/creator/v1/health` → **200**，`engineVersion=v2026.1.4-linux-amd64`，`deploymentMode=creator`（只读，无任何容器变更） |

代码体量（`wc -l` 实测）：`src/` **2,669** 行（11 文件）+ `mock/engine.js` **393** + `scripts/live-probe.js` **265** + `test/` 5 文件 **1,231** = **4,558** 行 / 18 个 js 文件。

---

## 2. 工具清单（12 个：11 只读 + 1 写）

> `tools/list` 的 `annotations` 把 8 个引擎类只读工具标为 `readOnlyHint:true / openWorldHint:true`（要开 socket），3 个本地只读工具标 `openWorldHint:false`（不开 socket），唯一写工具 `script_write` 标 `readOnlyHint:false / destructiveHint:true / idempotentHint:true`。
> 每个工具的 `creator/v1` scope 在 `_meta["box3-map-mcp/scope"]` 里；**没有任何工具越过出厂 9 项 scope**（`apps/game/shared/creator-cli-policy.ts:5-15`）。

### 2.1 引擎类只读（8 个，映射到 creator/v1 现有路由）

| 工具 | 入参（必填加粗） | 出参关键字段 | 副作用 | 幂等 | 失败时 |
|---|---|---|---|---|---|
| `engine_health` | — | `httpStatus, apiVersion, engineVersion, serverInstanceId, issuer, deploymentMode` | 无（唯一免鉴权路由） | 是 | 连不上→ `ENGINE_UNREACHABLE`，只读，无需回滚 |
| `map_list` | — | `count, projects[]`, 另附 `localDisk[]`（盘上只读工程清单） | 无（盘侧只读） | 是 | `CLI_TOKEN_MISSING` / `AUTH_REQUIRED` |
| `map_resources` | **`mapId`** | `projectId, counts{modelAssets,pictureAssets,audioAssets,uiTree}, resources` | 无 | 是 | 同上；此路由内部走全版本链，因此同时是**版本链可用性探针** |
| `script_list` | **`mapId`** | `sharedScripts[]`（HTTP 面只有共享表）+ `mapLocalScripts[]`（`{entry,side,type,hash,size,shared:false}`，只来自盘） | 无 | 是 | 未配 `BOX_MAP_PROJECTS_ROOT` 时 `mapLocalScripts` 缺省并回 `note` |
| `script_read` | **`mapId, side, entry`**，可选 `source: auto/http/local` | `readBackSource('http-shared'｜'local-disk'), content, hash, contentBytes/size, nameForm, hashMatchesContent/contentVerified` | 无 | 是 | `LOCAL_ROOT_MISSING` / `LOCAL_SCRIPT_NOT_FOUND` / `LOCAL_SCRIPT_SIDE_MISMATCH` |
| `data_read` | **`mapId, scope, space`**，可选 `key,page,limit` | `httpStatus, items｜item, total, nextCursor` | 无 | 是 | `INVALID_STORAGE_REQUEST`（引擎原样在带内返回） |
| `runtime_status` | **`mapId`** | `phase, running, message, updatedAt` | 无 | 是 | 编辑库不为未打开工程分配运行时 → `idle` 是**正常态**，不当故障 |
| `runtime_events_tail` | **`mapId`**，可选 `sinceEventId,maxEvents,idleMs,timeoutMs,judge` | `stopReason, received, lastEventId, events[], verdict{verdict,passed,findings}` | 无（读完自己断流，不挂 SSE） | 是 | 无 `Last-Event-ID` 时只收到初始 status 帧 → 判 `NO_EVENTS/passed:false`，**绝不报 PASS** |

### 2.2 本地只读（3 个，纯本地、不开 socket、不碰引擎）

| 工具 | 入参 | 出参 | 副作用 | 幂等 |
|---|---|---|---|---|
| `script_typecheck` | **`side, content`**，可选 `dialect, mode` | `satisfied, mode, blocking, dialect, dialectSource, errors[], warnings[], notes[]` | 无（`mode=language-service/auto` 时只读仓库声明文件；ESM 解析会 `mkdtemp` 一个临时 `.mjs` 跑 `node --check` 后**立刻删除**，不落工程盘） | 是 |
| `contract_describe` | **`side`**，可选 `filter` | `side, declarationFiles, missingDeclarationFiles, globals[{name,type,members[]}]` | 无 | 是 |
| `map_revision` | **`mapId`** | `mapId, permanentMapId, projectDir, blobRoot, permissionHash, branchName, headHash, state, groupState` | 无（三文件只读） | 是 |

### 2.3 唯一写工具 `script_write`

入参：**`mapId, side, entry, content`**；`expectedRevision`（乐观锁令牌）、`confirm`（默认 false = dry-run）、`dialect`（默认按 side）、`typeGateMode`、`verify` + `sinceEventId/maxEvents/verifyIdleMs/verifyWaitMs`、`allowUnhedged`（明知无 CAS）、`allowBlindWrite`（明知无回滚原内容）。`additionalProperties:false`，未声明键在 server 层就被 `INVALID_ARGS` 打回。

固定管线（顺序是承重的）：

```
validate → 读当前 revision（盘上 branch.headHash；不可用时降级 script hash）
        → CAS 比对 expectedRevision        ← 拦在最外层，先于任何 IO
        → 取写前镜像 preImage
        → 类型门（落盘前）
        → confirm!==true 时到此为止，返回 plan（dry-run 不写任何东西）
        → PUT scripts.update
        → 读回校验（逐字节 + blob 名摘要，两种命名形式都算）
        → 可选 V2 运行期验收
        → 有 error 级发现且有写前镜像 → PUT 写前内容回去（自动回滚）
```

副作用：产生新 blob 并推进版本链（引擎侧 blob 只增不改）；非入口脚本还会 bump `group-state.revision` 并 materialize 到全组。
幂等性：`idempotentHint:true` 的准确含义是**同一内容重复落盘不产生第二个 blob**（内容寻址 + `existsSync` 短路）；而**同一请求原样重放会被 CAS 拦住**（第一次写后 headHash 已换），这是设计意图，实测见 §6.5。
失败回滚：`FAILED_ROLLED_BACK` 回的是**原内容字节**，不是原 revision——版本链上会留下"改坏→再改回"两个头（内容等价、哈希不等价），要回到真旧 revision 只能用工程快照，切片 A 未暴露。回滚自身失败时明确报 `rolledBack:false` + "必须人工介入"。

**发现分级（本轮把这条语义显式化，未放松任何真校验）**：`severity:'error'` = 字节/摘要确实错 → 拦落盘或触发回滚；`severity:'warning'` = **某项检查没能运行**（blob 名是不可复算的形式、运行时 idle 导致验收没证据、map-local 无盘读通道）→ 保留写入、放进 `unverified` / `unresolved`，`status` 变成 `WRITTEN_WITH_UNVERIFIED_CHECKS` / `WRITTEN_ACCEPTANCE_UNVERIFIED`，**永不冒充 OK**。旧代码把全部 findings 混在一起当回滚条件，会让一个"无法验证"的警告摧毁一次正确写入。type bits（1/7）、乐观锁、类型门、逐字节读回四处校验只增不减。

---

## 3. 三条失败的真实根因：**代码错**（同一个缺失 import），不是测试假设错

接续前失败原文（三条）：

```
✖ map-local entry scripts are readable from disk and type bits are enforced
✖ writing map-local index.js advances the version chain and reloads from disk
✖ map-local script_read falls back to the disk chain automatically
```

前两条的 actual 报错完全相同：

```
ReferenceError: verifyBlobName is not defined
    at LocalMapStore.readMapLocalScript (src/local-store.js:179:17)
```

第三条是同一个异常换了传播路径：`script_read(entry:'index.js')` → `auto` 判定走盘 → 同函数 → 异常被 server 层吞成**带内** `isError:true`，于是断言 `read.result.isError === false` 得到 `true !== false`。

判定依据：

- `verifyBlobName` **确实存在且实现正确**（`src/cid.js`，是 C3 按真实数据刚补的函数），`src/local-store.js` 只是在第 179 行用了它却**没有 import**。这是**半成品代码**，不是测试写错。
- 三条测试的断言全部与出厂引擎一致，逐条核过：type bits `1/7` = `internals/schema/group-project/rda.ts:19-37`（`JS_SCRIPT=1` / `CLIENT_JS_SCRIPT=7`）+ 写入处 `project-manager.js:2165-2171`；map-local 不进共享表 = `project-manager.js:2090`；`readProjectScript` 只查 `extraProject.scriptAssets` = `:2200-2237`；map-local 写回**新** headHash 而共享写回**旧** headHash = `:2197` vs `:2160`。
- 因此**没有动任何断言来迁就代码**：只补 import（+ 把该函数改成对"真实字节 Buffer"而非"已解码字符串"做校验）。修完这 3 条自然全绿，且顺带把 §7 的两处真实校验**收紧**了。

C3 被打断时的那句话——"Critical real-data findings (URL-safe SHA-256 blob names + ESM client scripts). Let me fix the guards accordingly."——它已经写完了 `cid.js` 侧的 `verifyBlobName/urlSafeSha256Name`，**没来得及**把它们接进 `local-store.js`、`script-write.js`、`tools.js` 与类型门。C3b 做的正是这半段。

---

## 4. `tools/list` 原文

生成命令（无副作用，可直接 diff）：

```
cd box3-local-engine/tools/box3-map-mcp
node src/index.js --tools-json            # 12 个工具，18,379 字节
# 同一份快照已固化：docs/tools-list.snapshot.json
```

Stdio 真实往返也已验证（`initialize` → `notifications/initialized` → `tools/list` → `tools/call engine_health`，三行 JSON-RPC 原文见 §5.3 与附录）。协议面只有 4 个方法：`initialize / tools/list / tools/call / ping`（+ `notifications/initialized`、`logging/setLogLevels`），`tools` 能力声明 `listChanged:false`；未知方法回 `-32601`，缺 `jsonrpc:"2.0"` 回 `-32600`，通知回 `undefined`（不发响应）。

协议版本协商：`2025-06-18 / 2025-03-26 / 2024-11-05` 认；不认识的（实测 `1999-01-01`）**回落**到 `2025-06-18` 而不是报错。

`instructions` 原文里点名了 `expectedRevision` 与固定顺序（dry-run 取 revision → confirm → 读回 → 事件尾断言）。

---

## 5. 8 个只读工具各自实测状态

### 5.1 现网只读（127.0.0.1 已发布端口，只读 GET，无任何容器变更）

```
$ node scripts/live-probe.js   (BOX_CREATOR_BASE_URL=http://127.0.0.1:3127)
SUMMARY: 1/8 read tools returned data; failing: map_list, map_resources, script_list,
script_read, data_read, runtime_status, runtime_events_tail; disk revision=n/a;
blob name forms: CIDv0 252/254 (CRLF-checkout-only 2), URL-safe 123/123, coexist=true;
real scripts: 0 份，gate dialect 分布 {}。
```

| 工具 | 现网状态 | 实测依据 |
|---|---|---|
| `engine_health` | ✅ **PASS（真引擎 200）** | `{"apiVersion":"v1","engineVersion":"v2026.1.4-linux-amd64","serverInstanceId":"local-engine","issuer":"local-engine","deploymentMode":"creator"}`；对照 `:80` 是 `deploymentMode":"play","engineVersion":"0.2.0"` |
| `map_list` / `map_resources` / `script_list` / `script_read` / `data_read` / `runtime_status` / `runtime_events_tail` | 🟡 **UNVERIFIED（真图数据面）** — 卡在本地前置门 `CLI_TOKEN_MISSING`，**连 socket 都没开**（这是设计：缺 token 不发请求） | 原文：`ERROR CLI_TOKEN_MISSING: 操作 "projects.list" 需要 CLI Token：请设置环境变量 BOX_CREATOR_CLI_TOKEN（bxc_ 前缀，scope 必须包含 projects.list）`（其余 6 条同形，capability 逐项对应）。签发 `bxc_` token 属**写操作**（`player-admin/players/[subjectId].ts` 的 `create-cli-token`），本轮禁止 → 记 UNVERIFIED，归 C6 |

> 注：这不是工具坏。8 个里有 7 个是**同一道无凭据门**，且报错在本地发生、错误码是预期值；带假 token 的对照实测（`server.test.js 'engine errors are reported in band'`）返回 `AUTH_REQUIRED` 且**仍是带内** `isError:true`、`error:undefined`、`id` 保留。

### 5.2 盘侧（磁盘版本链）

| 项 | 状态 |
|---|---|
| `map_revision` / `script_read` 盘读 / `script_list` 的 `mapLocalScripts` | 🟡 现网 **UNVERIFIED**：仓库树里 `apps/local-engine/projects/` 是**空目录**（容器由宿主 bind mount 覆盖），真实工程目录在 Linux 包内 `/root/box3/BOX3-Engine-Server-0.2.0-linux-amd64/apps/local-engine/projects/`。进容器读属 Docker 操作，**C6 独占，本轮不碰** |
| 同一套代码路径 | ✅ **已在 mock 引擎上全链验证**：mock 逐字复刻 `project-state.json → permissionHash → versionControl → branch.headHash → scriptAssets → blob` 与 map-local/共享两条分叉（`mock/engine.js` 头注释点名复刻的行号），磁盘链读、CAS、推进、回退都过了 |
| 真实 blob 命名（不需要工程目录，用仓库自带出厂 blob） | ✅ **已实测**：`apps/local-engine/data/blobs/` 378 个真文件，254 CIDv0 + 123 URL-safe 共存。见 §7.1 |

### 5.3 本地两个只读

| 工具 | 状态 | 原文数字 |
|---|---|---|
| `contract_describe` | ✅ PASS | `server`: 3 份声明文件全在（`missing:[]`），**73 个全局**，`world` 成员 **108**；`client`: `packages/script-api/dts/client-api-types.dts`，**21 个全局**，`world` 成员 **2**（客户端声明面冻结这件事与 `ANALYSIS §3.4` / O2 §B-6 一致，未重新生成） |
| `script_typecheck` | ✅ PASS | 默认 `auto`；本部署 **typescript 不可解析**（devDependency，部署树里没有）→ 如实降级 `mode:'syntax-fallback'`，`notes` 明说"这一层不含语义类型检查"。原文见 §6.4 |

---

## 6. `script_write` 的乐观锁与类型门：验证证据（原文）

取证脚本 = mock 引擎 + 真代码路径（`tamper:true` 让存储层**恰好坏一次**，模拟链路改字节）。以下为**逐字输出**：

```
1 DRY-RUN: {"dryRun":true,"currentRevision":"QmUCQ53h3GtsruMDzF3QuVbr8z4wacTZr9c5PCbHpyPFtG",
  "revisionSource":"branch.headHash","predictedHash":"QmarWckznMPzzjKgw4LzkDN9eJh24bB1DzUVX6xwcr14yt",
  "predictedNameForm":"cidv0","preImageSource":"http-shared","rollbackAvailable":true,
  "isNewScript":false,"gate":{"satisfied":true,"mode":"syntax","dialect":"cjs"}}
   disk touched by dry-run? false
2 CAS: REVISION_CONFLICT | {"expected":"QmStale0","current":"QmUCQ53h3GtsruMDzF3QuVbr8z4wacTZr9c5PCbHpyPFtG","revisionSource":"branch.headHash"}
3 GATE: TYPE_GATE_FAILED | ["SYNTAX_ERROR"]
4 WRITE(tamper-once): {"status":"FAILED_ROLLED_BACK","rolledBack":true,
   "failures":[["CONTENT_MUTATED","error"],["HASH_MISMATCH","error"]],
   "readBackSource":"http-shared","engineHash":"Qmdi5HMebUKV22fqvtoR4nhtJHfc3BK4xs83BXfYvr37qw",
   "rollbackVerified":true}
5 REPAIR: {"status":"OK","failures":0,"unverified":0,"readBackSource":"http-shared","contentBack":true}
6 CLIENT ESM map-local write: {"status":"OK","dialect":"esm","hash":"QmNobVbJFpqf6Eh3WVLeaXobCUtSABs5WvQkvNJzmbhvVf",
   "shared":false,"readBackSource":"local-disk",
   "nameForm":{"form":"cidv0","verifiable":true,"verified":true,
     "actual":"QmNobVbJFpqf6Eh3WVLeaXobCUtSABs5WvQkvNJzmbhvVf",
     "expected":"QmNobVbJFpqf6Eh3WVLeaXobCUtSABs5WvQkvNJzmbhvVf"},
   "contentBack":true,"headMoved":true}
```

### 6.1 乐观锁（CAS）为什么必须存在、以及它的可信来源

引擎的 `scripts.update` **没有 CAS**：`updateProjectScript` 在 `project-manager.js:2076-2081` 读了 `branch.headHash`，但从不拿它跟调用方给的令牌比。所以锁**只能在工具里**，而工具是唯一的写者。

锁的权威来源是**盘上那三个文件**（`project-state.json → permissionHash → versionControl → branches[currentBranch].headHash`），与引擎读的同一条链；`creator/v1` 出厂 9 scope **没有任何一个能读到 headHash**（`projects.list` / `resources` / `scripts` 都到不了版本链，plan/N2 2.1），所以不能配 HTTP、也不新开 scope。`map_revision` 就是这条链的只读出口。

实测覆盖（全绿）：

| 语义 | 测试 | 关键断言 |
|---|---|---|
| dry-run 绝不写 | `dry-run changes nothing on disk and hands back the revision token` | `project-state.json` 字节改前==改后（上面 `disk touched by dry-run? false`） |
| confirm 不带令牌 = 拒 | `confirm without expectedRevision is refused (engine has no CAS)` | `REVISION_REQUIRED`，并把 `currentRevision` 回给调用方 |
| 过期令牌 = 拒，**先于任何 IO** | `a stale expectedRevision is refused before any HTTP write` | `REVISION_CONFLICT` + 盘未变 |
| 令牌会转（防重放） | `writing map-local index.js advances the version chain…` 末段 | 第二次带旧令牌 → `REVISION_CONFLICT`（见 §6.5） |
| map-local 无盘读 = 不许写 | `map-local entries cannot be written without a readable revision source` | `REVISION_SOURCE_UNAVAILABLE`（不是降级成盲写） |
| revision 语义不对称 | 代码注释 + `engineNotes` 原文 | 共享写回**旧**头（`:2160`）、map-local 写回**新**头（`:2197`），不可当同一种 token 用 |

### 6.2 类型门：默认值 + 拦在写之前

| 检查 | 实测 |
|---|---|
| 拦在任何 HTTP 之前 | `the type gate blocks before anything is sent`：坏语法 + 含数据库连接串两次都 `TYPE_GATE_FAILED`，`project-state.json` 一字节没动 |
| 语法 | `SYNTAX_ERROR`（cjs 走 `node:vm` 解析；esm 走 `node --check`，见 §6.4） |
| **type bits** | `LOCAL_SCRIPT_SIDE_MISMATCH`：`index.js` 请求 `side=client` 被拒（1≠7）；`unknown` 类型位不再被猜成 server（`AssetType` 1/7 之外的值报 `unknown`） |
| 敏感内容 | 与引擎发布规则**同源**的 7 条正则（`project-manager.js:63-73` 镜像），命中即 error 级、阻断；`sensitive content mirrors the engine publish rule and is blocking` ✅ |
| 体积 | `20 MiB` = 协议上限（`packages/cli/src/index.ts:11,82-84`），`size limit matches the protocol ceiling` ✅ |
| 未声明 API 成员 | **只提示不拦**：真实地图会在 `world/player/entity` 上挂未声明自定义属性（G3 2.4 计 86 个），拦了就是打死真图。`undeclared members are warnings, never a block (86 custom properties landmine)` ✅ |
| 诚实报告层级 | `auto mode reports honestly which tier ran`：`mode ∈ {language-service, syntax-fallback}`，永不把"门过了"冒充"类型检过了" |

上面第 3 行原文：`3 GATE: TYPE_GATE_FAILED | ["SYNTAX_ERROR"]`（输入 `content:'function ( {'`）。

### 6.3 读回校验与自动回滚

第 4 行原文同时抓到两项：`CONTENT_MUTATED`（逐字节不比预期多一个 `\n// tampered`）与 `HASH_MISMATCH`（blob 名按声明形式从字节复算对不上）→ `status:FAILED_ROLLED_BACK`，`rolledBack:true`，回滚后用 GET 复取的内容 == 原内容（`restored.data.content === 'module.exports = { v: 1 }\n'`）。

新增的盘侧 blob 名校验：map-local 写后从 `headHash` 链读回，若 `nameForm.verifiable && !verified` → `READBACK_BLOB_NAME_MISMATCH`（error）。理由：**名字与字节不符的 blob 能在盘上活着，但进不了游玩包**（`project-manager.js:54-60` 的可达闭包 + plan/N2 5.2 C6）。

回滚的诚实边界（代码里 `rollback.note` 原文）：blob 内容寻址、只增不改（`project-manager.js:2053-2055`），所以"改坏→再改回"在链上留两个 revision，**内容等价、哈希不等价**；回到真旧 revision 需要工程快照，切片 A 不暴露。回滚写入自己失败 → `rolledBack:false` + 明说"地图停在坏内容上，必须人工介入"。

### 6.4 类型门层级与解析器（原文 notes）

```
CLIENT ESM gate => {"satisfied":true,"dialect":"esm","dialectSource":"side=client 默认",
  "notes":["dialect=esm（side=client 默认）：服务端 index.js 走 CommonJS 沙箱，客户端 clientIndex.js 走 import-map ES Module 沙箱。",
           "解析器：node --check (.mjs)",
           "未声明成员比对依据：packages/script-api/dts/client-api-types.dts"]}
SERVER ESM gate => {"satisfied":false,"dialect":"cjs","errors":["ESM_SYNTAX_IN_CJS_SCRIPT"]}
```

`mode:'off'` 是显式逃生阀，返回里 `blocking:false` 且 `notes` 明说"本次没有做任何落盘前校验，兼容性完全靠运行期验收回路兜底"。

### 6.5 验收回路（V2）与"没证据 ≠ 通过"

| 场景 | 原文结果 |
|---|---|
| 事件流里有 `exception` + `Cannot find module` | `acceptance loop fails loudly…`：`status:FAILED_ROLLED_BACK`，`acceptance.verdict:'FAIL'`，findings 含 `MODULE_NOT_FOUND`，`rolledBack:true` |
| 运行时 idle（编辑库不为未打开工程起运行时） | `acceptance refuses to claim a pass when the runtime is idle`：`verdict:'SKIPPED_RUNTIME_NOT_RUNNING'`，`passed:false`，`status:'WRITTEN_ACCEPTANCE_UNVERIFIED'`，`unresolved[0].code='RUNTIME_IDLE'` —— **保留写入但绝不记通过**（启动预览要 `runtime.control`，切片 A 未暴露该工具） |
| 只收到初始 status 帧（无 `Last-Event-ID`） | `verdict:'NO_EVENTS'`，`passed:false`（`NO_RUNTIME_EVIDENCE`） |
| 旧令牌重放（幂等性边界） | §6.1 第 4 行；`REVISION_CONFLICT`，不会产生第二个 blob |

---

## 7. 两个真实数据结论（C3 发现、C3b 落地）

### 7.1 blob 名 = CIDv0 **或** URL-safe base64 SHA-256（不是最初以为的只有 CIDv0/base58）

**为什么这是兼容性问题而不是洁癖**：blob 文件名**就是包格式的一部分**（O2 地雷 3）。`project-manager.js:54-56` 的原文注释：
> "Cloud runtime assets use both CIDv0 and URL-safe SHA-256 names. Embedded extraProject metadata is binary, so publishing must discover both forms or **models, skins and shared scripts disappear from the play package**."
配套三条正则就在下面 `:55-60`（`Qm[1-9A-HJ-NP-Za-km-z]{44}` / `(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])` / legacy UUID v4）。

**出厂读路径本身就按这个分支**：`services/game-server/src/script/script-host.ts:229-243` —— `module.hash.startsWith('Qm')` 先 IPFS、否则直接 OSS CDN。也就是说**非 `Qm` 前缀的脚本哈希是一等公民**，不是异常。

**实测普查（本轮亲自跑出，只读，未写任何 blob）**：

```
目录：apps/local-engine/data/blobs（出厂内置内容；378 个目录项 = 377 个 blob + 1 个 .gitkeep）
CIDv0          254 个：252 个逐字节复现；2 个仅在 CRLF->LF 归一后复现
URL-safe SHA256 123 个：123 个全部逐字节复现（0 例外）
两种形式共存 = true
（sha256('') base64url = 47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU，与现网零字节 blob 的命名规则一致）
```

真图侧的命名共存也有既有取证：`box3-re/tmp/a9-jscripts.txt` 在**同一张云导入图**的 `projects/cloud-4e84ee7ef626058f-imported/source/blobs/` 里列出 `I5bnLmD_sN8gzktSvzqe7lkn1voN-BfHahEWCei8Obs`（43 字符 URL-safe）与一串 `Qm…`；`cloud-3a043df55e5057a5-imported` 里另有 3 个。

**落到代码（四处，全部是收紧不是放松）**：

| 位置 | 改动 |
|---|---|
| `src/cid.js` | `verifyBlobName(bytes,name)` 返回 `{form,verifiable,verified,actual,expected}`；`isUrlSafeSha256Name` 导出。CIDv0 与 URL-safe 都**按声明的形式**复算摘要；legacy UUID / 无法识别的形式 `verifiable:false` → 报 unverified，**不冒充通过、也不冒充不匹配** |
| `src/local-store.js` | 盘读改为**读 Buffer**（`size` 用真实字节数、摘要用真实字节），返回 `nameForm` + `contentVerified` |
| `src/script-write.js` | 把 `isCidV0(result.hash) && result.hash !== contentHash(content)` 换成 `verifyBlobName`。**旧写法对 URL-safe 名直接跳过校验**——真图上一个静默失效的检查就这样补回来了；不可复算的形式落 `unverified` |
| `src/tools.js` | `script_read` 的 HTTP 分支同样换成 `verifyBlobName`（旧写法会在**每张云导入图**上把完好脚本报成 mismatch，是个假警报）；盘分支透出 `nameForm/contentVerified` |

关键不对称，已被测试钉住：引擎写者 `storeReleaseBlob`（`project-manager.js:196-205`）**只产 CIDv0**，而云导入的图里已经存着 URL-safe 名。所以"**读认两种、写只产 CIDv0**"。实测（`an imported map with URL-safe blob names keeps CAS, pre-image and read-back honest`）：

```
A 链上名字(URL-safe) headHash = TFwQ72pCHlVe4zJtOpmV4xEbZ4TaKJBS-utcadMGXRg | len 43
B script_read http: {"form":"sha256-url","hashMatchesContent":true}
C script_read disk: {"source":"local-disk","form":"sha256-url","contentVerified":true}
D dry-run: {"currentRevision":"TFwQ72pCHlVe4zJtOpmV4xEbZ4TaKJBS-utcadMGXRg","revisionSource":"branch.headHash",
            "predictedHash":"QmS3ZrzHov3bAtSLy1yu6VT6fnEqJvVt7jBecJfZVVWrXL","predictedNameForm":"cidv0","preImageSource":"local-disk"}
E write:   {"status":"OK","failures":0,"unverified":0,"newHeadIsCidv0":true,"diskNameForm":"cidv0","contentVerified":true}
F legacy-uuid 形式: {"form":"legacy-uuid","verifiable":false,"verified":true}   ← 报 unverified，不报 mismatch
```

乐观锁令牌本身就是那个 43 字符名字，**照用不误**（旧代码的 `isCidV0` 前置条件会让这条链上的一切校验静默旁路）。

### 7.2 客户端脚本是 ESM，服务端脚本才是 CommonJS

证据（逐行核过出厂实现，不是推测）：

- **客户端 = ES Module**：`apps/game/src/engine/script/ses/ses-client.ts:51` 类注释"使用 iframe 作为隔离的沙箱环境执行客户端脚本，**支持 ES Module**"；`:182-188` 检查 `HTMLScriptElement.supports('importmap')`；`:210` `buildImportMap()`；`:230-232` 注入 `<script type="importmap">`；`:283-294` `entryScript.type = 'module'` 且入口正文就是 `import '<absolute entry key>';`；`:334` 模块体 `new Blob([...], { type: 'text/javascript' })`；`:346-350` 同时登记**无扩展名**（TS 风格）别名；`:363-380` 把相对 `import/export from`/`import()` 的重写为沙箱绝对路径。入口名 = `'clientIndex.js'`（`engine/script/index.ts:174`）。注入的全局清单里没有 `require`（`ses/apis/index.ts:64-95`）。
- **服务端 = CommonJS**：`services/game-server/src/script/bindings/resource.ts:387-405` 给每个模块构造 `{__dirname,__filename,require,resources,module,exports}` 并交给 `evalFuncs.module(...)`；`script-shell.ts:1007` `require:(id)=>this.resource.loadModule(id,null)`；`safe-eval.ts:36-52` 用 `Function.apply(null, globals.concat(src))` 以**函数体**求值；`script-start.ts:3` 本身就是 `module.exports = function (...)`。

**落到代码**：

| 位置 | 改动 |
|---|---|
| `src/typegate.js` | `defaultDialect(side)`：`server→cjs`、`client→esm`；返回 `dialect` + `dialectSource`（explicit / `side=… 默认`），覆盖行为永远如实报告 |
| `src/typegate.js` | **ESM 解析改成真解析**：临时 `.mjs` + `node --check`（不解析标识符、不执行、模块上下文），`parser:'node --check (.mjs)'`；只有 spawn 不可用才退回注释掉 import 行的 `node:vm` 解析，并在 `notes` 里明说这是弱层（`parser:'vm-strip-fallback'`）。**这条替换本身就是修 bug**：旧"ESM 解析"会把多行 import 打断、且看不见 `import.meta` / 顶层 await |
| `src/typegate.js` | 新增 `auditModuleDialect`：ESM 里出现 `require/module.exports/exports` → **error**（那个沙箱里这些名字不存在），消息里给两个逃生阀（`dialect:"cjs"` / `mode:"off"`）；裸 import 标识符 → **warning**（Import Map 只登记本图自己的模块），与既有 `require` 策略同构、交给运行期验收兜底。扫描前剥注释，避免注释掉的 `require` 误杀 |
| `src/typegate.js` | 修掉**错误事实**的旧文案：原先写"服务端入口 index.js / **客户端 clientIndex.js 由 CommonJS 沙箱加载**（plan/N2 1.3）"——客户端那句是错的，已按上面的行号重写 |
| `src/tools.js` | `dialect` schema 不再写死 `default:'cjs'`，改为说明按 side 取默认；`script_read` 描述补 blob 名形式 |

**为什么旧行为是真坏**：旧代码 `dialect` 默认 `cjs`，任何带顶层 `import/export` 的客户端脚本都会撞 `ESM_SYNTAX_IN_CJS_SCRIPT` → `TYPE_GATE_FAILED` → **AI 写不出任何合法的 clientIndex.js**（与 O2 §590 那句出厂 AI 提示"do NOT generate client scripts"叠加，把可修的一行文案问题坐实成能力缺失）。同时服务端的 CJS 门**一点没松**：同一段 ESM 字节送 `side:server` 仍然被拒，且实测拒在 HTTP 之前（§6.4 + `a client entry script is written as ESM and read back byte exact`）。

---

## 8. `skipped 2` 的处置：**已补上，现在 0 skip**

原来两条 `t.skip` 的条件是 `BOX3_REAL_BLOBS_DIR` 未设置——它们要的是"真实引擎已经存过的 blob 字节"，而不是模拟数据。本轮发现**仓库里就带着一份真实 blob 目录**（`apps/local-engine/data/blobs/`，378 个出厂文件），于是：

1. `test/cid.test.js` 把该目录设为默认权威（`BOX3_REAL_BLOBS_DIR` 仍可覆盖），只在目录不存在（精简/裁剪树、slim 发行物）时才 skip；
2. 两条 skip 的用例现在**真跑真过**，并新增第三条专门覆盖 URL-safe 形式；三条 diagnostic 原文：
   ```
   ℹ CIDv0 真实 blob 254 个：全部复现；其中 2 个仅在 CRLF->LF 归一后一致（Windows checkout 现象，非引擎漂移）
   ℹ 两种命名共存实测：CIDv0 254 个 + URL-safe SHA-256 123 个，全部逐字节复现
   ℹ 可解析 JSON blob 1 个，逐字节复现 1 个
   ```

**那 2 个"不匹配"必须写清，因为它容易被误读成引擎漂移**：两者都是**文本** blob（345,089 B 的 `/*! …` JS 与 484,114 B 的 `declare type GameLoggerMethod…` DTS），内含 9,222 / 13,804 个 CRLF；把 CRLF 折成 LF 后**两个都逐字节复现**。即 `git` 检出换行归一化改了工作树副本，**容器里的真实 blob 没有这个问题**（Linux 侧不换行）。因此测试**只接受这一条确切解释**（`normalized → verified`），任何其他摘要不符仍然 fail。这是**收窄**判据，不是放松。

这条同时是个**给后续所有 blob 校验的警告**：在 Windows 检出上复算内容地址会出假阴性，任何"包体检"类工具都必须按**原始字节**读，且不要把结论写成"出厂内容坏了"。

---

## 9. `node --test` 原文汇总 + 端到端还缺什么

### 9.1 本轮亲自跑出的汇总

```
$ cd tools/box3-map-mcp && node --check <18 个 js>      → 全部通过，0 语法错误
$ cd tools/box3-map-mcp && node --test test/*.test.js
ℹ tests 53
ℹ suites 0
ℹ pass 53
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 6886.3331
exit code 0
```

按文件逐条数（`node --test <file>` 单跑，与合跑口径一致）：`cid.test.js` 7 + `local-store.test.js` 7 + `script-write.test.js` 14 + `server.test.js` 11 + `typegate.test.js` 14 = **53**，全绿、无 `✖`。
相对接续前：40→**53**（净增 13 条，全部围绕两种 blob 名与 ESM/CJS 方言），3 fail→**0**，2 skip→**0**。

### 9.2 端到端还缺什么（真图闭环，逐项归口）

| # | 缺口 | 为什么现在跑不了 | 归口 |
|---|---|---|---|
| 1 | **CLI Token** | 8 只读工具里 7 个 + 唯一写工具都要 `bxc_` Bearer；签发 `create-cli-token` 是**写操作**且**硬依赖 PostgreSQL**（`local-player-identity.ts:915` 无库直接 throw）。本轮禁写、禁容器变更 | C6 |
| 2 | **`BOX_MAP_PROJECTS_ROOT` 真值** | 乐观锁唯一可信来源是盘上 `branch.headHash`；仓库树里 `apps/local-engine/projects/` 是**空目录**（容器 bind mount 覆盖），真目录在 Linux 包内 `/root/box3/…`。进容器读属 Docker 动作 | C6 |
| 3 | **真图 `script_write` 一次** | 本轮硬纪律：禁止导入 .boxproject / 建图 / publish / 写真实地图数据。当前只有 mock 全链证据 | C6 |
| 4 | **`confirm` 后真图载回** | map-local 写后的"出厂 reader 仍能载入"这条只验到 mock；真图要 `runtime_events_tail` 抓 `exception`/`MODULE_NOT_FOUND` | C6 |
| 5 | **预览运行时** | `runtime.control` 在出厂 9 scope 里但**切片 A 故意没暴露**（启动运行时不是只读，也不属于 A 的写面）；运行时 idle 时 V2 验收只能报 `SKIPPED_RUNTIME_NOT_RUNNING` | 切片 A 后续 / C6 |
| 6 | **G3/G4 回归联动** | 写完的 blob 名/类型位要能被发布闭包扫到（`project-compatibility.js`、`compatibility.ok`），且 `map.world.<id>.digest` 基线（908 文件 / `721ffb34…`）会随写变动 | C6（基准）+ C4/C4b（引擎写入口） |
| 7 | **客户端声明面太薄** | `contract_describe(client)` 只有 **21 个全局 / world 成员 2**（`client-api-tsconfig.json:7-10` 的 include 指向 0 命中路径，DTS 无法再生成）。门能过 ≠ API 真的可用；AI 产 client 脚本前**必须先做 O2 §B-6**（重开 `build-llm-context.ts:46` + 重算 API_RES + 改掉 `ai-server.ts:70` 那句 "Do NOT generate client scripts"） | 引擎侧（不在本泳道所有权） |
| 8 | **地形/UI 写入口为零** | 切片 A 只覆盖**脚本面**。体素只能走 mudb `VoxelProtocol`（且 `validate-project-action.ts:14-21` 明确禁止 project 级 voxel 动作）、`entity-tools.ts` 无 UI 工具、`creator/v1` 无 UI scope → 全接管地图开发的阻塞点是改造项 **R1**（切片 B） | C5/切片 B |
| 9 | **注册接线未做** | MCP client 侧 registration JSON（`command: node …/src/index.js` + 四个 env）尚未挂到实际宿主；本轮只在 stdio 往返里验证了协议 | 待主控决定 |
| 10 | **借道越权面未处置** | 任意 scope 的合法 `bxc_` Bearer 可借同一身份链行使账号全部 UI 级创作权限（GATES D2 之②）。切片 A 自身只用 9 scope，但**端到端演练一旦用真 token 就会撞上这个面** | 安全项，独立处置 |

### 9.3 复跑命令（全部只读，无副作用）

```bash
cd D:/desktop/神奇代码岛/box3-local-engine/tools/box3-map-mcp

# 1) 语法
for f in src/*.js mock/*.js scripts/*.js test/*.js; do node --check "$f"; done

# 2) 测试（含真 blob 目录普查；不需要 token、不开容器、不碰真图）
node --test test/*.test.js

# 3) tools/list 原文（与 docs/tools-list.snapshot.json 应当逐字节一致）
node src/index.js --tools-json
node src/index.js --config-json          # token 打码后的生效配置

# 4) 现网只读探针（只 GET；无 token 时 7/8 工具会在本地前置门停下）
BOX_CREATOR_BASE_URL=http://127.0.0.1:3127 node scripts/live-probe.js
#   换真权威目录：BOX3_REAL_BLOBS_DIR=<...>/source/blobs
#   换真图：      BOX3_LIVE_MAP_ID=<20 位 hex> BOX_MAP_PROJECTS_ROOT=<projects 父目录>

# 5) 只读注册（profile=readonly 或 ALLOW_WRITE=0 时 tools/list 不出现 script_write，
#    真调用回 WRITE_DISABLED）—— 本轮 CLI 实测原文：
#    tools: 11 | has script_write: false
#    names: engine_health,map_list,map_resources,script_list,script_read,data_read,
#           runtime_status,runtime_events_tail,script_typecheck,contract_describe,map_revision
BOX_MCP_PROFILE=readonly node src/index.js --tools-json
```

---

## 附录 A：`tools/list` 原文（`node src/index.js --tools-json` 逐字节输出）

```json
{
  "tools": [
    {
      "name": "engine_health",
      "description": "引擎健康检查。唯一不需要鉴权的 creator/v1 路由，用来确认基地址、镜像版本与部署模式。副作用：无。",
      "inputSchema": {
        "type": "object",
        "properties": {},
        "additionalProperties": false
      },
      "annotations": {
        "title": "Creator 引擎健康检查",
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": true
      },
      "_meta": {
        "box3-map-mcp/scope": "（无需 token）"
      }
    },
    {
      "name": "map_list",
      "description": "列出本地引擎全部工程（地图）。返回 permanentMapId / name / status / mapRole / updatedAt。副作用：无。",
      "inputSchema": {
        "type": "object",
        "properties": {},
        "additionalProperties": false
      },
      "annotations": {
        "title": "地图清单",
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": true
      },
      "_meta": {
        "box3-map-mcp/scope": "projects.list"
      }
    },
    {
      "name": "map_resources",
      "description": "读一张图的资源清单（模型/图片/音频/UI 树索引）。对应 getProjectResources（project-manager.js:2342-2389），它内部会走 permissionHash → versionControl → branch.headHash 全链，所以这个工具同时是版本链可用性的探针。副作用：无。",
      "inputSchema": {
        "type": "object",
        "properties": {
          "mapId": {
            "type": "string",
            "description": "地图标识：永久地图 ID（20 位十六进制）或本地工程目录名，两者引擎都认（project-manager.js:974-988）",
            "minLength": 1,
            "maxLength": 63
          }
        },
        "required": [
          "mapId"
        ],
        "additionalProperties": false
      },
      "annotations": {
        "title": "地图资源清单",
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": true
      },
      "_meta": {
        "box3-map-mcp/scope": "resources.list"
      }
    },
    {
      "name": "script_list",
      "description": "列脚本。HTTP 面只返回地图组共享脚本（listProjectSharedScripts, project-manager.js:2239-2269）；配了 BOX_MAP_PROJECTS_ROOT 时额外返回 map-local 入口脚本（index.js / clientIndex.js），那两类在 HTTP 面上是读不到的。副作用：无（盘侧只读）。",
      "inputSchema": {
        "type": "object",
        "properties": {
          "mapId": {
            "type": "string",
            "description": "地图标识：永久地图 ID（20 位十六进制）或本地工程目录名，两者引擎都认（project-manager.js:974-988）",
            "minLength": 1,
            "maxLength": 63
          }
        },
        "required": [
          "mapId"
        ],
        "additionalProperties": false
      },
      "annotations": {
        "title": "脚本清单",
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": true
      },
      "_meta": {
        "box3-map-mcp/scope": "scripts.read"
      }
    },
    {
      "name": "script_read",
      "description": "读一份脚本正文 + 内容哈希。shared 脚本走 GET .../scripts/{side}/{entry}；map-local 入口脚本 HTTP 必定 404，会自动退回盘上 headHash 链读取。盘读会带回 nameForm/contentVerified：blob 名可能是 CIDv0，也可能是 URL-safe SHA-256（云端导入的图两种混在同一个 blobs 目录里），两种都按字节复算校验；legacy UUID 形式无法复算，只会报 unverified。副作用：无。",
      "inputSchema": {
        "type": "object",
        "properties": {
          "mapId": {
            "type": "string",
            "description": "地图标识：永久地图 ID（20 位十六进制）或本地工程目录名，两者引擎都认（project-manager.js:974-988）",
            "minLength": 1,
            "maxLength": 63
          },
          "side": {
            "type": "string",
            "enum": [
              "client",
              "server"
            ],
            "description": "脚本侧：server 走服务端 isolate，client 走客户端；类型位 1/7（project-manager.js:2170）"
          },
          "entry": {
            "type": "string",
            "pattern": "^[A-Za-z0-9._-]{1,160}$",
            "description": "脚本文件名。index.js / clientIndex.js 是 map-local，其余默认进地图组共享表"
          },
          "source": {
            "type": "string",
            "enum": [
              "auto",
              "http",
              "local"
            ],
            "description": "auto：先 HTTP，map-local 时退盘；http/local：只走一种，便于对照两条路径"
          }
        },
        "required": [
          "mapId",
          "side",
          "entry"
        ],
        "additionalProperties": false
      },
      "annotations": {
        "title": "读取脚本正文",
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": true
      },
      "_meta": {
        "box3-map-mcp/scope": "scripts.read"
      }
    },
    {
      "name": "data_read",
      "description": "读作者数据空间（world.storage 的盘侧对应物）。带 key 返回单值，不带 key 返回分页键列表。上限：space 名 [A-Za-z0-9_]{1,50}，key ≤1 KiB，limit 1-100。副作用：无。",
      "inputSchema": {
        "type": "object",
        "properties": {
          "mapId": {
            "type": "string",
            "description": "地图标识：永久地图 ID（20 位十六进制）或本地工程目录名，两者引擎都认（project-manager.js:974-988）",
            "minLength": 1,
            "maxLength": 63
          },
          "scope": {
            "type": "string",
            "enum": [
              "project",
              "group"
            ]
          },
          "space": {
            "type": "string",
            "pattern": "^[A-Za-z0-9_]{1,50}$"
          },
          "key": {
            "type": "string",
            "maxLength": 1024
          },
          "page": {
            "type": "integer",
            "minimum": 0
          },
          "limit": {
            "type": "integer",
            "minimum": 1,
            "maximum": 100
          }
        },
        "required": [
          "mapId",
          "scope",
          "space"
        ],
        "additionalProperties": false
      },
      "annotations": {
        "title": "读数据空间",
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": true
      },
      "_meta": {
        "box3-map-mcp/scope": "storage.read"
      }
    },
    {
      "name": "runtime_status",
      "description": "预览运行时状态。编辑库不会为未打开的工程分配运行时，所以 idle 是正常态而非故障。副作用：无。",
      "inputSchema": {
        "type": "object",
        "properties": {
          "mapId": {
            "type": "string",
            "description": "地图标识：永久地图 ID（20 位十六进制）或本地工程目录名，两者引擎都认（project-manager.js:974-988）",
            "minLength": 1,
            "maxLength": 63
          }
        },
        "required": [
          "mapId"
        ],
        "additionalProperties": false
      },
      "annotations": {
        "title": "预览运行时状态",
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": true
      },
      "_meta": {
        "box3-map-mcp/scope": "runtime.view"
      }
    },
    {
      "name": "runtime_events_tail",
      "description": "取预览运行期事件尾部（log / exception / clear / status，缓冲上限 500 条、单条 16 KiB）。本工具读完自己断流，不会把 SSE 挂住。传 sinceEventId 可利用 Last-Event-ID 重放（服务端只重放 id > N 的，所以最早只能从 id=2 起，id=1 与 id=0 的初始 status 帧取不回）。副作用：无。",
      "inputSchema": {
        "type": "object",
        "properties": {
          "mapId": {
            "type": "string",
            "description": "地图标识：永久地图 ID（20 位十六进制）或本地工程目录名，两者引擎都认（project-manager.js:974-988）",
            "minLength": 1,
            "maxLength": 63
          },
          "sinceEventId": {
            "type": "integer",
            "minimum": 1
          },
          "maxEvents": {
            "type": "integer",
            "minimum": 1,
            "maximum": 500,
            "default": 50
          },
          "idleMs": {
            "type": "integer",
            "minimum": 100,
            "maximum": 10000,
            "default": 1500
          },
          "timeoutMs": {
            "type": "integer",
            "minimum": 500,
            "maximum": 30000,
            "default": 15000
          },
          "judge": {
            "type": "boolean",
            "default": true,
            "description": "是否顺带跑 V2 判定（无 exception / 无 MODULE_NOT_FOUND）"
          }
        },
        "required": [
          "mapId"
        ],
        "additionalProperties": false
      },
      "annotations": {
        "title": "运行期事件尾部与验收判定",
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": true
      },
      "_meta": {
        "box3-map-mcp/scope": "runtime.view"
      }
    },
    {
      "name": "script_typecheck",
      "description": "落盘前的类型/语法门（V0），纯本地，不碰引擎。mode=language-service 时等价于 apps/game/scripts/check-editor-types.ts:12-54 的 ts.createLanguageService；typescript 不可解析时自动降级到 syntax（node:vm 解析 + 声明文件未声明成员提示），并在 mode 里如实报告。副作用：无。",
      "inputSchema": {
        "type": "object",
        "properties": {
          "side": {
            "type": "string",
            "enum": [
              "client",
              "server"
            ],
            "description": "脚本侧：server 走服务端 isolate，client 走客户端；类型位 1/7（project-manager.js:2170）"
          },
          "content": {
            "type": "string",
            "description": "待校验正文"
          },
          "dialect": {
            "type": "string",
            "enum": [
              "cjs",
              "esm"
            ],
            "description": "脚本方言；不传时按 side 取默认：server=cjs、client=esm（客户端脚本实测就是 ESM，require/module.exports 在那个沙箱里不存在）。显式传值会覆盖默认，并在返回的 dialect/dialectSource 里如实标注。"
          },
          "mode": {
            "type": "string",
            "enum": [
              "auto",
              "language-service",
              "syntax",
              "off"
            ]
          }
        },
        "required": [
          "side",
          "content"
        ],
        "additionalProperties": false
      },
      "annotations": {
        "title": "脚本类型门",
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
      },
      "_meta": {
        "box3-map-mcp/scope": "（纯本地，无 HTTP）"
      }
    },
    {
      "name": "contract_describe",
      "description": "从出厂声明文件里读出 API 全局与成员名单，供 AI 按签名写脚本而不是凭记忆猜 API。纯本地、只读；结论只是提示（真实地图会在 API 对象上挂未声明自定义属性）。副作用：无。",
      "inputSchema": {
        "type": "object",
        "properties": {
          "side": {
            "type": "string",
            "enum": [
              "client",
              "server"
            ],
            "description": "脚本侧：server 走服务端 isolate，client 走客户端；类型位 1/7（project-manager.js:2170）"
          },
          "filter": {
            "type": "string",
            "description": "只看某个全局名，或只看含该成员的全局"
          }
        },
        "required": [
          "side"
        ],
        "additionalProperties": false
      },
      "annotations": {
        "title": "API 契约面查询",
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
      },
      "_meta": {
        "box3-map-mcp/scope": "（纯本地，无 HTTP）"
      }
    },
    {
      "name": "map_revision",
      "description": "读引擎的 revision 令牌：project-state.json → permissionHash → versionControl → branch.headHash（盘侧只读）。这是 scripts.update 唯一可信的乐观锁凭据（引擎自己不做 CAS）。未配 BOX_MAP_PROJECTS_ROOT 时明确报不可用。副作用：无。",
      "inputSchema": {
        "type": "object",
        "properties": {
          "mapId": {
            "type": "string",
            "description": "地图标识：永久地图 ID（20 位十六进制）或本地工程目录名，两者引擎都认（project-manager.js:974-988）",
            "minLength": 1,
            "maxLength": 63
          }
        },
        "required": [
          "mapId"
        ],
        "additionalProperties": false
      },
      "annotations": {
        "title": "地图版本头",
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
      },
      "_meta": {
        "box3-map-mcp/scope": "（纯本地盘读，无 HTTP）"
      }
    },
    {
      "name": "script_write",
      "description": "唯一的写工具：走 scripts.update 写一份作者脚本（PUT .../scripts/{side}/{entry}）。默认 confirm:false = dry-run，只返回计划（当前 revision、预测 CIDv0、类型门结论），不写任何东西。真写必须带 expectedRevision，与引擎当前 revision 不一致就 REVISION_CONFLICT 拒绝；落盘前必过类型门；写后逐字节读回校验，失败自动把原内容写回。副作用：产生新 blob 并推进版本链（引擎侧只增不改）。",
      "inputSchema": {
        "type": "object",
        "properties": {
          "mapId": {
            "type": "string",
            "description": "地图标识：永久地图 ID（20 位十六进制）或本地工程目录名，两者引擎都认（project-manager.js:974-988）",
            "minLength": 1,
            "maxLength": 63
          },
          "side": {
            "type": "string",
            "enum": [
              "client",
              "server"
            ],
            "description": "脚本侧：server 走服务端 isolate，client 走客户端；类型位 1/7（project-manager.js:2170）"
          },
          "entry": {
            "type": "string",
            "pattern": "^[A-Za-z0-9._-]{1,160}$",
            "description": "脚本文件名。index.js / clientIndex.js 是 map-local，其余默认进地图组共享表"
          },
          "content": {
            "type": "string",
            "description": "完整正文（整体覆盖，不是补丁）"
          },
          "expectedRevision": {
            "type": "string",
            "description": "乐观锁令牌：branch.headHash（有盘读时）或 script_read 的 hash（降级模式）"
          },
          "confirm": {
            "type": "boolean",
            "default": false,
            "description": "false=dry-run；true 才落盘"
          },
          "dialect": {
            "type": "string",
            "enum": [
              "cjs",
              "esm"
            ],
            "description": "脚本方言；不传时按 side 取默认：server=cjs、client=esm（客户端脚本实测就是 ESM，require/module.exports 在那个沙箱里不存在）。显式传值会覆盖默认，并在返回的 dialect/dialectSource 里如实标注。"
          },
          "typeGateMode": {
            "type": "string",
            "enum": [
              "auto",
              "language-service",
              "syntax",
              "off"
            ]
          },
          "verify": {
            "type": "boolean",
            "default": false,
            "description": "写后跑 V2 运行期验收（需要预览运行时在跑）"
          },
          "sinceEventId": {
            "type": "integer",
            "minimum": 1,
            "description": "验收窗口起点：Last-Event-ID 重放只覆盖 id > 此值的事件，用它跳过写入前已有的异常"
          },
          "maxEvents": {
            "type": "integer",
            "minimum": 1,
            "maximum": 500,
            "default": 200
          },
          "verifyIdleMs": {
            "type": "integer",
            "minimum": 100,
            "maximum": 10000,
            "default": 1500
          },
          "verifyWaitMs": {
            "type": "integer",
            "minimum": 500,
            "maximum": 30000,
            "default": 8000
          },
          "allowUnhedged": {
            "type": "boolean",
            "default": false,
            "description": "明知无 CAS 也要写（默认禁止）"
          },
          "allowBlindWrite": {
            "type": "boolean",
            "default": false,
            "description": "明知无回滚原内容也要写（默认禁止）"
          }
        },
        "required": [
          "mapId",
          "side",
          "entry",
          "content"
        ],
        "additionalProperties": false
      },
      "annotations": {
        "title": "写入作者脚本（带乐观锁与类型门）",
        "readOnlyHint": false,
        "destructiveHint": true,
        "idempotentHint": true,
        "openWorldHint": true
      },
      "_meta": {
        "box3-map-mcp/scope": "scripts.update"
      }
    }
  ]
}
```
