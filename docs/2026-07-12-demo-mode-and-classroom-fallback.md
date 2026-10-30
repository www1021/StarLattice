# 2026-07-12 国赛演示模式与模拟课堂容错验收记录

## 完成内容

- 强化 `/api/demo/seed-agent-records`：演示数据从单一模拟课堂扩展为四类训练各 5 条，支撑成长档案与智能体看板展示。
- 增加固定模拟课堂演示流程：前端虚拟课堂提供《分数的意义》5 句固定演示话术按钮。
- 保留并验证模型不可用时的规则 fallback：空模型配置下可完成 5 轮课堂互动并生成报告。
- 优化课堂报告容错：报告生成后，如果保存历史记录失败，接口仍返回报告，并提示可重试，不丢失课堂状态。
- 改善刷新或返回后的课堂恢复体验：
  - 前端将最近课堂快照保存到 `localStorage`。
  - 页面重新进入后先恢复本地快照。
  - 后端提供 `GET /api/classroom/:sessionId` 读取会话。
  - 后端提供 `POST /api/classroom/restore` 从本地快照恢复会话。

## 代码改动

- `server/index.ts`
  - 新增课堂会话读取和恢复接口。
  - 报告历史保存失败时降级返回报告。
  - seed 数据扩展为教案、说课、模拟课堂、实习反思四类训练。
- `server/classroom/classroomService.ts`
  - 新增 `restoreClassroom`，支持从课堂快照恢复 session store。
- `src/features/classroom/api.ts`
  - 新增 `getClassroom`、`restoreClassroom`。
  - `requestClassroomReport` 返回 `saveError`。
- `src/features/classroom/ClassroomTrainingPage.tsx`
  - 增加课堂快照本地缓存与恢复。
  - 增加固定模拟课堂演示流程按钮。
  - 报告失败提示中明确课堂状态已保留、可重试。
- `src/styles.css`
  - 增加固定演示流程工具条样式。

## 构建验收

- `npm run build` 通过。
- Vite 仍提示 chunk size warning，当前不阻断演示。

## 接口验收

测试端口：`8791`。
模型配置：显式清空 `QWEN_API_KEY`、`DASHSCOPE_API_KEY`、`AI_API_KEY`，验证规则 fallback。

流程：

1. `POST /api/demo/seed-agent-records`
2. `POST /api/classroom/create`
3. 连续 5 次 `POST /api/classroom/teacher-speak`
4. `GET /api/classroom/:sessionId`
5. `POST /api/classroom/restore`
6. `POST /api/classroom/report`

结果：

- seed 数量：20。
- seed 后四类训练均有数据：教案诊断、说课陪练、模拟课堂、实习反思。
- Agent 看板统计有值：
  - 学生 Agent 激活：171。
  - 观察员建议：71。
  - 事件 Agent 触发：87。
  - 证据链：251。
- 空模型配置下报告模式：`rule`。
- 模拟课堂完成轮次：5。
- 报告证据链数量：5。
- 课堂报告保存历史记录：成功。
- `GET /api/classroom/:sessionId` 恢复成功。
- `POST /api/classroom/restore` 恢复成功。

## 固定演示流程

课题：初中数学《分数的意义》。

1. 同学们，今天我们学习分数的意义。把一个苹果平均分成4份，其中1份可以怎样表示？
2. 赵明轩，你为什么认为只要分成4份就是四分之一？这里必须平均分吗？
3. 如果不是平均分，还能不能直接说其中一份是四分之一？请说明理由。
4. 先暂停一下，大家发言要围绕平均分和单位1，不要跑到吃苹果数量上。
5. 我们总结：分数表示把单位1平均分成若干份，取其中一份或几份。谁能再举例？

## 已知风险

- 本地快照恢复适用于演示和单机训练场景，不等同于正式多用户会话恢复。
- 如果浏览器禁用 `localStorage`，前端会退回普通课堂生成流程。
