# O26 · 机器可判 DoD 四组门 + AI 作业规程 playbook（E 泳道，2026-10-18）

承重结论一句话：**"这张图算不算做完"已经落成 17 条可执行断言（静态 4 / 运行 4 / 可回滚 4 / 兼容 5）+ 57 个 DoD 错误码，其中"UI 引用悬空即红"是独立一条规则并把悬空名单独回传（`report.uiDangling`）；17 条规则全部有反例、46 个 (规则, 码) 组合被 `assert` 判成 FAIL，没有一个写成 skip。**

验收口径对照 `box3-re/plan/N7-ai-adaptation-decisions.md` E 行：
> DoD 里含"UI 引用悬空即红"，且每条规则都有反例真的变红

| 口径 | 落点 |
|---|---|
| "UI 引用悬空即红" | 规则 `S3-ui-reference-not-dangling`，码 `UI_REFERENCE_DANGLING`（`retryable:true`）；`evaluateDoD` 的返回里单独有 `uiDangling:[{name, script, via, line}]`，`firstFailurePayload()` 会把它当第一失败项直接吐给模型。测试：`test/dod.test.js` 的 *S3 red: a UI reference that is not in the tree is red, and the report names it* |
| "每条规则都有反例真的变红" | 覆盖率自证测试 *every DoD rule has at least one asserted-red counterexample*：`assertRed()` 每被调用一次就往 `provenRed`/`provenRedPairs` 记账，测试结束时把 `DOD_RULES` 的 17 个 id 与该集合求差并 `deepEqual([])`；**新增规则若没有真的红过一次，全量测试立刻红**。计数（不是声明）：`provenRedPairs.size = 46 ≥ 40`，可用 `BOX3_DOD_REPORT_COUNT=1 node --test test/dod.test.js` 打印 |
| 缺证据=红 | 每条规则带 `requires`，缺证据产出 `EVIDENCE_MISSING` 阻塞项：`evaluateDoD({mapId:'empty'})` 得到 16 条失败（只有 `S2` 无 `requires`，它判的是门自身的配置漂移） |

---

## 1. 交付物与边界

| 文件 | 行数 | 说明 |
|---|---|---|
| `tools/box3-map-mcp/src/dod.js` | 1457 | 新建。零外部依赖，只 import 同目录既有 `acceptance.js` / `typegate.js` / `errors.js`；23 个显式 export；不注册进 `src/tools.js`、不改 `src/tools/index.js` |
| `tools/box3-map-mcp/test/dod.test.js` | 754 | 新建。42 个测试：正向 + 反例成对，外加覆盖率自证、错误契约自证、playbook 审计、泳道 C 信封形状 |
| 既有文件 | — | **一个都没动**（`src/tools.js`、`src/tools/index.js`、`src/errors.js`、`src/acceptance.js`、`src/typegate.js`、`src/server.js` 全为只读） |
| 泳道 C 的 `src/ui-binding.js` | — | 不 import、不创建、不占位（本轮它已由 C 落盘，E 只加了一条"信封形状兼容"测）。接入方式是 `options.uiBindingValidator`（或 `evidence.uiBindingFindings`）注入；`UI_REFERENCE_PATTERNS` 也只做"可加不可减"的加宽（`options.uiReferencePatterns`） |

测试原文数字（宿主 node v24.18.0，WSL 无 node）：

```
node --test test/dod.test.js        → tests 42 / pass 42 / fail 0 / skipped 0
node --test test/*.test.js（全量）  → tests 178 / pass 177 / fail 1 / skipped 0
```

那 1 条 fail **不是 E 泳道的缺陷**，是 A 泳道留给"dod.js 还不存在"的守卫断言：`test/tools-wiring.test.js:280` `assert.equal(fs.existsSync('src/dod.js'), false, 'lane A 不得创建 src/dod.js')`（同文件 :281 对 `ui-binding.js` 的同款断言在 C 落盘后同命）。任务落盘即失效，**需主控改成"已接线"口径**（见 §5）。该测试其余部分（既有文件不得 import 泳道 E/C 模块）仍然有效且通过。

---

## 2. 四组门：17 条规则、判据、证据、码表

