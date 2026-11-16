import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { KeyRound, Palette, PawPrint, RotateCcw, X } from "lucide-react";
import { AppearancePanel } from "../theme/AppearancePanel";
import { DEFAULT_APPEARANCE, type Appearance } from "../theme/appearance";
import { PetPanel } from "../pet/PetPanel";
import type { PetPreference } from "../pet/petPreferences";
import { ModelsPanel } from "./ModelsPanel";
import "./settings.css";

export type SettingsTab = "appearance" | "pet" | "models";

const TABS: Array<{ id: SettingsTab; label: string; hint: string; icon: typeof Palette }> = [
  { id: "appearance", label: "外观", hint: "主题与背景", icon: Palette },
  { id: "pet", label: "工作宠", hint: "小新陪你干活", icon: PawPrint },
  { id: "models", label: "模型与密钥", hint: "接入自己的模型", icon: KeyRound }
];

export function SettingsDialog({
  appearance,
  onChange,
  petPref,
  onPetChange,
  onClose,
  initialTab = "appearance"
}: {
  appearance: Appearance;
  onChange: (next: Appearance) => void;
  petPref: PetPreference;
  onPetChange: (next: PetPreference) => void;
  onClose: () => void;
  initialTab?: SettingsTab;
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const active = TABS.find((item) => item.id === tab) ?? TABS[0];

  return createPortal(
    <div
      className="settings-mask"
      role="dialog"
      aria-modal="true"
      aria-label="设置"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="settings-dialog">
        <aside className="settings-nav">
          <h2>设置</h2>
          {TABS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                type="button"
                key={item.id}
                className={`settings-nav-item${tab === item.id ? " is-active" : ""}`}
                aria-current={tab === item.id}
                onClick={() => setTab(item.id)}
              >
                <Icon size={14} strokeWidth={1.9} />
                <span>
                  <b>{item.label}</b>
                  <em>{item.hint}</em>
                </span>
              </button>
            );
          })}
        </aside>

        <section className="settings-main">
          <header className="settings-head">
            <div>
              <h3>{active.label}</h3>
              <p>
                {tab === "appearance"
                  ? "白/深两套主题，也可以换成自己的照片当背景"
                  : tab === "pet"
                    ? "开关工作宠、挑一只小新，再选一套它的招牌动作"
                    : "添加 OpenAI 兼容的模型，填上自己的 API Key 就能用"}
              </p>
            </div>
            <button type="button" className="settings-close" title="关闭" onClick={onClose}>
              <X size={15} />
            </button>
          </header>

          <div className="settings-body">
            {tab === "appearance" ? (
              <AppearancePanel appearance={appearance} onChange={onChange} />
            ) : tab === "pet" ? (
              <PetPanel pref={petPref} onChange={onPetChange} />
            ) : (
              <ModelsPanel />
            )}
          </div>

          <footer className="settings-foot">
            {tab === "appearance" ? (
              <button
                type="button"
                className="ap-btn is-quiet"
                onClick={() => onChange({ ...DEFAULT_APPEARANCE })}
              >
                <RotateCcw size={13} />
                恢复默认
              </button>
            ) : tab === "pet" ? (
              <small>工作宠设置按账号存本机，换设备不会同步</small>
            ) : (
              <small>密钥在本机加密保存，不会回传到浏览器</small>
            )}
            <button type="button" className="ap-btn" onClick={onClose}>
              完成
            </button>
          </footer>
        </section>
      </div>
    </div>,
    document.body
  );
}
