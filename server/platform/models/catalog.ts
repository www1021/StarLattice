import { PlatformError } from "../types.js";
import { getDefaultModelId, listUserModels, resolveUserApiKey } from "./userModels.js";

export type ModelCostTier = "low" | "medium" | "high";

/** 档案来源：内置、环境变量注入、或在设置面板里手动添加。 */
export type ModelOrigin = "builtin" | "env" | "user";

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
  origin: ModelOrigin;
  /** 密钥来源：设置面板存下来的、环境变量里的、或尚无。由 toModelView 兜底计算。 */
  keySource?: "stored" | "env" | "none";
  /** 仅用于执行层兜底（环境变量里配好的那一把），不出现在设置列表里。 */
  hidden?: boolean;
};

/** 对外展示用模型信息：含接口地址（本机配置，不敏感），但不含任何密钥。 */
export type ModelView = {
  id: string;
  label: string;
  description: string;
  provider: string;
  model: string;
  /** 仅用户自建模型回传接口地址，内置模型保持不暴露。 */
  baseUrl?: string;
  tags: string[];
  costTier: ModelCostTier;
  configured: boolean;
  custom: boolean;
  origin: ModelOrigin;
  /** 只说明密钥来自哪里，不回传任何片段（连头尾也不能给）。 */
  keySource: "stored" | "env" | "none";
  isDefault: boolean;
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

/**
 * 执行层里的「角色」id。它们不是模型，而是对默认模型的引用：
 * 规划/检索用 fast、复杂诊断用 reasoning、独立评审用 verifier、图文理解用 vision。
 * 角色不绑定任何地址与密钥，一律跟随用户设的默认模型，避免后端再写死一套内置档案。
 */
export const MODEL_ROLE_IDS = ["fast", "reasoning", "verifier", "vision"] as const;

const ROLE_LABELS: Record<string, string> = {
  fast: "快速模型",
  reasoning: "推理模型",
  verifier: "校验模型",
  vision: "多模态模型"
};

/**
 * 角色可以被部署配置单独指向某个模型（模型档案 id 或上游模型名）。
 * 不配就跟随用户在设置里选的默认模型 —— 所以界面上不需要再维护一套内置模型。
 */
const ROLE_ENV: Record<string, string> = {
  fast: "PLATFORM_MODEL_FAST",
  reasoning: "PLATFORM_MODEL_REASONING",
  verifier: "PLATFORM_VERIFY_MODEL",
  vision: "PLATFORM_MODEL_VISION"
};

/** 逻辑上代表「跟随用户默认」的占位 id，落库时不占用。 */
export const FOLLOW_DEFAULT_ID = "platform-default";

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

/** 设置面板里添加的模型；密钥已解密，仅在本进程内用于组装上游请求。 */
function userProfiles(): ModelProfile[] {
  return listUserModels().map((stored) => ({
    id: stored.id,
    label: stored.label,
    description: stored.description || "在设置面板中添加的 OpenAI 兼容模型。",
    provider: stored.provider,
    model: stored.model,
    baseUrl: stored.baseUrl,
    apiKey: resolveUserApiKey(stored),
    tags: stored.tags,
    costTier: stored.costTier,
    custom: true,
    origin: "user" as const,
    keySource: stored.apiKeyEnc ? ("stored" as const) : ("none" as const)
  }));
}

/**
 * 每次调用重新构建，保证测试与运行时改过设置后立即生效。
 * 目录里只有「用户在设置面板里添加的模型」：后端的密钥只能从这里来，
 * 环境变量不再参与模型组装，也不再有隐藏的兜底档案。
 */
export function getModelCatalog(): ModelProfile[] {
  const profiles: ModelProfile[] = [];
  for (const custom of userProfiles()) {
    const existing = profiles.findIndex((profile) => profile.id === custom.id);
    if (existing >= 0) {
      profiles.splice(existing, 1, custom);
    } else {
      profiles.push(custom);
    }
  }
  return aliasProfiles(profiles);
}

/** 设置里选的那个默认模型；它被删了就取第一个能用的，都没有才是 undefined。 */
function defaultProfileOf(catalog: ModelProfile[]): ModelProfile | undefined {
  const stored = getDefaultModelId().trim();
  if (stored && stored !== FOLLOW_DEFAULT_ID) {
    const hit = catalog.find((profile) => profile.id === stored);
    if (hit) {
      return hit;
    }
  }
  return catalog.find((profile) => profile.apiKey && profile.baseUrl) ?? catalog[0];
}

/** 角色 id 不是模型，只是对默认模型的一层引用。 */
function isModelRole(id: string): boolean {
  return (MODEL_ROLE_IDS as readonly string[]).includes(id);
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
      keySource: resolved.keySource,
      tags: [...new Set([...profile.tags, ...resolved.tags])]
    };
  };
  return profiles.map((profile) => resolveAlias(profile, new Set()));
}

