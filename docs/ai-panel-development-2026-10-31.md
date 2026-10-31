# AI panel development — 2026-10-31

The user owns real-provider API configuration and manual acceptance. Engineering checks do not claim manual acceptance.

## Implemented

- Identity-owned encrypted personal providers and administrator default channel, all three protocols.
- Owner-session authenticated Admin channel CRUD, test, model discovery, default switch, execution controls.
- No fallback from an explicitly invalid channel; only the designated enabled public default is eligible.
- Request-scoped review/autonomous tool exposure. Review creates proposals; human applies batches in the activity panel.
- Autonomous map writes use proposal/inverse workflows, save before/after writes, live execution policy checks, bounded calls and timeout, cancellation and per-session abort isolation.
- Project save errors now propagate instead of silently reporting success.
- Plan metadata and per-member state are journaled; drafts expire after restart, interrupted plans become unknown.
- VOXA personal channels, persisted workflow preference, three-protocol JSON planner, bounded native voxel edits and existing part name/position/scale updates, review/auto batches, stop, full-source fingerprint checks, before/after saving and latest-batch snapshot restore.
- Production ignores private-provider development opt-in. URLs are revalidated when resolved; provider errors do not echo upstream response bodies.

## Engineering verification

Commands: game-server tsc; check-ai-execution-policy.ts; check-ai-provider-isolation.ts (dev database only); check-plan-transactions.ts; check-entity-copy.ts; check-terrain-domain.ts; API generation/check/build; player-admin typecheck/build; scripts/ai-development-health.mjs.

## Limits that must not be described as completed

- Full Creator/VOXA typechecks expose inherited compatibility errors. These must be tracked separately from passing runtime/Admin checks; existing ignoreBuildErrors settings have not been introduced by this change.
- VOXA planner currently returns one complete JSON batch, not a streaming tool loop. Part creation/deletion, arbitrary hierarchy edits, animations and automated publication are not implemented by this panel.
- Map tools without a rollback-capable proposal path are intentionally not exposed to autonomous execution. Automatic publication/deletion of whole projects is not implemented.
- VOXA most recent batch's in-memory source snapshot is available while the editor remains open; persisted model versions are also written. An arbitrary historical snapshot selection UI is not implemented.
- Provider HTTP transport validates DNS inside the actual socket lookup, rejects private literals and all redirect responses, and forwards cancellation to the socket. All three mock protocol adapters passed through this transport.
- Rate limiting is per-process; no distributed token accounting or staged-user rollout dashboard is included.
- No third-party credentials were requested or used and no manual product acceptance was performed.

## 创作权限：VOXA 编辑器独立授权（2026-10-31 增补）

- 创作权限新增 `voxa.edit`（后台显示“VOXA 编辑器”），与 `models.manage`（“管理模型”）分离：
  前者允许打开 VOXA、新建/编辑/保存模型与皮肤、使用编辑锁与版本恢复；后者只管理模型库与工程导入导出，不授予编辑器访问权。
- 后台“创作权限管理”的勾选项直接来自 `apps/game/shared/creator-policy.ts` 的 `CREATOR_CAPABILITIES`，
  服务端 `apps/game/server/player-admin-validation.ts` 用同一常量做 zod 枚举校验，因此新增权限无需再改白名单。
- VOXA 页面 `apps/voxa/pages/index.tsx` 使用 `resolveVoxaEditorAccess`（`voxa.edit`）；
  模型写入类接口（`/api/local/blob`、`/api/local/models/[id]`、`edit-lock`、`snapshots`、`model`）统一走 `requireVoxaEditorAccess`；
  模型库删除仍要求 `models.manage`。
- 兼容性说明：升级后仅持有 `models.manage` 的账号仍可管理模型库，但打开 VOXA 会被拒绝（403）并提示开通“VOXA 编辑器”；
  管理员需在后台为需要编辑的账号单独勾选该权限。此改动为有意收紧，不做自动补授。
- 开发栈注意：`box3-dev` 内的 ts-node 鉴权进程不会热重载该常量，修改权限清单后必须
  `systemctl --user restart box3-dev` 才会接受新权限值。
