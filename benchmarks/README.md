# 基准评测与压测

## 目录

- `run-bench.mjs`：主表五臂（A0 历史单 Agent / A1 公平单 Agent / B 固定流水线 / C 完整平台 / C−loop 去自循环）× 30 用例，走 promptfoo；另含两个消融臂（Csingle 单验证器 / Cstatic 去调度）与弱初稿压力臂 S / SN。
- `judge.mjs`：固定裁判，只看产物正文与用例元数据，不看臂标签、平台自验分或循环记录。
- `verifier-accuracy.ts`：验证器 50 条构造样本准确率评估（不调用外部模型）。
- `clarify/run.mjs`：意图澄清 A/B（模糊需求直接执行 vs 先澄清再执行）。
- `concurrency.mjs`：并发压测，默认 `1,5,20` 三档，复用同一套隔离环境。
- `build-cases.mjs`：从 `data/eval/tasks.json` 生成 promptfoo 配置。
- `workflows/`：主表五臂、两个消融臂与压力臂对应的平台 DSL。
- `clarify/workflows/`：澄清 A/B 的对照组与实验组 DSL。
- `knowledge/`：评测用知识库文档。
- `results/`：汇总报告；原始逐次 JSON/CSV 不入库。

## 运行

```bash
# 五臂全量；默认继承当前 .env 的运行模式
node benchmarks/run-bench.mjs

# 烟测 / 指定用例 / 指定臂
BENCH_LIMIT=3 node benchmarks/run-bench.mjs
BENCH_TASK_IDS=edu-01,edu-10,topic-02 node benchmarks/run-bench.mjs
BENCH_ARMS=C,Cloop node benchmarks/run-bench.mjs

# 消融臂（不进入默认五臂，避免全量成本翻倍）
BENCH_ARMS=Cstatic,Csingle BENCH_LIMIT=2 node benchmarks/run-bench.mjs
# Cstatic：跳过运行前调度，直接用 DSL 声明的 Agent；Csingle：把双验证器收敛为单验证器

# 弱初稿压力臂（Self-Loop 触发证据）
BENCH_ARMS=S,SN BENCH_TASK_IDS=edu-01,edu-04,edu-10,edu-13,topic-02,topic-05 node benchmarks/run-bench.mjs

# 意图澄清 A/B（20 个模糊需求 × 2 臂）
node benchmarks/clarify/run.mjs

# 验证器准确率（离线构造样本）
npm run bench:verifier

# 并发压测
BENCH_CONCURRENCY=1,5,20 node benchmarks/concurrency.mjs
```

常用环境变量：

| 变量 | 作用 |
|---|---|
| `BENCH_LIMIT` | 限制用例数 |
| `BENCH_RANGE` | promptfoo 用例范围，如 `1:5` |
| `BENCH_PATTERN` / `BENCH_TASK_IDS` | 用例名过滤 / 指定任务 id |
| `BENCH_ARMS` | 只跑指定臂：`A0,A1,B,C,Cloop,Csingle,Cstatic,S,SN` |
| `BENCH_JUDGE_MODE` | `rules`（默认，确定性）或 `llm` |
| `BENCH_PORT` | 隔离服务端口，默认 8790 / 压测 8792 |
| `BENCH_EXTERNAL=1` | 复用已有服务，不再启动隔离进程 |
| `BENCH_CONCURRENCY` | 并发档位，默认 `1,5,20` |
| `BENCH_CONCURRENCY_TASK` | 压测用例，默认 `edu-01` |
| `BENCH_THRESHOLD` | 达标线，默认 `0.85` |
| `CLARIFY_PORT` / `CLARIFY_LIMIT` / `CLARIFY_IDS` / `CLARIFY_CONCURRENCY` | 澄清 A/B 的端口、用例数、指定用例与并发 |

live 模式需要 `PLATFORM_LIVE_AGENTS=1` 和 `QWEN_API_KEY`；不设置时是 stub，零模型费用。

## 消融矩阵

所有对比都只认固定裁判 `evalScore`，同用例配对做差。

| 对比 | 隔离的组件 | 当前证据 |
| --- | --- | --- |
| A1 − A0 | 知识库检索 + 统一交付契约 | live，30 例，+0.340 [+0.310, +0.368] |
| B − A1 | 三角色演练 | live，30 例，+0.020 [+0.005, +0.040] |
| C−loop − B | 多验证器（无验证 → 双验证器） | live，30 例，+0.004 [−0.004, +0.014]，不显著 |
| Csingle − C−loop | 单验证器 vs 双验证器 | 臂已定义，仅 stub 烟测，未跑 live |
| C − C−loop | Self-Loop | live，30 例未触发；压力臂 6 例触发 5/6，+0.047 [+0.006, +0.119] |
| C − Cstatic | 运行前调度（能力/负载评分 vs 静态指派） | 臂已定义，仅 stub 烟测，未跑 live |

## 结果文件

完整索引见 [`results/README.md`](results/README.md)，只引用其中标为可引用的文件。

- `results/latest.md`：当前有效结果摘要。主表为 30 例 × 5 臂 = 150 次（教育 11-07 批 + 选题 11-08 重跑，150/150 成功），见 `bench-merged-2026-11-08T02-55-02-172Z.md`。
- `results/bench-2026-11-07T17-52-16-749Z-p8790.md`：首批全量运行，topic 因账户欠费失败，**不可引用**；其教育子集单独保存为 `...-education-only.md`。
- `results/bench-2026-11-08T03-04-44-999Z-p8792.md`：压力臂 6 例 × 2 臂 = 12 次，当前代码；Self-Loop 触发 5/6，S − SN = +0.047。
- `results/bench-2026-11-08T08-39-17-688Z-p8791.md`：Csingle / Cstatic 消融臂 stub 烟测（2 例 × 2 臂 = 4 次），只证明链路可跑，分数无参考意义。
- `results/clarify-ab-latest.md`：意图澄清 A/B，10 例 × 2 臂 = 20 次；配对 +0.095。
- `results/verifier-accuracy.md`：验证器构造样本准确率。
- `results/concurrency-latest.md`：并发报告，2026-11-08 重新生成，仍为 stub（仅调度与排队；`PLATFORM_STUB_DELAY_MS=50`）。
- `results/bench-merged-2026-10-31T15-50-58-263Z.md`：旧的三基线冻结报告，已被五臂设计取代，仅作历史对照；其 C 66.7% 与另一旧批次的 96.7% 都不得与当前主表混用。
- `results/verify-sensitivity-latest.md`：验证器缺陷注入敏感性实验（历史结果）。

`benchmarks/.tmp/` 存放隔离 SQLite 临时库，已在 `.gitignore` 中排除。
