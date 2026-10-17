# N1 · play 页面自定义 —— 取证与规划（A7 泳道）

> 只做取证与规划，不改任何业务代码。`box3-local-engine/**` 全程只读。
> 仓库 tag `v2026.1.4`（commit `a35455d814`），分支 `slim/local-deploy`。所有 `path:line` 为**源码行**（非 bundle 偏移）。
> 现网取证：对已运行的 `box-local-engine-play-1`（`127.0.0.1:80`）做了**只读 GET**，未做任何容器变更。

---

## 0. 需求原文（逐字回应）

> "play页面自定义，当前的play页面都是固定模板，固定的样式展示各个地图，我想支持自定义页面样式来展示地图而不是锁死。"

拆解为三个可证问题：
1. "固定模板 / 固定样式"锁在哪一层？→ 锁在 `apps/game/pages/index.tsx` 单个页面组件里的 **styled-jsx**（不是配置、不是 CSS 文件、不是 DB）。见 §1。
2. "展示各个地图"的数据从哪来？→ 文件系统 `manifest.json`，非数据库、非 Postgres。见 §2。
3. "支持自定义页面样式" → 项目里**已存在一套 4 值设计令牌 `theme`**（sunset/ocean/forest/violet），已经落进发布清单，只是 play 端没读、没渲染、作者不能选。这是最省事的既有扩展点。见 §2.3 / §3。

结论一句话：**这不是"要不要新做一套模板引擎"的问题，而是"把已经躺在 manifest 里的 `theme` 字段接到 play 首页、并把写死的 styled-jsx 改造成按 `theme` 选预设"的问题。** 白盒改造落点极小。

---

## 1. 现状取证："固定模板"钉在代码上（path:line）

### 1.1 两个 play 页面路由

| 页面 | 文件 | 性质 | 渲染链路 |
| --- | --- | --- | --- |
| 地图**列表页**（"作品中心"，即 `/`） | `apps/game/pages/index.tsx`（2956 行） | Next Pages Router SSR | `getServerSideProps:2918` → `getPlayWorlds():2945` + `getPlayPresenceCounts():2953` → 客户端组件 `HomePage:166` → 卡片 JSX `:934-949` / 分组树 `:954-1067` → styled-jsx `:1491+` |
| 地图**详情/进图页**（`/p/[gameName]`） | `apps/game/pages/p/[gameName]/index.tsx`（282 行） | SSR 进图壳 + 游戏客户端 | `getServerSideProps:46` 校验存在性 `:55-68` → `getArenaServerRenderProps:82` → 封面 `mapInfo.backgroundImage:257` → `EngineApp:267` + 动态 `src/views/play:22` |

调用顺序（列表页）：`pages/index.tsx:2945 getPlayWorlds()` → `server/play-worlds.ts:22` 读盘 → `:69 名字 localeCompare 排序` → props 注入 `HomePage:166` → `useMemo worldGroups:218` 分组 → `:934 <article className="card">` 出卡片 → `<style jsx>:1491` 上色上栅格。

实下证据（只读 GET `127.0.0.1/`，`box3-re/tmp/a7.txt`）：
```
<title class="jsx-58b7e53ea0fd451e" ...>游玩作品中心</title>
... 命中类名： playWorkCenter / playerGrid / cardLink / jsx-58b7e53ea0fd451e
HTML 字节数： 51535  （= S8 口径的 "HTML 51.5 KB"，wire 总 315,903 B）
```
`jsx-<hash>` 类名 + 内联样式 = **styled-jsx**：版式与配色在构建期就烤进了 JS/CSS，运行期无外部样式钩子。

### 1.2 "卡片布局 / 封面 / 排序 / 分组 / 文案"分别硬编码在哪

