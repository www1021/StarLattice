import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Interface } from "node:readline";
import { createInterface } from "node:readline";
import type { McpToolInfo, McpTransport } from "../types.js";

const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TIMEOUT_MS = 20_000;
const CLIENT_INFO = { name: "starlattice-platform", version: "1.0.0" };

export type McpClientConfig = {
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  cwd?: string;
};

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
};

type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

export class McpProtocolError extends Error {
  readonly code?: number;
  readonly detail?: unknown;

  constructor(message: string, code?: number, detail?: unknown) {
    super(message);
    this.name = "McpProtocolError";
    this.code = code;
    this.detail = detail;
  }
}

export type McpConnectionInfo = {
  protocolVersion: string;
  serverName: string;
  serverVersion: string;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

/**
 * 最小但完整的 MCP 客户端：JSON-RPC 2.0 握手、工具发现与调用。
 * stdio 使用换行分隔消息；HTTP 使用 Streamable HTTP（JSON 或 SSE 响应）。
 */
export class McpClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private child?: ChildProcessWithoutNullStreams;
  private stdoutReader?: Interface;
  private stderrTail = "";
  private sessionId?: string;
  private closed = false;
  private info?: McpConnectionInfo;
  private readonly timeoutMs: number;
  private readonly config: McpClientConfig;

  constructor(config: McpClientConfig, options: { timeoutMs?: number } = {}) {
    this.config = config;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  static async open(
    config: McpClientConfig,
    options: { timeoutMs?: number } = {}
  ): Promise<{ client: McpClient; info: McpConnectionInfo }> {
    const client = new McpClient(config, options);
    const info = await client.initialize();
    return { client, info };
  }

  get connectionInfo() {
    return this.info;
  }

  async initialize(): Promise<McpConnectionInfo> {
    if (this.config.transport === "stdio") {
      this.startStdio();
    } else {
      this.assertHttpConfig();
    }

    const result = asRecord(
      await this.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO
      })
    );
    const serverInfo = asRecord(result.serverInfo);
    this.info = {
      protocolVersion: stringValue(result.protocolVersion) || PROTOCOL_VERSION,
      serverName: stringValue(serverInfo.name) || "mcp-server",
      serverVersion: stringValue(serverInfo.version) || "unknown"
    };
    await this.notify("notifications/initialized");
    return this.info;
  }

  async listTools(): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    // 分页保护：正常 MCP 服务器不会超过 20 页，避免异常服务端导致死循环。
    for (let page = 0; page < 20; page += 1) {
      const result = asRecord(
        await this.request("tools/list", cursor === undefined ? {} : { cursor })
      );
      const items = Array.isArray(result.tools) ? result.tools : [];
      for (const item of items) {
        const record = asRecord(item);
        const name = stringValue(record.name).trim();
        if (!name) {
          continue;
        }
        tools.push({
          name,
          title: stringValue(record.title) || undefined,
          description: stringValue(record.description) || undefined,
          inputSchema: asRecord(record.inputSchema) ?? { type: "object" }
        });
      }
      cursor = stringValue(result.nextCursor) || undefined;
      if (!cursor) {
        break;
      }
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>) {
    const result = asRecord(await this.request("tools/call", { name, arguments: args }));
    return {
      content: Array.isArray(result.content) ? result.content : [],
      structuredContent: result.structuredContent,
      isError: result.isError === true
    };
  }

  async close() {
    this.closed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("MCP 连接已关闭。"));
      this.pending.delete(id);
    }
    this.stdoutReader?.close();
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
  }

  private startStdio() {
    const command = this.config.command?.trim();
    if (!command) {
      throw new McpProtocolError("stdio 传输缺少启动命令。");
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, this.config.args ?? [], {
        cwd: this.config.cwd,
        env: { ...process.env, ...(this.config.env ?? {}) },
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      throw new McpProtocolError(`无法启动 MCP 进程：${describe(error)}`);
    }
    this.child = child;

    this.stdoutReader = createInterface({ input: child.stdout });
    this.stdoutReader.on("line", (line) => this.handleLine(line));

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-2000);
    });

    child.on("error", (error) => {
      this.failAll(new McpProtocolError(`MCP 进程错误：${error.message}`));
    });
    child.on("exit", (code, signal) => {
      const reason = this.stderrTail.trim();
      this.failAll(
        new McpProtocolError(
          `MCP 进程已退出（code=${code ?? "null"}${signal ? `, signal=${signal}` : ""}）${reason ? `：${reason}` : "。"}`
        )
      );
    });
  }

  private handleLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(trimmed) as JsonRpcResponse;
    } catch {
      return;
    }
    if (typeof message.id !== "number") {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(toProtocolError(message.error));
      return;
    }
    pending.resolve(message.result);
  }

  private async request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) {
      throw new McpProtocolError("MCP 连接已关闭。");
    }
    const id = this.nextId++;
    const message: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

    if (this.config.transport === "http") {
      const response = await this.postHttp(message);
      if (response.error) {
        throw toProtocolError(response.error);
      }
      return response.result;
    }

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpProtocolError(`MCP 请求超时：${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child?.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new McpProtocolError(`向 MCP 进程写入失败：${describe(error)}`));
      }
    });
  }

  private async notify(method: string, params?: unknown) {
    const message: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    if (this.config.transport === "stdio") {
      this.child?.stdin.write(`${JSON.stringify(message)}\n`);
      return;
    }
    await this.postHttp(message);
  }

  private async postHttp(message: JsonRpcRequest | JsonRpcNotification): Promise<JsonRpcResponse> {
    this.assertHttpConfig();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.config.url!, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {})
        },
        body: JSON.stringify(message),
        signal: controller.signal
      });
      const sessionId = response.headers.get("mcp-session-id");
      if (sessionId) {
        this.sessionId = sessionId;
      }
      if (!response.ok) {
        throw new McpProtocolError(`MCP HTTP 请求失败（${response.status}）。`);
      }
      if (!("id" in message)) {
        return { jsonrpc: "2.0" };
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) {
        return await readSseResponse(response, message.id);
      }
      const body = await response.text();
      if (!body.trim()) {
        throw new McpProtocolError("MCP HTTP 返回空响应。");
      }
      return JSON.parse(body) as JsonRpcResponse;
    } catch (error) {
      if (error instanceof McpProtocolError) {
        throw error;
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new McpProtocolError("MCP HTTP 请求超时。");
      }
      throw new McpProtocolError(`MCP HTTP 请求失败：${describe(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private assertHttpConfig() {
    const url = this.config.url?.trim();
    if (!url || !/^https?:\/\//i.test(url)) {
      throw new McpProtocolError("http 传输需要合法的服务器地址（http/https）。");
    }
  }

  private failAll(error: Error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

async function readSseResponse(response: Response, id: number): Promise<JsonRpcResponse> {
  const body = response.body;
  if (!body) {
    throw new McpProtocolError("MCP SSE 响应缺少消息体。");
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (data) {
            try {
              const message = JSON.parse(data) as JsonRpcResponse;
              if (message.id === id) {
                return message;
              }
            } catch {
              // 忽略非 JSON 的 SSE 心跳/注释。
            }
          }
        }
        newline = buffer.indexOf("\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  throw new McpProtocolError("MCP SSE 流已结束但未收到对应响应。");
}

function toProtocolError(error: JsonRpcResponse["error"]) {
  return new McpProtocolError(
    error?.message || "MCP 服务器返回未知错误。",
    error?.code,
    error?.data
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
