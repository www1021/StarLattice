import { useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Code2,
  Globe,
  LoaderCircle,
  Minus,
  Play,
  Plus,
  X
} from "lucide-react";
import { platformApi, type Plugin, type PluginInvokeResult, type PluginType, type PluginWrite } from "./api";

type AuthDraft = {
  type: "none" | "apikey" | "bearer";
  location: "header" | "query";
  name: string;
  value: string;
};

type WParam = {
  id: string;
  name: string;
  description: string;
  type: string;
  required: boolean;
  default: string;
  enabled: boolean;
};

type WOutput = { id: string; name: string; description: string; type: string };

type ParamGroups = { header: WParam[]; query: WParam[]; body: WParam[]; outputs: WOutput[] };

const ICONS = ["🌐", "🔍", "📚", "🤖", "📊", "🛠️", "💬", "🧠", "⚡", "🎯"];
const PARAM_TYPES = ["string", "int", "number", "boolean", "object"];
const STEPS = ["插件信息", "工具配置", "校验工具"];

let seq = 0;
function uid() {
  seq += 1;
  return `w${seq}`;
}
function blankParam(): WParam {
  return { id: uid(), name: "", description: "", type: "string", required: false, default: "", enabled: true };
}
function blankOutput(): WOutput {
  return { id: uid(), name: "", description: "", type: "string" };
}

const EMPTY_GROUPS: ParamGroups = { header: [], query: [], body: [], outputs: [] };

function Field({
  label,
  required,
  counter,
  children
}: {
  label: string;
  required?: boolean;
  counter?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="pl-field">
      <label>
        {label}
        {required ? <em>*</em> : null}
        {counter ? <span className="pl-counter-inline">{counter}</span> : null}
      </label>
      {children}
    </div>
  );
}

function CounterBox({
  value,
  max,
  onChange,
  placeholder,
  multiline
}: {
  value: string;
  max: number;
  onChange: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
}) {
  return (
    <div className={`pl-input-wrap ${multiline ? "is-area" : ""}`}>
      {multiline ? (
        <textarea
          className="pl-textarea"
          maxLength={max}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          className="pl-input"
          maxLength={max}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      <span className="pl-counter">
        {value.length}/{max}
      </span>
    </div>
  );
}

function Switch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`pl-switch ${on ? "is-on" : ""}`}
      onClick={onToggle}
    />
  );
}

