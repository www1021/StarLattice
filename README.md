# StarLattice · 多 Agent 编排与自进化平台

面向多 Agent 协作的 **Agent Harness**：把任务写成可编译、可调度、可验证、可回滚的工作流 DSL，而不是把 Prompt 写死在应用里。

> 2026 第五届“未来杯”创新大赛 · 赛道一「Agent 编排创新应用」
> 内置场景：教育实训（教案、课堂、学情、选题）与经营数据分析（销售指标、毛利口径、报告验证）

## 平台解决什么问题

- **编排不是拖拽壳**：工作流先经过编译器校验依赖、循环、作用域和子流程引用，再进入执行器；错误在运行前暴露。
- **调度有依据**：每个 Agent 节点在运行前生成调度计划，按能力匹配、可用度和优先级打分；任务声明模型标签时追加模型匹配权重，决策与理由写入 trace。
- **多模型协同**：逻辑模型目录把「角色」和「上游模型」解耦，Agent、节点、验证器可分别选 fast / reasoning / verifier；模型解析结果、回退与预算降级都写入步骤 trace。
- **结果可验证**：规则校验 → 多 Agent 交叉验证 → 基准比对，输出分数、置信度和问题清单；支持人工审批暂停/恢复。
- **优化有闭环**：Self-Loop 根据分数、提升幅度和预算决定继续或停止，并保留历史最优产物。
- **工具真接入**：内置 MCP 客户端，支持 stdio 与 Streamable HTTP，可发现并调用外部工具。

## 场景包

平台把“内核”和“场景内容”分开：编译、调度、执行、验证、Self-Loop 不认识任何行业概念，行业差异由 Agent、工具、模板与验证规则组合出来。

| 场景包 | 内置内容 | 用途 |
|---|---|---|
| 通用 | 6 个 Agent、1 条工作流、2 套模板、4 个基础工具 | 跨行业任务：规划、检索、执行、复核、报告 |
| 教育场景 | 17 个 Agent、8 条工作流、3 套模板、6 个工具 | 比赛深度验证：教案、课堂、学情、选题 |
| 经营分析 | 7 个 Agent、2 条工作流、1 套模板、5 个数据工具、1 个指标口径知识包 | 第二场景：销售概况 → 区域/品类并行分析 → 毛利口径验证 → 修正报告 |

注册中心与模板库顶部都提供场景筛选；未登记在清单中的自建内容归入“自定义”。新增场景只需注册 Agent / 工具、保存工作流与选择验证规则，不需要改引擎代码。

## 覆盖的官方能力

| 能力 | 平台实现 | 界面入口 |
|---|---|---|
| Agent 团队与版本 | 角色 / 技能 / 工具集 / 记忆（可选跨运行保留与召回）；版本快照、历史、回滚；节点可钉 `agentVersion` | 注册中心 |
| 知识库定义与集成 | 建库、上传、召回测试、绑定团队/工作流；绑定为已有 `knowledge.search` 节点提供默认检索范围（不会凭空添加节点） | 知识库管理 |
| 工作流编排 | 顺序、并行、条件、循环、验证、审批；**子工作流引用、编译期展开、环检测、父子 trace** | 编排画布 |
| 智能调度 | 能力匹配 0.5 + 可用度 0.3 + 优先级 0.2；节点可声明能力要求覆盖 Agent 标签；Agent 调用失败后按剩余候选运行中重调度；支持成本上限 | 运行监控 |
| 多模型协同 | 逻辑模型目录（provider / model / baseUrlEnv / apiKeyEnv / tags / costTier）；节点 → Agent → 全局默认的解析顺序；未知模型显式回退；验证器独立模型 | 注册中心 / 节点配置 |
| 工具与外部系统 | MCP stdio / Streamable HTTP、工具发现、调用超时、示例 MCP server | MCP 连接 |
| 监控与验证 | 步骤时间线、输入输出、错误堆栈、单步/整单重跑；三层验证、确定性硬规则、验证器独立性与置信度上限；失败突增 / 延迟突增 / 评分漂移异常告警 | 运行监控 / 验证报告 |
| 反馈与自我优化 | Self-Loop 修订、最优保留、停止原因、Agent 替换、换模型与 Prompt 修正 | 运行监控 |

