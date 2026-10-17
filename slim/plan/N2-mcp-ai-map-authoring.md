# N2 · AI/MCP 全自动接管编辑端地图开发（取证与规划）

泳道：A8 ｜ 日期：2026-10-17 ｜ 作者：A8 agent
取证基线：`D:\desktop\神奇代码岛\box3-local-engine`（分支 `slim/local-deploy`，镜像 tag `v2026.1.4-linux-amd64`，**全仓只读，未改一行**）
现网取证：WSL Ubuntu-24.04 上 7 个 `box-local-engine-*` + 4 个 `box3-lite-*` 容器，**只做了 GET / env 读取 / `docker ps -a` / `docker inspect`，零容器变更、零 --pull、未访问 docker.io**。

> 结论一句话：**今天不能 headless 全自动跑完"建图→搭地形→写 UI→写代码→发布→上服"，但缺口比 §3.4 记的更小也更准确**。
> 真正卡死的只有两件事：**(a) 地形与 UI 树没有任何服务端可编程写入口**（voxel 走 mudb diff 协议、uiTree 走 replica 广播，两者都要求一个带 runtime identity token 的编辑器会话）；**(b) 代码/存储/预览/脚本类已完全 headless**（`creator/v1` + `scripts.update` + `storage.write` + `runtime.control` + `play-admin/*` Bearer）。
> 而 `create/publish/export/package/play-import` 这五个"只认浏览器 Cookie"的判断**在源码层面被推翻**：CLI Token 的 `Authorization: Bearer` 会被同一条身份链接受（`player-service-client.ts:87-89` → `player-internal/runtime-identity.ts:21-24`），只是这些路由查的是**用户级 `creatorPermissions`，完全不看 CLI scope**（`creator-api-security.ts:105` vs `:141`）。这既是 G9 的免费钥匙，也是一个越权面。

---

## 0. 需求原文（逐字）

> "我想开发一个MCP或者什么工具或者插件吧，就是说ai可以完全接管edit端地图的开发，包括地形搭建，界面按钮，代码编写，各个交互等内容都能让ai能全自动接管的东西。"

拆解为四件接管事项 + 一条发布链：**地形搭建 / 界面按钮与交互 / 代码编写 / 发布与上线**。本文逐条钉到可编程面，不缩小（交互=实体属性+zone+碰撞+gamepad+UI 事件+作者脚本 API）也不扩大（不做引擎重写、不做新格式）。

---

## 1. 四件接管事项的可编程面取证表

### 1.0 先修正一个前提：项目状态的真实载体

| 事实 | 证据 |
|---|---|
| 磁盘上工程 = `projects/<id>/{project.json, group-state.json, source/{project-state.json, blobs/<CIDv0>, build-cache.json, runtime-blobs.json}, .snapshots/*.tar.gz, releases/<v>/{manifest.json, data/…}}` | 现网只读列举：`docker exec box-local-engine-creator-1 ls projects` → `cloud-3a043df55e5057a5-imported / cloud-4e84ee7ef626058f-imported / yunhai-xiantu`；`yunhai-xiantu/source` 实测仅 4 项 |
| `project-state.json` **只有指针**，实体/地形/UI/脚本全是 blob hash：实测内容 `{formatVersion:1, permissionHash:"QmSff…", extraProjectHash:"Qmdf…", groupProjectMetaData:{version:"0.3.31", hashes:{uiTree:"QmFF…", audioAssets:"…", pictureAssets:"…"}}}` | 现网只读 `cat source/project-state.json`（见 §9 附录 A）；结构定义 `apps/local-engine/src/project-manager.js:604-612` |
| **权威内存态 = 一棵 RDA 树**，不是 JSON 文件：`ProjectRDA`（`internals/schema/project/project-rda.ts:611-649`）含 `voxels / environment / ambientSound / physics / collisionFilter / player / entitiesTree / scriptIndex / zones / gamepad / assets / deleteAssets / defaultScreenId / info / storageMode`，`version` 常量 `'0.3.31'`（`:614`） | 同文件 |
| 序列化就是"把 15 个子对象各自 storeJSON，再把 hash 表 storeJSON"，纯内容寻址、可离线复刻 | `internals/build-system/project/project-serialize.ts:18-101`（`storeProjectJSON`）、`:105`（`storeProject`）、`:108+`（`retrieveProject`，**带自动版本迁移**） |
| 编辑器运行时对外只认 4 个协议通道：`EditReplicaProtocol`（project/voxel/permissions 广播）、`CodeEditorProtocol`、`DebuggerProtocol`、**`AiProtocol`** | `services/game-server/src/edit/edit-server.ts:147-214` |

### 1.1 地形搭建（voxels / world / entity）

| 子问 | 答 | 证据（path:line） |
|---|---|---|
| 今天的入口是什么？ | **两条，且都不给外部程序**：<br>① 浏览器编辑器 VoxelEditor 模式 → mudb `VoxelProtocol`（name `'game-terrain'`）`client.voxelChange`（`BatchVoxelRun{offset,count,block}` 行程编码）→ 服务端 `_applyVoxelTransaction` 逐个 `voxels.setVoxel(x,y,z,b)`；<br>② 首次建图时的**程序化模板**（`initTerrain`） | 协议：`internals/schema/voxel/voxel-protocol.ts:17-100`；写回：`services/game-server/src/edit/replica/replica-server.ts:1277-1283`；模式枚举 `services/game-server/src/edit/schema.ts:14-18`（`EditorMode.VoxelEditor` 在 `:17`）；模板入口 `services/game-server/src/project/terrain/init-terrain.ts:19-42` |
| 实体（entity）呢？ | 实体不在 voxel 通道，在 `EntitiesTreeRDA`（`project-rda.ts:509`，节点值 = `EntitySeedRDA` `:463-505`：name/tags/position/orientation/scale/tint/mesh/meshId/bounds/collision/gravity/mass/friction/restitution/particle/damage/sound/editLock/staticShadow）。**这条面 AI 已经能写**（见下） | `internals/schema/project/project-rda.ts:463-509` |
| 有没有可 headless 调用的接口？ | **有，而且已经存在一套完整的 AI 工具集**：`services/game-server/src/edit/ai/entity-tools.ts` 里 `createEntityTools()` 暴露 11 个 zod-schema 工具（createEntity `:254`、deleteEntity `:321`、updateEntity `:346`、listEntities `:446`、moveEntity `:468`、copyEntities `:501`、getProjectModels `:609`、createEntityFromModel `:685`）+ `createScriptTools()` 4 个（listScripts `:37`、readScript `:55`、updateScript `:75`、createScript `:156`、deleteScript `:222`）。它们直接走 `replica.projectTransaction()` → `RDATransaction.commit()`，与浏览器写的是同一棵树 | `services/game-server/src/edit/ai/entity-tools.ts:31-812`；事务 `src/edit/replica/transaction/transaction.ts:4-47`（注意 `:3` 原文注释 *"transactions must be constructed and dispatched within a single tick or else stuff can fuck up"*）；挂载 `src/edit/edit-server.ts:192-202` |
| **地形有没有 AI 工具？** | **没有。`createEntityTools` 里 0 个 voxel 写入工具**。当前内置 AI 的系统提示甚至明写 *"terrain can be edited via voxels"* 却不给工具 | `entity-tools.ts` 全文（无 `voxel` 字样）；`src/edit/ai/ai-server.ts:54-76` |
| `packages/mudb` 的 synchronizer 能否离线批量写入？ | **能，但是另一族**：`services/game-server/src/script/bindings/{world,entity,voxel,zone,synchronizer}-synchronizer.ts`（5 个文件，不是 9；见 §8 矛盾清单 M1）是**作者脚本侧**的状态同步，不是工程持久化。工程持久化的离线批量入口是纯函数链：`allocVoxels(w,h,d)` → 写体素 → `saveVoxelData(contentServer, voxels)` → `VoxelInfo{shape,chunks[]}` | `packages/utils/src/voxel.ts:392`（allocVoxels）、`:424`（freeVoxels）、`services/game-server/src/project/terrain/voxel.ts:9-76`（saveVoxelPreloadData/saveVoxelData，逐 chunk `boxCompress`+`content.store`）；`VoxelRDA` = `MuRDARegister({shape, chunks: Hash[]})` `project-rda.ts:69-82` |
| 已存在的导入通道？ | **三个**：<br>① **游玩包导入** `POST /api/play-admin/import`（可 `?mode=preview` 先审、`?mode=confirm` 再装），Bearer 密钥鉴权，**今天就能 headless 用**<br>② **工程包导入** `POST /api/local-projects/import?mode=independent\|submap`（≤1 GiB 流式），Cookie 门（`projects.import`）<br>③ **模型导入** `POST /api/creator-models/import`（Cookie，`models.manage`）+ 运行时侧 `POST /api/project-models {action:'importLocal', modelId}`（**无鉴权、无 loopback 校验**）<br>④ 地图组共享：`mapGroupManager.materialize/ensure` | `apps/game/pages/api/play-admin/import.ts:27,53-59,80-90`；`pages/api/local-projects/import.ts:18,45-53`；`pages/api/creator-models/import.ts:27`；`services/game-server/src/createServer.ts:652-700`（`/api/project-models` 缺 `localOnly`）、`replica-server.ts:2094`（updateLocalProjectModel） |
| 写入后怎么落盘？ | 唯一持久化函数 `EditReplicaServer.saveProject()`：`_storeProject()` → `storeProject(buildSystem, project)` → `_updateProjectAndGroupProject` → `persistLocalProjectState(permissionHash)`。<br>**两个硬坑**：<br>1. `replica-server.ts:1602` `if (!gameState.replica.running)` —— **游戏在跑就不记录 voxel chunk hash**，AI 写完地形必须先停预览再存盘；<br>2. `saveProject` 是 3 把信号量串起来的临界区（`:2647-2685`），与浏览器自动保存（`tick()` `:1573`）互斥，外部并发调用只能排队 | `src/edit/replica/replica-server.ts:1589-1706, 2640-2701` |
| 怎么触发存盘（外部）？ | `POST http://127.0.0.1:9967/<projectId>/internal/save-local-project`（loopback-only，Next 侧 publish.ts:5-35 就是这么用的）；返回 `{permissionHash}` | `src/createServer.ts:557-633`；调用方 `apps/game/pages/api/local-projects/[id]/publish.ts:5-35`、`pages/api/system/backups.ts:11-23` |
| 怎么发布？ | `publishMapGroup` → 每个成员 `publishProject`：读 `source/project-state.json` → **要求 `state.permissionHash` 非空** → `createProjectSnapshot(id,'publish')` → `createReleaseData` → 原子 rename `releases/<version>` | `apps/local-engine/src/project-manager.js:2406-2473, 2475-2514`；硬门槛原文 `:2414-2416` *"请先打开该工程并在编辑器中保存一次，再发布为游玩包"* |

