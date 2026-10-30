# 2026-08-26 说课模式选中态颜色由近黑改墨绿

## 完成内容

- 说课训练室"完整说课 / 实时追问"模式按钮的选中态（`.speak-mode-active`）由近黑 #26313c 改为墨绿 #335a4e（全站主色），白字保留；纸面风页面上不再出现孤立黑块。
- 按用户要求只改选中态：主操作按钮（`.speak-primary`）与追问按钮（`.speak-response button`）保持原 #26313c 不变。

## 涉及文件

- `src/styles.css`：
  - `.speak-training-mode-selector .speak-mode-active` 色值替换。
  - 原共用规则 `.speak-room-mode .speak-mode-active, .speak-controls .speak-primary, .speak-response button` 拆分为两条：选中态用 #335a4e，主按钮/追问按钮保留 #26313c。

## 构建结果

- `npm run build` 通过，仅原有 500KB chunk 警告。

## 页面流程

- 纯样式调整，交互与数据链路无影响；楷体纸面主题下选中态白字规则（11259 行附近）不受影响。

## 历史记录 / 成长档案

- 无影响。

## 已知风险

- 若后续希望主按钮也脱离近黑，可再把 `.speak-primary`/`.speak-response button` 换同色或浅染方案。

## 追加调整：选中态改浅染

- 用户反馈墨绿实底仍偏重，选中态改为纸面浅染：背景 #eaf3ee、文字 #2f5d4e、边框 #335a4e（两处 `.speak-mode-active` 规则同步）。
- 楷体主题覆盖规则 `.app-shell:has(.speak-workspace) .speak-room :is(...)` 中移除 `.speak-mode-active`，避免浅底被强制白字。
- `npm run build` 通过。

## 追加调整：输入方式与主按钮同改浅染

- 「语音说课 / 文本练习」选中态（`.speak-input-method-selector button.is-active`）与全部 `.speak-primary` 按钮（开始说课、优先重练、口语化预览页脚等三处定义）统一改为浅染：#eaf3ee 底、#2f5d4e 字、#335a4e 边框。
- 主题白字覆盖列表再移除 `.speak-primary`，仅保留 `.speak-response button` 等深色按钮的白字。
- 追问回应按钮（`.speak-response button`）按用户指定范围保持 #26313c 深色不变。
- `npm run build` 通过。

## 追加调整：开始套卷与回应追问同改浅染

- 「开始套卷」（`.speak-exam-paper button`）与「回应追问」（`.speak-response button`）统一改为浅染：#eaf3ee 底、#2f5d4e 字、#335a4e 边框。
- 主题白字覆盖列表最终仅保留 `.speak-coverage-list article.is-covered > div > span`。
- 全站其余 #26313c 实底按钮仅剩虚拟课堂页「生成虚拟课堂」「发送讲课/完成训练」，属另一页面主 CTA，本次不动。
- `npm run build` 通过。

## 追加调整：评委徽章三色浅染（方案 A）

- 三个角色头像徽章由深色实底白字改为同色系浅染，保留角色区分：
  - 研究员：底 #edf1f6、字 #435260、边框 rgba(67,82,96,0.3)
  - 教研员：底 #eaf3ee、字 #3f5a50、边框 rgba(79,109,98,0.35)
  - 专家：底 #efedf5、字 #5d5870、边框 rgba(93,88,112,0.3)
- 楷体主题中徽章圆形化规则（2923 行附近）不受影响；分数数字等文字重量未动。
- `npm run build` 通过。

## 追加调整：播放追问按钮同改浅染

- 评委卡片「播放追问」按钮（`.speak-role button`）由白底近黑字改为浅染：#eaf3ee 底、#2f5d4e 字、#335a4e 边框，与全页按钮统一。
- `npm run build` 通过。

## 追加调整：评委席状态条徽章同改浅染

- 「追问与答辩」面板顶部评委席状态条的圆形徽章（`.speak-defense-current > span`，含 teacher/expert 变体）由深色实底白字改为与评委卡片徽章一致的三色浅染（研究员 #edf1f6/#435260、教研员 #eaf3ee/#3f5a50、专家 #efedf5/#5d5870，各带同色细边框）。
- `npm run build` 通过。

## 追加调整：说课稿信纸化（建议 4）

- `.speak-primary-workspace textarea` 加信纸质感：左侧 42px 处一道朱红边线 rgba(178,90,72,0.3)，每 26px 一条极淡横线 rgba(127,140,154,0.14)（与 26px 行高对齐，background-position 分层偏移使横线落在行底），纸色底 rgba(252,251,246,0.9)，左内边距 58px 让文字起于红线右侧。
- `background-attachment: local` 使格线随内容滚动，长稿不错位。
- 锁定态 `.is-locked` 仍覆盖为素灰底，读稿时不显示格线，可接受。
- 黑板锚点未动。
- `npm run build` 通过。

## 追加调整：说课结构五框去重色（方案 A）

- 「说课结构识别」五个结构框中两块重色调浅：教学设计 #C9C6C7 → #EFEEF0（浅灰），评价设计 #8FB8A8 → #E4EFE9（浅灰绿）；教学依据 #FDF9D9、目标与重难点 #F7F6F2、教学反思 #EEDFD2 保持原浅彩。
- 五框保留淡彩区分，整组视觉重量统一变轻。
- `npm run build` 通过。
