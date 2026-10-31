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
