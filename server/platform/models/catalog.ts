import { PlatformError } from "../types.js";

export type ModelCostTier = "low" | "medium" | "high";

export type ModelProfile = {
  id: string;
  label: string;
  description: string;
  /** 上游协议标识；当前执行层支持 OpenAI 兼容协议。 */
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  tags: string[];
  costTier: ModelCostTier;
  custom: boolean;
};

/** 对外展示用模型信息：不包含 baseUrl 与任何密钥。 */
export type ModelView = {
  id: string;
  label: string;
  description: string;
  provider: string;
  model: string;
  tags: string[];
  costTier: ModelCostTier;
  configured: boolean;
  custom: boolean;
};

export type ModelResolutionSource =
  | "default"
  | "node"
  | "agent"
  | "verifier"
  | "fallback"
  | "budget-downgrade";

export type ModelResolution = ModelProfile & {
  requestedModel: string;
  source: ModelResolutionSource;
  /** 请求值未登记或无法解析时的明确回退标记；不会静默替换。 */
  fallback?: {
    requestedModel: string;
    reason: string;
  };
  /** 超出运行 token 预算后发生的成本降级。 */
  downgraded?: {
    from: string;
    reason: string;
  };
};

export type ModelResolveOptions = {
  source?: ModelResolutionSource;
  budgetExceeded?: boolean;
  /** 未知逻辑 id 是否允许按上游模型名直连默认 provider；默认允许并打 fallback 标记。 */
  allowRaw?: boolean;
  /** 测试或特殊场景可关闭预算降级。 */
  downgrade?: boolean;
};

const DEFAULT_QWEN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_QWEN_MODEL = "qwen3-vl-plus";
const DEFAULT_MINIMAX_BASE_URL = "https://api.minimax.io";
const DEFAULT_MINIMAX_MODEL = "MiniMax-M3";

export const BUILTIN_MODEL_IDS = [
  "platform-default",
  "fast",
  "reasoning",
  "verifier",
  "vision",
  "minimax"
] as const;

const COST_RANK: Record<ModelCostTier, number> = {
  low: 0,
  medium: 1,
  high: 2
};

export function costTierRank(tier: ModelCostTier): number {
  return COST_RANK[tier];
}

