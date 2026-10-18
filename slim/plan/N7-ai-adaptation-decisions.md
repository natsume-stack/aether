# N7 · AI 强制适配的两条绑定决策（主控，2026-10-18）

运行中的泳道不会自动读到本文，但**交付时我按这两条逐条验收**；F（端到端 demo）与后续泳道开工前必读。

## 决策 1：AI 身份走 `bxc_` CLI Token + `/api/creator/v1/**` 契约，**不给 `/internal/*` 加共享密钥当身份**

理由（全部有源码依据）：

- `/internal/ai-tool` 是在 `services/game-server/src/createServer.ts:648-654` 注册的 **loopback-only、无任何鉴权** 的"同机编排面"（`ai-tool-route.ts` 注释自述：Security boundary mirrors `localOnly`，**No auth is added to or bypassed from any existing route**）。给它加一个 `BOX_AI_AUTHORING_TOKEN` 等于把"零鉴权 + 仅回环"变成"零身份 + 单把共享密钥即全图写权限"：**无法区分是谁、无法按人审计、无法单独撤销、泄露即全权**。
- 已有的正确形态是 **`bxc_*` CLI Token**：`shared/creator-cli-policy.ts:5-15` 定义 9 个 scope（`projects.list/resources.list/scripts.read/scripts.update/storage.read/storage.write/runtime.view/runtime.control/scene.capture`），走 `/api/creator/v1/**`，在 OpenAPI 里就是 `securitySchemes.creatorToken`（`internals/apis/openapi/openapi.json`），并且今天刚收紧成"Bearer 只能触达 creator/v1，其余创作端路由 403 `CREATOR_CLI_ROUTE_DENIED`"（`creator-api-security.ts`，11/11 用例，红/绿对照已证）。
- ⇒ **"专属机读密钥"应当是 CLI Token 的一个新 scope，而不是一把旁路密钥。** 强制适配的做法：
  1. 在 `creator-cli-policy.ts` 增加 AI 创作 scope（例如 `authoring.apply`），并让签发端（`pages/api/player-admin/players/[subjectId].ts`）+ 门户勾选 UI 一起支持；
  2. 把 AI 工具面**提升到 `/api/creator/v1/authoring/*`**（带身份、带审计、可撤销、可限流），`/internal/ai-tool` 保持回环原样，只服务同机编排（编辑器面板/本地 launcher）；
  3. 每次 AI 写操作落审计行：`{tokenSubject, projectId, tool, revisionBefore, revisionAfter, result}`。
- 泳道 D 若仍主张给 internal 加 token，必须同时给出"为什么不能走 creator/v1 + 新 scope"的反证；否则我按本决策验收。

## 决策 2：UI 交互**不是能力空白**，禁止新造事件模型

盘底事实：

- 交互能力已存在于**脚本侧事件映射**：`packages/script-api/src/client/modules/ui.ts:4-27` 定义了 `UiEvent/UiInputEvent/UiImageEvent` 与事件名 `pointerdown / pointerup / focus / blur / load`；同目录还有 `events.ts`、`input.ts`。
- 声明层枚举也已存在：`internals/schema/project/ui-rda/defs.ts:814` 注释"实现 `packages/script-api/src/client/modules/ui.ts` 的枚举"，`:818` 是 `export enum PointerEventBehavior`。
- ⇒ 真实缺口只有两个：① **MCP 没把 `uiTreeRead/uiNodeAdd/uiNodeRemove` 透给 AI**（泳道 A 修）；② 缺少"节点 ↔ 脚本事件绑定"的**写入校验与一致性门**（悬空控件、指向不存在脚本、事件名非法）——这是泳道 C 该补的东西。
- **红线**：C 不得为了"让 AI 好写"而新增/改写 UI 数据形状或事件语义。真实地图挂了 **86 个未声明自定义属性**，任何 schema 变更都必须是 **additive**，且要通过 `compat-check.sh` 的"只允许增长/超集"判定。若 C 的结论是"绑定关系在现有 schema 里表达不出来"，它必须给出源码证据并停下交我决策，而不是自己扩 schema。

## 验收口径（我逐条查）

| 泳道 | 交付必须证明 |
|---|---|
| A | `ui_*`、`terrain_*`、`entity_*`、`model_*` 可被 MCP 调用；写操作有乐观锁 + 预算门 + 失败回滚；测试 ≥53 且 0 失败 |
| C | 只用既有 `UiEvent` 名 + `PointerEventBehavior` 完成绑定写入与校验；旧地图 uiTree 读回逐字节不变；若判定需扩 schema，输出证据而非改动 |
| D | AI 通道落在 creator/v1 + 新 scope 上；令牌不落盘；给出签发/撤销/审计路径；`/internal/*` 保持 loopback-only 不变 |
| B | `save/preview` 顺序约束有源码依据（`replica-server.ts:1602`）；并明确回答 `/edit` 公网化后 internal 路由的可达性与收紧 |
| E | DoD 里含"UI 引用悬空即红"，且每条规则都有反例真的变红 |
