# VOXA 模型编辑器

VOXA 编辑体素模型、皮肤与动画。Creator 可打开独立模型库，也可在地图内嵌入项目模型编辑；模型保存范围由当前工程上下文决定。

## 启动与数据

| 方式         | 命令 / 地址                                                       |
| ------------ | ----------------------------------------------------------------- |
| 完整源码栈   | 根目录 `npm run dev:infra`，默认 `http://127.0.0.1:3123/`         |
| 独立界面调试 | `npm --prefix apps/voxa run dev`，默认 `3001`，仍需身份服务与配置 |
| 开发模型数据 | `.local-data/apps/voxa/data/`                                     |
| 调整数据路径 | `BOX_DEV_DATA_DIRECTORY` 或单独设置 `VOXA_DATA_PATH`              |

玩家需获授创作端和“管理模型”能力。首次授权与模型制作见[首个作品教程](../../docs/first-project.md)。`.voxaproject` 用于模型工程导出；旧包缺少 mesh 等资源时，需打开后重新保存。

## 代码入口

| 位置                                  | 职责                     |
| ------------------------------------- | ------------------------ |
| `pages/index.tsx`、`pages/api/local/` | 页面门禁、模型与资源 API |
| `server/local-voxa-store.ts`          | 模型索引、blob 与快照    |
| `server/local-voxa-project-bundle.ts` | 模型工程包读写           |
| `src/models/`、`src/views/`           | 编辑、动画和保存界面     |
| `lang/src/`                           | 翻译源文件               |

## 按需检查

在根目录使用 `npm --prefix apps/voxa run <脚本名>`：

| 脚本                                                    | 内容                     |
| ------------------------------------------------------- | ------------------------ |
| `check:model-library-scope`                             | 独立模型库和项目模型范围 |
| `check:model-project-bundle`                            | 工程包与资源             |
| `check:local-cors`、`check:model-management-permission` | 来源和模型权限           |
| `check:default-skin-scope`、`check:parent-storage-url`  | 默认皮肤和父页面资源地址 |
| `build`                                                 | 编译翻译与应用           |
| `update-i18n`、`build-i18n`                             | 提取和构建文案           |

检查不属于默认 Verify；保存、放入地图和发布后的资源仍需实际验收。模型库与上传文件不提交到源码，测试范围见[检查与测试](../../docs/testing.md)。
