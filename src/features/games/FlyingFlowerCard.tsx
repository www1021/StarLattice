import { useState } from "react";
import type { FlyingFlowerGame } from "./types";

type Line = { who: "ai" | "me"; text: string; from?: string };

/**
 * 飞花令：AI 先出一句，学生接一句，判重、判含字、判真伪都在服务端（要查诗库）。
 * 判不过就把原因直说：没这个字、说过了、诗库里查不到，学生知道该往哪改。
 */
export function FlyingFlowerCard({ game }: { game: FlyingFlowerGame }) {
  const [lines, setLines] = useState<Line[]>([
    { who: "ai", text: game.opener.line, from: speakerOf(game) }
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [passed, setPassed] = useState(0);
  const [finished, setFinished] = useState(false);

  const submit = async () => {
    const line = input.trim();
    if (!line || busy || finished) {
      return;
    }
    setBusy(true);
    setError("");
    setNote("");
    try {
      const response = await fetch("/api/games/poetry/verify", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Requested-With": "StarLattice" },
        body: JSON.stringify({
          char: game.char,
          line,
          used: lines.map((item) => item.text)
        })
      });
      if (!response.ok) {
        throw new Error(`校验接口返回 ${response.status}`);
      }
      const result = (await response.json()) as {
        ok: boolean;
        reason?: string;
        degraded?: boolean;
        reply?: { line: string; title: string; author: string };
      };
      if (!result.ok) {
        setError(result.reason ?? "这句先不算，再想一句。");
        return;
      }
      const nextPassed = passed + 1;
      const additions: Line[] = [{ who: "me", text: line }];
      if (result.reply) {
        additions.push({
          who: "ai",
          text: result.reply.line,
          from: result.reply.author ? `${result.reply.author}《${result.reply.title}》` : undefined
        });
      }
      setLines((prev) => [...prev, ...additions]);
      setInput("");
      setPassed(nextPassed);
      if (result.degraded) {
        setNote("诗库这会儿连不上，这句先算你接上了。");
      }
      if (nextPassed >= game.rounds) {
        setFinished(true);
      }
    } catch {
      setError("校验服务没连上，稍后再试一句。");
    } finally {
      setBusy(false);
    }
  };

  if (finished) {
    return (
      <div className="game-body">
        <div className="game-result">
          <div className="game-result-score">
            <strong>{passed}</strong>
            <span>轮</span>
          </div>
          <div className="game-result-meta">
            <span>令字「{game.char}」</span>
            <span>接满了，收工</span>
          </div>
        </div>
        <div className="game-wrong-list">
          <p className="game-wrong-title">这一局用到的诗句</p>
          {lines.map((item, index) => (
            <div className="game-wrong-item" key={index}>
              <div className="game-wrong-stem">{item.text}</div>
              {item.from ? <p className="game-wrong-explain">{item.from}</p> : null}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="game-body">
      <div className="game-sprint-bar">
        <span className="game-step">
          已接 <i>{passed}</i>/{game.rounds} 轮
        </span>
        <span className="game-combo">令字「{game.char}」</span>
      </div>

      <div className="flower-lines">
        {lines.map((item, index) => (
          <div className={`flower-line is-${item.who}`} key={index}>
            <p>{item.text}</p>
            {item.from ? <span>{item.from}</span> : null}
          </div>
        ))}
      </div>

      <div className="flower-input">
        <input
          disabled={busy}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              void submit();
            }
          }}
          placeholder={`接一句含「${game.char}」的诗`}
          value={input}
        />
        <button disabled={busy || !input.trim()} onClick={() => void submit()}>
          {busy ? "查…" : "接这句"}
        </button>
      </div>

      {error ? <p className="twenty-message is-bad">{error}</p> : null}
      {note ? <p className="twenty-message">{note}</p> : null}
    </div>
  );
}

function speakerOf(game: FlyingFlowerGame): string | undefined {
  const { author, title } = game.opener;
  return author ? `${author}《${title}》` : undefined;
}
