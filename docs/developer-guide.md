# 开发入门

本文用于源码开发。安装发行版见[项目首页](../README.md)，第一次创作见[首个作品教程](first-project.md)。所有未特别标注的命令都在仓库根目录执行。

## 准备环境

| 工具                                | 用途                           |
| ----------------------------------- | ------------------------------ |
| Node.js `22.17.x`、Git              | 安装依赖、开发与基础检查       |
| Docker Engine / Desktop、Compose v2 | 开发数据库、镜像构建和部署     |
| Rust stable、平台工具链             | 原生管理器开发与按需 Rust 测试 |
| Python 3、C/C++ 编译工具            | 需要本机编译的 Node 原生依赖   |

无需全局安装 Rush 或 pnpm，仓库脚本使用 `rush.json` 中的固定版本。TypeScript、React 等共享版本以 `common/config/rush/common-versions.json` 为准。

macOS 使用 Xcode Command Line Tools；Windows 使用 MSVC / WebView2；Linux 桌面管理器需要 WebKitGTK。安装步骤见[部署管理器](../apps/deployment-manager/README.md)。基础 `verify` 不编译 Rust。

## 安装与启动

```sh
npm run install:all
cp .env.docker.example .env
npm run check:workspace
npm run dev:infra
```

已有 `.env` 时跳过复制。Windows PowerShell 使用 `Copy-Item .env.docker.example .env`。不要在各工作区目录独立安装依赖或删除共享锁文件。

| 数据库来源      | 配置与命令                                            |
| --------------- | ----------------------------------------------------- |
| 开发用容器      | 启动 Docker 后运行 `npm run dev:infra`                |
| 已有 PostgreSQL | 在 `.env` 设置 `BOX_DATABASE_URL`，运行 `npm run dev` |

已有数据库的示例：

```dotenv
BOX_DATABASE_URL=postgresql://<test-user>:<test-password>@127.0.0.1:5432/<test-database>
BOX_DATABASE_SCHEMA=box_engine
BOX_IDENTITY_DATABASE_SCHEMA=box_identity
```

连接串中的特殊字符需 URL 编码。源码进程运行在宿主机，不能使用仅在 Docker 网络中解析的 `postgres` 地址。Player Service 必须连接 PostgreSQL；Redis 可选，启动 Redis 容器后仍需配置 `REDIS_HOST` 等业务连接字段。

开发脚本读取根 `.env`，设置本地配置、服务地址和共享开发密钥。未指定的内部密钥会在启动时生成，重启后可能需要重新登录。服主令牌 `BOX_PLAY_ADMIN_TOKEN` 需自行配置，操作见[首个作品教程](first-project.md)。已有数据库卷的密码不会随 `.env` 修改而自动改变。

## 默认入口

首次启动会构建公共依赖。等待日志显示服务就绪，再访问：

| 服务           | 地址                     | 用途             |
| -------------- | ------------------------ | ---------------- |
| 登录门户       | `http://127.0.0.1:3125/` | 注册和玩家登录   |
| Creator        | `http://127.0.0.1:3127/` | 编辑、预览和发布 |
| VOXA           | `http://127.0.0.1:3123/` | 模型、皮肤与动画 |
| Play           | `http://127.0.0.1:3121/` | 已导入的发布地图 |
| Player Service | `http://127.0.0.1:3124/` | 身份与管理 API   |
| 玩家管理后台   | `http://127.0.0.1:8000/` | 服主和管理员操作 |

普通玩家注册后没有创作或后台权限；由服主授权。源码栈使用固定开发端口，修改 Compose 端口变量不会自动改变整套源码栈。

## 数据保存位置

```text
.local-data/
  apps/local-engine/
    projects/       可编辑工程
    play-worlds/    已导入游玩包
    data/           本机运行资源与配置
    backups/        工程备份
    dist/           工程与游玩包导出
    runtime-cache/  可重新生成的缓存
  apps/voxa/data/   模型库
  build-assets/    资源构建中间产物
```

`.local-data/` 被 Git、镜像构建和格式工具忽略。`BOX_DEV_DATA_DIRECTORY` 可更换开发数据根；资源构建缓存固定保存在仓库 `.local-data/build-assets/`。首次启动会迁移旧工程、模型和导出数据，保留非空目标，后续不重复导入。

| 数据类型                 | 位置与备份方式                                           |
| ------------------------ | -------------------------------------------------------- |
| 开发工程与模型           | `.local-data/`；作品通过 `.boxproject` / `.boxplay` 迁移 |
| 引擎内置资源             | `apps/local-engine/data/blobs/`，纳入源码与镜像构建输入  |
| 账号、权限和脚本持久数据 | PostgreSQL；单独做数据库备份                             |
| Docker 部署数据          | `BOX_DATA_DIRECTORY` 下的应用目录和数据库卷              |
| 桌面部署数据             | 系统应用数据目录，由部署管理器管理                       |

## 常用命令

| 任务                       | 命令                                                              |
| -------------------------- | ----------------------------------------------------------------- |
| 启动创作栈与开发数据库     | `npm run dev:creator:infra`                                       |
| 调试玩家后台               | `npm run dev:admin`，需后端已运行                                 |
| 调试部署管理器             | `npm run dev:manager` / `npm run dev:manager:native`              |
| 调试玩家启动器             | `npm run dev:player-launcher`                                     |
| 构建项目与依赖             | `npm run build -- --to @box/player-admin`                         |
| 更新依赖与锁文件           | `npm run update:all`                                              |
| 格式化 / 只检查格式        | `npm run format` / `npm run format:check`                         |
| 基础语法、风格和格式检查   | `npm run verify`                                                  |
| 按需类型 / 回归 / 工程检查 | `npm run typecheck` / `npm run test` / `npm run check`            |
| API 生成 / 同步检查 / 文档 | `npm run api:generate` / `npm run api:check` / `npm run api:docs` |
| 文档链接检查               | `node scripts/check-documentation.js`                             |

额外参数放在 `--` 后。修改依赖后提交清单与 `common/config/rush/pnpm-lock.yaml`；新增项目登记到 `rush.json`。公共包修改后可能需要重新构建和重启。

## 停止与排障

源码终端按 Ctrl+C 停止子服务。开发数据库容器继续保留，需要时单独停止：

```sh
docker compose --profile infra stop postgres redis
```

| 现象                  | 优先检查                                          |
| --------------------- | ------------------------------------------------- |
| Docker 连接失败       | Docker 是否启动，Compose v2 是否可用              |
| 数据库拒绝连接        | Player Service 日志、宿主机地址、原有账号与卷凭据 |
| 登录或创作被拒绝      | 登录门户、玩家身份、服主授予的创作权限            |
| 端口占用              | 是否重复启动了完整栈或独立界面                    |
| 修改后仍是旧行为      | 公共包是否重建；部署镜像是否仍为旧版本            |
| Rush 提示已有命令运行 | 等待现有安装或构建结束，不删除锁文件              |

故障报告附执行命令、系统/架构、提交与首个错误日志，移除密钥和玩家信息。不要删除数据库卷排障。下一步：[架构](architecture.md) · [测试](testing.md) · [贡献](../CONTRIBUTING.md) · [发布](release-and-version.md)。