| 维度 | 硬编码位置 | 证据 |
| --- | --- | --- |
| 卡片 DOM 结构 | `pages/index.tsx:934-949`（`article.card` → `Link.cardLink` → `div.cover>img` → `div.info`（name/author/version/description）→ `span.playCta`）；主/副地图分组树 `:990-1067`（`mainMap`/`submapGrid`） | 原文即 JSX，非模板变量 |
| 封面来源 + 兜底 | `:944 :995 :1044` `src={main.cover \|\| DEFAULT_MAP_COVER}`；`DEFAULT_MAP_COVER='/map-templates/blank-template.png'` `:38` | 封面数据可换（见 §2），但取用逻辑写死 |
| 栅格 / 配色 / 尺寸 | `<style jsx>` 块 `:1491` 起一路到 `:2900+`；`.playerGrid:1663,2593`、`.card:1826`、`.cover:1853`、`.cover img:1863`、根布局 `.playWorkCenter.page:2518`；主题色 `#ffdb00/#262626/#404040` 散写 `:2548-2610` | **版式=单文件里的写死 CSS，无变量层** |
| 排序 | 默认名字序 `server/play-worlds.ts:69`；"最近"按 recent 索引 `:394`；"收藏"过滤 `:391` | 三档全在代码，无外部排序键 |
| 分组 | `useMemo worldGroups:218-238`，键 = `mapGroupId \|\| mainProjectId \|\| id` | 分组规则写死 |
| 文案 | i18n `t('playHome.*')`，字典 `../i18n/zh.json`（`import` 在 `:9`）；页面标题"游玩作品中心"（见实下证据） | 文案走 i18n，但键名与措辞在源码 |

### 1.3 有没有可借用的既有"主题/配置"通道？——有，而且已经有两套

1. **`customizeType`（品牌变体，半死）** `server/map-info.ts:31-43` 用**地图名正则**映射到 `'DIGITALBLOCKLAND' \| 'Fantour' \| ''`；消费方 `components/engine-app/index.tsx:70-71`（`title = customizeType || name`）与 `src/views/components/common/logo/index.tsx:22`。
   → 只影响**进图页顶部标题/ logo 槽位**，不影响列表版式；且靠名字正则、非作者可选。**不能直接借用**（设计怪异，源码里作者自己写了 `// TODO: 移除这个怪异的东西` `map-info.ts:24`）。

2. **`theme`（4 值设计令牌，现成但 play 未接）——本方案的主扩展点。**
   - 类型：`components/project-management/project-types.ts:30 theme:'sunset'|'ocean'|'forest'|'violet'`。
   - 已持久化：写进工程 `project.json`，并在发布/导出时**落进 `manifest.json`**：`apps/local-engine/src/project-manager.js:2442 theme: metadata.theme || 'sunset'`（发布 release 对象，`:2437 projectName/:2439 author/:2440 description/:2441 cover`）。
   - 已应用（**仅 creator 端**）：`catalog/project-card.tsx:37 styles[\`cover${project.theme}\`]` → `pages/projects/projects.module.css:19` 的 `.coverSunset/.coverOcean/.coverForest/.coverViolet`（四段写死渐变）。
   - **当前赋值 = 自动轮询，作者选不了**：`project-manager.js:1118-1127` `themes[listProjects().length % themes.length]`（建图时按下标轮流发）。
   - **play 端完全没用**：`server/play-worlds.ts:22-73` 的字段清单里没有 `theme`；`pages/index.tsx` 也没读。
   → 数据已躺在每张已发布地图的 `manifest.json` 里，只差"play 读出来 + 按值渲染"。这就是"档一几乎免费"的根因。

3. **`BOX_APP_BASE_PATH` / `@box/deployment-routing`**（`server/public-path.ts:1-29`，注释 `:4` 点名资源重写由 `@box/deployment-routing` 维护）——基建，非主题；但与档三直接冲突（见 §3）。

---

## 2. 元数据面（一个地图现在有哪些可展示字段、存哪、谁能改）

### 2.1 字段清单与来源
`server/play-worlds.ts:4-18`（`PlayWorld` 类型）与 `:48-64`（读盘映射）：

| 字段 | 来源 | 现网是否已发布 | 可展示 |
| --- | --- | --- | --- |
| `name` `author` `description` `cover` `loadingCover` `version` `publicId` `permanentMapId` `mapGroupId` `mapRole` `mainProjectId` `playEnabled` | `<BOX_PLAY_LIBRARY_PATH>/<id>/manifest.json` 的对应键（`projectName→name`，`loadingCover→backgroundImage`） | ✅ | 是 |
| **`theme`** | `manifest.json.theme`（发布时 `project-manager.js:2442` 写入） | ✅ 已在盘 | **play 未读取 = 缺口** |
| **在线人数** | 实时，非持久：`server/play-presence.ts getPlayPresenceCounts()`（`index.tsx:2953`）+ `subscribeRealtime('play-presence')` `:295` | n/a | 是（不进 manifest） |

