# 易师训 Agent 工作规范

> 适用范围：`/Users/wgx/Project/Yiban/YiJiaoXun` 的一切开发、评测、文档与比赛材料工作。
> 当前目标：2026 未来杯赛道一（Agent 编排创新应用），初赛截止 **2026-11-20**，目标决赛一等奖。
> 本文件与 `TODO.md` 配套：`agent.md` 管「怎么做」，`TODO.md` 管「做什么、什么时候做」。
> 最后更新：2026-10-31

---

## 1. 每次开工前的固定动作

1. 读本文件。
2. 读 `TODO.md` 第 13 节「下一次开工直接执行」，再读当前任务条目的验收标准。
3. 检查工作区：`git status --short`。不回退、不覆盖用户已有改动；发现陌生改动先查清来源。
4. 确认本次任务的闭环：输入是什么、输出是什么、结果落到哪张表/哪个页面/哪份材料。
5. 确认运行模式：stub 还是 live；是否会产生模型费用；是否需要隔离数据库。
6. 完成后必须给出证据：命令输出、测试结果、页面截图或数据文件。口头说明不算完成。

### 1.1 任务执行协议

- 小步实现，一次只做一个可验收单元。
- 先补测试或至少写清复现步骤，再改行为。
- 改完跑对应验证；影响平台内核时跑 `npm run test:platform`；影响知识库时跑 `npm run test:knowledge`；提交前跑 `npm run build`。
- 只有在有证据后才勾选 `TODO.md`，并在 `docs/YYYY-MM-DD-任务名.md` 写验收记录。
- 复核、标注、抽检由执行者自己完成，不把任务退回用户做人工复核。
- 遇到阻塞先尝试降级方案（stub、BENCH_LIMIT、只跑单例），不要停工等待。

---

## 2. 项目定位与优先级

易师训原本是面向师范生教学能力成长的多智能体实训平台。当前作品定位是：

> **面向教学训练场景的可信多 Agent 编排平台**：提供 Agent/工具注册、JSON DSL 与可视化编排、可解释调度、状态机执行、三层验证、Self-Loop 收敛和可复现的三基线实验；教育训练是平台上的第一个场景。

优先级从高到低：

1. 赛题五模块：Agent 定义与配置、工作流编排、任务调度与执行、结果验证与监控、反馈循环与优化。
2. 量化证据：成功率、验证分、延迟、P95、循环轮次、token/成本、基线对比。
3. 提交材料：方案书、PPT、视频、README/可运行仓库。
4. 体验优化与扩展能力。

任何改动不得破坏现有教育闭环：教案、说课、模拟课堂、实习反思、成长档案、知识库。

### 2.1 叙事边界

- 讲「从教育应用沉淀出平台内核」，不讲「包装了一个教育应用」。
- 平台通用性靠「同一执行器 + 同一套节点类型 + 两套 DSL」证明，不靠第三个场景堆数量。
- 不把本地演示说成真实易班接口；易班联动必须标注「本地演示 / 预留接口 / 可扩展接入」。
- 不伪造用户数据、试点数据或性能数字。

---

## 3. 当前架构地图

