import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { PlatformError, type McpCallResult, type McpServerConfig, type McpServerView, type McpServerWrite, type McpToolInfo, type ToolRecord } from "../types.js";
import type { PlatformStateStore } from "../runtime/stateStore.js";
import { McpClient, McpProtocolError, type McpClientConfig, type McpConnectionInfo } from "./client.js";
import { isWorkflowToolEndpoint } from "./workflowTools.js";

export type McpConnection = Pick<McpClient, "listTools" | "callTool" | "close">;

export type McpConnect = (
  config: McpClientConfig
) => Promise<{ client: McpConnection; info: McpConnectionInfo }>;

export type McpRefreshResult = {
  server: McpServerView;
  tools: McpToolInfo[];
  info: McpConnectionInfo;
  latencyMs: number;
};

export type McpManagerOptions = {
  connect?: McpConnect;
  timeoutMs?: number;
};

export const DEMO_MCP_SERVER: McpServerWrite = {
  id: "teaching-resources",
  name: "教学资源 MCP（本地示例）",
  transport: "stdio",
  command: "node",
  args: ["scripts/mcp-demo-server.mjs"],
  enabled: true
};

export const DATA_ANALYSIS_MCP_SERVER: McpServerWrite = {
  id: "data-analysis",
  name: "经营数据分析 MCP（本地示例）",
  transport: "stdio",
  command: "node",
  args: ["scripts/data-analysis-mcp.mjs"],
  enabled: true
};

const SERVER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const MAX_ARGS = 50;
const MAX_ENV_KEYS = 50;

/**
 * MCP 连接池与注册同步：负责配置校验、真实握手、工具发现、工具记录落库与调用计时。
 * 连接失败会写入 lastError，但不会影响其它服务器。
 */
export class McpManager {
  private readonly clients = new Map<string, Promise<{ client: McpConnection; info: McpConnectionInfo }>>();
  private readonly connect: McpConnect;
  private readonly timeoutMs: number;
  private workflowRunner?: (tool: ToolRecord, args: Record<string, unknown>) => Promise<McpCallResult>;
  /** 平台插件（builtin）执行器：由服务端注入，把 builtin:// 端点分发到本地服务实现。 */
  private builtinRunner?: (tool: ToolRecord, args: Record<string, unknown>) => Promise<McpCallResult>;

  constructor(private readonly store: PlatformStateStore, options: McpManagerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? (Number(process.env.PLATFORM_MCP_TIMEOUT_MS) || 20_000);
    this.connect =
      options.connect ??
      ((config) => McpClient.open(config, { timeoutMs: this.timeoutMs }));
  }

  list(): McpServerView[] {
    return this.store.listMcpServers().map((config) => this.toView(config));
  }

  view(id: string): McpServerView {
    return this.toView(this.requireServer(id));
  }

  async save(body: unknown): Promise<McpServerView> {
    const existing = isRecord(body) && typeof body.id === "string" ? this.store.getMcpServer(body.id) : undefined;
    const write = parseMcpServerWrite(body, existing);
    if (existing) {
      await this.dropClient(existing.id);
    }
    return this.toView(this.store.saveMcpServer(write, existing));
  }

  async remove(id: string): Promise<McpServerView | undefined> {
    const server = this.store.getMcpServer(id);
    if (!server) {
      return undefined;
    }
    await this.dropClient(id);
    this.store.deleteToolsWithEndpointPrefix(endpointPrefix(id));
    this.store.deleteMcpServer(id);
    return this.toView(server);
  }

