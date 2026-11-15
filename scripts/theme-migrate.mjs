/**
 * 一次性配色迁移：把三份样式表里写死的中性色 / 强调色换成 CSS 变量，
 * 并按「浅色（默认白）/ 深色 / 暖纸」三套主题生成变量取值。
 *
 * 只跑一次；产物 src/styles/theme-tokens.css 之后由人维护。
 *   node scripts/theme-migrate.mjs
 */
import fs from "node:fs";

const ROOT = "src";
const FILES = [
  `${ROOT}/styles.css`,
  `${ROOT}/features/platform/platform.css`,
  `${ROOT}/features/workbench/workbench.css`
];
const OUT = `${ROOT}/styles/theme-tokens.css`;

/* 一次性脚本：token 文件已存在就停手，否则会用已迁移过的样式重算，把变量值算废 */
if (fs.existsSync(OUT)) {
  console.log(`${OUT} 已存在，跳过迁移。`);
  process.exit(0);
}

/* ---------- 颜色工具 ---------- */

function expandHex(hex) {
  const body = hex.slice(1);
  if (body.length === 3) {
    return `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`;
  }
  return hex.toLowerCase();
}

function toRgb(hex) {
  const body = hex.slice(1);
  return [
    parseInt(body.slice(0, 2), 16),
    parseInt(body.slice(2, 4), 16),
    parseInt(body.slice(4, 6), 16)
  ];
}

function toHsl(hex) {
  const [r, g, b] = toRgb(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2 / 255;
  const chroma = max - min;
  let h = 0;
  let s = 0;
  if (chroma !== 0) {
    s = l > 0.5 ? chroma / (510 - max - min) : chroma / (max + min);
    if (max === r) {
      h = ((g - b) / chroma + (g < b ? 6 : 0)) * 60;
    } else if (max === g) {
      h = ((b - r) / chroma + 2) * 60;
    } else {
      h = ((r - g) / chroma + 4) * 60;
    }
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100), chroma };
}

function hsl(h, s, l) {
  return `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l * 10) / 10}%)`;
}

/** 中性色：低饱和，或者暖灰（咖啡／米色这种色相在 22-50 之间但饱和度不高）。 */
function isNeutral(hslValue) {
  const { h, s, chroma } = hslValue;
  if (s <= 12 || chroma <= 12) return true;
  return h >= 20 && h <= 52 && s <= 30;
}

/* ---------- 亮度分档 ---------- */

function bucketOf(l) {
  if (l >= 96) return Math.round(l);
  if (l >= 88) return Math.round(l / 2) * 2;
  if (l >= 60) return Math.round(l / 3) * 3;
  return Math.round(l / 3) * 3;
}

/** 浅色主题：保持层次，整体抬到接近纯白。 */
function lightLevel(l) {
  if (l >= 95) return l + (100 - l) * 0.62;
  if (l >= 88) return l + 3.4;
  if (l >= 80) return l + 1.6;
  if (l >= 60) return l;
  if (l >= 40) return l - 1.6;
  return l - 1;
}

/** 深色主题：明暗翻转，用分段锚点让表面、边框、文字各自落到舒服的区间。 */
const DARK_ANCHORS = [
  [100, 10], [98, 11], [96, 12.5], [94, 14], [92, 15.5], [90, 17], [88, 19],
  [86, 21], [84, 23], [82, 25], [80, 27], [78, 29], [74, 33], [70, 36],
  [66, 40], [62, 44], [58, 49], [54, 54], [50, 59], [46, 64], [42, 69],
  [38, 74], [34, 78], [30, 82], [26, 85], [22, 88], [18, 90], [14, 92],
  [10, 93.5], [6, 95], [0, 96]
];

function darkLevel(l) {
  if (l >= DARK_ANCHORS[0][0]) return DARK_ANCHORS[0][1];
  for (let i = 0; i < DARK_ANCHORS.length - 1; i += 1) {
    const [l1, v1] = DARK_ANCHORS[i];
    const [l2, v2] = DARK_ANCHORS[i + 1];
    if (l <= l1 && l >= l2) {
      const ratio = (l1 - l) / (l1 - l2);
      return v1 + (v2 - v1) * ratio;
    }
  }
  return 96;
}