`evaluateDoD(evidence, options)` → `{verdict, passed, groups, gates[], failures[], advisories[], uiDangling[], blockingRuleIds[], next}`。
每个失败项都是 `{ruleId, group, severity, code, retryable, hint, message, detail}`；`verifyErrorContract()` 在返回前自检：码没登记 / 缺 `retryable` / `hint` 空 / warning 用了阻塞码 ⇒ **直接 throw**（DoD 自己不许有半成品结论）。

### 2.1 静态（4 条）

| id | 判据 | 证据 | 阻塞码 | 源码依据 |
|---|---|---|---|---|
| `S1-script-syntax-dialect` | 两侧方言分别是 CJS/ESM 且语法门过 | `scripts[].{side,content,check}`；无 `check` 时用 `options.typegateConfig` 现场跑 `checkScript` | `SCRIPT_SIDE_INVALID` / `SCRIPT_GATE_FAILED` / `SCRIPT_DIALECT_MISMATCH` / `SCRIPT_GATE_UNAVAILABLE` | 服务端 `index.js` 走 CJS 包装（`services/game-server/src/script/bindings/resource.ts:387-405`），`clientIndex.js` 走 import-map ESM（`apps/game/src/engine/script/ses/ses-client.ts:283-294`） |
| `S2-advisory-only-undeclared-members` | 未声明成员**只能**告警；把这类码注册成拦截项本身即判红 | `options.blockingCodes`、`scripts[].check.errors/warnings` | `DOD_GATE_NARROWING` / `UNDECLARED_MEMBER_TREATED_AS_BLOCKING` | `src/contract.js:174 UNDECLARED_API_MEMBER` 是 warning；真实地图带 **86 个未声明自定义属性** |
| `S3-ui-reference-not-dangling` | 脚本按名字取的 UI 节点必须在 `ui_tree_read` 的树里（name 与 id 都算已声明，`Root`/`screen`/`ROOT_ID`/`DEFAULT_SCREEN_ID` 白送） | `scripts[].content` + `uiTree.nodes`；C 泳道注入位 | `UI_REFERENCE_DANGLING` / `UI_BINDING_INVALID` / `EVIDENCE_MISSING` | `packages/script-api/src/client/modules/ui.ts:41 findChildByName`、`map-authoring-tools.ts:354-375` 节点形状 |
| `S4-no-sensitive-strings` | 正文不得命中引擎发布规则那组正则 | `scripts[].content`、`evidence.textAssets` | `SENSITIVE_CONTENT`（`retryable:false`） | `apps/local-engine/src/project-manager.js:63-73/249-261`（复用 `scanSensitiveContent`，不重抄规则） |

模式：`UI_REFERENCE_PATTERNS` 4 条（`ui.findChildByName('X')` / `ui.screen('X')` / `ui.byName('X')` / `binding.uiNode:'X'`）。扫之前先 `stripComments()`：注释里的引用不算引用（与 typegate 对 `require` 的同款处理），已建但没引用的节点只出 `UI_NODE_UNREFERENCED` 告警 —— **超集是合法的**。

### 2.2 运行（4 条）

