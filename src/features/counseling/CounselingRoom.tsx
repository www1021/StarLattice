import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, LoaderCircle, RotateCcw, Send, Sparkles, Square } from "lucide-react";

export type CounselingRoomMode = "counselor" | "seeker";

type RoomBubble = { id: string; role: "user" | "assistant"; content: string };

type RoomOpening = {
  student: { id: string; name: string; year: string; title: string };
  opening: string;
};

export type CounselingRoomProps = {
  mode: CounselingRoomMode;
  topic: string;
  caseId?: string;
  onClose: () => void;
};

const modeText: Record<CounselingRoomMode, { title: string; you: string; ai: string }> = {
  counselor: { title: "你扮演开导者", you: "我（开导者）", ai: "学生" },
  seeker: { title: "你扮演被开导的学生", you: "我（学生）", ai: "老师" }
};

const idOf = () => `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

/** 逐段解析 SSE：服务端只发 delta / done / error 三种。 */
async function streamRoomTurn(
  body: { mode: CounselingRoomMode; topic: string; caseId?: string; messages: Array<{ role: string; content: string }> },
  signal: AbortSignal,
  onDelta: (delta: string) => void
) {
  const response = await fetch("/api/counseling/room/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal
  });
  if (!response.ok || !response.body) {
    const payload = (await response.json().catch(() => undefined)) as { message?: string } | undefined;
    throw new Error(payload?.message || "聊天室连接失败。");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let failure: string | undefined;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const eventLine = frame.split("\n").find((line) => line.startsWith("event: "));
      const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
      if (!dataLine) continue;
      const event = eventLine?.slice(7).trim();
      const data = JSON.parse(dataLine.slice(6)) as { content?: string; message?: string };
      if (event === "delta" && data.content) onDelta(data.content);
      if (event === "error") failure = data.message || "聊天室回复失败。";
    }
  }
  if (failure) throw new Error(failure);
}

export function CounselingRoom({ mode: initialMode, topic, caseId, onClose }: CounselingRoomProps) {
  const [mode, setMode] = useState<CounselingRoomMode>(initialMode);
  const [student, setStudent] = useState<RoomOpening["student"]>();
  const [messages, setMessages] = useState<RoomBubble[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [starting, setStarting] = useState(true);
  const [error, setError] = useState<string>();
  const [summary, setSummary] = useState<string>();
  const [summaryPending, setSummaryPending] = useState(false);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesRef = useRef<RoomBubble[]>([]);
  messagesRef.current = messages;

  useEffect(() => {
    void openRoom(initialMode);
    return () => {
      abortRef.current?.abort();
      abortRef.current = undefined;
    };
    // 只在进入聊天室时开一次；角色切换走 switchMode。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, pending, summary]);

  // 输入框随内容长高，最多 132px，再多就内部滚动。
  useEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 132)}px`;
  }, [draft]);

  async function openRoom(nextMode: CounselingRoomMode) {
    abortRef.current?.abort();
    setStarting(true);
    setError(undefined);
    setSummary(undefined);
    setMessages([]);
    try {
      const response = await fetch("/api/counseling/room/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: nextMode, topic, caseId })
      });
      if (!response.ok) throw new Error("聊天室开场失败。");
      const payload = (await response.json()) as RoomOpening;
      setStudent(payload.student);
      setMessages([{ id: idOf(), role: "assistant", content: payload.opening }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "聊天室开场失败。");
    } finally {
      setStarting(false);
      window.setTimeout(() => inputRef.current?.focus(), 60);
    }
  }

  function switchMode() {
    const next = mode === "counselor" ? "seeker" : "counselor";
    setMode(next);
    void openRoom(next);
  }

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || pending) return;
    const nextMessages: RoomBubble[] = [...messagesRef.current, { id: idOf(), role: "user", content: text }];
    const replyId = idOf();
    setMessages([...nextMessages, { id: replyId, role: "assistant", content: "" }]);
    setDraft("");
    setPending(true);
    setError(undefined);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamRoomTurn(
        {
          mode,
          topic,
          caseId,
          messages: nextMessages.map((item) => ({ role: item.role, content: item.content }))
        },
        controller.signal,
        (delta) => {
          setMessages((current) =>
            current.map((item) => (item.id === replyId ? { ...item, content: item.content + delta } : item))
          );
        }
      );
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      const message = err instanceof Error ? err.message : "聊天室回复失败。";
      setError(message);
      setMessages((current) => current.filter((item) => item.id !== replyId || item.content.trim().length > 0));
    } finally {
      setPending(false);
      abortRef.current = undefined;
      window.setTimeout(() => inputRef.current?.focus(), 40);
    }
  }, [caseId, draft, mode, pending, topic]);

  async function finish() {
    const history = messagesRef.current.filter((item) => item.content.trim());
    if (history.length < 2) {
      onClose();
      return;
    }
    setSummaryPending(true);
    setError(undefined);
    try {
      const response = await fetch("/api/counseling/room/summary", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode, topic, caseId, messages: history.map((item) => ({ role: item.role, content: item.content })) })
      });
      const payload = (await response.json().catch(() => undefined)) as { summary?: string; message?: string } | undefined;
      if (!response.ok || !payload?.summary) throw new Error(payload?.message || "复盘生成失败。");
      setSummary(payload.summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : "复盘生成失败。");
    } finally {
      setSummaryPending(false);
    }
  }

  const aiName = mode === "counselor" ? student?.name ?? "学生" : "老师";
  const roleLine = student
    ? `${modeText[mode].title} · AI 扮演${mode === "counselor" ? `学生 ${student.name}` : "老师"}`
    : modeText[mode].title;

  return (
    <div className="croom-backdrop" role="dialog" aria-modal="true" aria-label="谈心聊天室">
      <div className="croom">
        <header className="croom-head">
          <button className="croom-icon-btn" type="button" onClick={onClose} aria-label="返回聊天">
            <ArrowLeft size={18} strokeWidth={2.2} />
          </button>
          <div className="croom-head-text">
            <strong>谈心聊天室</strong>
            <span>{roleLine}</span>
          </div>
          <div className="croom-head-actions">
            <button className="croom-ghost-btn" type="button" onClick={switchMode} disabled={pending}>
              <RotateCcw size={14} strokeWidth={2.2} />
              {mode === "counselor" ? "换成我当学生" : "换成我当开导者"}
            </button>
            <button className="croom-primary-btn" type="button" onClick={() => void finish()} disabled={pending || summaryPending}>
              {summaryPending ? <LoaderCircle size={14} className="croom-spin" /> : null}
              结束并复盘
            </button>
          </div>
        </header>

        <div className="croom-scroll" ref={scrollRef}>
          <div className="croom-day">
            {topic ? `谈的是：${topic.slice(0, 42)}` : "模拟对话 · 内容仅用于练习"}
          </div>
          {starting ? (
            <div className="croom-loading">
              <LoaderCircle size={16} className="croom-spin" /> 正在准备对话
            </div>
          ) : null}
          {messages.map((item) => {
            const mine = item.role === "user";
            if (!item.content.trim() && !mine) return null;
            return (
              <div className={`croom-row ${mine ? "is-mine" : "is-peer"}`} key={item.id}>
                <div className={`croom-avatar ${mine ? "is-mine" : ""}`}>
                  {mine ? "我" : aiName.slice(0, 1)}
                </div>
                <div className="croom-bubble">{item.content}</div>
              </div>
            );
          })}
          {pending && !messages[messages.length - 1]?.content.trim() ? (
            <div className="croom-row is-peer">
              <div className="croom-avatar">{aiName.slice(0, 1)}</div>
              <div className="croom-bubble croom-typing">
                <i />
                <i />
                <i />
              </div>
            </div>
          ) : null}

          {summary ? (
            <div className="croom-summary">
              <div className="croom-summary-title">
                <Sparkles size={15} strokeWidth={2.2} /> 这次谈话的复盘
              </div>
              <p>{summary}</p>
              <div className="croom-summary-actions">
                <button className="croom-ghost-btn" type="button" onClick={() => void openRoom(mode)}>
                  再来一次
                </button>
                <button className="croom-primary-btn" type="button" onClick={onClose}>
                  回到聊天
                </button>
              </div>
            </div>
          ) : null}

          {error ? <div className="croom-error">{error}</div> : null}
        </div>

        <div className="croom-composer">
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            placeholder={mode === "counselor" ? "以开导者的身份说一句…" : "说说你现在的感受…"}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          {pending ? (
            <button
              className="croom-send"
              type="button"
              aria-label="停止生成"
              onClick={() => {
                abortRef.current?.abort();
                setPending(false);
              }}
            >
              <Square size={15} strokeWidth={2.4} />
            </button>
          ) : (
            <button className="croom-send" type="button" aria-label="发送" onClick={() => void send()} disabled={!draft.trim()}>
              <Send size={16} strokeWidth={2.2} />
            </button>
          )}
        </div>
        <p className="croom-note">模拟对话用于练习，不替代真实的心理支持与危机干预。</p>
      </div>
    </div>
  );
}
