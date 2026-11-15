import { useRef, useState } from "react";
import { ImagePlus, Layers, Trash2 } from "lucide-react";
import {
  BLEND_LABEL,
  THEME_LABEL,
  downscaleCutout,
  downscalePhoto,
  type Appearance,
  type PhotoBlend,
  type ThemeMode
} from "./appearance";

/** 主题卡上的小色块：分别代表底色 / 侧栏 / 描边，直接写死，不跟主题变量走。 */
const THEME_SWATCH: Record<ThemeMode, [string, string, string]> = {
  light: ["#ffffff", "#f7f7f8", "#e4e4e7"],
  dark: ["#131418", "#1d1f24", "#34363d"]
};

const THEME_HINT: Record<ThemeMode, string> = {
  light: "白底配浅灰侧栏，接近常见聊天智能体",
  dark: "夜间用，正文对比度按深色重新算过"
};

/** 有照片时主题不参与配色，两套卡都不可选；移除照片会回到原来选的那套。 */
const PHOTO_MODE_HINT = "背景照片已接管配色：底色、描边、字色都从照片取样，白 / 深色主题暂时不生效。移除照片后会回到上次选的主题。";

const BLEND_HINT: Record<PhotoBlend, string> = {
  soft: "照片原样清晰，只有文字那一小块被羽化蒙版托住，向外渐隐到透明",
  layered: "把主体抠图盖在标题上层，标题从主体背后穿过去，层次更真实"
};