| id | 判据 | 阻塞码 | 源码/实测依据 |
|---|---|---|---|
| `R1-entry-contract` | 入口 SSR 不得 `notFound` / 不得跳登录 / `playEnabled!==false` / HTTP 2xx | `ENTRY_NOT_FOUND`、`ENTRY_PLAY_DISABLED`、`ENTRY_AUTH_REDIRECT`、`ENTRY_BAD_STATUS` | `apps/game/pages/p/[gameName]/index.tsx:55-68`、`apps/local-engine/src/play-library.js:424-436`（转发失败 502） |
| `R2-ws-session-survives` | 会话必须真连上、没被踢、活过阈值、到进图里程碑 | `WS_KICK_NO_AUTH`（`CloseType.NoAuth`=枚举第 6 个=**5**）、`WS_KICKED`、`WS_CLOSE_1005`、`WS_ABNORMAL_CLOSE`、`WS_SESSION_TOO_SHORT`（默认 3000 ms）、`WS_SESSION_NOT_CONNECTED`、`WS_NO_WORLD_ENTRY` | `internals/schema/types/game.ts:1-10`、`services/game-server/src/index.ts:366`、`edit/replica/replica-server.ts:1391`；`kickSession` 后 `client.close()` 不带状态码 ⇒ 浏览器 `1005/''/wasClean=true`，`O15-ws-disconnect.md:10` 四条路径实测（回环 40 ms 同形） |
| `R3-runtime-events-tail-clean` | 事件尾无 exception / 无 MODULE_NOT_FOUND，且窗口里必须有"有内容的事件" | `RUNTIME_EXCEPTION`、`MODULE_NOT_FOUND`、`NO_RUNTIME_EVIDENCE`、`RUNTIME_IDLE`、`EVIDENCE_MISSING` | **直接复用 `judgeEvents()`**（`src/acceptance.js:33`），零改动；只有 status 帧的窗口它自己就判 fail，DoD 继承该判定，不再另立一套"空=通过" |
| `R4-no-save-while-preview-running` | **预览在跑时的任何 save 都是硬失败**，`force:true` 另计一条；写过地形却没有"预览已停"的成功保存 ⇒ 再补一条 | `SAVE_WHILE_PREVIEW_RUNNING`、`SAVE_FORCE_USED`、`TERRAIN_NOT_PERSISTED` | `services/game-server/src/edit/replica/replica-server.ts:1600-1603`：`if (!gameState.replica.running) { recordVoxelInfo(...) }` ⇒ 预览中保存**不记录 voxel chunk hash**，存了等于静默丢地形 |

### 2.3 可回滚（4 条）

| id | 判据 | 阻塞码 |
|---|---|---|
| `B1-prewrite-token-captured` | save/写之前必须拿到 `before.revision` 或 `before.headHash`（也接受原文快照） | `PREWRITE_TOKEN_MISSING` |
| `B2-rollback-confirmed-and-readable` | 失败项必须 `rolledBack===true` **且**有读回证据 | `WRITE_NOT_ROLLED_BACK`、`ROLLBACK_READBACK_MISSING` |
| `B3-revision-conflict-is-retryable` | 冲突（`REVISION_CONFLICT`/`EXPECTED_REVISION_REQUIRED`/409/message 含 revision·CAS·conflict·409）必须带原码且 `retryable:true`；塌成 `TOOL_FAILED` 判红 | `CONFLICT_NOT_RETRYABLE`、`ERROR_CONTRACT_INCOMPLETE` |
| `B4-head-hash-chain-monotonic` | 写成功后 `after.headHash` 必须推进（`noChangeDeclared:true` 才豁免）；回滚后读回头必须等于写前头 | `HEAD_HASH_UNREADABLE`、`HEAD_HASH_NOT_ADVANCED`、`ROLLBACK_HASH_MISMATCH` |

`B3` 的可重试性判定**不自己拍**：以 `src/errors.js isRetryable()` 为权威，DoD 只负责发现"上游说了假话"。`B1/B4` 的令牌语义对齐 `src/tools/_shared.js:523-566 requireClientRevision` 与 `src/local-store.js:114-141 readRevision().headHash`。

### 2.4 兼容（5 条，全部只允许增长/超集）

| id | 判据 | 阻塞码 |
|---|---|---|
| `K1-legacy-map-bytes-unchanged` | 旧图写前/写后摘要逐字节相等；`declaredChange:true` **也照样红**（DoD 不豁免，改动要走人工评审） | `LEGACY_MAP_BYTES_CHANGED`、`LEGACY_READBACK_UNAVAILABLE` |
| `K2-custom-properties-preserved` | 未声明自定义属性逐键不能少；只给计数时数量不能缩（86 → 85 即红） | `CUSTOM_PROPERTY_DROPPED`、`CUSTOM_PROPERTY_COUNT_SHRANK` |
| `K3-no-freeze-seal-narrowing` | 注入对象禁 `frozen`/`sealed`；`surfaceAfter` 必须是 `surfaceBefore` 的超集 | `INJECTION_FROZEN`、`INJECTION_SEALED`、`INJECTION_SURFACE_NARROWED` |
| `K4-surface-growth-only` | 对外面（`tools/list`、声明面、契约）只增不减：A 泳道 12→37 是合格样例，掉一个名字就判红 | `ADVERTISED_TOOL_REMOVED` |
| `K5-entry-contract-and-protected-fields-untouched` | 写操作不得碰 `name/author/description/cover/loadingCover`；`entryContract.modified===true` 判红；`kind:'read'` 的触碰不计 | `PROTECTED_FIELD_TOUCHED`、`ENTRY_CONTRACT_MODIFIED` |