### 1.2 界面按钮与交互

| 子问 | 答 | 证据 |
|---|---|---|
| UI 配置存在什么数据结构里？ | **一棵 RDA 树 `UITreeRDA = MuRDATree(UINodeRDA)`**，节点值是多式联合：`UINodeSpec = {screen: UIScreenRDA, element: UIElementRDA}`，`UIElementSpec = {box, image, text, scrollBox, input}`（`defs.ts:768-792`）。**没有 button 这种类型**——按钮是 box/image+text 组合 + 客户端脚本绑事件 | `internals/schema/project/ui-rda/defs.ts:233,259,362,446,549,654,768-792,837-867`；默认屏 `DEFAULT_SCREEN_ID='DEFAULT_SCREEN_ID'` `:806`，`ProjectRDA.defaultScreenId` `project-rda.ts:645` |
| 布局/坐标/字号字段？ | `UICoord2RDA`、`UILayoutRDA`（`MuRDAUnion`，含 `UIAutoLayoutRDA`/`AutoResizeType`/`TextXAlignType`…）、`UIBoxRDA`、`UIImageRDA`（`ImageDisplayMode`）、`UITextRDA`（`UITextFontFamily`）、`UIScrollBoxRDA`（`UIScrollDirection`/滚动条可见性枚举） | 同上 `:51-229`、`:259-318`、`:318-527`、`:527-618`、`:618-766` |
| 场景/界面 JSON schema 在哪？ | **没有独立 JSON schema 文件**——schema 就是 mudb MuSchema 的 TS 定义，`toJSON/fromJSON` 由 RDA 生成；持久化形态是 `storeProjectJSON` 拆出来的 `uiTree` 一个 blob | `internals/build-system/project/project-serialize.ts:60-61,90`（`rawJSON.uiTree = await bs.storeJSON(rawJSON.uiTree)`）；读取端 `:170-186`（可为 `undefined` → 兼容旧图） |
| 运行时怎么加载？ | 播放端从 `hotProject.uiTree` + `defaultScreenId` 构建 UI；工程态则经 `EditReplicaProtocol.broadcast.project(actions)` 增量下发给编辑器客户端（**浏览器侧才是渲染方**） | `internals/schema/project/hot-schema.ts:177-178`；广播 `replica-server.ts:1252, 1684` |
| 有没有可 headless 写 UI 的接口？ | **没有。** `entity-tools.ts` 无 UI 工具；`creator/v1` 9 个 scope 里无 UI；`checkProjectActionSequence`（客户端动作序列校验）**不禁止 `uiTree`**，只禁 `prevHash/voxels/version/type/timestamp`，所以理论上客户端能写 uiTree，但仍需一个 mudb 会话 | `services/game-server/src/edit/replica/validate/validate-project-action.ts:14-25` |
| "交互"其余部分？ | ① **zone**（力场/雾/天/雪/雨覆写）：`ZoneRDA` = `ZoneSetRDA` 列表，`project-rda.ts:527-562`，`ProjectRDA.zones` `:634`；② **碰撞过滤**：`CollisionFilterRDA{selectorA,selectorB}` `:514-519`；③ **玩家/输入**：`PlayerRDA:395`、`GamepadRDA:584`（摇杆/飞行/跳跃/蹲/actionA/actionB 贴图）；④ **GUI（脚本驱动的对话框）**：`GameGUI` API + `gui-script.ts:16-60`（init/append/show…走 `GUIScriptProtocol` 到客户端）；⑤ **作者事件**：`world.onPlayerJoin` 等 `script/bindings/world-synchronizer.ts:116,188` | 见各 path:line |
| 危险分支（照实列） | `internals/schema/voxel/voxel-protocol.ts:14-15` `VOXEL_ROTATION_SHIFT=14 / VOXEL_TYPE_MASK`：体素值是一个打包 uint16（类型+旋转+），AI 若按"方块 id"直接写会写出非法旋转位 | |

### 1.3 代码编写

| 子问 | 答 | 证据 |
|---|---|---|
| 作者脚本在项目里的物理位置？ | **不是文件，是 blob**。脚本名→资产项在 `project.assets[name]`（`AssetType.JS_SCRIPT=1 / CLIENT_JS_SCRIPT=7`），值是 `hash` 指向 `source/blobs/<CIDv0>`；共享脚本（地图组级）在 `extraProject.scriptAssets[fileId]`，落在 **group blobRoot** | `internals/schema/project/project-rda.ts:46-64`；写盘证据 `project-manager.js:2083-2084, 2136-2153`；加载 `code-editor-server-controller.ts:679-720`（`initScripts` 按 hash `_retrieve(hash)` 取文本） |
| 入口文件约定 | `scriptIndex` 默认 `'index.js'`（`project-rda.ts:633`）；服务端 `index.js` = CommonJS、客户端 `clientIndex.js`；两者**被排除在共享脚本之外**（保持 map-local） | `project-manager.js:2086-2090`（含原文注释）；`code-editor-server-controller.ts` `_addIndexScripts`；`initScripts` |
| sandbox 加载路径 | `services/game-server/src/utils/script-server/{ivm2,ivmp}/`，`isolated-vm` 只在 `ivm2-script-socket-server.ts:1`、`ivm2-script-interface.ts:1`、`ivmp-vm-controller.ts:5`。三模可切 `local/ivm2/ivmp`（`entry.ts:652-680`）。打包后的 isolate 入口是 `src/assets/isolate/ivm2-script-entry.js`（含整套 schema 拷贝，`storageMode` 默认 `sqlite` 出现在 `:16866`） | 见 path:line |
| 398 个 API 的注入点 | 服务端权威类型源 = `internals/schema/api/js/*.ts`（**15 个 ts 文件**：api/db/gui/anticheat/moderation/motion/player/storage/http/math/error/navigator/rtc/entity/events/…）；构建链 `apps/game/api-tsconfig.json`（include `../../internals/schema/api/**/*.ts`）→ `scripts/assets/api/**/*.d.ts` → `build-server-types.ts:5-23` → `packages/script-api/dts/box3-server-api.d.ts`（4603 行）；编辑器实际用的 Monaco lib 是另一份 `apps/game/src/resource/api-declarations.dts`（**13 804 行**） | 实测 `ls internals/schema/api/js`（15 项）、`wc -l` 两个 dts |
| 运行时注入实现 | `internals/schema/api` 的类型被 `script/bindings/api.ts` + `bindings/*.ts` 落地成 isolate 内的全局（`world/entity/console/storage/…` 共 9 个全局，与 §3.4 一致） | `services/game-server/src/script/bindings/api.ts`、`binding-factory.ts` |
| 已有 headless 写入口？ | **有，且完整**：`PUT /api/creator/v1/projects/{projectId}/scripts/{side}/{entry}`（scope `scripts.update`）→ `writeCreatorProjectScript` → `manager.updateProjectScript`（**纯磁盘，不开运行时也能写**，会推进 `branch.headHash → permissionHash → project-state.json`）；读 `GET` 同路径（`scripts.read`）；列 `GET …/scripts`（`listProjectSharedScripts`） | `pages/api/creator/v1/projects/[projectId]/scripts/[side]/[entry].ts:16,22,35-49`；`packages/cli/src/index.ts:37-45,93-106`；`project-manager.js:2056-2189` |
| 能否离线校验类型？ | **能，仓库里已有一个可跑的机器判定器**：`apps/game/scripts/check-editor-types.ts` 用 `ts.createLanguageService`（Monaco 同款语言服务，`:21-34`）在内存里注入声明、对 20+ 段真实作者代码断言 `diagnostics().length===0` 与反向断言（`:65-99`），并同时校验两套库：编辑器组合 `{api.d.ts, server-api.d.ts}` 与独立 SDK `{box3-server-api.d.ts}`（`:57-60`），客户端库单独校验（`:108-117`）。**这就是 AI 的类型门** | 同上 |
| 内置 AI 的代码上下文从哪来？ | `services/game-server/src/edit/ai/llm-context.d.ts`（1533 行）由 `apps/game/scripts/build-llm-context.ts` 生成（跑 `tsconfig.llm-api.json` → 拼 d.ts → 写进 game-server 源码树） | `build-llm-context.ts:8-12,38,41` |

### 1.4 发布与上线（五个端点的实际路由与鉴权代码）