```
前端 src/
  main.tsx                         应用主入口与侧边栏路由
  features/classroom/              模拟课堂
  features/platform/
    WorkflowCanvasPage.tsx         编排画布
    RunMonitorPage.tsx             运行监控台
    NodeInspector.tsx              节点配置抽屉
    PlatformNodeCard.tsx           画布节点卡片
    layout.ts                      ELK 自动布局
    useDefinitionHistory.ts        zundo 撤销重做
    api.ts / types.ts / platform.css

后端 server/
  index.ts                         应用与平台装配入口
  platform/
    types.ts                       Agent/Tool/Node/Run/Verify/Loop 类型
    routes.ts                      /api/platform/*
    workflow/dsl.ts                DSL 解析
    workflow/compiler.ts           校验、拓扑排序、环检测、展开
    workflow/nodeTypes.ts          六类节点字段契约
    workflow/classroom-v1.json     教育主链路 DSL
    registry/agents.ts             11 个种子 Agent
    registry/tools.ts              7 个工具（builtin/mcp/http）
    runtime/executor.ts            状态机、超时、重试、快照、回滚
    runtime/stateStore.ts          SQLite 表与读写
    runtime/liveHandlers.ts        真实 Qwen Agent / 内置工具 handler
    scheduler/scheduler.ts         能力匹配 + 负载 + 优先级
    selfLoop/controller.ts         停止原因、修正动作、预算
    verify/verifier.ts             规则 + 交叉 + 基准三层验证
    verify/liveScorer.ts           LLM 逐维度打分与缓存
    metrics/                       指标采集（待建）

  lessonPlanService.ts             教案
  speakTrainingService.ts          说课
  classroom/                       模拟课堂
  internshipReflectionService.ts   实习反思
  knowledgeService.ts              知识库
  storage/chatRepository.ts        训练历史与成长档案

benchmarks/
  run-bench.mjs                    三基线评测入口（30 用例，分场景/分难度汇总）
  build-cases.mjs                  从 data/eval/tasks.json 生成 promptfoo 用例
  promptfoo/                       provider（按场景路由工作流）与生成的用例
  workflows/                       A/B/C 三套 DSL × 教育/选题两场景
  knowledge/                       8 个隔离知识库样本
  results/latest.md                最新基准报告
data/eval/tasks.json               评测集单一来源（输入/期望要点/rubric/阈值/难度）
```

### 3.1 数据位置

| 数据 | 默认路径 | 覆盖变量 |
|---|---|---|
| 平台运行/Agent/工作流 | `data/platform.db` | `PLATFORM_DB_PATH` |
| 训练历史/成长档案 | `data/training.db` | `TRAINING_DB_PATH` |
| 知识库/FTS | `data/knowledge.db` | `KNOWLEDGE_DB_PATH` |
| 导出文件 | `generated/` | 无 |
| 基准临时库 | `benchmarks/.tmp/` | 由 `run-bench.mjs` 自动生成 |

`data/`、`generated/`、`benchmarks/.tmp/` 不入库。

---

## 4. 运行模式与环境开关

### 4.1 模式判定

- 执行器构造时，只要注入了任一 handler（agent/tool/verify），模式就是 `live`；否则 `stub`。
- `live` 需要同时满足：`PLATFORM_LIVE_AGENTS=1` 且 Qwen Key 已配置；否则 `createPlatformLiveHandlers` 返回空对象，继续 stub。
- `PLATFORM_LIVE_AGENTS=1` 但缺 Key 时，服务启动会打印警告并保持 stub。
- `.env` 里默认没有 `PLATFORM_LIVE_AGENTS`；跑 live 基准时用命令行前缀显式开启，不改 `.env`。

### 4.2 环境变量

| 变量 | 作用 | 默认/注意 |
|---|---|---|
| `PLATFORM_LIVE_AGENTS` | `1` 开启真实 Agent handler | 默认关闭，避免误计费 |
| `PLATFORM_LIVE_MODEL` | 平台工作流文本模型 | 当前 `qwen-plus`；不设置则回退 `QWEN_MODEL` |
| `QWEN_MODEL` | 应用聊天/多模态模型 | 当前 `qwen3-vl-plus`，不要因平台评测随意改 |
| `PLATFORM_LIVE_VERIFY` | `0` 关闭 LLM 验证打分 | 默认开启；关闭后回退启发式 |
| `PLATFORM_LIVE_MAX_TOKENS` | 单次 Agent 输出上限 | 默认 2048 |
| `PLATFORM_LIVE_TEMPERATURE` | Agent 温度 | 默认 0.35 |
| `PLATFORM_STEP_TIMEOUT_MS` | live 单步超时 | 默认 120000；stub 默认 30000 |
| `PLATFORM_STUB_DELAY_MS` | stub 放慢，便于演示 | 默认 0 |
| `PLATFORM_FAIL_NODE_IDS` | 逗号分隔的失败注入节点 | 仅调试/演示失败重试 |
| `PLATFORM_DB_PATH` | 平台数据库 | 基准必须隔离 |
| `TRAINING_DB_PATH` | 训练数据库 | 基准必须隔离 |
| `KNOWLEDGE_DB_PATH` | 知识库数据库 | 基准必须隔离 |
| `BENCH_PORT` | 基准服务端口 | 默认 8790 |
| `BENCH_BASE_URL` | 复用已启动服务 | 设置后不自动起服务 |
| `BENCH_LIMIT` | 每个基线只跑前 N 例 | 烟测用 |
| `BENCH_RANGE` | 只跑指定下标区间（如 `20:30`） | 分场景烟测 |
| `BENCH_PATTERN` | 只跑 description 匹配正则的用例 | 调试单个用例 |
| `BENCH_RUN_TIMEOUT_MS` | 单例等待上限 | 默认 600000 |
| `BENCH_SKIP_LATEST` | 分块跑时不覆盖 `latest.md` | 设为 `1` |
| `BENCH_SUITE_STARTED_AT` | 合并报告的总耗时起点 | 毫秒时间戳 |
| `BENCH_CONCURRENCY` | 并发档位，如 `1,5,20` | 仅并发脚本 |
| `BENCH_CONCURRENCY_TASK` | 并发压测用例 id | 默认 `edu-01` |
| `BENCH_CONCURRENCY_WORKFLOW` | 并发压测工作流 | 默认按场景选 C 工作流 |
| `BENCH_KNOWLEDGE_BASE_IDS` | 基准知识库 id | 由 `run-bench.mjs` 自动注入 |