/** 设置 · 外观页签；弹窗外壳由 SettingsDialog 提供。 */
export function AppearancePanel({
  appearance,
  onChange
}: {
  appearance: Appearance;
  onChange: (next: Appearance) => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const cutoutRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const pickTheme = (theme: ThemeMode) => {
    onChange({ ...appearance, theme });
  };

  const uploadPhoto = async (file: File | undefined) => {
    if (!file) {
      return;
    }
    if (!file.type.startsWith("image/")) {
      setError("请选择图片文件（jpg / png / webp）");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const dataUrl = await downscalePhoto(file);
      onChange({ ...appearance, photo: dataUrl });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "图片处理失败");
    } finally {
      setBusy(false);
    }
  };

  const uploadCutout = async (file: File | undefined) => {
    if (!file) {
      return;
    }
    if (!file.type.startsWith("image/")) {
      setError("请选择透明底 PNG 抠图");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const dataUrl = await downscaleCutout(file);
      onChange({ ...appearance, cutout: dataUrl });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "图片处理失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className={`ap-section${appearance.photo ? " is-photo-mode" : ""}`}>
        <div className="ap-label">
          主题
          <small>{appearance.photo ? "照片接管中" : "默认白底，随时可换"}</small>
        </div>
        <div className={`ap-themes${appearance.photo ? " is-locked" : ""}`}>
          {(["light", "dark"] as ThemeMode[]).map((mode) => (
            <button
              type="button"
              key={mode}
              className={`ap-theme${appearance.theme === mode && !appearance.photo ? " is-active" : ""}`}
              aria-pressed={appearance.theme === mode && !appearance.photo}
              disabled={Boolean(appearance.photo)}
              title={appearance.photo ? "启用背景照片时主题不生效" : undefined}
              onClick={() => pickTheme(mode)}
            >
              <span className="ap-theme-swatch">
                {THEME_SWATCH[mode].map((color) => (
                  <span key={color} style={{ background: color }} />
                ))}
              </span>
              <span className="ap-theme-name">
                {THEME_LABEL[mode]}
                {appearance.theme === mode && !appearance.photo ? <em>使用中</em> : null}
              </span>
            </button>
          ))}
        </div>
        <p className="ap-hint">{appearance.photo ? PHOTO_MODE_HINT : THEME_HINT[appearance.theme]}</p>
      </section>

      <section className="ap-section">
        <div className="ap-label">
          背景照片
          <small>原图直出，不模糊、不压暗</small>
        </div>
        <div className="ap-photo-row">
          <span
            className="ap-photo-preview"
            style={appearance.photo ? { backgroundImage: `url("${appearance.photo}")` } : undefined}
          >
            {appearance.photo ? null : "未设置"}
          </span>
          <div className="ap-photo-actions">
            <button type="button" className="ap-btn" disabled={busy} onClick={() => fileRef.current?.click()}>
              <ImagePlus size={13} />
              {busy ? "处理中…" : appearance.photo ? "换一张" : "上传图片"}
            </button>
            {appearance.photo ? (
              <button
                type="button"
                className="ap-btn is-quiet"
                onClick={() => onChange({ ...appearance, photo: null, cutout: null })}
              >
                <Trash2 size={13} />
                移除照片
              </button>
            ) : null}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(event) => {
              void uploadPhoto(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </div>

        <div className="ap-slider" style={{ marginTop: 12 }}>
          <span className="ap-label" style={{ margin: 0 }}>
            透明度
          </span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={appearance.photoOpacity}
            disabled={!appearance.photo}
            aria-label="背景照片透明度"
            onChange={(event) => onChange({ ...appearance, photoOpacity: Number(event.target.value) })}
          />
          <output>{appearance.photoOpacity}%</output>
        </div>

        <div className="ap-modes" role="radiogroup" aria-label="文字与照片的融合方式">
          {(["soft", "layered"] as PhotoBlend[]).map((mode) => (
            <button
              type="button"
              key={mode}
              role="radio"
              aria-checked={appearance.photoBlend === mode}
              className={`ap-mode${appearance.photoBlend === mode ? " is-active" : ""}`}
              onClick={() => onChange({ ...appearance, photoBlend: mode })}
            >
              <span className="ap-mode-name">
                {BLEND_LABEL[mode]}
                {mode === "layered" ? <em>高级</em> : null}
              </span>
              <span className="ap-mode-desc">{BLEND_HINT[mode]}</span>
            </button>
          ))}
        </div>

        {appearance.photoBlend === "soft" ? (
          <label className="ap-switch">
            <input
              type="checkbox"
              checked={appearance.titleBlend}
              onChange={(event) => onChange({ ...appearance, titleBlend: event.target.checked })}
            />
            <span>
              标题与画面混色
              <small>大标题用 mix-blend-mode 取画面颜色，适合对比强烈的照片</small>
            </span>
          </label>
        ) : (
          <div className="ap-cutout">
            <div className="ap-photo-row">
              <span
                className="ap-photo-preview ap-cutout-preview"
                style={appearance.cutout ? { backgroundImage: `url("${appearance.cutout}")` } : undefined}
              >
                {appearance.cutout ? null : <Layers size={16} />}
              </span>
              <div className="ap-photo-actions">
                <button
                  type="button"
                  className="ap-btn"
                  disabled={busy}
                  onClick={() => cutoutRef.current?.click()}
                >
                  <ImagePlus size={13} />
                  {appearance.cutout ? "换一张抠图" : "上传主体抠图"}
                </button>
                {appearance.cutout ? (
                  <button
                    type="button"
                    className="ap-btn is-quiet"
                    onClick={() => onChange({ ...appearance, cutout: null })}
                  >
                    <Trash2 size={13} />
                    移除
                  </button>
                ) : null}
              </div>
              <input
                ref={cutoutRef}
                type="file"
                accept="image/png,image/webp"
                hidden
                onChange={(event) => {
                  void uploadCutout(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
            </div>
            <p className="ap-hint">
              抠图要和背景照片同一构图（同一张图去掉背景、留主体，导出透明 PNG），叠上去位置才对得上。
              自动抠图要接 SAM 图像分割模型，现在先用现成的抠图工具导出。
            </p>
          </div>
        )}

        <p className={`ap-hint${error ? " is-error" : ""}`}>
          {error || "照片只存在这台机器上，不会上传；文字用局部蒙版托底，画面其余部分完全原样。"}
        </p>
      </section>
    </>
  );
}