## 节点与内置工作流

平台支持 16 类节点：

`start` · `end` · `agent` · `llm`（模型思考）· `clarify`（意图澄清与 Prompt 改写）· `knowledge`（知识库检索）· `tool` · `http` · `template`（文本模板）· `subworkflow` · `parallel` · `condition` · `loop` · `verify` · `approve`（人工审批）· `human`（人工交互）

启动时会自动注册 30 个 Agent（通用 6 + 经营分析 7 + 教育 17）与 15 条内置工作流：

| 工作流 | 说明 |
|---|---|
| `task-report-v1` | 通用任务链路：检索 → 规划 → 起草 → 独立验证 |
| `intent-clarify-v1` | 意图澄清：意图分析 → 仅关键歧义时暂停确认 → 结构化 Prompt 改写 → 起草 → 验证；运行面板并排展示原始需求与改写稿 |
| `business-analysis-v1` | 经营分析：销售概况 → 区域/品类并行 → 毛利初稿 → 关键指标验证 → 诊断 Agent 自主调用知识库/MCP 查证 → 输出修正补丁 → 按模型口径重算 → 修订报告 → 有效补丁晋升 Agent v2 |
| `classroom-map-v1` | 教育场景旗舰地图：双源检索 → 教学设计子流程 → 教师 + 五类学生并行演练 → 验证分流 → 学情报告 → 可选交付审批 |
| `business-map-v1` | 经营分析旗舰地图：规划 → 数据画像 → 多口径校准 → 终稿验证 |
| `classroom-v1` | 师范生课堂训练主链路 |
| `classroom-session-v1` | 虚拟课堂交互会话：每个教师回合暂停等待真实输入，结束后生成课堂报告 |
| `counseling-session-v1` | 谈心谈话交互会话：逐轮人工输入 → 学生反馈 → 会话总结 |
| `lesson-approval-v1` | 教案人工审核发布链路（approve 暂停/恢复） |
| `mcp-resources-v1` | MCP 教学资源工具链 |
| `topic-review-v1` | 论文选题评审链路 |
| `lesson-design-v1` | 教学设计子流程（可被主流程引用） |
| `classroom-rehearsal-v1` | 课堂演练子流程 |
| `learning-report-v1` | 学情报告子流程 |
| `teaching-pipeline-v1` | 教研全链路：模型思考 → 知识库检索 → 三个子流程 → 全局验证 → 交付模板，共 19 步 |

子工作流在编译期递归展开，内部步骤以 `父节点/子节点` 路径进入同一条 trace；最大嵌套深度 5，直接/间接环都会被拒绝。

## 架构

```
React 19 + React Flow 画布
        │ REST / WebSocket
Express 5 API
        ├─ DSL 解析与编译器 ── 依赖/作用域/环检测 · 子流程展开
        ├─ 调度器 planner ───── 能力 · 可用度 · 优先级 · 模型匹配 · 成本上限
        ├─ 执行器 executor ──── stub / live · 模型解析与降级 · 单步重试 · 审批门
        ├─ Self-Loop 控制器 ── 分数/增益/预算 → 重写 / 换 Agent / 换模型 / 补检索
        ├─ 三层验证器 ──────── 规则 → 交叉验证 → 基准比对
        ├─ MCP 管理器 ──────── stdio / Streamable HTTP
        └─ SQLite ──────────── platform.db · knowledge.db · training.db
```

- **stub 模式**：不需要任何模型 Key，所有 Agent/LLM/验证返回确定性结果，适合评审复现和单测。
- **live 模式**：显式设置 `PLATFORM_LIVE_AGENTS=1` 后才调用真实模型；失败不会静默降级。

## 快速开始

要求 Node.js 20+（推荐 22 / 24）。

```bash
npm install
cp .env.example .env
npm run dev
```

- 前端：http://127.0.0.1:5173（端口被占用时 Vite 会自动换端口，以终端输出为准）
- 后端：http://127.0.0.1:8787
- 默认 stub 模式，无需填写任何 API Key；首次启动自动建库并写入 Agent / 工作流种子数据。

启用真实模型：

```bash
# .env
PLATFORM_LIVE_AGENTS=1
PLATFORM_LIVE_MODEL=qwen3.8-flash
QWEN_API_KEY=你的Key
```