  async refresh(id: string): Promise<McpRefreshResult> {
    const server = this.requireServer(id);
    await this.dropClient(id);
    const startedAt = performance.now();
    try {
      const { client, info } = await this.openClient(server);
      const tools = await client.listTools();
      const latencyMs = elapsedMs(startedAt);
      this.syncTools(server, tools);
      this.store.markMcpServerStatus(server.id, {
        connectedAt: new Date().toISOString(),
        info,
        latencyMs
      });
      return {
        server: this.toView(this.store.getMcpServer(server.id) ?? server),
        tools,
        info,
        latencyMs
      };
    } catch (error) {
      await this.dropClient(id);
      const message = describe(error);
      this.store.markMcpServerStatus(id, { error: message });
      throw toConnectionError(server, message);
    }
  }

  async call(serverId: string, toolName: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const server = this.requireServer(serverId);
    if (!server.enabled) {
      throw new PlatformError(`MCP 服务器「${server.name}」已停用。`, 400);
    }
    const name = toolName.trim();
    if (!name) {
      throw new PlatformError("缺少 MCP 工具名。", 400);
    }

    const startedAt = performance.now();
    try {
      const { client } = await this.openClient(server);
      const result = await client.callTool(name, args);
      const latencyMs = elapsedMs(startedAt);
      return {
        serverId: server.id,
        serverName: server.name,
        tool: name,
        latencyMs,
        isError: result.isError,
        content: result.content,
        text: flattenContent(result.content),
        structuredContent: result.structuredContent
      };
    } catch (error) {
      if (!(error instanceof McpProtocolError)) {
        throw error;
      }
      // 进程崩溃或连接被回收时重连一次，覆盖常见的服务器重启场景。
      await this.dropClient(serverId);
      try {
        const { client } = await this.openClient(server);
        const result = await client.callTool(name, args);
        return {
          serverId: server.id,
          serverName: server.name,
          tool: name,
          latencyMs: elapsedMs(startedAt),
          isError: result.isError,
          content: result.content,
          text: flattenContent(result.content),
          structuredContent: result.structuredContent
        };
      } catch (retryError) {
        const message = describe(retryError);
        this.store.markMcpServerStatus(serverId, { error: message });
        throw toConnectionError(server, message);
      }
    }
  }

  /** 工作流工具由平台执行器内联运行，不走外部 MCP 连接池。 */
  setWorkflowRunner(
    runner: (tool: ToolRecord, args: Record<string, unknown>) => Promise<McpCallResult>
  ) {
    this.workflowRunner = runner;
  }

  /** 平台插件（builtin）同样由服务端内联执行：端点形如 builtin://knowledge/search。 */
  setBuiltinRunner(
    runner: (tool: ToolRecord, args: Record<string, unknown>) => Promise<McpCallResult>
  ) {
    this.builtinRunner = runner;
  }

  callToolRecord(tool: ToolRecord, args: Record<string, unknown>): Promise<McpCallResult> {
    if (isWorkflowToolEndpoint(tool.endpoint)) {
      if (!this.workflowRunner) {
        throw new PlatformError("工作流工具执行器尚未接入，无法执行该工具。", 500);
      }
      return this.workflowRunner(tool, args);
    }
    if (tool.type === "builtin" || (tool.endpoint ?? "").startsWith("builtin://")) {
      if (!this.builtinRunner) {
        throw new PlatformError("平台插件执行器尚未接入，无法执行该工具。", 500);
      }
      return this.builtinRunner(tool, args);
    }
    const reference = parseMcpEndpoint(tool.endpoint);
    if (!reference) {
      throw new PlatformError(
        `工具「${tool.id}」缺少可用的 MCP 端点，请在 MCP 连接页重新发现工具。`,
        400
      );
    }
    return this.call(reference.serverId, reference.toolName, args);
  }

  async closeAll() {
    const handles = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(
      handles.map(async (handle) => {
        try {
          const { client } = await handle;
          await client.close();
        } catch {
          // 连接本来就失败时无需再处理。
        }
      })
    );
  }

  private async openClient(server: McpServerConfig) {
    const cached = this.clients.get(server.id);
    if (cached) {
      return cached;
    }
    const handle = this.connect({
      transport: server.transport,
      command: server.command,
      args: server.args,
      env: server.env,
      url: server.url
    });
    this.clients.set(server.id, handle);
    try {
      return await handle;
    } catch (error) {
      this.clients.delete(server.id);
      throw error;
    }
  }

