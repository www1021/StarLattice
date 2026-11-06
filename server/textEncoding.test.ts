import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeTextBuffer,
  normalizeUploadName,
  TextEncodingError
} from "./textEncoding.js";

test("decodes UTF-8 with and without BOM", () => {
  const plain = decodeTextBuffer(Buffer.from("分数的意义", "utf8"));
  assert.equal(plain.text, "分数的意义");
  assert.equal(plain.encoding, "utf-8");
  assert.equal(plain.usedFallback, false);

  const withBom = decodeTextBuffer(
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("分数的意义", "utf8")])
  );
  assert.equal(withBom.text, "分数的意义");
  assert.equal(withBom.encoding, "utf-8");
});

test("decodes GBK text exported from Windows as GB18030", () => {
  const buffer = Buffer.from([
    0xc4, 0xe3, 0xba, 0xc3, 0xa3, 0xac, 0xca, 0xc0, 0xbd, 0xe7
  ]);
  const decoded = decodeTextBuffer(buffer);
  assert.equal(decoded.text, "你好，世界");
  assert.equal(decoded.encoding, "gb18030");
  assert.equal(decoded.usedFallback, true);
});

test("decodes UTF-16 text with BOM", () => {
  const utf16le = decodeTextBuffer(Buffer.from([0xff, 0xfe, 0x60, 0x4f, 0x7d, 0x59]));
  assert.equal(utf16le.text, "你好");
  assert.equal(utf16le.encoding, "utf-16le");

  const utf16be = decodeTextBuffer(Buffer.from([0xfe, 0xff, 0x4f, 0x60, 0x59, 0x7d]));
  assert.equal(utf16be.text, "你好");
  assert.equal(utf16be.encoding, "utf-16be");
});

test("normalizes line endings and NFC composition", () => {
  const decoded = decodeTextBuffer(Buffer.from("第一行\r\n第二行\r第三行 e\u0301", "utf8"));
  assert.equal(decoded.text, "第一行\n第二行\n第三行 é");
});

test("rejects binary buffers and corrupted UTF-8 instead of silently producing U+FFFD", () => {
  assert.throws(
    () => decodeTextBuffer(Buffer.from([0x50, 0x4b, 0x00, 0x01, 0x02])),
    TextEncodingError
  );

  const valid = Buffer.from("初中数学分数的意义", "utf8");
  const corrupted = Buffer.concat([valid.subarray(0, valid.length - 1), Buffer.from([0xff])]);
  assert.throws(() => decodeTextBuffer(corrupted), /UTF-8 编码损坏/);
});

test("restores Chinese upload names decoded as latin1", () => {
  const mojibake = Buffer.from("分数.txt", "utf8").toString("latin1");
  assert.equal(normalizeUploadName(mojibake), "分数.txt");
  assert.equal(normalizeUploadName("  lesson\u0000.txt  "), "lesson.txt");
  assert.equal(normalizeUploadName("\u0001"), "未命名文档");
});