### 4.3 硬规则

- 不打印、不提交、不截图 `.env` 的值；只能看字段名。
- 不用 `.env` 做一次性实验；用命令行前缀或临时环境变量。
- 不随意切换 `QWEN_MODEL`；平台模型和应用模型分开，避免多模态链路受影响。
- 基准必须使用隔离的 `PLATFORM_DB_PATH / TRAINING_DB_PATH / KNOWLEDGE_DB_PATH`，不能污染 `data/`。
- 不杀用户正在使用的 5173 / 8787 进程；基准用 8790。

---

## 5. 五模块实现契约

### 5.1 Agent 与工具注册

- Agent 必填：`id`、`name`、`role`、`prompt`、`capabilities`；可选 `tools`、`model`、`version`。
- 能力标签用于调度，必须是稳定的短词（如 `lesson-plan`、`classroom-observer`）。
- 种子注册使用 `INSERT OR IGNORE`，重启幂等，不覆盖用户手工修改。
- 自定义 Agent/工具通过 API 新增；更新时省略字段要保留原值，版本 +1。
- 工具类型只允许 `builtin`、`mcp`、`http`；未接入的 MCP/HTTP 工具必须明确返回 `not_connected`，不能假装成功。

### 5.2 DSL 与编译器

- DSL 用 JSON，不用 YAML。
- 节点只有六类：`agent`、`tool`、`parallel`、`condition`、`loop`、`verify`。
- 编译器负责：必填校验、重复 id、未知引用、拓扑排序、环检测、子流程展开、条件表达式校验。
- 循环条件允许读取循环体内已产生的输出；循环体外的未来输出不允许引用。
- 任何新节点字段先改 `workflow/nodeTypes.ts` 契约，再改解析、画布抽屉和测试，避免三处漂移。

### 5.3 执行器

- 状态：`queued → running → verifying → revising → succeeded / failed / rolled_back`。
- 必须保留：单步超时、指数退避重试、成功快照、失败回滚、并行分支 `allSettled`。
- 每步落 `platform_run_steps`：输入、输出、状态、尝试次数、错误堆栈、快照。
- 验证节点默认验证「最近一个非验证节点的输出」；证据取整个运行收集到的引用。
- 异步启动返回 202 + running 记录；同步运行返回完整结果。
- 单步重跑只追加一条步骤记录，不改原运行状态，不向下游传播；UI 必须标注这一点。
- 不要在 stub 模式引入随机结果；stub 必须确定性，便于回归和演示。

### 5.4 调度器

- 公式：能力匹配、负载、优先级加权；决策必须可解释。
- 每个任务输出：选中 Agent、得分拆解、匹配能力、当前负载、次选 Agent、中文理由。
- 无候选时输出能力缺口；依赖未满足时输出阻塞原因。
- 调度器不是装饰：当前只在 Self-Loop 换 Agent 时调用，D1.2 要接入运行前全局规划。
- 换 Agent 时复用同一调度器，排除当前 Agent；不要另写一套选人逻辑。

### 5.5 三层验证器