验证层要调用真实评审模型时再设 `PLATFORM_LIVE_VERIFY=1`。上游单次请求默认 180 秒超时，可用 `PLATFORM_MODEL_TIMEOUT_MS` 调整；超时会按节点失败处理，由执行器重调度，不会无限挂起。

### 多模型配置

Agent 注册记录和节点里的 `model` 填**逻辑 id**，执行器再把它解析成上游模型与供应商：

| 逻辑 id | 默认来源 | 建议角色 |
|---|---|---|
| `platform-default` | `PLATFORM_LIVE_MODEL` / `QWEN_MODEL` | 通用交付、报告 |
| `fast` | `PLATFORM_MODEL_FAST`，缺省跟随默认 | 规划、检索、初稿、学生模拟 |
| `reasoning` | `PLATFORM_MODEL_REASONING` / `PLATFORM_MODEL_STRONG` | 诊断、修订、教研分析 |
| `verifier` | `PLATFORM_VERIFY_MODEL`，缺省跟随默认 | 独立评审与打分 |
| `minimax` | `MINIMAX_MODEL` / `MINIMAX_BASE_URL` / `MINIMAX_API_KEY` | 跨供应商快速模型 |

```bash
# 示例：执行用 Qwen，诊断/验证换成 MiniMax，形成真实的异构分工
PLATFORM_LIVE_MODEL=qwen3.8-flash
PLATFORM_MODEL_FAST=qwen3.8-flash
PLATFORM_MODEL_REASONING=MiniMax-M3
PLATFORM_VERIFY_MODEL=minimax
MINIMAX_API_KEY=你的Key
```

只有把不同逻辑 id 指向不同上游模型（或不同供应商）时才是真正的多模型；否则只是逻辑分层。其它 OpenAI 兼容模型可通过 `PLATFORM_MODEL_CATALOG` 注册。解析结果会写入步骤 trace：`requestedModel`、`resolvedModel`、`modelProfile`、`modelSource`，未知模型带 `modelFallback`，预算降级带 `modelDowngraded`。设置 `PLATFORM_RUN_TOKEN_BUDGET` 后，超预算的高成本模型会自动降级到 `fast`。

### 验证器独立性与硬规则

三层验证不再只靠“两个提示词投个票”：

- **规则层是确定性的**：正文引用标记、引用能否绑定到证据池、必需小节、最小篇幅、数值一致（`number_match`）都单独检查；显式要求引用/小节/篇幅时，任一客观缺陷都会把总分封顶到阈值以下，模型分再高也不能越过阈值。
- **交叉验证有独立性等级**：`prompt`（同模型同证据，置信度 ≤0.60）→ `evidence`（同模型、证据视图不同，≤0.70）→ `model`（不同上游模型，≤0.85）→ `cross-provider`（不同供应商，≤0.95）。模型调用失败回退启发式打分时，独立性直接降级为 `prompt` 并写入问题清单。
- **置信度不再只看分差**：`(1 - 3 × 标准差)` 之外还会被独立性等级、规则分/基准覆盖率过低、模型分与规则分差距过大、硬规则失败分别压低上限。
- **证据视图可分离**：验证节点设 `evidenceView: "pool" | "cited" | "split"`。`split` 让第一名验证器看完整证据池、其余验证器只看产物实际引用的证据，避免两名验证器共享同一份“标准答案”。
- **逐验证器模型**：`verifierModels` 可以为每个验证 Agent 指定不同逻辑模型，优先级高于 Agent 注册记录和节点 `model`。

```json
{
  "id": "verify-report",
  "kind": "verify",
  "verifier": "topic-review-verifier",
  "verifiers": ["topic-review-verifier", "topic-review-auditor"],
  "verifierModels": {
    "topic-review-verifier": "reasoning",
    "topic-review-auditor": "fast"
  },
  "evidenceView": "split",
  "requireEvidence": true,
  "minCitations": 2,
  "requiredSections": ["总体结论", "必须修改项", "建议修改项", "引用来源"],
  "minChars": 1200,
  "threshold": 0.85
}
```

灵敏度实验对真实产物做定向删改后重新验证。硬规则审计不需要模型 Key：

