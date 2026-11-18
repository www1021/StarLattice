import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { PlatformError } from "../types.js";
import { normalizeBaseUrl } from "./baseUrl.js";
import { currentOwnerId } from "../../auth/context.js";
import { SEED_MODELS } from "./seedModels.js";

/**
 * 用户自定义模型档案（设置面板里「模型与密钥」写进去的那些）。
 *
 * 存储：data/settings/models.json，API Key 用 AES-256-GCM 加密后落盘，
 * 密钥单独存 data/settings/model-key（首次使用自动生成，权限 0600）。
 * 接口层永远只返回脱敏后的 hint，不返回明文。
 */

export type ModelCostTierName = "low" | "medium" | "high";

export type StoredModel = {
  id: string;
  label: string;
  description: string;
  provider: string;
  model: string;
  baseUrl: string;
  /** 形如 v1:iv:tag:cipher，只在本模块内解密。 */
  apiKeyEnc: string;
  tags: string[];
  costTier: ModelCostTierName;
  createdAt: string;
  updatedAt: string;
};

export type UserModelInput = {
  id?: string;
  label?: string;
  description?: string;
  provider?: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  tags?: string[];
  costTier?: ModelCostTierName;
};

type SettingsFile = {
  version: 1;
  defaultModelId: string;
  models: StoredModel[];
};

/** 这五个 id 被执行层的角色解析占用，用户模型不能叫这些名字。 */
const RESERVED_IDS = new Set([
  "platform-default",
  "fast",
  "reasoning",
  "verifier",
  "vision"
]);

/** 无身份调用（后台任务、单元测试）用的独立目录，不与应用根目录混用。 */
const SYSTEM_SCOPE_DIR = "_system";

function settingsDir(): string {
  const root = process.env.MODEL_SETTINGS_DIR || path.resolve("data", "settings");
  const ownerId = currentOwnerId();
  // 有请求身份时按用户分目录；不同账号的 API Key 从物理上就分开。
  // 无身份时给一个空目录，绝不回落到根目录：根目录在分账号之前存过全局模型，
  // 回落等于让后台任务默默共用某个账号的凭据。
  return ownerId ? path.join(root, ownerId) : path.join(root, SYSTEM_SCOPE_DIR);
}

function modelsPath(): string {
  return path.join(settingsDir(), "models.json");
}

function keyPath(): string {
  return path.join(settingsDir(), "model-key");
}

