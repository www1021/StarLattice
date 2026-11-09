#!/usr/bin/env node
/**
 * 验证器灵敏度审计（无人工锚点）。
 *
 * 从隔离库取一份真实产物，按可控缺陷做定向删改（去掉证据 / 去掉行动建议 / 去掉结论 / 截断 /
 * 伪造引用），用同一套验证 Agent 重新打分。若验证器只对"措辞"敏感而不对"报告质量"敏感，
 * 删改后的分数应基本不变；反之分数应随缺陷单调下降。
 *
 * 两种模式：
 * - 默认（live）：真实调用验证模型，要求 PLATFORM_LIVE_AGENTS=1、PLATFORM_LIVE_VERIFY=1
 *   且配置模型 key；strict 模式下模型失败直接中断，避免把启发式回退当成模型结果。
 * - --rule-only：只跑确定性规则层（引用/章节/篇幅/数值），用一个恒定的高分打分器替代模型，
 *   不需要任何 key；用来单独证明硬规则本身的灵敏度，不能替代 live 模型审计。
 *
 * 用法：npx tsx benchmarks/audit-verifier-sensitivity.ts <platform-*.db> [taskId] [repeats] [--rule-only]
 */
import "dotenv/config";
import Database from "better-sqlite3";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRecord, VerifyNode } from "../server/platform/types.js";
import { LayeredVerifier, type DimensionScorer, type VerifyRequest } from "../server/platform/verify/verifier.js";
import { createLlmDimensionScorer, isLlmVerifyEnabled } from "../server/platform/verify/liveScorer.js";
import { BUILTIN_AGENTS } from "../server/platform/registry/agents.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const resultsDir = path.join(here, "results");
const args = process.argv.slice(2).filter((item) => item !== "--rule-only");
const ruleOnly = process.argv.includes("--rule-only");
const dbPath = args[0];
const taskId = args[1] || "topic-01";
const repeats = Math.max(1, Number(args[2] || (ruleOnly ? 1 : 2)));
if (!dbPath) {
  console.error(
    "用法：npx tsx benchmarks/audit-verifier-sensitivity.ts <platform-*.db> [taskId] [repeats] [--rule-only]"
  );
  process.exit(1);
}
if (!ruleOnly && !isLlmVerifyEnabled()) {
  console.error(
    "live 模式需要 PLATFORM_LIVE_AGENTS=1、PLATFORM_LIVE_VERIFY=1 且配置模型 key（不打印具体值）。" +
      " 只想验证硬规则时加 --rule-only。"
  );
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
const runs = (
  db
    .prepare("select id, input from platform_runs where workflow_id = ? and status = 'succeeded' order by started_at")
    .all("bench-topic-full-platform") as Array<{ id: string; input: string }>
)
  .map((row) => ({ id: row.id, input: JSON.parse(row.input) as Record<string, unknown> }))
  .filter((row) => row.input.taskId === taskId);
const run = runs[0];
if (!run) {
  console.error(`库里没有 ${taskId} 的完整平台运行`);
  process.exit(1);
}
const reportStep = db
  .prepare("select output from platform_run_steps where run_id = ? and node_id = 'report'")
  .get(run.id) as { output: string } | undefined;
const summaryStep = db
  .prepare("select output from platform_run_steps where run_id = ? and node_id = 'summary'")
  .get(run.id) as { output: string } | undefined;
const retrieveStep = db
  .prepare("select output from platform_run_steps where run_id = ? and node_id = 'retrieve'")
  .get(run.id) as { output: string } | undefined;
db.close();

const stepOutput = (row: { output: string } | undefined) => {
  if (!row) {
    return undefined;
  }
  const parsed = JSON.parse(row.output) as Record<string, unknown>;
  return typeof parsed.output === "string" ? parsed.output : undefined;
};
const original = stepOutput(reportStep) ?? stepOutput(summaryStep) ?? "";
if (!original) {
  console.error("运行里没有 report / summary 产物");
  process.exit(1);
}
const retrieval = retrieveStep
  ? (JSON.parse(retrieveStep.output) as { citations?: Array<{ title?: string; knowledgeBaseName?: string }> })
  : {};
const evidence: string[] = (retrieval.citations ?? []).map(
  (item) => `${item.title ?? "未命名文档"}（${item.knowledgeBaseName ?? "知识库"}）`
);

const variants: Array<{ name: string; label: string; text: string }> = [
  { name: "original", label: "原始产物", text: original },
  {
    name: "no-citations",
    label: "删除引用标记与引用来源节",
    text: removeSections(original, /引用来源|参考文献/)
      .replace(/\[\d+\]/g, "")
      .replace(/（来源：[^）]*）/g, "")
  },
  {
    name: "no-action",
    label: "删除必须修改项与建议修改项",
    text: removeSections(original, /必须修改|建议修改|改进建议/)
  },
  {
    name: "no-conclusion",
    label: "删除总体结论与开题判断",
    text: removeSections(original, /总体结论|是否建议进入开题|开题结论/)
  },
  { name: "truncated", label: "只保留前 60% 段落", text: truncateBlocks(original, 0.6) },
  {
    name: "fabricated-citations",
    label: "引用编号改为不存在的来源",
    text: fabricateCitations(original)
  },
  {
    name: "fluent-unsupported",
    label: "删除引用与结论后补足篇幅（流畅但无依据）",
    text: padToLength(
      removeSections(original, /引用来源|参考文献/).replace(/\[\d+\]/g, ""),
      original.length
    )
  }
];

const agents: AgentRecord[] = BUILTIN_AGENTS.filter((agent) =>
  ["topic-review-verifier", "topic-review-auditor"].includes(agent.id)
).map((agent) => ({
  id: agent.id,
  name: agent.name,
  version: 1,
  role: agent.role,
  prompt: agent.prompt,
  tools: agent.tools ?? [],
  model: agent.model,
  capabilities: agent.capabilities,
  memory: agent.memory ?? {},
  enabled: true,
  createdAt: "",
  updatedAt: ""
}));

// 与生产 topic-review-v1 的 verify-report 节点保持一致。
const node: VerifyNode = {
  id: "sensitivity",
  kind: "verify",
  verifier: "topic-review-verifier",
  verifiers: ["topic-review-verifier", "topic-review-auditor"],
  verifierModels: {
    "topic-review-verifier": "reasoning",
    "topic-review-auditor": "fast"
  },
  evidenceView: "split",
  rubric: ["创新性", "可行性", "规范性", "证据支撑"],
  required: ["结论"],
  requiredSections: ["总体结论", "必须修改项", "建议修改项", "引用来源"],
  requireEvidence: true,
  minCitations: 2,
  minChars: 1200,
  threshold: 0.85
};

const scorer: DimensionScorer = ruleOnly
  ? () => 0.95
  : createLlmDimensionScorer({ strict: true });
const verifier = new LayeredVerifier(scorer);

type Row = {
  variant: string;
  label: string;
  chars: number;
  scores: number[];
  confidences: number[];
  ruleScores: number[];
  citationTotals: number[];
  caughtBy: string[];
  independence: string;
  fallback: boolean;
};

async function main() {
  const rows: Row[] = [];
  for (const variant of variants) {
    const scores: number[] = [];
    const confidences: number[] = [];
    const ruleScores: number[] = [];
    const citationTotals: number[] = [];
    const caught = new Set<string>();
    let independence = "unknown";
    let fallback = false;

    for (let attempt = 0; attempt < repeats; attempt += 1) {
      const request: VerifyRequest = {
        node,
        artifact: { output: variant.text },
        evidence,
        attempt: attempt + 1,
        mode: "live",
        agents
      };
      const result = await verifier.evaluateAsync(request);
      if (result.independence.heuristicFallback) {
        throw new Error(
          `验证器「${variant.name}」发生启发式回退（${result.issues.join("；")}），` +
            "不能把这次结果当作模型灵敏度。请检查模型配置或改用 --rule-only。"
        );
      }
      if (!ruleOnly && !["model", "cross-provider"].includes(result.independence.level)) {
        throw new Error(
          `验证器独立性仅 ${result.independence.level}（${result.independence.models.join(" / ")}），` +
            "未达到模型级独立。请确认 PLATFORM_MODEL_FAST / PLATFORM_MODEL_REASONING 指向不同上游模型。"
        );
      }
      scores.push(result.score);
      confidences.push(result.confidence);
      ruleScores.push(result.layers.rule.score);
      citationTotals.push(result.citations.total);
      independence = result.independence.level;
      fallback ||= result.independence.heuristicFallback;
      for (const check of result.layers.rule.checks) {
        if (!check.passed && check.critical) {
          caught.add(check.label);
        }
      }
    }

    rows.push({
      variant: variant.name,
      label: variant.label,
      chars: variant.text.length,
      scores,
      confidences,
      ruleScores,
      citationTotals,
      caughtBy: [...caught],
      independence,
      fallback
    });
    console.log(`${variant.label}: ${scores.map((value) => value.toFixed(3)).join(" / ")}`);
  }

  const base = mean(rows[0].scores) ?? 0;
  const lines = [
    ruleOnly ? "# 验证器硬规则灵敏度审计（rule-only）" : "# 验证器灵敏度审计（缺陷注入 · live 模型）",
    "",
    `- 生成时间：${new Date().toISOString()}`,
    `- 样本：${taskId} 的完整平台产物（${original.length} 字）`,
    ruleOnly
      ? "- 方法：恒定高分打分器（0.95）+ 生产同款验证节点，只观察引用/章节/篇幅规则对缺陷的封顶效果。"
      : `- 方法：复用生产验证 Agent 与独立模型（${node.verifierModels?.["topic-review-verifier"]} / ${node.verifierModels?.["topic-review-auditor"]}），每个变体重复 ${repeats} 次。`,
    `- 证据：${evidence.length} 条检索引用；节点要求 minCitations=${node.minCitations}、minChars=${node.minChars}。`,
    "- 口径：若验证器对报告质量有方向性，删改后的分数应下降；如果删改前后基本不变，说明验证器对措辞而非内容敏感。",
    "",
    "| 变体 | 字数 | 验证分（各次） | 均值 | 相对原始 | 置信度均值 | 规则层 | 引用数 | 触发的硬规则 | 独立性 |",
    "| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |"
  ];
  for (const row of rows) {
    const avg = mean(row.scores) ?? 0;
    lines.push(
      `| ${row.label} | ${row.chars} | ${row.scores.map((value) => value.toFixed(3)).join(" / ")} | ${avg.toFixed(3)} | ${(avg - base).toFixed(3)} | ${(mean(row.confidences) ?? 0).toFixed(3)} | ${(mean(row.ruleScores) ?? 0).toFixed(3)} | ${row.citationTotals.join(" / ")} | ${row.caughtBy.join("、") || "无"} | ${ruleOnly ? "rule-only" : row.independence}${row.fallback ? "（回退）" : ""} |`
    );
  }
  const markdown = lines.join("\n") + "\n";
  mkdirSync(resultsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const prefix = ruleOnly ? "verify-rule-sensitivity" : "verify-sensitivity";
  writeFileSync(path.join(resultsDir, `${prefix}-${stamp}.md`), markdown);
  writeFileSync(path.join(resultsDir, `${prefix}-latest.md`), markdown);
  console.log(markdown);
}

void main();

function removeSections(text: string, pattern: RegExp) {
  const sections: Array<{ heading: string; body: string[] }> = [];
  let current: { heading: string; body: string[] } | null = null;
  for (const line of text.split("\n")) {
    if (/^##\s/.test(line)) {
      current = { heading: line, body: [line] };
      sections.push(current);
    } else if (current) {
      current.body.push(line);
    } else {
      current = { heading: "", body: [line] };
      sections.push(current);
    }
  }
  return sections
    .filter((section) => !pattern.test(section.heading))
    .map((section) => section.body.join("\n"))
    .join("\n")
    .trim();
}

function truncateBlocks(text: string, ratio: number) {
  const blocks = text.split(/\n{2,}/);
  return blocks.slice(0, Math.max(1, Math.round(blocks.length * ratio))).join("\n\n");
}

function fabricateCitations(text: string) {
  const replaced = text.replace(/\[(\d+)\]/g, (_, value: string) => `[${Number(value) + 90}]`);
  return replaced === text ? `${text}\n\n参见[99]。` : replaced;
}

function padToLength(text: string, length: number) {
  const filler = "本报告在删去引用后补充了通用表述，用于检验篇幅与引用是否被分别核对。";
  let padded = text;
  while (padded.length < length) {
    padded += `\n\n${filler.repeat(3)}`;
  }
  return padded;
}

function mean(values: number[]) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}