```bash
npx tsx benchmarks/audit-verifier-sensitivity.ts <platform-*.db> topic-01 1 --rule-only
```

live 审计需要 `PLATFORM_LIVE_AGENTS=1`、`PLATFORM_LIVE_VERIFY=1` 与模型 Key，并使用 strict 打分器：模型失败直接中断，不会把启发式回退当成模型结果。

## 5 分钟演示路径（通用内核 + 教育场景包）

1. **新建**：侧边栏顶部「新建」展开菜单——选「新对话」进入通用办公助手（写作、总结、翻译、会议纪要、表格整理，独立于教育场景）；选「新建任务」打开任务参数面板（默认流程为通用「任务报告流水线」）。填写 `topic=Q3 客户反馈汇总`、`audience=管理层`，运行后看节点着色与验证结论。
2. **展开场景包**：侧边栏「场景包」默认折叠，展开后进入教育各页面（「场景对话」切回教学对话）；在流程下拉框选择「教研全链路（子流程编排）」，填写 `topic=分数的意义`、`subject=数学`、`grade=五年级`；同一套画布、trace 与验证规则。
3. **运行监控**：时间线出现 `design/design-plan`、`rehearse/classroom/student-top`、`report/insight` 等嵌套路径和「子流程边界」标记；展开模型思考节点可看到 `thinking`。
4. **注册中心**：查看团队、Agent 版本历史，回滚到旧版本；在工作流节点里钉住指定版本运行。
5. **知识库**：新建知识库、上传文档、召回测试，再绑定到工作流；工作流里的 `knowledge.search` 节点未显式指定范围时会使用该绑定。绑定只提供默认检索范围，不会新增节点。团队绑定用于限定调度池；Agent 的 memory 与 tools 清单会注入 live prompt 并写入 trace。
6. **MCP 连接**：启动示例服务器 `node scripts/mcp-demo-server.mjs`，在页面选择 `stdio`、命令 `node`、参数填 `scripts/mcp-demo-server.mjs`，保存并刷新即可看到 3 个工具；运行 `mcp-resources-v1` 查看真实调用耗时。
7. **人工审批**：运行 `lesson-approval-v1`，在运行监控页通过或驳回；通过后从审批节点原地续跑，不重放已执行的模型调用。
8. **验证报告**：查看各次运行的评分、置信度、维度问题和 Verifier 分歧。验证结论独立于运行状态：执行成功但验证未通过时，运行仍可能显示 `succeeded`，同时在标题旁显示「验证未通过」徽标。

## 经营分析场景演示（第二场景）

数据固定为 `data/demo/sales.csv`（24 单、净销售额 113,400.00、退款 3,700.00、销货成本 71,110.00），MCP 工具做确定性计算，不依赖模型算术。

1. 侧边栏「场景包」切到「经营分析」，在工作流下拉框选择「经营数据分析流水线」，`question` 填「本月各区域与品类的毛利表现如何？」。
2. 首轮规划 Agent 按用户问法选择 `gross`，`number_match` 以关键指标锚点拦截：销售额基准 `117,100.00`、毛利额 `45,990.00`、毛利率 `39.27%` 与净额对照值不一致，live 实测首验 **0.5395** 未通过。
3. 诊断 Agent 开启 `toolCalling`：自主调用 `knowledge_search` 检索口径规则、`profile` 读取数据概况、`metric_calc` 分别复算 `gross` 与 `net`，再把工具返回的事实写入 `evidence`，输出 `rootCause` / `action` / `revenueBasis` / `promptPatch`。平台按模型选择的口径重算并重写报告，复核 **0.95 ≥ 0.70** 通过，补丁晋升为 `business-planner` v2。
4. 第二次运行直接采用 v2 规则：规划首轮即选择 `net`，**0 轮循环、首验 0.9166 通过**。完整 run id、工具 trace 与晋升记录见 [`docs/2026-11-06-自愈B工具调用报告.md`](docs/2026-11-06-自愈B工具调用报告.md)，A+C 阶段记录见 [`docs/2026-11-06-自愈A+C实现报告.md`](docs/2026-11-06-自愈A+C实现报告.md)。
5. 「MCP 连接」页的 `data-analysis` 服务器可发现 5 个工具：`profile` / `metric_calc` / `groupby` / `trend` / `chart`；「指标知识库」可导入「经营分析指标口径包」。

