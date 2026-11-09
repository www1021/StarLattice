import type { AgentRecord, VerifyDimension, VerifyNode } from "../types.js";
import { resolveVerificationModel } from "../models/catalog.js";

export type VerifyLayerKey = "rule" | "crossCheck" | "baseline";

export type RuleCheck = {
  key: string;
  label: string;
  passed: boolean;
  detail?: string;
  /** 信息项只展示，不参与规则分；用于“证据池可用”这类不直接判定质量的检查。 */
  informational?: boolean;
  /** 客观缺陷：未通过时把总分压到阈值以下（仅 live 产物生效）。 */
  critical?: boolean;
};

export type CitationSummary = {
  /** 正文引用标记出现次数 + 结构化 citation 条数。 */
  total: number;
  /** 去重后的引用来源数。 */
  distinct: number;
  /** 能绑定到证据池的引用数。 */
  valid: number;
  /** 无法绑定到证据池的引用数。 */
  missing: number;
  /** 证据池条数，便于判断引用编号是否越界。 */
  pool: number;
  /** 去重后的引用标记，最多展示 12 条。 */
  markers: string[];
};

export type VerifyIndependenceLevel = "prompt" | "evidence" | "model" | "cross-provider";

export type VerifyIndependence = {
  level: VerifyIndependenceLevel;
  modelDistinct: boolean;
  providerDistinct: boolean;
  evidenceDistinct: boolean;
  /** 任一验证器调用失败回退启发式打分时，不再宣称模型独立。 */
  heuristicFallback: boolean;
  models: string[];
  providers: string[];
};

export type ScorerDiagnostic = {
  key: string;
  detail: string;
};

export type VerifyAgentScore = {
  agentId: string;
  agentName: string;
  score: number;
  dimensions: VerifyDimension[];
  /** 验证器实际使用的逻辑模型与实际请求的上游模型，便于核对“验证模型是否独立”。 */
  model?: string;
  resolvedModel?: string;
  modelProvider?: string;
  requestedModel?: string;
  modelSource?: string;
  /** 该验证器拿到的证据视图：完整检索池或产物实际引用。 */
  evidenceView?: "pool" | "cited";
  /** 模型打分失败后回退启发式打分。 */
  fallback?: boolean;
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
  citations: CitationSummary;
  independence: VerifyIndependence;
};

export type VerifyRequest = {
  node: VerifyNode;
  artifact: unknown;
  artifactNodeId?: string;
  /** 支持字符串与知识库 citation 对象；执行器与验证器共用同一套归一化。 */
  evidence?: unknown;
  /** 数值比对规则（checks）的对照数据；缺失时 number_match 直接判失败。 */
  reference?: unknown;
  attempt?: number;
  mode?: "stub" | "live";
  agents?: AgentRecord[];
  /** 执行器 token 预算已用尽时，验证打分同样降级到低成本模型。 */
  budgetExceeded?: boolean;
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
  /** 验证节点显式指定的模型；用于真正走独立验证模型。 */
  nodeModel?: string;
  /** 逐验证器模型覆盖，优先级高于 nodeModel。 */
  agentModel?: string;
  /** 当前验证器拿到的证据视图。 */
  evidenceView?: "pool" | "cited";
  /** 打分器可写入的回退诊断，最终落到验证器分数记录。 */
  diagnostics?: ScorerDiagnostic[];
  budgetExceeded?: boolean;
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
  evidenceView: "pool" | "cited" | "split";
  citedEvidence: string[];
  citations: CitationSummary;
  budgetExceeded?: boolean;
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
  score: "score = 交叉验证分 × (0.5 + 0.5 × 规则分) × (0.6 + 0.4 × 基准覆盖率)；引用/章节/篇幅等客观缺陷直接封顶到阈值以下",
  confidence:
    "confidence = 1 - 3 × 验证器总分标准差，并受独立性上限约束；提示词级 ≤0.60、证据级 ≤0.70、模型级 ≤0.85、跨供应商 ≤0.95",
  agreement: "验证器总分标准差 ≤ 0.1 视为一致"
} as const;

