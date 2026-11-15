import { useEffect, useMemo, useState } from "react";
import { accountSessionStorage } from "../auth/accountStorage";
import {
  Boxes,
  Cable,
  CheckCircle2,
  Clock3,
  Globe2,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Server,
  Terminal,
  Trash2,
  Wrench,
  XCircle
} from "lucide-react";
import { platformApi } from "./api";
import type {
  McpCallResult,
  McpRefreshResponse,
  McpServerView,
  McpServerWrite,
  McpTransport,
  ToolRecord
} from "./types";
import "./platform.css";

type Banner = {
  tone: "info" | "success" | "error";
  text: string;
};

type ServerForm = {
  id: string;
  name: string;
  transport: McpTransport;
  command: string;
  argsText: string;
  url: string;
  envText: string;
  enabled: boolean;
};

const EMPTY_FORM: ServerForm = {
  id: "my-mcp-server",
  name: "我的 MCP 服务器",
  transport: "stdio",
  command: "node",
  argsText: "",
  url: "",
  envText: "",
  enabled: true
};

const PENDING_NODE_KEY = "platform:pending-node";

export function McpPage({ onOpenCanvas }: { onOpenCanvas?: () => void }) {
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [tools, setTools] = useState<ToolRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<Banner>();
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [form, setForm] = useState<ServerForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [refreshingId, setRefreshingId] = useState<string>();
  const [deletingId, setDeletingId] = useState<string>();
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [refreshInfo, setRefreshInfo] = useState<Record<string, McpRefreshResponse>>({});
  const [testTool, setTestTool] = useState<ToolRecord>();
  const [testArgs, setTestArgs] = useState("{}");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<McpCallResult>();

  async function load(selectId?: string) {
    try {
      const [serverResponse, toolResponse] = await Promise.all([
        platformApi.mcpServers(),
        platformApi.listTools()
      ]);
      setServers(serverResponse.servers);
      setTools(toolResponse.tools.filter((tool) => tool.type === "mcp"));
      setSelectedId((current) => {
        const next = selectId ?? current;
        if (next && serverResponse.servers.some((server) => server.id === next)) {
          return next;
        }
        return serverResponse.servers[0]?.id;
      });
    } catch (error) {
      setBanner({ tone: "error", text: describe(error) });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const selected = useMemo(
    () => servers.find((server) => server.id === selectedId),
    [servers, selectedId]
  );

  const serverTools = useMemo(
    () =>
      selected
        ? tools.filter((tool) => (tool.endpoint ?? "").startsWith(`mcp://${selected.id}/`))
        : [],
    [tools, selected]
  );

  const managedTools = useMemo(
    () =>
      tools.filter((tool) =>
        servers.some((server) => (tool.endpoint ?? "").startsWith(`mcp://${server.id}/`))
      ),
    [tools, servers]
  );

  const connectedCount = servers.filter(
    (server) => server.lastConnectedAt && !server.lastError
  ).length;

  useEffect(() => {
    setDeleteConfirm(false);
    setTestTool(undefined);
    setTestResult(undefined);
  }, [selectedId]);

  function openCreate() {
    setEditingId(undefined);
    setForm({ ...EMPTY_FORM, id: suggestId(servers) });
    setFormOpen(true);
  }

  function openEdit(server: McpServerView) {
    setEditingId(server.id);
    setForm({
      id: server.id,
      name: server.name,
      transport: server.transport,
      command: server.command ?? "",
      argsText: server.args.join("\n"),
      url: server.url ?? "",
      envText: "",
      enabled: server.enabled
    });
    setFormOpen(true);
  }

  async function submit() {
    if (saving) {
      return;
    }
    const env = parseEnv(form.envText);
    if (typeof env === "string") {
      setBanner({ tone: "error", text: env });
      return;
    }
    const write: McpServerWrite = {
      id: form.id.trim(),
      name: form.name.trim(),
      transport: form.transport,
      enabled: form.enabled,
      ...(form.transport === "stdio"
        ? {
            command: form.command.trim(),
            args: form.argsText
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean)
          }
        : { url: form.url.trim() }),
      ...(env ? { env } : {})
    };
    if (write.transport === "stdio" && !write.command) {
      setBanner({ tone: "error", text: "stdio 连接需要填写启动命令。" });
      return;
    }
    if (write.transport === "http" && !/^https?:\/\//i.test(write.url ?? "")) {
      setBanner({ tone: "error", text: "HTTP 连接需要填写 http/https 地址。" });
      return;
    }

    setSaving(true);
    try {
      const saved = await platformApi.saveMcpServer(write);
      setFormOpen(false);
      setEditingId(undefined);
      await load(saved.server.id);
      await refresh(saved.server.id);
    } catch (error) {
      setBanner({ tone: "error", text: describe(error) });
    } finally {
      setSaving(false);
    }
  }

  async function refresh(id: string) {
    if (refreshingId) {
      return;
    }
    setRefreshingId(id);
    try {
      const response = await platformApi.refreshMcpServer(id);
      setRefreshInfo((current) => ({ ...current, [id]: response }));
      setServers((current) =>
        current.map((server) => (server.id === id ? response.server : server))
      );
      const toolResponse = await platformApi.listTools();
      setTools(toolResponse.tools.filter((tool) => tool.type === "mcp"));
      setBanner({
        tone: "success",
        text: `已连接「${response.server.name}」：${response.info.serverName} v${response.info.serverVersion} · 协议 ${response.info.protocolVersion} · 发现 ${response.tools.length} 个工具 · 握手 ${formatMs(response.latencyMs)}`
      });
    } catch (error) {
      setBanner({ tone: "error", text: describe(error) });
      await load(id);
    } finally {
      setRefreshingId(undefined);
    }
  }

  async function remove(id: string) {
    if (deletingId) {
      return;
    }
    setDeletingId(id);
    try {
      await platformApi.deleteMcpServer(id);
      setBanner({ tone: "success", text: "MCP 连接已删除，相关工具记录已同步清理。" });
      setDeleteConfirm(false);
      setRefreshInfo((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setSelectedId(undefined);
      await load();
    } catch (error) {
      setBanner({ tone: "error", text: describe(error) });
    } finally {
      setDeletingId(undefined);
    }
  }

  function startTest(tool: ToolRecord) {
    setTestTool(tool);
    setTestResult(undefined);
    setTestArgs(JSON.stringify(exampleArgs(tool), null, 2));
  }

  function addToCanvas(tool: ToolRecord) {
    try {
      accountSessionStorage.setItem(
        PENDING_NODE_KEY,
        JSON.stringify({
          title: displayNameOf(tool),
          tool: toolNameOf(tool),
          args: exampleArgs(tool)
        })
      );
    } catch (error) {
      setBanner({ tone: "error", text: `无法写入画布数据：${describe(error)}` });
      return;
    }
    if (onOpenCanvas) {
      onOpenCanvas();
      return;
    }
    setBanner({
      tone: "success",
      text: `已暂存工具「${displayNameOf(tool)}」，打开编排画布后会自动加入流程。`
    });
  }

  async function runTest() {
    if (!selected || !testTool || testing) {
      return;
    }
    let args: Record<string, unknown>;
    try {
      const parsed = JSON.parse(testArgs || "{}") as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("参数必须是 JSON 对象。");
      }
      args = parsed as Record<string, unknown>;
    } catch (error) {
      setBanner({ tone: "error", text: `参数解析失败：${describe(error)}` });
      return;
    }
    setTesting(true);
    setTestResult(undefined);
    try {
      const response = await platformApi.callMcpTool(selected.id, toolNameOf(testTool), args);
      setTestResult(response.result);
      setBanner({
        tone: response.result.isError ? "error" : "success",
        text: `${response.result.serverName} · ${response.result.tool} 调用${response.result.isError ? "返回工具错误" : "成功"}，耗时 ${formatMs(response.result.latencyMs)}`
      });
    } catch (error) {
      setBanner({ tone: "error", text: describe(error) });
    } finally {
      setTesting(false);
    }
  }

  if (loading) {
    return (
      <div className="platform-page">
        <div className="platform-loading">
          <Loader2 size={18} className="is-spinning" />
          正在加载 MCP 连接…
        </div>
      </div>
    );
  }

  const info = selected ? refreshInfo[selected.id] : undefined;

  return (
    <div className="platform-page mcp-page">
      <header className="platform-head">
        <div className="platform-head-main">
          <span className="platform-eyebrow">MCP 接入</span>
          <h1>
            真实工具连接
            <span className="platform-version">
              {connectedCount}/{servers.length} 已连接 · {managedTools.length} 个工具
            </span>
          </h1>
          <p>
            通过 stdio 或 Streamable HTTP 连接 MCP 服务器，自动发现工具并同步到注册中心；工作流工具节点调用后，
            产物会记录 server、tool 与调用耗时。
          </p>
        </div>
        <div className="platform-head-actions">
          <button type="button" className="platform-button is-ghost" onClick={() => void load(selectedId)}>
            <RefreshCw size={14} />
            刷新
          </button>
          <button type="button" className="platform-button is-primary" onClick={openCreate}>
            <Plus size={14} />
            新建连接
          </button>
        </div>
      </header>

      {banner && (
        <div className={`platform-banner is-${banner.tone}`}>
          <div className="platform-banner-line">
            {banner.tone === "error" ? <XCircle size={15} /> : <CheckCircle2 size={15} />}
            <span>{banner.text}</span>
          </div>
        </div>
      )}

      {formOpen && (
        <section className="mcp-form">
          <header>
            <div>
              <strong>{editingId ? "编辑 MCP 连接" : "新建 MCP 连接"}</strong>
              <small>
                密钥只保存在服务端；列表仅展示变量名。留空环境变量表示保留原值。
              </small>
            </div>
          </header>

          <div className="mcp-form-grid">
            <label>
              服务器 ID
              <input
                value={form.id}
                disabled={editingId !== undefined}
                placeholder="teaching-resources"
                onChange={(event) => setForm({ ...form, id: event.target.value })}
              />
            </label>
            <label>
              显示名称
              <input
                value={form.name}
                placeholder="示例 MCP"
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </label>
            <label>
              传输方式
              <select
                value={form.transport}
                onChange={(event) =>
                  setForm({ ...form, transport: event.target.value as McpTransport })
                }
              >
                <option value="stdio">stdio（本地进程）</option>
                <option value="http">HTTP（Streamable HTTP）</option>
              </select>
            </label>
            <label className="is-switch">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
              />
              启用连接
            </label>

            {form.transport === "stdio" ? (
              <>
                <label>
                  启动命令
                  <input
                    value={form.command}
                    placeholder="node"
                    onChange={(event) => setForm({ ...form, command: event.target.value })}
                  />
                </label>
                <label className="is-wide">
                  启动参数（每行一个）
                  <textarea
                    value={form.argsText}
                    rows={3}
                    placeholder={"scripts/mcp-demo-server.mjs"}
                    onChange={(event) => setForm({ ...form, argsText: event.target.value })}
                  />
                </label>
              </>
            ) : (
              <label className="is-wide">
                服务器地址
                <input
                  value={form.url}
                  placeholder="https://mcp.example.edu/mcp"
                  onChange={(event) => setForm({ ...form, url: event.target.value })}
                />
              </label>
            )}

            <label className="is-wide">
              环境变量（KEY=value，每行一个）
              <textarea
                value={form.envText}
                rows={2}
                placeholder={"MCP_TOKEN=******"}
                onChange={(event) => setForm({ ...form, envText: event.target.value })}
              />
            </label>
          </div>

          <footer>
            <button
              type="button"
              className="platform-button is-ghost"
              onClick={() => {
                setFormOpen(false);
                setEditingId(undefined);
              }}
            >
              取消
            </button>
            <button
              type="button"
              className="platform-button is-primary"
              disabled={saving || !form.id.trim() || !form.name.trim()}
              onClick={() => void submit()}
            >
              {saving ? <Loader2 size={14} className="is-spinning" /> : <Cable size={14} />}
              {saving ? "保存并连接…" : "保存并连接"}
            </button>
          </footer>
        </section>
      )}

      <div className="mcp-layout">
        <aside className="mcp-list">
          <header className="mcp-list-head">
            <span>MCP 服务器</span>
            <small>{servers.length} 个连接</small>
          </header>
          {servers.length === 0 ? (
            <div className="mcp-empty">
              还没有 MCP 连接。点右上角「新建连接」，填写 stdio 命令或 HTTP 地址。
            </div>
          ) : (
            servers.map((server) => (
              <button
                key={server.id}
                type="button"
                className={`mcp-card ${server.id === selectedId ? "is-active" : ""}`}
                onClick={() => setSelectedId(server.id)}
              >
                <div className="mcp-card-head">
                  <span
                    className={`mcp-server-tile ${server.transport === "stdio" ? "is-stdio" : "is-http"}`}
                  >
                    {server.transport === "stdio" ? <Terminal size={16} /> : <Globe2 size={16} />}
                  </span>
                  <div className="mcp-card-title">
                    <strong>{server.name}</strong>
                    <small>
                      <code>{server.id}</code>
                    </small>
                  </div>
                  <span className={`mcp-status ${statusClass(server)}`} />
                </div>
                <div className="mcp-card-meta">
                  <span className={`mcp-badge is-transport`}>{transportLabel(server.transport)}</span>
                  <span className={`mcp-badge ${statusClass(server)}`}>{statusLabel(server)}</span>
                  <span className="mcp-badge is-owner">
                    {server.source === "custom" ? "我的" : "内置"}
                  </span>
                  <span>{server.toolCount} 工具</span>
                  {server.lastLatencyMs !== undefined && <span>{formatMs(server.lastLatencyMs)}</span>}
                </div>
                {server.lastError && <small className="mcp-card-error">{truncate(server.lastError, 72)}</small>}
              </button>
            ))
          )}
        </aside>

        <section className="mcp-detail">
          {selected ? (
            <>
              <header className="mcp-detail-head">
                <div className="mcp-detail-identity">
                  <span
                    className={`mcp-server-tile is-large ${selected.transport === "stdio" ? "is-stdio" : "is-http"}`}
                  >
                    {selected.transport === "stdio" ? <Terminal size={19} /> : <Globe2 size={19} />}
                  </span>
                  <div>
                    <div className="mcp-detail-title">
                      <h2>{selected.name}</h2>
                      <span className={`mcp-badge is-transport`}>{transportLabel(selected.transport)}</span>
                      <span className={`mcp-badge ${statusClass(selected)}`}>{statusLabel(selected)}</span>
                    </div>
                    <small>
                      <code>{selected.id}</code> ·{" "}
                      {selected.transport === "stdio" ? "stdio 本地进程" : "Streamable HTTP 远程服务"} ·{" "}
                      {selected.toolCount} 个工具
                    </small>
                  </div>
                </div>
                <div className="mcp-detail-actions">
                  <button
                    type="button"
                    className="platform-button is-ghost"
                    disabled={refreshingId !== undefined}
                    onClick={() => void refresh(selected.id)}
                  >
                    {refreshingId === selected.id ? (
                      <Loader2 size={14} className="is-spinning" />
                    ) : (
                      <RefreshCw size={14} />
                    )}
                    {refreshingId === selected.id ? "连接中…" : "连接并发现"}
                  </button>
                  <button type="button" className="platform-button is-ghost" onClick={() => openEdit(selected)}>
                    <Wrench size={14} />
                    编辑
                  </button>
                  {deleteConfirm ? (
                    <>
                      <button
                        type="button"
                        className="platform-button is-ghost"
                        disabled={deletingId !== undefined}
                        onClick={() => void remove(selected.id)}
                      >
                        {deletingId ? <Loader2 size={14} className="is-spinning" /> : <Trash2 size={14} />}
                        确认删除
                      </button>
                      <button type="button" className="platform-button is-ghost" onClick={() => setDeleteConfirm(false)}>
                        取消
                      </button>
                    </>
                  ) : (
                    <button type="button" className="platform-button is-ghost" onClick={() => setDeleteConfirm(true)}>
                      <Trash2 size={14} />
                      删除
                    </button>
                  )}
                </div>
              </header>

              <div className="mcp-meta-strip">
                <span>
                  <Server size={13} />
                  服务端 {info?.info.serverName ?? selected.serverName ?? "未握手"}
                  {(info?.info.serverVersion ?? selected.serverVersion)
                    ? ` v${info?.info.serverVersion ?? selected.serverVersion}`
                    : ""}
                </span>
                <span>
                  <Cable size={13} />
                  协议 {info?.info.protocolVersion ?? selected.protocolVersion ?? "—"}
                </span>
                <span>
                  <Clock3 size={13} />
                  握手耗时{" "}
                  {info
                    ? formatMs(info.latencyMs)
                    : selected.lastLatencyMs !== undefined
                      ? formatMs(selected.lastLatencyMs)
                      : "—"}
                </span>
                <span>
                  <Wrench size={13} />
                  {serverTools.length} 个工具
                </span>
              </div>

              {selected.lastError && (
                <div className="mcp-error-box">
                  <XCircle size={15} />
                  <span>{selected.lastError}</span>
                </div>
              )}

              <section className="mcp-section">
                <header>
                  <h3>
                    <Wrench size={15} />
                    已发现工具
                    <span>{serverTools.length}</span>
                  </h3>
                  <span className="mcp-note">工具已同步到注册中心，可直接加入编排画布。</span>
                </header>

                {serverTools.length === 0 ? (
                  <div className="mcp-empty">
                    还没有工具记录。点击「连接并发现」完成 MCP 握手后会自动同步 tools/list 结果。
                  </div>
                ) : (
                  <div className="mcp-tool-list">
                    {serverTools.map((tool) => (
                      <article className="mcp-tool" key={tool.id}>
                        <span className="mcp-tool-icon">
                          <Wrench size={15} />
                        </span>
                        <div className="mcp-tool-body">
                          <strong>{displayNameOf(tool)}</strong>
                          <small>
                            <code>{toolNameOf(tool)}</code>
                          </small>
                          {tool.description && <p>{tool.description}</p>}
                          <ToolSchema tool={tool} />
                        </div>
                        <div className="mcp-tool-actions">
                          <button
                            type="button"
                            className="platform-button is-ghost"
                            onClick={() => addToCanvas(tool)}
                          >
                            <Boxes size={13} />
                            加入画布
                          </button>
                          <button
                            type="button"
                            className="platform-button is-ghost"
                            onClick={() => startTest(tool)}
                          >
                            <Play size={13} />
                            测试调用
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>

              {testTool && (
                <section className="mcp-section mcp-test">
                  <header>
                    <h3>
                      <Play size={15} />
                      测试调用
                      <span>{toolNameOf(testTool)}</span>
                    </h3>
                    <button type="button" className="platform-button is-ghost" onClick={() => setTestTool(undefined)}>
                      关闭
                    </button>
                  </header>
                  <textarea
                    value={testArgs}
                    rows={6}
                    spellCheck={false}
                    onChange={(event) => setTestArgs(event.target.value)}
                  />
                  <div className="mcp-test-actions">
                    <small>参数按工具的 inputSchema 传入，结果会展示真实耗时。</small>
                    <button
                      type="button"
                      className="platform-button is-primary"
                      disabled={testing}
                      onClick={() => void runTest()}
                    >
                      {testing ? <Loader2 size={14} className="is-spinning" /> : <Play size={14} />}
                      {testing ? "调用中…" : "调用 MCP 工具"}
                    </button>
                  </div>

                  {testResult && (
                    <div className={`mcp-result ${testResult.isError ? "is-error" : ""}`}>
                      <header>
                        <strong>{testResult.isError ? "工具返回错误" : "调用成功"}</strong>
                        <span>
                          {testResult.serverName} · {testResult.tool} · {formatMs(testResult.latencyMs)}
                        </span>
                      </header>
                      <pre>{testResult.text || "（无文本输出）"}</pre>
                      {testResult.structuredContent !== undefined && (
                        <details>
                          <summary>structuredContent</summary>
                          <pre>{JSON.stringify(testResult.structuredContent, null, 2)}</pre>
                        </details>
                      )}
                    </div>
                  )}
                </section>
              )}
            </>
          ) : (
            <div className="mcp-empty mcp-empty-large">
              选择左侧连接查看工具，或新建一个 MCP 服务器。
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function statusClass(server: McpServerView) {
  if (server.lastError) {
    return "is-error";
  }
  if (server.lastConnectedAt) {
    return "is-on";
  }
  return "is-idle";
}

function statusLabel(server: McpServerView) {
  if (server.lastError) {
    return "连接失败";
  }
  if (server.lastConnectedAt) {
    return "已连接";
  }
  return "未连接";
}

function transportLabel(transport: McpTransport) {
  return transport === "stdio" ? "stdio 本地" : "HTTP 远程";
}

function ToolSchema({ tool }: { tool: ToolRecord }) {
  const params = toolParams(tool);
  if (params.length === 0) {
    return <span className="mcp-tool-required">无入参</span>;
  }
  return (
    <div className="mcp-schema">
      {params.map((param) => (
        <span className="mcp-schema-item" key={param.name} title={param.description}>
          <code>{param.name}</code>
          <em>{param.type}</em>
          {param.required && <i>必填</i>}
        </span>
      ))}
    </div>
  );
}

function toolParams(tool: ToolRecord) {
  const properties =
    typeof tool.schema.properties === "object" && tool.schema.properties !== null
      ? (tool.schema.properties as Record<string, Record<string, unknown>>)
      : {};
  const required = new Set(requiredFields(tool));
  return Object.entries(properties).map(([name, schema]) => ({
    name,
    type: typeof schema.type === "string" ? schema.type : "any",
    required: required.has(name),
    description: typeof schema.description === "string" ? schema.description : undefined
  }));
}

function displayNameOf(tool: ToolRecord) {
  return tool.name.split(" · ").slice(1).join(" · ") || tool.name;
}

function toolNameOf(tool: ToolRecord) {
  const endpoint = tool.endpoint ?? "";
  const raw = endpoint.slice(endpoint.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function requiredFields(tool: ToolRecord) {
  const required = tool.schema.required;
  return Array.isArray(required) ? required.filter((item): item is string => typeof item === "string") : [];
}

function exampleArgs(tool: ToolRecord) {
  const properties =
    typeof tool.schema.properties === "object" && tool.schema.properties !== null
      ? (tool.schema.properties as Record<string, Record<string, unknown>>)
      : {};
  const required = requiredFields(tool);
  const keys = required.length > 0 ? required : Object.keys(properties).slice(0, 3);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const schema = properties[key] ?? {};
    result[key] = exampleValue(key, schema);
  }
  return result;
}

function exampleValue(key: string, schema: Record<string, unknown>) {
  if (key.toLowerCase().includes("query")) {
    return "分数的意义";
  }
  if (key === "durationMinutes") {
    return 40;
  }
  if (key === "score") {
    return 0.86;
  }
  if (schema.type === "number") {
    return typeof schema.default === "number" ? schema.default : 1;
  }
  if (schema.type === "boolean") {
    return false;
  }
  if (schema.type === "array") {
    return [];
  }
  if (schema.type === "object") {
    return {};
  }
  return "示例值";
}

function parseEnv(text: string): Record<string, string> | undefined | string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return undefined;
  }
  const env: Record<string, string> = {};
  for (const line of lines) {
    const separator = line.indexOf("=");
    if (separator <= 0) {
      return `环境变量格式应为 KEY=value：${line}`;
    }
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return `环境变量名不合法：${key}`;
    }
    env[key] = line.slice(separator + 1).trim();
  }
  return env;
}

function suggestId(servers: McpServerView[]) {
  let index = servers.length + 1;
  while (servers.some((server) => server.id === `mcp-server-${index}`)) {
    index += 1;
  }
  return `mcp-server-${index}`;
}

function formatMs(value: number) {
  return value >= 1 ? `${value.toFixed(1)} ms` : `${value.toFixed(2)} ms`;
}

function truncate(value: string, max: number) {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
