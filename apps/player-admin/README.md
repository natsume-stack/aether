# 玩家管理后台

管理玩家、权限、游玩地图和运行时。它通过 `@box/apis` 访问 Player Service；后台管理账号与玩家登录账号独立。

## 首次使用

1. 根 `.env` 设置随机 `BOX_PLAY_ADMIN_TOKEN`（至少 16 字符），重启源码栈。
2. 打开 `http://127.0.0.1:8000/`，选择“服主登录”。
3. 在“服主管理”创建权限组，再创建独立管理账号，初始密码至少 12 位。
4. 玩家在登录门户注册后，由服主在“创作管理 → 创作权限”开启创作端并授予能力。

日常管理员选择“管理员登录”。Linux Web 部署管理器的 `BOX_SERVER_MANAGER_TOKEN` 不能用于此入口。具体步骤见[首个作品教程](../../docs/first-project.md)。

## 代码入口

| 位置                                    | 用途                   |
| --------------------------------------- | ---------------------- |
| `src/pages/shell/`、`src/pages/access/` | 页面导航、服主和权限组 |
| `src/pages/creator/`、`src/pages/maps/` | 创作授权和游玩包       |
| `src/player-admin-api.ts`               | 生成客户端适配         |

地图由“游玩管理 → 游玩地图 → 导入游玩包”添加；先检查脚本与媒体，再确认并开放地图组。界面能力判断不能替代服务端鉴权。

## 开发

完整栈使用根 `npm run dev:infra`。独立调试使用 `npm run dev:admin`，需后端已启动。

按需检查：`npm --prefix apps/player-admin run typecheck` / `build`。本模块没有独立测试脚本，管理 API 与权限回归在 game 和 player-policy；默认 Verify 仅检查基础格式与风格。