  private async dropClient(id: string) {
    const handle = this.clients.get(id);
    this.clients.delete(id);
    if (!handle) {
      return;
    }
    try {
      const { client } = await handle;
      await client.close();
    } catch {
      // 忽略关闭失败，连接已经不可用。
    }
  }

  private syncTools(server: McpServerConfig, tools: McpToolInfo[]) {
    const prefix = endpointPrefix(server.id);
    const all = this.store.listTools();
    const existing = all.filter((tool) => tool.type === "mcp" && (tool.endpoint ?? "").startsWith(prefix));
    // 取全库 id 去重：别人的连接也可能同步出同名函数，撞主键会互相覆盖。
    const taken = new Set(
      this.store.listAllToolIds().filter((id) => !existing.some((item) => item.id === id))
    );
    const keep = new Set<string>();
    // 同步出来的工具跟着服务器走：示例连接（无主）的工具全员可用，自己连的只有自己能用。
    const ownerId = server.ownerId ?? null;

    for (const tool of tools) {
      const id = uniqueToolId(server.id, tool.name, taken);
      taken.add(id);
      keep.add(id);
      this.store.saveTool(
        {
          id,
          name: `${server.name} · ${tool.title || tool.name}`,
          type: "mcp",
          schema: tool.inputSchema,
          endpoint: `${prefix}${encodeURIComponent(tool.name)}`,
          description: tool.description || `由 MCP 服务器「${server.name}」提供的工具。`,
          enabled: server.enabled
        },
        ownerId
      );
    }

    for (const tool of existing) {
      if (!keep.has(tool.id)) {
        this.store.deleteTool(tool.id);
      }
    }
  }

  private requireServer(id: string) {
    const server = this.store.getMcpServer(id);
    if (!server) {
      throw new PlatformError("MCP 服务器不存在。", 404);
    }
    return server;
  }

  private toView(config: McpServerConfig): McpServerView {
    const prefix = endpointPrefix(config.id);
    const toolCount = this.store
      .listTools()
      .filter((tool) => tool.type === "mcp" && (tool.endpoint ?? "").startsWith(prefix)).length;
    const { env: _env, ownerId: _ownerId, ...rest } = config;
    return {
      ...rest,
      envKeys: Object.keys(config.env).sort(),
      toolCount,
      source: config.ownerId ? "custom" : "builtin"
    };
  }
}

export function parseMcpServerWrite(body: unknown, existing?: McpServerConfig): McpServerWrite {
  if (!isRecord(body)) {
    throw new PlatformError("请求体必须是 JSON 对象。", 400);
  }
  const id = requireText(body.id, "id").toLowerCase();
  if (!SERVER_ID_PATTERN.test(id)) {
    throw new PlatformError("服务器 id 只允许字母、数字、点、下划线和短横线，且以字母或数字开头。", 400);
  }
  const transport = body.transport;
  if (transport !== "stdio" && transport !== "http") {
    throw new PlatformError("transport 必须是 stdio 或 http。", 400);
  }
  const command = optionalText(body.command);
  const url = optionalText(body.url);
  if (transport === "stdio" && !command) {
    throw new PlatformError("stdio 传输需要填写启动命令，例如 node。", 400);
  }
  if (transport === "http") {
    if (!/^https?:\/\//i.test(url)) {
      throw new PlatformError("http 传输需要填写 http/https 地址。", 400);
    }
  }
  const args =
    body.args === undefined
      ? (existing?.args ?? [])
      : Array.isArray(body.args)
        ? body.args.map((item, index) => requireText(item, `args[${index}]`))
        : (() => {
            throw new PlatformError("args 必须是字符串数组。", 400);
          })();
  if (args.length > MAX_ARGS) {
    throw new PlatformError(`args 最多 ${MAX_ARGS} 项。`, 400);
  }

  let env: Record<string, string> | undefined;
  if (body.env !== undefined) {
    if (!isRecord(body.env)) {
      throw new PlatformError("env 必须是键值对象。", 400);
    }
    const entries = Object.entries(body.env);
    if (entries.length > MAX_ENV_KEYS) {
      throw new PlatformError(`env 最多 ${MAX_ENV_KEYS} 项。`, 400);
    }
    env = {};
    for (const [key, value] of entries) {
      const name = key.trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new PlatformError(`环境变量名不合法：${name || "(空)"}。`, 400);
      }
      if (typeof value !== "string") {
        throw new PlatformError(`环境变量 ${name} 的值必须是字符串。`, 400);
      }
      env[name] = value;
    }
  }

  return {
    id,
    name: requireText(body.name, "name"),
    transport,
    command: transport === "stdio" ? command : undefined,
    args: transport === "stdio" ? args : [],
    env,
    url: transport === "http" ? url : undefined,
    enabled: typeof body.enabled === "boolean" ? body.enabled : (existing?.enabled ?? true)
  };
}