/* ---------- 收集颜色 ---------- */

const counts = new Map();
for (const file of FILES) {
  const css = fs.readFileSync(file, "utf8");
  for (const match of css.matchAll(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g)) {
    const hex = expandHex(match[0]);
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
}

const neutralBuckets = new Map(); // bucket -> { total, sample }
const accents = new Map(); // hex -> count

for (const [hex, count] of counts) {
  const value = toHsl(hex);
  if (isNeutral(value)) {
    const bucket = bucketOf(value.l);
    const current = neutralBuckets.get(bucket);
    if (!current) {
      neutralBuckets.set(bucket, { total: count, sample: hex, sampleCount: count });
    } else {
      current.total += count;
      if (count > current.sampleCount) {
        current.sample = hex;
        current.sampleCount = count;
      }
    }
  } else {
    accents.set(hex, count);
  }
}

/* ---------- 生成变量 ---------- */

const neutralKeys = [...neutralBuckets.keys()].sort((a, b) => b - a);

const paperLines = [];
const lightLines = [];
const darkLines = [];

for (const key of neutralKeys) {
  const { sample } = neutralBuckets.get(key);
  const value = toHsl(sample);
  paperLines.push(`  --n-${key}: ${sample};`);
  lightLines.push(`  --n-${key}: ${hsl(220, value.l > 55 ? 6 : 4, lightLevel(key))};`);
  darkLines.push(`  --n-${key}: ${hsl(220, value.l > 55 ? 9 : 6, darkLevel(key))};`);
}

const accentKeys = [...accents.keys()].sort((a, b) => accents.get(b) - accents.get(a));
for (const hex of accentKeys) {
  const value = toHsl(hex);
  let dark;
  if (value.l >= 88) {
    dark = hsl(value.h, Math.min(value.s, 76), 12 + (100 - value.l) * 0.45);
  } else if (value.l <= 45) {
    dark = hsl(value.h, Math.min(value.s, 82), Math.min(82, value.l + 26));
  } else {
    dark = hex;
  }
  paperLines.push(`  --a-${hex.slice(1)}: ${hex};`);
  lightLines.push(`  --a-${hex.slice(1)}: ${hex};`);
  darkLines.push(`  --a-${hex.slice(1)}: ${dark};`);
}

const tokens = `/* 自动生成：由 scripts/theme-migrate.mjs 从原始配色推导，勿手改。
   中性色按明度分档 --n-<明度>；强调色保留原色值 --a-<hex>。 */
:root,
:root[data-theme="light"] {
${lightLines.join("\n")}
}

:root[data-theme="paper"] {
${paperLines.join("\n")}
}

:root[data-theme="dark"] {
${darkLines.join("\n")}
}
`;

fs.mkdirSync(`${ROOT}/styles`, { recursive: true });
fs.writeFileSync(OUT, tokens, "utf8");
console.log(`tokens: ${neutralKeys.length} neutral + ${accentKeys.length} accent -> ${OUT}`);

/* ---------- 替换样式表 ---------- */

const hexToVar = new Map();
for (const [hex] of counts) {
  const value = toHsl(hex);
  if (isNeutral(value)) {
    hexToVar.set(hex, `var(--n-${bucketOf(value.l)})`);
  } else {
    hexToVar.set(hex, `var(--a-${hex.slice(1)})`);
  }
}

let replaced = 0;
for (const file of FILES) {
  let css = fs.readFileSync(file, "utf8");
  css = css.replace(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g, (match) => {
    const token = hexToVar.get(expandHex(match));
    if (!token) return match;
    replaced += 1;
    return token;
  });
  css = css.replace(/rgba\(255,\s*254,\s*251,/g, "rgba(var(--rgb-surface),");
  css = css.replace(/rgba\(36,\s*40,\s*41,/g, "rgba(var(--rgb-shadow),");
  fs.writeFileSync(file, css, "utf8");
}
console.log(`replaced ${replaced} color literals`);
