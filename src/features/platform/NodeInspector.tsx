import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Eye, Lock, Play, Trash2 } from "lucide-react";
import { platformApi } from "./api";
import {
  blockChildren,
  createLeafNode,
  uniqueNodeId,
  withBlockChildren,
  type RunNodeStatus
} from "./layout";
import type { NodeBlock, NodeField, NodeKind, NodeTypeSpec, WorkflowNode } from "./types";

type InspectorProps = {
  definition: WorkflowNode;
  spec?: NodeTypeSpec;
  specs: NodeTypeSpec[];
  commonFields: NodeField[];
  usedIds: Set<string>;
  status?: RunNodeStatus;
  onChange: (next: WorkflowNode) => void;
  onDelete: () => void;
  onOpenSubflow?: (workflowId: string, version?: number) => void;
  onTrialRun?: () => void;
  trialState?: "idle" | "running";
};

const CHILD_KINDS: NodeKind[] = [
  "agent",
  "llm",
  "clarify",
  "knowledge",
  "tool",
  "http",
  "template",
  "subworkflow",
  "verify",
  "approve",
  "human"
];

export function NodeInspector({
  definition,
  spec,
  specs,
  commonFields,
  usedIds,
  status,
  onChange,
  onDelete,
  onOpenSubflow,
  onTrialRun,
  trialState
}: InspectorProps) {
  const [expandedChild, setExpandedChild] = useState<string | undefined>();
  const [childKinds, setChildKinds] = useState<Record<string, NodeKind>>({});

  return (
    <aside className="platform-inspector">
      <header className="platform-inspector-head">
        <div>
          <span className="platform-inspector-kind" style={{ color: spec?.accent }}>
            {spec?.label ?? definition.kind}
          </span>
          <h2>{definition.title || definition.id}</h2>
        </div>
        {status && <span className={`platform-run-status is-${status}`}>{statusLabel(status)}</span>}
      </header>

      <p className="platform-inspector-note">
        节点 ID <code>{definition.id}</code> 创建后不可修改，引用依赖它定位。
      </p>

      {onTrialRun && (
        <div className="platform-trial-entry">
          <button
            type="button"
            className="platform-button is-ghost"
            onClick={onTrialRun}
            disabled={trialState === "running"}
          >
            {trialState === "running" ? (
              <Play size={14} className="is-spinning" />
            ) : (
              <Play size={14} />
            )}
            试跑到此节点
          </button>
          <small>执行到该节点后停止，后续节点保持未执行；输出在运行面板里查看。</small>
        </div>
      )}

      <div className="platform-field-list">
        {commonFields
          .filter((field) => field.key !== "id")
          .map((field) => (
            <FieldRow
              key={`${definition.id}-${field.key}`}
              field={field}
              value={(definition as Record<string, unknown>)[field.key]}
              onChange={(value) => onChange({ ...definition, [field.key]: value } as WorkflowNode)}
            />
          ))}
        {spec?.fields.map((field) =>
          field.key === "agentVersion" && definition.kind === "agent" ? (
            <AgentVersionField
              key={`${definition.id}-${field.key}`}
              definition={definition}
              field={field}
              onChange={(value) => onChange({ ...definition, agentVersion: value } as WorkflowNode)}
            />
          ) : (
            <FieldRow
              key={`${definition.id}-${field.key}`}
              field={field}
              value={(definition as Record<string, unknown>)[field.key]}
              onChange={(value) =>
                onChange({
                  ...definition,
                  [field.key]: value,
                  // 换 Agent 后旧版本号不再有意义，留空即跟随新 Agent 的最新版。
                  ...(field.key === "agent" ? { agentVersion: undefined } : {})
                } as WorkflowNode)
              }
            />
          )
        )}
      </div>

      {definition.kind === "subworkflow" && (
        <section className="platform-subflow-entry">
          <div>
            <strong>
              <Lock size={13} /> 子工作流只读边界
            </strong>
            <small>子流程拥有独立输入作用域，内部节点请到子流程本身编辑；这里只查看结构。</small>
          </div>
          <button
            type="button"
            className="platform-button is-ghost"
            disabled={!definition.workflowId || !onOpenSubflow}
            onClick={() =>
              definition.workflowId && onOpenSubflow
                ? onOpenSubflow(definition.workflowId, definition.workflowVersion)
                : undefined
            }
          >
            <Eye size={14} /> 打开子流程
          </button>
        </section>
      )}

      {spec?.blocks.map((block) => (
        <BlockEditor
          key={`${definition.id}-${block.key}`}
          block={block}
          definition={definition}
          specs={specs}
          usedIds={usedIds}
          expandedChild={expandedChild}
          childKind={childKinds[block.key] ?? "agent"}
          onExpand={(childKey) => setExpandedChild((current) => (current === childKey ? undefined : childKey))}
          onChildKindChange={(kind) => setChildKinds((current) => ({ ...current, [block.key]: kind }))}
          onChange={onChange}
        />
      ))}

      <button type="button" className="platform-danger" onClick={onDelete}>
        <Trash2 size={14} /> 删除该节点
      </button>
    </aside>
  );
}

