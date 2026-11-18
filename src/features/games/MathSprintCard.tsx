import { useCallback, useEffect, useRef, useState } from "react";
import { Clock } from "lucide-react";
import type { MathSprintGame } from "./types";
import { MathText, plainMath } from "./MathText";

type Record = {
  index: number;
  /** null 表示超时没选。 */
  chosen: number | null;
  correct: boolean;
};

const OPTION_KEYS = ["A", "B", "C", "D"];

/**
 * 数学速算：一题一屏，限时作答，答对自动进下一题，答错停下来看解析。
 * 判分全在本地——题目和答案都是出题时算好的，不需要再往返服务端。
 */
export function MathSprintCard({
  game,
  onAsk
}: {
  game: MathSprintGame;
  onAsk?: (text: string) => void;
}) {
  const total = game.questions.length;
  const [step, setStep] = useState(0);
  const [chosen, setChosen] = useState<number | null>(null);
  const [answered, setAnswered] = useState(false);
  const [records, setRecords] = useState<Record[]>([]);
  const [combo, setCombo] = useState(0);
  const [bestCombo, setBestCombo] = useState(0);
  const [timeLeft, setTimeLeft] = useState(game.secondsPerQuestion);
  const [finished, setFinished] = useState(false);

  const question = game.questions[Math.min(step, total - 1)];
  const correctCount = records.filter((item) => item.correct).length;
  const score = records.reduce((sum, item) => sum + (item.correct ? 10 : 0), 0);

  // 提交答案要在 interval 里调用，用 ref 存一份最新的，避免闭包拿到旧的 step。
  const submitRef = useRef<(picked: number | null) => void>(() => {});
  // 连击数也放 ref：submit 会在定时器里被调用，闭包里读到旧值会把连击算断。
  const comboRef = useRef(0);

  const submit = useCallback(
    (picked: number | null) => {
      if (answered || finished) {
        return;
      }
      const target = game.questions[step];
      const correct = picked !== null && picked === target.answer;
      const nextCombo = correct ? comboRef.current + 1 : 0;
      comboRef.current = nextCombo;
      setChosen(picked);
      setAnswered(true);
      setRecords((prev) => [...prev, { index: step, chosen: picked, correct }]);
      setCombo(nextCombo);
      setBestCombo((best) => Math.max(best, nextCombo));
    },
    [answered, finished, game.questions, step]
  );

  useEffect(() => {
    submitRef.current = submit;
  }, [submit]);

  const next = useCallback(() => {
    setAnswered(false);
    setChosen(null);
    if (step + 1 >= total) {
      setFinished(true);
      return;
    }
    setStep(step + 1);
    setTimeLeft(game.secondsPerQuestion);
  }, [game.secondsPerQuestion, step, total]);

  // 限时：用一个 deadline 算剩余秒数，比每秒减一稳（切标签页回来不会少算）。
  useEffect(() => {
    if (finished || answered || game.secondsPerQuestion <= 0) {
      return;
    }
    const deadline = Date.now() + game.secondsPerQuestion * 1000;
    setTimeLeft(game.secondsPerQuestion);
    const timer = window.setInterval(() => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setTimeLeft(left);
      if (left === 0) {
        window.clearInterval(timer);
        submitRef.current(null);
      }
    }, 200);
    return () => window.clearInterval(timer);
  }, [answered, finished, game.secondsPerQuestion, step]);

  // 答对就自动进下一题，答错停住让学生读解析。
  useEffect(() => {
    if (!answered || chosen === null || finished) {
      return;
    }
    if (game.questions[step].answer !== chosen) {
      return;
    }
    const timer = window.setTimeout(() => next(), 720);
    return () => window.clearTimeout(timer);
  }, [answered, chosen, finished, game.questions, next, step]);

  if (finished) {
    const wrong = records.filter((item) => !item.correct);
    const rate = Math.round((correctCount / total) * 100);
    return (
      <div className="game-body">
        <div className="game-result">
          <div className="game-score-ring" style={{ ["--rate" as string]: `${rate}%` }}>
            <div className="game-score-inner">
              <strong>{correctCount}</strong>
              <span>/{total}</span>
            </div>
          </div>
          <div className="game-result-meta">
            <p className="game-result-head">
              {rate === 100 ? "全对，稳" : rate >= 60 ? "过了大半，再练一局就顺了" : "慢一点，先把错的那几道弄明白"}
            </p>
            <div className="game-chips">
              <span className="game-chip">正确率 {rate}%</span>
              <span className="game-chip">最高连击 ×{bestCombo}</span>
              <span className="game-chip">得分 {score}</span>
            </div>
          </div>
        </div>

        {wrong.length > 0 ? (
          <div className="game-wrong-list">
            <p className="game-wrong-title">这几道没过，值得再看一眼</p>
            {wrong.map((item) => {
              const target = game.questions[item.index];
              return (
                <div className="game-wrong-item" key={item.index}>
                  <div className="game-wrong-stem">
                    <MathText text={target.stem} />
                  </div>
                  <p className="game-wrong-why">
                    你选的是
                    <b>
                      {item.chosen === null ? "（超时）" : <MathText text={target.options[item.chosen]} />}
                    </b>
                    ，正确答案是
                    <b>
                      <MathText text={target.options[target.answer]} />
                    </b>
                  </p>
                  <p className="game-wrong-explain">{target.explain}</p>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="game-all-clear">全对。要不要换一档难度再来一局？</p>
        )}

        <div className="game-actions">
          {wrong.length > 0 && onAsk ? (
            <button
              className="game-action primary"
              onClick={() =>
                onAsk(
                  [
                    `我刚做完「${game.title}」，${total} 道对了 ${correctCount} 道。这几道没想明白：`,
                    ...wrong.map((item, order) => {
                      const target = game.questions[item.index];
                      const mine =
                        item.chosen === null ? "没来得及选" : plainMath(target.options[item.chosen]);
                      return `${order + 1}. ${plainMath(target.stem)}（我选的是 ${mine}，正确答案是 ${plainMath(
                        target.options[target.answer]
                      )}）`;
                    }),
                    "这几道我卡在哪一步？给我讲讲思路，别再直接给答案。"
                  ].join("\n")
                )
              }
            >
              讲讲错题
            </button>
          ) : null}
          {onAsk ? (
            <button className="game-action" onClick={() => onAsk("再来一局速算，难度加一点")}>
              再来一局
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  const isCorrect = answered && chosen !== null && chosen === question.answer;
  const timedOut = answered && chosen === null;

  return (
    <div className="game-body">
      <div className="game-sprint-bar">
        <span className="game-step">
          {step + 1}
          <i>/{total}</i>
        </span>
        <div className="game-segments" aria-hidden="true">
          {game.questions.map((_, index) => {
            const record = records.find((item) => item.index === index);
            const state = record
              ? record.correct
                ? "is-right"
                : "is-wrong"
              : index === step
                ? "is-current"
                : "";
            return <span className={`game-segment ${state}`} key={index} />;
          })}
        </div>
        {combo >= 2 ? <span className="game-combo">连击 ×{combo}</span> : null}
        <span className={`game-timer ${timeLeft <= 5 && !answered ? "is-urgent" : ""}`}>
          <Clock size={12.5} strokeWidth={2.4} />
          {answered ? "已作答" : `${timeLeft}s`}
        </span>
      </div>

      <p className="game-stem">
        <MathText text={question.stem} block />
      </p>

      <div className="game-options">
        {question.options.map((option, index) => {
          const picked = answered && chosen === index;
          const reveal = answered && index === question.answer;
          return (
            <button
              className={`game-option ${reveal ? "is-right" : ""} ${
                picked && !reveal ? "is-wrong" : ""
              }`}
              disabled={answered}
              key={`${question.stem}-${index}`}
              onClick={() => submit(index)}
            >
              <span className="game-option-key">{OPTION_KEYS[index] ?? index + 1}</span>
              <span className="game-option-text">
                <MathText text={option} />
              </span>
            </button>
          );
        })}
      </div>

      {answered ? (
        <div className={`game-feedback ${isCorrect ? "is-ok" : "is-bad"}`}>
          <p className="game-feedback-head">
            {isCorrect ? "对了" : timedOut ? "时间到了" : "再想想"}
          </p>
          <p className="game-feedback-text">
            {timedOut || !isCorrect ? (
              <>
                正确答案是
                <b>
                  <MathText text={question.options[question.answer]} />
                </b>
                。
              </>
            ) : null}
            {question.explain}
          </p>
          {!isCorrect ? (
            <button className="game-action primary" onClick={next}>
              下一题
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
