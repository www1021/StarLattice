import type { AgentRecord, VerifyDimension, VerifyNode } from "../types.js";

export type VerifyLayerKey = "rule" | "crossCheck" | "baseline";

export type RuleCheck = {
  key: string;
  label: string;
  passed: boolean;
  detail?: string;
};

export type VerifyAgentScore = {
  agentId: string;
  agentName: string;
  score: number;
  dimensions: VerifyDimension[];
};

export type VerifyLayers = {
  rule: {
    score: number;
    checks: RuleCheck[];
  };
  crossCheck: {
    score: number;
    spread: number;
    agreement: boolean;
    verifiers: VerifyAgentScore[];
  };
  baseline: {
    score: number;
    coverage: number;
    matched: string[];
    missing: string[];
  };
};

export type VerifyReport = {
  mode: "stub" | "live";
  verifier: string;
  artifactNodeId?: string;
  threshold: number;
  score: number;
  confidence: number;
  passed: boolean;
  dimensions: VerifyDimension[];
  issues: string[];
  evidence: string[];
  layers: VerifyLayers;
};

export type VerifyRequest = {
  node: VerifyNode;
  artifact: unknown;
  artifactNodeId?: string;
  /** 支持字符串与知识库 citation 对象；执行器与验证器共用同一套归一化。 */
  evidence?: unknown;
  attempt?: number;
  mode?: "stub" | "live";
  agents?: AgentRecord[];
};

export type ScorerContext = {
  agent: AgentRecord;
  agentIndex: number;
  agentCount: number;
  dimension: string;
  rubric: string[];
  artifactText: string;
  evidence: string[];
  ruleScore: number;
  baselineCoverage: number;
  attempt: number;
};

export type DimensionScorer = (context: ScorerContext) => number | Promise<number>;

type VerifyPreparation = {
  node: VerifyNode;
  mode: "stub" | "live";
  threshold: number;
  rubric: string[];
  attempt: number;
  artifactText: string;
  evidence: string[];
  rule: VerifyLayers["rule"];
  baseline: VerifyLayers["baseline"];
  verifiers: AgentRecord[];
};

export const VERIFY_CONTRACT = "规则校验 → 交叉验证 → 基准比对";

export const VERIFY_LAYERS: Array<{ key: VerifyLayerKey; label: string; description: string }> = [
  {
    key: "rule",
    label: "规则校验",
    description: "确定性检查：输出非空、必需内容、占位符、证据引用、最小篇幅。"
  },
  {
    key: "crossCheck",
    label: "交叉验证",
    description: "至少两名验证 Agent 独立给每个维度打分，取均值，用分差折算置信度。"
  },
  {
    key: "baseline",
    label: "基准比对",
    description: "与 expectedKeywords 标准要点对照，未覆盖的要点直接进入问题清单。"
  }
];

export const VERIFY_FORMULA = {
  score: "score = 交叉验证分 × (0.5 + 0.5 × 规则分) × (0.6 + 0.4 × 基准覆盖率)",
  confidence: "confidence = 1 - 3 × 验证器总分标准差，单验证器置信度上限 0.5",
  agreement: "验证器总分标准差 ≤ 0.1 视为一致"
} as const;

export const VERIFY_DEFAULTS = {
  minVerifiers: 2,
  maxVerifiers: 3,
  spreadTolerance: 0.1,
  defaultRubric: ["目标达成", "证据支撑", "可执行性"]
} as const;

// 「占位」本身是汉字结构教学中的正常表述（如“心字底占位恰当”），只匹配明确的占位标记。
// 裸词「占位符」在评审报告里常是元讨论（如“模板仍有占位符需替换”），因此只认括号标记形态。
const PLACEHOLDER_PATTERN =
  /TODO|待补充|待完善|此处填写|此处插入|此处占位|请填写|lorem ipsum|示例占位|占位符未替换|占位待替换|[（(【\[]\s*(?:占位|待填|填写)[）)】\]]/i;
const EVIDENCE_DIMENSION_PATTERN = /证据|引用|来源|citation|evidence|source/i;

export class LayeredVerifier {
  constructor(private readonly scorer: DimensionScorer = heuristicDimensionScorer) {}

