/**
 * 仅用于本地预览游戏卡片的排版，不参与打包入口。
 * 打开 /games-preview.html 查看；数据取自服务端真实出题结果（src/games-preview-data.json）。
 */
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./styles/theme-tokens.css";
import "./styles/theme.css";
import { GameCard } from "./features/games/GameCard";
import { GameRail } from "./features/games/GameRail";
import type { GameCardData } from "./features/games/types";
import mock from "./games-preview-data.json";

const bag = mock as unknown as Record<string, GameCardData>;

/** 预览顺序按学科排，方便一屏看出六种玩法的视觉差异。 */
const ORDER: Array<{ key: string; label: string }> = [
  { key: "math_sprint", label: "数学 · 速算（四选一）" },
  { key: "twenty_four", label: "数学 · 24 点" },
  { key: "sudoku", label: "数学 · 数独" },
  { key: "poetry_order_easy", label: "语文 · 诗句拼句（五言，预填首字）" },
  { key: "poetry_order_hard", label: "语文 · 诗句接句（给上句拼下句）" },
  { key: "flying_flower", label: "语文 · 飞花令" },
  { key: "word_spell", label: "英语 · 单词拼写" }
];

function Preview() {
  return (
    <div className="preview-wrap">
      <div className="preview-block">
        <p className="preview-label">聊天里的入口条（空状态与智能体条下都用它）</p>
        <GameRail onPick={(entry) => console.log("pick:", entry)} />
      </div>
      {ORDER.filter((item) => bag[item.key]).map((item) => (
        <div className="preview-block" key={item.key}>
          <p className="preview-label">{item.label}</p>
          <GameCard game={bag[item.key]} onAsk={(text) => console.log("ask:", text)} />
        </div>
      ))}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
