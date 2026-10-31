# 玩家启动器维护

## 修改入口

| 位置                                                     | 职责                                  |
| -------------------------------------------------------- | ------------------------------------- |
| `src/main.ts`、`application/`                            | 页面组装、服务器会话与状态            |
| `src/api/player-api.ts`                                  | 生成客户端与请求协调                  |
| `src/features/servers/`、`player/`、`maps/`、`storage/`  | 服务器、账号、地图与存储操作          |
| `src/views/`、`src/styles/`                              | 展示与样式                            |
| `electron/main.ts`、`electron/application/commands.ts`   | 生命周期、IPC 来源校验与命令分发      |
| `electron/network/`、`runtime/`、`storage/`、`security/` | 网络、游戏窗口、缓存和本机安全        |
| `shared/`                                                | 无 DOM/Electron 依赖的地址与 API 策略 |

公开 HTTP 类型使用 `@box/apis`；本机 UI 状态在 `src/types.ts`。新增接口先修改共享契约，再更新 `shared/api-policy.ts` 和客户端。不在页面中拼接私有 API 或建立第二套离线文件协议。

## 进程与请求

渲染进程通过受限 IPC 调用本机能力；主进程模块不依赖 DOM。每次登录/退出更新请求代次，旧响应不覆盖新会话。

| 项目                | 规则                                                                         |
| ------------------- | ---------------------------------------------------------------------------- |
| 普通 API / 登录期限 | 15 秒 / 30 秒，包含响应体读取；登录不自动重试                                |
| 会话过期            | 受保护 API 的 401 回到登录页；登录接口 401 表示凭据错误                      |
| 本机诊断            | 最近 100 次写入 `network-diagnostics.json`，只含接口路径、耗时和状态等元数据 |
| 禁止记录            | 密码、Cookie、请求/响应正文、用户名和启动票据                                |

## 缓存与账号数据

| 数据            | 位置与清理边界                                                              |
| --------------- | --------------------------------------------------------------------------- |
| 地图资源        | 独立 Chromium Session 的 `box-play-static:<永久地图ID>:<版本>` CacheStorage |
| HTTP 缓存       | 由 Session 汇总展示，不分配给单张地图                                       |
| 地图清理        | 仅删除对应地图 CacheStorage，保留 Cookie 和 HTTP 缓存                       |
| 浏览器缓存清理  | 清理已添加服务器的 HTTP 缓存，保留地图缓存与 Cookie                         |
| 收藏与最近游玩  | 服务器 `/api/play-library`，使用当前玩家 Cookie 与 publicId                 |
| `map-labels.ts` | 永久 ID 到公开名称的本机缓存索引，不是收藏数据库                            |

缓存统计是实际存储字节，不是流量。HTTPS 和本机 HTTP 可预热，其他 HTTP 在线读取；规则在 `shared/server-address.ts`。底层 `clearResourceCache` 会同时清 Service Worker、CacheStorage 和 HTTP 缓存，与界面的分项清理不同。

## 检查与发行边界

模块根运行 `npm run check`，构建后按需执行 `test:desktop`、`test:menu`、`test:cache`。测试使用临时 profile，不读写玩家真实缓存；`BOX_LAUNCHER_SMOKE_ROOT` 可指向最终 app.asar 检查实际产物。

发行保留 `dist/`、`dist-electron/main.cjs` 和 `preload.cjs`。Vite/esbuild 已打包代码，`@box/apis` 为开发依赖。`after-pack.ts` 裁剪演示文件和语言资源，不删除 Chromium 运行库。

打包后检查 `file://` 下图片、模块与预加载脚本。版本、签名与 OSS 规则见[发布说明](release.md)。