`compareSurface(before, after)` 是全组共用的唯一比较原语：`superset === (removed.length === 0)`，**永远不比"相等"**。受保护字段清单转录自 `apps/game/server/play-admin.ts:858-859`（`PROTECTED_PLAY_FIELDS`，`options`/`evidence.extraProtectedFields` 只能追加）。

---

## 3. 反例矩阵（46 个红，全部 `assert` 判 FAIL）

下表"反例数"是 `assertRed()` 的**调用次数**（54 次，同一 (规则,码) 被多条测重复钉住）；测试里记账的是**去重后的 46 个 (ruleId, code) 组合**，该数字由 `provenRedPairs.size` 现场测量并 `assert ≥ 40`，不是照抄本表。跑 `BOX3_DOD_REPORT_COUNT=1 node --test test/dod.test.js` 会打印 `DOD_RED_PAIRS=46 DOD_RED_CALLS=54`。

| 规则 | 反例数 | 变红的码 |
|---|---|---|
| S1 | 5 | `SCRIPT_GATE_FAILED`（真门跑出 `ESM_SYNTAX_IN_CJS_SCRIPT`）、`SCRIPT_DIALECT_MISMATCH`（客户端用 `dialect:'cjs'` 逃生阀——门过了 DoD 仍不放过）、`SCRIPT_SIDE_INVALID`、`SCRIPT_GATE_UNAVAILABLE` |
| S2 | 2 | `DOD_GATE_NARROWING`、`UNDECLARED_MEMBER_TREATED_AS_BLOCKING` |
| S3 | 4 | `UI_REFERENCE_DANGLING`、`EVIDENCE_MISSING`（没读 `ui_tree_read`）、`UI_BINDING_INVALID`（C 注入位返回 error 级 ×2：自造数组 + 照 `ui-binding.js` 的 `{ok, problems[]}` 信封原样喂进去） |
| S4 | 1 | `SENSITIVE_CONTENT`（postgres DSN） |
| R1 | 4 | `ENTRY_NOT_FOUND`、`ENTRY_PLAY_DISABLED`、`ENTRY_AUTH_REDIRECT`、`ENTRY_BAD_STATUS` |
| R2 | 6 | `WS_KICK_NO_AUTH`、`WS_KICKED`、`WS_CLOSE_1005`、`WS_SESSION_TOO_SHORT`、`WS_SESSION_NOT_CONNECTED`、`WS_NO_WORLD_ENTRY` |
| R3 | 5 | `RUNTIME_EXCEPTION`、`MODULE_NOT_FOUND`、`NO_RUNTIME_EVIDENCE`、`EVIDENCE_MISSING`、`RUNTIME_IDLE` |
| R4 | 3 | `SAVE_WHILE_PREVIEW_RUNNING`、`SAVE_FORCE_USED`、`TERRAIN_NOT_PERSISTED` |
| B1–B4 | 9 | `PREWRITE_TOKEN_MISSING`、`WRITE_NOT_ROLLED_BACK`、`ROLLBACK_READBACK_MISSING`、`CONFLICT_NOT_RETRYABLE`、`ERROR_CONTRACT_INCOMPLETE`、`HEAD_HASH_NOT_ADVANCED`、`ROLLBACK_HASH_MISMATCH`、`HEAD_HASH_UNREADABLE` |
| K1–K5 | 15 | 见 §2.4 各码；K5 的 5 个受保护字段逐个试了一遍 |
| 缺证据总账 | 16 | 全 17 条里 16 条在同一测里给出 `EVIDENCE_MISSING` |
| playbook 自身 | 3 | `PLAYBOOK_ORDER_INVALID`（save/起预览换序、删掉"停预览"、不可跳步骤不写错误码） |
| DoD 自我契约 | 3 | `verifyErrorContract()` 对未登记码 / warning 用阻塞码 / 空 hint **各自 throw** |

