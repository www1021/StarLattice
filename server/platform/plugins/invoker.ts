import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PlatformError } from "../types.js";
import type { PluginInvokeResult, PluginRecord } from "../types.js";

const execFileAsync = promisify(execFile);
const API_TIMEOUT_MS = Number(process.env.PLUGIN_API_TIMEOUT_MS) || 15_000;
const CODE_TIMEOUT_MS = Number(process.env.PLUGIN_CODE_TIMEOUT_MS) || 10_000;
const PREVIEW_LIMIT = 1200;

function preview(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > PREVIEW_LIMIT ? `${trimmed.slice(0, PREVIEW_LIMIT)}…` : trimmed;
}

function hostOf(urlLike: string): string | undefined {
  try {
    return new URL(urlLike).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** 工具配置里的分组参数定义（header / query / body 共用结构）。 */
type GroupedParam = {
  name: string;
  description?: string;
  type?: string;
  required?: boolean;
  default?: string;
  enabled?: boolean;
};

function coerceParam(raw: unknown, type?: string): unknown {
  if (raw === undefined || raw === null || raw === "") return raw;
  if (type === "int" || type === "number") {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (type === "boolean") return raw === true || raw === "true";
  if (type === "object") {
    try {
      return typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      return raw;
    }
  }
  return raw;
}

/** API 插件实跑：真实发请求，强制域名白名单，返回状态码 + 耗时 + 预览 + 请求行。 */
export async function invokeApiPlugin(
  plugin: PluginRecord,
  args: Record<string, unknown>
): Promise<PluginInvokeResult> {
  const endpoint = plugin.endpoint;
  if (!endpoint) {
    throw new PlatformError("该 API 插件尚未配置接口地址。", 400);
  }
  const allowed = (plugin.domain ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase().split(":")[0])
    .filter(Boolean);
  const host = hostOf(endpoint);
  if (allowed.length > 0 && host && !allowed.includes(host)) {
    throw new PlatformError(`接口域名 ${host} 不在白名单（${plugin.domain}）内。`, 400);
  }

  const method = (plugin.method ?? "POST").toUpperCase();
  const startedAt = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {};
    const query = new URLSearchParams();
    let bodyObj: Record<string, unknown> | undefined;

    const auth = (plugin.config?.auth ?? {}) as {
      type?: string;
      location?: string;
      name?: string;
      value?: string;
      token?: string;
      key?: string;
      header?: string;
    };
    if (auth.type === "bearer" && (auth.token || auth.value)) {
      headers["Authorization"] = `Bearer ${auth.token ?? auth.value}`;
    } else if (auth.type === "apikey") {
      const keyVal = auth.value ?? auth.key;
      if (keyVal) {
        if (auth.location === "query") {
          query.set(auth.name || "api_key", keyVal);
        } else {
          headers[auth.name || auth.header?.trim() || "X-API-Key"] = keyVal;
        }
      }
    }

    const groups = plugin.config?.paramGroups as
      | { header?: GroupedParam[]; query?: GroupedParam[]; body?: GroupedParam[] }
      | undefined;
    const pick = (p: GroupedParam): unknown => {
      if (p.enabled === false) return undefined;
      const raw = args[p.name];
      if (raw !== undefined && raw !== "") return coerceParam(raw, p.type);
      if (p.default !== undefined && p.default !== "") return coerceParam(p.default, p.type);
      return undefined;
    };

    if (groups) {
      const consumed = new Set<string>();
      for (const p of groups.header ?? []) {
        const v = pick(p);
        if (v !== undefined && p.name) {
          headers[p.name] = String(v);
          consumed.add(p.name);
        }
      }
      for (const p of groups.query ?? []) {
        const v = pick(p);
        if (v !== undefined && p.name) {
          query.set(p.name, String(v));
          consumed.add(p.name);
        }
      }
      if (method !== "GET" && method !== "HEAD") {
        bodyObj = {};
        for (const p of groups.body ?? []) {
          const v = pick(p);
          if (v !== undefined && p.name) {
            bodyObj[p.name] = v;
            consumed.add(p.name);
          }
        }
      }
      // 兜底：校验时填了但参数表未定义（或被关闭）的参数不丢弃，
      // GET 追加到查询串、POST 追加到请求体，保证输入参数一定生效。
      for (const [key, value] of Object.entries(args)) {
        if (consumed.has(key) || !key) continue;
        if (method === "GET" || method === "HEAD") {
          query.set(key, typeof value === "string" ? value : JSON.stringify(value));
        } else {
          (bodyObj ??= {})[key] = value;
        }
      }
    } else {
      // 兼容旧数据：无分组定义时，参数整体作为 query（GET）或 body（POST）。
      for (const [key, value] of Object.entries(args)) {
        if (method === "GET" || method === "HEAD") {
          query.set(key, typeof value === "string" ? value : JSON.stringify(value));
        } else {
          (bodyObj ??= {})[key] = value;
        }
      }
    }

    let target = endpoint;
    const qs = query.toString();
    if (qs) {
      target += (endpoint.includes("?") ? "&" : "?") + qs;
    }
    const init: RequestInit = { method, signal: controller.signal, headers };
    if (bodyObj !== undefined) {
      init.headers = { ...headers, "Content-Type": "application/json" };
      init.body = JSON.stringify(bodyObj);
    }
    const response = await fetch(target, init);
    const text = await response.text();
    const latencyMs = Math.round(performance.now() - startedAt);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    return {
      ok: response.ok,
      kind: "api",
      status: response.status,
      latencyMs,
      preview: preview(text),
      detail: parsed,
      request: { method, url: target }
    };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startedAt);
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      kind: "api",
      latencyMs,
      error: message.includes("aborted") ? `请求超时（>${API_TIMEOUT_MS}ms）` : message
    };
  } finally {
    clearTimeout(timer);
  }
}

