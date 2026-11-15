import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Loader2, Plus, Sparkles } from "lucide-react";
import { platformApi } from "../platform/api";
import type { ModelProfileView } from "../platform/types";
import { findProvider } from "./modelProviders";

type Place = { left: number; bottom: number; width: number };

/**
 * 输入框下方的模型选择。
 * 只列「已经填了密钥」的模型 —— 选一个跑不通的配置比不显示更糟。
 */
export function ModelPicker({
  value,
  onChange,
  onOpenSettings
}: {
  value: string;
  onChange: (id: string) => void;
  onOpenSettings?: () => void;
}) {
  const [models, setModels] = useState<ModelProfileView[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<Place | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const data = await platformApi.listModels();
      setModels(data.models.filter((model) => model.configured));
    } catch {
      setModels([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const active = useMemo(
    () => models.find((model) => model.id === value) ?? models.find((model) => model.isDefault) ?? models[0],
    [models, value]
  );

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    setPlace({
      left: Math.max(12, Math.min(rect.left, window.innerWidth - 312)),
      bottom: window.innerHeight - rect.top + 8,
      width: 300
    });
    setOpen(true);
    // 每次打开都刷一遍，设置里刚加的模型立刻能选。
    void load();
  };

  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      const node = event.target as Node;
      if (!triggerRef.current?.contains(node) && !panelRef.current?.contains(node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    // 面板自己滚动（模型多的时候滚轮翻）不算页面动了，别一滚就关
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
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("scroll", handleScroll, true);
    };
  }, [open]);

  const label = active?.label ?? (loading ? "读取模型…" : "未配置模型");

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`composer-model${open ? " is-open" : ""}${active ? "" : " is-empty"}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={active ? `本轮使用 ${active.label}` : "还没有可用的模型，点这里添加一个"}
        onClick={toggle}
      >
        {loading ? <Loader2 size={13} className="is-spinning" /> : <Sparkles size={13} strokeWidth={1.9} />}
        <span>{label}</span>
        <ChevronDown size={13} strokeWidth={2} />
      </button>

      {open && place
        ? createPortal(
            <div
              className="composer-model-pop"
              role="listbox"
              ref={panelRef}
              style={{ left: place.left, bottom: place.bottom, width: place.width }}
            >
              <p className="composer-model-title">本轮使用</p>
              {models.length === 0 ? (
                <p className="composer-model-empty">
                  {loading ? "正在读取…" : "这个账号还没有可用的模型，先填一个 API Key。别的账号的模型不会带过来。"}
                </p>
              ) : (
                models.map((model) => (
                  <button
                    type="button"
                    key={model.id}
                    role="option"
                    aria-selected={model.id === active?.id}
                    className={`composer-model-item${model.id === active?.id ? " is-active" : ""}`}
                    onClick={() => {
                      onChange(model.id);
                      setOpen(false);
                    }}
                  >
                    <span className="composer-model-mark">
                      {findProvider(model.provider)?.mark ?? (model.label.trim()[0] ?? "·")}
                    </span>
                    <span className="composer-model-text">
                      <b>{model.label}</b>
                      <small>{model.model}</small>
                    </span>
                    {model.id === active?.id ? <Check size={14} /> : null}
                  </button>
                ))
              )}
              {onOpenSettings ? (
                <button
                  type="button"
                  className="composer-model-foot"
                  onClick={() => {
                    setOpen(false);
                    onOpenSettings();
                  }}
                >
                  <Plus size={13} />
                  添加或管理模型
                </button>
              ) : null}
            </div>,
            document.body
          )
        : null}
    </>
  );
}