/**
 * 角色被 PLATFORM_MODEL_FAST / _REASONING / _VERIFY / _VISION 指向某条已配好的模型时，
 * 按那条模型作答，只把 id 换成角色名。不指向就返回 undefined，交给「跟随默认」。
 */
function roleTargetProfile(
  role: string,
  catalog: ModelProfile[]
): ModelProfile | undefined {
  const targetId = envValue(ROLE_ENV[role] ?? "");
  if (!targetId) {
    return undefined;
  }
  const target = catalog.find((profile) => profile.id === targetId);
  if (!target) {
    return undefined;
  }
  return {
    ...target,
    id: role,
    label: `${target.label} · ${ROLE_LABELS[role] ?? role}`,
    tags: [...new Set([...target.tags, role])]
  };
}

export function getModelProfile(id: string): ModelProfile | undefined {
  const trimmed = id.trim();
  const catalog = getModelCatalog();
  const hit = catalog.find((profile) => profile.id === trimmed);
  if (hit) {
    return hit;
  }
  // 角色指向具体模型时先认那条：自循环、诊断这些地方要按「实际解析到哪个上游」做判断。
  if (trimmed && isModelRole(trimmed)) {
    const targeted = roleTargetProfile(trimmed, catalog);
    if (targeted) {
      return targeted;
    }
  }
  // 「跟随默认」与没有指定目标的角色 id 都解析到当前默认模型，方便老配置继续可用。
  if (!trimmed || trimmed === FOLLOW_DEFAULT_ID || isModelRole(trimmed)) {
    return defaultProfileOf(catalog);
  }
  return undefined;
}

export function isKnownModelId(id: string): boolean {
  const trimmed = id.trim();
  if (!trimmed || trimmed === FOLLOW_DEFAULT_ID || isModelRole(trimmed)) {
    return true;
  }
  return getModelCatalog().some((profile) => profile.id === trimmed);
}

/** 给人看的模型名：角色带上角色名，其余优先档案名，最后退回 id。 */
export function modelDisplayLabel(id: string): string {
  const trimmed = id.trim();
  const profile = getModelProfile(trimmed);
  if (isModelRole(trimmed)) {
    return profile ? `${profile.label} · ${ROLE_LABELS[trimmed]}` : (ROLE_LABELS[trimmed] ?? trimmed);
  }
  if (profile) {
    return profile.label;
  }
  if (trimmed === FOLLOW_DEFAULT_ID) {
    return "跟随默认";
  }
  return trimmed;
}

/** 设置列表里能看到的模型 id（不含隐藏兜底档案）。 */
export function availableModelIds(): string[] {
  return getModelCatalog()
    .filter((profile) => !profile.hidden)
    .map((profile) => profile.id);
}

/** 当前是否已经有任何一套可用的凭据。 */
export function isAnyModelConfigured(): boolean {
  return getModelCatalog().some((profile) => Boolean(profile.apiKey && profile.baseUrl));
}

export function toModelView(profile: ModelProfile): ModelView {
  const activeId = defaultProfileOf(getModelCatalog())?.id;
  return {
    id: profile.id,
    label: profile.label,
    description: profile.description,
    provider: profile.provider,
    model: profile.model,
    // 编辑自定义模型需要回显地址；环境变量注入的档案不外传地址。
    ...(profile.origin === "user" ? { baseUrl: profile.baseUrl } : {}),
    tags: profile.tags,
    costTier: profile.costTier,
    configured: Boolean(profile.apiKey && profile.baseUrl),
    custom: profile.custom,
    origin: profile.origin,
    keySource: profile.apiKey ? (profile.keySource ?? "env") : "none",
    isDefault: profile.id === activeId
  };
}

