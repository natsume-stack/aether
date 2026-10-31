# box3-agent-mcp — 活体创作 MCP

让 AI 读取并续作现有地图。地图数据工具直接连接权威编辑运行时，支持局部地形提案、应用、回滚与操作回执；编辑器订阅事件显示进度。相机、光标和 VOXA 的旧交互工具仍由打开的标签页执行，可按需使用。

同一套协议同时服务：

- **地图编辑器**（Creator `/edit`）
- **VOXA 模型编辑器**

工具目录以 `node tools/box3-agent-mcp/src/index.js --tools-json` 为准；使用识别码换取地图令牌，无需 CLI Token，无第三方依赖。

## 3 步接入

1. 在编辑器右下角 **Agent Active → 活体** 面板点 **复制 MCP 配置**。
2. 把 JSON 粘进 AI 客户端的 MCP 配置（ZCode / Claude Code / Cursor…），重启客户端。
3. 先打开地图启动编辑运行时，让 AI 调 `agent_help` → `map_context`。相机和光标交互才需要保持标签页打开。

配置长这样（识别码就是这张图的开发邀请）：

```json
{
  "mcpServers": {
    "box3-agent": {
      "command": "node",
      "args": ["<仓库>/tools/box3-agent-mcp/src/index.js"],
      "env": {
        "BOX_MAP_AGENT_BASE_URL": "https://box3.cdk.lat/edit",
        "BOX_MAP_AGENT_CODE": "MAP-XXXX-XXXX-XXXX",
        "BOX_MAP_PROJECT": "my-map"
      }
    }
  }
}
```

**生产环境不需要把 MCP 跑在服务器上**：`BOX_MAP_AGENT_BASE_URL` 是公开地址，AI 客户端在本机即可接入；识别码换 `agx_` 令牌只在内存里。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `BOX_MAP_AGENT_BASE_URL` | `http://127.0.0.1:3127` | 地图编辑器公开基址（含部署前缀，如 `/edit`） |
| `BOX_VOXA_AGENT_BASE_URL` | `http://127.0.0.1:3123` | VOXA 公开基址 |
| `BOX_MAP_AGENT_CODE` | — | 地图识别码（面板复制） |
| `BOX_VOXA_AGENT_CODE` | — | VOXA 识别码（面板复制） |
| `BOX_MAP_AGENT_TOKEN` / `BOX_VOXA_AGENT_TOKEN` | — | 已有 `agx_` 令牌时可直接给，免 join |
| `BOX_MAP_PROJECT` | — | 地图 project id（面板配置已带） |
| `BOX_VOXA_MODEL_ID` | — | 仅作参考；实际以当前打开的模型为准 |
| `BOX_AGENT_NAME` | `zcode` | 面板/审计里显示的 agent 名 |
| `BOX_AGENT_WAIT_MS` | `30000` | 单条命令等待编辑器回执 |
| `BOX_AGENT_MIN_ACTION_MS` | `250` | 两条编辑命令最小间隔，给人观看的时间 |
| `BOX_AGENT_ALLOW_WRITE` | `true` | `0`/`false` 时写工具返回 `WRITE_DISABLED` |
| `BOX_AGENT_CORPUS_ROOT` | — | 可选本地资源目录，包含 `_corpus/catalog.mjs build` 生成的 `catalog.json`；供 `asset_library_search` 检索 |

## 地图数据工作流

`map_context` → 按需 `map_terrain_read` / `map_scripts` / `map_script_read` → `map_runtime_status` → 停预览 → `map_propose` → `map_apply_proposal` → `map_runtime_save`。资源参考可先用 `asset_library_search` 搜索作者、名称、种类、本地可用状态和动画属性，结果保留来源与授权。

`map_propose_local_terrain` 可替代手写 boxes：提供选区、`fill` / `replace` / `surface`、目标方块及可选 `preserve` 保留区域。它读取完整现图选区，只把实际需要变更的格压缩为至多 64 个精确盒，并带读取时 revision 创建提案；选区超过 20 万格、读取不完整或布局过于碎片化时拒绝。`surface` 仅重铺选区内每列已有的最高非空气格，不自动抬高地面或删除上方建筑。

