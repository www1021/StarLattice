import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { PlatformError, type HttpMethod, type HttpNode } from "../types.js";

const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 15_000;
const HTTP_METHODS = new Set<HttpMethod>(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "kubernetes.default.svc"
]);

/**
 * HTTP 节点实现。安全边界：
 * - 只允许 http / https 公网地址，拒绝回环、内网、链路本地与云元数据地址；
 * - 每一跳重定向都重新校验，避免 30x 跳到内网；
 * - 响应体上限 256KB，超时与手动重定向都受控；
 * - 轨迹里只记录请求头键名，不记录值，避免 Authorization 等密钥泄漏。
 */
export async function executeHttpNode(node: HttpNode, input: Record<string, unknown>) {
  const method = normalizeMethod(input.method);
  const rawUrl = stringValue(input.url) ?? node.url;
  const headers = normalizeHeaders(input.headers);
  const body = input.body === undefined ? node.requestBody : input.body;
  const timeoutMs = clampInt(numberValue(input.timeoutMs) ?? node.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000, 120_000);
  const payload = serializeBody(method, body, headers);
  const startedAt = Date.now();

  let url = await assertSafeHttpUrl(rawUrl);
  let response: Response | undefined;
  let redirects = 0;
  let currentMethod: HttpMethod = method;
  let currentPayload = payload;

  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      response = await fetch(url, {
        method: currentMethod,
        headers,
        body: currentPayload,
        redirect: "manual",
        signal: controller.signal,
        cache: "no-store"
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new PlatformError(`HTTP 请求超时（>${timeoutMs}ms）：${url.toString()}`, 400);
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new PlatformError(`HTTP 请求失败：${detail}`, 400);
    } finally {
      clearTimeout(timer);
    }

    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      if (redirects >= MAX_REDIRECTS) {
        await response.body?.cancel();
        throw new PlatformError(`HTTP 重定向超过 ${MAX_REDIRECTS} 次，已终止。`, 400);
      }
      redirects += 1;
      await response.body?.cancel();
      url = await assertSafeHttpUrl(new URL(location, url).toString());
      // 303 与 302 在浏览器语义里通常改为 GET；307/308 保留方法与请求体。
      if (response.status === 303 || (response.status === 302 && currentMethod === "POST")) {
        currentMethod = "GET";
        currentPayload = undefined;
      }
      continue;
    }
    break;
  }

  if (!response) {
    throw new PlatformError("HTTP 请求未产生响应。", 502);
  }

  const { text, bytes, truncated } = await readCapped(response);
  const contentType = response.headers.get("content-type") ?? "";
  const json = parseJson(text, contentType);
  const elapsed = Date.now() - startedAt;

  return {
    mode: "live",
    kind: "http",
    method: currentMethod,
    url: url.toString(),
    status: response.status,
    ok: response.ok,
    contentType,
    redirects,
    latencyMs: elapsed,
    truncated,
    bytes,
    summary: `${currentMethod} ${url.host}${url.pathname} → ${response.status}（${elapsed} ms）`,
    output: text || "（响应体为空）",
    json,
    request: {
      method: currentMethod,
      url: url.toString(),
      headerKeys: Object.keys(headers),
      hasBody: currentPayload !== undefined
    }
  };
}

export async function assertSafeHttpUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PlatformError(`HTTP 地址不是合法 URL："${raw}"`, 400);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PlatformError("HTTP 节点只允许 http / https 地址。", 400);
  }
  if (url.username || url.password) {
    throw new PlatformError("HTTP 地址不能包含用户名或密码，请改用请求头传凭据。", 400);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname) {
    throw new PlatformError("HTTP 地址缺少主机名。", 400);
  }
  if (isBlockedHostname(hostname)) {
    throw new PlatformError(`拒绝访问内网或元数据地址："${hostname}"。`, 400);
  }
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new PlatformError(`拒绝访问内网或保留地址："${hostname}"。`, 400);
    }
    return url;
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new PlatformError(`无法解析主机名："${hostname}"。`, 400);
  }
  if (addresses.length === 0) {
    throw new PlatformError(`主机名 "${hostname}" 没有可用地址。`, 400);
  }
  for (const record of addresses) {
    if (isPrivateAddress(record.address)) {
      throw new PlatformError(`主机 "${hostname}" 解析到内网或保留地址 ${record.address}，已拒绝。`, 400);
    }
  }
  return url;
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split(".").map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return true;
    }
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && parts[1] === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized === "::" || normalized === "::1") {
      return true;
    }
    if (
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("ff")
    ) {
      return true;
    }
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) {
      return isPrivateAddress(mapped[1]);
    }
    return false;
  }
  return true;
}

function isBlockedHostname(hostname: string): boolean {
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return true;
  }
  return (
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa") ||
    hostname === "0.0.0.0"
  );
}

function normalizeMethod(value: unknown): HttpMethod {
  const method = (typeof value === "string" ? value : "GET").toUpperCase();
  if (!HTTP_METHODS.has(method as HttpMethod)) {
    throw new PlatformError(`HTTP 方法不支持 "${method}"。`, 400);
  }
  return method as HttpMethod;
}

function normalizeHeaders(value: unknown): Record<string, string> {
  const headers: Record<string, string> = {
    "user-agent": "StarLattice-AgentPlatform/0.2"
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return headers;
  }
  const entries = Object.entries(value as Record<string, unknown>).slice(0, 30);
  for (const [key, item] of entries) {
    const name = key.trim();
    if (!name || /[\r\n]/.test(name)) {
      continue;
    }
    if (item === undefined || item === null) {
      continue;
    }
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
      continue;
    }
    const text = String(item);
    if (/[\r\n]/.test(text)) {
      continue;
    }
    headers[name.toLowerCase()] = text;
  }
  return headers;
}

function serializeBody(
  method: HttpMethod,
  value: unknown,
  headers: Record<string, string>
): string | undefined {
  if (method === "GET" || value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && Object.keys(value as Record<string, unknown>).length === 0) {
    return undefined;
  }
  if (!headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  return JSON.stringify(value);
}

async function readCapped(response: Response): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    return { text: "", bytes: 0, truncated: false };
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done || !value) {
      break;
    }
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      const keep = Math.max(0, MAX_RESPONSE_BYTES - (bytes - value.byteLength));
      chunks.push(value.subarray(0, keep));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return { text: buffer.toString("utf8"), bytes: Math.min(bytes, MAX_RESPONSE_BYTES), truncated };
}

function parseJson(text: string, contentType: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  const looksJson =
    contentType.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[");
  if (!looksJson) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}
