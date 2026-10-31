# GOAL · AI 共同创作引擎（持续迭代）

> 启动：2026-10-31 · 状态：active · 原则：只写有证据的结论；每轮都要有可复跑的验收。

## 目标（Definition of Done）

1. **接管式共创闭环**：在真实社区地图上，人选定区域 → agent 读取现图 → 提出改动 → 编辑器内审阅 → 应用 → 保存 → 重启后仍在 → 可回滚。
2. **四个内容域同等级**：地形 / 实体 / 界面 / 脚本都能「提案 → 应用 → 持久逆操作 → 回滚」，并支持跨域计划（补偿式，非原子）。
3. **创作质量**：至少一次真实、可见、可玩的场景续作，附截图与回放；不能只有单格测试。
4. **交付形态**：可直接使用的编辑器面板 + MCP + 技能文档；一键起栈；测试与回归可复跑。

## 当前状态（每轮更新）

| 能力 | 状态 | 证据 |
|---|---|---|
| 地形提案/应用/回滚/跨重启逆数据 | ✅ | `authoring-rollback-restart-smoke.json` |
| 脚本提案/检查/应用/持久逆操作 | ✅ | `script-restart-smoke.json` |
| 界面属性域 | ✅ | `ui-restart-smoke.json` |
| 实体属性域 | ✅ | `check-entity-transactions.ts`（fixture） |
| 实体生命周期 create/delete/move/subtree | ✅ | `check-entity-lifecycle.ts`、`authoring-entity-lifecycle-smoke.json` |
| 跨域计划（补偿式） | ✅ | `check-plan-transactions.ts`、`authoring-plan-smoke.json` |
| 事件流 SSE + 持久回执 | ✅ | `authoring-events.ts`、`authoring-journal.ts` |
| 资源目录 + 检索 | ✅ | `_corpus/catalog.mjs` |
| 面板：提案审阅/应用/回滚/放弃/历史 | ✅ | `ai-activity/proposals.tsx` + 截图 |
| 面板：计划视图 | ⬜ | 仅 API |
| 可见创作验收 | 🟡 | 数据已验证（凉亭 83 格 + 1 实体），**镜头桥接不可靠，截图未取到** |

## 已知缺陷（按优先级）

1. **活体通道命令队列会卡死**：连续 `look` 超时后队列堆积（队列4），相机不再响应；`look` 回执声称已移动但视图不变。影响人类可见性，不影响服务端写入。
2. plan 分组不持久化（提案与逆数据持久，plan 需重建）。
3. 地形尚未成为 ContentDomain，无法与实体/界面编入同一计划。
4. 实体复制（copy）未实现。
5. Creator 全仓 tsc 仍有既有错误（本轮文件无新增诊断）。

## 下一轮队列

1. 修活体通道队列：超时命令必须出队并允许后续命令；camera 命令改为幂等设置而非 tween 排队。
2. 地形 ContentDomain 化 → 让"平台 + 摆件 + 标签"成为一个计划。
3. 面板计划视图（选择多个提案 → 建计划 → 应用/回滚）。
4. 可见创作验收：修好镜头后重拍凉亭；再做一个带 UI 提示的休息点。
5. 实体 copy、跨域冲突合并 UI。
