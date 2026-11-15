/** 外观偏好：主题、自定义背景照片、照片透明度、文字与照片的融合方式。
 *  存在本机 localStorage，按登录账号分键，不上传；未登录时只保留一份不含照片的外观。
 *  主题与背景照片是互斥的两套配色：没照片时按白/深色主题走；一有照片，
 *  界面色（底色、描边、字色）全部由照片取样结果接管，主题选择不再生效。 */

import { samplePhotoTone } from "./photoTone";
import { APPEARANCE_STORAGE_KEY, accountStorage } from "../auth/accountStorage";

export type ThemeMode = "light" | "dark";

/** soft = 局部渐变蒙版 + 文字柔光（默认）；layered = 主体抠图盖在文字上层 */
export type PhotoBlend = "soft" | "layered";

export type Appearance = {
  theme: ThemeMode;
  /** 背景照片，压过的小图 data URL；null 表示没有。 */
  photo: string | null;
  /** 照片透明度 0-100。 */
  photoOpacity: number;
  /** 融合方式。 */
  photoBlend: PhotoBlend;
  /** 主体抠图（透明 PNG data URL），layered 模式下压在文字上层。 */
  cutout: string | null;
  /** 标题是否用 mix-blend-mode 真正跟画面混色。 */
  titleBlend: boolean;
};

const STORAGE_KEY = APPEARANCE_STORAGE_KEY;
const MAX_PHOTO_EDGE = 1800;
const MAX_CUTOUT_EDGE = 1800;

export const DEFAULT_APPEARANCE: Appearance = {
  theme: "light",
  photo: null,
  photoOpacity: 86,
  photoBlend: "soft",
  cutout: null,
  titleBlend: false
};

export const THEME_LABEL: Record<ThemeMode, string> = {
  light: "白",
  dark: "深色"
};

export const BLEND_LABEL: Record<PhotoBlend, string> = {
  soft: "柔和融合",
  layered: "主体分层"
};

export function readAppearance(): Appearance {
  try {
    const raw = accountStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULT_APPEARANCE;
    }
    const parsed = JSON.parse(raw) as Partial<Appearance>;
    // 老版本存过 "paper"，现在只有白/深色两套，遇到就直接回落到白。
    const theme: ThemeMode = parsed.theme === "dark" ? "dark" : DEFAULT_APPEARANCE.theme;
    // 没有 photoBlend 说明是薄纱时代存下来的，那时的 72% 是「压着一层纱」调出来的，
    // 现在照片是原图直出，太淡反而像没铺满，顺手抬到新默认值。
    const legacyPhoto = parsed.photoBlend === undefined;
    const storedOpacity =
      typeof parsed.photoOpacity === "number" && Number.isFinite(parsed.photoOpacity)
        ? Math.max(0, Math.min(100, parsed.photoOpacity))
        : DEFAULT_APPEARANCE.photoOpacity;
    return {
      theme,
      photo: typeof parsed.photo === "string" && parsed.photo.startsWith("data:") ? parsed.photo : null,
      photoOpacity: legacyPhoto
        ? Math.max(storedOpacity, DEFAULT_APPEARANCE.photoOpacity)
        : storedOpacity,
      photoBlend: parsed.photoBlend === "layered" ? "layered" : "soft",
      cutout: typeof parsed.cutout === "string" && parsed.cutout.startsWith("data:") ? parsed.cutout : null,
      titleBlend: parsed.titleBlend === true
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function persistAppearance(next: Appearance): boolean {
  try {
    accountStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

/** 防止旧照片的异步取色结果盖到新照片上。 */
let toneToken = 0;

/** 把偏好写到 <html> 上，CSS 全靠几个 data-* 开关。
 *  照片取色要解码图片，是异步的：先按主题给一个中性兜底色，取完再换，
 *  避免切图那一帧闪出纯白/纯黑。 */
export function applyAppearance(next: Appearance) {
  const root = document.documentElement;
  const token = ++toneToken;
  root.dataset.theme = next.theme;
  root.dataset.photo = next.photo ? "on" : "off";
  root.dataset.photoBlend = next.photoBlend;
  root.dataset.titleBlend = next.titleBlend ? "blend" : "plain";
  if (next.photo) {
    root.style.setProperty("--app-photo", `url("${next.photo}")`);
  } else {
    root.style.removeProperty("--app-photo");
  }
  if (next.cutout) {
    root.style.setProperty("--app-photo-cutout", `url("${next.cutout}")`);
  } else {
    root.style.removeProperty("--app-photo-cutout");
  }
  root.style.setProperty("--app-photo-opacity", String(Math.max(0, Math.min(100, next.photoOpacity)) / 100));

  if (!next.photo) {
    root.removeAttribute("data-photo-ink");
    root.style.removeProperty("--photo-tint");
    return;
  }

  root.style.setProperty("--photo-tint", next.theme === "dark" ? "44, 46, 50" : "236, 237, 239");
  root.dataset.photoInk = next.theme === "dark" ? "light" : "dark";
  void samplePhotoTone(next.photo)
    .then((tone) => {
      if (token !== toneToken) {
        return;
      }
      root.style.setProperty("--photo-tint", tone.tint);
      root.dataset.photoInk = tone.ink;
    })
    .catch(() => {
      // 取色失败就留着兜底色，界面不至于崩。
    });
}

/**
 * 把用户选的图压到 1800px 以内再存 data URL：原图动辄好几 MB，
 * 直接塞 localStorage 会超配额，压完通常只剩几百 KB。
 */
export async function downscalePhoto(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_PHOTO_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("当前浏览器不支持图片处理");
  }
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.86);
}

/**
 * 主体抠图必须保住透明通道，所以走 PNG；PNG 体积大，先按 1600px 收一遍。
 */
export async function downscaleCutout(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_CUTOUT_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("当前浏览器不支持图片处理");
  }
  context.clearRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvas.toDataURL("image/png");
}
