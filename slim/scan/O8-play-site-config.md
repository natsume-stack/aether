# O8 · D2 泳道：play 站级配置（服主可改 banner）+ 地图卡片数据补齐

日期：2026-10-18 ｜ 泳道：D2 ｜ 状态：代码完成，真实浏览器/Next 运行时 UNVERIFIED（无 node_modules，不能 build）

## 1. 接口契约（与 D1 约定一致，逐字对齐）

`GET /api/play-site-config`（公开、只读、仅 play 模式；`Cache-Control: no-store`）返回：

```json
{ "schema": 1,
  "banner": { "images": [ { "src": "...", "href": "/p/<publicId>", "title": "", "subtitle": "" } ],
              "heightPx": 320, "autoplayMs": 6000 },
  "announcement": { "text": "", "href": "" },
  "tabs": [ { "key": "all", "label": "地图展厅", "match": {} } ],
  "footer": { "text": "" } }
```

公开响应**不含** `worldId`、路径、环境变量、错误细节（`buildPublicPlaySiteConfig` 重建对象，只输出契约 4 键）。

## 2. 文件清单

| 文件 | 动作 | 说明 |
|---|---|---|
| `apps/game/server/play-site-config.ts` | 新建 | 存储路径推导、默认值、宽容读取降级、严格写入校验、原子写 + `.bak` |
| `apps/game/pages/api/play-site-config.ts` | 新建 | 公开只读端点（模式门 + GET 门，形状同 `/api/play-worlds` 既有路由） |
| `apps/game/pages/api/play-admin/site-config.ts` | 新建 | 服主 GET（管理视图，保留 worldId 便于回写）/ PUT（全量替换）/ PATCH（按区块合并） |
| `apps/game/server/play-worlds.ts` | 修改（+22 行，纯 additive） | `PlayWorld` 增可选 `updatedAt`/`browseCount` 类型；输出增 `updatedAt`；**permissionHash 校验与其余字段一字未动** |
| `apps/game/server/play-site-config.test.ts` | 新建 | 13 用例；jest 惯例 + Node≥22 原生 TS 直跑双兼容（无 jest 全局时自动走 standalone runner） |
| `box3-re/scan/O8-play-site-config.md` | 新建 | 本文档 |

未触碰：`pages/index.tsx`、`components/play-home/**`（D1 所有权）、`protectedFields`、进图契约、CSP、任何 compose 文件。git 工作区核对：本泳道改动仅上表文件（`M apps/game/server/play-worlds.ts` + 4 个新文件）。

## 3. 存储位置与默认值策略（对任务书建议的一处偏离，有实测依据）

- 任务书建议「play 库同级」；实测现网 compose：`BOX_PLAY_LIBRARY_PATH=/app/play-worlds` 是**可写 bind 卷**（地图导入即写此目录），其同级 `/app` 属镜像文件系统、生产可能只读。故默认取 **`<BOX_PLAY_LIBRARY_PATH>/site-config.json`（库目录内）**；环境变量 `BOX_PLAY_SITE_CONFIG_PATH`（绝对路径）可覆盖。
- 库目录内放文件安全：`getPlayWorlds()` 只接受 `isDirectory()` 且 ID 正则命中的条目，`site-config.json`/`.bak`/`.tmp` 均被忽略（已单测断言）。
- 文件缺失 → 结构完整默认值（banner.images=[]、heightPx 320、autoplayMs 6000、公告/页脚空、tabs=[all]），HTTP 200，不记日志（缺文件是合法初始态）。
- JSON 损坏 / schema≠1 / 读取 IO 错误 → **降级默认值 + `console.error/warn` 一条含文件路径与原因的日志**（`[play-site-config] ... 已降级为默认配置：<原因>`）；不静默吞错、不 404、不崩。
- 读取端宽容（类型错字段回退默认并记 warning），写入端严格（非法值抛中文错误 → 端点回 400 + message）。

## 4. 服主写入（原子 + 回滚）

