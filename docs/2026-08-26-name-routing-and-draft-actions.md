# 2026-08-26 名字识别选人 + 操作按钮改为拟稿

## 完成内容

1. 选人引擎名字识别：教师自由发言中只要包含学生姓名，该学生获得 +100 压倒性加分，保证第一个回答。修复"喊赵明轩却学霸抢答"的缺陷。
2. 课堂操作按钮由"替教师直接发送"改为"拟稿进输入框"：点名回答、追问理由、发起同伴讨论、进入课堂小结、提醒全班回到任务点击后只把话术草稿写入教师输入框，由教师确认/修改后自行发送。教师每一句话都出自己口，符合训练定位与录屏原则。
3. 操作面板文案同步更新，说明"点击后在输入框生成话术，确认后发送"。

## 涉及文件

- `server/classroom/studentReactionEngine.ts`：新增 `nameMentionBonus`，并入 `selectUniversalResponders` 与 `selectQuestionResponders` 两个排序。
- `src/features/classroom/ClassroomTrainingPage.tsx`：删除 `handleClassroomAction` 与 `sendClassroomAction` 调用；新增 `handleDraftAction`、`buildActionDraft`、`findLastTeacherQuestion`（话术文本与后端原 buildActionTeacherText 保持一致）。
- `src/features/classroom/components/ClassroomOperationPanel.tsx`：两组副标题与五张动作卡片描述更新为拟稿语义。

## 构建结果

- `npm run build` 通过，仅原有 500KB chunk 警告。

## 接口验证（重启新后端后实测）

- `POST /api/classroom/create` 创建《分数的意义》课堂。
- 第一句"同学们，今天我们学习分数的意义。把一个苹果平均分成4份，其中1份可以怎样表示？"→ 2 人回应（全班提问语义保持）。
- 第二句"赵明轩，你为什么认为只要分成4份就是四分之一？这里必须平均分吗？"→ 回应者仅 [赵明轩]，内容为误解型纠正回答。名字识别生效。

## 行为说明

- 拟稿话术经输入框发送后走 teacher-speak 统一路径，规则引擎对 management/summary/instruction 等文本的识别与原 action 接口效果等价（事件处理、阶段判断不变）。
- 后端 `/api/classroom/action` 接口保留未删，前端不再调用。

## 历史记录 / 成长档案

- 无影响；训练记录仍经 teacher-speak 正常沉淀。

## 已知风险

- 拟稿依赖前端本地拼装 lastQuestion/topicKeywords，与后端原逻辑同源，若后端话术模板后续调整需同步前端。
- 名字识别为 includes 匹配，学生名为随机生成，理论上存在名字互为子串的可能，实际名册中未见。

## 追加修复：拟稿嵌入内容剥离学生名字

- 问题：点名/追问拟稿会把上一句教师发言原样嵌入；若上一句喊过名字，草稿会出现两个名字，名字识别给两人同时加分，基线分高的学霸可能压过选中对象，导致"选了 A 却是 B 回答"。
- 修复：`buildActionDraft` 新增 `stripStudentNames`，嵌入前剥掉源问题里所有学生名字并清理残留标点（如开头逗号），保证草稿全文只有开头一个名字；剥离后为空则回退"请结合刚才的课堂内容回答。"
- `npm run build` 通过。
