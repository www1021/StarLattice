/**
 * 第二步迁移：把 rgba() 里写死的高亮底色 / 阴影 / 浅色薄层换成变量，
 * 这样深色主题下这些叠加层才不会发白。
 *   node scripts/theme-migrate-rgba.mjs
 */
import fs from "node:fs";

const FILES = [
  "src/styles.css",
  "src/features/platform/platform.css",
  "src/features/workbench/workbench.css"
];
const TOKENS = "src/styles/theme-tokens.css";

/* 一次性脚本：重复跑会把已经换好的 color-mix 再套一层，直接拦住 */
if (fs.readFileSync("src/styles.css", "utf8").includes("--rgb-surface")) {
  console.log("rgba 迁移已完成，跳过。");
  process.exit(0);
}

/* 从 token 文件里读出强调色，用来给浅色薄层找最近的颜色 */
const tokenCss = fs.readFileSync(TOKENS, "utf8");
const accentHexes = [];
for (const match of tokenCss.matchAll(/--a-([0-9a-f]{6}):/g)) {
  accentHexes.push(match[1]);
}
const accentRgb = accentHexes.map((hex) => [
  parseInt(hex.slice(0, 2), 16),
  parseInt(hex.slice(2, 4), 16),
  parseInt(hex.slice(4, 6), 16)
]);

function nearestAccent(r, g, b) {
  let best = "";
  let bestDistance = Infinity;
  accentRgb.forEach(([ar, ag, ab], index) => {
    const distance = Math.hypot(ar - r, ag - g, ab - b);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = accentHexes[index];
    }
  });
  return { hex: best, distance: bestDistance };
}

const PROPERTY_RE = /([a-z-]+)\s*:\s*[^;{}]*$/;

let surfaceCount = 0;
let shadowCount = 0;
let tintCount = 0;

for (const file of FILES) {
  let css = fs.readFileSync(file, "utf8");
  const replaced = css.replace(
    /rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/g,
    (whole, rs, gs, bs, alphaText, offset) => {
      const r = Number(rs);
      const g = Number(gs);
      const b = Number(bs);
      const alpha = Number(alphaText);
      const prefix = css.slice(Math.max(0, offset - 160), offset);
      const propertyMatch = PROPERTY_RE.exec(prefix);
      const property = propertyMatch ? propertyMatch[1] : "";
      /* 文字颜色不动：白字压在品牌色上，翻成深色就瞎了 */
      if (property === "color" || property === "text-shadow" || property === "caret-color") {
        return whole;
      }
      const avg = (r + g + b) / 3;
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      if (avg >= 200 && chroma <= 14) {
        surfaceCount += 1;
        return `rgba(var(--rgb-surface), ${alpha})`;
      }
      if (avg <= 70 && chroma <= 20) {
        shadowCount += 1;
        return `rgba(var(--rgb-shadow), ${alpha})`;
      }
      if (avg >= 200 && chroma > 14) {
        const nearest = nearestAccent(r, g, b);
        if (nearest.distance <= 34) {
          tintCount += 1;
          return `color-mix(in srgb, var(--a-${nearest.hex}) ${Math.round(alpha * 100)}%, transparent)`;
        }
      }
      return whole;
    }
  );
  fs.writeFileSync(file, replaced, "utf8");
}

console.log(`surface ${surfaceCount} / shadow ${shadowCount} / tint ${tintCount}`);
