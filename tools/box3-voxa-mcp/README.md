# box3-voxa-mcp — VOXA 模型构建 MCP

让任意 MCP 客户端（ZCode / Claude / Cursor…）通过 VOXA 识别码体系构建模型：列清单、导入 `.voxaproject`、导入前本地 lint、登记产物。作用域仅限模型构建（VOX 码），碰不到地图。

## 工具面（5）

| 工具 | 说明 |
| --- | --- |
| `voxa_health` | 服务可达性 + 身份配置自检 |
| `voxa_model_list` | 工作区模型清单（导入前查重名） |
| `voxa_model_inspect` | **本地**解码 bundle：palette/usedColors/rects/texels 统计 + 门禁判定 + 四件套齐全性（导入前必跑） |
| `voxa_model_import` | 导入 bundle（成功即登记产物） |
| `voxa_artifact_register` | 登记产物到 Agent Active 面板 |

## 接入

```sh
# 环境变量（二选一身份）：
BOX_VOXA_BASE_URL=http://127.0.0.1:3123     # 默认
BOX_VOXA_AGENT_CODE=VOX-XXXX-XXXX-XXXX      # 首次调用自动 join 换令牌（推荐）
# 或 BOX_VOXA_AGENT_TOKEN=agx_...           # 已换好的令牌
# VOXA_ROOT=D:/desktop/神奇代码岛/box3-local-engine/apps/voxa   # inspect 需要（默认已推断）

# 注册 JSON（zcode / claude-code / cursor 通用 mcpServers 形态）：
{
  "mcpServers": {
    "box3-voxa": {
      "command": "node",
      "args": ["<repo>/tools/box3-voxa-mcp/src/index.js"],
      "env": { "BOX_VOXA_AGENT_CODE": "VOX-..." }
    }
  }
}
```

## 推荐工作流

```
1. voxa_model_list                  # 查重名
2. chisel v4 产 bundle（见 skills/box3-voxa-modeling）
3. voxa_model_inspect               # 门禁全绿再导入
4. voxa_model_import                # 导入即入库
5. voxa_artifact_register           # 面板可见（import 已自动登记，此步可选补登）
```

## 错误契约

`{code, retryable, hint}`：`VOXA_UNREACHABLE` / `AGENT_AUTH_REQUIRED` / `INVALID_CODE` / `FILE_NOT_FOUND` / `GATE_FAILED` / `VOXA_REJECTED`。hint 即下一步动作。

## 可编辑源与资源完整性

`voxa_model_context({modelId, offset?, limit?, paletteOffset?})` 直接读取已有模型的**已保存**源工程，返回 revision/源哈希、部件稳定ID、层级/骨骼绑定、变换和枢轴，以及分页调色板和动画摘要。部件每页最多128、调色板每页64，按 `nextOffset` / `nextPaletteOffset` 续读；不返回 encodedView 原始载荷。此操作不要求打开浏览器、移动镜头或先截图。它不包含编辑器未保存的更改，不能冒充实时内存快照；上下文中的源哈希/revision也还不是VOXA写事务接口。

`voxa_model_inspect` 现在分别报告三类证据：`source` 实际解码 project.bin v10，给出源版本/哈希、部件摘要和动画数量；`integrity` 校验 manifest 声明的资源哈希及 meta.dataHash 与真实 model-data 字节是否匹配；`gates` 仍是旧的体量回归参考，附明确阈值及覆盖边界，不能当成视觉质量结论。

只有 model-data(v7) 的展厅资源不会被标为可编辑源。project.bin 存在但损坏/不支持也不会标 editable。源可解码后还检查体素字典 key/value.id 一致、部件资源存在、蒙皮不直接以骨骼为 parent；不符合时返回 structuralIssues 和 editable:false。源通过这些检查仍不证明再分发许可、source/runtime 一致或修改后可运行；几何/材质编辑需要 VOXA 重新烘焙并保存，不能只替换源工程而继续引用旧运行时数据。原 inspect 的 dataHashPresent 仅证明字符串存在，新增 dataHashMatches 才是真实内容绑定检查；manifest 缺失、重复声明或资源被改均报告失败。

旧 inspect 使用 texels≥700，chisel v4 等策略使用不同阈值，因此 gatesPass 不能跨策略比较，也不能覆盖人工视觉/动画验收。现有质量较低的工程仍可以作为续作源，导入只是传输/解码，不是作品质量认证。
