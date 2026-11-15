import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Loader2, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { platformApi } from "../platform/api";
import type { ModelProfileView } from "../platform/types";
import { ModelDialog } from "./ModelDialog";
import { findProvider, providerLabel } from "./modelProviders";

/** 用供应商的单字标记对齐左侧，长列表里扫起来比纯文字快。 */
function markOf(model: ModelProfileView): string {
  const preset = findProvider(model.provider);
  if (preset) {
    return preset.mark;
  }
  return (model.label.trim()[0] ?? "·").toUpperCase();
}

/** 自建模型回传了接口地址，用它显示上游域名，比重复一遍模型名有用。 */
function hostOf(url?: string): string {
  if (!url) {
    return "";
  }
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** 设置 · 模型与密钥。整行点一下就切到这条模型，密钥一个字符都不显示。 */
export function ModelsPanel() {
  const [models, setModels] = useState<ModelProfileView[]>([]);
  const [defaultModelId, setDefaultModelId] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [dialog, setDialog] = useState<{ model?: ModelProfileView } | null>(null);

  const reload = async () => {
    try {
      const data = await platformApi.listModels();
      setModels(data.models);
      setDefaultModelId(data.defaultModelId);
      setLoadError("");
    } catch (reason) {
      setLoadError(reason instanceof Error ? reason.message : "读取模型列表失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const sorted = useMemo(() => {
    // 正在用的那条置顶，其余保持后端顺序。
    const copy = [...models];
    copy.sort((left, right) => Number(right.isDefault) - Number(left.isDefault));
    return copy;
  }, [models]);

  const active = models.find((model) => model.isDefault);

  const pick = async (model: ModelProfileView) => {
    if (model.isDefault || busyId) {
      return;
    }
    setBusyId(model.id);
    // 先本地切过去，点下去立刻有反馈，失败再回滚。
    setModels((current) =>
      current.map((item) => ({ ...item, isDefault: item.id === model.id }))
    );
    try {
      await platformApi.setDefaultModel(model.id);
      setDefaultModelId(model.id);
      setLoadError("");
    } catch (reason) {
      setLoadError(reason instanceof Error ? reason.message : "切换模型失败");
      await reload();
    } finally {
      setBusyId("");
    }
  };

  const removeModel = async (model: ModelProfileView) => {
    if (!window.confirm(`删除「${model.label}」？保存的密钥会一起删掉。`)) {
      return;
    }
    setBusyId(model.id);
    try {
      await platformApi.deleteModel(model.id);
      await reload();
    } catch (reason) {
      setLoadError(reason instanceof Error ? reason.message : "删除失败");
    } finally {
      setBusyId("");
    }
  };

  if (loading) {
    return (
      <div className="mp-loading">
        <Loader2 size={15} className="mp-spin" />
        正在读取模型配置…
      </div>
    );
  }

  return (
    <div className="mp">
      <div className="mp-head">
        <div className="mp-head-text">
          <b>已接入的模型</b>
          <small>
            {models.length
              ? `共 ${models.length} 个，当前使用 ${active?.label ?? "—"}`
              : "还没有接入任何模型"}
          </small>
        </div>
        <button type="button" className="mp-add" onClick={() => setDialog({})}>
          <Plus size={14} />
          添加模型
        </button>
      </div>

      {loadError ? (
        <p className="mp-alert is-bad">
          <AlertCircle size={13} />
          {loadError}
        </p>
      ) : null}

      {models.length === 0 ? (
        <div className="mp-empty">
          <b>先接入一个模型</b>
          <p>
            选一个供应商，填上自己的 API Key 就能用。密钥按账号单独加密保存，别的账号既看不到也用不了，界面和接口都不会回显。
          </p>
          <button type="button" className="mp-add" onClick={() => setDialog({})}>
            <Plus size={14} />
            添加第一个模型
          </button>
        </div>
      ) : (
        <ul className="mp-list">
          {sorted.map((model) => {
            const host = hostOf(model.baseUrl);
            // 模型只可能来自设置面板，每一行都能点。
            const manageable = true;
            return (
              <li
                key={model.id}
                className={`mp-item${model.isDefault ? " is-default" : ""}${
                  busyId === model.id ? " is-busy" : ""
                }${manageable ? "" : " is-locked"}`}
                role="button"
                tabIndex={model.isDefault || !manageable ? -1 : 0}
                aria-pressed={model.isDefault}
                title={model.isDefault ? "当前正在使用" : `点击使用 ${model.label}`}
                onClick={() => {
                  if (manageable) {
                    void pick(model);
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    if (manageable) {
                      void pick(model);
                    }
                  }
                }}
              >
                <span className="mp-mark">{markOf(model)}</span>

                <div className="mp-item-body">
                  <div className="mp-item-title">
                    <b>{model.label}</b>
                    {model.isDefault ? <span className="mp-tag">使用中</span> : null}
                    {model.configured ? null : <span className="mp-tag is-warn">缺密钥</span>}
                  </div>
                  <div className="mp-item-sub">
                    <span>{providerLabel(model.provider)}</span>
                    <code>{model.model}</code>
                    {host ? <span className="mp-item-host">{host}</span> : null}
                  </div>
                </div>

                <div className="mp-item-actions">
                  {manageable ? (
                    <>
                      <button
                        type="button"
                        className="mp-icon"
                        title="修改"
                        aria-label={`修改 ${model.label}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setDialog({ model });
                        }}
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        type="button"
                        className="mp-icon is-danger"
                        title="删除"
                        aria-label={`删除 ${model.label}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          void removeModel(model);
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="mp-note">
        点一下某一行就切到那条模型，对话和画布节点会自动跟着用。密钥用 AES-256-GCM
        加密后按账号存在本机，接口只回「已配置 / 缺密钥」，不回传任何片段。
      </p>

      {models.length ? (
        <div className="mp-hint">
          <Sparkles size={14} strokeWidth={1.8} />
          <p>
            默认模型会用在对话、画布节点和校验器上；某个节点想单独换一条，在节点面板的「模型」里选。
          </p>
        </div>
      ) : null}

      {dialog ? (
        <ModelDialog
          model={dialog.model}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void reload();
          }}
        />
      ) : null}
    </div>
  );
}