- 复用既有鉴权：`allowPlayLibraryAdmin`（`server/play-admin-security.ts`，即 play-admin/worlds 同款：play 模式 + 库已挂载 + `BOX_PLAY_ADMIN_TOKEN` timingSafeEqual + 每 IP 失败限流），未新造任何鉴权。
- 原子写：`${path}.${pid}.${Date.now()}.tmp` → `writeFileSync(mode 0o644)` → 旧版复制到 `<path>.bak` → `renameSync` 替换。tmp 命名与清理路径参照 `play-admin.ts` 的 manifest.json 写法。
- Windows/Docker Desktop 绑定挂载上并发读者可让 rename 短暂 EPERM：加了有界同步重试（4 次 × 80ms `Atomics.wait`，仓库已有同型先例 `removeDirectoryWithRetry`）；EROFS 不重试直接报「站点配置目录不可写…」。
- 回滚：`cp site-config.json.bak site-config.json`（同端点亦可 PUT 旧内容）；保留一层上一版。
- PUT 传 `{}` = 整体重置为默认；PATCH 按 banner/announcement/tabs/footer 区块浅合并（banner.images、tabs 传入即整体替换）。

## 5. banner 图源方案（最小可用、零新外部依赖、零新文件面）

优先级：**worldId 引用已安装地图（推荐）> 服主填站内路径/HTTPS URL**。

- `{ "worldId": "xxx" }`：读取时经 `getPlayWorlds()` 解析为 `src=world.cover`、`href=/p/<publicId>`、`title=world.name`（显式 title/subtitle/src/href 可覆盖）。cover 本来就是首页 `<img src>` 直接渲染的同一字符串——**复用即零新增暴露面**，解析值原样透出（与现有首页同信任级）。地图被删/无 cover 且无兜底 src → 该项丢弃（数据漂移，非吞错）。
- 服主手填 `src`/`href` 严格校验（防穿越/协议注入）：只允许 ①站内绝对路径——必须单 `/` 开头（拒 `//evil` 协议相对）、字符白名单 `[A-Za-z0-9@:._~-]`、段内禁 `..`/`.`、禁 `\ ? # %`；②`https:` 完整 URL——禁内嵌凭据/查询/片段（与 `validateAssetDistribution` 同标准）。拒绝 `http:`/`data:`/`javascript:` 等。**本模块从不按 src 读磁盘**，校验面向浏览器侧；不新增上传目录 → 不动 compose、无需新端口/卷。
- 「本地上传」路线本轮**不做**：需新可写目录 + 新静态路由，可能触发卷变更（需用户决策项），而 cover 复用已满足 dao3 式大图轮播。若后续确需上传，另列决策。

## 6. `updatedAt` / `browseCount`

- `updatedAt`（可选，ISO 或 `''`）：**首选 `manifest.createdAt`**——创作者端发布时写入的 ISO 时间（`project-manager.js` 发布流程实测：release manifest 的 `createdAt` 即该版本发布时间，覆盖导入即更新），语义是"地图内容最后更新"，随游玩包携带、不受容器/绑定挂载 mtime 失真影响，且无额外 stat。校验 ISO 正则失败时**回退 `manifest.json` 文件 mtime**（兼容无 createdAt 的旧包），stat 失败给 `''`。注意：改 publicId 等管理端写 manifest **不**改动 createdAt（内容未变，语义正确）。
- `browseCount`：**无来源，本轮不提供**——全仓检索 `browseCount/viewCount/playCount` 零命中，引擎无浏览计数存储；不造假数、不引入新存储写放大。类型为可选，前端按缺省隐藏。

## 7. tab `match` 语义

`match` 为可选字段的 AND 过滤；**空对象 = 命中全部**（默认 tab `{key:'all',label:'地图展厅',match:{}}` 与改版前"全量展示"一致）。支持字段仅三个（未知字段写入报错）：
- `mapGroupId`：按 `world.mapGroupId || world.mainProjectId || world.id` 比较——与首页现有分组规则（`pages/index.tsx` getServerSideProps 的 groupByMap）**同一兜底链**；
- `mapRole`：`'main' | 'submap'`；
- `publicId`：地图公开 ID。
判定函数 `worldMatchesTab()` 已导出，D1 可直接复用（服务端/客户端同语义）。

## 8. 验证

