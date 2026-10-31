# 检查与测试

所有命令从仓库根目录执行，先使用 Node.js `22.17.x` 安装依赖：`npm run install:all`。

## 默认 Verify 只做基础检查

```sh
npm run verify
```

只运行 Prettier 和 ESLint，检查格式、语法和代码风格。CI 与本地范围相同，不执行应用构建、类型检查、业务回归、依赖审计或 Compose 校验。基础检查无需启动 Docker、数据库或 Rust 编译。

PR 合入 `main`、`staging` 或 `release/v…` 时，`verify` 任务直接跳过，不安装依赖、不重复检查；这些分支的 push 也不运行 Verify。保留 PR 任务的跳过状态，是为了满足现有分支规则要求的 `verify` 状态，避免永久等待。`dev`、`dev-*`、`dev/**` 等开发分支继续执行基础检查。

## 按需选择检查

| 目标                    | 命令                                             | 前提                                                  |
| ----------------------- | ------------------------------------------------ | ----------------------------------------------------- |
| 类型检查                | `npm run typecheck`                              | 会先构建所需公共包与运行资源                          |
| 全套回归                | `npm run test`                                   | Node 原生依赖、Rust stable 与平台编译工具             |
| 工程与分发检查          | `npm run check`                                  | 会准备依赖并检查 Rust/分发实现                        |
| 依赖漏洞审计            | `node scripts/audit-dependencies.js`             | 网络可访问 registry；拒绝生产依赖中的 high / critical |
| 文档链接                | `node scripts/check-documentation.js`            | 检查本地文件、锚点和基础入口，不访问远程网站          |
| 当前源码 / Git 历史检查 | `npm run check:public` / `npm run check:history` | 历史检查扫描当前 Git 仓库                             |

详细检查不加入默认 Verify。类型检查、回归与工程检查会按依赖顺序构建公共包，运行 `prepare-assets` 后再检查资源。基础检查通过不能替代功能或目标平台验收。

## 模块命令速查

| 改动范围                     | 按需命令                                                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 工程、地图组、快照、导入导出 | `npm --prefix apps/local-engine test`                                                                                               |
| 网页、编辑器和账号服务       | `npm --prefix apps/game test -- --runInBand`                                                                                        |
| 实时连接与会话               | `npm --prefix apps/game run test:realtime`                                                                                          |
| 本地运行时会话               | `npm --prefix apps/game run test:local-runtime-session`                                                                             |
| 权威状态、资源与地图脚本     | `npm --prefix services/game-server test`                                                                                            |
| 反作弊与移动校验             | `npm --prefix services/game-server run check:anticheat`                                                                             |
| 玩家启动器                   | `npm --prefix apps/player-launcher run check`                                                                                       |
| 部署管理界面                 | `npm --prefix apps/deployment-manager run check`、`npm --prefix apps/deployment-manager test`                                       |
| 玩家后台                     | `npm --prefix apps/player-admin run typecheck`；管理 API 回归在 game / player-policy                                                |
| 登录门户                     | `npm --prefix apps/player-auth-portal run check`                                                                                    |
| HTTP API                     | `npm run api:check`、`npm --prefix internals/apis test`                                                                             |
| Rust 共享核心                | `cargo test --manifest-path apps/manager-core/Cargo.toml`                                                                           |
| Rust Web 管理器              | `cargo check --manifest-path apps/server-manager-rust/Cargo.toml`、`cargo test --manifest-path apps/server-manager-rust/Cargo.toml` |

VOXA 可分别运行 `check:model-library-scope`、`check:model-project-bundle`、`check:local-cors` 和 `check:model-management-permission`。默认皮肤或父窗口资源地址变化时，追加 `check:default-skin-scope` / `check:parent-storage-url`。使用 `npm --prefix apps/voxa run <脚本名>`。

不要混用运行器：Jest 使用 game 的 npm 脚本；Node test 和 TS 注册器以对应模块脚本为准。game Jest 默认输出终端报告，POSIX shell 设置 `JEST_HTML_REPORT=1` 可生成 HTML 报告。

