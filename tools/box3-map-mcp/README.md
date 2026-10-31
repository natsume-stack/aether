# box3-map-mcp — BOX3 地图创作 MCP

让任意支持 MCP 的 AI 客户端（ZCode / Claude / Cursor…）直接读取 BOX3 Creator 地图并创作：地形、实体、UI、脚本、保存——全部经由引擎已有的鉴权面（bxc_ CLI Token + loopback 写面），37 个工具，统一错误契约 `{code, retryable, hint}`。

## 5 分钟接入

```sh
# 0. 引擎已起（Creator :3127），且已签发 CLI Token（玩家门户勾选 authoring.apply）

# 1. 体检（可选，只读）
BOX_CREATOR_CLI_TOKEN=bxc_... node scripts/doctor.mjs

# 2. 生成客户端注册 JSON
node scripts/register-print.mjs --client zcode          # 或 claude-code / cursor
# 把输出的 JSON 填进客户端 MCP 配置，并在 env 里填 BOX_CREATOR_CLI_TOKEN=bxc_...

# 3. 重启客户端，agent 侧即可 tools/list 看到 37 个工具
```

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `BOX_CREATOR_BASE_URL` | `http://127.0.0.1:3127` | Creator API 基址 |
| `BOX_CREATOR_CLI_TOKEN` | — | `bxc_` CLI Token（**必填**才能过 creator/v1 面） |
| `BOX_MAP_PROJECTS_ROOT` | — | 引擎本地工程目录；设置后 `map_revision` 可离线解析 headHash |
| `BOX_MCP_PROFILE` | `authoring` | `readonly` 只读档案（写工具被过滤，调用返回 WRITE_DISABLED 契约） |
| `BOX_MCP_ALLOW_WRITE` | `true` | 总写开关（false 等效只读） |
| `BOX_MCP_TYPEGATE` | `auto` | `auto` / `language-service` / `syntax` / `off` |
| `BOX_MCP_TIMEOUT_MS` | `20000` | 单次引擎请求超时 |

## 工具面速览（37）

- **读**：`engine_health` `map_list` `map_resources` `map_revision` `map_status` `map_tool_catalog` `script_list` `script_read` `script_list_runtime` `script_read_runtime` `data_read` `terrain_info` `terrain_read` `entity_list` `ui_tree_read` `model_list` `model_search_public` `runtime_status` `runtime_events_tail` `contract_describe`
- **写**：`terrain_apply` `terrain_revert` `entity_create` `entity_update` `entity_move` `entity_delete` `entity_copy` `ui_node_add` `ui_node_remove` `script_write` `script_create` `script_patch` `script_delete` `script_typecheck` `model_add_to_project` `map_preview` `map_save`
- 全量 schema：`node src/index.js --tools-json`；与引擎工具层覆盖率：`node src/index.js --coverage-json`

## Agent 必读的三条硬规则

1. **写前先 `map_status`**：预览运行中所有地形写会被 409 `PREVIEW_RUNNING` 拒绝；硬顺序 = `map_preview stop` → 写 → `map_save`。
2. **乐观锁**：写工具认 `expectedRevision`；收到 409 `REVISION_CONFLICT` 时重新读一次（`map_revision`）再带新 revision 重试，不要盲重试。
3. **脚本先 typecheck**：`script_create/patch` 后调 `script_typecheck`，类型门不过别 `map_save`。

更完整的工作流（地形/实体/UI/脚本）见随包 Skills：`skills/box3-map-authoring/SKILL.md`（仓库根）。

## 安全模型

- 读写分离：读面走 `creator/v1`（验 token scope），写面走 loopback `/api/internal/map-authoring`（只认同机调用）——token 泄露也拿不到写权，除非本机。
- 审计：引擎侧每个写动作落审计行（tokenSubject + 写前写后 revision），被拒的 409/429 也落。
- 无第三方依赖：stdio JSON-RPC 手写四方法（initialize / ping / tools/list / tools/call），协议版本 `2025-06-18` 向下兼容。

## 测试

```sh
npm test          # node --test test/*.test.js（87 用例，含 484 行域护栏）
npm run probe     # 只读 live-probe（需引擎在线）
```
