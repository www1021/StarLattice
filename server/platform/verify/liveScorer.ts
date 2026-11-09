import { createHash } from "node:crypto";
import { completeQwenChat } from "../../qwenOpenAiClient.js";
import { isAnyModelConfigured, resolveVerificationModel } from "../models/catalog.js";
import {
  heuristicDimensionScorer,
  type DimensionScorer,
  type ScorerContext
} from "./verifier.js";

const MAX_ARTIFACT_CHARS = 8000;
const MAX_CACHE_ENTRIES = 200;

export function isLlmVerifyEnabled() {
  return (
    process.env.PLATFORM_LIVE_AGENTS === "1" &&
    process.env.PLATFORM_LIVE_VERIFY === "1" &&
    isAnyModelConfigured()
  );
}

/**
 * 用验证 Agent 自身的人设为产物逐维度打分，替代启发式占位打分。
 * 同一验证器对同一份产物只发起一次模型调用（按维度缓存），解析失败时回退启发式分数，
 * 保证验证阶段不会因为单次模型异常拖垮整个运行。
 */
export type LlmScorerOptions = {
  /** 基准实验用：模型调用失败直接抛错，避免静默回退启发式后误以为测的是模型。 */
  strict?: boolean;
};

export function createLlmDimensionScorer(options: LlmScorerOptions = {}): DimensionScorer {
  const cache = new Map<string, Promise<Record<string, number>>>();

  return async (context) => {
    const key = cacheKey(context);
    let pending = cache.get(key);
    if (!pending) {
      pending = requestDimensionScores(context);
      cache.set(key, pending);
      if (cache.size > MAX_CACHE_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) {
          cache.delete(oldest);
        }
      }
    }

    const scores = await pending.catch((error) => {
      if (options.strict) {
        throw error;
      }
      const detail = error instanceof Error ? error.message : String(error);
      context.diagnostics?.push({ key: "llm-fallback", detail });
      console.warn(
        `[platform] 验证器「${context.agent.id}」模型打分失败，回退启发式打分：${detail}`
      );
      return undefined;
    });
    const value = scores?.[context.dimension];
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : heuristicDimensionScorer(context);
  };
}

async function requestDimensionScores(context: ScorerContext) {
  const resolution = resolveVerificationModel({
    nodeModel: context.agentModel ?? context.nodeModel,
    agentModel: context.agent.model,
    budgetExceeded: context.budgetExceeded
  });
  const system = [
    "你是独立验证器。按给定 rubric 给候选产物逐维度打分。",
    context.agent.prompt,
    "评分要求：只依据产物正文与证据列表；分数范围 0-1，可保留两位小数；不要参考产物自评。",
    '只输出合法 JSON，格式为 {"scores":{"维度名":0.00},"reason":"一句话依据"}，不要输出 Markdown 代码块或额外解释。'
  ]
    .filter(Boolean)
    .join("\n");

  const evidenceLabel =
    context.evidenceView === "cited" ? "产物实际引用的证据" : "可用证据列表";
  const user = [
    `## 评分维度\n${context.rubric.join("、")}`,
    `## 验证器\n${context.agent.name}（${context.agent.role}）`,
    `## ${evidenceLabel}\n${
      context.evidence.length > 0
        ? context.evidence.map((item, index) => `[${index + 1}] ${item}`).join("\n")
        : "（没有可引用的知识库证据）"
    }`,
    `## 产物正文\n${truncate(context.artifactText, MAX_ARTIFACT_CHARS)}`,
    context.evidenceView === "cited"
      ? "注意：你只看到产物实际引用的证据；正文没有引用却给出“证据充分”判断时应扣分。"
      : "注意：证据列表可用不代表产物已经引用；请检查正文是否真的给出引用或来源。",
    `请为以下每个维度打分：${context.rubric.map((name) => `"${name}"`).join("、")}。`
  ].join("\n\n");

  const content = await completeQwenChat({
    system,
    messages: [{ role: "user", content: user }],
    model: resolution.model,
    maxTokens: 512,
    temperature: 0,
    provider: {
      baseUrl: resolution.baseUrl,
      apiKey: resolution.apiKey,
      label: resolution.provider
    }
  });

  return parseScores(content);
}

function parseScores(content: string) {
  const json = extractJson(content);
  if (!json) {
    throw new Error("验证器没有返回可解析的 JSON");
  }
  const payload = JSON.parse(json) as Record<string, unknown>;
  const raw =
    typeof payload.scores === "object" && payload.scores !== null
      ? (payload.scores as Record<string, unknown>)
      : payload;

  const scores: Record<string, number> = {};
  for (const [dimension, value] of Object.entries(raw)) {
    const parsed = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(parsed)) {
      scores[dimension] = Math.min(1, Math.max(0, parsed));
    }
  }
  return scores;
}

function extractJson(content: string) {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return "";
  }
  return content.slice(start, end + 1);
}

function cacheKey(context: ScorerContext) {
  const resolution = resolveVerificationModel({
    nodeModel: context.agentModel ?? context.nodeModel,
    agentModel: context.agent.model,
    budgetExceeded: context.budgetExceeded
  });
  const digest = createHash("sha1")
    .update(context.agent.id)
    .update("|")
    .update(resolution.id)
    .update("|")
    .update(resolution.model)
    .update("|")
    .update(context.evidenceView ?? "pool")
    .update("|")
    .update(context.rubric.join(","))
    .update("|")
    .update(context.evidence.join("|"))
    .update("|")
    .update(context.artifactText)
    .digest("hex");
  return digest;
}

function truncate(value: string, maxChars: number) {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…（已截断）`;
}