async function resolvePython(): Promise<string> {
  for (const candidate of ["python3", "python"]) {
    try {
      await execFileAsync(candidate, ["--version"], { windowsHide: true, timeout: 5000 });
      return candidate;
    } catch {
      // 继续尝试下一个候选
    }
  }
  throw new PlatformError(
    "未检测到 Python 解释器（python3 / python），代码插件暂无法在本地运行。",
    409
  );
}

/** 代码插件实跑：把用户函数丢进 Python 子进程，超时隔离 + 无 shell，返回 stdout。 */
export async function invokeCodePlugin(
  plugin: PluginRecord,
  args: Record<string, unknown>
): Promise<PluginInvokeResult> {
  const code = (plugin.config?.code as string | undefined)?.trim();
  if (!code) {
    throw new PlatformError("该代码插件尚未编写函数体，请先在编辑器里实现 run(args)。", 400);
  }
  const python = await resolvePython();
  const startedAt = performance.now();
  const dir = mkdtempSync(join(tmpdir(), "sl-plugin-"));
  const script = `${code}\n\nimport json, sys\nif __name__ == "__main__":\n    payload = sys.argv[1] if len(sys.argv) > 1 else "{}"\n    try:\n        result = run(json.loads(payload))\n    except Exception as exc:\n        print(json.dumps({"__error__": str(exc)}))\n        sys.exit(0)\n    print(json.dumps(result, default=str))\n`;
  const scriptPath = join(dir, "run.py");
  writeFileSync(scriptPath, script, "utf8");

  try {
    const { stdout } = await execFileAsync(
      python,
      [scriptPath, JSON.stringify(args)],
      { windowsHide: true, timeout: CODE_TIMEOUT_MS, maxBuffer: 1_000_000, cwd: dir }
    );
    const latencyMs = Math.round(performance.now() - startedAt);
    let detail: unknown;
    try {
      detail = JSON.parse(stdout);
    } catch {
      detail = undefined;
    }
    const failed = detail && typeof detail === "object" && "__error__" in (detail as object);
    return {
      ok: !failed,
      kind: "code",
      latencyMs,
      preview: preview(stdout),
      detail
    };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startedAt);
    const message = error instanceof Error ? error.message : String(error);
    const timedOut = message.includes("timeout") || message.includes("ETIMEDOUT");
    return {
      ok: false,
      kind: "code",
      latencyMs,
      error: timedOut ? `执行超时（>${CODE_TIMEOUT_MS}ms），已终止子进程。` : message
    };
  }
}

export function invokePlugin(
  plugin: PluginRecord,
  args: Record<string, unknown>
): Promise<PluginInvokeResult> {
  return plugin.type === "api" ? invokeApiPlugin(plugin, args) : invokeCodePlugin(plugin, args);
}