应用/回滚必须给稳定 `operationId`。超时后用 `map_operation_status` 查询，不能换一个 ID 盲重试。`map_proposal_status` 查询提案状态，`map_revert_proposal` 在 revision 仍匹配时恢复内容，再次保存。

当前地形多步提案采用补偿式回滚，不是跨地形/实体/UI/脚本原子事务。地形逆操作单独保存在同目录的 `.proposals.json` 快照（上限 64 MiB），重启后恢复回滚记录，但必须通过当前地图 revision 检查；待应用提案过期，执行中断的提案标为 unknown，不自动续跑。快照包含地形逆数据，不包含可执行步骤。操作 ID、执行结果摘要及事件历史会写入运行时工作目录的 `.authoring-journal/<container>.jsonl`，可用 `BOX_AUTHORING_JOURNAL_DIR` 指定其他位置，`map_authoring_history` 读取历史。

日志采用写前意图记录、同步落盘、摘要校验和单写入者锁，默认上限 32 MiB，不自动丢弃幂等键。日志不可写、损坏或达到容量时，Agent 写入会被拒绝，现有地图仍可打开。重启后的回执标记为历史记录，同 ID 不会再次执行；缺失完成记录则为结果未知。历史执行成功不证明地图修改已经保存，必须核对当前内容。日志不保存脚本正文、工具参数或 undoToken；不要直接删除日志以绕过重复操作保护。

库中 v7 发布模型样本不代表可编辑 `.voxaproject`，也不代表默认允许再分发。

## 按需操作浏览器视角（旧通道）

1. `agent_status` / `agent_observe`：确认接入，拿相机、视线命中、光标、实体、模型资源。
2. `agent_look`：把镜头移到施工区，人能看到 AI 在看哪里。
3. `agent_cursor` → `agent_place` / `agent_erase`：一次一格。
4. 连续施工用 `agent_place_path` / `agent_fill_box`，按 `paceMs` 逐块出现。
5. `agent_place_model`：`mesh` 只能从 `observe.models` 里选。
6. 每完成一小段 `agent_observe`；收尾 `agent_save`。
7. **预览在跑时不能写地形、不能保存**：先 `agent_preview stop`。这是引擎硬顺序。

## VOXA 侧工作流

1. `voxa_status` / `voxa_observe`：确认当前模型、光标、调色板。
2. `voxa_look` → `voxa_cursor` → `voxa_paint` / `voxa_erase`。
3. 路线用 `voxa_paint_path`，大块用 `voxa_fill_box`，颜色用 `voxa_set_color`。
4. 一个部件做完就 `voxa_observe`，不满意 `voxa_undo`。
5. `voxa_save`。

## 硬规则（写给 AI）

- **修改现图先读状态并限定区域**。地图数据支持批量提案；`paceMs` 仅属于旧浏览器展示工具，不是结构化写入的前置条件。
- **超时先核对结果**。运行时写查询 operationId 回执；旧浏览器写遇到 `EDITOR_TIMEOUT` 则先 observe，盲目重放会重复搭建。
- **保持权威内容一致**。运行时数据工具操作同一份工程，不需要移动视角；旧浏览器工具遇到 `EDITOR_NOT_ATTACHED` 时需要恢复标签页连接。
- **识别码等同开发邀请**。泄露后立刻在面板“轮换”。

## 工具

地图：`agent_status` `agent_observe` `agent_look` `agent_cursor` `agent_place` `agent_erase` `agent_place_path` `agent_fill_box` `agent_entities` `agent_select_entity` `agent_place_model` `agent_undo` `agent_redo` `agent_save` `agent_preview` `agent_screenshot` `agent_say` `agent_wait` `agent_release_camera` `agent_help`

VOXA：`voxa_status` `voxa_observe` `voxa_look` `voxa_cursor` `voxa_paint` `voxa_erase` `voxa_paint_path` `voxa_fill_box` `voxa_palette` `voxa_set_color` `voxa_undo` `voxa_redo` `voxa_save` `voxa_screenshot` `voxa_say` `voxa_wait` `voxa_help`

```sh
node src/index.js --tools-json      # 机器可读 schema
node src/index.js --config-json     # 解析后的配置（凭据已脱敏）
node src/index.js --doctor          # 探测地图/VOXA 活体面
npm test                            # mock HTTP 回归
```

