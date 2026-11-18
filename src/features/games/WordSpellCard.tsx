import { useCallback, useEffect, useMemo, useState } from "react";
import type { WordSpellGame } from "./types";

/**
 * 单词拼写：看中文意思，用字母牌拼出英文。
 *
 * 字母牌按索引管理——「apple」里两个 p 是两个块，按字符去重会让点了一个另一个也变灰。
 * 答对后如果浏览器支持朗读，会读一遍单词：小学生记拼写，听一遍比看一遍管用。
 */

function speakWord(word: string): void {
  try {
    const synth = window.speechSynthesis;
    if (!synth) {
      return;
    }
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(word);
    utterance.lang = "en-US";
    utterance.rate = 0.9;
    synth.speak(utterance);
  } catch {
    // 朗读是加分项，不支持就算了，不能影响游戏本身。
  }
}

export function WordSpellCard({
  game,
  onAsk
}: {
  game: WordSpellGame;
  onAsk?: (text: string) => void;
}) {
  const total = game.rounds.length;
  const [roundIndex, setRoundIndex] = useState(0);
  const [filled, setFilled] = useState<number[]>([]);
  const [status, setStatus] = useState<"playing" | "right" | "wrong" | "timeout">("playing");
  const [correct, setCorrect] = useState(0);
  const [timeLeft, setTimeLeft] = useState(game.secondsPerRound);
  const [finished, setFinished] = useState(false);

  const round = game.rounds[Math.min(roundIndex, total - 1)];
  const slots = useMemo(() => [...round.word], [round.word]);

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
      const text = next.map((index) => round.letters[index]).join("");
      if (text.toLowerCase() === round.word.toLowerCase()) {
        setStatus("right");
        speakWord(round.word);
        window.setTimeout(() => nextRound(true), 1000);
        return;
      }
      setStatus("wrong");
      window.setTimeout(() => {
        setFilled([]);
        setStatus("playing");
      }, 900);
    },
    [nextRound, round.letters, round.word]
  );

  const pickLetter = (letterIndex: number) => {
    if (status !== "playing" || filled.length >= slots.length) {
      return;
    }
    const next = [...filled, letterIndex];
    setFilled(next);
    if (next.length === slots.length) {
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
              {rate === 100 ? "全拼对了" : rate >= 60 ? "记性不错" : "这几词再看一遍就稳了"}
            </p>
            <div className="game-chips">
              <span className="game-chip">拼对 {correct} 个</span>
              <span className="game-chip">正确率 {rate}%</span>
            </div>
          </div>
        </div>

        <div className="game-wrong-list">
          <p className="game-wrong-title">这几个词</p>
          {game.rounds.map((item, index) => (
            <div className="game-wrong-item" key={`${item.word}-${index}`}>
              <div className="game-wrong-stem">
                {item.word}
                <span className="word-meaning-line">
                  {item.pos} {item.meaning}
                </span>
              </div>
            </div>
          ))}
        </div>

        {onAsk ? (
          <div className="game-actions">
            <button
              className="game-action primary"
              onClick={() =>
                onAsk(
                  `我玩了一局单词拼写，拼对 ${correct}/${total} 个。帮我把这几个词串起来记：${game.rounds
                    .map((item) => `${item.word}（${item.pos}${item.meaning}）`)
                    .join("；")}。每个词给一句能记住的短句，别只列单词表。`
                )
              }
            >
              讲记忆方法
            </button>
            <button className="game-action" onClick={() => onAsk("再来一局单词拼写")}>
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
        <span className={`game-timer ${timeLeft <= 10 && status === "playing" ? "is-urgent" : ""}`}>
          {status === "playing" ? `${timeLeft}s` : status === "right" ? "对了" : status === "wrong" ? "再拼" : "超时"}
        </span>
      </div>

      <div className={`word-board ${status === "wrong" ? "is-wrong" : ""} ${status === "right" ? "is-right" : ""}`}>
        <div className="word-meaning">
          <span className="word-emoji" aria-hidden="true">
            {round.emoji ?? "🔤"}
          </span>
          <div className="word-meaning-text">
            <strong>{round.meaning}</strong>
            <span className="word-meta">
              {round.pos} · {round.word.length} 个字母
            </span>
          </div>
        </div>

        <div className="word-slots" role="group" aria-label="单词答题格">
          {slots.map((_, position) => {
            const letterIndex = filled[position];
            const value = letterIndex === undefined ? "" : round.letters[letterIndex];
            return (
              <button
                key={position}
                type="button"
                className={`word-slot ${value ? "is-filled" : ""}`}
                disabled={!value || status !== "playing"}
                onClick={() => takeBack(position)}
              >
                {value}
              </button>
            );
          })}
        </div>

        {status === "right" ? (
          <button className="word-pronounce" type="button" onClick={() => speakWord(round.word)}>
            <span aria-hidden="true">🔊</span> 再听一遍
          </button>
        ) : null}
        {status === "timeout" ? (
          <p className="word-reveal">
            这个词是 <strong>{round.word}</strong>，{round.pos} {round.meaning}
          </p>
        ) : null}
      </div>

      <div className="word-tiles" role="group" aria-label="字母牌">
        {round.letters.map((letter, index) => {
          const used = filled.includes(index);
          return (
            <button
              key={`${letter}-${index}`}
              type="button"
              className={`word-tile ${used ? "is-used" : ""}`}
              disabled={used || status !== "playing"}
              onClick={() => pickLetter(index)}
            >
              {letter.toUpperCase()}
            </button>
          );
        })}
      </div>

      <p className="word-hint">
        按顺序点字母，点已拼的字母可以退回来。
        {status === "timeout" ? "" : `还差 ${Math.max(0, slots.length - filled.length)} 个字母。`}
      </p>

      {status === "timeout" ? (
        <button className="game-action primary" onClick={() => nextRound(false)}>
          下一个
        </button>
      ) : null}
    </div>
  );
}