存储位置：**文件系统**（`play-worlds/<id>/manifest.json` + `data/project-state.json`），**不走 Postgres**。`/api/play-worlds`（`pages/api/play-worlds.ts:11 res.json({worlds:getPlayWorlds()})`，**仅 GET、play 模式**）就是直接把这个读盘结果吐给前端；首页 SSR 也直接调同一函数。

### 2.2 作者今天能不能改这些字段？——能改"数据"，改不了"版式"，且分端

| 端 | 入口 | 可改字段 | 证据 |
| --- | --- | --- | --- |
| **creator** | `PATCH /api/local-projects/[id]`（`pages/api/local-projects/[id].ts:31 manager.updateProject(id, req.body)`）；UI "编辑信息"（`catalog/project-card.tsx:60 editDetails`，`dialogs/project-editor-dialog.tsx:272 作品封面 / :307 封面图`） | `name / author / description / cover / loadingCover / publicId` | `project-manager.js:1194-1230`（含 `cover` 校验：data-URL 且 ≤ `projectImageMaxDataUrlBytes` `:1216`） |
| **play（服主，带 `BOX_PLAY_ADMIN_TOKEN`）** | `PATCH /api/play-admin/worlds/[id]`（`pages/api/play-admin/worlds/[id].ts:13-17`） | **仅 `publicId` 与 `playEnabled`** | `server/play-admin.ts:857-887`：`:858-861` **显式禁止** 改 `name/author/description/cover/loadingCover`（抛"游玩端不允许修改地图封面、标题、作者或简介"）；`playEnabled` 走 `:889 setPlayWorldGroupAvailability` |

→ 推论：
- **"展示数据"（含 `theme` 值）本来就是数据驱动、且作者可通过 creator 编辑** —— 自定义列表封面/文案零改造即成立。
- **唯独 `theme` 目前是自动轮询、creator 无选择器**（`updateProject:1194-1230` 无 `theme` 分支，grep 确认），且 play 不读不渲 —— 这是两处**具体、可数的小改动**（见 §4）。
- **"页面版式/样式"是代码驱动**：写死在 `pages/index.tsx` 的 styled-jsx，DB/manifest 里没有任何版式列可借用。

---

## 3. 三档方案对比 + 推荐