- 规则层：输出非空、必需内容、占位符、证据引用、最小长度。
- 交叉层：至少 2 个验证器独立按 rubric 打分；单验证器置信度上限 0.5。
- 基准层：对照 `expectedKeywords`，缺失要点要列出。
- 总分公式：`交叉分 × (0.5 + 0.5 × 规则分) × (0.6 + 0.4 × 基准覆盖率)`。
- 置信度按验证器分数标准差折算；分歧大要降置信度并写入 issues。
- LLM 打分器按「验证器 + rubric + 证据 + 产物」缓存；解析失败回退启发式，不能让验证阶段拖垮运行。
- 修改公式、阈值、置信度逻辑必须同步更新 `VERIFY_CONTRACT` / `VERIFY_FORMULA`、方案书和测试。

### 5.6 Self-Loop

- 停止原因：`passed`、`max_iterations`、`no_improvement`、`budget_time`、`budget_tokens`、`while_false`。
- 修正动作只做三种：`rewrite`、`swap_agent`、`retrieve`；不做工作流自动改写。
- DSL 字段：`maxIterations`、`while`、`patience`、`budget.maxDurationMs`、`budget.maxTokens`。
- 每轮把修正指令注入循环体内 Agent 的 `selfLoop` 输入（轮次、分数、问题、动作）。
- 必须保留全部迭代记录，不删除失败轮次。
- **必须保留历史最优产物**：最后一轮变差时回滚到最优轮；初始产物也参与比较。D1.1 未完成前，不要把 C 的结果当作平台优势证据。

---

## 6. 编码规范

### 6.1 TypeScript

- 后端是 ESM 风格，跨文件导入写 `.js` 后缀；前端导入不写后缀。
- 不用 `any` 兜底；外部输入用 `unknown` + 类型守卫。
- 领域类型放 `server/platform/types.ts`；不要在前端重复定义不一致的镜像类型。
- 新增依赖必须先说明理由；能用现有依赖解决就不加新包。
- 不引入 Python 服务、ORM、向量数据库或消息队列。

### 6.2 注释与命名

- 默认不写注释；只在「为什么」不直观、存在隐藏约束或踩坑时写一行。
- 不写「这个函数做什么」的复述型注释。
- 用户可见文案、日志、文档用中文；代码标识符用英文。
- 不在代码里写死密钥、真实姓名、学校班级、手机号。

### 6.3 错误处理

- 业务错误抛 `PlatformError(message, status)`，message 用中文，状态码准确。
- API 用统一的 `fail(response, error)`；不要每个路由各写一套。
- 外部模型调用失败时：记录可读错误 → 回退 stub/启发式 → 保持运行状态可恢复。
- 不吞错；`catch` 后要么处理，要么带上下文抛出。fire-and-forget 必须显式注释原因。

### 6.4 数据库

- 使用 `better-sqlite3`；建表语句幂等。
- 新增列用「检查列是否存在再 `ALTER TABLE`」的迁移方式，不能假设库是空的。
- JSON 字段统一 `JSON.stringify/parse`，读取时对损坏数据回退空结构。
- 运行、步骤、验证、循环记录必须能通过 `runId` 串起来。
- 不在事务里做网络请求。

### 6.5 前端

- 复用 `src/features/platform/platform.css` 和现有设计语言；不引入 UI 组件库。
- 页面必须有加载态、空态、错误态。
- 运行中状态用轮询；WebSocket 是 P2，不阻塞主线。
- 画布变更要可撤销；保存失败要按 `issues[].path` 回标节点。
- 不做装饰性动画、不做 3D、不做移动端专门适配；保证窄屏不横向滚动即可。
- 截图要能直接进 PPT：关键数字大、层级清楚、无调试信息。

---

## 7. 验证命令与完成定义

### 7.1 常用命令

```bash
npm run test:platform      # 平台内核单测，改动内核必跑
npm run test:knowledge     # 知识库解析/检索，改动知识库必跑
npm run build              # 前后端类型检查 + 生产构建，提交前必跑
npm run dev                # 应用开发模式；前端 5173，后端 8787
npm run bench              # stub 基准，默认 8790，隔离临时库
```

### 7.2 live 烟测与全量

