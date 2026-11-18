import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SudokuGame } from "./types";

/** 找出所有和同行、同列、同宫撞车的格子，用于标红。 */
function findConflicts(values: number[]): Set<number> {
  const conflicts = new Set<number>();
  for (let index = 0; index < 81; index += 1) {
    const value = values[index];
    if (!value) {
      continue;
    }
    const row = Math.floor(index / 9);
    const column = index % 9;
    for (let step = 0; step < 9; step += 1) {
      const inRow = row * 9 + step;
      const inColumn = step * 9 + column;
      if (inRow !== index && values[inRow] === value) {
        conflicts.add(index);
        conflicts.add(inRow);
      }
      if (inColumn !== index && values[inColumn] === value) {
        conflicts.add(index);
        conflicts.add(inColumn);
      }
    }
    const boxRow = Math.floor(row / 3) * 3;
    const boxColumn = Math.floor(column / 3) * 3;
    for (let r = 0; r < 3; r += 1) {
      for (let c = 0; c < 3; c += 1) {
        const inBox = (boxRow + r) * 9 + boxColumn + c;
        if (inBox !== index && values[inBox] === value) {
          conflicts.add(index);
          conflicts.add(inBox);
        }
      }
    }
  }
  return conflicts;
}

/**
 * 数独：点格子、按数字填。判分按规则（填满且不冲突），不是跟标准答案逐格比——
 * 多解盘面下学生走另一条合法路径也算对。
 */
export function SudokuCard({ game }: { game: SudokuGame }) {
  const [values, setValues] = useState<number[]>(() => [...game.puzzle]);
  const [selected, setSelected] = useState<number | null>(null);
  const [hinted, setHinted] = useState<Set<number>>(() => new Set());
  const [hintCount, setHintCount] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const gridRef = useRef<HTMLDivElement | null>(null);

  const conflicts = useMemo(() => findConflicts(values), [values]);
  const blanks = values.filter((value) => value === 0).length;
  const solved = blanks === 0 && conflicts.size === 0;
  const selectedValue = selected === null ? 0 : values[selected];
  const fixed = (index: number) => game.puzzle[index] !== 0;

  // 计时只在没做完时走。
  useEffect(() => {
    if (solved) {
      return;
    }
    const timer = window.setInterval(() => setSeconds((prev) => prev + 1), 1000);
    return () => window.clearInterval(timer);
  }, [solved]);

  const write = useCallback(
    (index: number, value: number) => {
      if (fixed(index) || solved) {
        return;
      }
      setValues((prev) => {
        const next = [...prev];
        next[index] = value;
        return next;
      });
    },
    [fixed, solved]
  );

  const fill = useCallback(
    (value: number) => {
      if (selected === null) {
        return;
      }
      write(selected, value);
      // 填完自动跳到下一个空格，一路填下去不用一直点。
      if (value !== 0) {
        const nextBlank = values.findIndex((item, index) => item === 0 && index > selected && !fixed(index));
        if (nextBlank >= 0) {
          setSelected(nextBlank);
        }
      }
    },
    [fixed, selected, values, write]
  );

  const giveHint = () => {
    const target = values.findIndex((value, index) => value === 0 && !fixed(index));
    if (target < 0) {
      return;
    }
    const answer = game.solution[target];
    setValues((prev) => {
      const next = [...prev];
      next[target] = answer;
      return next;
    });
    setHinted((prev) => new Set(prev).add(target));
    setHintCount((prev) => prev + 1);
    setSelected(target);
  };

  const formatTime = (total: number) =>
    `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;

  return (
    <div className="game-body">
      <div className="game-sprint-bar">
        <span className="game-step">
          剩 <i>{blanks}</i> 格
        </span>
        <span className={`game-timer ${conflicts.size > 0 ? "is-urgent" : ""}`}>
          {conflicts.size > 0 ? `${conflicts.size} 处冲突` : solved ? "完成" : formatTime(seconds)}
        </span>
      </div>

      <div
        className="sudoku-grid"
        onKeyDown={(event) => {
          if (/^[1-9]$/.test(event.key)) {
            fill(Number(event.key));
            event.preventDefault();
          } else if (event.key === "Backspace" || event.key === "Delete" || event.key === "0") {
            fill(0);
            event.preventDefault();
          }
        }}
        ref={gridRef}
        tabIndex={0}
      >
        {values.map((value, index) => {
          const row = Math.floor(index / 9);
          const column = index % 9;
          const selectedRow = selected === null ? -1 : Math.floor(selected / 9);
          const selectedColumn = selected === null ? -1 : selected % 9;
          const sameBox =
            selected !== null &&
            Math.floor(row / 3) === Math.floor(selectedRow / 3) &&
            Math.floor(column / 3) === Math.floor(selectedColumn / 3);
          return (
            <button
              className={[
                "sudoku-cell",
                fixed(index) ? "is-fixed" : "",
                selected === index ? "is-selected" : "",
                hinted.has(index) ? "is-hint" : "",
                conflicts.has(index) ? "is-conflict" : "",
                value !== 0 && value === selectedValue && selected !== index ? "is-same" : "",
                row === selectedRow || column === selectedColumn || sameBox ? "is-peer" : "",
                column % 3 === 2 && column !== 8 ? "edge-right" : "",
                row % 3 === 2 && row !== 8 ? "edge-bottom" : ""
              ]
                .filter(Boolean)
                .join(" ")}
              key={index}
              onClick={() => {
                setSelected(index);
                gridRef.current?.focus();
              }}
            >
              {value === 0 ? "" : value}
            </button>
          );
        })}
      </div>

      <div className="sudoku-keys">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((number) => (
          <button key={number} onClick={() => fill(number)}>
            {number}
          </button>
        ))}
        <button onClick={() => fill(0)}>擦</button>
      </div>

      {solved ? (
        <div className="game-result">
          <div className="game-result-score">
            <strong>完成</strong>
            <span>用时 {formatTime(seconds)}</span>
          </div>
          <div className="game-result-meta">
            <span>{hintCount > 0 ? `用了 ${hintCount} 次提示` : "没用提示"}</span>
            <span>{conflicts.size === 0 ? "没有冲突" : ""}</span>
          </div>
        </div>
      ) : (
        <div className="twenty-foot">
          <button className="game-link" onClick={giveHint} type="button">
            填一格提示
          </button>
          <span className="twenty-hint">
            {conflicts.size > 0 ? "红色格子跟同行、同列或同宫重复了。" : "先找只剩一个候选的格子最容易破局。"}
          </span>
        </div>
      )}
    </div>
  );
}
