/**
 * 头像处理：浏览器里先压到 256×256、webp（不支持就 jpeg），
 * 再以 data URL 存库。服务端还有一道长度校验，这里只是让正常图片别撑爆存储。
 */

const MAX_SIDE = 256;
const MAX_DATA_URL_CHARS = 120_000;

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("这张图读不出来，换一张试试。"));
    };
    image.src = url;
  });
}

function drawSquare(image: HTMLImageElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = MAX_SIDE;
  canvas.height = MAX_SIDE;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("当前浏览器画不了图，换一个浏览器试试。");
  }
  // 居中裁成正方形，避免非 1:1 的图被拉变形
  const side = Math.min(image.naturalWidth, image.naturalHeight);
  const sx = (image.naturalWidth - side) / 2;
  const sy = (image.naturalHeight - side) / 2;
  context.drawImage(image, sx, sy, side, side, 0, 0, MAX_SIDE, MAX_SIDE);
  return canvas;
}

export async function compressAvatar(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("只能选图片文件。");
  }
  const image = await loadImage(file);
  const canvas = drawSquare(image);

  let dataUrl = canvas.toDataURL("image/webp", 0.82);
  if (!dataUrl.startsWith("data:image/webp")) {
    // 部分浏览器不支持 webp 导出，退回 jpeg
    dataUrl = canvas.toDataURL("image/jpeg", 0.86);
  }
  if (dataUrl.length <= MAX_DATA_URL_CHARS) {
    return dataUrl;
  }
  // 还是太大就再压一档，宁可糊一点也别让保存失败
  dataUrl = canvas.toDataURL("image/jpeg", 0.6);
  return dataUrl;
}