```bash
# 只跑 1 例，确认 key、知识库、验证链路都通
PLATFORM_LIVE_AGENTS=1 PLATFORM_LIVE_VERIFY=1 BENCH_LIMIT=1 npm run bench

# 跑 3 例，检查稳定性
PLATFORM_LIVE_AGENTS=1 PLATFORM_LIVE_VERIFY=1 BENCH_LIMIT=3 npm run bench

# 全量（30 例：教育 20 + 选题 10，三基线共 90 次运行）
# 单进程跑满约 80 分钟，容易被运行环境超时终止；按区间分块并合并更稳：
PLATFORM_LIVE_AGENTS=1 BENCH_RANGE=0:8   BENCH_SKIP_LATEST=1 npm run bench
PLATFORM_LIVE_AGENTS=1 BENCH_RANGE=8:16  BENCH_SKIP_LATEST=1 npm run bench
PLATFORM_LIVE_AGENTS=1 BENCH_RANGE=16:24 BENCH_SKIP_LATEST=1 npm run bench
PLATFORM_LIVE_AGENTS=1 BENCH_RANGE=24:30 BENCH_SKIP_LATEST=1 npm run bench
node benchmarks/merge-results.mjs benchmarks/results/chunks/chunk-*.json

# 只跑选题场景（用例下标 20:30）
PLATFORM_LIVE_AGENTS=1 PLATFORM_LIVE_VERIFY=1 BENCH_RANGE=20:30 npm run bench

# 并发压测（默认端口 8792，不占基准端口）
PLATFORM_STUB_DELAY_MS=300 BENCH_CONCURRENCY=1,5,20 node benchmarks/concurrency.mjs
PLATFORM_LIVE_AGENTS=1 BENCH_CONCURRENCY=1,5 node benchmarks/concurrency.mjs

# 选题评审可靠性审计（只读运行库，输出到 results/audit-topic-latest.md）
node benchmarks/audit-topic-reviews.mjs benchmarks/.tmp/platform-<stamp>.db ...

# 验证器灵敏度审计（对真实产物做缺陷注入，输出到 results/verify-sensitivity-latest.md）
PLATFORM_LIVE_AGENTS=1 PLATFORM_LIVE_VERIFY=1 npx tsx benchmarks/audit-verifier-sensitivity.ts <platform-*.db> topic-01 2
```

`merge-results.mjs` 会校验 30 个用例 × 3 基线齐全且无重复，只有通过才写 `latest.md`；分块结果放 `benchmarks/results/chunks/`。

评测集单一来源：`data/eval/tasks.json`；`benchmarks/build-cases.mjs` 在每次基准前自动生成 `benchmarks/promptfoo/promptfooconfig.yaml`，不要手工改生成文件。三套教育 DSL 与三套选题 DSL 均在 `benchmarks/workflows/`。

注意：

- live 单例可能 45–165 秒；全量前先估算时间和费用。
- 出现 `Arrearage`、429、401 时，先判断是欠费、限流还是 key 失效；不要连续重试烧额度。
- 基准报告必须写清模式、模型、用例数；`latest.md` 只能由脚本生成，不手改。

### 7.3 完成定义

一个任务算完成，必须同时满足：

- 代码/文档已落盘，没有半成品分支。
- 对应测试通过；没有测试的改动说明原因并给出手工复现步骤。
- `npm run build` 通过（只改文档可例外，但要在回复中说明）。
- 行为变化有可截图的页面或可复查的 API/数据。
- `TODO.md` 勾选，`docs/YYYY-MM-DD-任务名.md` 有验收记录。
- 未引入密钥、隐私数据、许可证风险。

---

## 8. 基准评测规范

### 8.1 三基线

| 基线 | 工作流 | 目的 |
|---|---|---|
| A 单 Agent | `bench-single-agent` | 直接生成，无编排、无验证、无循环 |
| B 固定流水线 | `bench-fixed-pipeline` | 固定顺序多 Agent，有验证，无调度、无循环 |
| C 完整平台 | `bench-full-platform` | 检索 + 教案 + 验证 + Self-Loop + 并行演练 + 报告 |

- 三套 DSL 在 `benchmarks/workflows/`，不要为单次实验临时改口径。
- 用例在 `benchmarks/promptfoo/promptfooconfig.yaml`；知识库样本在 `benchmarks/knowledge/`。
- 任务达标 = 运行成功且 `verifyPassed !== false`；运行成功不等于达标，报告里必须分开。
- 结果写 `benchmarks/results/bench-*.md/json/csv` 与 `latest.md/csv`。

