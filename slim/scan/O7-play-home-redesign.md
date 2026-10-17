# O7 · D1 泳道：play 首页视觉与结构改版（照 dao3.fun 换皮）

状态：**代码完成，静态/行为自测全绿；未经 next build 编译与真实渲染验证（UNVERIFIED）**。
用户诉求原话锚点：「顶部 banner（服主可改）→ 直接到地图展示 → 其他功能照旧，只抄袭这个展示页面，可在此基础上优化」。

## 1. 改动清单（行数增减用 `git diff --numstat` + `wc -l` 实测）

| 文件 | 增/删 | 行数 | 内容 |
| --- | --- | --- | --- |
| `apps/game/pages/index.tsx` | +452 / −8 | 2956 → 3400 | 结构重排、SSR 取配置、hero CSS 段、胶囊登录按钮 |
| `apps/game/components/play-home/site-config.ts` | 新建 | 273 | 站级配置类型/归一化/兜底拉取/tab 匹配 |
| `apps/game/components/play-home/banner-carousel.tsx` | 新建 | 189 | banner 轮播（结构+交互，样式由 index.tsx 提供） |
| `apps/game/components/play-home/map-card-meta.ts` | 新建 | 51 | `updatedAt`/`browseCount` 缺失兜底与格式化 |
| `apps/game/server/project-editor-dialog-ui.test.ts` | **0 改动** | 162 | `.playerGrid` 基类未动 → 三条断言原样通过 |

未触碰（`git diff --numstat` 输出为空的机器校验见 §4 第 33–40 项）：`server/play-worlds.ts`（D2 已改）、`server/play-admin.ts`、`pages/api/**`、`pages/p/[gameName]/index.tsx`、`apps/local-engine/src/play-library.js`、`i18n/zh.json`、`next.config.js`（CSP）。

## 2. 新版面区块顺序

```
main.page.boxWorkCenter.playWorkCenter[.playHomeHero][.isHeaderSolid]
 ├ header.siteHeader            非 hero：普通流；hero：sticky top:0 h:64px z:20 + blur(12px)，滚动 >8px 加阴影
 ├ .announceBar                 顶部黄色公告条（#ffdb00 / #262626），仅 announcement.text 非空时出现，可选跳转
 ├ PlayBannerCarousel           通栏 banner 轮播：多图自动播 + 左右箭头 + 圆点 + 标题叠层 + 黄胶囊 CTA
 │                              仅 banner.images.length > 0 时整块渲染；首图未就绪时 fixed 顶部 2px 进度条
 ├ div.header > .title          h1 = t('playHome.maps')，计数「N 个地图」（原样保留）
 ├ nav.sectionNav               分区 tab（来自 config.tabs）；无配置则整块不渲染
 ├ nav.collectionNav            全部 / 最近游玩 / 收藏（既有功能照旧，libraryEnabled 门控不变）
 ├ .notice                      既有提示条
 ├ .playerGrid                  地图卡片网格（tab + 集合视图两级过滤后 = visibleGroups）
 ├ .groups / .empty             服主管理树视图 / 空态（未改）
 └ footer.playFooter            非 hero：fixed 悬浮；hero：static 页内页脚 + config.footer.text
```
卡片内新增一行 `.cardMeta`：`{作者} · {版本}` 下方显示「7月25日 更新 · 9.72K 浏览」，两段各自缺失即各自不渲染。

## 3. 「无配置时与改版前等价」的具体兜底点（每条都可静态定位）

| # | 兜底点 | 位置 | 机制 |
| --- | --- | --- | --- |
| 1 | 配置读不到 → 整段 hero 皮肤不参与匹配 | index.tsx `className={...heroEnabled ? ' playHomeHero' : ''}` | 新增 CSS **全部**以 `.playHomeHero` 前缀；类不加，规则 0 命中，盒模型/宽度/页脚回到改前那批规则 |
| 2 | banner 块 | `{bannerImages.length ? <PlayBannerCarousel/> : null}` | 无图整块不出现，且组件内 `if (!count) return null` 二次兜底 |
| 3 | tab 块 | `{siteTabs.length ? <nav className="sectionNav"> : null}` | `siteTabs = siteConfig?.tabs?.length ? … : []` |
| 4 | 公告条 | `siteConfig?.announcement?.text ? … : null` | 文案空即不渲染 |
| 5 | 列表数据源 | `visibleGroups = filterGroupsByPlaySiteTab(libraryGroups, activeTab)`，`activeTab` 无 tab 时为 `null` → **原样返回同一数组引用** | 卡片集合与改前逐个相同 |
| 6 | 卡片元信息 | `worldMeta.parts.length ? <span className="cardMeta"> : null`；`readPlayWorldMeta` 对 undefined/''/非法日期/NaN/负数/布尔全部返回空串 | 只少一行，绝不让卡片消失或抛错 |
| 7 | SSR 取配置失败 | `readSiteConfigSafely()` try/catch → null；客户端再兜底一次 `loadPlaySiteConfig` | 页面不 500 |
| 8 | 页脚 | `siteConfig?.footer?.text ? … : null`，既有两条 t() 文案未改 | — |

