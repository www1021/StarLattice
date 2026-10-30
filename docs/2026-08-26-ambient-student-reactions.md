# 2026-08-26 未发言学生氛围反应（方案 A）

## 完成内容

- 修复"第一句发出后非发言学生仍显示等待课堂开始"的缺陷：每轮教师发言后，对未被选中回答的学生做氛围反应更新——`lastReaction` 换成符合人设的听讲反应文案，`currentStatus` 轻移（走神/沉默按稳定种子拉回专注）。
- 不往时间线加条目，避免噪音；发言学生仍为唯一出声者，主次不变。

## 涉及文件

- `server/classroom/studentReactionEngine.ts`：
  - 新增 `AMBIENT_REACTIONS`（五类人设各两条听讲文案）与 `applyAmbientReactions`。
  - `planStudentResponses` 在回答轮后调用氛围轮。
  - 修复种子负数越界：`stableResponseSeed` 返回 -15~15，取文案用 `Math.abs(seed) % length`。

## 接口验证

- 创建《分数的意义》课堂并发送第一句后，全部学生 `lastReaction` 非空：2 名发言者给出真实回答，3 名未发言者显示"安静听讲，没有举手。/走神了一下，被提醒后回头看黑板。/皱着眉，对刚才的说法有点犹豫。"等氛围文案，状态 focused。

## 构建结果

- `npm run build` 通过。

## 历史记录 / 成长档案

- 氛围反应只更新学生对象，不新增 conversation/timeline 记录，沉淀链路不变。

## 已知风险

- 氛围文案为固定池（每类 2 条），长课堂可能重复；当前演示 5 轮内可接受。
