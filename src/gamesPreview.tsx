/**
 * 仅用于本地预览四种游戏卡片的排版，不参与打包入口。
 * 打开 /games-preview.html 查看；数据取自服务端真实出题结果（src/games-preview-data.json）。
 */
import { createRoot } from "react-dom/client";
import "../styles.css";
import "../styles/theme-tokens.css";
import "../styles/theme.css";
import { GameCard } from "./features/games/GameCard";
import { GameRail } from "./features/games/GameRail";
import type { GameCardData } from "./features/games/types";
import mock from "./games-preview-data.json";

const games = mock as unknown as Record<GameCardData["type"], GameCardData>;

function Preview() {
  return (
    <div className="preview-wrap">
      <div className="preview-block">
        <p className="preview-label">聊天里的入口条（空状态与智能体条下都用它）</p>
        <GameRail onPick={(entry) => console.log("pick:", entry)} />
      </div>
      {(Object.keys(games) as GameCardData["type"][]).map((type) => (
        <div className="preview-block" key={type}>
          <p className="preview-label">type = {type}</p>
          <GameCard game={games[type]} onAsk={(text) => console.log("ask:", text)} />
        </div>
      ))}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
