import { useCallback, useEffect, useMemo, useState } from "react";
import type { PoetryOrderGame } from "./types";

/**
 * 诗句拼句：字块打乱，按诗句顺序点进格子里。
 *
 * 走的是「活字排版」这个意思——下面是木刻字块，上面是一张诗笺，
 * 排对了盖个印章、给出出处；排错了抖一下重来。
 *
 * 字块按「索引」管理而不是按字符：一句诗里常有重字（「处处闻啼鸟」），
 * 按字符去重会让点了一个另一个也变灰。
 */
export function PoetryOrderCard({
  game,
  onAsk
}: {
  game: PoetryOrderGame;
  onAsk?: (text: string) => void;
}) {
  const total = game.rounds.length;
  const [roundIndex, setRoundIndex] = useState(0);
  /** 已填字块在 tiles 里的下标，按点击顺序。 */
  const [filled, setFilled] = useState<number[]>([]);
  const [status, setStatus] = useState<"playing" | "right" | "wrong" | "timeout">("playing");
  const [correct, setCorrect] = useState(0);
  const [timeLeft, setTimeLeft] = useState(game.secondsPerRound);
  const [finished, setFinished] = useState(false);

  const round = game.rounds[Math.min(roundIndex, total - 1)];
  const slots = useMemo(() => [...round.answer], [round.answer]);
  const needCount = slots.length - game.prefilled;

  const nextRound = useCallback(
    (passed: boolean) => {
      if (passed) {
        setCorrect((prev) => prev + 1);
      }
      setFilled([]);
      setStatus("playing");
      if (roundIndex + 1 >= total) {
        setFinished(true);
        return;
      }
      setRoundIndex(roundIndex + 1);
      setTimeLeft(game.secondsPerRound);
    },
    [game.secondsPerRound, roundIndex, total]
  );

  // 限时：答完就停表，等学生看清结果再进下一句。
  useEffect(() => {
    if (finished || status !== "playing") {
      return;
    }
    const deadline = Date.now() + game.secondsPerRound * 1000;
    setTimeLeft(game.secondsPerRound);
    const timer = window.setInterval(() => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setTimeLeft(left);
      if (left === 0) {
        window.clearInterval(timer);
        setStatus("timeout");
      }
    }, 200);
    return () => window.clearInterval(timer);
  }, [finished, game.secondsPerRound, roundIndex, status]);

  const judge = useCallback(
    (next: number[]) => {
      const head = slots.slice(0, game.prefilled).join("");
      const text = head + next.map((index) => round.tiles[index]).join("");
      if (text === round.answer) {
        setStatus("right");
        window.setTimeout(() => nextRound(true), 900);
        return true;
      }
      setStatus("wrong");
      window.setTimeout(() => {
        setFilled([]);
        setStatus("playing");
      }, 900);
      return false;
    },
    [game.prefilled, nextRound, round.answer, round.tiles, slots]
  );

  const pickTile = (tileIndex: number) => {
    if (status !== "playing" || filled.length >= needCount) {
      return;
    }
    const next = [...filled, tileIndex];
    setFilled(next);
    if (next.length === needCount) {
      judge(next);
    }
  };

  const takeBack = (position: number) => {
    if (status !== "playing") {
      return;
    }
    setFilled((prev) => prev.filter((_, index) => index !== position));
  };

  if (finished) {
    const rate = Math.round((correct / total) * 100);
    return (
      <div className="game-body">
        <div className="game-result">
          <div className="game-score-ring" style={{ ["--rate" as string]: `${rate}%` }}>
            <div className="game-score-inner">
              <strong>{correct}</strong>
              <span>/{total}</span>
            </div>
          </div>
          <div className="game-result-meta">
            <p className="game-result-head">
              {rate === 100 ? "句句都对" : rate >= 60 ? "排得挺顺" : "再读两遍就熟了"}
            </p>
            <div className="game-chips">
              <span className="game-chip">拼对 {correct} 句</span>
              <span className="game-chip">正确率 {rate}%</span>
            </div>
          </div>
        </div>

        <div className="game-wrong-list">
          <p className="game-wrong-title">这几句的出处</p>
          {game.rounds.map((item, index) => (
            <div className="game-wrong-item" key={`${item.answer}-${index}`}>
              <div className="game-wrong-stem">{item.answer}</div>
              <p className="game-wrong-explain">
                {item.source.author}《{item.source.title}》
                {item.prompt ? ` · 上句是「${item.prompt}」` : ""}
              </p>
            </div>
          ))}
        </div>

        {onAsk ? (
          <div className="game-actions">
            <button
              className="game-action primary"
              onClick={() =>
                onAsk(
                  `我玩了一局诗句拼句，拼对 ${correct}/${total} 句。带我把这几句讲一讲，说说意思和好在哪里：${game.rounds
                    .map((item) => `「${item.answer}」（${item.source.author}《${item.source.title}》）`)
                    .join("；")}。别只翻译，讲讲画面。`
                )
              }
            >
              讲讲这几句
            </button>
            <button className="game-action" onClick={() => onAsk("再来一局诗句拼句")}>
              再来一局
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="game-body">
      <div className="game-sprint-bar">
        <span className="game-step">
          {roundIndex + 1}
          <i>/{total}</i>
        </span>
        <span className={`game-timer ${timeLeft <= 8 && status === "playing" ? "is-urgent" : ""}`}>
          {status === "playing" ? `${timeLeft}s` : status === "right" ? "对了" : status === "wrong" ? "再排" : "超时"}
        </span>
      </div>

      <div className={`poetry-paper ${status === "wrong" ? "is-wrong" : ""} ${status === "right" ? "is-right" : ""}`}>
        {round.prompt ? (
          <p className="poetry-prompt">
            <span className="poetry-prompt-label">上句</span>
            {round.prompt}
          </p>
        ) : null}

        <div className="poetry-slots" role="group" aria-label="诗句答题格">
          {slots.map((char, position) => {
            const locked = position < game.prefilled;
            const fillIndex = position - game.prefilled;
            const tileIndex = filled[fillIndex];
            const value = locked ? char : tileIndex === undefined ? "" : round.tiles[tileIndex];
            return (
              <button
                key={position}
                type="button"
                className={`poetry-slot ${value ? "is-filled" : ""} ${locked ? "is-locked" : ""}`}
                disabled={locked || !value || status !== "playing"}
                onClick={() => {
                  if (!locked && tileIndex !== undefined) {
                    takeBack(fillIndex);
                  }
                }}
              >
                {value}
              </button>
            );
          })}
        </div>

        {status === "right" ? (
          <div className="poetry-answer">
            <span className="poetry-seal">对</span>
            <span className="poetry-source">
              {round.source.author}《{round.source.title}》
            </span>
          </div>
        ) : null}
        {status === "timeout" ? (
          <p className="poetry-timeout">
            这句是「{round.answer}」——{round.source.author}《{round.source.title}》
          </p>
        ) : null}
      </div>

      <div className="poetry-tiles" role="group" aria-label="字块">
        {round.tiles.map((tile, index) => {
          const used = filled.includes(index);
          return (
            <button
              key={`${tile}-${index}`}
              type="button"
              className={`poetry-tile ${used ? "is-used" : ""}`}
              disabled={used || status !== "playing"}
              onClick={() => pickTile(index)}
            >
              {used ? "" : tile}
            </button>
          );
        })}
      </div>

      <p className="poetry-hint">
        点字块填进格子，点已填的字可以退回来。
        {status === "timeout" ? "" : `还要填 ${Math.max(0, needCount - filled.length)} 个字。`}
      </p>

      {status === "timeout" ? (
        <button className="game-action primary" onClick={() => nextRound(false)}>
          下一句
        </button>
      ) : null}
    </div>
  );
}
