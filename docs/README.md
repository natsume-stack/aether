# 文档导航

所有示例以当前源码为准；未注明的开发命令在仓库根目录执行。

## 按目标阅读

| 目标                   | 文档                                                         |
| ---------------------- | ------------------------------------------------------------ |
| 了解项目与下载安装     | [项目首页](../README.md)                                     |
| 启动和停止源码栈       | [开发入门](./developer-guide.md)                             |
| 授权、创作、备份与游玩 | [首个作品教程](./first-project.md)                           |
| 理解服务与数据位置     | [架构与数据流](./architecture.md)                            |
| 基础 Verify 与手动测试 | [检查与测试](./testing.md)                                   |
| 修改代码与提交 PR      | [代码规范](./code-style.md) · [贡献指南](../CONTRIBUTING.md) |
| 测试包与正式发行       | [发布与版本](./release-and-version.md)                       |

## 模块与部署

| 模块               | 文档                                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux 无桌面部署   | [服务器安装与运维](../distribution/server/README.md)                                                                                                     |
| 独立游玩服务       | [Play 分发模板](../distribution/play/README.md)                                                                                                          |
| 工程与发布包       | [本地引擎控制层](../apps/local-engine/README.md)                                                                                                         |
| 编辑器与权威运行时 | [网页服务](../apps/game/README.md) · [game-server](../services/game-server/README.md)                                                                    |
| 模型、皮肤和动画   | [VOXA](../apps/voxa/README.md)                                                                                                                           |
| 玩家与权限管理     | [玩家后台](../apps/player-admin/README.md)                                                                                                               |
| 登录页定制         | [登录门户](../apps/player-auth-portal/README.md) · [接口与定制](../apps/player-auth-portal/docs/API.md)                                                  |
| 部署管理器         | [桌面与 Web 界面](../apps/deployment-manager/README.md) · [Web 后端](../apps/server-manager-rust/README.md) · [共享核心](../apps/manager-core/README.md) |
| 玩家客户端         | [玩家启动器](../apps/player-launcher/README.md) · [维护](../apps/player-launcher/docs/maintenance.md) · [发布](../apps/player-launcher/docs/release.md)  |
| 接口与脚本类型     | [HTTP API](../internals/apis/README.md) · [Script API](../packages/script-api/README.md)                                                                 |

HTTP API 文档使用 `npm run api:docs` 启动，地址以日志为准。底层库 API 见各包 README；CHANGELOG 保留历史版本记录。

## 维护约定

命令、默认值、接口或用户流程变化时同步相关文档。保持一个主题一个说明入口，用链接复用详细步骤；Mermaid 用于服务关系、数据流和发布决策。

修改文档后运行 `node scripts/check-documentation.js` 和 `git diff --check`，并检查格式。链接检查只覆盖本地文件和锚点，不执行示例命令或验证远程页面。
