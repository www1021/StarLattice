# 2026-07-20 智能体看板升级

## 完成内容

- 智能体看板完整展示学生 Agent 激活、课堂事件 Agent 触发、观察员建议、证据链沉淀和事件处理率。
- 看板新增四类训练能力画像，直接复用成长档案的四类训练覆盖数据，保证看板与成长档案一致。
- 看板新增“为什么系统认为你需要改进”解释区，从薄弱维度、最近训练和推荐任务生成可解释证据。
- 看板新增 Agent 协作流程可视化，展示教师行为分析、学生 Agent、课堂事件 Agent、课堂观察员和评价报告 Agent 的协作链路。

## 涉及文件

- `server/storage/chatRepository.ts`
- `src/main.tsx`
- `src/styles.css`
- `TODO.md`

## 验收要点

- 调用 `/api/demo/seed-agent-records` 后，`/api/growth/summary` 返回 `agentOperationStats`、`agentCapabilityProfile`、`agentImprovementReasons`、`agentCollaborationFlow`。
- 智能体看板能展示 5 个核心运行指标。
- 智能体看板的四类训练能力画像与成长档案 `trainingTypeSummaries` 一致。
- 页面能展示“为什么系统认为你需要改进”和 Agent 协作流程。
- `npm run build` 通过。

## 验证结果

- `npm run build` 通过；Vite 仍提示单包超过 500KB，这是既有体积提示，不阻断功能。
- `/api/demo/seed-agent-records` 返回 `seeded: 20`。
- `/api/growth/summary` 返回 Agent 指标：学生 Agent 激活、课堂事件 Agent 触发、观察员建议、证据链沉淀、事件处理率。
- `/api/growth/summary` 返回 4 条四类训练覆盖数据，与成长档案页面使用同一份 `trainingTypeSummaries`。
- `/api/growth/summary` 返回 3 条 `agentImprovementReasons` 和 5 步 `agentCollaborationFlow`。
- 浏览器核查确认智能体看板展示 5 项核心指标、四类训练能力画像、原因解释区和 Agent 协作流程。