| 端点 | 路由文件 | 鉴权调用 | 所需能力 | 底层实现 |
|---|---|---|---|---|
| create | `apps/game/pages/api/local-projects/index.ts` | `:7 allowAuthenticatedCreatorApi(req,res,'projects.create')` | 用户级 `projects.create` | `project-manager.js:1079-1143 createProject`（纯文件系统：建目录 + `copyRuntimeData`/`copyReadableDirectorySync` + 写 `project.json`，含 `permanentMapId`、`mapSize`、`templateId:'blank'`、`terrainTheme`） |
| publish | `pages/api/local-projects/[id]/publish.ts` | `:37` `projects.edit` | 同上 | 先 `flushActiveEditor()`（`:5-35`，POST `…/internal/save-local-project`），再 `manager.publishMapGroup`（`project-manager.js:2475`） |
| export | `pages/api/local-projects/[id]/export.ts` | `:8` `projects.export`（`?scope=map\|group`） | | `manager.exportProject`（`project-manager.js:1357`）→ 临时 tar.gz 流式下载后 `fs.rmSync` |
| package（游玩包） | `pages/api/local-projects/[id]/package.ts` | `:15` `projects.export` | | `manager.exportPlayBundle(id@version,{assetMode:'local'\|'oss'})`（`project-manager.js:2746-2830+`）→ `.boxplay` = `bundle.json` + `worlds/<memberId>/`，`Content-Disposition: world.boxplay` |
| play-import | `pages/api/play-admin/import.ts` | **`:27 allowPlayLibraryAdmin(req,res)`** | **不是 Cookie：`Authorization: Bearer $BOX_PLAY_ADMIN_TOKEN`** | `importPlayBundle` / `createPlayBundleReview` / `confirmPlayBundleReview`（`apps/game/server/play-admin.ts:718,762,770,777,787`） |
| （附）snapshots | `pages/api/local-projects/[id]/snapshots.ts:6` | GET `projects.view` / POST `projects.edit` | | `listProjectSnapshots` `project-manager.js:813`、`restoreProjectSnapshot` `:829` |
| （附）runtime 控制 | `pages/api/local-projects/[id]/runtime.ts:36` | `projects.edit`/`projects.view` | | 转发 `http://127.0.0.1:{9966\|9967}/<id>/__local_runtime/{start,status}`（`:10-33`） |

**鉴权三闸门**（全部 path:line）：
1. `creator-api-security.ts:38-73 allowCreatorApi`：`BOX_DEPLOYMENT_MODE!=='creator'` → **404**；Host 必须 ∈ `{localhost,127.0.0.1,::1} ∪ BOX_CREATOR_ALLOWED_HOSTS`；`sec-fetch-site==='cross-site'` → 403；有 `Origin` 则必须同源。**没有 Origin 头的纯 HTTP 客户端（curl/MCP）天然通过**（`:59-70`）。
2. `authenticatedCreatorIdentity` `:88-118` → `resolvePlayerServiceIdentity` → `identity.creatorAccess` 必须 true（`:100-103`）→ `hasCreatorCapability(identity.creatorPermissions, cap)`（`:104-108`）。
3. `allowAuthenticatedCreatorCliApi` `:125-154` → 同样要求 `creatorAccess`，但查的是 `identity.creatorCliPermissions?.includes(capability)`（`:141`）。

---

## 2. 鉴权攻坚：CLI Token 的 9 项能力与最小扩权方案

### 2.1 能力清单（穷举，共 9 项）

`apps/game/shared/creator-cli-policy.ts:5-15`：
`projects.list`、`resources.list`、`scripts.read`、`scripts.update`、`storage.read`、`storage.write`、`runtime.view`、`runtime.control`、`scene.capture`。
中文名/说明/分组在 `:24-34`。归一化白名单 `normalizeCreatorCliCapabilities` `:37-41`（**不在数组里的字符串一律丢弃**）。
另一族是 UI 权限 `shared/creator-policy.ts:2-6`：`projects.view/create/edit/delete/import/export` + `models.manage`（7 项），`hasCreatorCapability` `:25-27` 把 `projects.view` 当隐含权限。

### 2.2 签发链（全部 path:line）

| 步骤 | 位置 |
|---|---|
| 表结构 `creator_cli_tokens(id, principal_id, name, token_hash, scopes TEXT[], created_at, last_used_at, last_used_ip, revoked_at, revoked_by)` | `apps/game/server/local-player-identity.ts:446-459`，索引 `:461-463` |
| 校验入参（zod 枚举 9 项，`.max(32)` 去重） | `apps/game/server/player-admin-validation.ts:102-110`，命令 `:156-158`（create/update/revoke-cli-token） |
| 签发：`bxc_<9字节hex>_<32字节base64url>`，存 `HMAC-SHA256(identitySecret, token)`，明文只在响应里出现一次；要求目标账号 `status==='active'` 且 `creator_access===true` | `local-player-identity.ts:1932-1958`（`:1949-1951` 生成与哈希，`:1943-1948` 前置校验，`:1956` 审计 `creator.cli-token.create`） |
| 轮换/撤销 | `:1973-1995 updateCreatorCliToken`、`:1960-1971 revokeCreatorCliToken`、`:1914-1930 listCreatorCliTokens` |
| **硬依赖**：以上全部 `if (!database) throw new Error('玩家管理需要配置 PostgreSQL')` | `:1916, 1938, 1962, 1980, 1986`；开关 `isPlayerDatabaseEnabled()` `:832-834` = `Boolean(BOX_DATABASE_URL)` |
| 校验：`Bearer` → HMAC → 查 `token_hash` 且 `revoked_at IS NULL` → JOIN principals/users → `row.creator_cli_permissions = normalizeCreatorCliCapabilities(row.scopes)` → 更新 `last_used_at/ip` | `:912-937`（`:919` 哈希，`:923` **同时 SELECT `u.creator_permissions`**，`:934` 覆盖 CLI 权限，`:935` 记账） |
| 谁决定走 token 还是走 Cookie | `pages/api/player-internal/runtime-identity.ts:12`（仅 `BOX_DEPLOYMENT_MODE==='player-service'`）、`:17-19`（内部 Bearer = `identitySecret()`，`:592-596`）、`:21-24`（**有 `X-Box-Creator-Authorization: Bearer ` 就走 CLI，否则走 `resolvePlayerIdentity`(Cookie)**） |
| 谁转发这个头 | `apps/game/server/player-service-client.ts:80-92`，具体 `:87-89` |

### 2.3 关键发现：五个端点并非"只认 Cookie"

**读码结论（源码级确证，端到端仍需一次带真 token 的实测才能算绿）**：
`resolvePlayerServiceIdentity` 对**所有** Creator 路由都会把请求的 `Authorization: Bearer …` 原样转成 `X-Box-Creator-Authorization`（`player-service-client.ts:87-89`），player-service 端优先按 CLI token 解析（`runtime-identity.ts:21-24`）。返回的 identity 里 **`creatorPermissions` 是用户行的 `u.creator_permissions`**（`local-player-identity.ts:923`），而 `authenticatedCreatorIdentity` 判的就是它（`creator-api-security.ts:105`）。
→ 因此**任意 9-scope 的合法 CLI Token，只要该账号有 `projects.edit/create/export/import`，就能直接打通 create/publish/export/package/import 五个"浏览器端点"**。`creatorCliPermissions` 在这五条路由上根本没被查。

现网只读反证（无凭据探针，`curl -X POST -H 'Authorization: Bearer bxc_test_test'`）：
- `POST /api/local-projects/nope/publish` → `401 {"code":"AUTH_REQUIRED","message":"请先注册或登录账号"}` ← 这是 `creator-api-security.ts:112` 的**浏览器路径**文案，说明请求确实进到了 Bearer 解析分支；
- `GET /api/creator/v1/projects` → `401 {"code":"AUTH_REQUIRED","message":"CLI Token 无效或已撤销"}` ← `:147` 的 CLI 文案。
两条不同文案互证：同一身份链、两个不同判定门。

### 2.4 那么"最小扩权"到底要扩什么？

| # | 需求 | 今天能做？ | 最小改法（半径） |
|---|---|---|---|
| 1 | headless create/publish/export/package/import | **能（借道上表 §2.3）** | **0 行**，但要显式化：把这 5 条路由改成 `allowAuthenticatedCreatorCliApi(req,res,'projects.manage') \|\| allowAuthenticatedCreatorApi(...)`，即新增 1 个 CLI capability `projects.manage`（`creator-cli-policy.ts:5-15` 加 1 项 + `:24-34` 加 meta + 5 个路由各 1 行），**顺带修掉 §2.5 的越权** |
| 2 | headless 快照/回滚 | 不能（`local-projects/[id]/snapshots.ts:6` 走 Cookie） | 新增 scope `projects.snapshot`（或复用 `projects.manage`），路由加 1 行 |
| 3 | headless **地形写入** | **不能** | 见改造项 R1（必须新增服务端工具，无鉴权捷径可走） |
| 4 | headless **UI 树/交互写入** | **不能** | 同 R1 |
| 5 | headless **资源/模型导入** | 半能：`/api/project-models` 无鉴权但只接本地 voxa；`/api/creator-models/import` 走 Cookie | 新增 scope `models.import`；或把运行时侧补上 `localOnly`（见 R4） |
| 6 | headless **进图验证（模拟玩家）** | **不能**（websocket `/createSession` 需要 player-service 签发的 runtime identity token） | 见 §4，用 `runtime.control` + `runtime.events` + `scene.capture` 组合近似，或新增 `runtime.simulateJoin` scope |

**鉴权侧最少改动量估计：1 个 capability + 5 处路由 1 行 + 1 处 zod 枚举（自动来自数组）≈ 20 行，不含新工具。**

### 2.5 照实列出的危险/异常分支（鉴权与存储）