export function parseMcpEndpoint(endpoint: string | undefined) {
  if (!endpoint || !endpoint.startsWith("mcp://")) {
    return undefined;
  }
  const rest = endpoint.slice("mcp://".length);
  const separator = rest.indexOf("/");
  if (separator <= 0 || separator === rest.length - 1) {
    return undefined;
  }
  const serverId = rest.slice(0, separator);
  const rawTool = rest.slice(separator + 1);
  let toolName = rawTool;
  try {
    toolName = decodeURIComponent(rawTool);
  } catch {
    // 保留原始值，交给服务器判断。
  }
  return { serverId, toolName };
}

export function uniqueToolId(serverId: string, toolName: string, taken: Set<string>) {
  const base = `mcp.${sanitizeSegment(serverId)}.${sanitizeSegment(toolName)}`;
  if (!taken.has(base)) {
    return base;
  }
  const digest = createHash("sha1").update(toolName).digest("hex").slice(0, 6);
  let candidate = `${base}-${digest}`;
  let index = 2;
  while (taken.has(candidate)) {
    candidate = `${base}-${digest}-${index}`;
    index += 1;
  }
  return candidate;
}

function elapsedMs(startedAt: number) {
  return Math.round((performance.now() - startedAt) * 10) / 10;
}

function endpointPrefix(serverId: string) {
  return `mcp://${serverId}/`;
}

function sanitizeSegment(value: string) {
  const sanitized = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^[^a-zA-Z0-9]+/, "")
    .replace(/_+$/, "");
  return sanitized.slice(0, 48) || "tool";
}

function flattenContent(content: unknown[]) {
  return content
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      if (!isRecord(item)) {
        return "";
      }
      if (item.type === "text") {
        return stringValue(item.text);
      }
      if (item.type === "resource") {
        const resource = isRecord(item.resource) ? item.resource : {};
        return stringValue(resource.text) || stringValue(resource.uri) || "[resource]";
      }
      if (item.type === "resource_link") {
        return `${stringValue(item.name) || "资源"}：${stringValue(item.uri)}`;
      }
      if (item.type === "image" || item.type === "audio") {
        return `[${item.type}: ${stringValue(item.mimeType) || "binary"}]`;
      }
      return truncate(JSON.stringify(item), 2000);
    })
    .filter(Boolean)
    .join("\n");
}

function toConnectionError(server: McpServerConfig, message: string) {
  return new PlatformError(
    `连接 MCP 服务器「${server.name}」失败：${message}`,
    502
  );
}

function requireText(value: unknown, field: string) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PlatformError(`缺少必填字段：${field}。`, 400);
  }
  return value.trim();
}

function optionalText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function truncate(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
