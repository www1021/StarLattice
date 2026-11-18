/**
 * 仅用于本地预览四种游戏卡片的排版，不参与打包入口。
 * 打开 /games-preview.html 查看；数据取自服务端真实出题结果（src/games-preview-data.json）。
 */
import { createRoot } from "react-dom/client";
import { GameCard } from "./features/games/GameCard";
import type { GameCardData } from "./features/games/types";
import mock from "./games-preview-data.json";

const games = mock as unknown as Record<GameCardData["type"], GameCardData>;

function Preview() {
  return (
    <div className="preview-wrap">
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