| 风险 | 证据 | 影响 |
|---|---|---|
| **CLI Token 绕过 scope 矩阵**：任意 scope 的 token 都能行使全部 UI 级 `creatorPermissions` | `creator-api-security.ts:105`（查 creatorPermissions）vs `:141`（查 creatorCliPermissions）；`local-player-identity.ts:923` SELECT 带 `u.creator_permissions` | 9 项 scope 的"最小权限"承诺在这 5 条路由上不成立；AI 拿一个 `projects.list` 的只读 token 也能发布/删图（`projects.delete`） |
| `pg → sqlite` 静默降级 | `services/game-server/src/entry.ts:686-688`：`if (storageMode === 'pg') { prebake.coldProject.storageMode = storageMode = 'sqlite'; }`（注释只写 *"try to migrate database"*，无 warn/log） | 作者脚本声明用 PG 的数据语义被静默换成 SQLite；AI 写完"数据能跑"是假信号 |
| `local-projects/[id]/publish.ts:31` 把 `ECONNREFUSED` **当正常**（注释："No edit runtime is normal …"） | `pages/api/local-projects/[id]/publish.ts:26-33` | 运行时挂了/网络不可达时发布的是**磁盘旧态**，AI 会以为"改了但没生效"；只捕 ECONNREFUSED，其它错误码（403/500）会抛 |
| `createServer.ts:557` 之后所有 `/internal/*` 都是 **loopback-only 且无 token**；而 `/api/project-models`、`/api/project-scripts`、`/api/project-skins` **三个写路由没有 `localOnly` 校验**（对照 `:568/599/609` 有） | `createServer.ts:558-566`（localOnly 定义）、`:652`、`:830`、`:859`（三处无 gate） | 同 docker 网络内任何容器可改工程资产/共享脚本；端口 9966/9967 目前只绑 127.0.0.1（实测 `docker ps`），**靠宿主端口映射侥幸兜住** |
| **loopback 校验与 Docker 化运行时互斥（推断，需实测）** | 运行时上游是容器 IP：`apps/server-manager-rust/src/runtime/runtime.rs:126-138 runtime_container_address()`（`docker inspect .IPAddress`）、`:430-431` 返回 `{hostname, port:9966}`；`apps/local-engine/src/runtime-upstream.js:8-9` 用它做 proxy target；而 `createServer.ts:609-619` 要求 `req.socket.remoteAddress ∈ {127.0.0.1,::1}` | 经 edit-library 代理进运行时的 `/internal/save-local-project` 源地址是 docker 桥 IP → **理论上 403**。当前 `docker ps -a` 无运行时容器，无法在不产生变更的前提下实测 → 标 UNVERIFIED（U1），但它直接决定 MCP 的落盘方式 |
| 内置 AI 在本地引擎默认**跑不起来** | `services/game-server/config/server.ts:46-48` `AI_MODEL_MAPPING` 默认 `undefined` → `ai-server.ts:336-340` `this.modelMapping[model]` 抛 TypeError；`OPENROUTER_API_KEY` 在现网 creator 容器 env **不存在**（实测 env 名单，见 §9 附录 B）；`edit-server.ts:91` 传入 | 好消息：**工具层与 LLM 无关，MCP 可单独复用**（`entity-tools.ts` 的 `createEntityTools(replica, state, gameId, logger)` 只需 replica/state/logger） |
| `addModelToProject` 有 `inputSchema` **无 `execute`** | `entity-tools.ts:676-683` | 该工具在服务端永不落地（AI SDK 语义 = 交给客户端执行）；AI 会"以为加了模型" |
| `searchPublicModels` 硬编码返回空 | `entity-tools.ts:662-673`（`'Public model search is unavailable in the local engine.'`） | 同上，AI 必须走本地 voxa 库 |
| 体素写序列校验是 TODO | `src/edit/replica/validate/validate-voxel-action.ts:1-13`（`// TODO` 后直接 `return true`） | 唯一约束是 `permissions.editVoxels`；AI 批量刷体素无任何合法性检查（可越界、可写水/空气刷爆） |
| `checkProjectActionSequence` 禁 `voxels` 类动作 | `validate-project-action.ts:14-21` | 客户端**不能**通过 project 动作改地形，地形只能走 VoxelProtocol → 说明"地形没有可复用的 project 级写入口"是设计使然，不是漏写 |

---

## 3. MCP 服务器工具面设计

### 3.1 形态选型

**MCP 服务器 = 一个薄的 TypeScript 进程（Node），对上游是 stdio/HTTP MCP，对下游只打两类接口：**
- **A 类 · 引擎 HTTP**：Creator `http://127.0.0.1:3127/api/creator/v1/*`（Bearer `bxc_…`）+ Play `http://127.0.0.1:80/api/play-admin/*`（Bearer `$BOX_PLAY_ADMIN_TOKEN`）。
- **B 类 · 盘侧直写（可选、需开关）**：`@box/build-system` + `@box/schema` + `@box/content-server` 纯函数（`storeProjectJSON`/`retrieveProject`/`saveVoxelData`/`storeReleaseBlob` 同套 CIDv0 逻辑），在**工程目录空闲（无编辑运行时）**时直写 blob + `project-state.json`。

不选 mudb websocket 客户端做主通道：它需要 player-service 签发的 runtime identity（`createServer.ts:326-344`，`BOX_PLAYER_SERVICE_INTERNAL_URL` 存在时 token 无效即抛 `Invalid or expired local player identity`），且 loopback 内部路由与容器化运行时可能互斥（U1）。

### 3.2 工具清单（分层：读 → 改 → 验 → 发）

**图例**：`R`=只读 `W`=写 `I`=幂等 `NI`=非幂等 `DRY`=支持 dry-run `SNAP`=写前自动快照

#### L1 读（首版即可交付，0 处引擎改动）

| 工具 | 入参 | 出参 | 副作用 | 幂等 | dry-run | 后端 |
|---|---|---|---|---|---|---|
| `map_list` | – | `{projects:[{permanentMapId,name,status,mapRole,updatedAt}]}` | 无 | I | – | `GET /creator/v1/projects`（`projects.list`） |
| `map_resources` | `mapId` | 模型/图片/音频/UI 资源清单 | 无 | I | – | `GET …/resources`（`resources.list`） |
| `script_list` | `mapId` | `{scripts:[{id,name,isClient,order}]}` | 无 | I | – | `GET …/scripts`（`scripts.read`） |
| `script_read` | `mapId,side,entry` | `{content,hash,shared}` | 无 | I | – | `GET …/scripts/{side}/{entry}` |
| `data_read` | `mapId,scope,space,key?,page?,limit?` | 单值或分页键列表 | 无 | I | – | `GET …/storage/{scope}/{space}` |
| `runtime_status` | `mapId` | `{phase,running,message,updatedAt}` | 无（编辑库明确不分配运行时，`edit-library.js:345-360`） | I | – | `GET …/runtime` |
| `runtime_events_tail` | `mapId,sinceEventId?` | SSE 事件序列（`log/exception/clear/status`，缓冲 500 条、单条 16 KiB） | 无 | I | – | `GET …/runtime/events`（`creator-preview-runtime.ts:18-19,126-131`） |
| `scene_screenshot` | `mapId,view=full\|3d\|2d` | PNG ≤6 MiB | 无；**要求浏览器编辑器在线并已 `scene.session` 授权** | I | – | `GET …/scene/capture` |
| `engine_health` | – | `{apiVersion,engineVersion,deploymentMode,…}` | 无 | I | – | `GET /creator/v1/health`（**无需鉴权**） |
| `contract_describe`（新增，纯本地） | `side?,filter?` | 398/12/客户端 32 个可调用签名 + JSDoc | 无 | I | – | 解析 `packages/script-api/dts/*.dts` + `internals/apis/openapi/openapi.json` |

#### L2 改（AI 写工程）

| 工具 | 入参 | 出参 | 副作用 | 幂等 | dry-run | SNAP | 今天可行？ |
|---|---|---|---|---|---|---|---|
| `script_write` | `mapId,side,entry,content,expectedRevision?` | `{hash,revision,shared}` | 写 blob + 推 `branch.headHash` + 改 `project-state.json`；非 index 会 bump group `revision` | I（同内容同 hash，CIDv0 天然去重） | 可（只算 hash） | 建议（`projects.snapshot`） | **是**（`scripts.update`）；`expectedRevision` 缺失 = 目前**无 CAS**（`project-manager.js:2079-2081,2187` 只读不比对）→ 需在 MCP 侧加乐观锁 |
| `data_write` / `data_delete` | `mapId,scope,space,key,value`(≤4 MiB JSON) | `{item}` | 写数据空间 | I | 否 | 否 | **是**（`storage.write`，`storage/[scope]/[space].ts:67-101`） |
| `map_create` | `id,name,mapSize,templateId` | `{project}` | 建目录 + 拷模板 | NI（同名报 `Project already exists` `:1084`） | 可（校验 `assertProjectId`/`publicMapIdExists`） | – | 借道 §2.3（Cookie 路由 + Bearer） |
| `entity_upsert` / `entity_delete` / `entity_move` | 见 `entity-tools.ts:256-276,323-327,470-478` | `{entityId,success}` | **改运行时内存态**，须再 `project_save` 落盘 | NI（随机 id `Math.random`，`:284`） | 需新加 | 是 | **否 → R1** |
| `terrain_apply`（新） | `mapId,{op:'set\|fill\|box\|sphere\|heightmap\|noise', region, block, blend?}` 或 `runs:[{x,y,z,b}]` | `{changedChunks,voxelInfo}` | 写 chunk blob → `project.voxels` | NI | 必须（返回 diff 不落盘） | 是 | **否 → R1** |
| `terrain_read`（新） | `mapId,region` | 体素数组 / 高度图 / chunk hash 列表 | 无 | I | – | – | 半能（盘侧 `box-decode`）→ R1 |
| `ui_upsert`（新） | `mapId,{screenId,node:{type:'screen'\|'element',data:box\|image\|text\|scrollBox\|input,layout,coord}}` | `{nodeId,treeHash}` | 改 `uiTree` blob | NI | 必须 | 是 | **否 → R1** |
| `interaction_configure`（新） | `mapId,{zones?\|collisionFilter?\|gamepad?\|player?\|environment?\|physics?}` | `{changed:[…]}` | 改对应 RDA 子树 | I（整体 set 语义） | 必须 | 是 | **否 → R1**（字段名唯一来源：`project-rda.ts:395-649` + `hot-schema.ts:139-184`） |
| `block_info_read`（新） | `mapId?` | `{names[],ids[]}` 方块表（**AI 必须用它把方块名换成 id，且注意 uint16 打包位**） | 无 | I | – | – | 盘侧可读（`BLOCK_INFO_RES` `project-init.ts:152-162`；打包位 `voxel-protocol.ts:14-15`） |
| `map_delete` | `mapId` | `{deleted}` | 删工程 | NI | 必须 | 前置强制 | 借道 Cookie（`projects.delete`）→ **首版不暴露** |

