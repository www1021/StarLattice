import { useEffect, useState } from "react";
import { ArrowRight, GitBranch, Trash2 } from "lucide-react";
import type { WorkflowEdge, WorkflowNode } from "./types";

type EdgeInspectorProps = {
  edge: WorkflowEdge;
  source?: WorkflowNode;
  target?: WorkflowNode;
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
          <span className="platform-inspector-kind" style={{ color: "#6366f1" }}>
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