function ParamTable({
  rows,
  onChange,
  disabled
}: {
  rows: WParam[];
  onChange: (rows: WParam[]) => void;
  disabled?: boolean;
}) {
  function patch(id: string, p: Partial<WParam>) {
    onChange(rows.map((r) => (r.id === id ? { ...r, ...p } : r)));
  }
  return (
    <div className={`pl-ptable ${disabled ? "is-disabled" : ""}`}>
      <div className="pl-ptable-head">
        <span>参数名称 <em>*</em></span>
        <span>参数描述</span>
        <span>参数类型 <em>*</em></span>
        <span>必填</span>
        <span>默认值</span>
        <span>开启</span>
        <span />
      </div>
      {rows.length === 0 ? (
        <div className="pl-ptable-empty">{disabled ? "GET 请求不使用 body 参数" : "暂无参数，点右上角「添加」"}</div>
      ) : (
        rows.map((r) => (
          <div className="pl-ptable-row" key={r.id}>
            <input
              className="pl-input pl-pin"
              placeholder="参数名称"
              value={r.name}
              onChange={(e) => patch(r.id, { name: e.target.value })}
            />
            <input
              className="pl-input pl-pin"
              placeholder="参数描述"
              value={r.description}
              onChange={(e) => patch(r.id, { description: e.target.value })}
            />
            <select
              className="pl-select pl-pin"
              value={r.type}
              onChange={(e) => patch(r.id, { type: e.target.value })}
            >
              {PARAM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <Switch on={r.required} onToggle={() => patch(r.id, { required: !r.required })} />
            <input
              className="pl-input pl-pin"
              placeholder="请输入"
              value={r.default}
              onChange={(e) => patch(r.id, { default: e.target.value })}
            />
            <Switch on={r.enabled} onToggle={() => patch(r.id, { enabled: !r.enabled })} />
            <button
              type="button"
              className="pl-icon-btn pl-pdel"
              aria-label="删除参数"
              onClick={() => onChange(rows.filter((x) => x.id !== r.id))}
            >
              <Minus size={14} strokeWidth={1.8} />
            </button>
          </div>
        ))
      )}
    </div>
  );
}

function OutputTable({ rows, onChange }: { rows: WOutput[]; onChange: (rows: WOutput[]) => void }) {
  function patch(id: string, p: Partial<WOutput>) {
    onChange(rows.map((r) => (r.id === id ? { ...r, ...p } : r)));
  }
  return (
    <div className="pl-ptable">
      <div className="pl-ptable-head is-output">
        <span>参数名称 <em>*</em></span>
        <span>参数描述</span>
        <span>参数类型 <em>*</em></span>
        <span />
      </div>
      {rows.length === 0 ? (
        <div className="pl-ptable-empty">暂无输出定义</div>
      ) : (
        rows.map((r) => (
          <div className="pl-ptable-row is-output" key={r.id}>
            <input
              className="pl-input pl-pin"
              placeholder="输出字段名"
              value={r.name}
              onChange={(e) => patch(r.id, { name: e.target.value })}
            />
            <input
              className="pl-input pl-pin"
              placeholder="输出内容"
              value={r.description}
              onChange={(e) => patch(r.id, { description: e.target.value })}
            />
            <select
              className="pl-select pl-pin"
              value={r.type}
              onChange={(e) => patch(r.id, { type: e.target.value })}
            >
              {PARAM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="pl-icon-btn pl-pdel"
              aria-label="删除输出"
              onClick={() => onChange(rows.filter((x) => x.id !== r.id))}
            >
              <Minus size={14} strokeWidth={1.8} />
            </button>
          </div>
        ))
      )}
    </div>
  );
}

function GroupBlock({
  title,
  addLabel,
  disabled,
  onAdd,
  children
}: {
  title: string;
  addLabel: string;
  disabled?: boolean;
  onAdd: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="pl-group">
      <div className="pl-group-head">
        <span>{title}</span>
        <button type="button" className="pl-add-link" onClick={onAdd} disabled={disabled}>
          <Plus size={13} strokeWidth={2} /> {addLabel}
        </button>
      </div>
      {children}
    </div>
  );
}

export function PluginWizard({
  mode,
  plugin,
  onClose,
  onDone
}: {
  mode: "create" | "edit";
  plugin?: Plugin;
  onClose: () => void;
  onDone: (plugin: Plugin) => void;
}) {
  const cfg = (plugin?.config ?? {}) as Record<string, unknown>;
  const isEdit = mode === "edit";
  const [type, setType] = useState<PluginType | null>(plugin?.type ?? null);
  const [step, setStep] = useState(isEdit ? 1 : 0);

  const [name, setName] = useState(plugin?.name ?? "");
  const [description, setDescription] = useState(plugin?.description === "（暂无说明）" ? "" : plugin?.description ?? "");
  const [icon, setIcon] = useState((cfg.icon as string) ?? "🌐");
  const [auth, setAuth] = useState<AuthDraft>(() => {
    const a = (cfg.auth ?? {}) as Record<string, string>;
    if (a.location) {
      return {
        type: (a.type as AuthDraft["type"]) ?? "none",
        location: (a.location as AuthDraft["location"]) ?? "header",
        name: a.name ?? "",
        value: a.value ?? ""
      };
    }
    if (a.type === "apikey" && a.key) {
      return { type: "apikey", location: "header", name: a.header || "X-API-Key", value: a.key };
    }
    if (a.type === "bearer") {
      return { type: "bearer", location: "header", name: "Authorization", value: a.token ?? "" };
    }
    return { type: "none", location: "header", name: "", value: "" };
  });
  const [runtime, setRuntime] = useState(plugin?.runtime ?? "Python 3.11");

  const [toolName, setToolName] = useState((cfg.toolName as string) ?? plugin?.name ?? "");
  const [endpoint, setEndpoint] = useState(plugin?.endpoint ?? "");
  const [method, setMethod] = useState(plugin?.method ?? "GET");
  const [stream, setStream] = useState<"stream" | "blocking">((cfg.stream as string) === "stream" ? "stream" : "blocking");
  const [toolDescription, setToolDescription] = useState((cfg.toolDescription as string) ?? "");
  const [domain, setDomain] = useState(plugin?.domain ?? "");

  const [groups, setGroups] = useState<ParamGroups>(() => {
    const g = cfg.paramGroups as Partial<ParamGroups> | undefined;
    if (g) {
      return {
        header: g.header ?? [],
        query: g.query ?? [],
        body: g.body ?? [],
        outputs: g.outputs ?? []
      };
    }
    // 旧数据迁移：扁平 params → query 组
    const legacy = (cfg.params ?? []) as Array<Record<string, string>>;
    if (legacy.length > 0) {
      return {
        ...EMPTY_GROUPS,
        query: legacy.map((p) => ({
          id: uid(),
          name: p.name ?? "",
          description: p.description ?? "",
          type: p.type ?? "string",
          required: false,
          default: p.sample ?? "",
          enabled: true
        }))
      };
    }
    return { ...EMPTY_GROUPS };
  });
  const [code, setCode] = useState((cfg.code as string) ?? `def run(args):\n    return {"echo": args}\n`);
  const [codeParams, setCodeParams] = useState<WParam[]>(() => {
    const legacy = (cfg.params ?? []) as Array<Record<string, string>>;
    return legacy.map((p) => ({
      id: uid(),
      name: p.name ?? "",
      description: p.description ?? "",
      type: p.type ?? "string",
      required: false,
      default: p.sample ?? "",
      enabled: true
    }));
  });

  const [sampleArgs, setSampleArgs] = useState<Record<string, unknown>>(
    (cfg.sampleArgs as Record<string, unknown>) ?? {}
  );
  const [argsJson, setArgsJson] = useState(() => {
    const s = cfg.sampleArgs as Record<string, unknown> | undefined;
    if (s && Object.keys(s).length > 0) return JSON.stringify(s, null, 2);
    // 从开启的参数生成示例
    const q = (groups.query ?? []).filter((p) => p.enabled && p.name);
    if (q.length > 0) {
      return JSON.stringify(
        Object.fromEntries(q.map((p) => [p.name, p.default === "" ? "" : p.default])),
        null,
        2
      );
    }
    return "{}";
  });
  const [tab, setTab] = useState<"request" | "response" | "original">("response");
  const [verifyResult, setVerifyResult] = useState<PluginInvokeResult | undefined>();
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState(false);
  const [exampleSaved, setExampleSaved] = useState(false);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const isApi = type === "api";

  /** 按参数定义自动生成校验输入：默认值按类型转换，保存过的示例值优先。 */
  function autoArgs(): Record<string, unknown> {
    const rows = isApi ? [...groups.query, ...groups.body, ...groups.header] : codeParams;
    const out: Record<string, unknown> = {};
    for (const p of rows) {
      const key = p.name.trim();
      if (!p.enabled || !key || key in out) continue;
      if (key in sampleArgs) {
        out[key] = sampleArgs[key];
        continue;
      }
      const raw = p.default.trim();
      if (p.type === "int" || p.type === "number") {
        const n = Number(raw);
        out[key] = raw === "" || Number.isNaN(n) ? (raw === "" ? "" : raw) : n;
      } else if (p.type === "boolean") {
        out[key] = raw === "" ? false : raw === "true";
      } else if (p.type === "object") {
        if (raw === "") {
          out[key] = {};
        } else {
          try {
            out[key] = JSON.parse(raw);
          } catch {
            out[key] = raw;
          }
        }
      } else {
        out[key] = raw;
      }
    }
    return out;
  }

  const builtConfig = useMemo(() => {
    if (isApi) {
      return {
        icon,
        auth,
        toolName: toolName.trim(),
        toolDescription: toolDescription.trim(),
        stream,
        paramGroups: groups,
        sampleArgs
      };
    }
    return { icon, code, params: codeParams, toolName: toolName.trim(), sampleArgs };
  }, [isApi, icon, auth, toolName, toolDescription, stream, groups, code, codeParams, sampleArgs]);

  function buildPayload(args: Record<string, unknown>): PluginWrite & { args?: Record<string, unknown> } {
    return {
      name: name.trim(),
      type: type as PluginType,
      description: description.trim() || undefined,
      ...(isApi
        ? {
            endpoint: endpoint.trim() || undefined,
            method,
            domain: domain.trim() || undefined
          }
        : { runtime }),
      config: builtConfig,
      args
    };
  }

  function parseArgs(): Record<string, unknown> {
    try {
      return argsJson.trim() ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
    } catch {
      throw new Error("输入参数不是合法 JSON");
    }
  }

  function validateStep(current: number): string | undefined {
    if (current === 1) {
      if (!name.trim()) return "请填写插件名称";
      if (!description.trim()) return "请填写插件描述";
      if (auth.type === "apikey" && !auth.name.trim()) return "请填写密钥参数名";
      if (auth.type !== "none" && !auth.value.trim()) return "请填写密钥值";
    }
    if (current === 2 && isApi) {
      if (!toolName.trim()) return "请填写工具名称";
      if (!endpoint.trim()) return "请填写调用地址";
    }
    return undefined;
  }

  function goNext() {
    const problem = validateStep(step);
    if (problem) {
      setError(problem);
      return;
    }
    setError(undefined);
    if (step === 2) {
      // 进入校验步骤：按最新参数定义自动生成输入 JSON
      setArgsJson(JSON.stringify(autoArgs(), null, 2));
      setTab("response");
    }
    setStep(step + 1);
  }

  async function runVerify() {
    let args: Record<string, unknown>;
    try {
      args = parseArgs();
    } catch (e) {
      setVerifyResult({ ok: false, kind: "api", latencyMs: 0, error: e instanceof Error ? e.message : "参数错误" });
      setVerified(false);
      return;
    }
    setVerifying(true);
    setError(undefined);
    setTab("response");
    try {
      const { result } = await platformApi.previewPlugin(buildPayload(args) as never);
      setVerifyResult(result);
      setVerified(result.ok);
      if (!result.ok) setTab("original");
    } catch (e) {
      setVerifyResult({
        ok: false,
        kind: "api",
        latencyMs: 0,
        error: e instanceof Error ? e.message : "校验失败"
      });
      setVerified(false);
      setTab("original");
    } finally {
      setVerifying(false);
    }
  }

  async function saveExample() {
    try {
      setSampleArgs(parseArgs());
      setExampleSaved(true);
      setTimeout(() => setExampleSaved(false), 1800);
    } catch {
      setError("输入参数不是合法 JSON，无法保存为示例");
    }
  }

  async function finish(status: "active" | "draft") {
    const problem = validateStep(1) ?? validateStep(2);
    if (problem && !(isEdit && problem)) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const base = {
        name: name.trim(),
        type: type as PluginType,
        description: description.trim() || undefined,
        ...(isApi
          ? { endpoint: endpoint.trim() || undefined, method, domain: domain.trim() || undefined }
          : { runtime }),
        status,
        config: builtConfig
      };
      const { plugin: saved } = isEdit
        ? await platformApi.updatePlugin((plugin as Plugin).id, base)
        : await platformApi.createPlugin(base);
      onDone(saved);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="pl-modal-backdrop">
      <div className="pl-modal pl-wizard">
        <div className="pl-modal-head">
          <div>
            <h2>{isEdit ? "编辑插件" : type ? `新建${isApi ? "API" : "代码"}插件` : "新建插件"}</h2>
          </div>
          <button type="button" className="pl-icon-btn" onClick={onClose} aria-label="关闭">
            <X size={16} strokeWidth={1.9} />
          </button>
        </div>

        {step >= 1 ? (
          <div className="pl-steps">
            {STEPS.map((label, i) => (
              <div
                key={label}
                className={`pl-step ${step === i + 1 ? "is-active" : ""} ${step > i + 1 ? "is-done" : ""}`}
              >
                <span className="pl-step-dot">{step > i + 1 ? <Check size={12} strokeWidth={2.4} /> : i + 1}</span>
                <span>{label}</span>
              </div>
            ))}
          </div>
        ) : null}

        <div className={`pl-wizard-body ${step === 3 ? "is-verify" : ""}`}>
          {error ? <div className="pl-confirm">{error}</div> : null}

          {step === 0 ? (
            <div className="pl-choice">
              <button type="button" className="pl-choice-tile" onClick={() => { setType("api"); setStep(1); }}>
                <span className="pl-choice-icon"><Globe size={18} strokeWidth={1.8} /></span>
                <strong>API 插件</strong>
                <span>通过 HTTP 接口接入外部服务与数据。</span>
              </button>
              <button type="button" className="pl-choice-tile is-code" onClick={() => { setType("code"); setStep(1); }}>
                <span className="pl-choice-icon"><Code2 size={18} strokeWidth={1.8} /></span>
                <strong>代码插件</strong>
                <span>编写 Python 函数实现自定义逻辑。</span>
              </button>
            </div>
          ) : null}

          {step === 1 ? (
            <div className="pl-form">
              <Field label="插件名称" required counter={`${name.length}/100`}>
                <CounterBox value={name} max={100} onChange={setName} placeholder="例如：文献检索" />
              </Field>
              <Field label="插件描述" required counter={`${description.length}/200`}>
                <CounterBox value={description} max={200} onChange={setDescription} multiline placeholder="这个插件解决什么问题" />
              </Field>
              <Field label="插件图标" required>
                <div className="pl-icon-row">
                  {ICONS.map((ic) => (
                    <button
                      key={ic}
                      type="button"
                      className={`pl-icon-item ${icon === ic ? "is-on" : ""}`}
                      onClick={() => setIcon(ic)}
                    >
                      {ic}
                    </button>
                  ))}
                </div>
              </Field>
              {isApi ? (
                <>
                  <Field label="授权方式" required>
                    <select
                      className="pl-select"
                      value={auth.type}
                      onChange={(e) => setAuth({ ...auth, type: e.target.value as AuthDraft["type"] })}
                    >
                      <option value="none">无授权</option>
                      <option value="apikey">API Key</option>
                      <option value="bearer">Bearer Token</option>
                    </select>
                  </Field>
                  {auth.type === "apikey" ? (
                    <div className="pl-auth-card">
                      <div className="pl-field">
                        <label>密钥位置 <em>*</em></label>
                        <div className="pl-radio-row">
                          {(["header", "query"] as const).map((loc) => (
                            <label key={loc} className="pl-radio">
                              <input
                                type="radio"
                                name="auth-location"
                                checked={auth.location === loc}
                                onChange={() => setAuth({ ...auth, location: loc })}
                              />
                              {loc === "header" ? "Header" : "Query"}
                            </label>
                          ))}
                        </div>
                      </div>
                      <Field label="密钥参数名" required counter={`${auth.name.length}/100`}>
                        <CounterBox value={auth.name} max={100} onChange={(v) => setAuth({ ...auth, name: v })} placeholder="api_key" />
                      </Field>
                      <Field label="密钥值" required counter={`${auth.value.length}/1000`}>
                        <CounterBox value={auth.value} max={1000} onChange={(v) => setAuth({ ...auth, value: v })} />
                      </Field>
                    </div>
                  ) : null}
                  {auth.type === "bearer" ? (
                    <Field label="密钥值" required counter={`${auth.value.length}/1000`}>
                      <CounterBox value={auth.value} max={1000} onChange={(v) => setAuth({ ...auth, value: v })} />
                    </Field>
                  ) : null}
                </>
              ) : (
                <Field label="运行环境" required>
                  <select className="pl-select" value={runtime} onChange={(e) => setRuntime(e.target.value)}>
                    <option value="Python 3.11">Python 3.11</option>
                    <option value="Python 3.10">Python 3.10</option>
                  </select>
                </Field>
              )}
            </div>
          ) : null}

          {step === 2 ? (
            <div className="pl-form">
              {isApi ? (
                <>
                  <div className="pl-sec-title">基础信息</div>
                  <Field label="工具名称" required counter={`${toolName.length}/100`}>
                    <CounterBox value={toolName} max={100} onChange={setToolName} placeholder="search_academic_papers" />
                  </Field>
                  <Field label="调用地址" required>
                    <CounterBox value={endpoint} max={500} onChange={setEndpoint} placeholder="https://api.example.com/works" />
                  </Field>
                  <Field label="请求方式" required>
                    <div className="pl-radio-row">
                      {(["GET", "POST"] as const).map((m) => (
                        <label key={m} className="pl-radio">
                          <input
                            type="radio"
                            name="req-method"
                            checked={method === m}
                            onChange={() => setMethod(m)}
                          />
                          {m}
                        </label>
                      ))}
                    </div>
                  </Field>
                  <Field label="调用方式" required>
                    <div className="pl-radio-row">
                      <label className="pl-radio">
                        <input
                          type="radio"
                          name="call-mode"
                          checked={stream === "stream"}
                          onChange={() => setStream("stream")}
                        />
                        流式
                      </label>
                      <label className="pl-radio">
                        <input
                          type="radio"
                          name="call-mode"
                          checked={stream === "blocking"}
                          onChange={() => setStream("blocking")}
                        />
                        非流式
                      </label>
                    </div>
                  </Field>
                  <Field label="工具描述" required counter={`${toolDescription.length}/200`}>
                    <CounterBox value={toolDescription} max={200} onChange={setToolDescription} multiline placeholder="这个工具做什么、什么时候用" />
                  </Field>
                  <Field label="域名白名单">
                    <CounterBox value={domain} max={300} onChange={setDomain} placeholder="api.example.com" />
                  </Field>

                  <div className="pl-sec-title">API 参数</div>
                  <GroupBlock
                    title="header"
                    addLabel="添加"
                    onAdd={() => setGroups({ ...groups, header: [...groups.header, blankParam()] })}
                  >
                    <ParamTable
                      rows={groups.header}
                      onChange={(rows) => setGroups({ ...groups, header: rows })}
                    />
                  </GroupBlock>
                  <GroupBlock
                    title="query"
                    addLabel="添加"
                    onAdd={() => setGroups({ ...groups, query: [...groups.query, blankParam()] })}
                  >
                    <ParamTable rows={groups.query} onChange={(rows) => setGroups({ ...groups, query: rows })} />
                  </GroupBlock>
                  <GroupBlock
                    title="body"
                    addLabel="添加"
                    disabled={method === "GET"}
                    onAdd={() => setGroups({ ...groups, body: [...groups.body, blankParam()] })}
                  >
                    <ParamTable
                      rows={groups.body}
                      onChange={(rows) => setGroups({ ...groups, body: rows })}
                      disabled={method === "GET"}
                    />
                  </GroupBlock>
                  <GroupBlock
                    title="outputs"
                    addLabel="添加"
                    onAdd={() => setGroups({ ...groups, outputs: [...groups.outputs, blankOutput()] })}
                  >
                    <OutputTable rows={groups.outputs} onChange={(rows) => setGroups({ ...groups, outputs: rows })} />
                  </GroupBlock>
                </>
              ) : (
                <>
                  <div className="pl-sec-title">函数体</div>
                  <Field label="run(args) → dict">
                    <textarea
                      className="pl-textarea pl-code pl-code-lg"
                      value={code}
                      spellCheck={false}
                      onChange={(e) => setCode(e.target.value)}
                    />
                  </Field>
                  <div className="pl-sec-title">参数</div>
                  <GroupBlock
                    title="inputs"
                    addLabel="添加"
                    onAdd={() => setCodeParams([...codeParams, blankParam()])}
                  >
                    <ParamTable rows={codeParams} onChange={setCodeParams} />
                  </GroupBlock>
                </>
              )}
            </div>
          ) : null}

          {step === 3 ? (
            <div className="pl-verify">
              <div className="pl-verify-info">
                <div>
                  <span>当前校验工具</span>
                  <strong>{toolName || name}</strong>
                </div>
                {isApi ? (
                  <div>
                    <span>API调用地址</span>
                    <strong>{endpoint || "—"}</strong>
                  </div>
                ) : (
                  <div>
                    <span>运行环境</span>
                    <strong>{runtime}</strong>
                  </div>
                )}
              </div>
              <div className="pl-verify-grid">
                <div className="pl-verify-col">
                  <div className="pl-verify-label">输入参数</div>
                  <div className="pl-verify-editor">
                    <textarea
                      className="pl-textarea pl-code"
                      value={argsJson}
                      spellCheck={false}
                      onChange={(e) => setArgsJson(e.target.value)}
                    />
                    <button
                      type="button"
                      className="platform-button is-primary"
                      onClick={runVerify}
                      disabled={verifying}
                    >
                      {verifying ? <LoaderCircle size={14} className="pl-spin" /> : <Play size={14} strokeWidth={1.8} />}
                      运行
                    </button>
                  </div>
                </div>
                <div className="pl-verify-col">
                  <div className="pl-verify-label">输出结果</div>
                  <div className="pl-verify-out">
                    <div className="pl-tabs">
                      {(["request", "response", "original"] as const).map((t) => (
                        <button
                          key={t}
                          type="button"
                          className={`pl-tab ${tab === t ? "is-on" : ""}`}
                          onClick={() => setTab(t)}
                        >
                          {t === "request" ? "请求" : t === "response" ? "响应" : "原始"}
                        </button>
                      ))}
                    </div>
                    <pre className={`pl-test-result ${verifyResult ? (verifyResult.ok ? "is-ok" : "is-fail") : ""}`}>
                      {!verifyResult
                        ? "点击「运行」查看校验结果"
                        : tab === "request"
                          ? verifyResult.request
                            ? `${verifyResult.request.method} ${verifyResult.request.url}`
                            : isApi
                              ? `${method} ${endpoint}`
                              : "Python 子进程本地执行"
                          : tab === "response"
                            ? verifyResult.error
                              ? `错误：${verifyResult.error}`
                              : `${verifyResult.status ?? "-"} · ${verifyResult.latencyMs}ms\n${
                                  verifyResult.detail !== undefined
                                    ? JSON.stringify(verifyResult.detail, null, 2)
                                    : verifyResult.preview ?? ""
                                }`
                            : JSON.stringify(verifyResult.detail ?? verifyResult.error ?? {}, null, 2)}
                    </pre>
                  </div>
                </div>
              </div>
              <div className="pl-verify-foot">
                <button type="button" className="platform-button is-ghost" onClick={saveExample}>
                  {exampleSaved ? "已保存为示例" : "保存为示例"}
                </button>
              </div>
            </div>
          ) : null}
        </div>

        <div className="pl-wizard-foot">
          {step === 0 ? (
            <button type="button" className="platform-button is-ghost" onClick={onClose} style={{ marginLeft: "auto" }}>
              取消
            </button>
          ) : (
            <>
              <button
                type="button"
                className="platform-button is-ghost"
                onClick={() => (step === 1 && !isEdit ? (setType(null), setStep(0)) : setStep(step - 1))}
                disabled={verifying || saving}
              >
                <ArrowLeft size={15} strokeWidth={1.8} />
                上一步
              </button>
              {step < 3 ? (
                <button type="button" className="platform-button is-primary" onClick={goNext} disabled={saving}>
                  下一步
                  <ArrowRight size={15} strokeWidth={1.8} />
                </button>
              ) : (
                <div className="pl-wizard-foot-right">
                  {!isEdit ? (
                    <button
                      type="button"
                      className="platform-button is-ghost"
                      onClick={() => finish("draft")}
                      disabled={saving}
                    >
                      存为草稿
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="platform-button is-primary"
                    onClick={() => finish("active")}
                    disabled={saving || (!isEdit && !verified)}
                    title={isEdit ? "保存修改" : verified ? "校验已通过，完成创建" : "请先运行校验并通过"}
                  >
                    <Check size={15} strokeWidth={1.9} />
                    {saving ? "保存中…" : isEdit ? "保存" : "完成创建"}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
