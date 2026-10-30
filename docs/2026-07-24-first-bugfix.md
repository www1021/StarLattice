# 2026-07-24 第一轮 bug 修复记录

## 修复结论

- 第一轮系统测试未发现阻断级 bug，本日严重 bug 清零。
- 已补齐模拟课堂报告的可导出成果闭环：生成课堂报告时同步生成 Word 文档，并保存到历史记录和成长档案。
- 已优化模拟课堂报告生成时的加载提示、保存失败提示和报告弹层中的下载入口。
- 已复测知识库引用链路，确认昨天引用数为 0 是测试输入未选择知识库，不是检索链路失效。

## 本次改动

- `server/index.ts`
  - 新增课堂报告 Word artifact 生成逻辑。
  - 保存模拟课堂历史记录时同步保存 artifact。
  - `/api/classroom/report` 响应新增 `artifact` 字段。
- `src/features/classroom/types.ts`
  - 新增 `ClassroomArtifact` 类型。
- `src/features/classroom/api.ts`
  - 更新课堂报告接口返回类型，支持读取 `artifact`。
- `src/features/classroom/ClassroomTrainingPage.tsx`
  - 保存课堂报告 artifact 状态。
  - 优化生成报告时的加载提示，说明会汇总证据链、Agent 决策依据和 Word 报告。
  - 报告保存成功后提示 Word 成果名称；失败时保留可重试提示。
- `src/features/classroom/components/ClassroomReportPanel.tsx`
  - 报告弹层新增 Word 下载入口。
  - 成果未返回时显示低干扰重试提示。
- `src/styles.css`
  - 新增课堂报告下载入口和空成果提示样式。

## 回归验证

| 验证项 | 结果 | 说明 |
|---|---|---|
| `npm run build` | 通过 | 仅有 Vite chunk 体积提示，不影响运行 |
| 模拟课堂报告导出 | 通过 | `/api/classroom/report` 返回 `数学-分数的意义-模拟课堂诊断报告.docx` |
| 成长档案成果统计 | 通过 | 最新模拟课堂记录 `artifactCount = 1` |
| 知识库引用链路 | 通过 | 上传短文本资料后，教案生成返回 1 条 citation |
| 四模块稳定回归 | 通过 | 教案、说课、模拟课堂、实习反思均可跑通 |

## 非阻断观察

- 单阶段说课回归分数偏低，原因是只提交了一个说课阶段；第二轮系统测试应使用完整十阶段说课文本。
- 教案和课堂报告在模型增强场景下仍可能出现 15 秒级耗时；当前已有 fallback 和更明确的加载提示，可继续在 7 月 26 体验优化日检查细节。

## 验收结论

- 第一轮严重 bug 清零。
- 四个模块均能稳定跑通。
- 课堂报告现在可作为可下载成果进入成长档案，国赛材料闭环更完整。