## 测试与构建

```bash
npm run test:platform   # 平台单测（编译器/执行器/调度/Self-Loop/验证/MCP/存储）
npm run test:knowledge  # 知识库服务
npm run test:counseling # 谈心谈话
npm run build           # tsc + vite 生产构建
```

当前平台单测 **190/190**、知识库 **10/10**、基准脚本 **20/20** 通过；验证器构造样本 50/50；生产构建通过。

## 量化实验

评测集位于 `data/eval/tasks.json`（教育 20 例 + 选题 10 例）。五臂分别为：A0 历史单 Agent、A1 公平单 Agent（检索 + 统一交付契约）、B 固定流水线、C 完整平台、C−loop 完整平台去 Self-Loop；另有弱初稿压力臂 S / SN 用于触发 Self-Loop。所有臂的最终产物由同一契约生成，达标只看独立固定裁判（`fixed-judge-rules-v2`），不看平台自验分。

```bash
node benchmarks/run-bench.mjs                       # 30 用例 × 主表五臂
BENCH_ARMS=Cstatic,Csingle BENCH_LIMIT=2 node benchmarks/run-bench.mjs  # 消融臂 stub 烟测
BENCH_ARMS=S,SN BENCH_TASK_IDS=edu-01,edu-04,edu-10,edu-13,topic-02,topic-05 node benchmarks/run-bench.mjs
node benchmarks/clarify/run.mjs                     # 意图澄清 A/B（20 模糊需求 × 2 臂）
CLARIFY_LIMIT=10 CLARIFY_IDS=fz-01,fz-02,fz-03,fz-04,fz-05,fz-16,fz-17,fz-18,fz-19,fz-20 node benchmarks/clarify/run.mjs  # 缩减样本
npm run bench:verifier                              # 验证器构造样本准确率
BENCH_CONCURRENCY=1,5,20 node benchmarks/concurrency.mjs
```

- 默认继承当前运行模式；live 需要 `PLATFORM_LIVE_AGENTS=1` 与 `QWEN_API_KEY`，不设置时是 stub。
- **当前可引用的 live 证据：30 例 × 5 臂 × 1 次（150/150 成功）**：[合并报告](benchmarks/results/bench-merged-2026-11-08T02-55-02-172Z.md)。A0 达标 3.3% / 均分 0.595，A1 86.7% / 0.935，B 100.0% / 0.955，C 90.0% / 0.941，C−loop 100.0% / 0.960。配对差值：A1 − A0 = +0.340 [+0.310, +0.368]，B − A1 = +0.020 [+0.005, +0.040]，C−loop − B = +0.004 [−0.004, +0.014]，C − C−loop = −0.019 [−0.051, +0.004]；Self-Loop 触发 0/30，未触发时 C 与 C−loop 的差异只反映采样波动。检索 Recall@5 = 0.958，Precision@5 = 0.567。
- **报告由两批 live 运行合并**：教育 20 例取自 2026-11-07 批次（零失败），选题 10 例于 2026-11-08 重跑（50 次零失败，墙钟 22 分 37 秒，并发 3）。两批工作流、提示词、裁判与模型一致；期间只增加了模型请求超时与修了用例过滤，不影响口径。墙钟不合并推算。首批选题运行因上游请求挂起与账户欠费（HTTP 400 Arrearage）失效，[旧全量报告](benchmarks/results/bench-2026-11-07T17-52-16-749Z-p8790.md)已标为不可引用。
- **压力臂（Self-Loop 失败输入，小样本）**：[6 例 × 2 臂 = 12 次](benchmarks/results/bench-2026-11-08T03-04-44-999Z-p8792.md)，当前代码、零失败。S（保留循环）100% / 0.963，SN（去循环）83.3% / 0.916；配对 S − SN = +0.047（95% CI [+0.006, +0.119]），5 胜 1 负；循环触发 5/6，平均 1.0 轮，触发子集 +0.053（95% CI [+0.003, +0.140]，n=5）。代价是 Tokens 约 1.9 倍、P50 约 2.1 倍。样本 n=6、非随机，只能说明这批失败输入上有可测增益。旧批次（验证器修复前）为 S − SN = −0.045，已作为历史保留。
- **意图澄清 live A/B（缩减样本）**：[10 例 × 2 臂 = 20 次](benchmarks/results/clarify-ab-latest.md)，两臂零失败。实验组裁判分 0.978 / 达标 100%，对照组 0.883 / 80%；配对差 +0.095（95% CI [+0.062, +0.142]），10 胜 0 负，缺失槽位覆盖率 +31.0pp。答案为脚本按预设规格注入，不是真人回答；样本按“5 例重度缺失 + 5 例部分已给”控成本选取，非随机抽样。
- **消融口径**：多验证器的 live 证据是 `C−loop − B`（+0.004，不显著）；Self-Loop 的 live 证据是压力臂 `S − SN`（+0.047，小样本）。新增 `Csingle`（单验证器）与 `Cstatic`（去调度）两个消融臂，已通过 stub 烟测但尚未跑 live，不能当作已验证结论。
- **并发口径**：[并发报告](benchmarks/results/concurrency-latest.md) 仍为 stub，只反映调度与排队；live 并发未验证。旧报告里的 6ms 总耗时来自合并脚本计时缺陷，已改为缺少 `BENCH_SUITE_STARTED_AT` 时写“未记录”；C 66.7% / 96.7% 的旧批次已标为历史，禁止与主表混用。
- 结论边界：B 相对 A1 有小幅显著增益，C−loop 相对 B 不显著；C 相对 C−loop 不显著且略低，Self-Loop 在正常任务上未触发，因此不能宣称"完整平台提升常规任务达标率"。可测的增益集中在两处小样本实验：失败输入上的 Self-Loop（+0.047）与模糊需求上的意图澄清（+0.095）；其余价值由架构能力、验证器与工程约束支撑，不能外推为普遍提升。
- 原始逐次产物不入库；`benchmarks/.tmp/` 为隔离临时库，已忽略。

