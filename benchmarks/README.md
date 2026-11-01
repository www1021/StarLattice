# 基准评测与压测

## 目录

- `run-bench.mjs`：三基线（单 Agent / 固定流水线 / 完整平台）× 30 用例，走 promptfoo。
- `concurrency.mjs`：并发压测，默认 `1,5,20` 三档，复用同一套隔离环境。
- `build-cases.mjs`：从 `data/eval/tasks.json` 生成 promptfoo 配置。
- `workflows/`：三基线对应的平台 DSL。
- `knowledge/`：评测用知识库文档。
- `results/`：汇总报告；原始逐次 JSON/CSV 不入库。

## 运行

```bash
# 全量三基线；默认继承当前 .env 的运行模式
node benchmarks/run-bench.mjs

# 烟测
BENCH_LIMIT=3 node benchmarks/run-bench.mjs

# 只跑指定用例
BENCH_RANGE=1:5 node benchmarks/run-bench.mjs

# 并发压测
BENCH_CONCURRENCY=1,5,20 node benchmarks/concurrency.mjs
```

常用环境变量：

| 变量 | 作用 |
|---|---|
| `BENCH_LIMIT` | 限制用例数 |
| `BENCH_RANGE` | promptfoo 用例范围，如 `1:5` |
| `BENCH_PATTERN` | 用例名过滤 |
| `BENCH_PORT` | 隔离服务端口，默认 8790 / 压测 8792 |
| `BENCH_EXTERNAL=1` | 复用已有服务，不再启动隔离进程 |
| `BENCH_CONCURRENCY` | 并发档位，默认 `1,5,20` |
| `BENCH_CONCURRENCY_TASK` | 压测用例，默认 `edu-01` |
| `BENCH_THRESHOLD` | 达标线，默认 `0.85` |

live 模式需要 `PLATFORM_LIVE_AGENTS=1` 和 `QWEN_API_KEY`；不设置时是 stub，零模型费用。

## 结果文件

- `results/latest.md` / `latest.csv`：最近一次汇总，可能由结果合并脚本生成。
- `results/bench-merged-2026-10-31T15-50-58-263Z.md`：**冻结的 30 用例三基线报告**，方案书引用以此为准。
- `results/concurrency-latest.md`：live 并发 1 的结果。
- `results/concurrency-stub-latest.md`：stub 1/5/20 三档结果。
- `results/verify-sensitivity-latest.md`：验证器缺陷注入敏感性实验。

`benchmarks/.tmp/` 存放隔离 SQLite 临时库，已在 `.gitignore` 中排除。