**已跑（真实执行，Node v24.18.0 原生 TS，Electron `ELECTRON_RUN_AS_NODE=1`；仓库无 node_modules，jest 不可用，standalone runner 直接执行同一 .test.ts）**：

```
$ node --check（等价：Qoder.exe --check）
ALL_CHECK_OK   # server/play-site-config.ts, pages/api/play-site-config.ts, pages/api/play-admin/site-config.ts
               # server/play-worlds.ts, server/play-site-config.test.ts 全部通过

$ node server/play-site-config.test.ts   # 经临时 .ts 扩展名解析钩子直跑（钩子在仓库外 scratchpad）
ok - 文件缺失时返回结构完整的默认值
ok - JSON 损坏时降级默认值并记录可诊断日志（非静默）
ok - schema 不匹配时降级默认值并记日志
ok - 原子写入：临时文件 + rename，保留上一版 .bak
ok - PATCH 按区块合并，PUT 全量替换
ok - 目录穿越与非法图源被拒绝          # ../、/a/../../、//evil、http:、javascript:、data:、C:\、?#% 均拒；/map-templates/a.png、https CDN 通过
ok - 并发写入不产生半截文件，终态为其中一版  # 3 子进程并发 PUT，全程无 .tmp 残留
ok - worldId 引用解析为地图 cover 与 /p/<publicId>，公开形状符合契约
ok - getPublicPlaySiteConfig 端到端（真实 getPlayWorlds + 缺失文件默认值）
ok - 默认存储路径推导为地图库目录内，且库内配置文件不会被当作地图
ok - tab match 语义：空对象命中全部，字段按地图组/角色/公开 ID 过滤
ok - getPlayWorlds 回归：updatedAt 取自 manifest.createdAt，permissionHash 校验未放松
ok - 鉴权：复用 allowPlayLibraryAdmin，模式不符 404、坏密钥 401、正确密钥放行
# 13/13 passed        （修复 rename EPERM 竞态后连续 3 轮 13/13，确定性通过）
```

单测全部在 `os.tmpdir()` 临时目录内造 fixture，未触碰真实地图/真实数据。

**UNVERIFIED（逐行静态走查，未经真实运行时执行）**：
1. 两个 Next API 路由的实际 HTTP 行为（无 node_modules，Next 无法编译/启动）：走查确认导入深度与同目录既有路由逐字符一致（`play-admin/*.ts` 用 `../../../server/...`，`api/*.ts` 用 `../../server/...`）、handler 签名/方法门/错误形状复刻 `play-worlds.ts` 与 `worlds/[id].ts` 既有模式。
2. D1 页面消费路径（SSR 调用 `getPublicPlaySiteConfig()` 或 fetch 端点）未联调。
3. 真实容器内 `/app/play-worlds` 卷对 `site-config.json` 的写权限未实测（地图导入已写同目录，推断可写）。
4. 现网 WSL 侧数据目录（任务书称 `/app/apps/local-engine/play-worlds/<id>`；compose grep 实测目标为 `/app/play-worlds`，宿主 `<数据目录>/apps/local-engine/play-worlds`）——以 env 变量为准，路径差异不影响本实现（一切经 `BOX_PLAY_LIBRARY_PATH` 推导）。
5. jest 兼容层未用 jest 实跑（仅验证了"describe/test 存在则注册"的分支逻辑）；`*.test.ts` 命名与 `server/` 下既有惯例一致。
6. 外链 https 图源可能被现有 CSP `img-src` 拦截——未改 CSP；默认方案（cover 复用/站内路径）不受影响。

## 9. 需用户决策 / 遗留

- banner **本地上传**未做（理由见 §5）；若要做需定上传目录与静态路由（可能牵动卷配置）。
- `browseCount` 未来若要真数，需新增计数存储（写放大风险），本轮明确不提供。
- 单容器无库部署（仅 `BOX_WORLD_ID`）下：公开端点回默认配置（200），管理端点经 `allowPlayLibraryAdmin` 回 404「游玩地图库管理功能未开启」；如需支持该形态管理，设 `BOX_PLAY_SITE_CONFIG_PATH` 即可（写入不再依赖库存在——端点门仍要求库挂载，此为复刻既有 play-admin 语义，未放松）。