type BlockEditorProps = {
  block: NodeBlock;
  definition: WorkflowNode;
  specs: NodeTypeSpec[];
  usedIds: Set<string>;
  expandedChild?: string;
  childKind: NodeKind;
  onExpand: (key: string) => void;
  onChildKindChange: (kind: NodeKind) => void;
  onChange: (next: WorkflowNode) => void;
};

function BlockEditor({
  block,
  definition,
  specs,
  usedIds,
  expandedChild,
  childKind,
  onExpand,
  onChildKindChange,
  onChange
}: BlockEditorProps) {
  const children = blockChildren(definition, block.key);
  const childId = uniqueNodeId(`${definition.id}-step`, usedIds);

  const updateChild = (index: number, next: WorkflowNode) => {
    const copy = [...children];
    copy[index] = next;
    onChange(withBlockChildren(definition, block.key, copy));
  };

  return (
    <section className="platform-block">
      <header>
        <strong>{block.label}</strong>
        <span>{children.length} 个节点{block.required ? " · 必填" : ""}</span>
      </header>

      {children.map((child, index) => {
        const childKey = `${block.key}-${index}`;
        const expanded = expandedChild === childKey;
        const childSpec = specs.find((item) => item.kind === child.kind);
        const isContainer = child.kind === "parallel" || child.kind === "condition" || child.kind === "loop";
        return (
          <div className="platform-child" key={childKey}>
            <div className="platform-child-head">
              <button type="button" className="platform-child-toggle" onClick={() => onExpand(childKey)}>
                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span className="platform-child-kind" style={{ color: childSpec?.accent }}>
                  {childSpec?.label ?? child.kind}
                </span>
                <span className="platform-child-title">{child.title || child.id}</span>
              </button>
              <button
                type="button"
                className="platform-icon-button"
                title="删除"
                onClick={() => {
                  onChange(
                    withBlockChildren(
                      definition,
                      block.key,
                      children.filter((_, position) => position !== index)
                    )
                  );
                  onExpand("");
                }}
              >
                <Trash2 size={13} />
              </button>
            </div>

            {expanded && (
              <div className="platform-child-body">
                <label className="platform-field">
                  <span>节点 ID</span>
                  <input
                    value={child.id}
                    onChange={(event) => {
                      const nextId = event.target.value.trim();
                      if (nextId) {
                        updateChild(index, { ...child, id: nextId });
                      }
                    }}
                    spellCheck={false}
                  />
                </label>
                <FieldRow
                  key={`${childKey}-title`}
                  field={{ key: "title", label: "显示名称", type: "text" }}
                  value={child.title}
                  onChange={(value) => updateChild(index, { ...child, title: String(value ?? "") })}
                />
                {isContainer ? (
                  <p className="platform-hint">嵌套容器暂不支持在此编辑结构，请在顶层使用同类型节点。</p>
                ) : (
                  childSpec?.fields.map((field) => (
                    <FieldRow
                      key={`${childKey}-${field.key}`}
                      field={field}
                      value={(child as Record<string, unknown>)[field.key]}
                      onChange={(value) => updateChild(index, { ...child, [field.key]: value } as WorkflowNode)}
                    />
                  ))
                )}
              </div>
            )}
          </div>
        );
      })}

      <div className="platform-block-add">
        <select value={childKind} onChange={(event) => onChildKindChange(event.target.value as NodeKind)}>
          {CHILD_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {specs.find((item) => item.kind === kind)?.label ?? kind}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() =>
            onChange(
              withBlockChildren(definition, block.key, [...children, createLeafNode(childKind, childId)])
            )
          }
        >
          + 添加步骤
        </button>
      </div>
    </section>
  );
}

type FieldRowProps = {
  field: NodeField;
  value: unknown;
  onChange: (value: unknown) => void;
};