function ensureDir(): void {
  const dir = settingsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/** 首次调用生成 32 字节密钥；已有则复用。 */
function secretKey(): Buffer {
  ensureDir();
  const file = keyPath();
  if (existsSync(file)) {
    const raw = readFileSync(file, "utf8").trim();
    const buf = Buffer.from(raw, "base64");
    if (buf.length === 32) {
      return buf;
    }
    // 文件被截断或手改坏了，不静默重建，否则已存的密钥全部解不开却毫无提示。
    throw new PlatformError(
      "本地密钥文件 data/settings/model-key 已损坏，无法解密已保存的 API Key。请删除后重新填写密钥。",
      500
    );
  }
  const fresh = randomBytes(32);
  writeFileSync(file, fresh.toString("base64"), { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows 上 chmod 基本无效，忽略即可。
  }
  return fresh;
}

function encrypt(plain: string): string {
  if (!plain) {
    return "";
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${body.toString("base64")}`;
}

function decrypt(payload: string): string {
  if (!payload) {
    return "";
  }
  const [version, ivRaw, tagRaw, bodyRaw] = payload.split(":");
  if (version !== "v1" || !ivRaw || !tagRaw || !bodyRaw) {
    return "";
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", secretKey(), Buffer.from(ivRaw, "base64"));
    decipher.setAuthTag(Buffer.from(tagRaw, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(bodyRaw, "base64")),
      decipher.final()
    ]).toString("utf8");
  } catch {
    return "";
  }
}

function emptySettings(): SettingsFile {
  return { version: 1, defaultModelId: "", models: [] };
}

/**
 * 首次使用的账号：把预置的三条模型摆出来，密钥留空。
 * 落库时机交给用户第一次保存，不在这里写盘——没配密钥的空档案没必要先占一份配置。
 */
function seedSettings(): SettingsFile {
  const now = new Date().toISOString();
  return {
    version: 1,
    defaultModelId: "",
    models: SEED_MODELS.map((seed) => ({
      ...seed,
      apiKeyEnc: "",
      createdAt: now,
      updatedAt: now,
      tags: [...seed.tags]
    }))
  };
}

function normalizeStored(value: unknown): StoredModel | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const entry = value as Record<string, unknown>;
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  const model = typeof entry.model === "string" ? entry.model.trim() : "";
  const baseUrl = typeof entry.baseUrl === "string" ? entry.baseUrl.trim() : "";
  if (!id || !model || !baseUrl) {
    return undefined;
  }
  return {
    id,
    label: typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : id,
    description: typeof entry.description === "string" ? entry.description : "",
    provider:
      typeof entry.provider === "string" && entry.provider.trim() ? entry.provider.trim() : "openai",
    model,
    baseUrl,
    apiKeyEnc: typeof entry.apiKeyEnc === "string" ? entry.apiKeyEnc : "",
    tags: Array.isArray(entry.tags)
      ? entry.tags.filter((tag): tag is string => typeof tag === "string" && tag.trim() !== "")
      : [],
    costTier:
      entry.costTier === "low" || entry.costTier === "high" || entry.costTier === "medium"
        ? entry.costTier
        : "medium",
    createdAt: typeof entry.createdAt === "string" ? entry.createdAt : new Date().toISOString(),
    updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : new Date().toISOString()
  };
}

/**
 * 按「文件路径 + mtime + size」缓存，避免对话链路每次取密钥都读一次磁盘。
 * 必须按路径分开：不同账号的 models.json 完全可能大小一样，复制出来的 mtime 也一样，
 * 共用一条缓存会让一个账号读到另一个账号的模型列表和解密后的 Key。
 */
const settingsCache = new Map<string, { stamp: string; value: SettingsFile }>();

export function readSettings(): SettingsFile {
  const file = modelsPath();
  if (!existsSync(file)) {
    // 文件不在了（删掉最后一条模型后目录被清空）时缓存也要跟着失效。
    settingsCache.delete(file);
    return seedSettings();
  }
  const stamp = `${file}:${cacheStamp(file)}`;
  const cached = settingsCache.get(file);
  if (cached && cached.stamp === stamp) {
    return cached.value;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // 配置文件坏了不应该让整个平台起不来：当作空配置，但保留原文件供人工排查。
    console.warn(`[models] ${file} 不是合法 JSON，已按空配置处理。`);
    return emptySettings();
  }
  if (typeof parsed !== "object" || parsed === null) {
    return emptySettings();
  }
  const record = parsed as Record<string, unknown>;
  const models = Array.isArray(record.models)
    ? record.models.map(normalizeStored).filter((item): item is StoredModel => Boolean(item))
    : [];
  const value: SettingsFile = {
    version: 1,
    // 旧版本把默认写成 "platform-default" 这个占位 id，读的时候归零，交给目录自动选第一个。
    defaultModelId:
      typeof record.defaultModelId === "string" &&
      record.defaultModelId.trim() &&
      record.defaultModelId.trim() !== "platform-default"
        ? record.defaultModelId.trim()
        : "",
    models
  };
  settingsCache.set(file, { stamp, value });
  return value;
}

function cacheStamp(file: string): string {
  try {
    const info = statSync(file);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return "";
  }
}

function writeSettings(next: SettingsFile): void {
  ensureDir();
  // 写完立刻让缓存失效，避免设置面板保存后仍读到旧值。
  const file = modelsPath();
  settingsCache.delete(file);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * 启动时没有请求身份，settingsDir() 会落到空的 _system 目录，
 * 因此 listUserModels()/isAnyModelConfigured() 在启动期永远看不到账号配好的模型。
 * 这里只做「是否存在可用凭据」的启动期判定：扫描各账号目录的 models.json，
 * 不解密、不缓存，也不把任何 Key 带进进程级全局状态。
 * 真正调用仍由 resolveModel() 在当前请求的账号上下文里解析，不会串用别人的凭据。
 */
export function configuredModelOwnerIds(): string[] {
  const root = process.env.MODEL_SETTINGS_DIR || path.resolve("data", "settings");
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      // 下划线开头的是 _system / _legacy 等系统保留目录，绝不拿来当账号身份。
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const owners: string[] = [];
  for (const owner of entries) {
    const file = path.join(root, owner, "models.json");
    if (!existsSync(file)) {
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      const models = (parsed as Record<string, unknown> | null)?.models;
      if (!Array.isArray(models)) {
        continue;
      }
      const usable = models.some((item) => {
        if (!item || typeof item !== "object") {
          return false;
        }
        const record = item as Record<string, unknown>;
        return Boolean((record.apiKeyEnc || record.apiKey) && record.baseUrl);
      });
      if (usable) {
        owners.push(owner);
      }
    } catch {
      // 单个账号的配置文件坏了不影响其他账号，也不该让平台起不来。
    }
  }
  return owners;
}

export function listUserModels(): StoredModel[] {
  return readSettings().models;
}

export function getUserModel(id: string): StoredModel | undefined {
  return readSettings().models.find((item) => item.id === id.trim());
}

export function getDefaultModelId(): string {
  const settings = readSettings();
  const stored = settings.defaultModelId;
  // 指到一个已经被删掉的 id 时，直接把第一条可用模型当作默认，避免界面显示一个不存在的名字。
  if (stored && settings.models.some((item) => item.id === stored)) {
    return stored;
  }
  // 没显式选过：优先挑已经填了密钥的那条。预置骨架只是占位，别让界面默认指向一条用不了的模型。
  const usable = settings.models.find((item) => Boolean(item.apiKeyEnc && item.baseUrl));
  return (usable ?? settings.models[0])?.id ?? "";
}

/**
 * 只取用户真正选过的那条默认 id，不做兜底。
 * 预置骨架不算「选过」：否则执行层会把一条还没填密钥的模型当成默认，
 * 而用户明明已经配好并指向了另一条。
 */
export function getExplicitDefaultModelId(): string {
  return readSettings().defaultModelId.trim();
}

/** 只能把真实存在的模型设为默认；删掉默认模型时由 getDefaultModelId 自动顺延。 */
export function setDefaultModelId(id: string): string {
  const settings = readSettings();
  const trimmed = id.trim();
  if (!trimmed) {
    throw new PlatformError("模型 id 不能为空。", 422);
  }
  if (!settings.models.some((item) => item.id === trimmed)) {
    throw new PlatformError(`模型「${trimmed}」不存在，无法设为默认。`, 404);
  }
  writeSettings({ ...settings, defaultModelId: trimmed });
  return trimmed;
}

/** 明文只在这里出现，用于组装上游请求。 */
export function resolveUserApiKey(stored: StoredModel): string {
  return decrypt(stored.apiKeyEnc);
}

/** 明文只在这里出现，用于组装上游请求；接口层不回传任何片段。 */

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || `model-${Date.now().toString(36)}`;
}

function assertBaseUrl(value: string): string {
  // 粘完整端点也认，存下来统一是 /v1 这一层
  const url = normalizeBaseUrl(value);
  if (!url) {
    throw new PlatformError("接口地址不能为空。", 422);
  }
  if (url.length > 300) {
    throw new PlatformError("接口地址过长。", 422);
  }
  if (!/^https?:\/\/.+/i.test(url)) {
    throw new PlatformError("接口地址必须是 http:// 或 https:// 开头的完整地址。", 422);
  }
  // 只允许 http(s)，并且拒绝把账号密码塞进 URL —— 既避免凭据落到日志，也挡住畸形地址。
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PlatformError("接口地址格式不正确。", 422);
  }
  if (parsed.username || parsed.password) {
    throw new PlatformError("接口地址里不要带账号密码，API Key 请填在密钥栏。", 422);
  }
  return url;
}

function assertShort(value: string, label: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new PlatformError(`${label}最多 ${max} 个字符。`, 422);
  }
  return trimmed;
}

export function saveUserModel(input: UserModelInput): StoredModel {
  const model = assertShort(input.model ?? "", "模型 ID", 120);
  if (!model) {
    throw new PlatformError("模型 ID 不能为空，例如 gpt-4o-mini 或 qwen-plus。", 422);
  }
  if (!/^[A-Za-z0-9._:/-]+$/.test(model)) {
    throw new PlatformError("模型 ID 只能包含字母、数字、点、斜杠、冒号、下划线与连字符。", 422);
  }
  const baseUrl = assertBaseUrl(input.baseUrl ?? "");
  const settings = readSettings();
  const rawId = input.id?.trim();
  const id = rawId && /^[a-z0-9][a-z0-9-]*$/.test(rawId) ? rawId : slugify(rawId || model);
  if (RESERVED_IDS.has(id)) {
    throw new PlatformError(`「${id}」是执行层保留的角色名，请换一个名字。`, 422);
  }

  const existingIndex = settings.models.findIndex((item) => item.id === id);
  const existing = existingIndex >= 0 ? settings.models[existingIndex] : undefined;
  const apiKey = assertShort(input.apiKey ?? "", "API Key", 400);
  // 编辑时留空＝沿用原密钥，避免前端拿不到明文又把密钥抹掉。
  const apiKeyEnc = apiKey ? encrypt(apiKey) : (existing?.apiKeyEnc ?? "");
  const now = new Date().toISOString();

  const stored: StoredModel = {
    id,
    label: assertShort(input.label || existing?.label || model, "名称", 60),
    description: assertShort(input.description ?? existing?.description ?? "", "说明", 200),
    provider: assertShort(input.provider || existing?.provider || "openai", "供应商", 40),
    model,
    baseUrl,
    apiKeyEnc,
    tags: input.tags ?? existing?.tags ?? [],
    costTier: input.costTier ?? existing?.costTier ?? "medium",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };

  const models = [...settings.models];
  if (existingIndex >= 0) {
    models.splice(existingIndex, 1, stored);
  } else {
    models.push(stored);
  }
  writeSettings({ ...settings, models });
  return stored;
}

export function deleteUserModel(id: string): boolean {
  const trimmed = id.trim();
  const settings = readSettings();
  const next = settings.models.filter((item) => item.id !== trimmed);
  if (next.length === settings.models.length) {
    return false;
  }
  // 删的正好是默认模型时留空，读取时自动顺延到第一个模型。
  const defaultModelId =
    settings.defaultModelId === trimmed ? "" : settings.defaultModelId;
  writeSettings({ ...settings, models: next, defaultModelId });
  return true;
}
