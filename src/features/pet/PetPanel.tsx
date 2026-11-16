import { Sparkles } from "lucide-react";
import { MOTIONS, SELECTABLE_CAST, castById, type MotionId } from "./petCast";
import type { PetPreference } from "./petPreferences";
import "./petPanel.css";

/** 设置 · 工作宠页签；弹窗外壳由 SettingsDialog 提供。
 *  开启开关、选哪只小新、选哪套动作，全部即时生效并写回本机偏好。 */
export function PetPanel({
  pref,
  onChange
}: {
  pref: PetPreference;
  onChange: (next: PetPreference) => void;
}) {
  const current = castById(pref.castId);
  const motion = MOTIONS.find((item) => item.id === pref.motionId) ?? MOTIONS[0];

  const chooseCast = (castId: string) => {
    const cast = castById(castId);
    // 换角色时默认套用它的专属动作，用户之后可以再单独改动作
    onChange({ ...pref, castId, motionId: cast.motion });
  };

  return (
    <div className="pet-settings">
      <label className="ap-switch pet-enable-switch">
        <input
          type="checkbox"
          checked={pref.enabled}
          onChange={(event) => onChange({ ...pref, enabled: event.target.checked })}
        />
        <span>
          显示工作宠
          <small>关闭后对话页不再显示小新，正文恢复满宽</small>
        </span>
      </label>

      <div className={`pet-settings-body${pref.enabled ? "" : " is-disabled"}`}>
        <div className="ap-section">
          <div className="ap-label">
            <span>选一只小新</span>
            <small>每只都有自己的一套表情和专属动作</small>
          </div>
          <div className="pet-cast-grid">
            {SELECTABLE_CAST.map((cast) => {
              const active = cast.id === pref.castId;
              return (
                <button
                  type="button"
                  key={cast.id}
                  className={`pet-cast-card${active ? " is-active" : ""}`}
                  onClick={() => chooseCast(cast.id)}
                  aria-pressed={active}
                >
                  <span className="pet-cast-thumb">
                    <img src={cast.poses.idle.src} alt="" />
                  </span>
                  <span className="pet-cast-name">{cast.name}</span>
                  <span className="pet-cast-tag">{cast.tagline}</span>
                  {active ? (
                    <span className="pet-cast-check">
                      <Sparkles size={13} />
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        <div className="ap-section">
          <div className="ap-label">
            <span>专属动作</span>
            <small>待机时小新的招牌动作，换角色会自动切到它的专属款</small>
          </div>
          <div className="pet-motion-grid">
            {MOTIONS.map((item) => {
              const active = item.id === pref.motionId;
              const isSignature = item.id === current.motion;
              return (
                <button
                  type="button"
                  key={item.id}
                  className={`pet-motion-card${active ? " is-active" : ""}`}
                  onClick={() => onChange({ ...pref, motionId: item.id as MotionId })}
                  aria-pressed={active}
                >
                  <b>{item.label}</b>
                  <small>{item.hint}</small>
                  {isSignature ? <em>{current.name}的专属</em> : null}
                </button>
              );
            })}
          </div>
        </div>

        <p className="pet-settings-note">
          当前：{current.name} · {motion.label}。工作宠只在你对话时活动，不会挡住消息；点它一下还会眨眼。
        </p>
      </div>
    </div>
  );
}