独立公网登录回归：

```sh
npm --prefix apps/game test -- --runInBand --runTestsByPath server/player-login-transfer.test.ts server/player-login-transfer-store.test.ts server/player-service-public-auth.test.ts server/player-map-library-proxy.test.ts server/player-session-security.test.ts
npm --prefix apps/player-auth-portal test
```

覆盖跨域名/IP 回跳、子路径、会话与设备 Cookie、错误目标、校验值、过期、重放和会话撤销。上线验收时将门户与 Play / Creator 配为不同主机，分别验证首次登录、已有登录自动返回、退出后访问被拒绝；无需开放第三方 Cookie。

## 真实数据库测试

使用独立测试库，账号需允许创建/删除测试 schema；不要连接生产数据。命令不会自动读取根 `.env`，连接串特殊字符需 URL 编码。

```sh
MODERATION_TEST_DATABASE_URL='postgresql://<test-user>:<test-password>@127.0.0.1:5432/<test-database>' \
  npm --prefix apps/game test -- --runInBand --runTestsByPath server/script-moderation-store.test.ts

BOX_DATABASE_URL='postgresql://<test-user>:<test-password>@127.0.0.1:5432/<test-database>' \
  npm --prefix apps/game run test:realtime-postgres
```

前者使用 `moderation_test_*` schema 验证授权持久化；后者使用 `ws_regression_*` schema 验证事务、撤销事件和监听重连。测试结束清理自己创建的 schema 和连接。PowerShell 用 `$env:<变量名>` 设置环境后执行 npm 命令。

未设置 `MODERATION_TEST_DATABASE_URL` 时，对应 Jest 用例显示 skipped。`check:postgres-storage` 使用 pg-mem，`check:redis-runtime` 使用内存适配器；它们不等于真实服务连接测试。

## 桌面、镜像与业务验收

| 改动                       | 实际验收                                       |
| -------------------------- | ---------------------------------------------- |
| `.boxproject` / `.boxplay` | 导出、重新导入、检查旧格式，再进入 Play        |
| 权限与登录                 | 普通玩家、创作者、管理员分别操作，验证拒绝路径 |
| 实时连接与传送             | 两名玩家连接、会话撤销、跨地图与重连           |
| VOXA                       | 保存模型、加入地图、发布后检查资源             |
| 镜像、管理器与备份         | 在独立数据目录启动目标产物，检查升级和恢复     |
| 玩家启动器                 | 实际启动 Electron、连接服务器、检查菜单与缓存  |

玩家启动器图形测试需要桌面会话；Linux CI 需要显示服务和系统库：

```sh
npm --prefix apps/player-launcher run test:desktop
npm --prefix apps/player-launcher run test:menu
npm --prefix apps/player-launcher run test:cache
```

根详细测试会检查 Rust Web 管理器，但不编译或运行 Tauri 桌面 App。原生环境见[部署管理器](../apps/deployment-manager/README.md)；实际操作见[首个作品教程](first-project.md)。

## 记录结果

记录执行命令、退出码、失败与 skipped 原因，以及测试的提交、镜像版本和平台。清理仅限测试创建的临时目录/schema，不删除开发数据或 Docker 卷。日志与截图移除 Token、Cookie、数据库凭据和玩家资料。

发布流水线使用 `node scripts/check-public-repository.js` 检查当前源码中的内部文件、凭据和运行数据；已删除的历史文件不属于本次打包输入。该检查也可在本机单独运行，检测结果不输出凭据明文。

Git 全历史审计单独运行：`node scripts/check-public-history.js /absolute/path/to/public-candidate.git`。脚本扫描完整克隆中全部可达引用；二进制及大于 8 MiB 的 blob 不做内容扫描。当前源码检查通过，不代表旧历史已经清理；公开源码时还需处理历史中的敏感记录。该检查不会改写历史或发布仓库。