#### L3 验（见 §4）

| 工具 | 入参 | 出参 | 备注 |
|---|---|---|---|
| `script_typecheck` | `side,content` | `{errors:[{line,col,code,message}],satisfied:bool}` | 直接用 `check-editor-types.ts:12-54` 的 `ScriptTypeProbe`（同一语言服务，零猜测） |
| `project_validate` | `mapId` | `{ok, problems[], version, migrationRequired}` | `validateProjectSource`（`project-manager.js:696-722`）+ `scanProjectCompatibility`（`:2412` 产出 `compatibility.json`）+ `retrieveProject` 版本迁移检查（`project-serialize.ts:120-141`） |
| `preview_start` / `preview_stop` | `mapId` | `{phase,running}` | `POST …/runtime`（`runtime.control`）；`creator-preview-runtime.ts:72-84` |
| `server_eval`（新，最高价值） | `mapId,expr` | `{ok,value\|error}` | 复用 `state.game.script.scriptEval(expr)`（`debugger-server.ts:52-73`）；权限 `permissions.permissions.debugger`（`:19-22`）。AI 可用它断言 `world.queryAll("*").length`、体素高度、脚本是否真的注册了 `onPlayerJoin` |
| `scene_screenshot` | 同上 L1 | 视觉判定输入 | 需浏览器在场 |

#### L4 发

| 工具 | 入参 | 出参 | 幂等 | 今天可行 |
|---|---|---|---|---|
| `project_save` | `mapId` | `{permissionHash}` | I（hash 不变即空操作） | **有条件**：`POST /internal/save-local-project`（loopback-only `createServer.ts:609-619`）；U1 未决 |
| `map_publish` | `mapId,version,notes` | `{release,compatibility}` | NI（`Release already exists` `:2427-2429`） | 借道 §2.3 |
| `bundle_export` | `mapId,version,assetMode` | `.boxplay` 字节/落地路径 | I（同 release 同产物） | 借道 §2.3 |
| `server_import` | `.boxplay`,`mode=preview` → `{reviewId}` → `confirm` | `{worlds[]}` | NI | **是**（Bearer，`play-admin/import.ts:27,53-59,80-90`） |
| `server_open` | `worldId,playEnabled` | `{worlds}` | I | **是**（`play-admin/worlds/[id].ts:8-18` + `play-admin.ts:889`） |
| `snapshot_list` / `snapshot_restore` | `mapId,snapshot?` | 列表 / `{recovery,project}` | restore NI（且自动 `before-restore` 快照 `:854`） | Cookie → 需加 scope（`local-projects/[id]/snapshots.ts:6`） |

### 3.3 调用顺序（AI 的固定剧本）

```
读:  engine_health → map_list → contract_describe → script_list/read → terrain_read → block_info_read
改:  snapshot_create(前置) → terrain_apply(dry) → [AI 看 dry diff + scene_screenshot] → terrain_apply(commit)
     → entity_upsert* / ui_upsert* / interaction_configure → script_write(expectedRevision)
验:  script_typecheck(每条脚本) → project_validate(版本/闭包/兼容) → preview_start
     → runtime_events_tail(断言无 exception 事件) → server_eval(不变量断言) → scene_screenshot
     → preview_stop(必须，否则 saveProject 不记录 voxel chunk：replica-server.ts:1602)
发:  project_save → map_publish → bundle_export → server_import(preview→confirm) → server_open
回:  任一步失败 → snapshot_restore(或 git-like: 把 branch.headHash 写回上一版)
```

### 3.4 安全模型（AI 误操作如何回滚）

| 层 | 机制 | 是否已存在 | 证据 |
|---|---|---|---|
| L0 事务原子性 | `RDATransaction` 记录 forward+**inverse** 动作，`store.inverse()` 天然可回滚 | **已存在** | `src/edit/replica/transaction/transaction.ts:14-46`；`_rollbackProject/_rollbackVoxel/_rollbackPermissions` `replica-server.ts:1227-1297`（体素回滚靠读回原值 `:1269`） |
| L1 工程级快照 | `createProjectSnapshot(id,reason)` → `.snapshots/<ts>-<reason>-<sha256(state)[0:16]>.tar.gz`，**上限 5 个**（`snapshotLimit=5`），内容签名去重（同 state 不重复打） | **已存在** | `project-manager.js:746-794`、`:30`、`snapshotRoot` `:738`、`parseSnapshotInfo` `:796-811` |
| L2 回滚 | `restoreProjectSnapshot`：解包→`validateProjectSource`→**先自动打 `before-restore` 快照**→`renameSync` 原子换 `source`，失败留 `.restore-backup-<pid>-<ts>`；同卷 staging 避 EXDEV | **已存在，且做得很稳** | `project-manager.js:829-880`（`:854`、`:855-857`、注释 `:839-843`） |
| L3 版本/分支 | `permission.versionControl.{branches{headHash}, currentBranch}`；服务端 `createBranch/switchBranch`（存盘后改分支） | **已存在，但 HTTP 面未暴露** | `project-manager.js:2074-2081, 2176-2186`；`replica-server.ts:2703-2726`；UI 侧仅 `EditorTab.VersionControl`（`edit/schema.ts:35`）→ 改造项 R2 |
| L4 发布不可变 | `releases/<version>` 原子 rename、`immutable:true`、失败清 tmp | 已存在 | `project-manager.js:2453-2468` |
| L5 上服可回退 | 游玩库按目录隔离，`deletePlayWorld` 删主图连带副图 | 已存在 | `play-admin.ts:796-817` |
| **缺口** | ① **写前自动快照**只在 `publish`（`:2417`）与 `launch`（`:2562`）、`before-restore`（`:854`）触发，**外部工具写 blob 前无人打快照**；② **无 CAS/乐观锁**（`updateProjectScript` 不校验调用方给的 revision）；③ `snapshotLimit=5` 对 AI 高频写太少；④ `createProjectSnapshot` 依赖 `spawnSync tar`（`:770-773` → `:1238`），与冷启动同步 tar 同源，AI 每步都快照会把 tar 打成主耗时 | | |

**MCP 侧必须实现的护栏（引擎 0 改动即可）**：
1. `dryRun` 默认 true，写类工具无 `confirm` 参数一律拒绝执行；
2. 任何 `W` 工具执行前**强制** `snapshot_create`（走已有 `createProjectSnapshot`），并记录返回的 `permissionHash` 作为 revision token；
3. 写类工具串行化（单实例互斥），且工程处于"运行时未打开"状态才允许 B 类盘侧直写；检测到运行时活跃时**只允许走 A 类协议/内部路由**；
4. 每步把 `expectedRevision` 与盘上 `branch.headHash` 比对，不等则中止（弥补无 CAS）；
5. 永不注册 `map_delete` / `projects.delete` / 封禁类（`play-admin/players/*`）到默认 profile，放独立 profile + 人工确认。

---

## 4. AI 自动验收闭环（可机器判定）

### 4.1 判定层次与对应实现

| 层 | 判据（可断言） | 用什么跑 | 证据 |
|---|---|---|---|
| **V0 语法** | `tsc` 解析 + `check-editor-types.ts` 的 `diagnostics()==0`；反向断言"非法 API 必须报错"（如 `world.anticheat.createTracker()` 在客户端应 0 允许，`:115`） | MCP `script_typecheck`（复用现成 probe） | `apps/game/scripts/check-editor-types.ts:12-54,57-117` |
| **V1 结构** | `project-state.json` 可读、`blobs` 目录存在、`permissionHash` 可达、引用闭包无缺块 | `validateProjectSource`（`project-manager.js:696-722`，缺 blobs 直接进 `problems`）+ `getReachableProjectHashes`（`:396-414`）+ `retrieveProject` 版本断言（`project-serialize.ts:114-141`，type!=='project' 抛错、版本不符跑 migration、**无 migration 则抛**） | |
| **V2 运行时可加载** | 启动后 `runtime_events_tail` 中**无 `type:'exception'`**（含 `message` 与结构化 `stack`，区分 `side:server/client`）；`MODULE_NOT_FOUND` 归到 exception 事件里，可 grep `message.includes('MODULE_NOT_FOUND')` | `creator-preview-runtime.ts` 缓冲 500 条 + `Last-Event-ID` 重放（`:96-104`）；事件源 `debugger-server.ts:8-11,80-83,94-101` 订阅 `scriptServer.onException` | |
| **V3 世界真的活着** | `preview_start` → `phase:'ready'`（`running===true`）→ `server_eval` 断言：`world.queryAll("*").length>0`、出生点体素非空、地形高度分布在阈值内、`world.storage` 可读 | `runtime.control`（`creator/v1/.../runtime` POST）+ `startProject/stopProject`（`replica-server.ts:2543,2609`）+ `scriptEval`（`debugger-server.ts:52-73`） | |
| **V4 进图脚本真的触发** | `onPlayerJoin` 通道有订阅且触发（`world-synchronizer.ts:116,188,505-506`） | **今天缺一个 headless 进图器**。可行替代：(a) `server_eval` 手工派发 join 事件；(b) 用 `runtime.events` 观察现有真实玩家；(c) 新增 `runtime.simulateJoin` scope（改造项 R3） | |
| **V5 视觉/观感** | `scene_screenshot` PNG（`full\|3d\|2d`，6 MiB 上限）→ 交给多模态判定"地形是否成形/按钮是否在位" | `creator/v1/.../scene/capture`（**要求浏览器编辑器在场并已 `scene.session` 授权**：`creator-scene-session.ts:111-125`，无会话 409，超时 25 s `:4,117-120`） | |
| **V6 发布链** | `map_publish` 返回 `compatibility`（`scanProjectCompatibility` 产物 `compatibility.json`，`project-manager.js:2412-2413`）；`bundle_export` 有 `.boxplay`；`server_import(mode=preview)` 给出 review 资源清单，`mode=confirm` 成功；`server_open` 后 `play-admin/worlds/status` 正常 | `play-admin.ts:718-795,889` | |

