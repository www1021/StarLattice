/**
 * 拉取服务方真正可用的模型清单（GET {baseUrl}/models）。
 *
 * 预置列表只是方便输入，实际能调通哪些模型取决于账号与密钥，
 * 所以让用户按自己的密钥拉一次列表，比手抄模型 ID 靠谱。
 * 各家返回结构不完全一致，这里统一成排好序的 id 数组。
 */

import { normalizeBaseUrl } from "./baseUrl.js";
import { readErrorDetail } from "./probe.js";

export type RemoteModelList = {
  ok: boolean;
  status: number;
  /** 服务方返回的模型 ID 列表，已去重排序；失败时为空。 */
  models: string[];
  message: string;
};

const TIMEOUT_MS = 12000;
const MAX_MODELS = 300;

function pickId(item: unknown): string {
  if (typeof item === "string") {
    return item.trim();
  }
  if (item && typeof item === "object") {
    const record = item as Record<string, unknown>;
    // OpenAI/DashScope 用 id，部分国产网关用 model 或 name。
    for (const key of ["id", "model", "name"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  }
  return "";
}

/** 从各家五花八门的响应里抠出模型 ID：data[] / models[] / output.models[] / 裸数组。 */
export function collectModelIds(payload: unknown): string[] {
  const roots: unknown[][] = [];
  if (Array.isArray(payload)) {
    roots.push(payload);
  } else if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.data)) {
      roots.push(record.data);
    }
    if (Array.isArray(record.models)) {
      roots.push(record.models);
    }
    if (record.output && typeof record.output === "object") {
      const output = record.output as Record<string, unknown>;
      if (Array.isArray(output.models)) {
        roots.push(output.models);
      }
    }
  }
  const ids = new Set<string>();
  for (const root of roots) {
    for (const item of root) {
      const id = pickId(item);
      if (id) {
        ids.add(id);
      }
    }
  }
  return [...ids].sort((left, right) => left.localeCompare(right)).slice(0, MAX_MODELS);
}

export async function listRemoteModels(input: {
  baseUrl: string;
  apiKey: string;
}): Promise<RemoteModelList> {
  const base = normalizeBaseUrl(input.baseUrl);
  if (!/^https?:\/\/.+/i.test(base)) {
    return { ok: false, status: 0, models: [], message: "接口地址必须是 http(s) 开头的完整地址。" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${base}/models`, {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {})
      },
      signal: controller.signal
    });
    if (!response.ok) {
      const detail = readErrorDetail(await response.text(), input.apiKey);
      const hint =
        (response.status === 401 || response.status === 403) && !input.apiKey
          ? "还没填 API Key，填上再拉列表。"
          : response.status === 401 || response.status === 403
            ? "密钥无效，或这套接口不支持列出模型。"
            : response.status === 404
              ? "这个地址没有 /models 接口，可能 baseUrl 少写了 /v1。"
              : "服务方返回错误。";
      return {
        ok: false,
        status: response.status,
        models: [],
        message: `${hint}${detail ? `（${detail}）` : ""}`
      };
    }
    const models = collectModelIds(await response.json().catch(() => null));
    if (models.length === 0) {
      return { ok: false, status: response.status, models: [], message: "服务方返回了空列表，还是手动填模型 ID。" };
    }
    return { ok: true, status: response.status, models, message: `拿到 ${models.length} 个可用模型。` };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, status: 0, models: [], message: `超过 ${TIMEOUT_MS / 1000} 秒没有响应，请检查地址与网络。` };
    }
    return {
      ok: false,
      status: 0,
      models: [],
      message: error instanceof Error ? `请求失败：${readErrorDetail(error.message, input.apiKey)}` : "请求失败。"
    };
  } finally {
    clearTimeout(timer);
  }
}
