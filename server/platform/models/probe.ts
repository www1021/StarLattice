/**
 * 模型连通性探针：在服务端发一个最小请求，避免把密钥暴露给浏览器，
 * 也绕过浏览器直连第三方接口的 CORS 限制。
 */

import { normalizeBaseUrl } from "./baseUrl.js";

export type ProbeResult = {
  ok: boolean;
  latencyMs: number;
  status: number;
  message: string;
};

const TIMEOUT_MS = 15000;

/** 上游错误体五花八门，统一抽出人能看懂的那句话；顺带把密钥从文本里抹掉。 */
export function readErrorDetail(raw: string, apiKey: string): string {
  let text = raw.trim();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const error = record.error;
      if (error && typeof error === "object") {
        const message = (error as Record<string, unknown>).message;
        if (typeof message === "string" && message.trim()) {
          text = message.trim();
        }
      } else if (typeof record.message === "string" && record.message.trim()) {
        text = record.message.trim();
      }
    }
  } catch {
    // 非 JSON 错误体（网关 HTML 页面等）直接截断原文。
  }
  if (apiKey) {
    text = text.split(apiKey).join("***");
  }
  // 上游有时会自己把密钥截成 “****heck” 回显回来，这种残段连同常见前缀一起抹掉。
  text = text
    .replace(/(api[\s_-]*key[^:：]{0,24}[:：]\s*)\S+/gi, "$1***")
    .replace(/\b(?:sk|AIza)[-_A-Za-z0-9]{6,}/g, "***");
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

export async function probeModel(input: {
  baseUrl: string;
  model: string;
  apiKey: string;
}): Promise<ProbeResult> {
  const base = normalizeBaseUrl(input.baseUrl);
  if (!/^https?:\/\/.+/i.test(base)) {
    return { ok: false, latencyMs: 0, status: 0, message: "接口地址必须是 http(s) 开头的完整地址。" };
  }
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: input.model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        stream: false
      }),
      signal: controller.signal
    });
    const latencyMs = Date.now() - started;
    const body = await response.text();
    if (!response.ok) {
      const detail = readErrorDetail(body, input.apiKey);
      // 404 有两种来源：地址拼错，或模型名不对。后者更常见，别一律怪 baseUrl。
      const modelMissed = /model[\s_-]*(not|does not)[\s_-]*(exist|found)|model_not_found|invalid model/i.test(detail);
      const hint =
        response.status === 401 || response.status === 403
          ? "密钥无效或没有该模型权限。"
          : response.status === 429
            ? "请求过于频繁或额度用尽。"
            : modelMissed
              ? "模型名称不对，或这把密钥没开通该模型；点「获取可用模型」看看实际能用哪些。"
              : response.status === 404
                ? "接口地址可能不对，注意 baseUrl 通常要带 /v1。"
                : "上游返回错误。";
      return {
        ok: false,
        latencyMs,
        status: response.status,
        message: `${hint}${detail ? `（${detail}）` : ""}`
      };
    }
    return { ok: true, latencyMs, status: response.status, message: `连通正常，耗时 ${latencyMs} ms。` };
  } catch (error) {
    const latencyMs = Date.now() - started;
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, latencyMs, status: 0, message: `超过 ${TIMEOUT_MS / 1000} 秒没有响应，请检查地址与网络。` };
    }
    return {
      ok: false,
      latencyMs,
      status: 0,
      message: error instanceof Error ? `请求失败：${readErrorDetail(error.message, input.apiKey)}` : "请求失败。"
    };
  } finally {
    clearTimeout(timer);
  }
}