### 4.2 闭环形态（写死进 MCP）

```
for attempt in 1..N:
  生成/修补 → V0(类型)  失败→ 带 diagnostics 回喂模型，重试
            → V1(结构)  失败→ 回滚到本轮快照，重试
            → V2(加载)  有 exception/MODULE_NOT_FOUND → 定位 stack 帧→文件→行，回喂
            → V3(不变量 server_eval 断言集)  不满足 → 读 terrain_read 实际值修正
            → V5(截图)  观感不合规 → 调参重试
  全绿 → preview_stop → project_save → V1 再跑一次（确保落盘后的 hash 闭包完整）
```
关键约束（必须写进 MCP 而不是靠 AI 记）：**V3→V2→stop→save 的顺序不可颠倒**，因为 `replica-server.ts:1602` 在 `running` 时不记录体素 chunk；且 `saveProject` 与浏览器自动保存竞争同一信号量（`:1573`），所以**验收期间禁止浏览器打开同一工程**。

### 4.3 与 G3 / G4 / G9 的关系

| 门 | 定义（`box3-re/impl/GATES.md:36`、`ANALYSIS-AND-PLAN.md:158-159`） | 本文贡献 |
|---|---|---|
| **G3 功能** | 现存「起床战争」`cloud-4e84ee7ef626058f-imported` 导入→开放→浏览器进图→脚本 `onPlayerJoin` 触发 | §4.1 的 V2/V3/V4 就是 G3 的**自动化版本**；G3 的人工"浏览器进图"可被 `server_eval` + `runtime_events_tail` 替代（V4 仍需 R3 才能完全无人）。现网只读确认该工程目录存在 |
| **G4 契约** | 398 个服务端可调用全部有实现；独立 `box3-pack` 生成的 `.boxplay` 能被出厂 reader 接受 | §4.1 V0（`contract_describe` + `script_typecheck` 拿这 398 面喂类型门）+ V1（出厂 `retrieveProject` 做严格校验：type 断言 + 版本迁移断言，`project-serialize.ts:114-141`）→ **G4 的第二半可直接用"我生成的包能否被 `retrieveProject` 读回且 hash 闭包无缺块"来判** |
| **G9 headless** | AI/MCP 链路可 headless 跑通 | **状态应从 `未` 改判为 `部分`**：`scripts.*`/`storage.*`/`runtime.*` 已绿（`creator-cli-policy.ts:5-15` + 路由实测 200/401 一致）；`play-admin` 全链已绿（Bearer，`play-admin-security.ts:23-26`）；`create/publish/export/package` 借 `X-Box-Creator-Authorization` 通道**可达**（§2.3，需一次带真 token 实测）；**唯 `terrain` 与 `ui/interaction` 是真绿不了**（R1） |

---

## 5. 兼容性护栏（用户硬性要求 #3：不得破坏原有地图支持与功能）

### 5.1 契约冻结策略（398 面）

1. **冻结基线落盘**：`packages/script-api/dts/box3-server-api.d.ts`(4603 行) + `apps/game/src/resource/api-declarations.dts`(13 804 行) + `dts/{client,server}-api-types.dts`(546/1020 行) 全部纳入指纹；任何改动必须产 diff 报告（**可调用数、属性数、9 个全局名单**）。
2. **只增不改不删**：新 API 只能加在 `internals/schema/api/js/*.ts`（15 文件，真正的类型源，`api-tsconfig.json` include `../../internals/schema/api/**/*.ts`）；改签名 = 破坏性变更，需 G4 全绿 + 旧图回归。
3. **机器门即回归门**：`check-editor-types.ts` 已经是"断言式契约测试"（既断言有、也断言无，如 `:77` `!methods.includes('mapId')`、`:82` `!options.includes('scope')`、`:66-72` 只读性反向断言）。**接入 CI，任何 398 面破坏性变更都会在这里红**，这是最低成本的冻结手段，且仓库已有、无需新写。
4. **AI 侧硬约束**：MCP 的 `script_write` 在落盘前**必须**过 `script_typecheck`；模型不许凭记忆调 API，只能用 `contract_describe` 返回的签名（见 5.3 对 DTS 断链的补救）。

### 5.2 旧图加载兼容测试点（每条都要有 path:line 依据）

| # | 测试点 | 依据 |
|---|---|---|
| C1 | **版本迁移链不断**：旧 project JSON 的 `version` ≠ `0.3.31` 时必须能跑 `buildMigrate` 到新 hash；**没有对应 migration 会抛带脏话的错误**（原文全大写 *"DID YOU REMEMBER TO WRITE A MIGRATION…"*）。AI 若自造 project JSON 写了错误 version，旧图会被这条直接打死 | `internals/build-system/project/project-serialize.ts:120-141`；`CURRENT_VERSION` 来自 `ProjectRDA.stateSchema.identity.version`（`project-rda.ts:614`）；迁移样例 `internals/build-system/tasks/migrations/project-0.3.7.ts:7-13`（该迁移会把 `storageMode` 强设 `sqlite`，`:10`） |
| C2 | `rawJSON.type !== 'project'` 直接抛 → AI 生成的 root JSON 必须保留 `type:'project'`（`MuRDAConstant`，`project-rda.ts:613`） | `project-serialize.ts:114-119` |
| C3 | **可选子资源向后兼容**：`uiTree/audioAssets/pictureAssets` 在 `retrieveProject` 里是 `rawJSON.x ? retrieve : undefined`（`:170-176`）→ 老图可以没有 UI 树；`zones` 存盘时 `rawJSON.zones \|\| []`（`:83`）。AI 写这些字段时**不能假定它们存在** | `project-serialize.ts:83,170-176` |
| C4 | `uiTree` 默认屏必须保持 `DEFAULT_SCREEN_ID` 常量键（`ui-rda/defs.ts:806,837-866`），否则 `defaultScreenId`（`project-rda.ts:645` 默认值也是该常量）会指向不存在的屏 |
| C5 | **发布前兼容扫描**已在跑：`scanProjectCompatibility(sourceRoot)` → `compatibility.json`（`project-manager.js:2412-2413`），实现在 `src/project-compatibility.js`。AI 产物必须让 `compatibility.ok`，且该文件要进发布产物对比 |
| C6 | **blob 双名形式**都要认：CIDv0（`/Qm[1-9A-HJ-NP-Za-km-z]{44}/g`）、URL-safe SHA-256（43 字符）、legacy UUID —— 漏一种"模型、皮肤、共享脚本会从游玩包里消失"（原文注释） | `project-manager.js:54-60` |
| C7 | **`spawnSync tar -tzf` 的 ENOBUFS 陷阱**：大 blob 图 `tar` 列表输出会撑爆默认缓冲，代码已改为落文件再读；AI 侧任何"包体检"工具沿用旧写法会假失败 | `project-manager.js:1655-1675`（注释在 `:1661-1662`） |
| C8 | **冷启动同步 tar 快照**：`launch` 时会给每个工程打快照（`:2562` → `:770` → `runTar`/`spawnSync tar` `:1238`）；AI 频繁开合工程会把这个变成主耗时。改法见 R5，且改后必须回归"旧图仍能正常 launch + 快照仍能 restore" |
| C9 | **数据面降级**：`entry.ts:686-688` 的 `pg→sqlite` 静默改写会先把老图的数据语义换掉 → G3/G4 回归必须显式断言 `STORAGE_MODE` 实际值与预期一致 |
| C10 | **CLI 能力数组是唯一白名单**：`normalizeCreatorCliCapabilities`（`creator-cli-policy.ts:37-41`）会静默丢弃未知 scope。加 scope 必须同步 `CREATOR_CLI_CAPABILITIES`、`…_META`、以及 UI（`player-admin-validation.ts:102-110` 自动派生），否则签出去的 token 少权限但不报错 |
| C11 | 三个 creator 工程 + 一个真实导入图作为**回归基线集**：现网只读实测目录 = `cloud-3a043df55e5057a5-imported`、`cloud-4e84ee7ef626058f-imported`、`yunhai-xiantu`（`projects` 目录） |

### 5.3 DTS 断链对 AI 的影响与补救

