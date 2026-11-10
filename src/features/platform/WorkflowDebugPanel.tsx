import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Loader2,
  MessageSquareText,
  Play,
  RotateCcw,
  Send,
  X,
  XCircle
} from "lucide-react";
import { platformApi } from "./api";
import { aggregateStatuses, isActiveRun, runStatusLabel, type RunNodeStatus } from "./layout";
import type {
  RunRecord,
  StepRecord,
  TraceResponse,
  WorkflowDefinition,
  WorkflowVariable
} from "./types";

/** 调试会话中的一轮：用户输入 + 一条 run 的结果。只存在本页内存，不落库。 */
type DebugTurn = {
  id: string;
  userText: string;
  input: Record<string, unknown>;
  runId?: string;
  run?: RunRecord;
  steps: StepRecord[];
  output?: unknown;
  error?: string;
  nodeSummaries: { nodeId: string; status: RunNodeStatus; durationMs: number }[];
};

type WorkflowDebugPanelProps = {
  definition: WorkflowDefinition;
  workflowId: string;
  trace?: TraceResponse;
  runStatuses: Map<string, RunNodeStatus>;
  nodeDurations: Map<string, number>;
  selectedNodeId?: string;
  onTrace: (trace: TraceResponse | undefined) => void;
  onRunningChange: (running: boolean) => void;
  onSelectNode: (nodeId: string) => void;
  onClose: () => void;
};

