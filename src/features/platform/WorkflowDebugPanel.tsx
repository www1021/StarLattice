import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Loader2,
  MessageSquareText,
  Play,
  RotateCcw,
  Send,
  X
} from "lucide-react";
import { platformApi, type DebugChatEvent } from "./api";
import { renderMarkdown, streamSafeMarkdown } from "../chat/markdown";
import "../chat/message-markdown.css";
import type { HumanField, TraceResponse, WorkflowDefinition, WorkflowVariable } from "./types";

/** 调试运行报错的节点级详情，逐条显示让用户知道哪里错。 */
type DebugIssue = {
  code: string;
  path: string;
  message: string;
  /** 服务端算好的节点 ID；有值时点路径可直接定位到画布节点。 */
  nodeId?: string;
  /** 落在「参数提取」节点某参数上时的参数下标，跳转后可在检查器里滚到那一行。 */
  paramIndex?: number;
};

/** 只有输出节点才会产生这条：后端一次给全文，前端按字数做逐字动画。不展示节点名。 */
type DebugFeedMessage = {
  id: string;
  text: string;
  /** 是否要做逐字动画；关掉流式开关时为 false，直接整篇显示。 */
  reveal: boolean;
  /** 兼容旧的分片协议：服务端是否还在往这条里追加分片。 */
  streaming: boolean;
};

/**
 * 一轮对话按到达顺序排：输出节点正文、人工输入提示、用户回答。
 * 用一条时间线而不是「回复列表 + 单独的表单」，回答之后的回复才会排在回答后面。
 */
type DebugMessage =
  | { type: "reply"; id: string; item: DebugFeedMessage }
  | { type: "prompt"; id: string; text: string }
  | { type: "answer"; id: string; text: string };

/** 工作流在人工交互节点挂起时，后端下发的待填表单。 */
type DebugInteraction = {
  id: string;
  nodeId: string;
  path: string;
  title: string;
  prompt?: string;
  fields: HumanField[];
};

/** 一轮对话：用户一句 + 按顺序排下来的正文/提问/回答。节点运行结果在画布节点上看。 */
type DebugTurn = {
  id: string;
  userText: string;
  answer: string;
  phase: "streaming" | "done" | "error";
  intent?: string;
  statusText?: string;
  notice?: string;
  issues: DebugIssue[];
  messages: DebugMessage[];
  /**
   * 播放头：messages 里已经播到的下标。只有 `index <= playhead` 的条目会渲染，
   * `index === playhead` 的那条正在播，播完把 playhead 往后推一格。
   * 节奏因此由「谁播完了」决定，而不是各条各自起动画、互相比谁快。
   */
  playhead: number;
  /** 非空表示工作流正停在这个人工输入节点，等用户在底部输入框回答。 */
  interaction?: DebugInteraction;
};

type WorkflowDebugPanelProps = {
  definition: WorkflowDefinition;
  workflowId: string;
  onTrace: (trace: TraceResponse | undefined) => void;
  onRunningChange: (running: boolean) => void;
  onSelectNode: (nodeId: string, paramIndex?: number) => void;
  onClose: () => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 终态事件到达后收掉所有还在转的流式光标，避免连接结束时留下半个光标。 */
function finishFeed(messages: DebugMessage[]): DebugMessage[] {
  return messages.some((message) => message.type === "reply" && message.item.streaming)
    ? messages.map((message) =>
        message.type === "reply"
          ? { ...message, item: { ...message.item, streaming: false } }
          : message
      )
    : messages;
}

/** SSE 下发的字段是裸 JSON，逐项收成 HumanField，避免后端字段缺失把表单弄崩。 */
function parseInteractionFields(value: unknown): HumanField[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).flatMap((item) => {
    const key = typeof item.key === "string" ? item.key.trim() : "";
    if (!key) {
      return [];
    }
    return [
      {
        key,
        label: typeof item.label === "string" && item.label.trim() ? item.label : key,
        type: (typeof item.type === "string" ? item.type : "text") as HumanField["type"],
        required: item.required === true,
        options: Array.isArray(item.options)
          ? item.options.filter((option): option is string => typeof option === "string" && option !== "")
          : undefined,
        defaultValue: item.defaultValue as HumanField["defaultValue"],
        placeholder: typeof item.placeholder === "string" ? item.placeholder : undefined,
        description: typeof item.description === "string" ? item.description : undefined
      }
    ];
  });
}

function defaultInputValues(definition: WorkflowDefinition): Record<string, string> {
  const values: Record<string, string> = {};
  for (const variable of definition.inputs) {
    const declared = variable.defaultValue;
    if (declared !== undefined && declared !== null) {
      values[variable.name] =
        typeof declared === "string" ? declared : JSON.stringify(declared);
      continue;
    }
    values[variable.name] =
      variable.type === "boolean" ? "false" : variable.type === "number" ? "0" : "";
  }
  return values;
}

