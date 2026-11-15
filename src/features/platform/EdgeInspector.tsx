import { useEffect, useState } from "react";
import { ArrowRight, GitBranch, Trash2 } from "lucide-react";
import type { WorkflowEdge, WorkflowNode } from "./types";
import { choiceIndexOfPort, choiceOptionsOf, isChoiceOtherPort } from "./choicePorts";

type EdgeInspectorProps = {
  edge: WorkflowEdge;
  source?: WorkflowNode;
  target?: WorkflowNode;
  /** 同一个上游节点上还有别的、带条件的出边：这条无条件线此时是兜底。 */
  siblingGated?: boolean;
  onChange: (patch: Partial<Pick<WorkflowEdge, "label" | "when">>) => void;
  onDelete: () => void;
  onClose: () => void;
};

/** 与编译器保持同一语法：${节点或输入.字段} 可选跟一个比较运算符与字面量。 */
const EXPRESSION_PATTERN = /^\s*\$\{([^}\s]+)\}\s*(?:(<=|>=|==|!=|<|>)\s*(.+?))?\s*$/;

export function EdgeInspector({
  edge,
  source,
  target,
  siblingGated = false,
  onChange,
  onDelete,
  onClose
}: EdgeInspectorProps) {
  const [label, setLabel] = useState(edge.label ?? "");
  const [condition, setCondition] = useState(edge.when ?? "");

  useEffect(() => {
    setLabel(edge.label ?? "");
    setCondition(edge.when ?? "");
  }, [edge.from, edge.to, edge.label, edge.when]);

  const trimmedCondition = condition.trim();
  const conditionError =
    trimmedCondition && !EXPRESSION_PATTERN.test(trimmedCondition)
      ? "条件只支持 ${节点.字段} 运算符 值，例如 ${verify.score} < 0.85。"
      : undefined;
  const dirty = label !== (edge.label ?? "") || condition !== (edge.when ?? "");
  // 选项卡拉出来的线：告诉用户这条挂在哪个选项上，免得改选项后不知道哪条线会失效。
  const otherPort = isChoiceOtherPort(edge.fromPort);
  const portIndex = choiceIndexOfPort(edge.fromPort);
  const portLabel =
    portIndex !== undefined && source ? choiceOptionsOf(source)[portIndex] : undefined;

  function commit() {
    if (conditionError || !dirty) {
      return;
    }
    onChange({
      ...(label.trim() !== (edge.label ?? "") ? { label: label.trim() || undefined } : {}),
      ...(trimmedCondition !== (edge.when ?? "")
        ? { when: trimmedCondition || undefined }
        : {})
    });
  }

  return (
    <aside className="platform-inspector">
      <header className="platform-inspector-head">
        <div>
          <span className="platform-inspector-kind" style={{ color: "#a8552c" }}>
            连线
          </span>
          <h2>
            {source?.title || edge.from} <ArrowRight size={13} aria-hidden /> {target?.title || edge.to}
          </h2>
        </div>
      </header>

      <p className="platform-inspector-note">
        条件为真时这条边才激活；若某个节点的全部入边都未激活，该节点会标记为「跳过」并继续向下游传播。
      </p>

      {!edge.when?.trim() && siblingGated && (
        <p className="platform-inspector-note">
          这个节点上还有带条件的分支，所以这条无条件线当兜底用：只有那些条件都不成立时才会走到这里。
        </p>
      )}

      {portIndex !== undefined && (
        <p className="platform-inspector-note">
          这条线从「选项 {portIndex + 1}」拉出
          {portLabel ? `（${portLabel}）` : ""}：只有用户点了这一项才会走到下游，其余分支保持跳过。
        </p>
      )}

      {otherPort && (
        <p className="platform-inspector-note">
          这条线从「其他」兜底出口拉出：用户点了「其他」、或输入的内容不在上面几个选项里时走这里。
        </p>
      )}

      <div className="platform-field-list">
        <label className="platform-field">
          <span>连线标签</span>
          <input
            value={label}
            placeholder="例如：口径正确 / 兜底"
            onChange={(event) => setLabel(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
          />
          <small>显示在连线中点，用于说明这条分支的业务含义。</small>
        </label>

        <label className="platform-field">
          <span>
            <GitBranch size={12} /> 边条件
          </span>
          <input
            value={condition}
            placeholder="${verify.score} >= 0.8"
            className={conditionError ? "has-error" : undefined}
            onChange={(event) => setCondition(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
          />
          <small className={conditionError ? "platform-error-text" : undefined}>
            {conditionError ??
              "留空表示无条件激活。只能引用上游节点或 input.*；表达式中不要包含后续节点。"}
          </small>
        </label>
      </div>

      <div className="platform-edge-inspector-actions">
        <button type="button" className="platform-button" onClick={commit} disabled={!dirty || Boolean(conditionError)}>
          应用修改
        </button>
        <button type="button" className="platform-button is-ghost" onClick={onClose}>
          收起面板
        </button>
        <button type="button" className="platform-button is-reject" onClick={onDelete}>
          <Trash2 size={13} /> 删除连线
        </button>
      </div>
    </aside>
  );
}