function AgentVersionField({
  definition,
  field,
  onChange
}: {
  definition: WorkflowNode;
  field: NodeField;
  onChange: (value: unknown) => void;
}) {
  const agentId = typeof definition.agent === "string" ? definition.agent : "";
  const current = typeof definition.agentVersion === "number" ? definition.agentVersion : undefined;
  const [versions, setVersions] = useState<number[]>([]);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");

  useEffect(() => {
    if (!agentId) {
      setVersions([]);
      setState("idle");
      return;
    }
    let cancelled = false;
    setState("loading");
    platformApi
      .listAgentVersions(agentId)
      .then((response) => {
        if (cancelled) {
          return;
        }
        setVersions([...new Set(response.versions.map((item) => item.version))].sort((a, b) => b - a));
        setState("idle");
      })
      .catch(() => {
        if (!cancelled) {
          setVersions([]);
          setState("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  return (
    <label className="platform-field">
      <span>{field.label}</span>
      <select
        value={current === undefined ? "" : String(current)}
        onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))}
        disabled={!agentId}
      >
        <option value="">跟随最新版本</option>
        {versions.map((version) => (
          <option key={version} value={version}>
            v{version}
          </option>
        ))}
        {current !== undefined && !versions.includes(current) && (
          <option value={current}>v{current}（当前）</option>
        )}
      </select>
      <small>
        {!agentId
          ? "先选择 Agent。"
          : state === "loading"
            ? "读取版本快照…"
            : state === "error"
              ? "版本列表读取失败，留空仍可跟随最新版。"
              : field.help}
      </small>
    </label>
  );
}

function FieldRow({ field, value, onChange }: FieldRowProps) {
  if (field.type === "select" && field.options && field.options.length > 0) {
    const current = typeof value === "string" ? value : "";
    // 已保存的值可能不在最新列表里（被引用流程已删除），保留它以免编辑时悄悄丢失配置。
    const options = current && !field.options.includes(current) ? [current, ...field.options] : field.options;
    return (
      <label className="platform-field">
        <span>{field.label}</span>
        <select value={current} onChange={(event) => onChange(event.target.value)}>
          <option value="">请选择…</option>
          {options.map((option) => (
            <option key={option} value={option}>
              {field.optionLabels?.[option] ?? option}
            </option>
          ))}
        </select>
        {field.help && <small>{field.help}</small>}
      </label>
    );
  }

  if (field.type === "json") {
    return <JsonField field={field} value={value} onChange={onChange} />;
  }

  if (field.type === "list") {
    const text = Array.isArray(value) ? value.join("\n") : "";
    return (
      <label className="platform-field">
        <span>{field.label}</span>
        <textarea
          rows={3}
          value={text}
          placeholder={field.placeholder}
          onChange={(event) =>
            onChange(
              event.target.value
                .split("\n")
                .map((item) => item.trim())
                .filter(Boolean)
            )
          }
        />
        {field.help && <small>{field.help}</small>}
      </label>
    );
  }

  if (field.type === "textarea") {
    return (
      <label className="platform-field">
        <span>{field.label}</span>
        <textarea
          rows={3}
          value={typeof value === "string" ? value : ""}
          placeholder={field.placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
        {field.help && <small>{field.help}</small>}
      </label>
    );
  }

  if (field.type === "boolean") {
    return (
      <label className="platform-field">
        <span>{field.label}</span>
        <select
          value={value === true ? "true" : value === false ? "false" : ""}
          onChange={(event) => {
            const next = event.target.value;
            onChange(next === "" ? undefined : next === "true");
          }}
        >
          <option value="">自动</option>
          <option value="true">是</option>
          <option value="false">否</option>
        </select>
        {field.help && <small>{field.help}</small>}
      </label>
    );
  }

  return (
    <label className="platform-field">
      <span>{field.label}</span>
      <input
        type={field.type === "number" ? "number" : "text"}
        step={field.type === "number" ? 0.01 : undefined}
        value={typeof value === "number" || typeof value === "string" ? value : ""}
        placeholder={field.placeholder}
        spellCheck={false}
        onChange={(event) => {
          if (field.type === "number") {
            onChange(event.target.value === "" ? undefined : Number(event.target.value));
            return;
          }
          onChange(event.target.value);
        }}
      />
      {field.help && <small>{field.help}</small>}
    </label>
  );
}

function JsonField({ field, value, onChange }: FieldRowProps) {
  const [error, setError] = useState<string>();
  return (
    <label className="platform-field">
      <span>{field.label}</span>
      <textarea
        rows={5}
        defaultValue={value === undefined ? "{}" : JSON.stringify(value, null, 2)}
        spellCheck={false}
        onBlur={(event) => {
          const raw = event.target.value.trim();
          if (!raw) {
            onChange({});
            setError(undefined);
            return;
          }
          try {
            onChange(JSON.parse(raw) as Record<string, unknown>);
            setError(undefined);
          } catch {
            setError("JSON 格式不正确，本次修改未保存。");
          }
        }}
      />
      {error ? <small className="platform-error-text">{error}</small> : field.help && <small>{field.help}</small>}
    </label>
  );
}

function statusLabel(status: RunNodeStatus): string {
  if (status === "succeeded") {
    return "已通过";
  }
  if (status === "failed") {
    return "失败";
  }
  return "运行中";
}
