# 独立 Play 分发部署

服主需要 Docker Engine / Desktop、Compose v2 和 PostgreSQL，无需项目源码或 Node.js。地图通过 `.boxplay` 导入，增加地图不重建镜像。

## 文件与配置

```text
play-image.tar
player-service-image.tar
compose.yml
.env.example
play-worlds/
```

正式导出目录还包含构建记录、许可说明和 `SHA256SUMS`；Linux 使用 `sha256sum -c SHA256SUMS`，macOS 使用 `shasum -a 256 -c SHA256SUMS` 校验。

复制 `.env.example` 为 `.env`，设置：

| 配置                      | 用途                                                                     |
| ------------------------- | ------------------------------------------------------------------------ |
| `PERMISSION_TOKEN_SECRET` | 至少 32 字节随机秘密，使用 `openssl rand -hex 32` 生成，升级和重启时保留 |
| `BOX_DATABASE_URL`        | PostgreSQL 连接                                                          |
| `BOX_PLAYER_AUTH_API_KEY` | 至少 16 字符，仅供登录门户后端与 Player Service 共用                     |
| `BOX_PLAYER_LOGIN_URL`    | 服主部署的登录页地址；留空显示未开启登录                                 |
| `BOX_PLAY_ADMIN_TOKEN`    | 玩家后台的服主令牌                                                       |

登录与注册页面单独部署，Play 和 Player Service 不内置玩家登录页。

## 启动与导入地图

```sh
docker image load --input play-image.tar
docker image load --input player-service-image.tar
mkdir -p play-worlds
docker compose up -d
docker compose ps
```

默认 Play 为 `http://127.0.0.1:3121/`，玩家后台为 `http://127.0.0.1:3124/players`。使用服主身份在“游玩管理 → 游玩地图”导入 `.boxplay`，检查内容后开放地图组。也可把完整发布目录放入 `play-worlds/<作品ID>/`。

`play-storage-init` 只初始化缓存卷，`Exited (0)` 表示成功。Play 主容器仍以非 root 用户运行。

## 缓存与传送

| 内容           | 配置                                                                            |
| -------------- | ------------------------------------------------------------------------------- |
| 预烘焙缓存     | 保存在 `box-play-runtime-cache` 卷，可重建，不包含账号或脚本持久数据            |
| 常驻运行时数量 | `BOX_PLAY_PREWARM_RUNTIMES`，设为 `0` 关闭，不超过 `BOX_PLAY_MAX_RUNTIMES`      |
| 跨地图传送     | `world.teleport(mapId, players, serverId?)`，默认创建独立私有房间               |
| 私有房间限制   | `BOX_TELEPORT_MAX_ROOMS`、`BOX_TELEPORT_ROOM_IDLE_TIMEOUT_MS`；仍计入运行时上限 |

## 更新与备份

```sh
docker compose down
docker image load --input play-image.tar
docker image load --input player-service-image.tar
docker compose up -d
```

两个镜像可独立更新。保留 `.env`、地图目录和数据库备份；作品包与缓存卷不能代替 PostgreSQL `pg_dump` 或快照。

远程访问时配置实际公开地址和 HTTPS，管理路由、数据库、Redis 不直接公开。详细安装和网络说明见[服务器指南](../server/README.md)。