export const VERIFY_DEFAULTS = {
  minVerifiers: 2,
  maxVerifiers: 3,
  spreadTolerance: 0.1,
  defaultRubric: ["目标达成", "证据支撑", "可执行性"]
} as const;

const INDEPENDENCE_CAPS: Record<VerifyIndependenceLevel, number> = {
  prompt: 0.6,
  evidence: 0.7,
  model: 0.85,
  "cross-provider": 0.95
};

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
      const evidenceView = evidenceViewFor(prepared.evidenceView, agentIndex);
      const dimensions = prepared.rubric.map((dimension) => {
        const value = this.scorer(
          scorerContext(prepared, agent, agentIndex, dimension, evidenceView)
        );
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
        dimensions,
        evidenceView,
        ...verifierModelInfo(request, agent)
      };
    });
    return assembleReport(request, prepared, scored);
  }

  async evaluateAsync(request: VerifyRequest): Promise<VerifyReport> {
    const prepared = this.prepare(request);
    const scored = await Promise.all(
      prepared.verifiers.map(async (agent, agentIndex) => {
        const diagnostics: ScorerDiagnostic[] = [];
        const evidenceView = evidenceViewFor(prepared.evidenceView, agentIndex);
        const dimensions = await Promise.all(
          prepared.rubric.map(async (dimension) => {
            const value = await this.scorer(
              scorerContext(prepared, agent, agentIndex, dimension, evidenceView, diagnostics)
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
          dimensions,
          evidenceView,
          fallback: diagnostics.some((item) => item.key === "llm-fallback"),
          ...verifierModelInfo(request, agent)
        };
      })
    );
    return assembleReport(request, prepared, scored);
  }

  private prepare(request: VerifyRequest): VerifyPreparation {
    const { node } = request;
    const mode = request.mode ?? "live";
    const rubric =
      node.rubric && node.rubric.length > 0 ? node.rubric : [...VERIFY_DEFAULTS.defaultRubric];
    const artifactText = artifactTextOf(request.artifact);
    const evidencePool = normalizeEvidence([
      ...(Array.isArray(request.evidence)
        ? request.evidence
        : request.evidence === undefined
          ? []
          : [request.evidence])
    ]).slice(0, 8);
    const artifactEvidence = normalizeEvidence(collectCitations(request.artifact)).slice(0, 8);
    const evidence = [...new Set([...evidencePool, ...artifactEvidence])].slice(0, 8);
    const { summary: citations, citedEvidence } = analyzeCitations(
      artifactText,
      evidencePool,
      artifactEvidence
    );
    const evidenceView = node.evidenceView ?? "pool";

    return {
      node,
      mode,
      threshold: node.threshold ?? 0.8,
      rubric,
      attempt: Math.max(1, request.attempt ?? 1),
      artifactText,
      evidence,
      evidenceView,
      citedEvidence,
      citations,
      rule: evaluateRules(
        node,
        request.artifact,
        artifactText,
        evidence,
        rubric,
        collectText(request.reference),
        mode,
        citations
      ),
      baseline: evaluateBaseline(node, artifactText),
      verifiers: resolveVerifierAgents(node, request.agents ?? []),
      budgetExceeded: request.budgetExceeded
    };
  }
}

function verifierModelInfo(request: VerifyRequest, agent: AgentRecord) {
  const resolution = resolveVerificationModel({
    nodeModel: request.node?.verifierModels?.[agent.id] ?? request.node?.model,
    agentModel: agent.model,
    budgetExceeded: request.budgetExceeded
  });
  return {
    model: resolution.id,
    resolvedModel: resolution.model,
    modelProvider: resolution.provider,
    requestedModel: resolution.requestedModel,
    modelSource: resolution.source
  };
}

function scorerContext(
  prepared: VerifyPreparation,
  agent: AgentRecord,
  agentIndex: number,
  dimension: string,
  evidenceView: "pool" | "cited",
  diagnostics?: ScorerDiagnostic[]
): ScorerContext {
  return {
    agent,
    agentIndex,
    agentCount: prepared.verifiers.length,
    dimension,
    rubric: prepared.rubric,
    artifactText: prepared.artifactText,
    evidence: evidenceView === "cited" ? prepared.citedEvidence : prepared.evidence,
    ruleScore: prepared.rule.score,
    baselineCoverage: prepared.baseline.coverage,
    attempt: prepared.attempt,
    nodeModel: prepared.node.model,
    agentModel: prepared.node.verifierModels?.[agent.id],
    evidenceView,
    diagnostics,
    budgetExceeded: prepared.budgetExceeded
  };
}

function evidenceViewFor(
  configured: "pool" | "cited" | "split",
  agentIndex: number
): "pool" | "cited" {
  if (configured === "cited") {
    return "cited";
  }
  if (configured === "split" && agentIndex > 0) {
    return "cited";
  }
  return "pool";
}

function assembleReport(
  request: VerifyRequest,
  prepared: VerifyPreparation,
  scored: VerifyLayers["crossCheck"]["verifiers"]
): VerifyReport {
  const { node, threshold, rubric, rule, baseline, evidence, mode, citations } = prepared;
  const crossScore = round4(average(scored.map((item) => item.score)));
  const spread = round4(standardDeviation(scored.map((item) => item.score)));
  const agreement = scored.length >= 2 && spread <= VERIFY_DEFAULTS.spreadTolerance;
  const independence = summarizeIndependence(scored);
  const dimensions = rubric.map((name, index) => ({
    name,
    score: round4(average(scored.map((item) => item.dimensions[index].score)))
  }));

  const rawScore = round4(
    clamp01(crossScore * (0.5 + 0.5 * rule.score) * (0.6 + 0.4 * baseline.coverage))
  );
  // 数值不一致、引用缺失、章节缺失、篇幅不足都是客观缺陷：即使模型分高，也不允许越过阈值。
  const criticalFailures = rule.checks.filter((check) => check.critical && !check.passed);
  const numberMismatch = rule.checks.some(
    (check) => check.key.startsWith("number_match:") && !check.passed
  );
  const score =
    criticalFailures.length > 0 || numberMismatch
      ? Math.min(rawScore, round4(Math.max(0, threshold - 0.01)))
      : rawScore;

  let confidence = clamp(1 - spread * 3, 0.2, 0.98);
  // 一致性只说明两个验证器是否同向；独立性决定这份一致性值多少。
  confidence = Math.min(confidence, INDEPENDENCE_CAPS[independence.level]);
  if (scored.length < VERIFY_DEFAULTS.minVerifiers) {
    confidence = Math.min(confidence, 0.5);
  }
  if (rule.score < 0.8 || baseline.coverage < 0.7) {
    confidence = Math.min(confidence, 0.8);
  }
  const modelRuleGap = round4(crossScore - rule.score);
  if (modelRuleGap > 0.2) {
    confidence = Math.min(confidence, 0.65);
  }
  if (criticalFailures.length > 0) {
    confidence = Math.min(confidence, 0.6);
  }
  if (mode === "stub") {
    confidence = Math.min(confidence, 0.5);
  }

  const issues = [
    ...rule.checks
      .filter((check) => !check.passed && !check.informational)
      .map((check) => `规则层：${ruleIssueText(check)}`),
    ...(mode === "stub"
      ? ["stub 演练：分值为内容信号估计（置信度上限 0.50），不能作为模型自愈证据"]
      : []),
    ...(scored.length < VERIFY_DEFAULTS.minVerifiers
      ? ["交叉验证降级：仅 1 名验证器，置信度上限 0.5"]
      : []),
    ...(independence.level === "prompt"
      ? [
          independence.heuristicFallback
            ? "验证器模型调用失败并回退启发式打分，独立性降级为提示词级，置信度上限 0.60"
            : "交叉验证仅为提示词级：验证器使用同一上游模型与同一证据，置信度上限 0.60"
        ]
      : []),
    ...(independence.level === "evidence"
      ? ["交叉验证为证据级：验证器同模型，仅证据视图不同，置信度上限 0.70"]
      : []),
    ...(!agreement && scored.length >= 2
      ? [
          `交叉验证分歧较大：${scored
            .map((item) => `${item.agentName} ${item.score.toFixed(2)}`)
            .join(" / ")}`
        ]
      : []),
    ...(modelRuleGap > 0.2
      ? [`模型分与确定性规则分歧较大（模型 ${crossScore.toFixed(2)} / 规则 ${rule.score.toFixed(2)}），置信度上限 0.65`]
      : []),
    ...(criticalFailures.length > 0
      ? [`确定性检查未通过：${criticalFailures.map((check) => check.label).join("、")}`]
      : []),
    ...(baseline.missing.length > 0
      ? [`基准比对缺少要点：${baseline.missing.join("、")}`]
      : []),
    ...dimensions
      .filter((dimension) => dimension.score < threshold)
      .map(
        (dimension) =>
          `维度「${dimension.name}」未达标（${dimension.score.toFixed(2)} < ${threshold.toFixed(2)}）`
      )
  ].slice(0, 16);

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
    },
    citations,
    independence
  };
}

