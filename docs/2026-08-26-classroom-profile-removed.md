# 2026-08-26 删除虚拟课堂班级画像描述行

## 完成内容

- 删除配置面板底部的班级画像长描述（"初中数学普通班五人微格课堂……协同运行"整段），页面更干净，配置区只保留字段网格与生成按钮。

## 涉及文件

- `src/features/classroom/components/ClassroomConfigPanel.tsx`：移除 `.classroom-profile` 段落渲染。
- `src/styles.css`：删除 `.classroom-profile` 样式块。

## 构建结果

- `npm run build` 通过；全局检索 `classroom-profile` 无残留。

## 说明

- `classProfile` 字段仍保留在数据类型与后端生成逻辑中，仅前端不再展示；若后续报告或档案需要可再引用。

## 历史记录 / 成长档案

- 无影响。
