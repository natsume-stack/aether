# 登录门户接口与定制

适用于本模块和导出的独立模板。启动方式见[门户 README](../README.md)，这里说明页面接口、后端代理和运行配置。

## 页面定制

| 文件                              | 修改内容                  |
| --------------------------------- | ------------------------- |
| `src/app.tsx`、`src/forms.tsx`    | 布局、登录/账号表单和提示 |
| `src/styles/theme.css`、`app.css` | 颜色与页面样式            |
| `public/index.html`、`public/`    | 标题、logo、图片与字体    |

只修改源码，不编辑生成的 `public/app.js`、`theme.js` 或 `styles.css`。输入中文时保留输入框节点与组合输入状态，避免每次输入都重建表单。

## 六种账号操作

页面调用 `PortalClient`，前后端请求均使用 `@box/apis` 的 OpenAPI 生成客户端。门户后端添加 `X-Box-Player-Auth-Key`，通过对应的命名方法请求玩家服务。新增字段先更新契约并生成类型，不手写请求路径。

| 功能 | 客户端方法                                     | 门户接口                  | 正文                                  |
| ---- | ---------------------------------------------- | ------------------------- | ------------------------------------- |
| 登录 | `login(username, password)`                    | `POST /api/auth/login`    | `username`、`password`                |
| 注册 | `register(username, displayName, password)`    | `POST /api/auth/register` | `username`、`displayName`、`password` |
| 会话 | `session()`                                    | `GET /api/auth/session`   | 无                                    |
| 退出 | `logout()`                                     | `POST /api/auth/logout`   | `{}`                                  |
| 昵称 | `updateNickname(displayName)`                  | `PATCH /api/auth/profile` | `displayName`                         |
| 密码 | `changePassword(currentPassword, newPassword)` | `POST /api/auth/password` | `currentPassword`、`newPassword`      |

```ts
import { PortalClient } from './client';

const client = new PortalClient();
const result = await client.login(username, password);
if (result.returnUrl) {
    location.assign(result.returnUrl);
}
```

| 输入或响应                      | 规则                                               |
| ------------------------------- | -------------------------------------------------- |
| 用户名                          | 3–32 位，字母开头，只含字母、数字和下划线          |
| 昵称                            | 去首尾空白后 1–32 位，支持中文，不允许换行         |
| 新密码                          | 10–128 位，不自动裁剪空格；确认密码只在页面比较    |
| 注册成功                        | 同时建立登录，无需重复调用 login                   |
| `session.player === null`       | 正常未登录状态                                     |
| `registrationEnabled === false` | 隐藏注册入口，后端同时拒绝注册                     |
| `reloginRequired`               | 改密成功已撤销会话，清空密码与玩家状态，回到登录页 |

改昵称和改密不接受用户 ID、角色、头像或权限字段。当前没有头像上传、邮件/短信验证或无凭据密码找回接口。

## 导航与错误

Creator / Play 可以传入 `source`、`returnUrl`。客户端携带导航参数，后端只允许返回配置中的 Creator / Play 源。页面只使用返回结果的 `returnUrl`，不直接信任查询参数。

| 情况                  | 页面处理                                         |
| --------------------- | ------------------------------------------------ |
| 登录账号/密码错误     | 留在登录表单，显示 `PortalClient.message(error)` |
| 当前会话过期          | 回到登录页                                       |
| 原密码错误            | 留在改密表单                                     |
| 429                   | 保留 Retry-After，暂停提交，不连续自动重试       |
| Player Service 不可用 | 显示服务异常，不伪装成密码错误或登录成功         |

## 真实联调配置

在模块或模板根复制 `.env.example` 为 `.env`，填测试服务配置，再运行 `npm run dev:live`。该模式会操作真实账号，使用独立测试玩家。

| 变量                                            | 用途                                                                                         |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `BOX_PLAYER_SERVICE_INTERNAL_URL`               | 上游 Player Service；源码常为 `http://127.0.0.1:3124`，容器常为 `http://player-service:3213` |
| `BOX_PLAYER_AUTH_API_KEY`                       | 与上游一致的服务密钥，只在后端使用                                                           |
| `BOX_AUTH_PORTAL_PUBLIC_URL`                    | 门户公开地址                                                                                 |
| `BOX_PLAY_PUBLIC_URL`、`BOX_CREATOR_PUBLIC_URL` | 允许返回的页面地址                                                                           |
| `BOX_PLAYER_REGISTRATION_ENABLED`               | 注册开关                                                                                     |
| `HOST`、`PORT`                                  | 监听地址与端口                                                                               |

标准配置优先于兼容的 `AUTH_DEMO_*` 字段。不同公网地址通过一次性登录码共享会话，不要求共同 Cookie 域。页面须保留 `source`、`returnUrl`、`transferState` 和 `transferChallenge`，并按后端返回的 `returnUrl` 回跳。域名配置不会自动生成证书。

独立模板在 `vendor/apis` 中携带同一份 SDK 源码，构建时打包进前后端产物；运行镜像不需要额外安装工作区依赖。

## 复用或实现后端

```ts
import { PortalConfig, PortalServer } from './server';

const portal = new PortalServer(PortalConfig.fromEnvironment());
await portal.listen();
// 停止：await portal.close()
```

可用 `portal.handle(request, response)` 接入现有 Node HTTP 服务。工作目录不同于模板根时，通过 `publicDirectory` 指定静态目录。

| 责任       | 要求                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------- |
| 上游请求   | 固定 `/api/player-auth/{login,register,session,logout,profile,password}`，保持方法和允许字段 |
| 会话       | 转发 `box_local_player_session` 和 `box_local_player_device` Cookie                          |
| 响应       | 多条 Set-Cookie 逐条转发；Node 22 可用 `headers.getSetCookie()`，不能逗号合并                |
| 来源与正文 | 写请求验证实际 Origin；仅可信代理使用转发头；JSON 限 32 KiB                                  |
| 静态文件   | 只服务 public，验证符号链接与真实路径                                                        |
| 生产监听   | 镜像监听 `0.0.0.0:3214`，提供 `GET /api/health-check` 和 HEALTHCHECK                         |

`PortalConfig` 管配置，`AuthOperation` 管操作字段，`AuthPolicy` 管策略，`PlayerServiceClient` 管上游请求，`AuthProxy` 协调代理。不要扩展成任意路径代理。

## 打包前验收

使用 `npm run check`，再实际检查：登录/注册/退出、关闭注册、中文昵称、错误原密码、改密后旧会话失效、Creator/Play 回跳、上游停机提示，以及导入镜像后的健康状态。

打包、导入和独立源码导出命令见[门户 README](../README.md)。模拟服务不覆盖真实 Cookie、设备、封禁和限流行为。
