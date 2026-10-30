# 2026-08-26 报告生成后自动滚动进视野

## 完成内容

- 点击「完成训练」生成诊断报告成功后，页面平滑滚动到报告面板顶部（`scrollIntoView` smooth + block start），用户和录屏观众能直接看到报告出现。
- 状态条变为错误态时（如报告保存失败、课堂生成失败），平滑滚动到状态条（block center），避免底部点击、顶部报错看不到的问题。
- 未加高亮闪烁装饰（按用户确认范围执行）。

## 涉及文件

- `src/features/classroom/ClassroomTrainingPage.tsx`：新增 `statusRef`、`reportPanelRef`；新增两个 `useEffect` 分别监听 `report` 与 `statusTone === "error"` 触发滚动；状态条 `<p>` 挂 ref；报告面板外包 `div.classroom-report-anchor` 挂 ref。
- `src/styles.css`：新增 `.classroom-report-anchor { scroll-margin-top: 16px; }`，滚动落点不贴顶。

## 构建结果

- `npm run build` 通过，仅原有 500KB chunk 警告，不阻断。

## 页面流程

- 成功路径：完成训练 -> 报告渲染 -> 平滑下滑至报告面板。
- 失败路径：任意操作报错 -> 状态条滚入视野中央。
- 关闭报告（onClose）不触发滚动。

## 历史记录 / 成长档案

- 纯前端交互调整，不涉及数据写入，无影响。

## 已知风险

- 页面加载时若恢复课堂失败产生错误态，也会触发一次滚动；状态条本就在页首附近，影响可忽略。
