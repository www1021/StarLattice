import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  Loader2,
  RefreshCw,
  Search,
  X
} from "lucide-react";
import { platformApi } from "../platform/api";
import type { ModelProbeResult, ModelProfileView, ModelWrite, RemoteModelList } from "../platform/types";
import {
  CUSTOM_PROVIDER_ID,
  MODEL_PROVIDERS,
  PROVIDER_GROUPS,
  findProvider,
  suggestModelId,
  type ModelProvider
} from "./modelProviders";

type PickerItem = {
  id: string;
  label: string;
  mark?: string;
  hint?: string;
};

type PickerGroup = {
  title: string;
  items: PickerItem[];
};

/** 带搜索的下拉：触发器 + 浮层面板，点外面收起。 */
function Select({
  value,
  placeholder,
  groups,
  onPick,
  searchPlaceholder,
  footer,
  triggerMark
}: {
  value: string;
  placeholder: string;
  groups: PickerGroup[];
  onPick: (id: string) => void;
  searchPlaceholder: string;
  footer?: ReactNode;
  triggerMark?: string;
}) {
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [place, setPlace] = useState<{ left: number; top: number; width: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 面板挂到 body 上再定位：弹窗正文是可滚动的，绝对定位会被裁掉。
  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    const panelHeight = 336;
    const flip = window.innerHeight - rect.bottom < panelHeight && rect.top > panelHeight;
    setPlace({
      left: rect.left,
      top: flip ? rect.top - panelHeight - 5 : rect.bottom + 5,
      width: rect.width
    });
    setOpen(true);
  };

  useEffect(() => {
    if (!open) {
      setKeyword("");
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      const node = event.target as Node;
      if (!boxRef.current?.contains(node) && !panelRef.current?.contains(node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    // 页面或弹窗一滚动就收起，免得面板跟触发器脱位；
    // 但面板自己滚（滚轮翻列表、拖滚动条）不能算，否则一滚就没了。
    const handleScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && panelRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("scroll", handleScroll, true);
    // 展开就能直接搜，不用再点一次输入框
    const timer = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("scroll", handleScroll, true);
      window.clearTimeout(timer);
    };
  }, [open]);

  const current = useMemo(() => {
    for (const group of groups) {
      const hit = group.items.find((item) => item.id === value);
      if (hit) {
        return hit;
      }
    }
    return undefined;
  }, [groups, value]);

  const filtered = useMemo(() => {
    const keyword2 = keyword.trim().toLowerCase();
    if (!keyword2) {
      return groups;
    }
    return groups
      .map((group) => ({
        ...group,
        items: group.items.filter(
          (item) =>
            item.label.toLowerCase().includes(keyword2) ||
            item.id.toLowerCase().includes(keyword2) ||
            (item.hint ?? "").toLowerCase().includes(keyword2)
        )
      }))
      .filter((group) => group.items.length > 0);
  }, [groups, keyword]);

  return (
    <div className="md-sel" ref={boxRef}>
      <button
        type="button"
        className={`md-sel-trigger${open ? " is-open" : ""}`}
        onClick={toggle}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {triggerMark ? <span className="md-mark">{triggerMark}</span> : null}
        <span className={`md-sel-value${current ? "" : " is-empty"}`}>
          {current?.label ?? placeholder}
        </span>
        <ChevronDown size={15} className="md-sel-caret" />
      </button>

      {open && place
        ? createPortal(
            <div
              className="md-sel-pop"
              role="listbox"
              ref={panelRef}
              style={{ left: place.left, top: place.top, width: place.width }}
            >
              <div className="md-sel-search">
                <Search size={13} />
                <input
                  ref={inputRef}
                  value={keyword}
                  placeholder={searchPlaceholder}
                  onChange={(event) => setKeyword(event.target.value)}
                />
              </div>
              <div className="md-sel-scroll">
                {filtered.length === 0 ? (
                  <p className="md-sel-empty">没有匹配项</p>
                ) : (
                  filtered.map((group) => (
                    <div key={group.title} className="md-sel-group">
                      <p className="md-sel-group-title">{group.title}</p>
                      {group.items.map((item) => (
                        <button
                          type="button"
                          key={item.id}
                          role="option"
                          aria-selected={item.id === value}
                          className={`md-sel-item${item.id === value ? " is-active" : ""}`}
                          onClick={() => {
                            onPick(item.id);
                            setOpen(false);
                          }}
                        >
                          {item.mark ? <span className="md-mark">{item.mark}</span> : null}
                          <span className="md-sel-item-label">{item.label}</span>
                          {item.hint ? <span className="md-sel-item-hint">{item.hint}</span> : null}
                          {item.id === value ? <Check size={14} className="md-sel-check" /> : null}
                        </button>
                      ))}
                    </div>
                  ))
                )}
              </div>
              {footer ? <div className="md-sel-foot">{footer}</div> : null}
            </div>,
            document.body
          )
        : null}
    </div>
  );
}

type Draft = {
  providerId: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  label: string;
  costTier: "low" | "medium" | "high";
  /** 密钥框里的内容是不是用户真改过；没改过就沿用服务端已存的那把。 */
  keyDirty: boolean;
};

/**
 * 编辑时密钥框里显示的东西。
 * 真实密钥只在服务端加密保存，前端拿不到任何片段，这里就是一段占位符：
 * 让人一眼看出「已经存过密钥」，同时一个字符也读不出来。
 */
const SAVED_KEY_MASK = "••••••••••••••••";

function draftFromModel(model: ModelProfileView | undefined): Draft {
  if (!model) {
    const first = MODEL_PROVIDERS[0];
    return {
      providerId: first.id,
      apiKey: "",
      model: first.models[0]?.id ?? "",
      baseUrl: first.baseUrl,
      label: "",
      costTier: "medium",
      keyDirty: false
    };
  }
  const provider = findProvider(model.provider);
  return {
    providerId: provider?.id ?? CUSTOM_PROVIDER_ID,
    // 已经存过密钥就摆一段掩码，而不是留个空框让人以为密钥丢了。
    apiKey: model.keySource === "stored" ? SAVED_KEY_MASK : "",
    model: model.model,
    baseUrl: model.baseUrl ?? provider?.baseUrl ?? "",
    label: model.label,
    costTier: model.costTier,
    keyDirty: false
  };
}

/** 添加 / 编辑一条模型档案。密钥只在本机加密保存，界面不回显任何片段。 */
export function ModelDialog({
  model,
  onClose,
  onSaved
}: {
  model?: ModelProfileView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = Boolean(model);
  const [draft, setDraft] = useState<Draft>(() => draftFromModel(model));
  /** 供应商预置列表里没有想要的模型时，改成手填。 */
  const [manualModel, setManualModel] = useState(() => {
    if (!model) {
      return false;
    }
    const preset = findProvider(model.provider);
    return !preset || preset.models.length === 0 || !preset.models.some((item) => item.id === model.model);
  });
  const [showKey, setShowKey] = useState(false);
  const keyInputRef = useRef<HTMLInputElement>(null);
  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [probe, setProbe] = useState<ModelProbeResult | null>(null);
  /** 按当前地址与密钥从服务方拉回来的真实模型列表。 */
  const [remote, setRemote] = useState<RemoteModelList | null>(null);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState("");

  const provider: ModelProvider = findProvider(draft.providerId) ?? MODEL_PROVIDERS[0];
  const isCustom = provider.id === CUSTOM_PROVIDER_ID;
  // 用户填过的地址优先，其次才是供应商预设；预设供应商也允许只改地址不改模型。
  const baseUrl = draft.baseUrl.trim() || provider.baseUrl;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const providerGroups: PickerGroup[] = useMemo(
    () =>
      PROVIDER_GROUPS.map((group) => ({
        title: group,
        items: MODEL_PROVIDERS.filter((item) => item.group === group).map((item) => ({
          id: item.id,
          label: item.label,
          mark: item.mark,
          hint: item.models.length ? `${item.models.length} 个模型` : undefined
        }))
      })).filter((group) => group.items.length > 0),
    []
  );

  const modelGroups: PickerGroup[] = useMemo(() => {
    const groups: PickerGroup[] = [];
    const available = remote?.ok ? new Set(remote.models) : null;
    // 拉过真实列表就把它放最前面：预置的模型名可能已经改过或对当前账号没开通。
    if (available && available.size > 0) {
      groups.push({
        title: `该密钥可用 · ${available.size} 个`,
        items: [...available].map((id) => ({ id, label: id }))
      });
    }
    // 预置项里跟真实列表重复的不再列一遍，免得同一个模型出现两行。
    const presets = provider.models.filter((item) => !available?.has(item.id));
    if (presets.length > 0) {
      groups.push({
        title: provider.label,
        items: presets.map((item) => ({
          id: item.id,
          label: item.label ?? item.id,
          hint: item.label ? item.id : undefined
        }))
      });
    }
    return groups;
  }, [provider, remote]);

  const pickProvider = (id: string) => {
    const next = findProvider(id);
    if (!next || next.id === draft.providerId) {
      return;
    }
    setProbe(null);
    setRemote(null);
    setDraft((prev) => ({
      ...prev,
      providerId: next.id,
      // 换供应商就换模型和地址；切到自定义时给一张空表让用户自己填
      model: next.models[0]?.id ?? "",
      baseUrl: next.baseUrl,
      // 显示名称跟着旧供应商走就没意义了，留给占位提示自动填
      label: "",
      // 换了家供应商，旧密钥多半用不了；掩码也一起清掉，免得看着像还能用。
      apiKey: "",
      keyDirty: false
    }));
    setManualModel(next.models.length === 0);
  };

  const modelName = draft.model.trim();
  const displayName =
    draft.label.trim() || modelName || provider.label;

  /** 只有用户真的动过密钥框才把密钥发给服务端；否则留空，由服务端沿用已存的那把。 */
  const apiKeyForRequest = draft.keyDirty ? draft.apiKey.trim() || undefined : undefined;

  const fetchRemote = async () => {
    if (!baseUrl) {
      setError("先填接口地址，再拉模型列表。");
      return;
    }
    setFetching(true);
    setError("");
    setRemote(null);
    try {
      const result = await platformApi.listRemoteModels({
        id: editing ? model?.id : undefined,
        baseUrl,
        apiKey: apiKeyForRequest
      });
      setRemote(result);
      // 手头这个模型名不在服务方列表里，多半就是它导致 Model not exist：
      // 清掉并切回下拉，免得存进去一个永远调不通的名字。
      if (result.ok && (!modelName || !result.models.includes(modelName))) {
        setManualModel(false);
        setDraft((prev) => ({ ...prev, model: "" }));
      }
    } catch (reason) {
      setRemote({
        ok: false,
        status: 0,
        models: [],
        message: reason instanceof Error ? reason.message : "拉取失败"
      });
    } finally {
      setFetching(false);
    }
  };

  const runProbe = async () => {
    if (!modelName) {
      setError("先选一个模型，再测试连接。");
      return;
    }
    if (!baseUrl) {
      setError("接口地址不能为空。");
      return;
    }
    setTesting(true);
    setError("");
    setProbe(null);
    try {
      const result = await platformApi.testModel({
        id: editing ? model?.id : undefined,
        baseUrl,
        model: modelName,
        apiKey: apiKeyForRequest
      });
      setProbe(result);
    } catch (reason) {
      setProbe({
        ok: false,
        latencyMs: 0,
        status: 0,
        message: reason instanceof Error ? reason.message : "测试失败"
      });
    } finally {
      setTesting(false);
    }
  };

  const submit = async () => {
    if (!modelName) {
      setError("模型名称不能为空。");
      return;
    }
    if (!baseUrl.trim()) {
      setError("接口地址不能为空。");
      return;
    }
    if (!editing && !draft.apiKey.trim() && !provider.keyless) {
      setError("API Key 不能为空；本地模型可以留空。");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const payload: ModelWrite = {
        label: displayName,
        provider: provider.id,
        model: modelName,
        baseUrl,
        apiKey: apiKeyForRequest,
        costTier: draft.costTier,
        description: `${provider.label} · 在设置里添加`
      };
      const id = model?.id || suggestModelId(provider.id, modelName);
      if (id) {
        payload.id = id;
      }
      await platformApi.saveModel(payload);
      onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div
      className="md-mask"
      role="dialog"
      aria-modal="true"
      aria-label={editing ? "编辑模型" : "添加模型"}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="md">
        <header className="md-head">
          <h3>{editing ? "编辑模型" : "添加模型"}</h3>
          <button type="button" className="md-close" title="关闭" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <div className="md-body">
          <div className="md-label-row">
            <label>供应商</label>
            <span className="md-label-tip">仅支持 OpenAI 兼容协议 API</span>
            {provider.docs ? (
              <a className="md-doc" href={provider.docs} target="_blank" rel="noreferrer">
                查看文档
                <ArrowUpRight size={12} />
              </a>
            ) : null}
          </div>

          <Select
            value={provider.id}
            placeholder="选择供应商"
            groups={providerGroups}
            onPick={pickProvider}
            searchPlaceholder="搜索供应商"
            triggerMark={provider.mark}
          />

          {provider.note ? <p className="md-note">{provider.note}</p> : null}

          {isCustom ? null : (
            <p className="md-endpoint">
              默认接口 <code>{provider.baseUrl}</code>
              <span>不用改，需要换就展开「高级配置」</span>
            </p>
          )}

          {isCustom ? (
            <label className="md-field">
              <span>
                接口地址
                <em>填到 /v1 即可，整条粘进来也能认</em>
              </span>
              <input
                value={draft.baseUrl}
                placeholder="https://api.example.com/v1"
                spellCheck={false}
                onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
              />
            </label>
          ) : null}

          <label className="md-field">
            <span>
              API Key
              {editing ? <em>密钥加密存本机，这里只显示掩码</em> : null}
            </span>
            <div className="md-key-row">
              <div className="md-key-input">
                <input
                  ref={keyInputRef}
                  type={showKey ? "text" : "password"}
                  value={draft.apiKey}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={
                    editing
                      ? model?.keySource === "env"
                        ? "当前用的是服务端环境变量里的密钥"
                        : "还没配密钥，填一个才能用"
                      : (provider.keyPlaceholder ?? "输入你的 API Key")
                  }
                  // 一进来就全选掩码：直接敲字就是覆盖，不改的话保持原样提交。
                  onFocus={() => {
                    if (editing && !draft.keyDirty) {
                      keyInputRef.current?.select();
                    }
                  }}
                  onChange={(event) =>
                    setDraft({ ...draft, apiKey: event.target.value, keyDirty: true })
                  }
                />
                <button
                  type="button"
                  className="md-eye"
                  title={showKey ? "隐藏" : "显示"}
                  aria-label={showKey ? "隐藏密钥" : "显示密钥"}
                  onClick={() => setShowKey((prev) => !prev)}
                >
                  {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              <button
                type="button"
                className="md-btn is-quiet"
                disabled={testing}
                onClick={() => void runProbe()}
              >
                {testing ? <Loader2 size={13} className="md-spin" /> : null}
                测试连接
              </button>
            </div>
          </label>

          {probe ? (
            <p className={`md-probe${probe.ok ? " is-ok" : " is-bad"}`}>
              {probe.ok ? <Check size={13} /> : <X size={13} />}
              {probe.message}
            </p>
          ) : null}

          <div className="md-field">
            <div className="md-field-head">
              <span>模型名称</span>
              <button
                type="button"
                className="md-inline-action"
                disabled={fetching}
                onClick={() => void fetchRemote()}
              >
                {fetching ? <Loader2 size={11} className="md-spin" /> : <RefreshCw size={11} />}
                {fetching ? "拉取中…" : "获取可用模型"}
              </button>
            </div>
            {modelGroups.length > 0 && !manualModel ? (
              <Select
                value={draft.model}
                placeholder="选择模型"
                groups={modelGroups}
                onPick={(id) => setDraft({ ...draft, model: id })}
                searchPlaceholder="搜索模型"
                footer={
                  <button
                    type="button"
                    className="md-sel-manual"
                    onClick={() => {
                      setManualModel(true);
                    }}
                  >
                    列表里没有？手动填写模型 ID
                  </button>
                }
              />
            ) : (
              <>
                <input
                  value={draft.model}
                  placeholder="输入模型 ID，例如 gpt-4o 或 qwen-plus"
                  spellCheck={false}
                  onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                />
                {modelGroups.length > 0 ? (
                  <button
                    type="button"
                    className="md-back-to-list"
                    onClick={() => {
                      setManualModel(false);
                      setDraft({ ...draft, model: provider.models[0]?.id ?? "" });
                    }}
                  >
                    从预置列表里选
                  </button>
                ) : null}
              </>
            )}
            {remote ? (
              <p className={`md-probe${remote.ok ? " is-ok" : " is-bad"}`}>
                {remote.ok ? <Check size={13} /> : <X size={13} />}
                {remote.ok
                  ? remote.models.includes(modelName)
                    ? `${remote.message}当前这个模型在列表里，可以直接测连通性。`
                    : `${remote.message}刚才那个模型名不在里面，已清空，从下拉里挑一个。`
                  : remote.message}
              </p>
            ) : null}
          </div>

          <label className="md-field">
            <span>
              显示名称
              <em>列表和对话里显示这个名字</em>
            </span>
            <input
              value={draft.label}
              placeholder={modelName || provider.label}
              maxLength={60}
              onChange={(event) => setDraft({ ...draft, label: event.target.value })}
            />
          </label>

          <button
            type="button"
            className={`md-advanced-toggle${advanced ? " is-open" : ""}`}
            onClick={() => setAdvanced((prev) => !prev)}
          >
            <ChevronDown size={13} />
            高级配置
          </button>

          {advanced ? (
            <div className="md-advanced">
              {isCustom ? null : (
                <label className="md-field">
                  <span>接口地址</span>
                  <input
                    value={draft.baseUrl}
                    placeholder={provider.baseUrl}
                    spellCheck={false}
                    onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
                  />
                </label>
              )}

              <div className="md-field">
                <span>成本档</span>
                <div className="md-tiers">
                  {(
                    [
                      ["low", "低"],
                      ["medium", "中"],
                      ["high", "高"]
                    ] as Array<[Draft["costTier"], string]>
                  ).map(([value, text]) => (
                    <button
                      type="button"
                      key={value}
                      className={`md-tier${draft.costTier === value ? " is-active" : ""}`}
                      onClick={() => setDraft({ ...draft, costTier: value })}
                    >
                      {text}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {error ? <p className="md-alert">{error}</p> : null}
        </div>

        <footer className="md-foot">
          <button type="button" className="md-btn is-quiet" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button type="button" className="md-btn is-primary" onClick={() => void submit()} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </button>
        </footer>
      </div>
    </div>,
    document.body
  );
}
