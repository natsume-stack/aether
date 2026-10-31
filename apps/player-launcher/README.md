# 玩家启动器

Electron 玩家客户端：添加服务器、登录、选择地图并游玩。不负责安装 Docker、部署服务器或管理服主配置；开服使用[部署管理器](../deployment-manager/README.md)。

## 使用与数据

| 功能         | 行为                                                     |
| ------------ | -------------------------------------------------------- |
| 服务器与账号 | 每个服务器独立会话；系统加密存储，不保存密码             |
| 地图列表     | 搜索名称/作者；收藏和最近游玩来自当前服务器玩家账号      |
| 游戏窗口     | 使用 Chromium，支持 Pointer Lock                         |
| 地图缓存     | HTTPS / 本机 HTTP 可预热公开资源；其他 HTTP 按需在线读取 |
| 本机存储     | 分别展示和清理地图 CacheStorage 与浏览器 HTTP 缓存       |

Linux 无安全密钥存储时只保留内存会话，不回退到明文。服务端会话失效后回到对应服务器登录表单。启动器不支持离线导入 `.boxplay`，也不缓存账号密码或服务端脚本。

## 开发与打包

先按[开发入门](../../docs/developer-guide.md)安装工作区依赖，再在仓库根运行：

```sh
npm run dev:player-launcher
```

该命令准备 API 依赖并启动 Electron/Vite。模块的 `dev:electron` 用于已准备依赖后的调试；页面不直接获得 Node 权限，本机能力通过受限 IPC 提供。

| 任务                   | 根目录命令                                                        |
| ---------------------- | ----------------------------------------------------------------- |
| 类型、构建与回归       | `npm --prefix apps/player-launcher run check`                     |
| 实际桌面 / 菜单 / 缓存 | 同模块 `test:desktop` / `test:menu` / `test:cache`                |
| macOS ARM64 包         | `npm run package:player-launcher:macos-arm64`                     |
| Windows 包             | `npm run package:player-launcher:windows-amd64` / `windows-arm64` |
| Linux 包               | `npm run package:player-launcher:linux-amd64` / `linux-arm64`     |

每个安装包在目标系统与架构上构建。Electron/Chromium 是主要包体，工作区依赖会被打包，不复制整个 node_modules。

维护入口见[维护说明](docs/maintenance.md)，测试与正式版本见[发布说明](docs/release.md)。
