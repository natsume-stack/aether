# 本地引擎控制层

`apps/local-engine` 管理工程、地图组、快照、导入导出、资源和运行时生命周期。源码启动优先使用根目录 `npm run dev:infra`；普通安装使用[项目首页](../../README.md)的发行入口。

## 服务与部署命令

以下命令在 `apps/local-engine` 目录执行，用于 Docker 调试；后缀 `-up` 表示使用已有镜像。

| 服务           | 构建并启动                              | 默认宿主机入口           |
| -------------- | --------------------------------------- | ------------------------ |
| Creator        | `node src/deploy.js creator`            | `http://127.0.0.1:3127/` |
| Play           | `node src/deploy.js play`               | `http://127.0.0.1:3121/` |
| VOXA           | `node src/deploy.js voxa`               | `http://127.0.0.1:3123/` |
| Player Service | `node src/deploy.js player-service`     | `http://127.0.0.1:3124/` |
| 登录门户       | `node src/deploy.js player-auth-portal` | `http://127.0.0.1:3125/` |

例如 `node src/deploy.js creator-up`；停止本仓库服务使用 `node src/deploy.js stop`。地址与端口以实际配置为准。

## 数据与格式

| 内容                            | 用途                                                           |
| ------------------------------- | -------------------------------------------------------------- |
| `.boxproject`                   | 可编辑地图或地图组备份，用于迁移和继续创作                     |
| `.boxplay`                      | 已发布地图组快照，供 Play 导入，不包含可编辑 `source/`         |
| 地图组                          | 一个主地图与可选副地图；地形和实体独立，共享组资源与组数据空间 |
| `apps/local-engine/data/blobs/` | 引擎内置与构建资源，整个目录纳入源码和镜像构建输入             |

| 运行方式       | 作品数据根                                                           |
| -------------- | -------------------------------------------------------------------- |
| 源码开发       | `.local-data/apps/local-engine/`，可由 `BOX_DEV_DATA_DIRECTORY` 调整 |
| Docker Compose | `BOX_DATA_DIRECTORY` 下的 `apps/local-engine/`                       |
| 桌面部署       | 系统应用数据目录的 `runtime/apps/local-engine/`                      |

数据根内包含 `projects/`、`play-worlds/`、`backups/`、`dist/` 等目录。不要手改工程状态、资源哈希或发布清单；不同运行环境之间通过作品包或备份迁移。作品备份不包含 PostgreSQL。

Creator 只导出作品数据，镜像与桌面安装包由构建脚本生成。Play 导入后管理开放状态和访问 ID，不直接修改发布快照。

## 资源与检查

选择“仅本地资源”会将地图所需资源放入游玩包；选择 OSS 引用时，游玩仍需访问发布者的对象存储。内置资源和默认皮肤不依赖 BOX3 云端。

```sh
# 仓库根目录执行
npm --prefix apps/local-engine run prepare-assets
npm --prefix apps/local-engine test
```

构建中间产物存放 `.local-data/build-assets/`，最终运行与旧地图迁移资源写回源码 blob 目录。开发地图、模型、导出和缓存不放进内置资源目录。

操作教程见[首个作品](../../docs/first-project.md)，代码职责见[架构](../../docs/architecture.md)。