/** 注册中心展示：未知 id 按“上游直连”展示，不隐藏、不替换。 */
export function describeAgentModel(id: string | undefined): ModelView {
  const requested = id?.trim() || FOLLOW_DEFAULT_ID;
  const profile = getModelProfile(requested);
  if (profile) {
    const view = toModelView(profile);
    // 角色 id 指向的是默认模型，展示时把角色名带上，注册中心才看得出它扮演什么。
    return isModelRole(requested)
      ? { ...view, id: requested, label: `${view.label} · ${ROLE_LABELS[requested]}` }
      : view;
  }
  const fallback = defaultProfileOf(getModelCatalog());
  return {
    id: requested,
    label: "未登记模型",
    description: "不在模型目录中，运行时按上游模型名直连当前默认模型，并在 trace 标记 fallback。",
    provider: fallback?.provider ?? "openai-compatible",
    model: requested,
    tags: ["raw"],
    costTier: "medium",
    configured: Boolean(fallback?.apiKey),
    custom: true,
    origin: "env",
    keySource: fallback?.apiKey ? (fallback.keySource ?? "env") : "none",
    isDefault: false
  };
}

function cheapestLowCostProfile(catalog: ModelProfile[]): ModelProfile | undefined {
  return [...catalog]
    .filter((profile) => profile.apiKey && profile.baseUrl)
    .sort((left, right) => COST_RANK[left.costTier] - COST_RANK[right.costTier])[0];
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
  const defaultProfile = defaultProfileOf(catalog);
  if (!defaultProfile) {
    throw new PlatformError(
      "还没有配置任何模型。请打开「设置 → 模型与密钥」，选一个供应商并填入自己的 API Key。",
      422
    );
  }
  const raw = requested?.trim() || FOLLOW_DEFAULT_ID;
  const matched = catalog.find((profile) => profile.id === raw);
  let profile: ModelProfile;
  let source: ModelResolutionSource = options.source ?? "default";
  let fallback: ModelResolution["fallback"];

  if (matched) {
    profile = matched;
  } else if (raw === FOLLOW_DEFAULT_ID) {
    // 跟随默认时保留真实模型 id，trace 里才能看出到底调了哪条。
    profile = defaultProfile;
  } else if (isModelRole(raw)) {
    // 角色只是引用：优先用部署配置指定的模型/上游名，没配就跟随默认模型。
    const roleTarget = envValue(ROLE_ENV[raw] ?? "");
    const targetProfile = roleTarget
      ? catalog.find((profile) => profile.id === roleTarget)
      : undefined;
    const label = `${targetProfile?.label ?? defaultProfile.label} · ${ROLE_LABELS[raw] ?? raw}`;
    profile = targetProfile
      ? { ...targetProfile, id: raw, label }
      : roleTarget
        ? { ...defaultProfile, id: raw, model: roleTarget, label }
        : { ...defaultProfile, id: raw, label };
    profile = { ...profile, tags: [...new Set([...profile.tags, raw])] };
  } else if (options.allowRaw === false) {
    profile = defaultProfile;
    source = "fallback";
    fallback = {
      requestedModel: raw,
      reason: `未知模型「${raw}」不在模型列表里，已回退到默认模型「${defaultProfile.label}」。`
    };
  } else {
    profile = {
      ...defaultProfile,
      id: raw,
      label: `直连 ${raw}`,
      description: "未在模型列表登记，按上游模型名直连当前默认模型的接口。",
      model: raw,
      tags: ["raw"],
      custom: true
    };
    source = "fallback";
    fallback = {
      requestedModel: raw,
      reason: `「${raw}」不在模型列表，已按上游模型名直连默认接口；建议到设置里登记成一条模型。`
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
  if (agentModel && agentModel !== FOLLOW_DEFAULT_ID) {
    return resolveModel(agentModel, { source: "agent", budgetExceeded: input.budgetExceeded });
  }
  const envModel = envValue("PLATFORM_VERIFY_MODEL");
  if (envModel) {
    return resolveModel(envModel, { source: "verifier", budgetExceeded: input.budgetExceeded });
  }
  return resolveModel("verifier", { source: "verifier", budgetExceeded: input.budgetExceeded });
}

/** Agent 保存时的强制校验：接受角色 id 或设置里真实存在的模型 id。 */
export function validateAgentModel(value: string | undefined): string {
  const id = value?.trim() || FOLLOW_DEFAULT_ID;
  if (isKnownModelId(id)) {
    return id;
  }
  const usable = availableModelIds();
  throw new PlatformError(
    usable.length
      ? `未知模型「${id}」。可用模型：${usable.join("、")}；需要接入其它模型请到「设置 → 模型与密钥」里添加。`
      : `未知模型「${id}」。还没有配置任何模型，请先到「设置 → 模型与密钥」里添加。`,
    422
  );
}