| 维度 | 档一：数据驱动预设版式 | 档二：每地图页面设计令牌（白名单 JSON） | 档三：作者自定义 HTML/CSS/组件 |
| --- | --- | --- | --- |
| 思路 | 把 manifest 已有的 `theme` 接进 play 首页，卡片按 4 预设渲染；预设=有限版式集 | 每地图一份受约束的设计令牌（配色/圆角/间距/栅格枚举/字号），SSR 注入成 CSS 变量，版式仍是闭集枚举 | 作者给任意 HTML/CSS/JSX，服务端注入渲染 |
| 改哪些文件 | `server/play-worlds.ts:48-64` 加 `theme`；`pages/index.tsx:944` 卡片套预设类 + `:1491` 增 4 段预设 CSS；`project-manager.js:1194-1230` 加 `theme` 分支；creator `project-editor-dialog.tsx` 加 4 色选择器 | 档一全部 + `server/map-info.ts:45-82` 透传 `pageConfig`；`manifest.json` 新增 `pageConfig`（`formatVersion` +1）；`project-manager.js:2437-2463` 发布写 `pageConfig`；首页/详情页读令牌设 `style={{'--x':…}}` | 档一 + 一套 sanitizer（服务端 DOMPurify）/沙箱 iframe（独立 origin）/组件注册表；重写 `@box/deployment-routing` 基路径逻辑以覆盖作者 HTML |
| 存储加列 | **无**（`theme` 已在 manifest） | `manifest.json` 增 `pageConfig` 对象（文件，非 Postgres），`formatVersion 1→2` | 同档二，另需存原始 HTML/CSS（体积/寻址） |
| 白名单约束 | 天然（枚举） | 必须：schema 限定令牌键 + 值域（色值正则、间距枚举、禁 `url()`/`expression`/`@import`） | 无法白名单（自由度=攻击面） |
| 需重建镜像？ | 是（改了 `pages/index.tsx`→重打 Next standalone bundle） | 是 | 是，且需放宽 CSP（改部署形态） |
| 对 lite（3 容器/3 端口/无特权/全 127.0.0.1） | **无影响** | **无影响**（令牌随 manifest 走文件，不需新服务/端口/DB） | **有风险**：内联脚本/CSP 放宽 → 与"无特权、面最小"相悖；作者脚本同源可触 `box_local_player_session` cookie |
| 与 HTML monkey-patch / 基路径现状 | 无冲突（styled-jsx 烤进 bundle 后本就走既有基路径） | 同左 | **直接冲突**：作者 HTML 不被 `public-path.ts`/`@box/deployment-routing` 前缀化 → 资源路径错乱；SSR 全量缓冲重写链路（`play-library.js` 运行时代理为 `pipe` `:436`，`/p` 页由 next-server 出，作者 HTML 绕过基路径处理） |
| 对首屏字节（引用已知口径，不新造） | styled-jsx 只烤**用到的**规则；4 预设内联到首页 `<style>`，HTML（现 51,535 B / wire 315,903 B）**增量约数 KB**；`/p/[gameName]` chunk 口径 598,064 B 不变（不动进图页） | 令牌是 SSR props 里一段小 JSON（`mapInfo` 已随 `clientConfig` 下发），CSS 变量 <1 KB；首页 HTML 基本不变 | 作者 HTML/CSS 原样进首屏，字节不可控；认证后 `/p` 现 149,594 B 会被显著推高 |
| 风险 | 低 | 中（需 schema + 令牌作用域隔离） | 高（XSS/模板注入/CSP/基路径） |

### 推荐：先档一，再在其骨架上叠档二；档三否决

理由（全部有上表 path:line 支撑）：
1. **档一几乎零新增系统**：`theme` 已持久化进发布 manifest（`project-manager.js:2442`），creator 卡片已有 4 段渐变 CSS（`projects.module.css:19`）——play 端只是"没读没渲 + 作者选不了"，是**接线**不是**发明**，完全契合"白盒改哪几行、加什么扩展点，不另起一套"。
2. **档二给真自定义**：把 `theme` 从 4 枚举扩成受白名单约束的设计令牌 JSON，落点仍在"manifest→SSR props→CSS 变量"这条已存在的通道上，不需新服务/端口/DB，**对 play-lite 形态零冲击**（呼应 W4 §6 交付主线）。
3. **档三与项目根基对冲**：XSS + 基路径 monkey-patch 冲突 + CSP 放宽，违背 lite 的"无特权、面最小"，且等于"另起一套模板引擎"，明确不采纳。

---

## 4. 兼容性护栏（用户硬性要求："不能因支持自定义就让现有地图进不去或功能异常"）

### 4.1 结构上必须守住的三条不变量
1. **进图契约不动**：`pages/p/[gameName]/index.tsx:55-68` 的存在性/`playEnabled` 校验、`play-library.js` 运行时代理（`:424 ensureRuntime` + `:427 http.request` + `:436 upstream.pipe(res)`）**一行不改**；自定义只碰"列表呈现 + 进图 loadingCover"，绝不碰 `EngineApp:267`/`src/views/play:22` 的引擎装配与 `clientConfig`。
2. **缺字段必回退，卡片永不抛**：所有新增读取保持既有兜底风格——`theme: manifest.theme \|\| 'sunset'`（对齐 `project-manager.js:2442` 与 `play-worlds.ts:55-63` 的 `|| ''` 惯例）、`cover \|\| DEFAULT_MAP_COVER`（`index.tsx:38`）、`author \|\| t('playHome.unnamed')`（`:945`）。喂一张只含 `id/permissionHash` 的最小 manifest，首页必须照常出卡（现有 `getPlayWorlds():65 catch { return [] }` 的容错不能改成抛错）。
3. **样式作用域隔离**：新预设/令牌**只允许挂 CSS 变量到 play 容器**（`#__next__root:241` / `.play-react:268`），禁止作者级令牌注入全局元素选择器，避免渗透到游戏画布。styled-jsx 本身以 `jsx-<hash>` 作用域（实下证据 `jsx-58b7e53ea0fd451e`）——这是隔离的现成保证，档二令牌不得绕过它直接写 `<style>` 全局块。