## 与 `box3-map-mcp` 的关系

- `box3-agent-mcp` 提供识别码加入、权威运行时内容读取、局部地形提案/应用/回滚、保存，以及可选相机和光标操作。数据编辑不要求逐格播放或先移动相机。
- `box3-map-mcp` 保留 CLI 认证的工具箱，包括工程导入/导出和旧脚本工具；两套入口的功能与迁移状态以实际工具目录为准。
- 日常现图续作优先走共享运行时协调器；相机与光标用于需要调整视角的任务，不作为内容编辑前置条件。

## 脚本内容预览

`map_script_read` 返回正文、执行侧及 `revision`。将该版本和 `edits` 交给 `map_script_preview`，可获取候选正文和逐处修改。每项编辑为 `{index, deleteCount, text}`，坐标按原始正文的 UTF-16 位置计算；重叠编辑、过期版本和越界范围会被拒绝。

此工具只读，不执行、不应用、不保存，也不做项目类型和 UI 绑定检查。候选正文标记 `validation: not-typechecked`；不能将预览成功当作脚本可运行或可保存的证明。正式修改走下述提案链；旧脚本写入口不会因此自动获得版本保护。

`map_script_check` 接受相同补丁，检查整组同侧脚本的语法、TypeScript 语义和全项目 UI 绑定，使用项目脚本/UI 快照及引擎 API 声明。必须读取 `check.available`、`check.accepted`、`sourceStillMatches` 和 `dependenciesStillMatch`，HTTP 成功不代表满足检查策略或仍对应当前工程。`check.passed` / `check.clean` 另行表示静态检查是否无错误。服务端按 CommonJS 函数体解析，客户端支持 ESM；脚本按独立模块处理。声明资源 `.dts` 会映射为编译器支持的虚拟 `.d.ts`，支持中文脚本名。

默认 `policy: strict` 要求无静态错误。已有社区工程可以显式选择 `policy: no-new-errors`：在同一个隔离线程中对修改前后的完整错误多重集合做比较，检查所有同侧依赖脚本和 UI 引用，不以错误总数降低或前 200 条显示摘要判断通过。新增、重复增加或替换为另一种错误均拒绝；候选语法必须有效。`comparison` 报告原有、新增、修复数量。此策略允许保留已有问题，绝不代表旧图可运行或质量合格；禁止自动降级到此策略。

`map_propose_script` 接受补丁和所选策略，只准备提案。编辑器“创作提案”可查看逐处删除/插入正文与检查策略。`map_apply_proposal` 会重新检查并核对整个脚本/UI 域的 revision 后修改真实 CRDT，`map_runtime_save` 再持久保存。`map_revert_proposal` 使用服务端保存的逆操作，拒绝覆盖后续人工修改；支持保存、重启、恢复逆操作并回滚。共享脚本要求已有编辑锁，预览必须先停止。

提案快照还会保存脚本逆操作和供审阅的正文差分，属于本地工程数据；JSONL 操作日志仍不记录正文或参数。普通本地脚本加载使用稳定 ID，重命名或执行侧改变会使旧版本失效。当前脚本运行时验收只覆盖临时注释修改、保存重开和 73 脚本恢复后一致，不替代真实玩法和创作质量验收。

该检查不包含实际运行验收，不签发应用许可，也不修改正文。UI 校验复用现有 `tools/box3-map-mcp/src/ui-binding.js`，其静态扫描不能证明动态生成的绑定完全正确。缺失 TypeScript、声明或绑定校验模块，以及超出预算时明确返回 unavailable，不自动降级为通过。默认向上寻找源码根，可用 `BOX_AUTHORING_REPO_ROOT` 指定；部署需提供 TypeScript 和共享校验模块。检查在工作线程运行，每个运行时最多一个，15 秒超时，512 MiB 老生代限制；繁忙时返回 `SCRIPT_CHECK_BUSY`，不会把编译工作压入无界队列。

## 现有实体局部编辑

