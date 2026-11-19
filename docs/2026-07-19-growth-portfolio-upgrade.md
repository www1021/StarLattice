# 2026-07-19 成长档案升级

## 完成内容

- 成长档案新增四类训练覆盖聚合，分别展示教案诊断、说课陪练、模拟课堂、实习反思的次数、均分、最新记录、证据数量、成果数量和下一步任务。
- 成长档案页面强化“跨四类训练的成长档案，不是单篇反思或分数看板”的表达。
- 成长档案继续展示平均得分、薄弱维度、推荐下一步任务、能力成长矩阵、训练证据时间线、代表性成果和智能体协同证据。
- 成长档案 Markdown 与 Word 导出内容新增“四类训练覆盖”章节，保证导出报告与页面信息一致。

## 涉及文件

- `server/storage/chatRepository.ts`
- `server/index.ts`
- `src/main.tsx`
- `src/styles.css`
- `TODO.md`

## 验收要点

- 调用 `/api/demo/seed-agent-records` 后，`/api/growth/summary` 返回四类训练覆盖数据。
- 成长档案页面能展示四类训练均已覆盖，并能看到均分、证据数、成果数和最新记录。
- `/api/growth/report` 支持 `md` 和 `docx` 两种导出，并包含“四类训练覆盖”章节。
- `npm run build` 通过。

## 验证结果

- `npm run build` 通过；Vite 仍提示单包超过 500KB，这是既有体积提示，不阻断功能。
- `/api/demo/seed-agent-records` 返回 `seeded: 20`。
- `/api/growth/summary` 返回 4 类训练覆盖：教案诊断、说课陪练、模拟课堂、实习反思均为“已覆盖”。
- 成长档案接口返回 `growthTimeline: 10`、`representativeArtifacts: 4`、`capabilityMatrix: 6`。
- `/api/growth/report` 成功生成 `StarLattice成长档案.md` 和 `StarLattice成长档案.docx`。
- 浏览器核查确认成长档案页展示“已覆盖 4/4 类训练”，并保留导出 MD、导出 Word 入口。