正向对照（防"为反而反"的过拦）：真实语法门跑 server CJS + client ESM 双双过；未声明成员只在 warnings 里 ⇒ 判绿；注释掉的 `findChildByName('ghost')` ⇒ 不判悬空；探针自己 `ws.close()` 造成的 1005 ⇒ 判绿（O15:179 的第二种同形读数）；`surfaceAfter` 只增长 ⇒ 判绿；只读碰了 `manifest/name` ⇒ 判绿；`noChangeDeclared:true` ⇒ 判绿。

---

## 4. AI 作业规程 playbook（F 泳道照抄这份，12 步，8 步不可跳）

同 `src/dod.js` 的 `PLAYBOOK` 常量（**代码即文档**，`auditPlaybook()` 会审这份规程本身）。不可跳：1、3、4、6、9、10、11、12。

| # | 动作 | 用哪个 MCP 工具 | 读哪个返回字段 | 失败先看哪个码 | 可跳 |
|---|---|---|---|---|---|
| 1 | 读状态：能不能写、预览在不在跑 | `map_status` | `runtimeActive` / `preview.running` / `canPersistTerrain` | `HTTP_502` | **否** |
| 2 | 读能力目录：22 个引擎工具此刻挂没挂 | `map_tool_catalog` | `missing[]` | `ENGINE_TOOL_NOT_MOUNTED` | 是 |
| 3 | 取版本令牌（乐观锁 + 回滚物料） | `map_revision`（UI 用 `ui_tree_read`，脚本用 `script_read`） | `headHash` / `revision` | `REVISION_SOURCE_UNAVAILABLE` | **否** |
| 4 | **停预览** | `map_preview {action:"stop"}` | `preview.running=false` | `SAVE_WHILE_PREVIEW_RUNNING` | **否** |
| 5 | 读现状：要改那块长什么样 | `ui_tree_read` / `entity_list` / `terrain_info` / `script_list` / `script_read` | 节点 name/id、实体 id、脚本 revision | `LOCAL_SCRIPT_NOT_FOUND` | 是 |
| 6 | **先过静态门**再落笔 | `script_typecheck` | `satisfied` / `errors` / `warnings` | `TYPE_GATE_FAILED` | **否** |
| 7 | 先建 UI 节点（把脚本要引用的名字建出来） | `ui_node_add` | `nodeIds` / `newRevision`（批量链式） | `REVISION_CONFLICT` | 是（顺序不可跳） |
| 8 | 写地形/实体/模型/脚本正文，一小步一令牌 | `terrain_apply` / `entity_create` / `entity_update` / `model_add_to_project` / `script_write` / `script_patch` | 新 revision | `REVISION_CONFLICT` | 是 |
| 9 | **落盘，不带 force** | `map_save` | `permissionHash` / `diskHeadHash` | `SAVE_WHILE_PREVIEW_RUNNING` | **否** |
| 10 | **起预览**，进入可取证状态 | `map_preview {action:"start"}` | `preview.running=true` | `RUNTIME_IDLE` | **否** |
| 11 | **自检 DoD** | `evaluateDoD`（`src/dod.js`；主控待暴露为 `map_dod_report`） | `verdict` / `failures[]` / `uiDangling[]` | `UI_REFERENCE_DANGLING` | **否** |
| 12 | **冒烟**：进图一次 + 读事件尾 | `runtime_events_tail`（+ 播放侧探针记 `entry`/`ws` 读数） | exceptions / close code / kick | `WS_KICK_NO_AUTH` | **否** |

三条不能省的为什么（写进步骤里，别让下一个 AI 自己发现）：
- 第 4 步早于第 9 步 = `replica-server.ts:1600-1603` 的硬顺序，跳了就静默丢地形（`R4`）。
- 第 3 步 = 没有写前令牌就没有回滚，也没有 CAS（`B1`/`B4`）。
- 第 10 步早于第 11/12 步 = `judgeEvents` 把"零事件窗口"判 fail，预览没跑就没有任何证据（`R3`）。
- 第 7 步早于第 8 步 = 先建节点再写引用，否则新脚本自己的引用就是悬空的（`S3`）。

---

## 5. 需要主控接线/决策的点（E 泳道无权改的部分）

