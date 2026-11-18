import type { GameCardData } from "./types";
import { GAME_BADGES, GAME_ICONS } from "./meta";
import { MathSprintCard } from "./MathSprintCard";
import { TwentyFourCard } from "./TwentyFourCard";
import { SudokuCard } from "./SudokuCard";
import { FlyingFlowerCard } from "./FlyingFlowerCard";
import "./games.css";

/**
 * 游戏卡片：按类型分派到具体玩法。
 * 卡片里的交互全在前端完成，只有飞花令要回服务端查诗库。
 */
export function GameCard({
  game,
  onAsk
}: {
  game: GameCardData;
  /** 结算后的「讲讲错题 / 再来一局」把一句话发回聊天，交给智能体接。 */
  onAsk?: (text: string) => void;
}) {
  const Icon = GAME_ICONS[game.type];
  return (
    <section className="game-card" data-game={game.type}>
      <header className="game-card-head">
        <span className="game-card-icon" aria-hidden="true">
          <Icon size={17} strokeWidth={2.1} />
        </span>
        <div className="game-card-title">
          <h4>{game.title}</h4>
          <p>{game.rules}</p>
        </div>
        <span className="game-card-badge">{GAME_BADGES[game.type]}</span>
      </header>

      {game.type === "math_sprint" ? <MathSprintCard game={game} onAsk={onAsk} /> : null}
      {game.type === "twenty_four" ? <TwentyFourCard game={game} onAsk={onAsk} /> : null}
      {game.type === "sudoku" ? <SudokuCard game={game} /> : null}
      {game.type === "flying_flower" ? <FlyingFlowerCard game={game} /> : null}
    </section>
  );
}