/** 控制字段（答辩类型、轮次、格式等）不该接收用户对话正文。 */
const CONTROL_INPUT_NAMES = new Set([
  "mode",
  "type",
  "kind",
  "round",
  "index",
  "stage",
  "lang",
  "format"
]);
/** 元器 / 平台里承载 SYS.UserQuery 的常见字段名，按优先级匹配。 */
const MESSAGE_INPUT_NAMES = [
  "input",
  "userQuery",
  "query",
  "question",
  "content",
  "message",
  "text",
  "title",
  "topic"
];

/**
 * 「对话内容」要灌进用户问题输入，而不是定义里的第一个字符串字段。
 * 例如论文题目流程的输入顺序是 mode / title / input，取第一个会把整句题目
 * 填成答辩类型，真正给大模型提取标签的 input 反而是空串。
 */
function firstTextField(definition: WorkflowDefinition): WorkflowVariable | undefined {
  const strings = definition.inputs.filter((item) => item.type === "string");
  for (const name of MESSAGE_INPUT_NAMES) {
    const hit = strings.find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (hit) {
      return hit;
    }
  }
  return (
    strings.find((item) => !CONTROL_INPUT_NAMES.has(item.name.toLowerCase())) ??
    strings[0] ??
    definition.inputs.find((item) => item.type !== "boolean" && item.type !== "number")
  );
}

function buildDebugInput(
  definition: WorkflowDefinition,
  values: Record<string, string>
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const variable of definition.inputs) {
    const raw = values[variable.name] ?? "";
    if (variable.type === "number") {
      const parsed = Number(raw);
      input[variable.name] = Number.isNaN(parsed) ? 0 : parsed;
    } else if (variable.type === "boolean") {
      input[variable.name] = raw === "true";
    } else if (variable.type === "object") {
      try {
        input[variable.name] = raw.trim() ? (JSON.parse(raw) as unknown) : {};
      } catch {
        input[variable.name] = {};
      }
    } else {
      input[variable.name] = raw;
    }
  }
  return input;
}

/** 一句话回答要落到人工节点的文本字段，其余字段用默认值补齐。 */
function interactionValues(interaction: DebugInteraction, answer: string): Record<string, unknown> {
  const fields = interaction.fields;
  if (fields.length === 0) {
    return { text: answer };
  }
  const answerField =
    fields.find((field) => /^(text|answer|content|input|query|response|reply)$/i.test(field.key)) ??
    fields.find((field) => field.type === "text" || field.type === "textarea") ??
    fields[0];
  return choiceValues(interaction, answerField ? { [answerField.key]: answer } : {});
}

/**
 * 按 key 覆盖字段值，其余仍用默认值补齐。
 * 选项卡点按钮时用它——选项本身就是答案，不能再往文本字段里塞一遍。
 */
function choiceValues(
  interaction: DebugInteraction,
  answers: Record<string, string>
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of interaction.fields) {
    const picked = answers[field.key];
    if (picked !== undefined) {
      values[field.key] = picked;
    } else if (field.defaultValue !== undefined) {
      values[field.key] = field.defaultValue;
    } else if (field.type === "number") {
      values[field.key] = 0;
    } else if (field.type === "boolean") {
      values[field.key] = false;
    } else if (field.type === "select") {
      values[field.key] = field.options?.[0] ?? "";
    } else {
      values[field.key] = "";
    }
  }
  return values;
}

