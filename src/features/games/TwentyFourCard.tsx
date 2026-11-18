import { useCallback, useEffect, useRef, useState } from "react";
import type { TwentyFourGame } from "./types";
import { verifyTwentyFour } from "./expr";

const OPERATORS = ["+", "−", "×", "÷", "(", ")"];

/**
 * 24 点：点数字和运算符拼算式，回车判定。
 * 判定给出的是「算出来是多少」而不是一句「错了」——学生看到 28 才知道自己差在哪。
 */
export function TwentyFourCard({
  game,
  onAsk
}: {
  game: TwentyFourGame;
  onAsk?: (text: string) => void;
}) {
  const total = game.rounds.length;
  const [roundIndex, setRoundIndex] = useState(0);
  const [expression, setExpression] = useState("");
  const [status, setStatus] = useState<"playing" | "solved" | "failed">("playing");
  const [message, setMessage] = useState("");
  const [showHint, setShowHint] = useState(false);
  const [solved, setSolved] = useState(0);
  const [timeLeft, setTimeLeft] = useState(game.secondsPerRound);
  const [finished, setFinished] = useState(false);

  const round = game.rounds[Math.min(roundIndex, total - 1)];
  const inputRef = useRef<HTMLInputElement | null>(null);

  const nextRound = useCallback(
    (passed: boolean) => {
      if (passed) {
        setSolved((prev) => prev + 1);
      }
      setStatus("playing");
      setMessage("");
      setExpression("");
      setShowHint(false);
      if (roundIndex + 1 >= total) {
        setFinished(true);
        return;
      }
      setRoundIndex(roundIndex + 1);
      setTimeLeft(game.secondsPerRound);
    },
    [game.secondsPerRound, roundIndex, total]
  );

  const fail = useCallback(() => {
    setStatus("failed");
    setMessage(`时间到。一种解法：${round.hint}`);
  }, [round.hint]);

  // 限时：答对/答错后停表，等学生看结果再进下一轮。
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
        fail();
      }
    }, 200);
    return () => window.clearInterval(timer);
  }, [fail, finished, game.secondsPerRound, roundIndex, status]);

  const submit = () => {
    if (status !== "playing" || !expression.trim()) {
      return;
    }
    const result = verifyTwentyFour(expression, round.numbers);
    if (result.ok) {
      setStatus("solved");
      setMessage("成了。");
      window.setTimeout(() => nextRound(true), 760);
      return;
    }
    setMessage(result.error ?? "再试试。");
  };

  const insert = (token: string) => {
    if (status !== "playing") {
      return;
    }
    setExpression((prev) => `${prev}${token}`);
    inputRef.current?.focus();
  };

  if (finished) {
    const rate = Math.round((solved / total) * 100);
    return (
      <div className="game-body">
        <div className="game-result">
          <div className="game-result-score">
            <strong>{solved}</strong>
            <span>/ {total} 组</span>
          </div>
          <div className="game-result-meta">
            <span>通过率 {rate}%</span>
            <span>{rate === 100 ? "全通了" : rate >= 50 ? "过半数" : "再来几次会更快"}</span>
          </div>
        </div>
        <div className="game-wrong-list">
          <p className="game-wrong-title">这些牌组的解法</p>
          {game.rounds.map((item, index) => (
            <div className="game-wrong-item" key={index}>
              <div className="game-wrong-stem">{item.numbers.join("　")}</div>
              <p className="game-wrong-explain">{item.hint}</p>
            </div>
          ))}
        </div>
        {onAsk ? (
          <div className="game-actions">
            <button
              className="game-action primary"
              onClick={() =>
                onAsk(
                  `我玩了一局 24 点，${total} 组过了 ${solved} 组。带我做一遍这几组的思路：${game.rounds
                    .map((item) => `${item.numbers.join("、")}（提示：${item.hint}）`)
                    .join("；")}。重点是先想什么，别直接报式子。`
                )
              }
            >
              讲讲思路
            </button>
            <button className="game-action" onClick={() => onAsk("再来一局 24 点")}>
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
          {status === "playing" ? `${timeLeft}s` : status === "solved" ? "过了" : "超时"}
        </span>
      </div>

      <div className="twenty-cards">
        {round.numbers.map((number, index) => (
          <button
            className="twenty-card"
            key={`${roundIndex}-${index}`}
            onClick={() => insert(String(number))}
          >
            {number}
          </button>
        ))}
      </div>

      <input
        className="twenty-input"
        onChange={(event) => setExpression(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            submit();
          }
        }}
        placeholder="点下面的牌拼算式，或用键盘输入，如 (3+3)×(8-4)"
        ref={inputRef}
        value={expression}
      />

      <div className="twenty-keys">
        {OPERATORS.map((operator) => (
          <button key={operator} onClick={() => insert(operator === "−" ? "-" : operator === "×" ? "*" : operator === "÷" ? "/" : operator)}>
            {operator}
          </button>
        ))}
        <button onClick={() => setExpression((prev) => prev.slice(0, -1))}>退格</button>
        <button className="is-submit" onClick={submit}>
          判定
        </button>
      </div>

      {message ? (
        <p className={`twenty-message ${status === "solved" ? "is-ok" : status === "failed" ? "is-bad" : ""}`}>
          {message}
        </p>
      ) : null}

      <div className="twenty-foot">
        <button
          className="game-link"
          onClick={() => setShowHint((prev) => !prev)}
          type="button"
        >
          {showHint ? "收起提示" : "看一眼提示"}
        </button>
        {showHint ? <span className="twenty-hint">先想 24 的因数：3×8、4×6、2×12，再看手里的牌能不能凑出来。</span> : null}
      </div>

      {status === "failed" ? (
        <button className="game-action primary" onClick={() => nextRound(false)}>
          下一组
        </button>
      ) : null}
    </div>
  );
}