| 事实（逐条实测） | 影响 | 补救（按性价比排序） |
|---|---|---|
| 服务端链**完好可再生**：`internals/schema/api/js/*.ts`(15) → `api-tsconfig.json` → `scripts/assets/api/**` → `build-server-types.ts:5-23` → `box3-server-api.d.ts` | AI 服务端类型可权威再生 | 把 `node apps/game/scripts/build-apis.ts` 接进 CI，产物 hash 入库（`build-apis.ts:20-24` 已 `Promise.all` 传播失败） |
| **客户端链已断**：`client-api-tsconfig.json:7-10` include `src/engine/script/apis/*.ts` → `git ls-files` 0 命中（实测空），真实实现在 `src/engine/script/ses/apis/`（14 项、2 098 行）；`build-apis.ts:22` 仍会跑这半个 tsconfig，只产出 `scripts/assets/client_api/js/common.d.ts`（来自 `internals/schema/api/common.ts`，实测 git 已入库） | AI 写客户端脚本**没有准确类型 → 必瞎写**（这正是需求里"界面按钮/交互"最危险的部分，因为 UI 与输入 API 全在客户端） | ① **一行修断链**：把 include 改成 `src/engine/script/ses/apis/*.ts`（或 `**/*.ts`），恢复 `scripts/assets/client_api`；② 同时启用 `build-llm-context.ts:41` 被注释掉的 `runTsc('client-api-tsconfig.json', …)`，让内置 AI 的系统提示也含客户端 API（当前 `ai-server.ts:70` 直接写 *"Do NOT generate client scripts. The client API is currently not supported."*）；③ 短期不修引擎也能走另一条：`packages/script-api/src/client/{global.ts,modules/*.ts}`（12 模块，含 `ui.ts`）→ `rollup.config.mjs` → `dts/client-api-types.dts`(546 行)，`check-editor-types.ts:108-117` 已在用它做客户端判定 |
| `docs.box3lab.com/api/` 404（`ANALYSIS-AND-PLAN.md:101`）；`packages/script-api/package.json` 里有 `doc`/`wiki` 两条 typedoc 脚本（entry `src/server/global-doc.ts`、`src/client/global.ts`） | 文档站缺失，但**文档可从源码再生** | typedoc 本地生成进包，`contract_describe` 直接读它 |
| `internals/apis/openapi/openapi.json` 的 `info.version` 仍是 `0.2.0`（实测 `node -e`），但**137 个 path 全在里面**，含全部 `/api/creator/v1/*` | 版本字段不可信，**路径与 schema 可信** | MCP 用它做工具生成源；顺手把 `info.version` 绑 `BOX_IMAGE_TAG` |

---

## 6. 最小可落地切片

**目标：不写任何引擎代码（引擎仓只读）、不扩鉴权，2–3 天出一个真能端到端验证的 MCP。**

### 切片 A · `box3-map-mcp`（只读 + 一个写）

工具集（8 个）：
- `engine_health`、`map_list`、`map_resources`、`script_list`、`script_read`、`data_read`、`runtime_status`、`runtime_events_tail` —— 全部映射到**已存在且已鉴权**的 `creator/v1` 端点（scope 全在 9 项内）。
- **唯一写工具 `script_write`**（`scripts.update`），带：`dryRun` 默认、写前取 `branch.headHash` 做 revision 比对（读 `project-state.json→permissionHash→versionControl`，纯只读，逻辑同 `project-manager.js:2074-2081`）、写后回读校验 hash。

端到端可验证的三件事（就是 G9 的第一块真绿）：
1. **AI 全自动改代码**：`map_list` → `script_read` → AI 生成补丁 → `script_write` → 回读 hash 一致 → `script_list` 出现新条目。
2. **AI 全自动判对错（V2）**：`runtime_status` →（人工点一次预览，或用 `runtime.control` 若已授权）→ `runtime_events_tail` 断言**无 `type:'exception'`**、无 `MODULE_NOT_FOUND`，有则把 `stack` 回喂自修。**这一步第一次给出"地图对不对"的机器判据。**
3. **类型门（V0）**：`script_typecheck` 直接调 `apps/game/scripts/check-editor-types.ts` 的 `ScriptTypeProbe`（不改它，只在 MCP 里 import 复用），写盘前先绿。

**明确不做**（因为今天做不到，见 §7）：地形写入、UI/交互写入、无头建图/发布、自动进图。

### 切片 B · `box3-terrain-pack`（离线写地形，纯盘侧）

只在"工程无运行时打开"时工作，全程 `dryRun` 出 diff + `createProjectSnapshot` 前置：
`allocVoxels` → 生成/`setVoxel` → `saveVoxelData`（`terrain/voxel.ts:57-76`）→ 造 `VoxelInfo{shape,chunks}` → 复用 `storeProjectJSON` 的 15-way 拆分（`project-serialize.ts:34-101`）→ 原子改 `project-state.json` 三级 hash 链（照 `project-manager.js:2160-2187` 的既有写法）。
**判据**：`retrieveProject(bs,newHash)` 能读回（含版本/类型断言）+ `getReachableProjectHashes` 闭包无缺块 + `box-decode` 能读回体素 = **G4 后半的等价测试**。
风险：与运行中编辑器不同步（编辑器内存态会覆盖盘），故 MCP 必须硬挡"运行时活跃时禁止盘写"。

### 切片 C · `box3-publish-mcp`（发布链 headless）

`map_create` / `map_publish` / `bundle_export` 走 §2.3 的 Bearer 借道（先做一次带真 token 的实测把 U2 关死），`server_import`/`server_open` 走已有 Bearer（`play-admin`）。
→ 完成 **建图→改代码→发布→上服→开放** 的无人链；仍缺地形/UI（靠切片 B + R1）。

### 需要的引擎侧改造（按收益/半径排序，本泳道不实现）

| ID | 改造 | 文件 · 半径 | 收益 |
|---|---|---|---|
| **R1** | 在 edit 运行时加一个 **loopback 内部 AI 工具端点**：`POST /internal/ai-tool {name,args,dryRun}`，内部直接 `createEntityTools(replica,state,gameId,logger)` 的表查找执行（+ 新增 `terrain_apply`/`terrain_read`/`ui_upsert`/`interaction_configure` 四个同族工具） | `services/game-server/src/createServer.ts:557-633`（同一段 localOnly 里加 1 条路由）+ `src/edit/ai/entity-tools.ts`（+~400 行） | **一次性拿下地形+UI+交互三件接管事项**，零新鉴权面，回滚白送（`projectTransaction` 已有 inverse） |
| **R2** | 把 `versionControl.branches/switchBranch` 暴露为 CLI scope `projects.version` | `creator-cli-policy.ts:5-15` + 1 条 `creator/v1` 路由 → `replica-server.ts:2703-2726` | AI 级 undo/redo 与"实验分支" |
| **R3** | `runtime.simulateJoin`：无头进图并派发 `onPlayerJoin` | `world-synchronizer.ts:188` 的入口 + `createServer.ts:557` 段内新路由 | **G3 从人工变自动**，V4 变绿 |
| **R4** | 补 `/api/project-models`、`/api/project-scripts`、`/api/project-skins` 的 `localOnly(req,res)`（现在三条写路由漏了） | `createServer.ts:652,830,859` 各 1 行 | 消掉 §2.5 的无鉴权资产写面 |
| **R5** | 去冷启动 `spawnSync tar`：`runTar` 换成 node `tar` 库或 `box3-pack`（CIDv0 已有全套正则与闭包扫描） | `project-manager.js:770-773,1238,1669,847` | 首图数十秒；AI 才敢"每步都快照" |
| **R6** | 写类端点加 `expectedRevision` CAS | `project-manager.js:2056-2189` + `storage/[scope]/[space].ts` | 多 agent 并发安全 |
| **R7** | 修客户端 DTS 断链（2 处 include + 1 行注释解除） | `client-api-tsconfig.json:8`、`build-llm-context.ts:41` | AI 终于有客户端类型（UI/交互必需） |
| **R8** | `if (storageMode==='pg')` 降级改成显式 warn 或直接拒绝 | `entry.ts:686-688` | 消掉假绿 |
| **R9** | `snapshotLimit` 可配 + 写前强制快照钩子 | `project-manager.js:30,746` | AI 高频写的安全网 |

---

## 7. "今天做不到"清单（需求原文里必须承认的部分）

| 用户要的 | 今天 | 缺什么 |
|---|---|---|
| 地形搭建全自动 | **做不到**（无服务端工具、无 HTTP 入口、体素只能走需要登录会话的 VoxelProtocol，且 `checkProjectActionSequence` 明确禁止客户端用 project 动作写体素） | R1（`terrain_apply/terrain_read`）或切片 B |
| 界面按钮全自动 | **做不到**（`uiTree` 是 RDA 树，无任何外部写面；且没有 `button` 元素类型，按钮=组合+客户端脚本） | R1 + R7（客户端类型） |
| 各交互全自动 | **部分**：实体属性（`EntitySeedRDA` 全字段）已可由 `updateEntity` 写，zone/碰撞/gamepad/player/环境 无工具 | R1 |
| 代码编写全自动 | **能做到**（`scripts.update` + `script_typecheck` + `runtime.events` 异常流） | 仅需 MCP 包装 |
| 发布/上服全自动 | **基本能做到**：`play-admin` 已 Bearer；`create/publish/export/package` 借 §2.3 通道可达（待一次真 token 实测）；`exportPlayBundle` 前必须已有 `permissionHash`（`project-manager.js:2414-2416`） | 实测 U2 + R1/B（否则只有空图） |
| 全程零人工 | **做不到**：截图要浏览器编辑器在线授权（`creator-scene-session.ts:111-125`，`scene.capture` 的语义就是"请求当前已授权编辑会话"）；进图验证要真人/真客户端（V4） | R3；V5 可先用 `server_eval` 断言替代视觉 |

---

## 8. UNVERIFIED / 矛盾清单