## 4. 契约对齐（与 D2 实测代码逐条比，不靠假设）

- 响应形状、`schema: 1` 与 `banner/announcement/tabs/footer` 字段名：**与 `server/play-site-config.ts` 的 `PublicPlaySiteConfig` 一致**，归一化后消费。
- 上下界改为与 D2 相同：heightPx 120–720、autoplayMs 2000–20000、默认 320/6000、images/tabs ≤12、title≤80 / subtitle≤160 / text≤300 / label≤40。**不截服主选的 620px**（先前 560 上界是我的错，已改）。
- tab 匹配：D2 文档写「`worldMatchesTab()` 已导出，D1 可直接复用」，**我没有复用**——它在 `server/` 模块里（顶层 `import fs`），被客户端组件值导入会把 fs 打进浏览器包。改为在 `site-config.ts` 内实现同语义版本，并用 **44 组用例把两者输出逐一对照（全等，PASS）**：`mapGroupId` 比 `mapGroupId||mainProjectId||id` 解析值（即首页 `group.groupId`）、`mapRole`、`publicId`、键 `undefined` 不参与判定、空 match 命中全部。未知键忽略 + tab 命中 0 组时退回全量（不白屏）。
- `href` 白名单与 D2 同标准：站内绝对路径或 https，拒绝 `javascript:`/`data:`/`http:`/`//host`/带凭据 URL；站内用 `<Link>`，https 用 `<a rel="noreferrer">`。
- `browseCount`：D2 明确「无存储来源，本轮不提供」→ 实测 `readPlayWorldMeta({无字段})` 返回 `parts: []`，只出「更新」段。**未造假数**。
- 消费通道：SSR 主通道（`getPublicPlaySiteConfig()`，首屏即有 banner、不顶版）+ 端点兜底通道（`GET /api/play-site-config`）。

## 5. 兼容红线与既有校验的处理结果

| 约束 | 处理 | 证据 |
| --- | --- | --- |
| `platform-api-removal.test.js:163-166`：index.tsx **不得出现任何 `fetch(`** | 请求下沉到 `components/play-home/site-config.ts`（不在该名单内） | 脚本复刻断言 PASS（index.tsx 内 `fetch(` 计数 = 0） |
| 同文件:191 `XMLHttpRequest` 必须恰好 1 处 | 未增删 | 计数 = 1 PASS |
| 同文件:192 / check-standalone:1658 根路由选择器 | `getServerSideProps` 三段重定向一字未动 | 正则 PASS |
| `check-desktop-deployment-manager.js:569` 禁 `href="/play-system"` | 未引入 | PASS |
| `project-editor-dialog-ui.test.ts:147/149/152` | 基类 `.playerGrid`（`repeat(auto-fill, minmax(208px, 224px))` + `justify-content: start`）与 `.playWorkCenter .playerGrid .cover{aspect-ratio:1}` **保持原文**，改版栅格写在 `.playHomeHero .playerGrid` 里 | 三条正则 PASS → **该测试文件无需改动** |
| 进图契约 | `href={\`/p/${encodeURIComponent(main.publicId)}\`}`、停用拦截、`recordRecent` 原样 | PASS |
| i18n | 只用既有 key（脚本抽 `t('…')` 与 `zh.json` 求差 = 空集）；新中文文案（分区/横幅/进度）走 `play-site-config` 或硬编码，与同文件既有硬编码中文（'打开地图'/'主地图'）同标准——`i18n/zh.json` 不在我的所有权内，未新增 key | PASS |
| `protectedFields` / CSP / HTML 基路径 monkey-patch | 未碰；banner 是站级配置不是地图字段 | 文件 diff 空 |
| 86 个未声明自定义属性 | 只读不写、不 freeze/seal/收窄；唯一入口 `readRaw()` 用 `as unknown as Record<string, unknown>` | 代码走查 |

## 6. 验证做到哪一步 / 哪些 UNVERIFIED

