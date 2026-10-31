# 管理器共享核心

`box-manager-core` 是 Rust 库，供 Tauri 桌面管理器和 Rust Web 管理器共享部署规则。它不单独启动，平台路径、HTTP、窗口与进程适配留在调用方。

| 模块                                                      | 职责                       |
| --------------------------------------------------------- | -------------------------- |
| `configuration`、`configuration_migration`、`environment` | 配置、迁移和运行环境       |
| `services`、`map_runtime_profiles`                        | 服务控制与地图运行时配置   |
| `backup`、`backup_store`                                  | 备份校验、创建、导入和恢复 |
| `auth_portal`、`ssl`、`access_settings`                   | 登录镜像、证书和访问设置   |
| `operation`                                               | 管理修改操作的并发保护     |

## 备份边界

相对部署根目录归档 `apps/local-engine/{projects,dist,play-worlds}` 和 `apps/voxa/data`，可包含根 `.env`。默认恢复保留当前 `.env`，仅显式选择时替换。

归档不包含外部 PostgreSQL/Redis 或整个 Docker 卷。恢复前停止实际写入者，并通过 `backup` 的路径、大小与回滚校验，不直接解压上传内容。

## 按需检查

```sh
cargo test --manifest-path apps/manager-core/Cargo.toml
cargo check --manifest-path apps/server-manager-rust/Cargo.toml
node scripts/check-desktop-deployment-manager.js
node scripts/check-headless-rust-manager.js
```

从仓库根执行，需要 Rust stable。共享规则变化时核对桌面和 Web 两端；基础 Verify 不执行这些检查。原生环境见[部署管理器](../deployment-manager/README.md)。
