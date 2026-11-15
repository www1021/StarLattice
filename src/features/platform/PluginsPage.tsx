import { useEffect, useMemo, useState } from "react";
import {
  Code2,
  Globe,
  Plus,
  Search,
  Trash2,
  X,
  AlertTriangle,
  Boxes,
  Play
} from "lucide-react";
import { platformApi, type Plugin, type PluginStatus } from "./api";
import { PluginWizard } from "./PluginWizard";
import "./plugins.css";

function statusMeta(status: PluginStatus): { label: string; className: string } {
  if (status === "active") return { label: "已启用", className: "is-on" };
  if (status === "error") return { label: "异常", className: "is-error" };
  return { label: "草稿", className: "is-idle" };
}

function PluginCard({ plugin, onClick }: { plugin: Plugin; onClick: () => void }) {
  const typeBadge =
    plugin.type === "api"
      ? { label: "API", className: "is-api" }
      : { label: "代码", className: "is-code" };
  const st = statusMeta(plugin.status);
  const icon = (plugin.config?.icon as string) ?? null;
  return (
    <button
      type="button"
      className={`pl-card ${plugin.status === "draft" ? "is-draft" : ""}`}
      onClick={onClick}
    >
      <div className="pl-card-head">
        <span className={`pl-card-icon ${plugin.type === "code" ? "is-code" : ""}`}>
          {icon ?? (plugin.type === "api" ? <Globe size={16} strokeWidth={1.7} /> : <Code2 size={16} strokeWidth={1.7} />)}
        </span>
        <span className="pl-card-title">
          <strong>{plugin.name}</strong>
        </span>
        <span
          className={`pl-status ${
            plugin.status === "active" ? "is-active" : ""
          } ${plugin.status === "error" ? "is-error" : ""}`}
        />
      </div>
      <p className="pl-card-desc">{plugin.description}</p>
      <div className="pl-card-meta">
        <span className={`pl-badge ${typeBadge.className}`}>{typeBadge.label}</span>
        <span className={`pl-badge ${st.className}`}>{st.label}</span>
        {plugin.official ? <span className="pl-badge is-official">官方</span> : null}
        {plugin.domain ? <span>{plugin.domain}</span> : null}
        {plugin.runtime ? <span>{plugin.runtime}</span> : null}
      </div>
    </button>
  );
}

