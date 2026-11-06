import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const skipDirs = new Set([
  "node_modules",
  ".git",
  "dist",
  ".npm-cache",
  "generated",
  "_archive",
  "ref_render"
]);
const textExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".json",
  ".css",
  ".html",
  ".md",
  ".txt",
  ".csv",
  ".yml",
  ".yaml",
  ".sql",
  ".sh"
]);
// 用转义写法，避免检查脚本本身被标记为乱码。
const mojibakeMarkers = [
  "\u951f\u65a4\u62f7",
  "\u00ef\u00bc",
  "\u00e2\u20ac",
  "\u00c3\u00a4",
  "\u00c3\u00a9",
  "\u00e6\u2022",
  "\u00e9\u00a3",
  "\uFFFD"
];

const problems = [];

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) {
        walk(path.join(directory, entry.name));
      }
      continue;
    }
    if (!entry.isFile() || !textExtensions.has(path.extname(entry.name).toLowerCase())) {
      continue;
    }
    if (entry.name === "package-lock.json") {
      continue;
    }
    checkFile(path.join(directory, entry.name));
  }
}

function checkFile(filePath) {
  const relative = path.relative(root, filePath);
  if (relative.includes("\uFFFD")) {
    problems.push(`${relative}: 文件名包含 U+FFFD`);
  }

  const buffer = readFileSync(filePath);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    problems.push(`${relative}: 不是合法 UTF-8`);
    return;
  }

  const marker = mojibakeMarkers.find((item) => text.includes(item));
  if (marker) {
    problems.push(`${relative}: 包含乱码特征 ${JSON.stringify(marker)}`);
    return;
  }

  if (text.includes("\r\n")) {
    problems.push(`${relative}: 包含 CRLF，请统一为 LF`);
  }
}

walk(root);

if (problems.length > 0) {
  console.error(`编码检查未通过（${problems.length} 个文件）：`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

console.log("编码检查通过：文本文件均为 UTF-8 / LF，未发现乱码特征。");
