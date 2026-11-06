const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true });
const UTF16_LE = new TextDecoder("utf-16le");
const UTF16_BE = new TextDecoder("utf-16be");
const GB18030 = new TextDecoder("gb18030");

const MAX_REPLACEMENT_RATIO = 0.005;
const MAX_CONTROL_RATIO = 0.02;
/** 严格 UTF-8 解码失败后，若大部分字节仍是合法 UTF-8 序列，更可能是文件损坏而不是 GBK。 */
const CORRUPT_UTF8_VALID_RATIO = 0.6;

export type TextEncoding = "utf-8" | "utf-16le" | "utf-16be" | "gb18030";

export type DecodedText = {
  text: string;
  encoding: TextEncoding;
  /** 非 UTF-8/UTF-16 时标记为 true，便于调用方记录导入方式。 */
  usedFallback: boolean;
};

export class TextEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TextEncodingError";
  }
}

/**
 * 归档文本统一解码：BOM → 严格 UTF-8 → GB18030。
 * 不能直接 buffer.toString("utf8")，否则 Windows 导出的 GBK/GB18030 TXT/CSV 会变成 U+FFFD。
 */
export function decodeTextBuffer(buffer: Buffer): DecodedText {
  if (buffer.length === 0) {
    return { text: "", encoding: "utf-8", usedFallback: false };
  }

  const bom = detectBom(buffer);

  if (bom === "utf-8") {
    return finish(decodeStrict(buffer.subarray(3)), "utf-8", false);
  }
  if (bom === "utf-16le") {
    return finish(UTF16_LE.decode(buffer.subarray(2)), "utf-16le", false);
  }
  if (bom === "utf-16be") {
    return finish(UTF16_BE.decode(buffer.subarray(2)), "utf-16be", false);
  }

  if (buffer.includes(0)) {
    throw new TextEncodingError("文件包含二进制内容，无法作为文本导入。");
  }

  try {
    return finish(decodeStrict(buffer), "utf-8", false);
  } catch {
    if (utf8ValidByteRatio(buffer) >= CORRUPT_UTF8_VALID_RATIO) {
      throw new TextEncodingError("文件疑似 UTF-8 编码损坏，请用 UTF-8 重新保存后再上传。");
    }
  }

  const text = GB18030.decode(buffer);
  if (replacementRatio(text) > MAX_REPLACEMENT_RATIO) {
    throw new TextEncodingError("文件编码无法识别或乱码过多，请用 UTF-8 重新保存后再上传。");
  }
  return finish(text, "gb18030", true);
}

/** 上传文件名可能被 busboy 按 latin1 解码；能无损还原时转回 UTF-8，并统一做 NFC 归一化。 */
export function normalizeUploadName(name: string): string {
  let value = name;
  if (/[\u0080-\u00ff]/.test(value)) {
    const decoded = Buffer.from(value, "latin1").toString("utf8");
    if (!decoded.includes("\uFFFD")) {
      value = decoded;
    }
  }
  const cleaned = value.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned || "未命名文档";
}

/** 对已经由 PDF/Office 解析器提取的文本做一次乱码与二进制兜底检查。 */
export function assertCleanText(text: string): void {
  const length = text.length;
  if (length === 0) {
    return;
  }
  if (replacementRatio(text) > MAX_REPLACEMENT_RATIO) {
    throw new TextEncodingError("提取到的文本包含大量乱码，请确认原文件可复制且未损坏。");
  }
  if (controlRatio(text) > MAX_CONTROL_RATIO) {
    throw new TextEncodingError("提取到的文本包含大量控制字符，请确认上传的是文本类文件。");
  }
}

function finish(text: string, encoding: TextEncoding, usedFallback: boolean): DecodedText {
  const cleaned = cleanup(text);
  assertCleanText(cleaned);
  return { text: cleaned, encoding, usedFallback };
}

function cleanup(text: string): string {
  return text
    .replace(/^\uFEFF/, "")
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "");
}

function decodeStrict(buffer: Buffer): string {
  return UTF8_STRICT.decode(buffer);
}

function detectBom(buffer: Buffer): TextEncoding | undefined {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return "utf-8";
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return "utf-16le";
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return "utf-16be";
  }
  return undefined;
}

function replacementRatio(text: string): number {
  let replacements = 0;
  for (const char of text) {
    if (char === "\uFFFD") {
      replacements += 1;
    }
  }
  return text.length === 0 ? 0 : replacements / text.length;
}

function controlRatio(text: string): number {
  let controls = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x7f || (code < 0x20 && code !== 0x09 && code !== 0x0a)) {
      controls += 1;
    }
  }
  return text.length === 0 ? 0 : controls / text.length;
}

/**
 * 统计能被严格 UTF-8 解码的有效字节占比。
 * 用于区分“损坏的 UTF-8”和真正的 GBK：GBK 文本的该比例通常低于 0.5。
 */
function utf8ValidByteRatio(buffer: Buffer): number {
  let index = 0;
  let valid = 0;
  while (index < buffer.length) {
    const byte = buffer[index];
    if (byte <= 0x7f) {
      valid += 1;
      index += 1;
      continue;
    }

    let size = 0;
    if (byte >= 0xc2 && byte <= 0xdf) {
      size = 2;
    } else if (byte >= 0xe0 && byte <= 0xef) {
      size = 3;
    } else if (byte >= 0xf0 && byte <= 0xf4) {
      size = 4;
    }

    if (size === 0 || index + size > buffer.length) {
      index += 1;
      continue;
    }

    let matched = true;
    for (let offset = 1; offset < size; offset += 1) {
      const next = buffer[index + offset];
      if (next < 0x80 || next > 0xbf) {
        matched = false;
        break;
      }
    }

    if (matched) {
      valid += size;
      index += size;
    } else {
      index += 1;
    }
  }
  return buffer.length === 0 ? 1 : valid / buffer.length;
}