export function PluginsPage() {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Plugin | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState<Plugin | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);

  async function load() {
    setLoading(true);
    setLoadError(undefined);
    try {
      const data = await platformApi.listPlugins();
      setPlugins(data.plugins);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "加载插件失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return plugins;
    return plugins.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        (p.domain ?? "").toLowerCase().includes(q)
    );
  }, [plugins, query]);

  const myPlugins = filtered.filter((p) => !p.official);
  const officialPlugins = filtered.filter((p) => p.official);

  async function deletePlugin(id: string) {
    try {
      await platformApi.deletePlugin(id);
      setSelected(null);
      setConfirmDelete(false);
      await load();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "删除失败");
    }
  }

  function refreshWith(saved: Plugin) {
    setEditing(null);
    setSelected(saved);
    void load();
  }

  return (
    <div className="pl-page">
      <div className="platform-head">
        <div className="platform-head-main">
          <div className="platform-eyebrow">扩展能力</div>
          <h1>插件</h1>
        </div>
        <div className="platform-head-actions">
          <div className="pl-search">
            <Search size={15} strokeWidth={1.8} />
            <input
              value={query}
              placeholder="搜索插件"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <button
            type="button"
            className="platform-button is-primary"
            onClick={() => setWizardOpen(true)}
          >
            <Plus size={15} strokeWidth={2} />
            新建插件
          </button>
        </div>
      </div>

      {loadError ? <div className="pl-confirm">{loadError}</div> : null}
      {loading ? (
        <div className="pl-empty">加载中…</div>
      ) : (
        <>
          <div className="pl-section">
            <div className="pl-section-label">官方插件</div>
            {officialPlugins.length === 0 ? (
              <div className="pl-empty">没有匹配的官方插件</div>
            ) : (
              <div className="pl-row">
                {officialPlugins.map((p) => (
                  <PluginCard key={p.id} plugin={p} onClick={() => setSelected(p)} />
                ))}
              </div>
            )}
          </div>

          <div className="pl-section">
            <div className="pl-section-label">我的插件 <small>{myPlugins.length} 个</small></div>
            {myPlugins.length === 0 ? (
              <div className="pl-empty">还没有自定义插件</div>
            ) : (
              <div className="pl-grid">
                {myPlugins.map((p) => (
                  <PluginCard key={p.id} plugin={p} onClick={() => setSelected(p)} />
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {selected ? (
        <PluginDetail
          plugin={selected}
          onClose={() => {
            setSelected(null);
            setConfirmDelete(false);
          }}
          onDelete={() => deletePlugin(selected.id)}
          onOpenEditor={() => setEditing(selected)}
          confirmDelete={confirmDelete}
          setConfirmDelete={setConfirmDelete}
        />
      ) : null}

      {editing ? (
        <PluginWizard
          mode="edit"
          plugin={editing}
          onClose={() => setEditing(null)}
          onDone={refreshWith}
        />
      ) : null}

      {wizardOpen ? (
        <PluginWizard
          mode="create"
          onClose={() => setWizardOpen(false)}
          onDone={refreshWith}
        />
      ) : null}
    </div>
  );
}

function PluginDetail({
  plugin,
  onClose,
  onDelete,
  onOpenEditor,
  confirmDelete,
  setConfirmDelete
}: {
  plugin: Plugin;
  onClose: () => void;
  onDelete: () => void;
  onOpenEditor: () => void;
  confirmDelete: boolean;
  setConfirmDelete: (value: boolean) => void;
}) {
  const st = statusMeta(plugin.status);
  const typeBadge =
    plugin.type === "api"
      ? { label: "API 插件", className: "is-api" }
      : { label: "代码插件", className: "is-code" };
  const [testOpen, setTestOpen] = useState(false);
  const [argsText, setArgsText] = useState("{}");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<
    { ok: boolean; text: string } | undefined
  >();

  async function runTest() {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = argsText.trim() ? (JSON.parse(argsText) as Record<string, unknown>) : {};
    } catch {
      setTestResult({ ok: false, text: "参数不是合法 JSON。" });
      return;
    }
    setTesting(true);
    setTestResult(undefined);
    try {
      const { result } = await platformApi.testPlugin(plugin.id, parsed);
      const text = result.error
        ? `错误：${result.error}`
        : `状态 ${result.status ?? "-"} · 耗时 ${result.latencyMs}ms\n${result.preview ?? ""}`;
      setTestResult({ ok: result.ok, text });
    } catch (error) {
      setTestResult({ ok: false, text: error instanceof Error ? error.message : "试运行失败" });
    } finally {
      setTesting(false);
    }
  }

  return (
    <>
      <div className="pl-drawer-backdrop" onClick={onClose} />
      <aside className="pl-drawer-panel" aria-label="插件详情">
        <div className="pl-drawer-head">
          <div className="pl-drawer-title">
            <span className={`pl-card-icon ${plugin.type === "code" ? "is-code" : ""}`}>
              {(plugin.config?.icon as string) ??
                (plugin.type === "api" ? <Globe size={18} strokeWidth={1.7} /> : <Code2 size={18} strokeWidth={1.7} />)}
            </span>
            <h2>{plugin.name}</h2>
          </div>
          <button type="button" className="pl-icon-btn" onClick={onClose} aria-label="关闭">
            <X size={16} strokeWidth={1.9} />
          </button>
        </div>

        <div className="pl-meta-strip">
          <span className={`pl-badge ${typeBadge.className}`}>{typeBadge.label}</span>
          <span className={`pl-badge ${st.className}`}>{st.label}</span>
          {plugin.official ? <span className="pl-badge is-official">官方提供</span> : null}
          <span className="pl-badge is-idle">v{plugin.version}</span>
        </div>

        <div className="pl-meta-strip">
          <div className="pl-meta">
            <b>{plugin.calls}</b>
            <span>累计调用</span>
          </div>
          <div className="pl-meta">
            <b>{plugin.tools}</b>
            <span>工具数</span>
          </div>
          <div className="pl-meta">
            <b>{plugin.references}</b>
            <span>引用 Agent</span>
          </div>
        </div>

        <div className="pl-block">
          <h3>说明</h3>
          <p className="pl-kv" style={{ color: "var(--n-33)" }}>
            {plugin.description}
          </p>
        </div>

        <div className="pl-block">
          <h3>接入信息</h3>
          {plugin.endpoint ? (
            <div className="pl-kv">
              <span>接口</span>
              <code>
                {plugin.method} {plugin.endpoint}
              </code>
            </div>
          ) : null}
          {plugin.domain ? (
            <div className="pl-kv">
              <span>域名白名单</span>
              <code>{plugin.domain}</code>
            </div>
          ) : null}
          {plugin.runtime ? (
            <div className="pl-kv">
              <span>运行环境</span>
              <code>{plugin.runtime}</code>
            </div>
          ) : null}
          <div className="pl-kv">
            <span>最近更新</span>
            <code>{plugin.updatedAt}</code>
          </div>
        </div>

        {plugin.official ? (
          <div className="pl-block" style={{ color: "var(--n-48)", fontSize: 12.5, lineHeight: 1.6 }}>
            <Boxes size={15} strokeWidth={1.8} />
            <span>官方插件由平台维护，可直接在 Agent 里引用。</span>
          </div>
        ) : (
          <>
            <div className="pl-block">
              <button
                type="button"
                className="platform-button is-ghost"
                onClick={() => setTestOpen((value) => !value)}
              >
                <Play size={15} strokeWidth={1.8} />
                {testOpen ? "收起试运行" : "试一试"}
              </button>
              {testOpen ? (
                <div className="pl-test">
                  <label>参数（JSON）</label>
                  <textarea
                    className="pl-textarea"
                    value={argsText}
                    onChange={(event) => setArgsText(event.target.value)}
                    rows={4}
                  />
                  <button
                    type="button"
                    className="platform-button is-primary"
                    onClick={runTest}
                    disabled={testing}
                  >
                    {testing ? "运行中…" : "运行"}
                  </button>
                  {testResult ? (
                    <pre className={`pl-test-result ${testResult.ok ? "is-ok" : "is-fail"}`}>
                      {testResult.text}
                    </pre>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="pl-drawer-actions">
              {!confirmDelete ? (
                <button
                  type="button"
                  className="platform-button is-reject"
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 size={15} strokeWidth={1.8} />
                  删除
                </button>
              ) : (
                <div className="pl-confirm" style={{ flex: 1 }}>
                  <span>
                    <AlertTriangle size={14} strokeWidth={1.9} /> 删除后，引用它的 Agent
                    会少掉对应工具，且无法恢复。
                  </span>
                  <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <button
                      type="button"
                      className="platform-button is-ghost"
                      onClick={() => setConfirmDelete(false)}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="platform-button is-reject"
                      onClick={onDelete}
                    >
                      确认删除
                    </button>
                  </div>
                </div>
              )}
              <button
                type="button"
                className="platform-button is-primary"
                onClick={onOpenEditor}
              >
                编辑
              </button>
            </div>
          </>
        )}
      </aside>
    </>
  );
}