  evaluate(request: VerifyRequest): VerifyReport {
    const prepared = this.prepare(request);
    const scored = prepared.verifiers.map((agent, agentIndex) => {
      const dimensions = prepared.rubric.map((dimension) => {
        const value = this.scorer(scorerContext(prepared, agent, agentIndex, dimension));
        if (typeof value !== "number") {
          throw new Error("异步打分器必须通过 evaluateAsync() 调用。");
        }
        const score = round4(clamp01(value));
        return {
          name: dimension,
          score,
          comment: score >= prepared.threshold ? "达标" : "低于阈值"
        };
      });
      return {
        agentId: agent.id,
        agentName: agent.name,
        score: round4(average(dimensions.map((item) => item.score))),
        dimensions
      };
    });
    return assembleReport(request, prepared, scored);
  }

  async evaluateAsync(request: VerifyRequest): Promise<VerifyReport> {
    const prepared = this.prepare(request);
    const scored = await Promise.all(
      prepared.verifiers.map(async (agent, agentIndex) => {
        const dimensions = await Promise.all(
          prepared.rubric.map(async (dimension) => {
            const value = await this.scorer(
              scorerContext(prepared, agent, agentIndex, dimension)
            );
            const score = round4(clamp01(value));
            return {
              name: dimension,
              score,
              comment: score >= prepared.threshold ? "达标" : "低于阈值"
            };
          })
        );
        return {
          agentId: agent.id,
          agentName: agent.name,
          score: round4(average(dimensions.map((item) => item.score))),
          dimensions
        };
      })
    );
    return assembleReport(request, prepared, scored);
  }

  private prepare(request: VerifyRequest): VerifyPreparation {
    const { node } = request;
    const rubric =
      node.rubric && node.rubric.length > 0 ? node.rubric : [...VERIFY_DEFAULTS.defaultRubric];
    const artifactText = collectText(request.artifact);
    const evidence = normalizeEvidence([
      ...(Array.isArray(request.evidence)
        ? request.evidence
        : request.evidence === undefined
          ? []
          : [request.evidence]),
      ...collectCitations(request.artifact)
    ]).slice(0, 8);

    return {
      node,
      mode: request.mode ?? "live",
      threshold: node.threshold ?? 0.8,
      rubric,
      attempt: Math.max(1, request.attempt ?? 1),
      artifactText,
      evidence,
      rule: evaluateRules(node, request.artifact, artifactText, evidence, rubric),
      baseline: evaluateBaseline(node, artifactText),
      verifiers: resolveVerifierAgents(node, request.agents ?? [])
    };
  }
}

function scorerContext(
  prepared: VerifyPreparation,
  agent: AgentRecord,
  agentIndex: number,
  dimension: string
): ScorerContext {
  return {
    agent,
    agentIndex,
    agentCount: prepared.verifiers.length,
    dimension,
    rubric: prepared.rubric,
    artifactText: prepared.artifactText,
    evidence: prepared.evidence,
    ruleScore: prepared.rule.score,
    baselineCoverage: prepared.baseline.coverage,
    attempt: prepared.attempt
  };
}

function assembleReport(
  request: VerifyRequest,
  prepared: VerifyPreparation,
  scored: VerifyLayers["crossCheck"]["verifiers"]
): VerifyReport {
  const { node, threshold, rubric, rule, baseline, evidence, mode } = prepared;
  const crossScore = round4(average(scored.map((item) => item.score)));
  const spread = round4(standardDeviation(scored.map((item) => item.score)));
  const agreement = scored.length >= 2 && spread <= VERIFY_DEFAULTS.spreadTolerance;
  const dimensions = rubric.map((name, index) => ({
    name,
    score: round4(average(scored.map((item) => item.dimensions[index].score)))
  }));

  const score = round4(
    clamp01(crossScore * (0.5 + 0.5 * rule.score) * (0.6 + 0.4 * baseline.coverage))
  );

  let confidence = clamp(1 - spread * 3, 0.2, 0.98);
  if (scored.length < VERIFY_DEFAULTS.minVerifiers) {
    confidence = Math.min(confidence, 0.5);
  }
  if (rule.score < 0.6 || baseline.coverage < 0.5) {
    confidence = Math.min(confidence, 0.65);
  }

  const issues = [
    ...rule.checks.filter((check) => !check.passed).map((check) => `规则层：${ruleIssueText(check)}`),
    ...(scored.length < VERIFY_DEFAULTS.minVerifiers
      ? ["交叉验证降级：仅 1 名验证器，置信度上限 0.5"]
      : []),
    ...(!agreement && scored.length >= 2
      ? [
          `交叉验证分歧较大：${scored
            .map((item) => `${item.agentName} ${item.score.toFixed(2)}`)
            .join(" / ")}`
        ]
      : []),
    ...dimensions
      .filter((dimension) => dimension.score < threshold)
      .map(
        (dimension) =>
          `维度「${dimension.name}」未达标（${dimension.score.toFixed(2)} < ${threshold.toFixed(2)}）`
      ),
    ...(baseline.missing.length > 0
      ? [`基准比对缺少要点：${baseline.missing.join("、")}`]
      : [])
  ].slice(0, 8);

  return {
    mode,
    verifier: node.verifier,
    artifactNodeId: request.artifactNodeId,
    threshold,
    score,
    confidence: round4(confidence),
    passed: score >= threshold,
    dimensions,
    issues,
    evidence,
    layers: {
      rule,
      crossCheck: { score: crossScore, spread, agreement, verifiers: scored },
      baseline
    }
  };
}