- 回归：`apps/voxa/scripts/regression-voxa-editor-permission.ts`（权限矩阵与入口/接口分离），
  以及 `apps/game/scripts/check-creator-capabilities.ts`（后台可授值与规范化）。

## Runtime

Source of truth: /home/natsume/box3-dev/repo/box3-local-engine, branch dev/server-2026-10-31. Use box3-dev user systemd unit; do not touch production ports 3121–3127. Restart rebuilds dependencies. Admin AI view: ?view=ai-providers. Creator and VOXA use their existing public origins.

## 本轮验收记录（2026-10-31 晚）

提交 `2a906ab feat(ai): add execution ledger, shared channels, publication rollback and VOXA editor permission`（已推送 `dev/server-2026-10-31`）。

已实测通过：

- 生产构建（严格类型检查，`ignoreBuildErrors: false`）：Creator `apps/game`、VOXA `apps/voxa` 均构建成功；使用隔离产物目录 `.next-ai-build`，未覆盖线上 `.next`。
- 类型检查：`services/game-server`、`apps/player-admin`、`apps/game -p tsconfig.runtime.json`、`apps/voxa` 全量 `tsc --noEmit` 均 0 错误。
- 权限端到端（真实账号流程，临时账号已删除）：
  1) 新玩家未授权 → VOXA 页面 403，提示开通“VOXA 编辑器”；
  2) 后台 PATCH 授予 `voxa.edit` → VOXA 页面 200；
  3) 仅 `models.manage` → 403（管理权不再等同编辑权）；
  4) 撤销后立即 403；匿名访问 401；`voxa.edit + models.manage` → 200。
- AI 回归：provider 隔离/共享与撤销、密钥轮换、执行台账（分布式并发/配额/kill switch/租约过期/终态不可重放）、发布回滚（CAS/路径校验/独占锁/不可重放）、消息校验（内联图片、拒绝远程 URL/SVG/非法角色）、provider 网关与 HTTP 传输（私网拒绝、重定向拒绝、流取消）、地形/实体/UI/计划事务、VOXA 模型库作用域与工程包。
- API 契约：`api:generate` 生成 192 路由 / 259 操作，`api:check` 与 `api:build` 通过。

未纳入自动回归（需真实素材/模型，非代码失败）：

- `apps/voxa/scripts/check-edit-lock.ts` 需要开发环境存在至少一个模型（当前 `VOXA_DATA_PATH` 为空库）。
- `apps/voxa/scripts/check-agent-model-context.ts` 依赖 `_corpus/model-continuation/夜翼蝙蝠-局部材质续作.voxaproject`，服务器上没有该样本。
- 两者均未连接生产服务；执行前务必显式设置 `VOXA_CHECK_URL=http://127.0.0.1:13123`，脚本默认 3001 端口不属于开发栈。

已知限制：

- 回归脚本调用方式有环境差异：`apps/game/scripts/check-ai-providers.ts` 不能加载 `.env`（开发 `.env` 打开了 `AI_PROVIDER_ALLOW_PRIVATE`，会改变 URL 策略断言）；`services/game-server/scripts/check-*.ts` 需 `TS_NODE_TRANSPILE_ONLY=true` 与 `TS_NODE_COMPILER_OPTIONS={"preserveConstEnums":true,"isolatedModules":false}`，否则 ts-node 报 TS5091。
- 整项目删除仍未开放给 AI（仅保留可回滚的实体/UI/脚本/地形删除与发布回滚）。

## Agent 面板与工作流（2026-10-31 二轮）

