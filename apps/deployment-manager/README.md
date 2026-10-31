# 部署管理器

桌面版和 Linux Web 管理端共用 Vite 界面。Tauri 适配本机桌面操作，Rust Web 管理器提供 HTTP 后端，共享规则位于 [manager-core](../manager-core/README.md)。玩家连接服务器使用另一个[玩家启动器](../player-launcher/README.md)。

## 代码职责

| 位置                                    | 职责                              |
| --------------------------------------- | --------------------------------- |
| `src/main.js`、`src/core/`              | 启动、状态与渲染请求              |
| `src/app/`、`src/app/bindings/`         | 页面组装和事件绑定                |
| `src/views/`、`src/styles/`             | 展示结构和样式                    |
| `src/configuration/`、`src/operations/` | 配置读取、校验与服务操作          |
| `src/infrastructure/`                   | Tauri / Web 传输与生成 API 客户端 |
| `src/ui/`、`src/utils/`                 | 通用界面和工具                    |

页面只读取状态并发出操作，服务调用由 operation 和传输层完成。渲染器在入口注册，避免循环依赖。前端手写 JS/CSS 文件少于 500 行，构建前检查结构和导入。

## 启动与检查

先按[开发入门](../../docs/developer-guide.md)安装依赖，从根目录执行：

```sh
npm run dev:manager
npm run dev:manager:native
```

第一条调试网页，第二条调试 Tauri；分别运行，不要同时占用端口。独立网页仍需 Rust Web 后端才能控制服务。

按需运行 `npm --prefix apps/deployment-manager run check` / `test`，以及 `node scripts/check-desktop-deployment-manager.js`。这些详细检查不属于基础 Verify。

## 原生工具链

所有平台使用 Rust stable；[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) 为系统依赖来源。

| 平台       | 准备                                                                        |
| ---------- | --------------------------------------------------------------------------- |
| macOS      | `xcode-select --install`，确认 `xcode-select -p`                            |
| Windows    | Visual Studio 2022 Build Tools 的 C++ 桌面组件、MSVC、Windows SDK、WebView2 |
| Linux 桌面 | C/C++、pkg-config、OpenSSL、WebKitGTK 4.1 等开发库                          |

Debian / Ubuntu 示例：

```sh
sudo apt update
sudo apt install build-essential curl wget file pkg-config libwebkit2gtk-4.1-dev libxdo-dev libssl-dev librsvg2-dev libayatana-appindicator3-dev
rustup default stable
```

Windows Docker 另需 WSL 2 与硬件虚拟化。无桌面 Linux 使用[服务器包](../../distribution/server/README.md)，不需要 Tauri / WebKitGTK。

## 构建与验收

macOS 本机 App：`npm --prefix apps/deployment-manager run tauri -- build --bundles app`。其他平台使用对应工具链与 Tauri 目标；完整发行包使用根打包入口，见[发布与版本](../../docs/release-and-version.md)。直接构建 Tauri 不会自动生成完整镜像发行资源。

在目标平台检查首次启动、Docker 连接、配置保存、服务控制、备份恢复和更新。基础 `verify` 只检查格式、语法和风格；手动 Rust/回归检查也不代替实际 Tauri 启动验收。