function summarizeIndependence(
  scored: VerifyLayers["crossCheck"]["verifiers"]
): VerifyIndependence {
  const heuristicFallback = scored.some((item) => item.fallback);
  const models = [
    ...new Set(
      scored.map((item) => (heuristicFallback ? "heuristic" : item.resolvedModel ?? item.model ?? "unknown"))
    )
  ];
  const providers = [
    ...new Set(scored.map((item) => item.modelProvider ?? "unknown"))
  ];
  const evidenceViews = [...new Set(scored.map((item) => item.evidenceView ?? "pool"))];
  const modelDistinct = !heuristicFallback && models.length > 1;
  const providerDistinct = !heuristicFallback && providers.length > 1;
  const evidenceDistinct = evidenceViews.length > 1;
  const level: VerifyIndependenceLevel = providerDistinct
    ? "cross-provider"
    : modelDistinct
      ? "model"
      : evidenceDistinct
        ? "evidence"
        : "prompt";
  return {
    level,
    modelDistinct,
    providerDistinct,
    evidenceDistinct,
    heuristicFallback,
    models,
    providers
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
 * stub 模式不模拟“修订后抬分”：分值只由产物内容、规则层和基准覆盖决定，
 * 同一份产物无论第几次验证都得到同一分数。stub 结果仅用于契约演练，不能当作自愈证据。
 */
export function stubDimensionScorer(context: ScorerContext): number {
  return heuristicDimensionScorer(context);
}

function evaluateRules(
  node: VerifyNode,
  artifact: unknown,
  artifactText: string,
  evidence: string[],
  rubric: string[],
  referenceText: string,
  mode: "stub" | "live",
  citations: CitationSummary
): VerifyLayers["rule"] {
  const checks: RuleCheck[] = [];
  const live = mode === "live";
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
    detail: placeholder ? `发现占位标记「${placeholder}」` : undefined,
    critical: live
  });

  const citationsRequired =
    node.requireEvidence ?? rubric.some((dimension) => EVIDENCE_DIMENSION_PATTERN.test(dimension));
  if (citationsRequired) {
    const minCitations = node.minCitations ?? 1;
    const requiredExplicitly = node.requireEvidence === true || node.minCitations !== undefined;
    if (!requiredExplicitly) {
      // 未显式要求引用时保持原有口径：证据池或产物内结构化引用可用即通过，避免误伤课堂演示。
      checks.push({
        key: "evidence",
        label: "证据引用",
        passed: evidence.length > 0,
        detail: evidence.length > 0 ? `可用证据 ${evidence.length} 条` : "证据池为空"
      });
    } else {
      // 显式要求引用后，证据池只说明“有资料可用”，真正的引用完整性按正文标记单独检查。
      checks.push({
        key: "evidence",
        label: "证据池可用",
        passed: evidence.length > 0,
        detail: evidence.length > 0 ? `可用证据 ${evidence.length} 条` : "证据池为空",
        informational: true
      });
      // 只有能绑定到证据池的引用才算“可追溯引用”，伪造编号不能凑数。
      const markerPassed = citations.valid >= minCitations;
      const bindingPassed = citations.total > 0 && citations.missing === 0;
      const expectedSources = Math.min(3, Math.max(1, citations.pool));
      const coverage = round4(citations.valid / expectedSources);
      checks.push({
        key: "citation_markers",
        label: "证据引用",
        passed: markerPassed,
        detail: markerPassed
          ? `可追溯引用 ${citations.valid} 条（去重 ${citations.distinct} 个来源）`
          : `可追溯引用不足（${citations.valid} / ${minCitations}，无法绑定 ${citations.missing} 条）`,
        critical: live
      });
      checks.push({
        key: "citation_binding",
        label: "引用可追溯",
        passed: bindingPassed,
        detail:
          citations.total === 0
            ? "没有引用可核对"
            : citations.missing > 0
              ? `${citations.missing} 条引用无法绑定到证据池（证据池 ${citations.pool} 条）`
              : `${citations.valid} 条引用均可绑定到证据池`,
        critical: live
      });
      checks.push({
        key: "citation_coverage",
        label: "引用来源覆盖",
        passed: citations.total === 0 ? false : coverage >= 0.5,
        detail: `覆盖 ${coverage.toFixed(2)}（有效引用 ${citations.valid} / 期望 ${expectedSources} 个来源）`
      });
    }
  }

  for (const section of node.requiredSections ?? []) {
    const passed = containsSection(artifactText, section);
    checks.push({
      key: `section:${section}`,
      label: `小节「${section}」`,
      passed,
      detail: passed ? undefined : `正文缺少小节「${section}」`,
      critical: live
    });
  }

  if (node.minChars !== undefined && node.minChars > 0) {
    checks.push({
      key: "minChars",
      label: `最小篇幅 ${node.minChars} 字`,
      passed: artifactText.length >= node.minChars,
      detail: `当前 ${artifactText.length} 字`,
      critical: live
    });
  }

  node.checks?.forEach((check, index) => {
    if (check.type !== "number_match") {
      return;
    }
    const result = evaluateNumberMatch(artifactText, referenceText, check.tolerance, check.anchors);
    checks.push({
      key: `number_match:${index}`,
      label: check.anchors && check.anchors.length > 0 ? "关键指标数值一致" : "数值一致",
      passed: result.passed,
      detail: result.detail,
      critical: live
    });
  });

  const scoredChecks = checks.filter((check) => !check.informational);
  const passedCount = scoredChecks.filter((check) => check.passed).length;
  return {
    score: scoredChecks.length === 0 ? 1 : round4(passedCount / scoredChecks.length),
    checks
  };
}