export function WorkflowDebugPanel({
  definition,
  workflowId,
  onTrace,
  onRunningChange,
  onSelectNode,
  onClose
}: WorkflowDebugPanelProps) {
  const [turns, setTurns] = useState<DebugTurn[]>([]);
  const [text, setText] = useState("");
  const [inputValues, setInputValues] = useState<Record<string, string>>(() =>
    defaultInputValues(definition)
  );
  const [inputsOpen, setInputsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [interactionSubmitting, setInteractionSubmitting] = useState<string>();
  const runTokenRef = useRef(0);
  const abortRef = useRef<AbortController | undefined>(undefined);
  /** 本轮真正在跑的运行 ID：退出调试/清空会话时用它显式取消，别让后台一直跑。 */
  const activeRunRef = useRef<string | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  /** 没主动往上翻时跟随正文增长；用户上翻后不强行拉回底部。 */
  const stickToBottomRef = useRef(true);
  const turnCountRef = useRef(0);
  const targetField = firstTextField(definition);

  useEffect(() => {
    const el = composerRef.current;
    if (!el) {
      return;
    }
    // 按内容增高，封顶后由 textarea 自己滚动；提交清空时自动收回两行。
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
    const stream = scrollRef.current;
    if (stream && stickToBottomRef.current) {
      stream.scrollTop = stream.scrollHeight;
    }
  }, [text]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    // 用户自己发了新一轮，重新跟随；其余消息更新尊重当前是否贴底。
    if (turns.length > turnCountRef.current) {
      stickToBottomRef.current = true;
    }
    turnCountRef.current = turns.length;
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [turns, busy]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const onScroll = () => {
      stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    // 打字动画每帧改的是文本节点，turns 不变；用 DOM 变化跟随内容高度，
    // rAF 合并成一帧一次滚动，避免和 smooth 滚动互相打架。
    let frame = 0;
    const observer = new MutationObserver(() => {
      if (!stickToBottomRef.current || frame) {
        return;
      }
      frame = requestAnimationFrame(() => {
        frame = 0;
        const node = scrollRef.current;
        if (node && stickToBottomRef.current) {
          node.scrollTop = node.scrollHeight;
        }
      });
    });
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      observer.disconnect();
      if (frame) {
        cancelAnimationFrame(frame);
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      runTokenRef.current += 1;
      const runId = activeRunRef.current;
      activeRunRef.current = undefined;
      abortRef.current?.abort();
      abortRef.current = undefined;
      // 关掉调试视图就该把这条运行停下来：abort 只断开 SSE，
      // 后端还要收到显式取消才不会继续跑、不会继续占调度槽位。
      if (runId) {
        void platformApi.cancelRun(runId).catch(() => undefined);
      }
      onRunningChange(false);
    };
    // 只在卸载时清理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function patchTurn(turnId: string, patch: Partial<DebugTurn>) {
    setTurns((current) =>
      current.map((turn) => (turn.id === turnId ? { ...turn, ...patch } : turn))
    );
  }

  /**
   * 一条播完，把播放头往后推一格。
   * 只在「推的正是当前这条」时生效，重复回调或乱序回调都不会把后面的条目提前放出来。
   */
  function advance(turnId: string, index: number) {
    setTurns((current) =>
      current.map((turn) =>
        turn.id === turnId && turn.playhead === index
          ? { ...turn, playhead: index + 1 }
          : turn
      )
    );
  }

  function handleEvent(event: DebugChatEvent, turnId: string, runToken: number) {
    const { event: kind, data } = event;

    // progress 是运行中的实时进度，nodes 是终态汇总；两者都要刷新画布 trace，
    // 否则画布一直停在「本轮运行还没有这个节点的执行记录」。
    const runData = data.run;
    const traceRunId =
      typeof data.runId === "string"
        ? data.runId
        : isRecord(runData) && typeof runData.id === "string"
          ? runData.id
          : undefined;
    // 记下正在跑的运行，退出调试时用来显式取消。
    if (traceRunId) {
      activeRunRef.current = traceRunId;
    }
    if (
      (kind === "nodes" || kind === "progress") &&
      runTokenRef.current === runToken &&
      traceRunId
    ) {
      void platformApi
        .trace(traceRunId)
        .then((fullTrace) => {
          if (runTokenRef.current !== runToken) {
            return;
          }
          onTrace(fullTrace);
        })
        .catch(() => undefined);
    }

    setTurns((current) =>
      current.map((turn) => {
        if (turn.id !== turnId) {
          return turn;
        }
        switch (kind) {
          case "meta":
            return {
              ...turn,
              intent: typeof data.intent === "string" ? data.intent : undefined
            };
          case "status":
            return {
              ...turn,
              statusText: typeof data.text === "string" ? data.text : undefined
            };
          case "interaction": {
            const id = typeof data.id === "string" ? data.id : "";
            if (!id) {
              return turn;
            }
            // 不画表单卡片，只在对话里留一行提示；回答走底部输入框。
            // 文案按节点自己的问题走：选项卡就直接说要选一项，
            // 一律套「请输入你对上述问题的回答」会让人以为是刚才那句话被追问了。
            const promptId = `prompt-${id}`;
            const fields = parseInteractionFields(data.fields);
            const hasChoice = fields.some((field) => field.type === "select");
            const nodePrompt =
              typeof data.prompt === "string" && data.prompt.trim() ? data.prompt.trim() : "";
            const promptText = nodePrompt
              ? nodePrompt
              : hasChoice
                ? "请在下面选一项，或者直接写一段不在选项里的内容。"
                : "请输入你的回答：";
            const messages = turn.messages.some((message) => message.id === promptId)
              ? turn.messages
              : [
                  ...turn.messages,
                  {
                    type: "prompt" as const,
                    id: promptId,
                    text: promptText
                  }
                ];
            return {
              ...turn,
              interaction: {
                id,
                nodeId: typeof data.nodeId === "string" ? data.nodeId : "",
                path: typeof data.path === "string" ? data.path : "",
                title: typeof data.title === "string" ? data.title : "人工输入",
                prompt: typeof data.prompt === "string" ? data.prompt : undefined,
                fields
              },
              messages,
              statusText: undefined
            };
          }
          case "progress":
            // 节点状态只用来刷新画布 trace，对话里不再罗列节点和耗时。
            return turn;
          case "output": {
            // 一条回复对应一个 id：新协议一次发全（done=true + reveal），
            // 旧的分片协议仍按 id 追加，避免别处的调用方突然失效。
            // replace=true 表示整篇替换（真流式的收尾帧：用台账最终产物覆盖
            // 已流出的正文），不再追加。
            const id = typeof data.id === "string" ? data.id : "";
            if (!id) {
              return turn;
            }
            const chunk = typeof data.text === "string" ? data.text : "";
            const done = data.done === true;
            const replace = data.replace === true;
            const index = turn.messages.findIndex(
              (message) => message.type === "reply" && message.item.id === id
            );
            if (index >= 0) {
              return {
                ...turn,
                messages: turn.messages.map((message, position) =>
                  position === index && message.type === "reply"
                    ? {
                        ...message,
                        item: {
                          ...message.item,
                          text: replace ? chunk : message.item.text + chunk,
                          streaming: !done
                        }
                      }
                    : message
                ),
                statusText: undefined
              };
            }
            return {
              ...turn,
              statusText: undefined,
              messages: [
                ...turn.messages,
                {
                  type: "reply" as const,
                  id,
                  item: {
                    id,
                    text: chunk,
                    reveal: data.reveal === true,
                    streaming: !done
                  }
                }
              ]
            };
          }
          case "delta":
            return {
              ...turn,
              answer: turn.answer + (typeof data.content === "string" ? data.content : "")
            };
          case "notice":
            return {
              ...turn,
              notice: typeof data.text === "string" ? data.text : undefined
            };
          case "nodes":
            return {
              ...turn,
              messages: finishFeed(turn.messages),
              interaction: undefined,
              statusText: undefined
            };
          case "error": {
            const details = Array.isArray(data.details)
              ? data.details.filter(isRecord).map((item) => ({
                  code: typeof item.code === "string" ? item.code : "error",
                  path: typeof item.path === "string" ? item.path : "workflow",
                  nodeId: typeof item.nodeId === "string" ? item.nodeId : undefined,
                  message: typeof item.message === "string" ? item.message : "未知问题"
                }))
              : [];
            return {
              ...turn,
              phase: "error",
              notice: typeof data.message === "string" ? data.message : "工作流运行失败",
              issues: details,
              messages: finishFeed(turn.messages),
              interaction: undefined,
              statusText: undefined
            };
          }
          case "done":
            return {
              ...turn,
              phase: "done",
              messages: finishFeed(turn.messages),
              interaction: undefined,
              statusText: undefined
            };
          default:
            return turn;
        }
      })
    );
  }

  /** 当前停在人工输入节点时，底部输入框发的这句就是回答，不再另起一轮运行。 */
  const pendingTurn = [...turns]
    .reverse()
    .find((turn) => turn.interaction && turn.phase === "streaming");
  const pendingInteraction = pendingTurn?.interaction;
  /** 选项卡：待输入表单里第一个带选项的 select，就是用户要点的那个东西。 */
  const choiceField = pendingInteraction?.fields.find(
    (field) => field.type === "select" && (field.options?.length ?? 0) > 0
  );
  /**
   * 提示行同样排在时间线上：它前面的回复没播完，就还不该让人作答。
   * 否则会出现「问题还在一个字一个字往外冒，输入框已经催你回答了」。
   */
  const pendingPromptIndex = pendingInteraction
    ? (pendingTurn?.messages.findIndex((item) => item.id === `prompt-${pendingInteraction.id}`) ?? -1)
    : -1;
  const answerReady =
    !pendingInteraction ||
    !pendingTurn ||
    pendingPromptIndex < 0 ||
    pendingTurn.playhead > pendingPromptIndex;

  async function submit() {
    const userText = text.trim();
    if (!userText) {
      return;
    }
    if (pendingTurn && pendingInteraction) {
      // 提示行还没轮到出现时不接受作答，免得回答跑到问题前面。
      if (!answerReady) {
        return;
      }
      // 选项卡：输入框里写的字本身就是选择。命中某个选项就走那一路，
      // 不在选项里就当「其他」，由后端落到兜底分支。
      const picked = choiceField
        ? choiceValues(pendingInteraction, { [choiceField.key]: userText })
        : undefined;
      await submitInteraction(pendingTurn.id, pendingInteraction, userText, picked);
      return;
    }
    if (busy) {
      return;
    }
    const values = { ...inputValues };
    if (targetField) {
      values[targetField.name] = userText;
    }
    const input = buildDebugInput(definition, values);
    const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const runToken = runTokenRef.current + 1;
    runTokenRef.current = runToken;
    const controller = new AbortController();
    abortRef.current = controller;

    setBusy(true);
    onRunningChange(true);
    setNotice(undefined);
    setText("");
    setTurns((current) => [
      ...current,
      {
        id: turnId,
        userText,
        answer: "",
        phase: "streaming",
        issues: [],
        messages: [],
        playhead: 0
      }
    ]);
    onTrace(undefined);

    try {
      await platformApi.debugChat(
        workflowId,
        userText,
        input,
        (event) => {
          if (runTokenRef.current === runToken) {
            handleEvent(event, turnId, runToken);
          }
        },
        // 调试运行固定走严格模式：每轮都跑工作流，不做意图分流与兜底回复。
        // 同时把画布当前定义带上：没保存的连线/参数改动也能立刻被检查到。
        { signal: controller.signal, strictRun: true, definition }
      );
    } catch (error) {
      if (runTokenRef.current === runToken) {
        const message = error instanceof Error ? error.message : String(error);
        patchTurn(turnId, { phase: "error", notice: message });
        setNotice(message);
      }
    } finally {
      if (runTokenRef.current === runToken) {
        abortRef.current = undefined;
        // 流已经收尾，这条运行要么结束、要么被服务端取消，不用再记着它。
        activeRunRef.current = undefined;
        setBusy(false);
        onRunningChange(false);
        setTurns((current) =>
          current.map((turn) =>
            turn.id === turnId && turn.phase === "streaming" ? { ...turn, phase: "done" } : turn
          )
        );
      }
    }
  }

  /** 人工输入节点提交后，运行会在后端继续，SSE 后续事件照常回来。 */
  async function submitInteraction(
    turnId: string,
    interaction: DebugInteraction,
    userText: string,
    /** 选项卡点按钮时直接给出的字段值；不传就按一句话回答铺开。 */
    picked?: Record<string, unknown>
  ) {
    const answerId = `answer-${interaction.id}`;
    setInteractionSubmitting(interaction.id);
    setText("");
    // respond 接口会等到整轮跑完才返回；先乐观插入回答，后面的回复才会排在它之后。
    setTurns((current) =>
      current.map((turn) =>
        turn.id === turnId
          ? {
              ...turn,
              interaction: undefined,
              statusText: "已提交，继续执行工作流…",
              messages: [
                ...turn.messages,
                { type: "answer" as const, id: answerId, text: userText }
              ]
            }
          : turn
      )
    );
    try {
      await platformApi.respondInteraction(
        interaction.id,
        picked ?? interactionValues(interaction, userText)
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 提交失败就撤掉这条回答，把话放回输入框，允许重试。
      setText(userText);
      setTurns((current) =>
        current.map((turn) => {
          if (turn.id !== turnId) {
            return turn;
          }
          const messages = turn.messages.filter((item) => item.id !== answerId);
          return {
            ...turn,
            interaction,
            statusText: undefined,
            messages,
            // 撤掉一条后播放头跟着回退，否则后面重试的回答会被当成「已经播过」直接甩出来。
            playhead: Math.min(turn.playhead, messages.length)
          };
        })
      );
      setNotice(`人工输入提交失败：${message}`);
    } finally {
      setInteractionSubmitting(undefined);
    }
  }

  function clear() {
    runTokenRef.current += 1;
    const runId = activeRunRef.current;
    activeRunRef.current = undefined;
    abortRef.current?.abort();
    abortRef.current = undefined;
    // 清空会话等于放弃这一轮，后台也别再跑了。
    if (runId) {
      void platformApi.cancelRun(runId).catch(() => undefined);
    }
    setTurns([]);
    setNotice(undefined);
    setInteractionSubmitting(undefined);
    setText("");
    setBusy(false);
    onTrace(undefined);
    onRunningChange(false);
  }

  return (
    <div className="platform-debug-side">
      <div className="platform-debug-panel">
        <header className="platform-debug-head">
          <div className="platform-debug-head-main">
            <MessageSquareText size={16} />
            <div>
              <strong>工作流调试</strong>
              <span>{definition.name} · 每轮直接运行工作流</span>
            </div>
          </div>
          <div className="platform-debug-head-actions">
            <button type="button" className="platform-icon-button" title="清空会话" onClick={clear}>
              <RotateCcw size={14} />
            </button>
            <button type="button" className="platform-icon-button" title="退出调试" onClick={onClose}>
              <X size={15} />
            </button>
          </div>
        </header>

        <div className="platform-debug-map" onClick={() => setInputsOpen((value) => !value)}>
          {inputsOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span>
            输入映射：
            <code>{targetField?.name ?? "（工作流未声明输入）"}</code>
            {targetField ? " ← 对话内容" : " · 将使用空输入运行"}
          </span>
          <span className="platform-debug-map-count">{definition.inputs.length} 个输入</span>
        </div>
        {inputsOpen && (
          <div className="platform-debug-inputs">
            {definition.inputs.length === 0 && (
              <p className="platform-debug-note">这条工作流没有声明输入，运行时使用空对象。</p>
            )}
            {definition.inputs.map((variable) => (
              <label key={variable.name} className="platform-debug-input-row">
                <span>
                  <code>{variable.name}</code>
                  <em>{variable.type}{variable.required ? " · 必填" : ""}</em>
                </span>
                <input
                  value={inputValues[variable.name] ?? ""}
                  placeholder={variable.name === targetField?.name ? "留空则填入对话内容" : variable.description ?? ""}
                  onChange={(event) =>
                    setInputValues((current) => ({ ...current, [variable.name]: event.target.value }))
                  }
                />
              </label>
            ))}
            <p className="platform-debug-note">
              除第一个字符串字段外，其余字段使用上方填写的固定值；调试视图不会修改画布 DSL。
            </p>
          </div>
        )}

        <div className="platform-debug-stream" ref={scrollRef}>
          {turns.length === 0 && (
            <div className="platform-debug-empty">
              <Play size={18} />
              <strong>发送内容即运行工作流</strong>
              <p>
                每轮都会真正跑一遍工作流，不会用模型兜底回答。
                只有输出节点的正文会打印出来，其它节点产物只往下传变量。
                跑到需要你回答的地方会提示一句，直接在下面输入就行。
                要看每个节点的输入和输出，点画布节点右上角的「详情」。
              </p>
            </div>
          )}
          {turns.map((turn) => (
            <div key={turn.id} className="platform-debug-turn">
              <div className="platform-debug-bubble is-user">{turn.userText}</div>
              <div className="platform-debug-bubble is-assistant">
                {turn.statusText && (
                  <div className="platform-debug-status">
                    <Loader2 size={12} className="is-spinning" /> {turn.statusText}
                  </div>
                )}
                {turn.messages.map((message, index) => {
                  // 只渲染播到的那一条；后面的先不出现，等前一条播完再依次放行。
                  if (index > turn.playhead) {
                    return null;
                  }
                  if (message.type === "reply") {
                    return (
                      <ReplyBlock
                        key={message.id}
                        item={message.item}
                        turnId={turn.id}
                        onDone={() => advance(turn.id, index)}
                      />
                    );
                  }
                  if (message.type === "prompt") {
                    return (
                      <PromptLine
                        key={message.id}
                        text={message.text}
                        onDone={() => advance(turn.id, index)}
                      />
                    );
                  }
                  return (
                    <InstantLine
                      key={message.id}
                      text={message.text}
                      onDone={() => advance(turn.id, index)}
                    />
                  );
                })}
                {turn.answer && (
                  <div className="platform-debug-answer">
                    {turn.answer}
                    {turn.phase === "streaming" && <span className="platform-debug-caret" />}
                  </div>
                )}
                {turn.phase === "streaming" &&
                  !turn.answer &&
                  !turn.statusText &&
                  turn.messages.length === 0 && (
                    <div className="platform-debug-status">
                      <Loader2 size={12} className="is-spinning" /> 正在组织回复…
                    </div>
                  )}
                {turn.notice && <p className="platform-debug-notice-inline">{turn.notice}</p>}

                {turn.issues.length > 0 && (
                  <div className="platform-debug-issues">
                    <div className="platform-debug-issues-head">
                      <AlertTriangle size={12} /> 问题详情 · {turn.issues.length} 处
                    </div>
                    <ul>
                      {turn.issues.map((issue, index) => {
                        // 服务端给的节点 ID 优先（含容器嵌套节点）；没有时再按 path 猜，
                        // 且必须真的存在于画布顶层才允许跳转。
                        const candidate = issue.nodeId ?? issue.path.split(/[./]/)[0];
                        const locatable = Boolean(
                          issue.nodeId || (candidate && definition.nodes.some((node) => node.id === candidate))
                        );
                        return (
                          <li key={`${issue.code}-${issue.path}-${index}`}>
                            <button
                              type="button"
                              className={`platform-debug-issue-path${locatable ? "" : " is-static"}`}
                              title={locatable ? "在画布上定位这个节点" : "工作流级问题，在上方输入映射或画布里检查"}
                              onClick={() => {
                                if (locatable) {
                                  onSelectNode(issue.nodeId ?? candidate, issue.paramIndex);
                                }
                              }}
                            >
                              <code>{issue.path}</code>
                            </button>
                            <span>{issue.message}</span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}

              </div>
            </div>
          ))}
        </div>

        {notice && (
          <div className="platform-debug-notice">
            <AlertTriangle size={13} /> {notice}
          </div>
        )}

        {/* 选项卡：点一项就是回答，不再要求用户把选项名字打进输入框 */}
        {choiceField && pendingTurn && pendingInteraction && answerReady ? (
          <div className="platform-debug-choices">
            <span className="platform-debug-choices-label">{choiceField.label}</span>
            {(choiceField.options ?? []).map((option, index) => (
              <button
                key={option}
                type="button"
                className="platform-debug-choice"
                disabled={Boolean(interactionSubmitting)}
                onClick={() =>
                  void submitInteraction(
                    pendingTurn.id,
                    pendingInteraction,
                    option,
                    choiceValues(pendingInteraction, { [choiceField.key]: option })
                  )
                }
              >
                <span className="platform-debug-choice-index">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="platform-debug-choice-text">{option}</span>
              </button>
            ))}
            {/* 兜底口：不点选项、自己写一段也行，写完回车就走「其他」分支。 */}
            <button
              type="button"
              className="platform-debug-choice is-other"
              disabled={Boolean(interactionSubmitting)}
              title="输入不在上面选项里的内容，运行会走「其他」兜底分支"
              onClick={() => composerRef.current?.focus()}
            >
              <span className="platform-debug-choice-index">··</span>
              <span className="platform-debug-choice-text">其他（在下面输入，走兜底分支）</span>
            </button>
          </div>
        ) : null}

        <div className="platform-debug-composer">
          <textarea
            ref={composerRef}
            value={text}
            rows={2}
            placeholder={
              pendingInteraction
                ? answerReady
                  ? choiceField
                    ? "点上面的选项，或者直接写一段不在选项里的内容（走「其他」兜底分支）"
                    : "请输入你的回答，回车发送"
                  : "问题还在输出，稍等一下再回答…"
                : "输入一句话，回车发送（Shift+回车换行）"
            }
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <button
            type="button"
            className="platform-button is-primary"
            disabled={
              !text.trim() ||
              (busy && !pendingInteraction) ||
              Boolean(pendingInteraction && !answerReady) ||
              Boolean(pendingInteraction && interactionSubmitting === pendingInteraction.id)
            }
            onClick={() => void submit()}
          >
            {busy && !pendingInteraction ? (
              <Loader2 size={14} className="is-spinning" />
            ) : (
              <Send size={14} />
            )}
            {pendingInteraction ? "发送回答" : "发送"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 输入框最多长到 168px，再长就在框里用滚轮看。 */
const COMPOSER_MAX_HEIGHT = 168;

/** 折叠再展开时不重播打字动画；key 带 turnId，新一轮运行的同名节点不会被误判成播过。 */
const revealedReplyIds = new Set<string>();

/**
 * 播放顺序不再依赖「谁先挂载谁先占位」：那一套靠模块级队列 + effect 里申请/释放槽位，
 * 在 React 严格模式下 effect 会被 setup→cleanup→setup 跑两遍，槽位刚放出就被下一条抢走，
 * 于是上一条还在打字、下一条已经开始出字。现在改成由父组件持有 playhead，
 * 一次只放行一条，播完才推进，跟挂载顺序和 effect 次数都无关。
 */

/**
 * 节奏照主流 agent 的「平滑流式」来做：首字延迟相当于 TTFT，之后按词块匀速释放，
 * 标点后稍微停一下。不用缓动、也不把整篇硬压进一两秒——那样前段哗哗出、
 * 后段一下补齐，正是现在看着「突然全部显示」的原因。
 * 26 字/秒约合 30~40 token/s，接近人正常阅读的速度。
 */
const REVEAL_CHARS_PER_SECOND = 26;
const REVEAL_FIRST_DELAY_MS = 220;
const REVEAL_MAX_MS = 14000;
const PAUSE_SENTENCE_MS = 130;
const PAUSE_CLAUSE_MS = 45;

/** ES2020 lib 里没有 Intl.Segmenter 的类型，运行时探测后用局部接口约束。 */
type SegmenterLike = { segment(input: string): Iterable<{ segment: string }> };
const SegmenterCtor = (
  Intl as unknown as {
    Segmenter?: new (locale: string, options: { granularity: "word" }) => SegmenterLike;
  }
).Segmenter;

/** 中文没有空格边界，逐字蹦会碎；优先按词切块，老浏览器退回正则切块。 */
function revealChunks(text: string): string[] {
  const raw: string[] = [];
  if (SegmenterCtor) {
    const segmenter = new SegmenterCtor("zh", { granularity: "word" });
    for (const part of segmenter.segment(text)) {
      if (part.segment) {
        raw.push(part.segment);
      }
    }
  } else {
    raw.push(...(text.match(/[\u3400-\u9fff]|[A-Za-z0-9_]+|\s+|[^\s]/gu) ?? []));
  }
  // 纯空白并进前一块，别让一个空格单独占一帧。
  const chunks: string[] = [];
  for (const part of raw) {
    if (chunks.length > 0 && /^\s+$/.test(part)) {
      chunks[chunks.length - 1] += part;
    } else {
      chunks.push(part);
    }
  }
  return chunks.length > 0 ? chunks : text ? [text] : [];
}

type RevealTimeline = { chunks: string[]; ends: number[]; totalMs: number };

function buildRevealTimeline(text: string): RevealTimeline {
  const chunks = revealChunks(text);
  const pauses: number[] = chunks.map((chunk) => {
    const tail = chunk.trim().slice(-1);
    if (/[。！？!?；;\n]/.test(tail)) {
      return PAUSE_SENTENCE_MS;
    }
    if (/[，,、：:）)]/.test(tail)) {
      return PAUSE_CLAUSE_MS;
    }
    return 0;
  });
  const baseMs = (Array.from(text).length / REVEAL_CHARS_PER_SECOND) * 1000;
  const rawTotal = baseMs + pauses.reduce((sum, value) => sum + value, 0);
  // 超长文本整体等比压缩到上限，依旧匀速，不会中途突然加速。
  const scale = rawTotal > REVEAL_MAX_MS ? REVEAL_MAX_MS / rawTotal : 1;
  let elapsed = 0;
  const ends = chunks.map((chunk, index) => {
    elapsed +=
      ((Array.from(chunk).length / REVEAL_CHARS_PER_SECOND) * 1000 + pauses[index]) * scale;
    return elapsed;
  });
  return { chunks, ends, totalMs: elapsed };
}

/** 单条回复：只有正文，不套框不限高；轮到它才挂载并开始出字，播完再通知父级放行下一条。 */
function ReplyBlock({ item, turnId, onDone }: { item: DebugFeedMessage; turnId: string; onDone: () => void }) {
  const revealKey = `${turnId}:${item.id}`;
  const [needsReveal] = useState(
    () => item.reveal && !item.streaming && !revealedReplyIds.has(revealKey)
  );
  const timeline = useMemo(() => buildRevealTimeline(item.text), [item.text]);
  const [shown, setShown] = useState(() => (needsReveal ? 0 : timeline.chunks.length));
  const finishedRef = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    if (finishedRef.current) {
      return;
    }
    // 不做动画（关掉流式开关、旧协议还在追分片、空文本）：整篇显示，立刻放行下一条。
    if (!needsReveal || timeline.chunks.length === 0) {
      finishedRef.current = true;
      setShown(timeline.chunks.length);
      revealedReplyIds.add(revealKey);
      onDoneRef.current();
      return;
    }
    let startedAt = 0;
    let frame = 0;
    let cursor = 0;
    const tick = (now: number) => {
      if (!startedAt) {
        startedAt = now;
      }
      const elapsed = now - startedAt - REVEAL_FIRST_DELAY_MS;
      if (elapsed < 0) {
        frame = requestAnimationFrame(tick);
        return;
      }
      // 线性推进：时间到哪就显示到哪块，末尾逐块补齐而不是一次甩出全文。
      while (cursor < timeline.ends.length && timeline.ends[cursor] <= elapsed) {
        cursor += 1;
      }
      setShown(cursor);
      if (elapsed >= timeline.totalMs) {
        finishedRef.current = true;
        setShown(timeline.chunks.length);
        revealedReplyIds.add(revealKey);
        onDoneRef.current();
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [needsReveal, revealKey, timeline]);

  const revealing = needsReveal && shown < timeline.chunks.length;
  const visible = revealing ? timeline.chunks.slice(0, shown).join("") : item.text;
  // 真流式（streaming=true）的半截 markdown 也走安全渲染，防止 **、表格
  // 写到一半时把标记当正文渲染出来。
  const html = useMemo(
    () =>
      renderMarkdown(revealing || item.streaming ? streamSafeMarkdown(visible) : visible),
    [visible, revealing, item.streaming]
  );

  return (
    <div className="platform-debug-reply">
      <div
        className={`platform-debug-reply-text message-markdown${revealing ? " is-revealing" : ""}`}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

/**
 * 人工输入提示：轮到它才出现，出现后立刻把播放头往后推。
 * 后端在人工节点挂起时立刻下发提示，而上一条回复可能还在逐字播；
 * 靠播放头排序，提示一定排在问题后面。
 */
function PromptLine({ text, onDone }: { text: string; onDone: () => void }) {
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const finishedRef = useRef(false);

  useEffect(() => {
    if (finishedRef.current) {
      return;
    }
    finishedRef.current = true;
    onDoneRef.current();
  }, []);

  return <p className="platform-debug-prompt">{text}</p>;
}

/** 用户回答在时间线上的占位：渲染出来就放行，不排队也不播动画。 */
function InstantLine({ text, onDone }: { text: string; onDone: () => void }) {
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const finishedRef = useRef(false);

  useEffect(() => {
    if (finishedRef.current) {
      return;
    }
    finishedRef.current = true;
    onDoneRef.current();
  }, []);

  return <div className="platform-debug-user-inline">{text}</div>;
}

