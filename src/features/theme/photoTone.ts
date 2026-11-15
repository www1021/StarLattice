/** 从背景照片里取一套界面色。
 *
 *  照片模式不再吃主题的黑白配色，而是现场读图：判断画面偏暗还是偏亮，
 *  决定该用亮字还是暗字；再取一段主体色，给卡片、侧栏、描边当同色系膜。
 *  膜是半透明的，叠在原图上颜色几乎一样，只靠「遮掉细节 + 一圈淡边」划出框，
 *  所以不会出现一块纯黑/纯白板子压在照片上。
 */

export type PhotoTone = {
  /** "r, g, b"，可直接塞进 rgba(var(--photo-tint), a)。 */
  tint: string;
  /** light = 画面暗、用亮字；dark = 画面亮、用暗字。 */
  ink: "light" | "dark";
};

const SAMPLE = 64;
/** 线性平均亮度低于这个值算「暗照片」，文字翻成亮色。 */
const INK_THRESHOLD = 0.3;
const cache = new Map<string, PhotoTone>();

function toLinear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("背景照片读取失败"));
    image.src = src;
  });
}

/** 同一张照片只算一次；data URL 很长，但 Map 里就一两条目，无所谓。 */
export async function samplePhotoTone(photo: string): Promise<PhotoTone> {
  const cached = cache.get(photo);
  if (cached) {
    return cached;
  }
  const image = await loadImage(photo);
  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE;
  canvas.height = SAMPLE;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("当前浏览器不支持图片取色");
  }
  context.drawImage(image, 0, 0, SAMPLE, SAMPLE);
  const { data } = context.getImageData(0, 0, SAMPLE, SAMPLE);

  const samples: Array<{ luma: number; r: number; g: number; b: number }> = [];
  let totalLuma = 0;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] < 128) {
      continue;
    }
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    const luma = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
    totalLuma += luma;
    samples.push({ luma, r, g, b });
  }
  if (!samples.length) {
    return { tint: "44, 46, 50", ink: "light" };
  }

  const ink: PhotoTone["ink"] = totalLuma / samples.length < INK_THRESHOLD ? "light" : "dark";

  // 取色不用全图平均：大片天空/高光会把平均值拽亮，压在暗部上就像一块灰板。
  // 按亮度排序后截一段主体区，暗图取中低段、亮图取中高段。
  samples.sort((left, right) => left.luma - right.luma);
  const [low, high] = ink === "light" ? [0.2, 0.48] : [0.4, 0.68];
  const from = Math.floor(samples.length * low);
  const to = Math.max(from + 1, Math.floor(samples.length * high));
  const slice = samples.slice(from, to);
  const average = [0, 1, 2].map((channel) =>
    slice.reduce((sum, item) => sum + [item.r, item.g, item.b][channel], 0) / slice.length
  );

  // 往灰里收一点：照片再花，界面膜也不该跟着跳成鲜艳色。
  // 只在亮照片上轻微提亮，暗照片保持原本的深度。
  const gray = (average[0] + average[1] + average[2]) / 3;
  const lift = ink === "light" ? 0.04 : 0.16;
  const tint = average
    .map((channel) => {
      const muted = channel * 0.76 + gray * 0.24;
      return Math.round(Math.min(255, Math.max(0, muted + (255 - muted) * lift)));
    })
    .join(", ");

  const tone: PhotoTone = { tint, ink };
  cache.set(photo, tone);
  return tone;
}