function envValue(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function platformDefaultModel(): string {
  return (
    envValue("PLATFORM_LIVE_MODEL") ||
    envValue("QWEN_MODEL") ||
    envValue("AI_MODEL") ||
    DEFAULT_QWEN_MODEL
  );
}

function qwenBaseUrl(): string {
  return (
    envValue("QWEN_BASE_URL") ||
    envValue("DASHSCOPE_BASE_URL") ||
    envValue("AI_BASE_URL") ||
    DEFAULT_QWEN_BASE_URL
  );
}

function qwenApiKey(): string {
  return envValue("QWEN_API_KEY") || envValue("DASHSCOPE_API_KEY") || envValue("AI_API_KEY");
}

type CustomModelEntry = {
  id?: unknown;
  label?: unknown;
  description?: unknown;
  provider?: unknown;
  model?: unknown;
  baseUrl?: unknown;
  baseUrlEnv?: unknown;
  apiKey?: unknown;
  apiKeyEnv?: unknown;
  tags?: unknown;
  costTier?: unknown;
};

/**
 * 额外模型通过 PLATFORM_MODEL_CATALOG 注入（JSON 数组），
 * 便于在 OpenAI 兼容供应商之间切换而不改执行器；同 id 会覆盖内置档案。
 */
function customProfiles(): ModelProfile[] {
  const raw = envValue("PLATFORM_MODEL_CATALOG");
  if (!raw) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn(
      `[platform] PLATFORM_MODEL_CATALOG 不是合法 JSON，已忽略：${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.warn("[platform] PLATFORM_MODEL_CATALOG 必须是 JSON 数组，已忽略。");
    return [];
  }

  const profiles: ModelProfile[] = [];
  for (const [index, value] of parsed.entries()) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    const entry = value as CustomModelEntry;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const model = typeof entry.model === "string" ? entry.model.trim() : "";
    if (!id || !model) {
      console.warn(`[platform] PLATFORM_MODEL_CATALOG[${index}] 缺少 id 或 model，已跳过。`);
      continue;
    }
    const baseUrlEnv = typeof entry.baseUrlEnv === "string" ? entry.baseUrlEnv.trim() : "";
    const apiKeyEnv = typeof entry.apiKeyEnv === "string" ? entry.apiKeyEnv.trim() : "";
    profiles.push({
      id,
      label: typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : id,
      description:
        typeof entry.description === "string" && entry.description.trim()
          ? entry.description.trim()
          : "通过 PLATFORM_MODEL_CATALOG 注册的 OpenAI 兼容模型。",
      provider: typeof entry.provider === "string" && entry.provider.trim() ? entry.provider.trim() : "openai-compatible",
      model,
      baseUrl:
        typeof entry.baseUrl === "string" && entry.baseUrl.trim()
          ? entry.baseUrl.trim()
          : baseUrlEnv
            ? envValue(baseUrlEnv)
            : qwenBaseUrl(),
      apiKey:
        typeof entry.apiKey === "string" && entry.apiKey.trim()
          ? entry.apiKey.trim()
          : apiKeyEnv
            ? envValue(apiKeyEnv)
            : qwenApiKey(),
      tags: Array.isArray(entry.tags)
        ? entry.tags.filter((tag): tag is string => typeof tag === "string" && tag.trim() !== "")
        : [],
      costTier: isCostTier(entry.costTier) ? entry.costTier : "medium",
      custom: true
    });
  }
  return profiles;
}

function isCostTier(value: unknown): value is ModelCostTier {
  return value === "low" || value === "medium" || value === "high";
}

function builtinProfiles(): ModelProfile[] {
  const defaultModel = platformDefaultModel();
  const minimaxApiKey = envValue("MINIMAX_API_KEY");
  return [
    {
      id: "platform-default",
      label: "平台默认模型",
      description: "未显式配置模型时的全局默认；读取 PLATFORM_LIVE_MODEL / QWEN_MODEL。",
      provider: "qwen",
      model: defaultModel,
      baseUrl: qwenBaseUrl(),
      apiKey: qwenApiKey(),
      tags: ["default", "balanced"],
      costTier: "medium",
      custom: false
    },
    {
      id: "fast",
      label: "快速模型",
      description: "低延迟、低成本角色（规划、检索、初稿）；可用 PLATFORM_MODEL_FAST 覆盖。",
      provider: "qwen",
      model: envValue("PLATFORM_MODEL_FAST") || defaultModel,
      baseUrl: qwenBaseUrl(),
      apiKey: qwenApiKey(),
      tags: ["fast", "low-cost"],
      costTier: "low",
      custom: false
    },
    {
      id: "reasoning",
      label: "推理模型",
      description: "复杂诊断与修订角色；可用 PLATFORM_MODEL_REASONING 覆盖。",
      provider: "qwen",
      model:
        envValue("PLATFORM_MODEL_REASONING") ||
        envValue("PLATFORM_MODEL_STRONG") ||
        defaultModel,
      baseUrl: qwenBaseUrl(),
      apiKey: qwenApiKey(),
      tags: ["reasoning", "strong"],
      costTier: "high",
      custom: false
    },
    {
      id: "verifier",
      label: "验证模型",
      description: "独立评审与打分角色；可用 PLATFORM_VERIFY_MODEL 覆盖，默认跟随平台模型。",
      provider: "qwen",
      model: envValue("PLATFORM_VERIFY_MODEL") || defaultModel,
      baseUrl: qwenBaseUrl(),
      apiKey: qwenApiKey(),
      tags: ["verifier", "independent"],
      costTier: "medium",
      custom: false
    },
    {
      id: "vision",
      label: "多模态模型",
      description: "图片/文档理解角色；读取 QWEN_MODEL（默认 qwen3-vl-plus）。",
      provider: "qwen",
      model: envValue("PLATFORM_MODEL_VISION") || envValue("QWEN_MODEL") || DEFAULT_QWEN_MODEL,
      baseUrl: qwenBaseUrl(),
      apiKey: qwenApiKey(),
      tags: ["vision", "multimodal"],
      costTier: "medium",
      custom: false
    },
    {
      id: "minimax",
      label: "MiniMax 模型",
      description: "跨供应商 OpenAI 兼容通道；需要 MINIMAX_API_KEY。",
      provider: "minimax",
      model: envValue("MINIMAX_MODEL") || DEFAULT_MINIMAX_MODEL,
      baseUrl: envValue("MINIMAX_BASE_URL") || DEFAULT_MINIMAX_BASE_URL,
      apiKey: minimaxApiKey,
      tags: ["fast", "cross-provider"],
      costTier: "low",
      custom: false
    }
  ];
}

/** 每次调用重新构建，保证测试与运行时修改环境变量后立即生效。 */
export function getModelCatalog(): ModelProfile[] {
  const profiles = builtinProfiles();
  for (const custom of customProfiles()) {
    const existing = profiles.findIndex((profile) => profile.id === custom.id);
    if (existing >= 0) {
      profiles.splice(existing, 1, custom);
    } else {
      profiles.push(custom);
    }
  }
  return aliasProfiles(profiles);
}

/**
 * 允许环境变量把某个逻辑模型的 model 写成另一个逻辑 id（如 PLATFORM_VERIFY_MODEL=minimax），
 * 这样 profile 会继承目标档案的 provider / 凭据，而不是把 "minimax" 当成 Qwen 模型名。
 */
function aliasProfiles(profiles: ModelProfile[]): ModelProfile[] {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const resolveAlias = (profile: ModelProfile, seen: Set<string>): ModelProfile => {
    const target = byId.get(profile.model);
    if (!target || target.id === profile.id || seen.has(target.id)) {
      return profile;
    }
    const resolved = resolveAlias(target, new Set([...seen, profile.id]));
    return {
      ...profile,
      provider: resolved.provider,
      model: resolved.model,
      baseUrl: resolved.baseUrl,
      apiKey: resolved.apiKey,
      tags: [...new Set([...profile.tags, ...resolved.tags])]
    };
  };
  return profiles.map((profile) => resolveAlias(profile, new Set()));
}

export function getModelProfile(id: string): ModelProfile | undefined {
  return getModelCatalog().find((profile) => profile.id === id.trim());
}

export function isKnownModelId(id: string): boolean {
  return getModelCatalog().some((profile) => profile.id === id.trim());
}

export function availableModelIds(): string[] {
  return getModelCatalog().map((profile) => profile.id);
}

export function toModelView(profile: ModelProfile): ModelView {
  return {
    id: profile.id,
    label: profile.label,
    description: profile.description,
    provider: profile.provider,
    model: profile.model,
    tags: profile.tags,
    costTier: profile.costTier,
    configured: Boolean(profile.apiKey && profile.baseUrl),
    custom: profile.custom
  };
}

/** 至少一个逻辑模型具备可用凭据时，才允许打开 live 执行。 */
export function isAnyModelConfigured(): boolean {
  return getModelCatalog().some((profile) => Boolean(profile.apiKey && profile.baseUrl));
}

/** 注册中心展示：未知 id 按“上游直连”展示，不隐藏、不替换。 */
export function describeAgentModel(id: string | undefined): ModelView {
  const requested = id?.trim() || "platform-default";
  const profile = getModelProfile(requested);
  if (profile) {
    return toModelView(profile);
  }
  return {
    id: requested,
    label: "未登记模型",
    description: "不在模型目录中，运行时按上游模型名直连平台默认 provider，并在 trace 标记 fallback。",
    provider: "qwen",
    model: requested,
    tags: ["raw"],
    costTier: "medium",
    configured: Boolean(qwenApiKey()),
    custom: true
  };
}

function cheapestLowCostProfile(catalog: ModelProfile[]): ModelProfile {
  const preferred = catalog.find((profile) => profile.id === "fast");
  if (preferred) {
    return preferred;
  }
  return [...catalog].sort(
    (left, right) => COST_RANK[left.costTier] - COST_RANK[right.costTier]
  )[0];
}

/**
 * 解析顺序：显式逻辑模型 → 平台默认；预算超限时降级到低成本档。
 * 未知 id 不静默替换：要么按上游模型名直连（allowRaw），要么回退默认并写 fallback。
 */
export function resolveModel(
  requested: string | undefined,
  options: ModelResolveOptions = {}
): ModelResolution {
  const catalog = getModelCatalog();
  const raw = requested?.trim() || "platform-default";
  const matched = catalog.find((profile) => profile.id === raw);
  const defaultProfile = catalog.find((profile) => profile.id === "platform-default") ?? catalog[0];
  let profile: ModelProfile;
  let source: ModelResolutionSource = options.source ?? "default";
  let fallback: ModelResolution["fallback"];

  if (matched) {
    profile = matched;
  } else if (options.allowRaw === false) {
    profile = defaultProfile;
    source = "fallback";
    fallback = {
      requestedModel: raw,
      reason: `未知逻辑模型「${raw}」不在模型目录，已回退 platform-default。`
    };
  } else {
    profile = {
      ...defaultProfile,
      id: raw,
      label: "直连模型",
      description: "未在模型目录登记，按上游模型名直连平台默认 provider。",
      model: raw,
      tags: ["raw"],
      custom: true
    };
    source = "fallback";
    fallback = {
      requestedModel: raw,
      reason: `「${raw}」不在模型目录，已按上游模型名直连默认 provider；建议登记为逻辑模型。`
    };
  }

  let downgraded: ModelResolution["downgraded"];
  if (
    options.budgetExceeded &&
    options.downgrade !== false &&
    profile.costTier !== "low"
  ) {
    const cheaper = cheapestLowCostProfile(catalog);
    if (cheaper && cheaper.id !== profile.id) {
      downgraded = {
        from: profile.id,
        reason: "本次运行 token 预算已用尽，按成本策略降级到低成本模型。"
      };
      profile = cheaper;
      source = "budget-downgrade";
    }
  }

  return {
    ...profile,
    requestedModel: raw,
    source,
    ...(fallback ? { fallback } : {}),
    ...(downgraded ? { downgraded } : {})
  };
}

/** Agent 节点：node.model 优先于 Agent 注册记录里的 model。 */
export function resolveAgentModel(input: {
  nodeModel?: string;
  agentModel?: string;
  budgetExceeded?: boolean;
}): ModelResolution {
  const nodeModel = input.nodeModel?.trim();
  if (nodeModel) {
    return resolveModel(nodeModel, { source: "node", budgetExceeded: input.budgetExceeded });
  }
  return resolveModel(input.agentModel, { source: "agent", budgetExceeded: input.budgetExceeded });
}

/** 验证器：节点模型优先，其次验证 Agent 自己的模型，最后 PLATFORM_VERIFY_MODEL / 全局默认。 */
export function resolveVerificationModel(input: {
  nodeModel?: string;
  agentModel?: string;
  budgetExceeded?: boolean;
}): ModelResolution {
  const nodeModel = input.nodeModel?.trim();
  if (nodeModel) {
    return resolveModel(nodeModel, { source: "node", budgetExceeded: input.budgetExceeded });
  }
  const agentModel = input.agentModel?.trim();
  if (agentModel && agentModel !== "platform-default") {
    return resolveModel(agentModel, { source: "agent", budgetExceeded: input.budgetExceeded });
  }
  const envModel = envValue("PLATFORM_VERIFY_MODEL");
  if (envModel) {
    return resolveModel(envModel, { source: "verifier", budgetExceeded: input.budgetExceeded });
  }
  return resolveModel("verifier", { source: "verifier", budgetExceeded: input.budgetExceeded });
}

/** Agent 保存时的强制校验：只接受目录中的逻辑 id，避免配置了却无人使用的“展示字段”。 */
export function validateAgentModel(value: string | undefined): string {
  const id = value?.trim() || "platform-default";
  if (isKnownModelId(id)) {
    return id;
  }
  throw new PlatformError(
    `未知模型「${id}」。可用逻辑模型：${availableModelIds().join("、")}；如需接入其它模型，请通过 PLATFORM_MODEL_CATALOG 注册。`,
    422
  );
}