function containsSection(text: string, section: string) {
  const target = section.trim().toLowerCase();
  if (!target) {
    return true;
  }
  // 小节要求按“行首标题”核对：正文里顺带提到「分层练习」不能顶替缺失的小节标题。
  return text.split(/\r?\n/).some((line) => {
    const stripped = line
      .trim()
      .replace(/^(?:[#>*\-+\s]|\d+[.、)]|[（(]\d+[）)])+/, "")
      .toLowerCase();
    if (!stripped.startsWith(target)) {
      return false;
    }
    const rest = stripped.slice(target.length);
    return rest === "" || /^[\s:：）)\-—·*]/.test(rest);
  });
}

type ParsedNumber = {
  raw: number;
  /** 百分数折算为小数后的小数值，用于兼容 “12.5%” 与 “0.125” 两种写法。 */
  normalized: number;
  text: string;
};

const DATE_PATTERN = /\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/g;
const NUMBER_PATTERN = /(?<![A-Za-z0-9_.])([-−–—])?\s*((?:\d{1,3}(?:[,，]\d{3})+|\d+)(?:\.\d+)?)\s*(%|％)?/g;

function evaluateNumberMatch(
  artifactText: string,
  referenceText: string,
  tolerance = 0,
  anchors?: string[]
): { passed: boolean; detail: string } {
  if (anchors && anchors.length > 0) {
    return evaluateAnchoredNumberMatch(artifactText, referenceText, anchors, tolerance);
  }
  const reference = extractNumbers(referenceText);
  if (reference.length === 0) {
    return { passed: false, detail: "对照数据为空或没有可解析的数字" };
  }
  const artifact = extractNumbers(artifactText);
  if (artifact.length === 0) {
    return { passed: false, detail: "产物中没有可解析的数字" };
  }
  const unmatched = artifact.filter(
    (value) => !reference.some((expected) => numbersMatch(value, expected, tolerance))
  );
  if (unmatched.length > 0) {
    return {
      passed: false,
      detail: `产物 ${artifact.length} 个数字中有 ${unmatched.length} 个与对照数据不一致（例如 ${unmatched[0].text}）`
    };
  }
  return {
    passed: true,
    detail: `产物 ${artifact.length} 个数字全部匹配对照数据（容差 ${tolerance}）`
  };
}

/**
 * 指标锚点模式：逐行查找标签后的首个数字，只核对关键指标。
 * 报告里的序号、占比、环比等派生数字不参与比对，避免自由文本被误杀。
 */
function evaluateAnchoredNumberMatch(
  artifactText: string,
  referenceText: string,
  anchors: string[],
  tolerance: number
): { passed: boolean; detail: string } {
  const referenceLines = referenceText.split(/\r?\n/);
  const artifactLines = artifactText.split(/\r?\n/);
  const failures: string[] = [];
  let checked = 0;

  for (const anchor of anchors) {
    const expected = firstNumbersAfterAnchor(referenceLines, anchor);
    if (expected.length === 0) {
      failures.push(`对照数据中「${anchor}」没有可核对数字`);
      continue;
    }
    const actual = firstNumbersAfterAnchor(artifactLines, anchor);
    if (actual.length === 0) {
      failures.push(`产物缺少「${anchor}」的数值`);
      continue;
    }
    checked += 1;
    const unmatched = actual.filter(
      (value) => !expected.some((candidate) => numbersMatch(value, candidate, tolerance))
    );
    if (unmatched.length > 0) {
      const expectedText = [...new Set(expected.map((value) => value.text))].slice(0, 3).join(" / ");
      failures.push(`「${anchor}」产物值 ${unmatched[0].text} 与对照值 ${expectedText} 不一致`);
    }
  }

  if (failures.length > 0) {
    return {
      passed: false,
      detail: `关键指标核对未通过：${failures.slice(0, 3).join("；")}`
    };
  }
  return {
    passed: true,
    detail: `关键指标 ${checked} 项数值全部匹配对照数据（容差 ${tolerance}）`
  };
}

const ANCHOR_VALUE_PATTERN = /^\s*(?:\*\*)?\s*[：:|＝=]\s*(?:\*\*)?\s*/;

function firstNumbersAfterAnchor(lines: string[], anchor: string): ParsedNumber[] {
  const numbers: ParsedNumber[] = [];
  for (const line of lines) {
    let from = 0;
    while (true) {
      const index = line.indexOf(anchor, from);
      if (index === -1) {
        break;
      }
      const rest = line.slice(index + anchor.length);
      const field = ANCHOR_VALUE_PATTERN.exec(rest);
      if (field) {
        const value = extractNumbers(rest.slice(field[0].length))[0];
        if (value) {
          numbers.push(value);
        }
      }
      from = index + anchor.length;
    }
  }
  return numbers;
}

function extractNumbers(text: string): ParsedNumber[] {
  const cleaned = text.replace(DATE_PATTERN, " ");
  const numbers: ParsedNumber[] = [];
  for (const match of cleaned.matchAll(NUMBER_PATTERN)) {
    const sign = match[1] ? -1 : 1;
    const digits = match[2].replace(/[,，]/g, "");
    const value = Number(digits);
    if (!Number.isFinite(value)) {
      continue;
    }
    const raw = sign * value;
    const percent = Boolean(match[3]);
    numbers.push({
      raw,
      normalized: percent ? raw / 100 : raw,
      text: match[0].trim()
    });
  }
  return numbers;
}

function numbersMatch(actual: ParsedNumber, expected: ParsedNumber, tolerance: number) {
  return withinTolerance(actual.raw, expected.raw, tolerance) ||
    withinTolerance(actual.normalized, expected.normalized, tolerance);
}

function withinTolerance(left: number, right: number, tolerance: number) {
  const delta = Math.abs(left - right);
  if (delta <= 1e-9) {
    return true;
  }
  const scale = Math.max(Math.abs(left), Math.abs(right), 1);
  return delta <= scale * tolerance;
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

/**
 * 只取产物正文用于评分：包装对象里的 inputs、提示词和运行元数据不是被验证对象，
 * 否则验证器会把节点输入里的数字/关键词当成产物内容，导致分数虚高。
 */
export function artifactTextOf(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "object") {
    return collectText(value);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.output === "string") {
    return record.output;
  }
  if (record.output !== undefined && typeof record.output === "object") {
    return collectText(record.output);
  }
  return collectText(value);
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

type CitationMarker = {
  key: string;
  label: string;
  index?: number;
  source?: string;
};

const CITATION_INDEX_PATTERNS = [/\[(\d{1,3})\]/, /【(\d{1,3})】/, /［(\d{1,3})］/];
const CITATION_SOURCE_PATTERNS = [
  /[（(]\s*来源\s*[:：]\s*([^）)\n]{1,80})[）)]/,
  /(?:^|\n)\s*来源\s*[:：]\s*([^\n]{2,120})/
];

/** 只统计正文里实际出现的引用标记；证据池非空不等于产物引用了证据。 */
function analyzeCitations(
  artifactText: string,
  evidencePool: string[],
  structuredCitations: string[]
): { summary: CitationSummary; citedEvidence: string[] } {
  const markers: CitationMarker[] = [];
  let occurrences = 0;

  for (const pattern of CITATION_INDEX_PATTERNS) {
    for (const match of matchAll(artifactText, pattern)) {
      const index = Number(match[1]);
      if (!Number.isInteger(index) || index <= 0) {
        continue;
      }
      occurrences += 1;
      markers.push({ key: `index:${index}`, label: `[${index}]`, index });
    }
  }
  for (const pattern of CITATION_SOURCE_PATTERNS) {
    for (const match of matchAll(artifactText, pattern)) {
      const label = cleanCitationLabel(match[1]);
      if (!label) {
        continue;
      }
      occurrences += 1;
      markers.push({ key: `source:${label.toLowerCase()}`, label, source: label });
    }
  }

  const unique = new Map<string, CitationMarker>();
  for (const marker of markers) {
    unique.set(marker.key, marker);
  }
  const distinctMarkers = [...unique.values()];
  let valid = 0;
  let missing = 0;
  const cited: string[] = [];
  for (const marker of distinctMarkers) {
    const bound = bindCitation(marker, evidencePool);
    if (bound === undefined) {
      missing += 1;
    } else {
      valid += 1;
      if (bound) {
        cited.push(bound);
      }
    }
  }
  // 结构化 citation 由上游工具产出，视为有效引用；正文标记才需要核对编号/来源。
  for (const citation of structuredCitations) {
    valid += 1;
    cited.push(citation);
  }

  const structuredKeys = structuredCitations
    .map((item) => cleanCitationLabel(item).toLowerCase())
    .filter(Boolean);
  return {
    summary: {
      total: occurrences + structuredCitations.length,
      distinct: new Set([...distinctMarkers.map((item) => item.key), ...structuredKeys]).size,
      valid,
      missing,
      pool: evidencePool.length,
      markers: [...new Set([...distinctMarkers.map((item) => item.label), ...structuredCitations])].slice(
        0,
        12
      )
    },
    citedEvidence: [...new Set(cited)].slice(0, 8)
  };
}

function bindCitation(marker: CitationMarker, pool: string[]): string | undefined {
  if (marker.index !== undefined) {
    return pool[marker.index - 1];
  }
  const label = cleanCitationLabel(marker.source ?? marker.label).toLowerCase();
  if (!label) {
    return undefined;
  }
  return pool.find((item) => {
    const normalized = cleanCitationLabel(item).toLowerCase();
    return normalized.includes(label) || label.includes(normalized);
  });
}

function matchAll(text: string, pattern: RegExp): RegExpMatchArray[] {
  const global = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`
  );
  return [...text.matchAll(global)];
}

function cleanCitationLabel(value: string) {
  return value
    .replace(/^[\[\]【】\s]+|[\[\]【】\s]+$/g, "")
    .replace(/[。；;，,\s]+$/g, "")
    .trim();
}

export function collectCitations(value: unknown, depth = 0): string[] {
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