- VOXA 面板按站点视觉规范重做：使用 `colors.module.scss` 设计令牌，新增对话流、逐条工具卡片（待执行/执行中/完成/失败）、审核与自主切换、停止与回滚、渠道 Tab。
- 渠道自助：面板内直接新增/编辑/测试/拉取模型/删除玩家自己的渠道；密钥由玩家服务加密保存，选择与模型写入 `voxa.model` 偏好，下次打开自动复用。
- 规划器升级为多步 agent 契约：`/api/ai/plan` 接受 `history`、`toolResults`、`step`，返回 `{message, commands, done}`；模型据执行结果修复失败或继续下一步，最多 3 个客户端步（服务端上限 4）。
- 执行反馈：`executePanelPlan` 新增 `command-start/command-done/command-error/batch-done` 事件，面板逐条更新状态；失败时可直接“让 AI 修复”。
- 地图侧面板在输入区新增常驻“API 渠道”入口，渠道管理与工具调用/思维链沿用既有 AI Elements 表现。
- 安全与钩子不变：每次写入仍经过管理员策略、执行租约/配额、全源快照、人工编辑中断、逐命令审计与保存后回滚点。

验证：VOXA 全量 `tsc`、Creator 运行图 `tsc`、VOXA 生产构建通过；使用 mock provider 实测“规划 → 执行结果回传 → 下一步 done”两步链路；`apps/voxa/scripts/check-agent-plan-contract.ts` 覆盖 done 语义与命令白名单。

## 渠道、模型与流式规划（2026-10-31 第三轮）

- 渠道编辑：玩家自己的渠道可在浮窗内编辑；API Key 留空提交不会覆盖已保存密钥。平台渠道只读，提供“复制”另存为自己的渠道（需填自己的密钥）。
- 模型选择：输入区新增模型下拉（渠道模型列表）+“自定义模型…”输入；拉取模型后自动刷新。
- 思考强度：关/低/中/高四档，持久化到浏览器本地；按协议映射为 `reasoning_effort`（Chat Completions）、`reasoning.effort`（Responses）、`thinking.budget_tokens`（Anthropic）。默认“关”保持最大兼容性。
- 规划改为流式 NDJSON（`stream:true`）：事件 `phase`（读取上下文/等待/生成/校验）、`progress`（已接收字符）、`command`（逐条工具调用，完整 JSON 之前出现）、`plan`、`error`。思维链内容不下发，只展示进度与工具调用。
- 为降低延迟，发给模型的上下文去掉 `snapshot` 等非规划字段；服务端输出 `[voxa-ai] stream start/done/failed` 日志，包含上下文大小、首字节与总耗时，便于定位慢渠道。
- 客户端显示已用秒数与当前阶段；停止按钮可中断流式请求；失败会带出提供商错误（脱敏）。

验证：VOXA 全量 `tsc` 与生产构建通过；SSE mock 实测首条工具调用 0.25s 出现、完整计划 0.46s 到达；两步循环与 reasoning 参数透传通过；渠道“编辑不改密钥”后测试连接与拉取模型均成功。

## 慢请求诊断与感知优化（2026-10-31 第四轮）

实测当前两个渠道：

- `及触摸`（Anthropic / https://xcmapi.org / deepseek-v4.1-flash-1017）：极小 ping 测试 3.5s，模型列表约 0.9s，说明主要延迟在上游网关/模型；两个渠道均为管理员（平台）渠道。
- `天津拉拉吗`（Chat / https://ai.mosslab.internal）：18ms 内返回证书不受信错误，属于运行环境未信任内部 CA。

因此本轮做两件事：

- 让玩家能编辑：平台渠道在 VOXA 与地图面板都显示“复制”，复制为自己的渠道后可改密钥/模型；自己的渠道可直接编辑，留空密钥不覆盖。
- 让等待可见、可缩短：
  - 模型提示词要求 JSON 中 `commands` 放在 `message` 之前，并限制 message 长度，工具卡片可在流式阶段先出现。
  - 客户端不再等待“保存偏好”完成才发请求；上下文构建记录耗时与字节数（`[voxa-panel] context`）。
  - 分阶段显示：读取模型上下文 → 准备请求 → 等待模型响应（含已用秒数）→ 生成 → 校验；流式 `command` 事件逐条显示工具卡片。
  - 服务端记录 `[voxa-ai] stream start/done/failed`（上下文大小、首字节、总耗时、token），便于判断慢在网关还是模型。

