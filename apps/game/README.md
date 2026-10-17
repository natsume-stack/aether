# 网页编辑器与玩家服务

`apps/game` 为 Creator、Play 和 Player Service 提供页面与 HTTP 服务，按 `BOX_DEPLOYMENT_MODE` 构建不同产物。

| 模式           | 页面与职责                                                           |
| -------------- | -------------------------------------------------------------------- |
| Creator        | `/projects` 工程管理、`/e/<project-id>` 编辑、`/p/<project-id>` 预览 |
| Play           | 发布地图库、`/p/<publicId>` 游玩、会话与资源转发                     |
| Player Service | 玩家身份、管理 API、玩家后台静态资源                                 |

Creator 和 VOXA 使用获授权玩家的创作能力；后台管理使用独立管理会话。Play 的地图来自已导入 `.boxplay`，不会自动显示 Creator 工程。

## 开发与部署

源码开发在仓库根目录运行：

```sh
npm run dev:infra
```

Docker 调试入口也从仓库根目录执行：

```sh
node apps/local-engine/src/deploy.js creator
node apps/local-engine/src/deploy.js play
node apps/local-engine/src/deploy.js stop
```

开发地址见[开发入门](../../docs/developer-guide.md)。容器网页监听 `3000`，宿主机端口由部署配置映射，不能与源码端口混用。

## 代码入口

| 位置                                 | 用途                           |
| ------------------------------------ | ------------------------------ |
| `pages/`                             | 页面与 HTTP 路由               |
| `server/`                            | 身份、管理、实时连接与代理实现 |
| `src/views/edit/`、`src/views/play/` | 创作和游玩界面                 |
| `src/engine/`                        | 浏览器游戏引擎                 |
| `shared/`                            | 页面与服务共用逻辑             |

浏览器通过同源入口访问会话、资源和 WebSocket，网页服务转发到内部 game-server。Play 使用独立构建，移除编辑器、Monaco 和工程写入入口；不要将 Creator 产物当作游玩镜像。

按需检查：`npm --prefix apps/game run lint`、`npm --prefix apps/game test -- --runInBand`。接口变更同步 `@box/apis`；完整范围见[检查与测试](../../docs/testing.md)。