export function heuristicDimensionScorer(context: ScorerContext): number {
  const tokens = dimensionTokens(context.dimension);
  const mentioned = tokens.some((token) => context.artifactText.includes(token));
  const lengthFactor = clamp01(context.artifactText.length / 400);
  const expertise = bestCapability(context.agent, tokens);
  const jitter = deterministicJitter(`${context.agent.id}:${context.dimension}`);
  return clamp01(
    0.45 +
      0.18 * (mentioned ? 1 : 0) +
      0.12 * lengthFactor +
      0.1 * context.ruleScore +
      0.1 * context.baselineCoverage +
      0.05 * (expertise - 0.6) +
      jitter
  );
}

/**
 * stub 模式下的模拟打分：真实 Agent 尚未接入，用轮次推进模拟"修订后提升"。
 * 首尾验证器各偏 ±0.02，均值和正好落在轮次基准分上，保证同一产物重复验证结果一致。
 */
export function stubDimensionScorer(context: ScorerContext): number {
  const base = 0.62 + 0.12 * (context.attempt - 1);
  const offset =
    context.agentCount < 2 ? 0 : context.agentIndex === 0 ? 0.02 : context.agentIndex === 1 ? -0.02 : 0;
  return clamp01(base + offset);
}

function evaluateRules(
  node: VerifyNode,
  artifact: unknown,
  artifactText: string,
  evidence: string[],
  rubric: string[]
): VerifyLayers["rule"] {
  const checks: RuleCheck[] = [];
  const present = artifact !== undefined && artifact !== null && artifactText.trim() !== "";
  checks.push({
    key: "artifact",
    label: "输出非空",
    passed: present,
    detail: present ? `正文 ${artifactText.length} 字` : "未拿到被验证产物"
  });

  for (const item of node.required ?? []) {
    const passed = containsField(artifact, item) || artifactText.includes(item);
    checks.push({
      key: `required:${item}`,
      label: `必需内容「${item}」`,
      passed,
      detail: passed ? undefined : `输出中没有找到「${item}」`
    });
  }

  const placeholder = PLACEHOLDER_PATTERN.exec(artifactText)?.[0];
  checks.push({
    key: "placeholder",
    label: "无占位内容",
    passed: !placeholder,
    detail: placeholder ? `发现占位标记「${placeholder}」` : undefined
  });

  const citationsRequired =
    node.requireEvidence ?? rubric.some((dimension) => EVIDENCE_DIMENSION_PATTERN.test(dimension));
  if (citationsRequired) {
    const count = evidence.length + collectCitations(artifact).length;
    checks.push({
      key: "evidence",
      label: "证据引用",
      passed: count > 0,
      detail: count > 0 ? `引用 ${count} 条` : "输出与证据池都没有可追溯引用"
    });
  }

  if (node.minChars !== undefined && node.minChars > 0) {
    checks.push({
      key: "minChars",
      label: `最小篇幅 ${node.minChars} 字`,
      passed: artifactText.length >= node.minChars,
      detail: `当前 ${artifactText.length} 字`
    });
  }

  const passedCount = checks.filter((check) => check.passed).length;
  return {
    score: checks.length === 0 ? 1 : round4(passedCount / checks.length),
    checks
  };
}

function evaluateBaseline(node: VerifyNode, artifactText: string): VerifyLayers["baseline"] {
  const expected = node.expectedKeywords ?? [];
  if (expected.length === 0) {
    return { score: 1, coverage: 1, matched: [], missing: [] };
  }
  const matched = expected.filter((keyword) => artifactText.includes(keyword));
  const missing = expected.filter((keyword) => !matched.includes(keyword));
  return {
    score: round4(matched.length / expected.length),
    coverage: round4(matched.length / expected.length),
    matched,
    missing
  };
}