### 4.2 回归检查点（现有图 + 3 工程必须绿）
- **起床战争** `cloud-4e84ee7ef626058f-imported`：
  - `GET /`（首页）仍列出该卡，`GET /p/cloud-4e84ee7ef626058f-imported` 带玩家 Cookie **200**（W4 §3.5 实测 149,594 B 为基线，改造后不得由 200 变 3xx/4xx/5xx）。
  - `POST /api/createSession` 200（W4 §3.5），证明"改样式没动进图链"。
  - `/api/play-worlds` 200 且该 world 字段完整（W4 §3.3）。
- **3 个 creator 工程**（`yunhai-xiantu` 等，HANDOVER §1 数据面）：creator 首页 `ProjectCard` 的 `theme` 由"自动轮询"改"可选"后，**旧工程无 `theme` 值时必须回落 `'sunset'`**（`project-card.tsx:37` 的 `cover${undefined}` 会变 `cover + 'undefined'` 类 → 必须显式 `\|\| 'sunset'`）。
- **既有 UI 断言会被打到，需同步更新**（否则改造直接红）：`server/project-editor-dialog-ui.test.ts:152` **硬断言** `.playerGrid{grid-template-columns:repeat(auto-fill,minmax(208px,224px));justify-content:start}`。任何改列表栅格的档一/二 PR **必须同时改这条断言**，这是真实存在的回归门。
- **默认外观零漂移**：`theme='sunset'` 或未设 `pageConfig` 时，首页渲染 HTML 应与改造前**字节等价**（除新增内联预设的可选 CSS 定义外，无渲染差异）——作为档一验收基线。

### 4.3 G8 门判据（本次新增功能门，补 G1–G7 之外的"自定义不破坏"）
```
G8 play 页面自定义不破坏现有地图
  (a) 进图链回归：起床战争 /p/<id> 带 Cookie 200 + createSession 200（对照 W4 基线）
  (b) 元数据容错：最小/缺字段 manifest 不导致首页崩溃或卡片丢失（getPlayWorlds 返回 [] 而非 throw）
  (c) 默认零漂移：theme 缺省=sunset 时首页 HTML 与改造前 diff 为空（或仅新增未命中预设的定义）
  (d) 作用域隔离：作者令牌/预设不产生全局元素选择器；游戏画布 CSS 不受影响（DOM 快照比对）
  (e) CSP 不变：档一/二 部署的 CSP 头与出厂逐字节一致（仅档三才会破坏，故档三在此判 red）
  (f) creator 三工程卡 theme 缺省回落成功，编辑信息弹窗保存 name/cover 仍走 updateProject:1194-1230
```

---

## 5. 最小可落地切片（第一个 PR）

**目标：把"已经躺在 manifest 里的 `theme`"接到 play 首页并让作者可选——纯接线，可端到端验证。**

改动（4 文件，估 ~40–80 行，不新增服务、不碰 Postgres、不需 `pnpm-lock` re-lock）：
1. `apps/game/server/play-worlds.ts`：`PlayWorld` 类型（`:4-18`）加 `theme: string`；读盘映射（`:48-64`）加 `theme: manifest.theme || 'sunset'`。 **（~3 行）**
2. `apps/game/pages/index.tsx`：卡片 `<div className="cover">`（`:944`）按 `main.theme` 挂一个预设类/CSS 变量；`<style jsx>`（`:1491` 起）加 4 段与 creator 对齐的封面预设（可复制 `projects.module.css:19` 的 4 条渐变）。 **（~25 行）**
3. `apps/local-engine/src/project-manager.js`：`updateProject`（`:1194-1230`）现**无 `theme` 分支**——补 `if (typeof patch.theme==='string' && ['sunset','ocean','forest','violet'].includes(patch.theme)) metadata.theme = patch.theme`。 **（~3 行）**
4. `apps/game/components/project-management/dialogs/project-editor-dialog.tsx`：把 `:1118-1127` 的自动轮询语义在 UI 上改为 4 色色板，保存经现有 `PATCH /api/local-projects/[id]`（已透传 body）。 **（~15 行）**

