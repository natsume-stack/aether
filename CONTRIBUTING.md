# 贡献指南

欢迎提交文档、Bug 修复、测试和功能改进。较大功能、接口或数据格式调整，先开 Issue 说明用途和范围。项目采用 [MIT](LICENSE.md) 许可。

## Fork 与创建分支

从[官方仓库](https://github.com/box3lab/box3-local-engine) Fork 后，用自己的 GitHub 账号替换 `<your-account>`：

```sh
git clone https://github.com/<your-account>/box3-local-engine.git
cd box3-local-engine
git remote add upstream https://github.com/box3lab/box3-local-engine.git
git fetch upstream
git switch -c dev/<short-description> upstream/dev
```

社区贡献统一向 `dev` 提交 Pull Request。开发中同步上游时，先保存本机改动，再执行 `git fetch upstream` 和 `git merge upstream/dev`。

## 安装与检查

使用 Node.js `22.17.x`，启动 Docker 后在根目录执行：

```sh
npm run install:all
cp .env.docker.example .env
npm run dev:infra
```

已有 `.env` 时跳过复制；PowerShell 使用 `Copy-Item .env.docker.example .env`。环境与数据目录见[开发入门](docs/developer-guide.md)，首次创作见[首个作品教程](docs/first-project.md)。

| 改动           | 提交前执行                                                        |
| -------------- | ----------------------------------------------------------------- |
| 通用基础检查   | `npm run verify`、`git diff --check`                              |
| 文档           | 追加 `node scripts/check-documentation.js`                        |
| 功能或数据行为 | 按[测试指南](docs/testing.md)运行受影响模块测试                   |
| HTTP API       | `npm run api:generate`、`npm run api:check`，提交契约与生成物     |
| 依赖或工作区   | `npm run update:all`、`npm run check:workspace`，提交清单与锁文件 |

Verify 只检查格式、语法和代码风格，不运行业务测试、Rust 编译、漏洞审计或打包。需要更详细验证时，手动运行 `typecheck`、`test`、`check` 或对应模块命令。

## 修改约定

- 遵循[代码规范](docs/code-style.md)，优先复用现有公共包；一个 PR 解决一个明确问题。
- 涉及权限、数据格式和实时协议时，验证正常与失败路径。
- 命令、配置和用户操作变化时同步文档，不夹带无关重排。
- 不提交真实 `.env`、密钥、玩家数据、地图、日志和构建产物。
- `apps/local-engine/data/blobs/` 保存内置资源，整个目录纳入源码与构建输入；开发数据放 `.local-data/`。

## 提交与 PR

先检查差异，仅暂存本次文件。下面以文档修改为例：

```sh
git status --short
git diff -- README.md docs/
git add README.md docs/
git diff --cached --check
git commit -m "docs: clarify development workflow"
git push -u origin HEAD
```

在 GitHub 创建指向官方 `dev` 的 PR，说明：

| 内容       | 写什么                                   |
| ---------- | ---------------------------------------- |
| 问题与结果 | 触发条件、原行为与修改后行为，关联 Issue |
| 范围       | 涉及模块、接口与兼容性；UI 改动附截图    |
| 验证       | 实际命令和结果，注明未执行或失败项       |
| 数据影响   | 迁移、备份和恢复要求（如涉及）           |

PR 创建或更新时自动运行基础 Verify，不打包或上传 OSS，Fork 无需官方发布密钥。评审修改继续提交到同一主题分支。

## 发布与反馈

源码合并不会自动替换已有容器。发布路径为 `dev → staging → 正式版本分支 → main`；引擎使用 `release/v<版本>`，玩家启动器使用 `player-release/v<版本>`。预发布与正式共用流程、版本后缀和重跑规则见[发布与版本](docs/release-and-version.md)。

通过 [Issues](https://github.com/box3lab/box3-local-engine/issues)报告问题，附系统/架构、版本或提交、复现步骤和脱敏日志。保留原作者及第三方许可声明，品牌与商标不属于 MIT 授权范围。