1. **暴露 DoD 工具**：把 `evaluateDoD` 包成 `map_dod_report`（建议 `{mapId, groups?, dryRun?}`）。工具本身属 A 的 `src/tools/index.js`/`src/tools.js`，E 无权登记；`map_dod_report` 目前不在 37 个名字里，测试已用断言钉住这一点。
2. **读数采集**：`evidence` 的 13 个区块（`scripts/uiTree/entry/ws/runtimeEvents/saves/writes/revisionChain/legacyReadback/customProperties/injection/toolsList/writeTouches`）需要有人从各域工具的真返回拼出来。`entry/ws` 两块**必须**由播放侧探针提供（MCP 自己开不了浏览器）。字段口径见 §2 表格与 `src/dod.js` 头注释。
3. **泳道 C 接上注入位**：`evaluateDoD(evidence, { uiBindingValidator: validateUiBindings })` 就是完整接线——已按 `src/ui-binding.js:445-451/436-440` 的真实形状核过：E 传 `{scripts, uiTree, bindings: evidence.uiBindingProposals}`，C 回 `{ok, errorCount, warningCount, problems[], checked}`，`S3` 直接吃 `.problems`（也吃裸数组 / `.findings` / `evidence.uiBindingFindings`）。`severity:'error'` ⇒ 阻塞并映射到 `UI_BINDING_INVALID`（C 的原码保留在 `detail.upstreamCode`），`severity:'warning'` ⇒ 只进 `advisories`（例如 `UI_EVENT_KIND_MISMATCH` 绝不能把图判死）。
4. **`test/tools-wiring.test.js:280`** 的 "lane A 不得创建 src/dod.js" 断言已过时（现在全量 178 里唯一那条 fail 就是它）。同文件 :281 对 `ui-binding.js` 的同款断言在 C 泳道落盘后同样失效——本轮 C 已落盘，两处需一起改成"已接线"口径。
5. **错误码归属**：DoD 新增 57 个码在 `src/dod.js DOD_CODE_CONTRACT`，与 `src/errors.js` 的 35 个并存；`verifyErrorContract()` 认两张表的并集。若主控想把它们并成一张表，改 `errors.js` 并同步删 `DOD_CODE_CONTRACT` 即可（DoD 侧只走 `dodRetryable/dodHintFor`）。
6. **`S2` 的语义确认**：把"有人拿未声明成员拦落盘"判成 DoD 红，是 E 的立场（红线是 86 个自定义属性）。若某次评审决定真的要收紧，必须显式改 `ADVISORY_CODES` 并配一条测。

## 6. UNVERIFIED（诚实清单，别当已验证用）

- `UNVERIFIED`：`entry` / `ws` 两块证据目前只有**测试内自造的读数**，没跑过真浏览器进图；kick=5→1005 这条判据是从 `O15-ws-disconnect.md:10/100` 的实测结论转录的，本轮没有复现。
- `UNVERIFIED`：`R4` 依赖 `evidence.saves[].previewRunning` 为真读数。`map_save` 现在**不返回预览状态**（只回 `forced`/`diskHeadHash`），所以接线时必须由 `map_status` 在 save 前后各取一次；否则该字段缺失会按 `EVIDENCE_MISSING` 判红（是"缺证据"，不是"违例"）。
- `UNVERIFIED`：`K1` 的旧图逐字节摘要依赖盘上导出路径（`map_revision` → blob → `stableStringify`）；本轮只用摘要字符串做了判定演练，没对 377 个真 blob 跑过对照。
- `UNVERIFIED`：`map_authoring` 侧 `uiNodeAdd/uiNodeRemove` 的真 409 形态、以及 `computeUiRevision` 令牌在长批量里的过期节奏，属 C 泳道；`B3` 只保证"冲突被上报时必须可重试"。
- `UNVERIFIED`：方言/声明面结论沿用 A 泳道的 `typegate` 实测；E 只把 `checkScript` 当真门调用了一次（测里 108 ms 那条）。
- `UNVERIFIED`：`PLAYBOOK` 第 2 步 `map_tool_catalog` 在 mock 引擎上的 `missing[]` 覆盖过，但真引擎（含 B/D 泳道改动）挂载名单每轮可能变，F 泳道跑 demo 时以实返回为准。
