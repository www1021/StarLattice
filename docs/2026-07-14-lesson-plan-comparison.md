# 2026-07-14 教案前后对比与测试验收记录

## 完成内容

- 新增教案初稿与优化稿对比摘要，覆盖目标、学情、活动、评价、育人融入五个维度。
- 教案生成、优化、流式生成接口均返回 `comparison`，并将对比摘要写入历史记录。
- 教案评价继续以 `教案诊断` 类型写入 `training_evaluations`，成长档案可从历史记录聚合训练次数和得分。
- 教案中心、聊天结果卡片、教案预览侧栏展示前后对比与知识库引用来源。
- 侧边栏恢复“教案生成”入口，方便直接进入教案结果页测试。
- 演示 seed 数据包含 5 组教案测试记录，并补充五维优化标注。

## 验证记录

- `npm run build`：通过。
- `POST /api/demo/seed-agent-records`：返回 `seeded: 20`。
- 本地 SQLite 查询：
  - `training_evaluations` 中 `教案诊断` 共 48 条。
  - `agent_demo_01` 至 `agent_demo_05` 共 5 组教案演示测试数据。
  - 教案诊断平均分 83.7。
- `GET /api/growth/summary`：
  - `summary.trainingTypeCounts["教案诊断"]` 为 48。
  - 成长档案可统计教案训练次数和得分。

## 测试数据说明

5 组教案演示数据：

- `agent_demo_01`：分数的意义，74 分。
- `agent_demo_02`：责任与集体，77 分。
- `agent_demo_03`：古诗意象品读，80 分。
- `agent_demo_04`：生态系统稳定性，83 分。
- `agent_demo_05`：英语课堂提问，86 分。