`map_entities` 按 ID 或分页读取实际实体树，返回实体/资源域 `revision`。`map_propose_entities` 用该版本和 `patches: [{entityId, properties}]` 准备现有物件的属性提案，最多 64 个不同 ID；支持位置、缩放、四元数朝向、名称、标签、模型引用、着色与常用物理属性。未知属性、非有限值、重复 ID、锁定实体及缺失/非模型资源引用会被拒绝。它不新增、删除或重挂实体。

在“创作提案”审阅属性前后差分后，调用相同的 `map_apply_proposal` / `map_revert_proposal`，再单独保存。实际应用先取得引擎项目锁，再核对版本、构建真实 RDA 动作并在锁内回读，避免等待人工编辑或保存时误用旧版本。实体逆数据可经提案快照恢复；恢复前仍核对整域版本，拒绝覆盖后来的人工修改。当前证据是实际 RDA 与生产锁方法的本地集成测试；真实地图实体保存重启和创作外观验收尚待完成。

## 检查器的生产资源

服务端 build 会将三份 API 声明和同一个 UI 绑定校验器打包至 `dist/authoring-resources`，附 SHA256/体积/来源清单。TypeScript 是生产依赖；已编译检查线程不预加载 SWC。资源发现优先使用包内目录，再查找源码根，显式 `BOX_AUTHORING_REPO_ROOT` 优先级最高。因此前文“部署需提供共享校验模块”在标准 build 下由打包步骤落实，单独复制服务端 JS 仍不够。

`npm run check:authoring-production` 在没有源码祖先、SWC、ts-node 和 tools 目录的临时独立树中运行已编译检查线程，验证合法修改、真实 API 错误、显式旧图兼容策略及缺失绑定模块拒绝。这是检查器部署边界的集成验证，不是整个部署镜像构建验收。检查依赖缺失仍明确 unavailable。

## 现图道路算子

`map_propose_local_terrain` 新增 `kind: road`，使用 `path: [[x,z], ...]`、奇数 `width`（默认 3）和 `maxStepHeight`（0 或 1，默认 1）。工具读取完整选择区域，用现有非空气表面生成连续的体素道路，即使宽度为 1 的斜线也连接相邻格；仅将精确表面差分交给现有提案事务。保留区、区域外及地下内容不写入。

路径缺少表面、宽度越界或相邻高度差超过阈值时拒绝，不自动填平建筑或跨越悬崖。保留区可能中断路线。该算子不清理头顶空间，不识别屋顶/水面用途，不证明可通行；正式应用前应检查区域语义、材质碰撞、净空与视觉。地形选择应覆盖完整相关高度，避免将截断的建筑内部误认作表面。应用、保存、回滚仍分开调用，关闭相机/光标不影响运行。

未应用草稿可以通过 `map_discard_proposal`（稳定 operationId）或面板“放弃草稿”拒绝，不改地图内容。仅待应用/已过期草稿可放弃；已应用、部分完成、结果不明的提案必须先核对或回滚。放弃结果跨重启保留，审阅和历史不删除，也不会释放提案数量配额。此操作同样受写配置控制。

## UI 属性提案（现有节点）

`map_ui_nodes` 提供权威 UI 节点及 UI 域 revision。`map_propose_ui` 接受 `{expectedRevision, patches:[{nodeId, properties}]}`，只编辑现有元素的 positionOffset/positionRatio、sizeOffset/sizeRatio、anchor、visible、背景颜色/不透明度，以及节点类型实际支持的文字/字号/文字颜色与不透明度。颜色是引擎的 RGB 0–255；坐标为二维数组。

在真实 UITreeRDA 上模拟，审阅显示实际量化后的结果（不是假定请求的小数能无损写入），正式应用先取得共享项目 mutex 再做 CAS 和精确回读；逆数据经独立提案快照保存，使用统一 apply/revert/save 链。屏幕节点、未知属性、类型不支持属性、重复目标、非有限数值以及自动布局父级下会被忽略的绝对位置修改均拒绝。

此阶段不改名称、ID、类型、父子关系、图片引用和脚本，因此保持静态绑定身份；不宣称能证明动态脚本绑定或视觉/交互行为。未实现 UI 新增/删除/重挂，也不将已有绑定问题当作已修复。所有布局、可见性和文字调整仍需真实屏幕尺寸/运行行为验收；隐藏元素尤其可能改变交互，调用者应审阅用途。