**UNVERIFIED（我查不到/不能查，绝不猜）**
- **U1** 经 edit-library 代理进运行时的 `/internal/*` 是否被 `localOnly` 403 拒掉。代码级强烈指向"会拒"（`runtime.rs:126-138` 给的是容器 IP + `createServer.ts:609-619` 只认 loopback），但实测要 `POST`（=变更），禁止。**G9 的落盘方案取决于此**。
- **U2** 用真实 `bxc_…` token 打 `/api/local-projects/[id]/publish` 是否 2xx。需要签发（`player-admin/players/[subjectId].ts` 的 `create-cli-token` 动作，属变更）→ 未做。只做了无凭据探针，文案证明 Bearer 分支被走到。
- **U3** 客户端运行时 API 的真实数量（"约 156 个"）未独立复算；我只确证了声明链断点位置与真实实现目录（`src/engine/script/ses/apis/`，14 项、2 098 行）。
- **U4** `play-admin` 的 `mode=preview` 审查流是否会拦住 AI 生成的脚本（`script-moderation` 另有一套：`pages/api/play-admin/script-moderation.ts`、`server/script-moderation-service.ts`）——未读完，未测。
- **U5** `mudb` 的 `VoxelProtocol` 客户端能否在不渲染 3D 的情况下只发 `voxelChange`（协议本身允许，但客户端实现依赖 mesh/AO/bake 上下文）。
- **U6** `AI_MODEL_MAPPING`/`OPENROUTER_API_KEY` 若补齐，内置 AI 面板是否就能端到端跑（权限侧 `ai-server.ts:81-84` 要 `sessionPermission.owner`）。

**与既有文档的矛盾（需主控更正 §3.4 / GATES.md G9）**
- **M1** "9 个 mudb synchronizer 文件"：`services/game-server/src/script/bindings/` 实际是 **5** 个 `*-synchronizer.ts`（world/entity/voxel/zone/synchronizer）。
- **M2** "五个端点只认浏览器会话 Cookie → 今天无法 headless 建图→发布→上服"：`play-admin/import` 从来不是 Cookie 门而是 `BOX_PLAY_ADMIN_TOKEN` Bearer（`play-admin-security.ts:9-26`）；其余四个也接受 CLI Bearer（因为判的是用户级 `creatorPermissions`，`creator-api-security.ts:105`）。G9 的真实缺口是**工具面（地形/UI）**，不是**鉴权面**。
- **M3** "客户端 DTS 无法再生成"：仅指 `apps/game/scripts/assets/client_api` 这条链（`client-api-tsconfig.json:8` include 空）；`packages/script-api/dts/client-api-types.dts`(546 行) 由 `rollup.config.mjs` 从 `src/client/global.ts` 正常产出，且已被 `check-editor-types.ts:108-117` 使用。措辞应从"无法再生成"改为"编辑器的 Monaco 客户端库链已断，SDK 客户端链完好但只有 546 行（覆盖面远小于运行时实现的约 156 个 API）"。

**已存在但可疑/危险的分支（照实列，均在 §2.5 展开）**
`entry.ts:686-688`（pg→sqlite 静默降级）｜`createServer.ts:652,830,859`（三条写路由缺 `localOnly`）｜`validate-voxel-action.ts:12`（`// TODO` 恒 true）｜`entity-tools.ts:676-683`（`addModelToProject` 无 `execute`）、`:662-673`（搜索硬编码空）｜`ai-server.ts:336-340`（`modelMapping` 为 undefined 时抛 TypeError）+ `config/server.ts:46-48`（本地默认 undefined）+ `edit-server.ts:91`（OPENROUTER key 现网未设）｜`publish.ts:31`（ECONNREFUSED 当正常）｜`replica-server.ts:1602`（运行中不记体素 hash）｜`transaction.ts:3`（原文警告"必须单 tick 内完成"）｜`creator-cli-policy.ts:37-41`（未知 scope 静默丢弃）｜`project-serialize.ts:131-140`（无 migration 则抛，错误文案为全大写喊话）。

---

## 9. 需用户决策项

| # | 决策 | 选项 | 我的建议 |
|---|---|---|---|
| **D1** | **R1 是否批准**（在引擎里加一个 loopback 内部 AI 工具端点 + 4 个地形/UI 工具） | ①批准（唯一能真正"全自动接管地形与界面"的路，~400 行，半径 2 文件，零新鉴权面）／②只做盘侧 `box3-terrain-pack`（引擎 0 改，但禁止与编辑器同时开图）／③只做切片 A 代码链 | **① + ② 并行**：②先出成果，①做正式面 |
| **D2** | **越权面怎么修**（CLI token 借道 §2.3） | ①先借道打通 G9、把越权记为已知风险／②立刻显式化：加 1 个 `projects.manage` scope 并改 5 行路由（同时修掉漏洞，≈20 行） | **②**，因为它一次解决"G9 前置"和"最小权限承诺失效"，且半径 6 个文件各 1 行 |
| **D3** | **U1 是否允许实测**（需一次 `POST /internal/save-local-project`，属容器内写入；可只在一次性克隆工程上做） | 允许（克隆图）／禁止（则 MCP 落盘方案只能走切片 B 盘侧） | **允许，但仅对新建的一次性克隆图**，因为 publish 路径本身今天就发这个请求，不做实测整个设计的落盘环节都是猜 |
| **D4** | **验收闭环要不要真玩家进图** | ①R3 加 `simulateJoin` scope（G3 完全自动化）／②G3 保留一次人工进图，其余全自动 | ①，否则"全自动"名不副实 |
| **D5** | **MCP 跑在哪** | ①宿主 WSL（只能打 3127/80 的 HTTP，内部路由可能被 U1 挡）／②creator 容器内（loopback 全通，但要进镜像、体积↑） | 先①，若 U1 实测为 403 则**把 MCP 作为 sidecar 放 creator 网络命名**，而不是塞进镜像（守 A2 体积门） |
| **D6** | **AI 写盘的默认策略** | ①dryRun 默认 + 每步强制快照（安全，但受 `snapshotLimit=5` 与 tar 同步 IO 拖累）／②只在批次末尾一次快照 | ①配 R5（去 tar）+ R9（可配上限）；**没做 R5 之前先用 ②**，否则每步几十秒 |
| **D7** | **要不要把 398 面 + 客户端面做成 MCP 常驻资源**（`contract_describe` / prompt 资源），并顺手修 R7 客户端类型断链 | 是／否 | **是**——这是用户要求 #3 里"AI 不破坏原有功能"与需求里"界面按钮全自动"的共同前提 |

---

## 附录 A · 现网只读取证记录

- `GET http://127.0.0.1:3127/api/creator/v1/health` → `200 {"apiVersion":"v1","engineVersion":"v2026.1.4-linux-amd64","serverInstanceId":"local-engine","issuer":"local-engine","deploymentMode":"creator"}`
- `GET /api/local-projects`（无凭据）→ `401`；`+ Authorization: Bearer bxc_test_test` → `401 {"code":"AUTH_REQUIRED","message":"请先注册或登录账号"}`
- `GET /api/creator/v1/projects`（同上 bogus）→ `401 {"code":"AUTH_REQUIRED","message":"CLI Token 无效或已撤销"}`
- `POST /api/local-projects/nope/publish`（bogus Bearer）→ `401 {"code":"AUTH_REQUIRED","message":"请先注册或登录账号"}`（**走到浏览器门**）
- `GET http://127.0.0.1:9967/yunhai-xiantu/internal/creator-preview-runtime` → `200 {"phase":"idle","running":false,…}`（由 edit-library 自身应答，`edit-library.js:361-374`）
- creator env（名单，`docker exec … env`）：`BOX_DEPLOYMENT_MODE=creator`、`BOX_CREATOR_ALLOWED_HOSTS=127.0.0.1`、`BOX_PLAYER_SERVICE_INTERNAL_URL=http://player-service:3213`、`BOX_RUNTIME_MANAGER_URL=http://server-manager:3130`、`BOX_EDIT_RUNTIME_PORT=9967`、`BOX_DATABASE_URL`/`PERMISSION_TOKEN_SECRET` 存在；**`OPENROUTER_API_KEY`/`AI_MODEL_MAPPING` 不存在**；`BOX_LOCAL_PROJECTS_PATH` 未设（用默认 `/app/apps/local-engine/projects`）
- `ls projects` → `cloud-3a043df55e5057a5-imported`、`cloud-4e84ee7ef626058f-imported`、`yunhai-xiantu`
- `yunhai-xiantu/` → `.snapshots/`、`group-state.json`、`project.json`、`source/{blobs,build-cache.json,project-state.json,runtime-blobs.json}`；`source/project-state.json` 内容见 §1.0（`permissionHash=QmSffxpcMjy9sAx9mSCfLErpwAwnWr1qprENEC6YSU2mg1`，`groupProjectMetaData.version="0.3.31"`）
- `docker ps -a`：**无任何 per-project 运行时容器在跑**（只有 7+4 个服务容器与 3 个已退出的 `*-storage-init`）→ U1 无法在不产生变更的前提下实测
- `internals/apis/openapi/openapi.json`：`info={"title":"BOX3 Local Engine API","version":"0.2.0",…}`，`paths=137`，`/api/creator/v1/*` 14 条全在列

## 附录 B · 取证边界声明

引擎仓 `box3-local-engine/` 未做任何修改；未 `git commit/push`；未改根 `docker-compose.yml`、`BOX3-IMAGE-CATALOG.json`、`pnpm-lock.yaml`；未执行任何 `docker` 写操作/`--pull`/外网拉取。临时探针输出仅落在 `box3-re/tmp/a8-*.txt`。本文全部 path:line 均为亲自读到；未读到的一律写进 §8 的 U 项，无一处推测函数名或路由名。
