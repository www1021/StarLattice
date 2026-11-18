import { Gamepad2 } from "lucide-react";
import { GAME_ENTRIES, GAME_ICONS, type GameEntry } from "./meta";
import "./games.css";

/**
 * 聊天里的游戏入口条：让不知道有这功能的学生看见「可以玩一局」。
 * 空状态和智能体条下面都用它，点一下直接把话发出去，不用先打字。
 */
export function GameRail({
  onPick,
  disabled,
  hint = "边玩边练，答完能给讲错题"
}: {
  onPick: (entry: GameEntry) => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <div className="game-rail" aria-label="学科小游戏">
      <span className="game-rail-label">
        <Gamepad2 size={15} strokeWidth={2.1} />
        玩一局
      </span>
      {GAME_ENTRIES.map((entry) => {
        const Icon = GAME_ICONS[entry.type];
        return (
          <button
            className="game-rail-item"
            data-game={entry.type}
            disabled={disabled}
            key={entry.type}
            onClick={() => onPick(entry)}
            type="button"
          >
            <Icon size={13.5} strokeWidth={2.2} />
            {entry.label}
          </button>
        );
      })}
      <span className="game-rail-hint">{hint}</span>
    </div>
  );
}
