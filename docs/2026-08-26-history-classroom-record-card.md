# 2026-08-26 历史记录课堂记录卡与长文折叠（A+B）

## 完成内容

- A：模拟课堂训练记录从历史"继续"进入聊天后，不再渲染成一整段白底长文，改为结构化"课堂诊断记录卡"：复用 `EvaluationPanel`（总分大数字 + 维度分条 + 诊断 + 下一步任务），原始报告全文收进折叠。
- B：通用长文折叠——任何超过 300 字的消息正文只显示前 300 字 + "展开完整内容/收起完整内容"切换按钮，全类型受益。

## 涉及文件

- `src/main.tsx`：
  - 新增 `CollapsibleText`（300 字折叠）与 `ClassroomRecordCard`（EvaluationPanel + CollapsibleText）组件。
  - 消息气泡渲染链新增分支：`message.evaluation?.trainingType === "模拟课堂"` → 记录卡；通用兜底 `<p>` 替换为 `CollapsibleText`。
- `src/styles.css`：新增 `.classroom-record-card`（grid 间隙、内嵌评价卡紧凑化）与 `.text-collapse-toggle`（浅染小按钮，与全站按钮语言一致）。

## 数据来源

- 记录卡数据取自现有 `latestEvaluation`（overallScore/dimensions/diagnosis/suggestions/nextTask）与消息 artifacts/citations，后端零改动。
- 恢复逻辑 `restoreConversation` 已把 latestEvaluation 挂到最后一条 assistant 消息，无需修改。

## 构建结果

- `npm run build` 通过。

## 页面流程

- 历史 → 模拟课堂记录"继续"→ 聊天页看到记录卡：评价结构 + 折叠全文 + 成果链接（原有 artifacts 区块不变）。
- 其他类型长消息（如说课报告文本）同样折叠，展开可看全文。

## 历史记录 / 成长档案

- 纯展示层调整，无影响。

## 已知风险

- 记录卡仅在带 evaluation 的最后一条 assistant 消息生效；同会话更早的长消息走 B 折叠兜底，可接受。