function resolveVerifierAgents(node: VerifyNode, registry: AgentRecord[]): AgentRecord[] {
  const pool = registry.filter((agent) => agent.enabled);
  const ids =
    node.verifiers && node.verifiers.length > 0
      ? node.verifiers
      : defaultVerifierIds(node, pool);
  const seen = new Set<string>();
  const agents: AgentRecord[] = [];
  for (const id of ids) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    agents.push(
      pool.find((agent) => agent.id === id) ?? {
        id,
        name: id,
        version: 1,
        role: "验证",
        prompt: "",
        tools: [],
        model: "",
        capabilities: [],
        memory: {},
        enabled: true,
        createdAt: "",
        updatedAt: ""
      }
    );
    if (agents.length >= VERIFY_DEFAULTS.maxVerifiers) {
      break;
    }
  }
  return agents;
}

function defaultVerifierIds(node: VerifyNode, pool: AgentRecord[]): string[] {
  const ids = [node.verifier];
  for (const agent of pool) {
    if (ids.length >= VERIFY_DEFAULTS.maxVerifiers) {
      break;
    }
    if (agent.id !== node.verifier && agent.tools.includes("verify.rubric")) {
      ids.push(agent.id);
    }
  }
  return ids;
}

function dimensionTokens(dimension: string): string[] {
  const tokens = new Set<string>([dimension]);
  const chars = Array.from(dimension.replace(/[\s·、/]/g, ""));
  for (let index = 0; index < chars.length - 1; index += 1) {
    tokens.add(`${chars[index]}${chars[index + 1]}`);
  }
  return [...tokens].filter((token) => token.length >= 2);
}

function bestCapability(agent: AgentRecord, tokens: string[]): number {
  const scores = agent.capabilities
    .filter((capability) => tokens.some((token) => capability.tag.includes(token) || token.includes(capability.tag)))
    .map((capability) => capability.weight);
  return scores.length > 0 ? Math.max(...scores) : 0.6;
}

function deterministicJitter(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 1000;
  }
  return ((hash % 7) - 3) / 200;
}

function ruleIssueText(check: RuleCheck): string {
  return check.detail ? `${check.label}未通过（${check.detail}）` : `${check.label}未通过`;
}

function collectText(value: unknown, depth = 0): string {
  if (value === undefined || value === null || depth > 6) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => collectText(item, depth + 1)).join("\n");
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .map((item) => collectText(item, depth + 1))
      .join("\n");
  }
  return "";
}

function collectCitations(value: unknown, depth = 0): string[] {
  if (value === undefined || value === null || depth > 6 || typeof value !== "object") {
    return [];
  }
  const citations: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      citations.push(...collectCitations(item, depth + 1));
    }
    return citations;
  }
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.citations)) {
    for (const item of record.citations) {
      if (typeof item === "string") {
        citations.push(item);
      } else if (item !== null && typeof item === "object") {
        const citation = item as Record<string, unknown>;
        const title = typeof citation.title === "string" ? citation.title : undefined;
        const source = typeof citation.source === "string" ? citation.source : undefined;
        const text = [title, source].filter(Boolean).join(" · ");
        if (text) {
          citations.push(text);
        }
      }
    }
  }
  for (const item of Object.values(record)) {
    if (item !== record.citations) {
      citations.push(...collectCitations(item, depth + 1));
    }
  }
  return citations;
}

function containsField(value: unknown, field: string, depth = 0): boolean {
  if (value === undefined || value === null || depth > 6 || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsField(item, field, depth + 1));
  }
  const record = value as Record<string, unknown>;
  return field in record || Object.values(record).some((item) => containsField(item, field, depth + 1));
}

/**
 * 把字符串或知识库 citation 对象归一化为可展示、可计数的证据文本。
 * 真实检索返回 {documentName, knowledgeBaseName, snippet, source}，stub 返回 {title, source}，
 * 两者都必须计入规则层与验证器上下文。
 */
export function normalizeEvidence(value: unknown): string[] {
  const items = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const normalized: string[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      const text = item.trim();
      if (text) {
        normalized.push(text);
      }
      continue;
    }
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const title = firstText(record.documentName, record.title, record.knowledgeBaseName, record.name, record.id);
    const source = firstText(record.source, record.knowledgeBaseName);
    const snippet = firstText(record.snippet, record.text, record.content);
    const text = [title, source].filter(Boolean).join(" · ") || snippet;
    if (text) {
      normalized.push(text);
    }
  }
  return [...new Set(normalized)];
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return "";
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const mean = average(values);
  return Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}