## 目录结构

```
server/platform/
  workflow/     DSL 解析、编译器、节点契约、内置工作流 JSON
  runtime/      执行器、状态存储、审批门、live handlers
  scheduler/    运行前调度计划
  selfLoop/     Self-Loop 控制器
  verify/       三层验证器与 live scorer
  registry/     Agent、团队、工具注册
  knowledge/    平台知识库
  mcp/          MCP 客户端与管理器
  metrics/      指标采集
src/features/platform/   画布、监控台、注册中心、知识库、MCP、验证报告
benchmarks/     promptfoo 五臂 / 压力臂、澄清 A/B、验证器准确率、并发压测、结果
scripts/        MCP 示例服务器、语音资源准备
docs/           验收记录与设计说明
data/eval/      评测集（其余 data/ 运行时数据库已忽略）
```

## 配置与安全

- `.env` 与本地 SQLite 数据库不进入仓库；`.env.example` 只保留空值和公开地址。
- 默认 stub 模式，不开模型调用；live 必须显式开启。
- MCP 服务器的环境变量以明文保存在本地 SQLite，API 只返回字段名（`envKeys`），不返回值。
- HTTP 工具只做登记与展示，不执行任意 URL；需要访问外部系统时走 MCP，避免工作流变成 SSRF 入口。
- 仓库历史不含真实密钥；开源或提交前仍建议轮换所有第三方 Key。

## 文档

- [多模型协同实现报告](docs/2026-11-06-多模型协同实现报告.md)
- [平台验收记录（D1.1–D3.5）](docs/2026-10-31-平台验收D1.1-D3.5.md)
- [可信评测执行记录（含欠费中断说明）](docs/2026-11-07-硬伤6-最小可信实验方案.md)
- [教育子集五臂报告](benchmarks/results/bench-2026-11-07T17-52-16-749Z-p8790-education-only.md)
- [验证器构造样本准确率](benchmarks/results/verifier-accuracy.md)
- [验证器硬规则灵敏度（rule-only，无需 Key）](benchmarks/results/verify-rule-sensitivity-latest.md)
- [验证器灵敏度实验（live，历史结果）](benchmarks/results/verify-sensitivity-latest.md)：旧脚本使用未登记模型 id，可能静默回退启发式；现已改为 strict 模式，失败直接中断，不再产生这类结果。
- [评测用例与工作流](benchmarks/workflows)

## License

[MIT](LICENSE)