已跑（命令都在报告里可复现）：
1. `tsc 5.9.3 --noEmit --jsx preserve --noResolve` 四文件：**TS1xxx 解析错误 0**（对照 `git show HEAD:` 基线同为 0）。编译器借用 `D:/desktop/box3/node_modules/typescript`，未在本仓安装任何东西。
2. `tsc --moduleResolution node --strict true` 单独检 `site-config.ts` / `map-card-meta.ts`：真实解析到 `server/play-worlds.ts` 的 `PlayWorld` 类型，**非缺依赖类错误 0**（只余 TS2307/TS2792/TS2580，全是无 node_modules/无 @types 的环境噪声）。
3. **行为测试 89 例全绿**（`tsc --outDir` 转译到临时目录后用 node 直跑，未写入仓库）：归一化 17 种垃圾输入不抛错、schema≠1 拒绝、上下界、href 注入 9 例、D2 默认配置消费结果、tab 语义 44 组对照、元信息缺失/非法 25 例、以及把 `globalThis.fetch` 换成 404/非 JSON/抛错/空体/损坏 5 种桩后 `loadPlaySiteConfig` 仍返回 null 且不抛。
4. 静态结构 40 项全绿：CSS 花括号与 `:global()` 配平、960/1200 三档断点齐备、`scale(1.1)`/`9999px`/1024 内容列/色值换算落地、`<main>…</main>` 全页 JSX 标签配平（自写 brace/quote 感知扫描器，CRLF 归一）、`playBanner*` 类名**双向覆盖**（组件用到的都有规则、CSS 里无孤儿）。
5. 自写 CSS 声明检查器扫整个 `<style jsx>`：**336 个规则块、0 问题**（每块都校验 `prop: value`、值为空、函数括号配平、空规则块、花括号层数）。

UNVERIFIED（本轮硬现实：`apps/game` 无 node_modules，跑不了 `next build`，也跑不了 jest/浏览器）：
- 页面是否真能编译出 bundle；styled-jsx 的 `:global()` 在 `.playHomeHero` 前缀下的实际作用域产物。
- 首屏视觉：banner 与 sticky 头/公告条的层叠与高度、1:1 卡片在 1024 列里的实际列数（3/2/1）、胶囊按钮与 PlayerAccount 触发器在 64px 头内的对齐、页脚由 fixed 改 static 后正文底部空间。
- 轮播交互（自动播/悬停暂停/箭头/圆点/键盘焦点）与 SSR↔客户端 hydration（首帧 `viewportWidth=0` 已按服务端高度渲染，避免 mismatch，但未实机确认）。
- 服主在管理端改 banner 后首页是否按预期出现（依赖 D2 的 `PUT/PATCH /api/play-admin/site-config` 与 `site-config.json` 落盘）。
- 已知主动取舍：① dao3 的 `main.mt-[-64px]`（hero 上滑顶到 sticky 头下）**未照搬**——同栈里还有公告条，负边距会把公告条压到头下被遮；改为不透明 sticky 头 + 通栏 banner，视觉接近且无遮挡风险。② 移动抽屉未做：本站顶栏只有品牌+账户入口，抽屉里会空（`siteNav` 在 ≤640 本就 `display:none`）。③ 顶部进度条不做动画：本仓 `@keyframes` 在 styled-jsx 下的作用域无本地证据（`account-menu-in` 定义了但全仓 0 引用，反证不可靠），改成静态 2px 黄条。④ `updatedAt` 不走 `Intl.DateTimeFormat('zh-CN')`：本机 Node（ICU 78.3）实测输出 `7/25` 而非 `7月25日`，各端 ICU 版本会漂，改用手拼月/日。

## 7. 要真验需要用户放行的事

1. 联网/装依赖放行：`rush install` 或 `pnpm install --filter game`（当前 `pnpm-lock.yaml` 相关阻塞项见风险清单）。
2. `cd apps/game && npx next build`（或仓内既有构建脚本）→ 过 SWC/styled-jsx，才算「能编译」。
3. `npx jest server/project-editor-dialog-ui.test.ts` + `node scripts/platform-api-removal.test.js`（后者还依赖 `internals/apis/dist/index.js` 已构建，现缺失即 ENOENT，非本次改动引起）+ `node scripts/check-desktop-deployment-manager.js` + `node scripts/check-standalone.js`。
4. 起 BOX_UI_PREVIEW 开发服（我留了 `previewSiteConfig`，dev-only 门控：`NODE_ENV==='development' && BOX_UI_PREVIEW==='true'`，生产路径不受影响）肉眼过版面；再用真地图 + `BOX_PLAY_SITE_CONFIG_PATH` 写一份带 banner 的配置验服主改图链路。
5. 若要覆盖线上形态：重建 play 镜像（**本轮我没动任何容器**，其它泳道在用 Docker）。

## 8. 留给下一轮的建议（不在本次范围）

- 服主管理 UI 里补 banner 编辑面板（走 D2 的 `GET/PUT/PATCH /api/play-admin/site-config`，`worldId` 引用已安装的地图即可零新增文件面）。
- `browseCount` 若将来要有真数，需要新增计数存储（D2 已评估：写放大风险，本轮明确不做）。
- 模型展厅/直播中心等 dao3 分区：契约里 `tabs[].label` 已能承载文案，但没有对应数据源，需要另立泳道。
