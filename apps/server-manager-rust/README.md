# Rust Web 管理器

为 Linux 无桌面部署提供管理 HTTP API、静态界面、事件连接和 Docker 子运行时管理。界面来自[部署管理器](../deployment-manager/README.md)，规则复用[共享核心](../manager-core/README.md)。开服使用[服务器包](../../distribution/server/README.md)。

## 代码入口

| 位置                                | 职责                                 |
| ----------------------------------- | ------------------------------------ |
| `src/main.rs`、`src/http/`          | 启动、路由、认证、静态文件和归档传输 |
| `src/platform/`、`src/runtime/`     | 配置、备份、镜像与子运行时           |
| `src/operations.rs`、`src/tests.rs` | 长操作进度与回归                     |

## 运行配置

| 变量                                                  | 默认或用途                                    |
| ----------------------------------------------------- | --------------------------------------------- |
| `BOX_SERVER_MANAGER_ROOT`                             | `/workspace` 部署根                           |
| `BOX_SERVER_MANAGER_COMPOSE_FILE`                     | 根目录 `compose.yml`；源码 Compose 需显式指定 |
| `BOX_SERVER_MANAGER_ENV_FILE`                         | 根目录 `.env`                                 |
| `BOX_SERVER_MANAGER_PUBLIC_DIR`                       | `/app/public` 预构建界面                      |
| `BOX_SERVER_MANAGER_HOST` / `BOX_SERVER_MANAGER_PORT` | 原生服务默认 `0.0.0.0:3130`                   |
| `BOX_SERVER_MANAGER_TOKEN`                            | Web 管理令牌，启动时校验强度                  |
| `BOX_RUNTIME_MANAGER_TOKEN`                           | 内部运行时密钥，与登录令牌独立                |

宿主机绑定由 Compose 的 `BOX_SERVER_MANAGER_BIND_IP` 控制。运行需要 Docker CLI、Compose、Socket 和预构建界面；直接 `cargo run` 不会准备完整部署包。保护管理入口与令牌，不公开 Docker Socket。

## 按需检查

```sh
cargo check --manifest-path apps/server-manager-rust/Cargo.toml
cargo test --manifest-path apps/server-manager-rust/Cargo.toml
node scripts/check-headless-rust-manager.js
```

根目录执行，需要 Rust stable 和平台编译工具，无需 Tauri/WebKitGTK。基础 Verify 不执行这些命令。实际安装、登录、服务控制与恢复仍需使用独立数据目录验收。