验证到：在 creator 给起床战争选 `theme=ocean` → 发布/导出写 `manifest.theme`（`project-manager.js:2442` 已在做）→ play 首页 `GET /` 该卡渲染 ocean 渐变；缺省图仍 sunset；`/p/<id>` 200 不变。
一次镜像重建即可（改的是 `pages/*` 与 `server/*`，进 standalone bundle）；lite 形态无需任何 compose/端口变更。

> 后续增量：档二 = 在 1、2 的骨架上把"枚举 theme"升成"`pageConfig` 白名单令牌 JSON"（`manifest.formatVersion 1→2`），不新增服务/端口/表。

---

## 6. UNVERIFIED 清单（没查到的，不猜）

1. **登录态/真实玩家进入 `/p` 后的实际首屏字节**：沿用 S8 §1.1 与 W4 §3.5 口径（wire 315,903 B / HTML 51,535 B / 认证 `/p` 149,594 B / chunk 598,064 B），A7 未重新测。改造对这些数字的影响按 styled-jsx 行为推断为"数 KB 级"，未实测。
2. **`>8 MB 直接 destroy` 的 HTML 全量缓冲重写确切落点**：ANALYSIS §3.3 如此描述；A7 只读到 `public-path.ts`（`:4` 指向 `@box/deployment-routing`）与 `play-library.js:448 / edit-library.js:458`（`res.destroy()` 出现在 catch，运行时代理为 `pipe` `:436`，非全量正则缓冲）。**"正则改写 HTML"具体在哪个文件行=UNVERIFIED**；若做档三需先把该链路读实。
3. **`customizeType`（`map-info.ts:31-43`）是否真被任何已发布地图命中**：只读到"名字正则 + 写死两个合作方"，未验证现网触发；与版式自定义无关，仅记录既有"怪异变体通道"存在。
4. **creator "编辑信息"弹窗是否已暴露 `theme`**：grep `dialogs/*.tsx` 未见 `theme`（只有 `cover/loadingCover`，`project-editor-dialog.tsx:272/307`），判定为"无 theme 选择器"；未逐行读完整个弹窗文件（~350+ 行），标小范围 UNVERIFIED。
5. **play 首页分组/排序是否有任何 env/DB 覆盖**：读到 `play-worlds.ts`/`index.tsx` 全为代码内常量，未发现配置键；未对全仓做穷尽 grep，标"未发现"。
6. **档二设计令牌进 manifest 后对 `manifest.permissionHash` 校验的影响**：`getPlayWorlds():40-47` 与 `importWorld` 都校验 `permissionHash`；给 manifest 增 `pageConfig` 键**是否会改变哈希计算**=UNVERIFIED，落地前须读 `permissionHash` 生成处（本车道未定位）。

---

## 7. 需用户决策项

1. **接受"改代码 + 重建镜像"吗？** 档一/二都要动 `pages/index.tsx`（进 Next standalone bundle），需一次重建；这与"prune/re-lock 阻塞"（HANDOVER §3 P0-#3）同属镜像链路。纯免重建的路子只有"读已存在的 `theme` 值但版式仍固定"——不满足需求。
2. **档一够不够，还是直接上档二？** 档一=4 套预设（作者只能选其一，零自定义风险）；档二=配色/间距/栅格枚举令牌（真·每图定制，但需 schema 白名单）。建议先合档一验证链路，再评估档二收益是否值得 `formatVersion` 升版。
3. **`permissionHash` 兼容策略**（依赖 §6-#6 取证）：新增 manifest 字段是否触碰哈希、老地图如何平滑迁移。
4. **是否把"作者自助改封面/标题"从 creator-only 放开给 play 服主**：现 `play-admin.ts:858-861` **主动禁止**；若 lite 是"服主自助开服"场景，是否要开一个受控的 play 侧编辑口（会改变现有安全语义，需明确拍板）。
5. **档三是否彻底放弃**：本规划建议放弃（XSS/CSP/基路径三重冲突）；若用户坚持要"作者写 HTML"，需另立安全评审车道，本车道不覆盖其攻击面。