### 8.2 改动后的复测规则

- 改执行器、验证器、调度器、Self-Loop：至少 `BENCH_LIMIT=3` live 复测；影响结论时跑全量。
- 改提示词、Agent 配置、知识库样本：跑全量，避免小样本偶然性。
- 改评测集：A/B/C 必须同一批用例，不能只跑 C。
- 复测后更新 TODO 与验收记录；如果结论变差，如实写，不隐藏。

### 8.3 当前已知结论

- 8 用例 live：A 0% 达标 / 0.555；B 75% / 0.862；C 62.5% / 0.852。
- C 未跑赢 B 的根因是 Self-Loop 不保留最优产物，不是模型能力不足。
- C 的 P95 明显高于 B，因为多了验证与循环；材料里要解释成本换来了什么。

---

## 9. 安全与合规

- `.env` 永不入库、永不截图、永不出现在日志/文档/测试记录里。
- 任何读取 `.env` 的命令只输出字段名，例如 `sed -E 's/=.*/=<hidden>/' .env`；不 `cat`、不 `grep` 值。
- 不在代码、DSL、基准用例里写真实 API Key。
- 开源/提交前轮换 Qwen、IMA、讯飞、Langfuse 等真实密钥。
- 不执行破坏性 git 命令（`reset --hard`、`clean -f`、`push --force`、删除分支）。
- 不回退用户已有改动；不删除陌生文件；需要清理时先确认来源。
- 不杀用户正在运行的服务；基准使用独立端口和临时数据库。
- 第三方许可证：n8n（Sustainable Use）、Windmill（AGPL）、Dify 附加条款、Flowise 商业 `ee` 不进入作品代码。
- 截图和视频必须遮挡密钥、手机号、真实学生姓名、学校内部信息。
- 主动写局限性和失败案例，不夸大「支持千并发」「已大规模落地」。

---

## 10. 协作与回复方式

- 全程用中文；技术术语保留英文原名。
- 结论先行，说明改了哪些文件、跑了什么命令、结果如何、还差什么。
- 不假设已有团队成员分工；单人项目直接实现，不把任务写成「留给 A/B/C」。
- 不要求用户做人工复核、标注或抽检；执行者自己验证并给出证据。
- 只在「会阻塞方向」或「需要付费/对外操作」时提问；其余按 TODO 和现有代码推断。
- 涉及推送、提交、发布、对外发送等不可逆操作，先征得用户同意。
- 汇报风险时给可执行预案，不只列问题。

---

## 11. 已知约束与风险

| 约束 | 影响 | 处理 |
|---|---|---|
| Qwen 额度可能欠费/限流 | live 基准中断 | 平台模型用 `qwen-plus`；先 `BENCH_LIMIT=1` 烟测；保留 stub 录屏兜底 |
| live 单步 120 秒超时 | 长输出可能失败 | 控制 prompt 与 maxTokens；失败可重试；监控页看错误堆栈 |
| Self-Loop 不保留最优 | C 可能低于 B | D1.1 修复前不宣传 C 的分数优势 |
| 调度器只在换 Agent 时调用 | 五模块「调度」证据不足 | D1.2 运行前全局规划 |
| 单步重跑不重算下游 | 监控页可能被误解 | UI 明确标注；D1.6 再考虑下游重算 |
| 主包 >500 kB | 构建警告 | 不阻断比赛；不在截止前做大拆分 |
| 教育页仍走 `classroomService` | 平台化叙事有缺口 | 保留 fallback，演示从平台画布启动；D2.3 增量接入 |
| 报名/材料未确认 | 可能错过截止 | D0.1 今天确认；材料 11/10 必须开工 |
| SQLite 并发写 | 压测可能锁库 | 压测用独立库；记录瓶颈，不吹高并发 |

---

## 12. 禁止事项

- 不把平台做成「部署 Dify/Langflow/Sim」的演示。
- 不为了通用性做第三个场景。
- 不重写现有四类训练功能。
- 不在截止前引入新数据库、新语言、新框架。
- 不伪造基准数据、用户数据、试点证明。
- 不跳过测试直接勾 TODO。
- 不把 `.env`、密钥、隐私信息写进任何提交物。
- 不在未确认的情况下推送、发布、提交或清理仓库。
