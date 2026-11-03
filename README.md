# StarLattice · 多 Agent 编排与自进化平台

面向多 Agent 协作的 **Agent Harness**：把任务写成可编译、可调度、可验证、可回滚的工作流 DSL，而不是把 Prompt 写死在应用里。

> 2026 第五届“未来杯”创新大赛 · 赛道一「Agent 编排创新应用」
> 内置场景：教育实训（教案、课堂、学情、选题）与经营数据分析（销售指标、毛利口径、报告验证）

## 平台解决什么问题

- **编排不是拖拽壳**：工作流先经过编译器校验依赖、循环、作用域和子流程引用，再进入执行器；错误在运行前暴露。
- **调度有依据**：每个 Agent 节点在运行前生成调度计划，按能力匹配、可用度和优先级打分，决策与理由写入 trace。
- **结果可验证**：规则校验 → 多 Agent 交叉验证 → 基准比对，输出分数、置信度和问题清单；支持人工审批暂停/恢复。
- **优化有闭环**：Self-Loop 根据分数、提升幅度和预算决定继续或停止，并保留历史最优产物。
- **工具真接入**：内置 MCP 客户端，支持 stdio 与 Streamable HTTP，可发现并调用外部工具。

## 场景包

平台把“内核”和“场景内容”分开：编译、调度、执行、验证、Self-Loop 不认识任何行业概念，行业差异由 Agent、工具、模板与验证规则组合出来。

| 场景包 | 内置内容 | 用途 |
|---|---|---|
| 通用 | 6 个 Agent、1 条工作流、2 套模板、4 个基础工具 | 跨行业任务：规划、检索、执行、复核、报告 |
| 教育场景 | 17 个 Agent、8 条工作流、3 套模板、6 个工具 | 比赛深度验证：教案、课堂、学情、选题 |
| 经营分析 | 4 个 Agent、1 条工作流、1 套模板、5 个数据工具、1 个指标口径知识包 | 第二场景：销售概况 → 区域/品类并行分析 → 毛利口径验证 → 修正报告 |

注册中心与模板库顶部都提供场景筛选；未登记在清单中的自建内容归入“自定义”。新增场景只需注册 Agent / 工具、保存工作流与选择验证规则，不需要改引擎代码。

## 覆盖的官方能力

| 能力 | 平台实现 | 界面入口 |
|---|---|---|
| Agent 团队与版本 | 角色 / 技能 / 工具集 / 记忆；版本快照、历史、回滚；节点可钉 `agentVersion` | 注册中心 |
| 知识库定义与集成 | 建库、上传、召回测试、绑定团队/工作流；绑定为已有 `knowledge.search` 节点提供默认检索范围（不会凭空添加节点） | 知识库管理 |
| 工作流编排 | 顺序、并行、条件、循环、验证、审批；**子工作流引用、编译期展开、环检测、父子 trace** | 编排画布 |
| 智能调度 | 能力匹配 0.5 + 可用度 0.3 + 优先级 0.2；运行前计划与理由落库 | 运行监控 |
| 工具与外部系统 | MCP stdio / Streamable HTTP、工具发现、调用超时、示例 MCP server | MCP 连接 |
| 监控与验证 | 步骤时间线、输入输出、错误堆栈、单步/整单重跑；三层验证与置信度 | 运行监控 / 验证报告 |
| 反馈与自我优化 | Self-Loop 修订、最优保留、停止原因、Agent 替换与 Prompt 修正 | 运行监控 |

## 节点与内置工作流

平台支持 10 类节点：

`agent` · `llm`（模型思考）· `tool` · `template`（文本模板）· `subworkflow` · `parallel` · `condition` · `loop` · `verify` · `approve`

启动时会自动注册 27 个 Agent（通用 6 + 经营分析 4 + 教育 17）与 10 条内置工作流：

| 工作流 | 说明 |
|---|---|
| `task-report-v1` | 通用任务链路：检索 → 规划 → 起草 → 独立验证（默认打开） |
| `business-analysis-v1` | 经营分析：销售概况 → 区域/品类并行 → 毛利初稿 → `number_match` 验证 → 净额重算 → 修订报告 |
| `classroom-v1` | 师范生课堂训练主链路 |
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
        ├─ 调度器 planner ───── 能力 · 可用度 · 优先级
        ├─ 执行器 executor ──── stub / live · 单步重试 · 审批门
        ├─ Self-Loop 控制器 ── 分数/增益/预算 → 继续或停止
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

验证层要调用真实评审模型时再设 `PLATFORM_LIVE_VERIFY=1`。

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
2. 首轮报告故意使用毛销售额口径，`number_match` 拦截：产物中的 `45,990.00`、`39.27%` 与核对基准不一致，首轮验证得分 **0.5425**。
3. Self-Loop 在循环体内按 `revenueBasis=net` 重算：毛利额 **42,290.00**、毛利率 **37.29%**，重建报告后第 1 轮得分 **0.74 ≥ 阈值 0.70**，停止迭代并保留修订稿。
4. 「MCP 连接」页的 `data-analysis` 服务器可发现 5 个工具：`profile` / `metric_calc` / `groupby` / `trend` / `chart`；「指标知识库」可导入「经营分析指标口径包」。

## 测试与构建

```bash
npm run test:platform   # 平台单测（编译器/执行器/调度/Self-Loop/验证/MCP/存储）
npm run test:knowledge  # 知识库服务
npm run test:counseling # 谈心谈话
npm run build           # tsc + vite 生产构建
```

当前平台单测 **112/112** 通过，构建通过。

## 量化实验

评测集位于 `data/eval/tasks.json`（教育 20 例 + 选题 10 例）。三基线分别为单 Agent、固定流水线和完整平台。

```bash
node benchmarks/run-bench.mjs                       # 30 用例 × 3 基线
BENCH_LIMIT=3 node benchmarks/run-bench.mjs         # 烟测
BENCH_CONCURRENCY=1,5,20 node benchmarks/concurrency.mjs
```

- 默认继承当前运行模式；live 需要 `PLATFORM_LIVE_AGENTS=1` 与 `QWEN_API_KEY`。
- 详细数据与口径见 [冻结的 30 用例报告](benchmarks/results/bench-merged-2026-10-31T15-50-58-263Z.md)、[并发报告](benchmarks/results/concurrency-latest.md) 和 [验收文档](docs/2026-10-31-平台验收D1.1-D3.5.md)。
- benchmark 原始逐次结果不入库，保留 `latest` 汇总与冻结报告；`benchmarks/.tmp/` 为隔离临时库，已忽略。

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
benchmarks/     promptfoo 三基线、并发压测、结果
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

- [任务与验收清单](TODO.md)
- [平台验收记录（D1.1–D3.5）](docs/2026-10-31-平台验收D1.1-D3.5.md)
- [验证器敏感性实验](benchmarks/results/verify-sensitivity-latest.md)
- [评测用例与工作流](benchmarks/workflows)

## License

[MIT](LICENSE)