function formatJson(value: unknown): string {
  if (value === undefined) {
    return "（无输出）";
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatDuration(ms?: number): string {
  if (ms === undefined) {
    return "—";
  }
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/** v1 输入映射：自然语言整句填进第一个字符串输入，其余必填项给中性默认值。 */
function defaultInputValues(definition: WorkflowDefinition): Record<string, string> {
  const values: Record<string, string> = {};
  for (const variable of definition.inputs) {
    values[variable.name] =
      variable.type === "boolean" ? "false" : variable.type === "number" ? "0" : "";
  }
  return values;
}

function firstTextField(definition: WorkflowDefinition): WorkflowVariable | undefined {
  return (
    definition.inputs.find((item) => item.type === "string") ??
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

/** 与画布节点卡片用同一套状态聚合规则，避免两处显示不一致。 */
function nodeSummariesOf(trace: TraceResponse | undefined) {
  const statuses = aggregateStatuses(trace?.steps ?? []);
  const durations = new Map<string, number>();
  for (const step of trace?.steps ?? []) {
    const root = step.path.split("/")[0] || step.nodeId;
    durations.set(root, (durations.get(root) ?? 0) + (step.durationMs ?? 0));
  }
  return [...durations.entries()].map(([nodeId, durationMs]) => ({
    nodeId,
    status: statuses.get(nodeId) ?? ("succeeded" as RunNodeStatus),
    durationMs
  }));
}

function outputOf(trace: TraceResponse | undefined): unknown {
  if (!trace) {
    return undefined;
  }
  if (trace.run.output !== undefined) {
    return trace.run.output;
  }
  const lastWithOutput = [...trace.steps].reverse().find((step) => step.output !== undefined);
  return lastWithOutput?.output;
}

export function WorkflowDebugPanel({
  definition,
  workflowId,
  trace,
  runStatuses,
  nodeDurations,
  selectedNodeId,
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
  const [expandedTurns, setExpandedTurns] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const runTokenRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const targetField = firstTextField(definition);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, busy]);

  useEffect(() => {
    return () => {
      runTokenRef.current += 1;
      onRunningChange(false);
    };
    // 只在卸载时清理，避免每次渲染都触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit() {
    const userText = text.trim();
    if (!userText || busy) {
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
    setBusy(true);
    onRunningChange(true);
    setNotice(undefined);
    setText("");
    setTurns((current) => [
      ...current,
      { id: turnId, userText, input, steps: [], nodeSummaries: [] }
    ]);
    onTrace(undefined);

    const updateTurn = (patch: Partial<DebugTurn>) => {
      setTurns((current) =>
        current.map((turn) => (turn.id === turnId ? { ...turn, ...patch } : turn))
      );
    };

    try {
      const { run } = await platformApi.startRun(workflowId, input);
      updateTurn({ runId: run.id });
      let current = await platformApi.trace(run.id);
      if (runTokenRef.current !== runToken) {
        return;
      }
      onTrace(current);
      while (runTokenRef.current === runToken && isActiveRun(current.run.status)) {
        await new Promise((resolve) => window.setTimeout(resolve, 600));
        current = await platformApi.trace(run.id);
        if (runTokenRef.current === runToken) {
          onTrace(current);
        }
      }
      if (runTokenRef.current !== runToken) {
        return;
      }
      updateTurn({
        run: current.run,
        steps: current.steps,
        output: outputOf(current),
        error: current.run.error,
        nodeSummaries: nodeSummariesOf(current)
      });
    } catch (error) {
      updateTurn({ error: error instanceof Error ? error.message : String(error) });
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      if (runTokenRef.current === runToken) {
        setBusy(false);
        onRunningChange(false);
      }
    }
  }

  function clear() {
    runTokenRef.current += 1;
    setTurns([]);
    setNotice(undefined);
    setText("");
    setBusy(false);
    onTrace(undefined);
    onRunningChange(false);
  }

  const selectedSteps = selectedNodeId
    ? (trace?.steps ?? []).filter((step) => step.path.split("/")[0] === selectedNodeId)
    : [];
  const selectedStatus = selectedNodeId ? runStatuses.get(selectedNodeId) : undefined;

  return (
    <div className="platform-debug-side">
      <div className="platform-debug-panel">
        <header className="platform-debug-head">
          <div className="platform-debug-head-main">
            <MessageSquareText size={16} />
            <div>
              <strong>工作流调试</strong>
              <span>{definition.name} · 输入一句话走完整流程</span>
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
              <strong>输入一个问题开始调试</strong>
              <p>
                例如「围绕勾股定理生成一份教案」。运行后左侧画布会逐节点高亮并显示耗时，
                点击节点可在这里查看该步的输入、输出与错误。
              </p>
            </div>
          )}
          {turns.map((turn) => (
            <div key={turn.id} className="platform-debug-turn">
              <div className="platform-debug-bubble is-user">{turn.userText}</div>
              <div className="platform-debug-bubble is-assistant">
                <div className="platform-debug-bubble-head">
                  {turn.run ? (
                    turn.run.status === "succeeded" ? (
                      <CheckCircle2 size={13} />
                    ) : (
                      <XCircle size={13} />
                    )
                  ) : turn.error ? (
                    <XCircle size={13} />
                  ) : (
                    <Loader2 size={13} className="is-spinning" />
                  )}
                  <span>
                    {turn.run
                      ? `${runStatusLabel(turn.run.status)} · ${turn.steps.length} 步 · ${formatDuration(turn.run.durationMs)}`
                      : turn.error
                        ? "运行失败"
                        : "运行中…"}
                  </span>
                  {turn.runId && <code>{turn.runId.slice(0, 8)}</code>}
                </div>
                {turn.error && <p className="platform-debug-error">{turn.error}</p>}
                {turn.nodeSummaries.length > 0 && (
                  <div className="platform-debug-nodes">
                    {turn.nodeSummaries.map((node) => (
                      <button
                        key={node.nodeId}
                        type="button"
                        className={`platform-debug-node is-${node.status}`}
                        onClick={() => onSelectNode(node.nodeId)}
                      >
                        <span>{node.nodeId}</span>
                        <em>{formatDuration(node.durationMs)}</em>
                      </button>
                    ))}
                  </div>
                )}
                {turn.output !== undefined && (
                  <>
                    <button
                      type="button"
                      className="platform-debug-toggle"
                      onClick={() =>
                        setExpandedTurns((current) => {
                          const next = new Set(current);
                          if (next.has(turn.id)) {
                            next.delete(turn.id);
                          } else {
                            next.add(turn.id);
                          }
                          return next;
                        })
                      }
                    >
                      {expandedTurns.has(turn.id) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      最终产物
                    </button>
                    {expandedTurns.has(turn.id) && (
                      <pre className="platform-debug-output">{formatJson(turn.output)}</pre>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>

        {selectedNodeId && (
          <div className="platform-debug-detail">
            <div className="platform-debug-detail-head">
              <span>
                节点详情 · <code>{selectedNodeId}</code>
              </span>
              {selectedStatus && <em className={`is-${selectedStatus}`}>{selectedStatus}</em>}
              <span className="platform-debug-detail-time">
                <Clock3 size={11} /> {formatDuration(nodeDurations.get(selectedNodeId))}
              </span>
            </div>
            {selectedSteps.length === 0 ? (
              <p className="platform-debug-note">本轮运行还没有这个节点的执行记录。</p>
            ) : (
              <div className="platform-debug-detail-body">
                {selectedSteps.map((step) => (
                  <details key={step.id} open={selectedSteps.length === 1}>
                    <summary>
                      <code>{step.path}</code>
                      <em>{step.status}</em>
                      <span>{formatDuration(step.durationMs)}</span>
                    </summary>
                    <p>输入</p>
                    <pre>{formatJson(step.input)}</pre>
                    <p>输出</p>
                    <pre>{formatJson(step.output)}</pre>
                    {step.error && <p className="platform-debug-error">{step.error}</p>}
                  </details>
                ))}
              </div>
            )}
          </div>
        )}

        {notice && (
          <div className="platform-debug-notice">
            <AlertTriangle size={13} /> {notice}
          </div>
        )}
        {busy && (
          <div className="platform-debug-progress">
            <Loader2 size={13} className="is-spinning" />
            节点执行中，左侧画布实时高亮…
          </div>
        )}

        <div className="platform-debug-composer">
          <textarea
            value={text}
            rows={2}
            placeholder="输入问题，回车发送（Shift+回车换行）"
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
            disabled={busy || !text.trim()}
            onClick={() => void submit()}
          >
            {busy ? <Loader2 size={14} className="is-spinning" /> : <Send size={14} />}
            发送
          </button>
        </div>
      </div>
    </div>
  );
}