## 多协议命令兼容与推理预算（2026-10-31 第五轮）

真实 DeepSeek 测试暴露了两类问题：

- **输出预算**：DeepSeek Responses 是推理模型，2048 输出预算会被 `reasoning_text` 全部耗尽并返回 `response.incomplete`，正文为空。现调整为 Chat 8192/12288、Responses 12288/16384、Anthropic 8192/12288（按思考强度），并对 `incomplete`、`finish_reason=length` 给出明确错误。
- **命令格式**：同一模型在不同接口会返回 `{"kind","args"}`、`{"cmd",...扁平}`、`{"paint":{...}}` 单键对象；另有 Anthropic `tool_use`、OpenAI `tool_calls/function_call`、Gemini `functionCall`。现统一归一化为 `{kind,args}`，无法识别的条目才计入 rejected，并在错误中列出原始 key/kind，便于定位。

验证：`apps/voxa/scripts/check-agent-plan-coercion.ts` 覆盖全部上述结构；真实 DeepSeek 流式蝙蝠测试 14s 返回 23 条命令、rejected=0；流式先到工具调用再出完整计划。

## 上下文缓存与成本优化（2026-11-01）

调研结论（DeepSeek 官方 KV cache、deepseek-harness、Anthropic/OpenAI prompt caching）：

- DeepSeek 按请求前缀落盘缓存，`A+B` 后的 `A+C` 不会命中 `A`，必须保持 append-only 前缀；官方 Usage：Chat `prompt_cache_hit_tokens` / `prompt_tokens_details.cached_tokens`，Responses `input_tokens_details.cached_tokens`，Anthropic 兼容 `cache_read_input_tokens`。DeepSeek 忽略 `cache_control` / `prompt_cache_key`。
- Anthropic 需要显式 `cache_control`（system/message 内容块，≤4 个断点）；OpenAI 自动前缀缓存并提供 `prompt_cache_key` 路由亲和；Responses 应使用消息数组而非扁平字符串。
- deepseek-harness 的核心是“模型可见内容 = 持久引用内容”的 append-only 投影；上下文压缩时原样重放上一请求前缀，只在末尾追加。

本轮实现：

- **服务端精确回放**：`apps/voxa/server/agent-conversation.ts` 按 userId/provider/model/systemHash/conversationId 保存完整消息（含上一轮模型原文），下一步只追加新用户消息；TTL 3 小时，超限按对裁剪并清空上下文以免增量链断裂。客户端发送每会话 UUID。
- **稳定前缀**：上下文规范化（parts 按 id、palette 按 colorId、cells 按坐标排序、数值定点），提示词改为 `{context|contextDelta, execution, request, step}`，易变字段靠后。
- **上下文增量**：第一步发全量；之后仅发 `contextDelta`（added/removed cells、变化的 parts/palette）；shape/partId/截断变化或差异过大时回退全量。System 中明确增量应用规则。
- **协议缓存标记**：Anthropic system + 最近两条消息加 `cache_control`；OpenAI host 加 `prompt_cache_key`；DeepSeek 不发送其忽略的参数。
- **可观测**：`provider-usage.ts` 统一解析命中/写入；台账新增 `cached_input_tokens`/`cache_write_tokens` 与 `cacheHitRate`；Admin“最近 AI 执行记录”显示缓存命中；VOXA 计划消息显示“上下文缓存命中 N%”。

实测：

- DeepSeek 官方流式蝙蝠：首个请求 input 787 / cached 640（81%），第二个 1606 / 768（48%），26 条命令全部解析（rejected=0）；Responses `input` 消息数组可用。
- Mock 会话两步：第二次请求确认为 `[user, assistant(原文), user]`，指令逐字节一致，`contextDelta` 含新增体素且移除为空，计划事件回传 cached 60/100。

已知边界：会话缓存当前为进程内存，重启或多副本会冷启动；DeepSeek 缓存 best-effort，不能作为正确性依赖。崩溃防护：NavBar/hierarchy/node-manager/redux 空节点守卫、AI 删除后清理选中、React error boundary 已加入。
