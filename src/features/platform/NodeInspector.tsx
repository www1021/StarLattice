import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import {
  AtSign,
  Braces,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Copy,
  Eye,
  Link2,
  Lock,
  Maximize2,
  Minimize2,
  Minus,
  MoreHorizontal,
  Play,
  Plus,
  Search,
  Settings2,
  Trash2,
  Type,
  X,
  type LucideIcon
} from "lucide-react";
import { platformApi } from "./api";
import {
  blockChildren,
  createLeafNode,
  uniqueNodeId,
  withBlockChildren,
  type RunNodeStatus
} from "./layout";
import { NODE_VISUALS, nodeTintStyle } from "./nodeVisuals";
import {
  buildRefAlias,
  displayFromRaw as displayWithAlias,
  rawFromDisplay as rawWithAlias
} from "./refAlias";
import type {
  ExtractParam,
  NodeBlock,
  NodeErrorStrategy,
  NodeField,
  NodeInputBinding,
  NodeKind,
  NodeOutputProperty,
  NodePortSource,
  NodePortSpec,
  NodePortType,
  NodeTypeSpec,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowVariable
} from "./types";

type InspectorProps = {
  definition: WorkflowNode;
  /** 整条工作流：用于算上游节点、工作流输入与下游连线。 */
  workflow: WorkflowDefinition;
  spec?: NodeTypeSpec;
  specs: NodeTypeSpec[];
  commonFields: NodeField[];
  usedIds: Set<string>;
  status?: RunNodeStatus;
  /** 最近一次运行的报错文本，用于在输出变量的 Error 分支里回显。 */
  lastError?: string;
  onChange: (next: WorkflowNode) => void;
  onDelete: () => void;
  onOpenSubflow?: (workflowId: string, version?: number) => void;
  onTrialRun?: () => void;
  trialState?: "idle" | "running";
  /** 关闭面板：右上角 X。 */
  onClose?: () => void;
  /** 从错误提示跳过来时，滚动并高亮「参数提取」节点里的第 N 行参数。 */
  focusParamIndex?: number | null;
  /** 同一下标连点两次也要重新滚动，用自增计数强制 effect 触发。 */
  focusParamNonce?: number;
};

/** 扁平项：给原生下拉（字段内联插入变量）用。 */
type RefOption = {
  value: string;
  label: string;
  group: string;
  type: NodePortType;
};

/** 引用树的一个字段节点；有 children 表示还能往下钻，钻到叶子才允许引用。 */
type RefField = {
  name: string;
  /** 相对节点输出的路径，如 output.content。 */
  path: string;
  token: string;
  type: NodePortType;
  desc?: string;
  children?: RefField[];
};

/** 引用树的一级：工作流输入，或某个上游节点。 */
type RefGroup = {
  key: string;
  label: string;
  kindLabel: string;
  kind?: NodeKind;
  nodeId?: string;
  color?: string;
  fields: RefField[];
};

const CHILD_KINDS: NodeKind[] = [
  "agent",
  "llm",
  "clarify",
  "extract",
  "knowledge",
  "tool",
  "http",
  "template",
  "subworkflow",
  "verify",
  "approve",
  "human"
];

const PORT_TYPES: NodePortType[] = ["string", "number", "boolean", "object", "array", "file"];
/** 与后端 strictRun 的默认输出节点判定保持一致：变量转换等 template 不算回复节点。 */
const REPLY_NODE_TITLE = /^(回复|回答|答复|输出|answer|output|respond)/i;
const TYPE_SHORT: Record<NodePortType, string> = {
  string: "str",
  number: "int",
  boolean: "bool",
  object: "obj",
  array: "arr",
  file: "file"
};
/** 类型列展示完整类型名。 */
const TYPE_LABEL: Record<NodePortType, string> = {
  string: "string",
  number: "int",
  boolean: "boolean",
  object: "object",
  array: "array",
  file: "file"
};
const PORT_SOURCES: Array<{ value: NodePortSource; label: string }> = [
  { value: "literal", label: "固定值" },
  { value: "reference", label: "引用上游节点" },
  { value: "variable", label: "工作流变量" },
  { value: "system", label: "系统变量" }
];

/** 模型区右侧齿轮展开的参数。 */
const MODEL_PARAM_KEYS = new Set(["temperature", "topP", "maxTokens", "thinking"]);
/** 由专属分区接管，不再落到通用字段列表里。 */
const DEDICATED_KEYS = new Set([
  "params",
  "model",
  "system",
  "prompt",
  "template",
  "outputFormat",
  "temperature",
  "topP",
  "maxTokens",
  "thinking"
]);

export function NodeInspector({
  definition,
  workflow,
  spec,
  specs,
  commonFields,
  usedIds,
  status,
  lastError,
  onChange,
  onDelete,
  onOpenSubflow,
  onTrialRun,
  trialState,
  onClose,
  focusParamIndex,
  focusParamNonce
}: InspectorProps) {
  const [expandedChild, setExpandedChild] = useState<string | undefined>();
  const [childKinds, setChildKinds] = useState<Record<string, NodeKind>>({});
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menuOpen]);

  const upstream = useMemo(() => upstreamNodes(workflow, definition.id), [workflow, definition.id]);
  const refGroups = useMemo(
    () => buildRefTree(workflow, upstream, specs),
    [workflow, upstream, specs]
  );
  const refOptions = useMemo(() => flattenRefGroups(refGroups), [refGroups]);
  /**
   * 本节点「输入变量」表里的入参，也进变量面板。
   * token 用的是变量名本身（${template}），不是它绑定的那串 ${节点id.字段}：
   * 一是不长，正文里和插入后看到的是同一个东西；二是执行器现在按节点入参解析这个名字。
   */
  const selfInputGroups = useMemo<RefGroup[]>(() => {
    const fields: RefField[] = [];
    for (const row of currentInputBindings(definition)) {
      const name = row.name?.trim();
      if (!name) {
        continue;
      }
      fields.push({
        name,
        path: name,
        token: "${" + name + "}",
        type: row.type ?? "string",
        desc: row.description || "本节点输入"
      });
    }
    return fields.length > 0
      ? [{ key: SELF_GROUP_KEY, label: "本节点输入变量", kindLabel: "输入参数", color: "#a8552c", fields }]
      : [];
  }, [definition, spec]);
  /** 正文编辑器里可选的变量：本节点输入在前，工作流输入与上游节点在后。 */
  const editorRefGroups = useMemo(
    () => [...selfInputGroups, ...refGroups],
    [selfInputGroups, refGroups]
  );

  const fields = spec?.fields ?? [];
  const modelField = fields.find((field) => field.key === "model");
  const modelParamFields = fields.filter((field) => MODEL_PARAM_KEYS.has(field.key));
  const systemField = fields.find((field) => field.key === "system");
  const promptField = fields.find((field) => field.key === "prompt");
  const outputFormatField = fields.find((field) => field.key === "outputFormat");
  /** 文本模板节点的正文：回复节点里它就是「回复内容」，单独占一个分区。 */
  const templateField = fields.find((field) => field.key === "template");
  /** 选项卡选完交给模型的那段指令；普通人工节点没有就是纯表单。 */
  const generatePromptField = fields.find((field) => field.key === "generatePrompt");
  /** 选项卡：选项 + 模型，是它与普通「人工交互」的区别。 */
  const isChoiceNode = definition.kind === "human";
  const restFields = fields.filter((field) => !DEDICATED_KEYS.has(field.key));
  const simpleFields = restFields.filter((field) => field.type !== "json");
  const jsonFields = restFields.filter((field) => field.type === "json");
  const common = commonFields.filter((field) => field.key !== "id");
  const visual = NODE_VISUALS[definition.kind];
  const Icon = visual?.icon ?? Link2;
  // 回复类 template 默认就是输出节点；变量转换等其它节点要显式打开才打印。
  const isReplyNode =
    definition.kind === "template" && REPLY_NODE_TITLE.test((definition.title ?? "").trim());
  // 选项卡配了模型或提示词就会产出回复，默认按输出节点对待，省得用户再去找开关。
  const emitsByChoice =
    definition.kind === "human" &&
    (Boolean(definition.generatePrompt?.trim()) || Boolean(definition.model));
  const emitOutput = definition.emitOutput ?? (isReplyNode || emitsByChoice);
  const streamOutput = definition.streamOutput ?? true;

  const renderField = (field: NodeField) =>
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
        refOptions={refOptions}
        onChange={(value) =>
          onChange({
            ...definition,
            [field.key]: value,
            ...(field.key === "agent" ? { agentVersion: undefined } : {})
          } as WorkflowNode)
        }
      />
    );

  const copyId = () => {
    void navigator.clipboard?.writeText(definition.id).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <aside className="platform-inspector ni-panel">
      <header className="ni-head">
        <div className="ni-head-main">
          <span
            className="ni-head-icon"
            style={visual ? nodeTintStyle(definition.kind) : undefined}
          >
            <Icon size={15} />
          </span>
          <div className="ni-head-text">
            <div className="ni-head-title-row">
              <h2>{definition.title || spec?.label || definition.id}</h2>
            </div>
            <input
              className="ni-head-desc"
              value={definition.description ?? ""}
              placeholder={spec?.description || "节点描述"}
              title={definition.description || spec?.description || "点击填写节点描述"}
              spellCheck={false}
              onChange={(event) => onChange({ ...definition, description: event.target.value })}
            />
          </div>
        </div>

        <div className="ni-head-actions" ref={menuRef}>
          {onTrialRun && (
            <button
              type="button"
              className="ni-icon-btn"
              title="试跑到此节点"
              onClick={onTrialRun}
              disabled={trialState === "running"}
            >
              <Play size={14} className={trialState === "running" ? "is-spinning" : undefined} />
            </button>
          )}
          <button
            type="button"
            className="ni-icon-btn"
            title="更多操作"
            onClick={() => setMenuOpen((current) => !current)}
          >
            <MoreHorizontal size={16} />
          </button>
          {menuOpen && (
            <div className="ni-menu">
              {onTrialRun && (
                <button type="button" onClick={() => { onTrialRun(); setMenuOpen(false); }}>
                  <Play size={13} /> 试跑到此节点
                </button>
              )}
              <button type="button" onClick={() => { copyId(); setMenuOpen(false); }}>
                <Copy size={13} /> 复制节点 ID
              </button>
              {definition.kind === "subworkflow" && onOpenSubflow && definition.workflowId && (
                <button
                  type="button"
                  onClick={() => {
                    onOpenSubflow(definition.workflowId!, definition.workflowVersion);
                    setMenuOpen(false);
                  }}
                >
                  <Eye size={13} /> 打开子流程
                </button>
              )}
              <button type="button" className="is-danger" onClick={() => { onDelete(); setMenuOpen(false); }}>
                <Trash2 size={13} /> 删除该节点
              </button>
            </div>
          )}
          {onClose && (
            <button
              type="button"
              className="ni-icon-btn ni-close"
              title="关闭面板"
              aria-label="关闭面板"
              onClick={onClose}
            >
              <X size={15} />
            </button>
          )}
        </div>

        <div className="ni-head-meta">
          <code title="节点 ID，引用上游时用它定位">{definition.id}</code>
          <button type="button" className="ni-copy" onClick={copyId}>
            <Copy size={11} /> {copied ? "已复制" : "复制"}
          </button>
          {status && <span className={`platform-run-status is-${status}`}>{statusLabel(status)}</span>}
        </div>
      </header>

      {modelField && (
        <ModelSection
          key={`${definition.id}-model`}
          field={modelField}
          paramFields={modelParamFields}
          definition={definition}
          icon={Icon}
          onChange={(patch) =>
            onChange({
              ...definition,
              ...patch,
              // 选项卡选了模型就意味着「要生成回复」，顺手把打印开关落下，行为才和面板一致。
              ...(definition.kind === "human" &&
              typeof patch.model === "string" &&
              patch.model.trim()
                ? { emitOutput: definition.emitOutput ?? true }
                : {})
            } as WorkflowNode)
          }
        />
      )}

      {definition.kind === "extract" && (
        <ExtractParamsSection
          key={`${definition.id}-params`}
          node={definition}
          onChange={onChange}
          focusParamIndex={focusParamIndex}
          focusParamNonce={focusParamNonce}
        />
      )}

      <InputSection
        key={`${definition.id}-inputs`}
        node={definition}
        spec={spec}
        refGroups={refGroups}
        workflowInputs={definition.kind === "start" ? workflow.inputs : undefined}
        onChange={onChange}
      />

      {templateField && (
        <PromptSection
          key={`${definition.id}-template`}
          title={isReplyNode ? "回复内容" : "模板内容"}
          info={
            isReplyNode
              ? "这段文字会原样回复给用户；输入 / 可插入本节点「输入变量」里的名字，运行时按引用取值。"
              : "用 ${节点.字段} 拼装确定性文本，不需要生成；输入 / 可插入本节点输入变量。"
          }
          field={templateField}
          value={(definition as Record<string, unknown>).template}
          refGroups={editorRefGroups}
          variant={isReplyNode ? "reply" : "prompt"}
          onChange={(value) => onChange({ ...definition, template: value } as WorkflowNode)}
        />
      )}

      {systemField && (
        <PromptSection
          key={`${definition.id}-system`}
          title={definition.kind === "llm" ? "系统提示词" : systemField.label}
          info="设定模型的角色、任务边界与输出要求；输入 / 可插入本节点「输入变量」里的名字。"
          field={systemField}
          value={(definition as Record<string, unknown>).system}
          refGroups={editorRefGroups}
          onChange={(value) => onChange({ ...definition, system: value } as WorkflowNode)}
        />
      )}
      {promptField && (
        <PromptSection
          key={`${definition.id}-prompt`}
          title={isChoiceNode ? "引导语" : definition.kind === "llm" ? "用户提示词" : promptField.label}
          info={
            isChoiceNode
              ? "提问本身：用户在这里看到要选什么，选完按下面的提示词生成回复。"
              : "本轮真正交给模型的指令，通常引用输入区里定义的变量。"
          }
          field={promptField}
          value={(definition as Record<string, unknown>).prompt}
          refGroups={editorRefGroups}
          onChange={(value) => onChange({ ...definition, prompt: value } as WorkflowNode)}
        />
      )}

      {/* 选项卡：用户能点的选项。有它才有得选，没有就只剩一句话输入框。 */}
      {isChoiceNode && (
        <ChoiceSection
          key={`${definition.id}-options`}
          node={definition}
          refOptions={refOptions}
          onChange={onChange}
        />
      )}

      {generatePromptField && (
        <PromptSection
          key={`${definition.id}-generate`}
          title="提示词"
          info="用户选完后交给模型的指令，可用 ${choice} 取选中的那一项；留空只把选择结果传给下游。"
          field={generatePromptField}
          value={(definition as Record<string, unknown>).generatePrompt}
          refGroups={editorRefGroups}
          onChange={(value) =>
            onChange({
              ...definition,
              generatePrompt: value,
              // 配了提示词就说明这里会产出回复，顺手打开打印，省得用户再找开关。
              ...(value.trim() ? { emitOutput: definition.emitOutput ?? true } : {})
            } as WorkflowNode)
          }
        />
      )}

      {/* 开始节点只是输入入口，不产生业务输出变量，按原版不展示输出变量区。 */}
      {definition.kind !== "start" && (
        <OutputSection
          key={`${definition.id}-outputs`}
          node={definition}
          spec={spec}
          hasFormatField={Boolean(outputFormatField)}
          lastError={lastError}
          onChange={onChange}
        />
      )}

      {/* 只有输出节点打印正文；流式开关决定逐字出现还是整篇显示。 */}
      {definition.kind !== "start" && (
        <Section
          key={`${definition.id}-reply-output`}
          title="回复输出"
          info="决定这个节点的产物是否打印到调试会话，以及打印时是否逐字出现。"
          defaultOpen={!isReplyNode}
        >
          <div className="ni-output-row">
            <div>
              <strong>打印到会话</strong>
              <small>
                {isReplyNode
                  ? "回复节点默认开启；关掉后只把变量传给下游"
                  : "非回复节点默认不打印，打开后视为输出节点"}
              </small>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={emitOutput}
              className={`ni-toggle${emitOutput ? " is-on" : ""}`}
              title={emitOutput ? "已开启：正文会打印到调试会话" : "已关闭：产物只向下游传递"}
              onClick={() =>
                onChange({ ...definition, emitOutput: !emitOutput } as WorkflowNode)
              }
            >
              <i />
            </button>
          </div>
          <div className="ni-output-row">
            <div>
              <strong>流式输出回复</strong>
              <small>打开逐字出现，关闭整篇一次显示</small>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={emitOutput && streamOutput}
              disabled={!emitOutput}
              className={`ni-toggle${emitOutput && streamOutput ? " is-on" : ""}`}
              title={
                !emitOutput
                  ? "先打开「打印到会话」"
                  : streamOutput
                    ? "已开启：回复逐字出现"
                    : "已关闭：回复整篇一次显示"
              }
              onClick={() =>
                onChange({ ...definition, streamOutput: !streamOutput } as WorkflowNode)
              }
            >
              <i />
            </button>
          </div>
          <p className="ni-note">
            只有打开「打印到会话」的节点会在调试面板里显示正文；其它节点的 output 只用于
            <code>${"{节点.字段}"}</code> 引用传递，不会重复打印。
          </p>
        </Section>
      )}

      <ErrorSection
        key={`${definition.id}-error`}
        node={definition}
        onChange={onChange}
      />

      {simpleFields.length > 0 && (
        <Section
          key={`${definition.id}-config`}
          title="节点配置"
          info="这类节点专属的运行参数，按节点类型自动显示。"
        >
          <div className="ni-field-stack">{simpleFields.map(renderField)}</div>
        </Section>
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
          refOptions={refOptions}
          onExpand={(childKey) => setExpandedChild((current) => (current === childKey ? undefined : childKey))}
          onChildKindChange={(kind) => setChildKinds((current) => ({ ...current, [block.key]: kind }))}
          onChange={onChange}
        />
      ))}

      <footer className="ni-footer">
        <span>改动会即时写入画布，保存后生效</span>
        <button type="button" onClick={onDelete}>
          <Trash2 size={12} /> 删除节点
        </button>
      </footer>
    </aside>
  );
}

/* ---------------- 分区骨架 ---------------- */

type SectionProps = {
  title: string;
  info?: string;
  actions?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
};

function Section({ title, info, actions, defaultOpen = true, children }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`ni-section${open ? " is-open" : ""}`}>
      <div className="ni-section-head">
        <button type="button" className="ni-section-toggle" onClick={() => setOpen((current) => !current)}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span>{title}</span>
          {info && (
            <span className="ni-info" title={info}>
              <CircleHelp size={12} />
            </span>
          )}
        </button>
        <div className="ni-section-actions">{actions}</div>
      </div>
      {open && <div className="ni-section-body">{children}</div>}
    </section>
  );
}

function AddButton({ onClick, title = "添加" }: { onClick: () => void; title?: string }) {
  return (
    <button type="button" className="ni-add" title={title} onClick={onClick}>
      <Plus size={14} />
    </button>
  );
}

function InfoTip({ text }: { text: string }) {
  return (
    <span className="ni-info" title={text}>
      <CircleHelp size={12} />
    </span>
  );
}

/* ---------------- 模型 ---------------- */

function ModelSection({
  field,
  paramFields,
  definition,
  icon: NodeIcon,
  onChange
}: {
  field: NodeField;
  paramFields: NodeField[];
  definition: WorkflowNode;
  icon: LucideIcon;
  onChange: (patch: Partial<WorkflowNode>) => void;
}) {
  const [paramsOpen, setParamsOpen] = useState(false);
  const rawModel = typeof definition.model === "string" ? definition.model : "";
  // 「platform-default」和空值是同一件事：跟随默认。归一成空值，下拉里不会出现两个同义项。
  const current = rawModel === "platform-default" ? "" : rawModel;
  const options = (field.options ?? []).filter((option) => option !== "platform-default");
  const withCurrent = current && !options.includes(current) ? [current, ...options] : options;
  const tuned = paramFields.filter((item) => {
    const value = (definition as Record<string, unknown>)[item.key];
    return value !== undefined && value !== "";
  }).length;

  return (
    <Section
      title="模型"
      info={field.help || "选择本节点调用的模型；留空使用平台默认模型。"}
      actions={
        paramFields.length > 0 && (
          <button
            type="button"
            className={`ni-text-btn${paramsOpen ? " is-active" : ""}`}
            title="展开模型参数"
            onClick={() => setParamsOpen((currentOpen) => !currentOpen)}
          >
            <Settings2 size={12} /> 参数{tuned > 0 ? ` · ${tuned}` : ""}
          </button>
        )
      }
    >
      <div className="ni-model-row">
        <span className="ni-model-icon">
          <NodeIcon size={14} />
        </span>
        <select
          className="ni-model-select"
          value={current}
          onChange={(event) => onChange({ model: event.target.value || undefined })}
        >
          <option value="">跟随默认模型</option>
          {withCurrent.map((option) => (
            <option key={option} value={option}>
              {field.optionLabels?.[option] ?? option}
            </option>
          ))}
        </select>
        <ChevronDown size={13} className="ni-model-caret" />
      </div>
      {options.length === 0 ? (
        <p className="ni-model-empty">还没有可用的模型，先到「设置 → 模型与密钥」里添加一个。</p>
      ) : null}
      {paramsOpen && paramFields.length > 0 && (
        <ModelParams definition={definition} fields={paramFields} onChange={onChange} />
      )}
    </Section>
  );
}

/** 带滑块的采样参数；留空表示跟随平台默认，滑块一拖就写入具体值。 */
const SLIDER_PARAMS: Record<string, { min: number; max: number; step: number; hint: string }> = {
  temperature: { min: 0, max: 2, step: 0.1, hint: "越高越发散，越低越稳定；写作类 0.7 左右，抽取类 0.1 左右。" },
  topP: { min: 0, max: 1, step: 0.05, hint: "从概率最高的词里按累积概率取样；调低会更保守。" }
};

function ModelParams({
  definition,
  fields,
  onChange
}: {
  definition: WorkflowNode;
  fields: NodeField[];
  onChange: (patch: Partial<WorkflowNode>) => void;
}) {
  const sliders = fields.filter((field) => SLIDER_PARAMS[field.key]);
  const tokenField = fields.find((field) => field.key === "maxTokens");
  const thinkingField = fields.find((field) => field.key === "thinking");

  return (
    <div className="ni-model-params">
      {sliders.map((field) => {
        const spec = SLIDER_PARAMS[field.key];
        const raw = (definition as Record<string, unknown>)[field.key];
        const value = typeof raw === "number" ? raw : undefined;
        return (
          <div className={`ni-param${value === undefined ? " is-default" : ""}`} key={field.key}>
            <div className="ni-param-head">
              <span>{field.label}</span>
              <em className={value === undefined ? "is-default" : undefined}>
                {value === undefined ? "跟随默认" : value}
              </em>
              {value !== undefined && (
                <button
                  type="button"
                  className="ni-param-reset"
                  title="恢复平台默认"
                  onClick={() => onChange({ [field.key]: undefined } as Partial<WorkflowNode>)}
                >
                  重置
                </button>
              )}
            </div>
            <input
              type="range"
              min={spec.min}
              max={spec.max}
              step={spec.step}
              value={value ?? (spec.min + spec.max) / 2}
              onChange={(event) =>
                onChange({ [field.key]: Number(event.target.value) } as Partial<WorkflowNode>)
              }
            />
            <small>{spec.hint}</small>
          </div>
        );
      })}

      {tokenField && (
        <div className="ni-param">
          <div className="ni-param-head">
            <span>{tokenField.label}</span>
            <em className={definition.maxTokens === undefined ? "is-default" : undefined}>
              {definition.maxTokens === undefined ? "跟随默认" : `${definition.maxTokens} tokens`}
            </em>
            {definition.maxTokens !== undefined && (
              <button
                type="button"
                className="ni-param-reset"
                onClick={() => onChange({ maxTokens: undefined })}
              >
                重置
              </button>
            )}
          </div>
          <div className="ni-param-tokens">
            <input
              type="number"
              min={1}
              max={32768}
              step={128}
              placeholder="平台默认"
              value={definition.maxTokens ?? ""}
              onChange={(event) =>
                onChange({
                  maxTokens: event.target.value === "" ? undefined : Number(event.target.value)
                })
              }
            />
            {[1024, 2048, 4096].map((size) => (
              <button
                type="button"
                key={size}
                className={definition.maxTokens === size ? "is-active" : undefined}
                onClick={() => onChange({ maxTokens: size })}
              >
                {size}
              </button>
            ))}
          </div>
        </div>
      )}

      {thinkingField && (
        <label className="ni-switch">
          <input
            type="checkbox"
            checked={definition.thinking === true}
            onChange={(event) => onChange({ thinking: event.target.checked })}
          />
          <span>{thinkingField.label}</span>
          <small>{thinkingField.help ?? "打开后产物附带思考摘要"}</small>
        </label>
      )}
    </div>
  );
}

/* ---------------- 输入参数 ---------------- */

/**
 * 参数提取的「参数信息」表：一行一个参数。
 * 这张表就是这个节点拦参数的全部依据——名字负责下游引用，描述负责告诉模型找什么，
 * 必填决定缺了要不要停下来问。所以它比输入变量表更靠前、更显眼。
 */
function ExtractParamsSection({
  node,
  onChange,
  focusParamIndex,
  focusParamNonce
}: {
  node: WorkflowNode;
  onChange: (next: WorkflowNode) => void;
  /** 从错误提示跳过来时聚焦的参数行下标；undefined 表示不聚焦。 */
  focusParamIndex?: number | null;
  /** 同一下标连点两次也要重新滚动，用自增计数强制 effect 触发。 */
  focusParamNonce?: number;
}) {
  const rows = node.params ?? [];
  const setRows = (next: ExtractParam[]) => onChange({ ...node, params: next });
  const update = (index: number, patch: Partial<ExtractParam>) => {
    const copy = [...rows];
    copy[index] = { ...copy[index], ...patch };
    setRows(copy);
  };
  const rowRefs = useRef<Record<number, HTMLDivElement | null>>({});

  // 点击错误提示跳过来时，把对应参数行滚进视野并高亮一下，方便直接改。
  useEffect(() => {
    if (focusParamIndex === undefined || focusParamIndex === null) {
      return;
    }
    const target = rowRefs.current[focusParamIndex];
    if (!target) {
      return;
    }
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.classList.add("is-focused");
    const timer = window.setTimeout(() => target.classList.remove("is-focused"), 2000);
    return () => window.clearTimeout(timer);
  }, [focusParamIndex, focusParamNonce]);

  return (
    <Section
      title="参数信息"
      info="每行一个要提取的参数。名字会变成下游引用字段（${节点ID.名字}）；描述告诉模型从原文里找什么；勾了必填，没抽到就先暂停追问，抽到了才继续往下走。"
      actions={
        <AddButton
          title="添加参数"
          onClick={() =>
            setRows([
              ...rows,
              { name: `param${rows.length + 1}`, label: "", description: "", type: "string", required: true }
            ])
          }
        />
      }
    >
      <div className="ni-extract-thead">
        <span>参数名称 *</span>
        <span>参数描述</span>
        <span>必填</span>
        <span />
      </div>
      {rows.length === 0 && (
        <p className="ni-empty">还没有参数。至少加一条，这个节点才会真的拦参数，否则会直接放行。</p>
      )}
      {rows.map((row, index) => (
        <div
          className="ni-extract-row"
          key={`extract-${index}`}
          ref={(element) => {
            rowRefs.current[index] = element;
          }}
        >
          <input
            value={row.name}
            placeholder="title"
            spellCheck={false}
            title="下游引用用的字段名：${节点ID.名字}"
            onChange={(event) => update(index, { name: event.target.value })}
          />
          <input
            value={row.description ?? ""}
            placeholder="如：用户要练的那篇论文的完整标题"
            title={row.description || "描述会作为抽取说明交给模型"}
            onChange={(event) => update(index, { description: event.target.value })}
          />
          <label className="ni-check" title="必填：抽不到就暂停追问">
            <input
              type="checkbox"
              checked={row.required !== false}
              onChange={(event) => update(index, { required: event.target.checked })}
            />
          </label>
          <button
            type="button"
            className="ni-icon-mini is-remove"
            title="删除该参数"
            onClick={() => setRows(rows.filter((_, position) => position !== index))}
          >
            <Minus size={13} />
          </button>
        </div>
      ))}
      {rows.length > 0 && (
        <p className="ni-extract-hint">
          缺参数时会先弹一张补充卡片；追问话术在下面「追问话术」里改，不写就按参数描述自动生成。
        </p>
      )}
    </Section>
  );
}

function InputSection({
  node,
  spec,
  refGroups,
  workflowInputs,
  onChange
}: {
  node: WorkflowNode;
  spec?: NodeTypeSpec;
  refGroups: RefGroup[];
  /** 开始节点：工作流级输入在这里只读展示，用户问题从这里进、用 ${input.xxx} 往下传。 */
  workflowInputs?: WorkflowVariable[];
  onChange: (next: WorkflowNode) => void;
}) {
  const rows = currentInputBindings(node);
  const [refIndex, setRefIndex] = useState<number | null>(null);
  const [detailIndex, setDetailIndex] = useState<number | null>(null);
  const [presetOpen, setPresetOpen] = useState(false);
  /** 引用面板挂在这一行的「数据来源」格子上，向下弹出，不会把行撑高。 */
  const cellRefs = useRef<Record<number, HTMLDivElement | null>>({});
  /** 预设端口：这类节点推荐的入参，节点里还没用到的那几个。 */
  const presetPorts = (spec?.ports.inputs ?? []).filter(
    (port) => !(node.kind === "template" && port.name === "template") && !rows.some((row) => row.name === port.name)
  );

  const setRows = (next: NodeInputBinding[]) => {
    const prevNames = new Set((node.inputBindings ?? currentInputBindings(node)).map((item) => item.name));
    const nextNames = new Set(next.map((item) => item.name));
    // template 节点的正文由 node.template 承载，执行器按作用域插值；
    // 把「模板变量」端口里看到的正文写回 inputs，只会让面板把引用显示成写死的输入值。
    const isTemplatePort = (name: string) => node.kind === "template" && name === "template";
    const kept = Object.fromEntries(
      Object.entries(node.inputs ?? {})
        .filter(([key]) => !prevNames.has(key) || nextNames.has(key))
        .filter(([key]) => !isTemplatePort(key))
    );
    const derived = Object.fromEntries(
      next
        .filter((item) => item.value !== undefined && item.value !== "" && item.value !== null)
        .filter((item) => !isTemplatePort(item.name))
        .map((item) => [item.name, item.value])
    );
    onChange({ ...node, inputBindings: next, inputs: { ...kept, ...derived } });
  };

  const update = (index: number, patch: Partial<NodeInputBinding>) => {
    const copy = [...rows];
    copy[index] = { ...copy[index], ...patch };
    setRows(copy);
  };

  const addRow = () => {
    setRows([
      ...rows,
      { name: `param${rows.length + 1}`, type: "string", source: "literal", value: undefined }
    ]);
    setRefIndex(null);
  };

  /** 把某个预设端口变成一行真实入参；值留空等用户填。 */
  const addPresetPort = (port: NodePortSpec) => {
    setRows([
      ...rows,
      {
        name: port.name,
        type: port.type,
        required: port.required,
        description: port.description,
        defaultValue: port.defaultValue as string | number | boolean | undefined,
        source: "literal",
        value: undefined
      }
    ]);
    setRefIndex(null);
  };

  const fillDefaults = () => {
    if (presetPorts.length === 0) {
      return;
    }
    setRows([
      ...rows,
      ...presetPorts.map((port) => ({
        name: port.name,
        type: port.type,
        required: port.required,
        description: port.description,
        defaultValue: port.defaultValue as string | number | boolean | undefined,
        source: "literal" as const,
        value: undefined
      }))
    ]);
  };

  return (
    <Section
      title="输入变量"
      info={
        node.kind === "start"
          ? "这里是本次运行的用户问题入口。工作流声明的输入会原样进入画布，下游节点用 ${input.变量名} 引用即可，开始节点不需要输出变量。"
          : "每行一个入参。数据来源可以选固定值或引用工作流输入 / 上游节点输出；保存时会同步写入节点 inputs，运行时真的会解析。预设参数只是这类节点的推荐入参，不用全部填。"
      }
      actions={
        node.kind === "start" ? undefined : (
          <>
            {presetPorts.length ? (
              <button
                type="button"
                className="ni-text-btn"
                onClick={fillDefaults}
                title="把这类节点推荐的入参一次性插进来"
              >
                预设
              </button>
            ) : null}
            <AddButton onClick={addRow} title="添加输入参数" />
          </>
        )
      }
    >
      {node.kind === "start" && (
        <div className="ni-start-inputs">
          <div className="ni-start-inputs-head">
            <span>工作流输入</span>
            <span>类型</span>
            <span>下游引用</span>
          </div>
          {(workflowInputs ?? []).length === 0 ? (
            <p className="ni-empty">工作流还没有声明输入。到画布顶部的「输入变量」里添加，用户的问题就会从这里进入。</p>
          ) : (
            workflowInputs!.map((variable) => (
              <div className="ni-start-input-row" key={variable.name}>
                <code>{variable.name}</code>
                <span>{variable.type}</span>
                <code className="ni-start-ref">{`${"$"}{input.${variable.name}}`}</code>
              </div>
            ))
          )}
          <p className="ni-start-hint">运行时用户输入会写入这些变量，下游节点通过上表的引用取值，开始节点本身不产生输出变量。</p>
        </div>
      )}

      {node.kind !== "start" && (
        <div className="ni-var-thead">
          <span>变量名称 *</span>
          <span>数据来源 *</span>
          <span>类型</span>
          <span />
          <span />
        </div>
      )}

      {rows.length === 0 && node.kind !== "start" && (
        <p className="ni-empty">
          {presetPorts.length > 0
            ? "没有额外入参。这类节点的主要参数在「节点参数」里填，需要额外变量时点右上角 + 或从下面插入预设。"
            : "暂无输入参数，点右上角 + 添加。"}
        </p>
      )}

      {rows.map((row, index) => {
        const isRef =
          row.source === "reference" ||
          (typeof row.value === "string" && row.value.includes("${"));
        return (
          <div className="ni-var-block" key={`in-${index}`}>
            <div className="ni-var-row">
              <span className="ni-var-name">
                <input
                  value={row.name}
                  placeholder="变量名"
                  spellCheck={false}
                  onChange={(event) => update(index, { name: event.target.value })}
                />
                {row.required && <b className="ni-required">*</b>}
              </span>

              <div
                className={`ni-var-source-cell${isRef ? " is-ref" : ""}`}
                ref={(element) => {
                  cellRefs.current[index] = element;
                }}
              >
                <select
                  className="ni-var-source-select"
                  title="数据来源：固定输入，或引用上游节点的输出变量"
                  value={isRef ? "reference" : "literal"}
                  onChange={(event) => {
                    if (event.target.value === "reference") {
                      update(index, { source: "reference" });
                      setRefIndex(index);
                      setDetailIndex(null);
                      return;
                    }
                    update(index, { source: "literal", value: undefined });
                    setRefIndex(null);
                  }}
                >
                  <option value="literal">输入</option>
                  <option value="reference">引用</option>
                </select>
                {isRef ? (
                  <button
                    type="button"
                    className={`ni-var-token${refIndex === index ? " is-active" : ""}`}
                    title={toEditable(row.value) || "点击选择变量"}
                    aria-haspopup="dialog"
                    aria-expanded={refIndex === index}
                    onClick={() => {
                      setRefIndex((current) => (current === index ? null : index));
                      setDetailIndex(null);
                    }}
                  >
                    {row.value ? <code>{refLabel(toEditable(row.value))}</code> : <em>选择变量</em>}
                    <ChevronDown size={11} />
                  </button>
                ) : (
                  <input
                    className="ni-var-value"
                    value={toEditable(row.value)}
                    placeholder="固定值"
                    spellCheck={false}
                    onChange={(event) => update(index, { value: fromEditable(event.target.value) })}
                  />
                )}
              </div>

              <select
                className="ni-var-type"
                value={row.type}
                title={`变量类型：${row.type}`}
                onChange={(event) => update(index, { type: event.target.value as NodePortType })}
              >
                {PORT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {TYPE_LABEL[type]}
                  </option>
                ))}
              </select>

              <button
                type="button"
                className={`ni-icon-mini${detailIndex === index ? " is-active" : ""}`}
                title="参数详情"
                onClick={() => setDetailIndex((current) => (current === index ? null : index))}
              >
                <Settings2 size={12} />
              </button>
              <button
                type="button"
                className="ni-icon-mini is-remove"
                title="删除该参数"
                onClick={() => {
                  setRows(rows.filter((_, position) => position !== index));
                  setRefIndex(null);
                  setDetailIndex(null);
                }}
              >
                <Minus size={13} />
              </button>
            </div>

            {detailIndex === index && (
              <div className="ni-var-detail">
                <label>
                  <span>参数说明</span>
                  <input
                    value={row.description ?? ""}
                    placeholder="告诉下游这个参数是什么"
                    onChange={(event) => update(index, { description: event.target.value })}
                  />
                </label>
                <label>
                  <span>默认值</span>
                  <input
                    value={toEditable(row.defaultValue)}
                    placeholder="留空则不设默认值"
                    onChange={(event) =>
                      update(index, {
                        defaultValue: fromEditable(event.target.value) as
                          | string
                          | number
                          | boolean
                          | undefined
                      })
                    }
                  />
                </label>
                <label className="ni-check">
                  <input
                    type="checkbox"
                    checked={row.required === true}
                    onChange={(event) => update(index, { required: event.target.checked })}
                  />
                  必填
                </label>
              </div>
            )}
          </div>
        );
      })}

      {refIndex !== null && rows[refIndex] && (
        <VarPicker
          anchor={cellRefs.current[refIndex] ?? null}
          groups={refGroups}
          current={toEditable(rows[refIndex].value)}
          onClose={() => setRefIndex(null)}
          onPick={(token) => {
            update(refIndex, { value: token, source: "reference" });
            setRefIndex(null);
          }}
          onClear={() => {
            update(refIndex, { value: undefined, source: "literal" });
            setRefIndex(null);
          }}
        />
      )}

      {node.kind !== "start" && presetPorts.length > 0 && (
        <div className={`ni-preset${presetOpen ? " is-open" : ""}`}>
          <button
            type="button"
            className="ni-preset-head"
            aria-expanded={presetOpen}
            onClick={() => setPresetOpen((current) => !current)}
          >
            <ChevronDown size={12} />
            <span>预设参数</span>
            <em>{presetPorts.length}</em>
            <small>这类节点推荐的入参，用不到可以不管</small>
          </button>
          {presetOpen && (
            <ul className="ni-preset-list">
              {presetPorts.map((port) => (
                <li key={port.name}>
                  <code>{port.name}</code>
                  <span className="ni-preset-label">{port.label}</span>
                  <span className="ni-preset-type">{TYPE_LABEL[port.type]}</span>
                  <button
                    type="button"
                    className="ni-preset-add"
                    title={`把 ${port.name} 加成一行输入变量`}
                    onClick={() => addPresetPort(port)}
                  >
                    <Plus size={11} />
                    插入
                  </button>
                  {port.description ? <p>{port.description}</p> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Section>
  );
}

/* ---------------- 变量选择器：节点 → 字段 → 叶子（向下弹出的浮层） ---------------- */

type PickerLevel = { label: string; fields: RefField[] };

/** 引用来源分段：节点输出变量 / 工作流级变量；哪一段没内容就不渲染。 */
type RefSection = { key: string; label: string; groups: RefGroup[] };

const WORKFLOW_GROUP_KEY = "__input__";
/** 本节点自己的输入变量（引用上游的那些入参），正文里最常用，单独排一段。 */
const SELF_GROUP_KEY = "__self__";

function refSections(groups: RefGroup[]): RefSection[] {
  const selfGroups = groups.filter((group) => group.key === SELF_GROUP_KEY);
  const nodeGroups = groups.filter(
    (group) => group.key !== WORKFLOW_GROUP_KEY && group.key !== SELF_GROUP_KEY
  );
  const flowGroups = groups.filter((group) => group.key === WORKFLOW_GROUP_KEY);
  const sections: RefSection[] = [];
  if (selfGroups.length > 0) {
    sections.push({ key: "self", label: "本节点输入变量", groups: selfGroups });
  }
  if (nodeGroups.length > 0) {
    sections.push({ key: "node", label: "节点输出变量", groups: nodeGroups });
  }
  if (flowGroups.length > 0) {
    sections.push({ key: "flow", label: "工作流级变量", groups: flowGroups });
  }
  return sections;
}

/**
 * 浮层定位：默认贴着触发框下沿弹出；给点坐标（正文里的光标）就以那个点为锚，
 * 面板落在光标下一行，看起来像「在框里就地展开」，而不是掉到编辑器下面。
 */
function useFloatPosition(
  anchor: HTMLElement | null,
  point?: { top: number; left: number } | null
) {
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(null);

  useEffect(() => {
    if (!anchor) {
      setPosition(null);
      return;
    }
    const place = () => {
      const width = Math.min(318, window.innerWidth - 24);
      if (point) {
        setPosition({
          top: Math.max(8, Math.min(point.top, window.innerHeight - 220)),
          left: Math.max(8, Math.min(point.left, window.innerWidth - width - 8)),
          width
        });
        return;
      }
      const rect = anchor.getBoundingClientRect();
      const top = Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 240));
      const left = Math.max(8, Math.min(rect.left - 4, window.innerWidth - width - 8));
      setPosition({ top, left, width });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, point?.top, point?.left]);

  return position;
}

/**
 * 字段绑定用的级联选择：先选来源节点，再逐级点字段，钻到叶子才写入引用。
 * （正文里插入变量走的是 VarQuickPicker——那颗只有变量名的小卡片。）
 * 面板挂在 body 上，只在触发框下面浮一层，不参与节点面板的排版。
 */
function VarPicker({
  anchor,
  point,
  groups,
  current,
  onPick,
  onClear,
  onClose,
  ignore
}: {
  anchor: HTMLElement | null;
  point?: { top: number; left: number } | null;
  groups: RefGroup[];
  /** 当前已写入的表达式，用来标出已选项。 */
  current?: string;
  onPick: (token: string) => void;
  onClear?: () => void;
  onClose: () => void;
  /** 触发按钮本身：按下它不算「点到别处」，否则会被关掉又立刻重开。 */
  ignore?: HTMLElement | null;
}) {
  const [stack, setStack] = useState<PickerLevel[]>([]);
  const [query, setQuery] = useState("");
  const boxRef = useRef<HTMLDivElement | null>(null);
  const position = useFloatPosition(anchor, point);
  const sections = useMemo(() => refSections(groups), [groups]);
  const level = stack[stack.length - 1];
  const keyword = query.trim().toLowerCase();

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      // 点面板内部不关；点触发按钮交给它自己的 toggle 处理；其余一律收起。
      if (boxRef.current?.contains(target) || ignore?.contains(target)) {
        return;
      }
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [ignore, onClose]);

  const hits = useMemo(() => {
    if (!keyword) {
      return [];
    }
    const found: Array<{ group: RefGroup; field: RefField; trail: string }> = [];
    const walk = (group: RefGroup, fields: RefField[], trail: string[]) => {
      for (const field of fields) {
        const path = [...trail, field.name];
        if (
          !field.children?.length &&
          `${group.label} ${group.kindLabel} ${path.join(".")}`.toLowerCase().includes(keyword)
        ) {
          found.push({ group, field, trail: path.join(".") });
        }
        if (field.children?.length) {
          walk(group, field.children, path);
        }
      }
    };
    groups.forEach((group) => walk(group, group.fields, []));
    return found.slice(0, 60);
  }, [groups, keyword]);

  const levelFields = useMemo(() => {
    if (!level) {
      return [];
    }
    return keyword ? level.fields.filter((field) => field.name.toLowerCase().includes(keyword)) : level.fields;
  }, [level, keyword]);

  const enter = (field: RefField) => {
    if (field.children?.length) {
      setStack((prev) => [...prev, { label: field.name, fields: field.children! }]);
      setQuery("");
      return;
    }
    onPick(field.token);
  };

  if (!position) {
    return null;
  }

  const backLabel = stack.length > 1 ? stack[stack.length - 2].label : "选择变量";

  return createPortal(
    <div
      ref={boxRef}
      className="ni-ref-float"
      role="dialog"
      aria-label="选择变量"
      style={{ top: position.top, left: position.left, width: position.width }}
    >
      <div className="ni-ref-float-head">
        {level ? (
          <button
            type="button"
            className="ni-ref-back"
            title={`返回${backLabel}`}
            onClick={() => {
              setStack(stack.slice(0, -1));
              setQuery("");
            }}
          >
            <ChevronLeft size={12} />
            <span>{backLabel}</span>
          </button>
        ) : (
          <span className="ni-ref-float-title">选择变量</span>
        )}
        {level ? <span className="ni-ref-float-crumb">{level.label}</span> : null}
        <span className="ni-ref-spacer" />
        {onClear ? (
          <button type="button" className="ni-ref-act" onClick={onClear}>
            改为固定值
          </button>
        ) : null}
        <button type="button" className="ni-ref-close" title="关闭" onClick={onClose}>
          <X size={12} />
        </button>
      </div>

      <div className="ni-ref-float-search">
        <Search size={12} className="ni-ref-float-search-icon" />
        <input
          autoFocus
          value={query}
          placeholder={level ? `在 ${level.label} 里搜索字段` : "搜索变量名"}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query ? (
          <button type="button" onClick={() => setQuery("")} title="清空搜索">
            <X size={11} />
          </button>
        ) : null}
      </div>

      <div className="ni-ref-float-list">
        {keyword && !level ? (
          <>
            {hits.length === 0 && <p className="ni-ref-empty">没有匹配的变量</p>}
            {hits.map((hit) => (
              <button
                type="button"
                className={`ni-ref-row${current === hit.field.token ? " is-current" : ""}`}
                key={`${hit.group.key}-${hit.field.path}`}
                onClick={() => onPick(hit.field.token)}
              >
                <span className="ni-ref-row-main">
                  <b>{hit.trail}</b>
                  <em>{hit.group.label}</em>
                </span>
                <span className="ni-ref-row-type">{TYPE_SHORT[hit.field.type]}</span>
              </button>
            ))}
          </>
        ) : null}

        {!keyword && !level ? (
          <>
            {sections.length === 0 && (
              <p className="ni-ref-empty">还没有可引用的变量，先把它连到开始节点之后</p>
            )}
            {sections.map((section) => (
              <div className="ni-ref-section" key={section.key}>
                <div className="ni-ref-section-label">{section.label}</div>
                {section.groups.map((group) => {
                  const empty = group.fields.length === 0;
                  return (
                    <button
                      type="button"
                      className="ni-ref-node"
                      key={group.key}
                      disabled={empty}
                      onClick={() => {
                        setStack([{ label: group.label, fields: group.fields }]);
                        setQuery("");
                      }}
                    >
                      <span
                        className="ni-ref-node-icon"
                        style={group.kind ? nodeTintStyle(group.kind) : undefined}
                        aria-hidden="true"
                      >
                        {group.kind ? (
                          (() => {
                            const KindIcon = NODE_VISUALS[group.kind!].icon;
                            return <KindIcon size={10} strokeWidth={2.2} />;
                          })()
                        ) : (
                          <Braces size={10} strokeWidth={2.2} />
                        )}
                      </span>
                      <span className="ni-ref-node-label">{group.label}</span>
                      {empty ? (
                        <em className="ni-ref-node-empty">无输出</em>
                      ) : (
                        <ChevronRight size={12} className="ni-ref-go" />
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </>
        ) : null}

        {level ? (
          <>
            {levelFields.length === 0 && <p className="ni-ref-empty">该层级没有可引用字段</p>}
            {levelFields.map((field) => {
              const branch = Boolean(field.children?.length);
              return (
                <button
                  type="button"
                  className={`ni-ref-row${current === field.token ? " is-current" : ""}`}
                  key={field.path}
                  onClick={() => enter(field)}
                >
                  <span className="ni-ref-row-main">
                    <b>{field.name}</b>
                    <em>{field.desc || field.path}</em>
                  </span>
                  <span className="ni-ref-row-type">{TYPE_SHORT[field.type]}</span>
                  {branch ? <ChevronRight size={12} className="ni-ref-go" /> : null}
                </button>
              );
            })}
          </>
        ) : null}
      </div>

      <div className="ni-ref-float-foot">
        {level ? "带箭头的字段是对象 / 数组，点进去继续选。" : "先点节点，再点字段，到最末一级即引用。"}
      </div>
    </div>,
    document.body
  );
}


/* ---------------- 提示词 ---------------- */

type RefPart = {
  token: boolean;
  /** 画出来的文字（引用会换成节点标题）。 */
  value: string;
  /** 原文里的 ${...}，点开变量列表时用它标出当前项。 */
  raw: string;
  /** 引用在正文里的字符区间，换变量时按它做替换。 */
  start: number;
  end: number;
};

/**
 * 把正文按 ${...} 切开：引用片段单独包一层，好在高亮层里上紫色。
 * 切的是编辑框里那份显示文本，所以切出来的下标和光标位置天然一致。
 */
function splitRefs(text: string): RefPart[] {
  const parts: RefPart[] = [];
  const pattern = /\$\{[^}]*\}/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) {
      parts.push({ token: false, value: text.slice(last, index), raw: "", start: last, end: index });
    }
    parts.push({
      token: true,
      value: match[0],
      raw: match[0],
      start: index,
      end: index + match[0].length
    });
    last = index + match[0].length;
  }
  if (last < text.length) {
    parts.push({ token: false, value: text.slice(last), raw: "", start: last, end: text.length });
  }
  return parts;
}

/**
 * 算出光标在屏幕上的落点。
 * textarea 不提供光标坐标，只能拿一个同字体、同宽度、同换行规则的隐藏盒子
 * 把「光标前的正文」摆一遍，再量末尾那个零宽块的位置。
 * 有了它，变量面板才能像正文里的斜杠菜单一样贴在字下面，而不是掉到编辑器外边。
 */
function caretSpot(area: HTMLTextAreaElement, index: number): { top: number; left: number } {
  const style = window.getComputedStyle(area);
  const rect = area.getBoundingClientRect();
  const padLeft = parseFloat(style.paddingLeft) || 0;
  const padRight = parseFloat(style.paddingRight) || 0;
  const padTop = parseFloat(style.paddingTop) || 0;
  const borderLeft = parseFloat(style.borderLeftWidth) || 0;
  const borderTop = parseFloat(style.borderTopWidth) || 0;
  const borderRight = parseFloat(style.borderRightWidth) || 0;
  // clientWidth 不含边框但含内边距，滚动条另外扣掉，剩下的才是真正的排版宽度。
  const scrollbar = Math.max(0, area.offsetWidth - area.clientWidth - borderLeft - borderRight);
  const width = Math.max(40, area.clientWidth - padLeft - padRight - scrollbar);
  const lineHeight =
    parseFloat(style.lineHeight) || (parseFloat(style.fontSize) || 12) * 1.7;

  const probe = document.createElement("div");
  const probeStyle = probe.style;
  probeStyle.position = "fixed";
  probeStyle.top = "0";
  probeStyle.left = "-10000px";
  probeStyle.boxSizing = "content-box";
  probeStyle.width = `${width}px`;
  probeStyle.margin = "0";
  probeStyle.padding = "0";
  probeStyle.border = "0";
  probeStyle.fontFamily = style.fontFamily;
  probeStyle.fontSize = style.fontSize;
  probeStyle.fontWeight = style.fontWeight;
  probeStyle.letterSpacing = style.letterSpacing;
  probeStyle.lineHeight = style.lineHeight;
  probeStyle.whiteSpace = "pre-wrap";
  probeStyle.overflowWrap = "break-word";
  probe.textContent = area.value.slice(0, Math.max(0, index));

  const marker = document.createElement("span");
  marker.style.display = "inline-block";
  marker.style.width = "0";
  marker.style.height = `${lineHeight}px`;
  marker.textContent = "\u200b";
  probe.appendChild(marker);
  document.body.appendChild(probe);

  const probeRect = probe.getBoundingClientRect();
  const markerRect = marker.getBoundingClientRect();
  const dx = markerRect.left - probeRect.left;
  const dy = markerRect.top - probeRect.top;
  document.body.removeChild(probe);

  return {
    top: rect.top + borderTop + padTop + dy - area.scrollTop + lineHeight + 4,
    left: rect.left + borderLeft + padLeft + dx - area.scrollLeft
  };
}

/**
 * 正文里的变量小卡片：只有标题和变量名。
 * 只列**本节点自己定义的输入变量**——上游节点、工作流级的变量一律不进这张卡，
 * 想引上游输出请到「输入变量」表里给参数绑来源，正文只认这边的名字。
 * 键盘 ↑↓ 选、回车插入、Esc 收起；继续打字则自动收起，字照常进正文。
 */
function VarQuickPicker({
  anchor,
  point,
  inputs,
  current,
  onPick,
  onClose,
  ignore
}: {
  anchor: HTMLElement | null;
  point?: { top: number; left: number } | null;
  inputs: RefField[];
  /** 当前已写入的表达式，用来标出正在用的那个。 */
  current?: string;
  onPick: (token: string) => void;
  onClose: () => void;
  /** 触发按钮本身：按下它不算「点到别处」。 */
  ignore?: HTMLElement | null;
}) {
  // 点已有变量打开时，光标直接停在它那一行，按回车就是「保持原样」
  const [active, setActive] = useState(() => {
    const index = inputs.findIndex((field) => field.token === current);
    return index >= 0 ? index : 0;
  });
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // 键盘走到看不见的行时把它滚进来
  useEffect(() => {
    boxRef.current?.querySelector<HTMLElement>(`[data-row="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // 宽度按内容自适应，所以要先把卡片画出来量一次再定位（量之前藏起来）。
  useLayoutEffect(() => {
    const element = boxRef.current;
    if (!element) {
      return;
    }
    const place = () => {
      const rect = element.getBoundingClientRect();
      const base = point
        ? point
        : anchor
          ? { top: anchor.getBoundingClientRect().bottom + 6, left: anchor.getBoundingClientRect().left - 4 }
          : { top: 40, left: 40 };
      // 下方放不下就翻到光标上面，别顶出视口
      const top =
        base.top + rect.height > window.innerHeight - 8
          ? Math.max(8, base.top - rect.height - 20)
          : Math.max(8, base.top);
      const left = Math.max(8, Math.min(base.left, window.innerWidth - rect.width - 8));
      setPos({ top, left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, point?.top, point?.left, inputs.length]);

  // 点别处收起；点正文里的变量交给它自己重新开。
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (boxRef.current?.contains(target) || ignore?.contains(target)) {
        return;
      }
      if ((event.target as HTMLElement | null)?.closest?.(".ni-prompt-hit")) {
        return;
      }
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [ignore, onClose]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((index) => {
          if (inputs.length === 0) {
            return 0;
          }
          const next = index + step;
          return next < 0 ? inputs.length - 1 : next >= inputs.length ? 0 : next;
        });
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const field = inputs[Math.min(active, inputs.length - 1)];
        if (field) {
          onPick(field.token);
        }
        return;
      }
      // 继续打字就收起卡片，字符照常打进正文
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [inputs, active, onPick, onClose]);

  return createPortal(
    <div
      ref={boxRef}
      className="ni-qv"
      role="listbox"
      aria-label="选择变量"
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? "visible" : "hidden" }}
    >
      <p className="ni-qv-title">输入变量</p>
      {inputs.length === 0 ? <p className="ni-qv-empty">这个节点还没有输入变量</p> : null}
      <div className="ni-qv-list">
        {inputs.map((field, index) => (
          <button
            type="button"
            key={field.path}
            data-row={index}
            className={`ni-qv-row${index === active ? " is-active" : ""}${
              field.token === current ? " is-current" : ""
            }`}
            onMouseEnter={() => setActive(index)}
            onClick={() => onPick(field.token)}
          >
            <span className="ni-qv-name">{field.name}</span>
          </button>
        ))}
      </div>
    </div>,
    document.body
  );
}

/**
 * 选项卡的选项编辑：一行一个选项，编号自动、可增删。
 * 「从变量拉取」时不手填，改成填一个数组引用，运行时逐项变成按钮。
 */
function ChoiceSection({
  node,
  refOptions,
  onChange
}: {
  node: WorkflowNode;
  refOptions?: RefOption[];
  onChange: (next: WorkflowNode) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  // 有 optionsFrom 字段（哪怕是空串）就是动态模式：切过来还没填引用也该停在动态这一侧。
  const dynamic = node.optionsFrom !== undefined;
  const options = node.options ?? [];
  const filled = options.filter((item) => item.trim() !== "").length;

  const patch = (next: string[]) => onChange({ ...node, options: next } as WorkflowNode);

  const insertRef = (token: string) => {
    const current = node.optionsFrom ?? "";
    const element = inputRef.current;
    if (!element) {
      onChange({ ...node, optionsFrom: token } as WorkflowNode);
      return;
    }
    const start = element.selectionStart ?? current.length;
    const end = element.selectionEnd ?? start;
    const next = current.slice(0, start) + token + current.slice(end);
    onChange({ ...node, optionsFrom: next } as WorkflowNode);
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <Section
      title="选项"
      info="用户只能从这些选项里选一个；选完按下面的提示词继续生成回复。"
      actions={
        <span className="ni-choice-count">{dynamic ? "动态" : filled > 0 ? `${filled} 项` : "未设置"}</span>
      }
    >
      <div className="ni-choice-mode">
        <span className="ni-choice-mode-label">设置方式</span>
        <label className={`ni-choice-radio${dynamic ? "" : " is-on"}`}>
          <input
            type="radio"
            checked={!dynamic}
            onChange={() => onChange({ ...node, optionsFrom: undefined } as WorkflowNode)}
          />
          手动设置选项
        </label>
        <label className={`ni-choice-radio${dynamic ? " is-on" : ""}`}>
          <input
            type="radio"
            checked={dynamic}
            onChange={() => onChange({ ...node, optionsFrom: node.optionsFrom ?? "" } as WorkflowNode)}
          />
          从变量拉取
        </label>
      </div>

      {dynamic ? (
        <label className="platform-field">
          <span>选项变量</span>
          <div className="ni-choice-ref">
            <input
              ref={inputRef}
              value={node.optionsFrom ?? ""}
              placeholder="${input.topics}"
              spellCheck={false}
              onChange={(event) =>
                onChange({ ...node, optionsFrom: event.target.value } as WorkflowNode)
              }
            />
            {refOptions && refOptions.length > 0 ? (
              <RefPicker options={refOptions} onPick={insertRef} />
            ) : null}
          </div>
          <small>
            填一个数组引用（字符串数组，或带 label 的对象数组），运行时逐项变成按钮；留空则退回手动选项。
          </small>
        </label>
      ) : (
        <>
          {options.length === 0 ? (
            <p className="ni-choice-empty">还没有选项，用户只能自己打字。点下面的「添加选项」开始。</p>
          ) : (
            <div className="ni-choice-list">
              {options.map((item, index) => (
                <div className="ni-choice-row" key={index}>
                  <span className="ni-choice-index">{String(index + 1).padStart(2, "0")}</span>
                  <input
                    className="ni-choice-input"
                    value={item}
                    placeholder="选项内容，用户会看到这一行"
                    spellCheck={false}
                    onChange={(event) =>
                      patch(options.map((value, at) => (at === index ? event.target.value : value)))
                    }
                  />
                  <button
                    type="button"
                    className="ni-icon-btn"
                    title="删除这一项"
                    onClick={() => patch(options.filter((_, at) => at !== index))}
                  >
                    <Minus size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <button type="button" className="ni-choice-add" onClick={() => patch([...options, ""])}>
            <Plus size={12} /> 添加选项
          </button>
          {options.some((item) => item.trim() !== "") && (
            <p className="ni-choice-empty">
              画布上除了这几项，还会自动多一个「其他」出口：用户点「其他」或者写的内容不在这几项里时走它。
            </p>
          )}
        </>
      )}
    </Section>
  );
}

function PromptSection({
  title,
  info,
  field,
  value,
  refGroups,
  onChange,
  variant = "prompt"
}: {
  title: string;
  info: string;
  field: NodeField;
  value: unknown;
  refGroups: RefGroup[];
  onChange: (value: string) => void;
  /** reply：回复内容编辑器，更高、更醒目；prompt：普通提示词。 */
  variant?: "prompt" | "reply";
}) {
  const reply = variant === "reply";
  /**
   * 变量小卡片打开时记下的区间：
   * 敲 / 和「插入变量」是空区间（插入），点已有变量是它的区间（原位替换）。
   */
  const [picker, setPicker] = useState<{ start: number; end: number; current?: string } | null>(null);
  /**
   * 变量面板的落点：正文里的光标坐标。
   * 有它就贴着光标弹（在编辑框里头），没有才退回「贴着整个编辑框下沿」。
   */
  const [pickerPoint, setPickerPoint] = useState<{ top: number; left: number } | null>(null);
  const [expanded, setExpanded] = useState(false);
  /**
   * 正在用输入法拼字。镜像层负责「上色」，textarea 的字是透明的；
   * 但中文预编辑那串拼音是浏览器直接画在 textarea 里的，透明就看不见了，
   * 所以拼字期间临时把 textarea 的字显回来、镜像层让位。
   */
  const [composing, setComposing] = useState(false);
  const controlRef = useRef<HTMLTextAreaElement | null>(null);
  /** 「插入变量」按钮：面板打开时按住它不算点到别处。 */
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  /** 编辑框整块：面板默认贴着它下沿弹，有光标坐标时以光标为准。 */
  const boxRef = useRef<HTMLDivElement | null>(null);
  /** 打开面板前的光标位置：面板自己会抢焦点，插入时按这个位置写回去。 */
  const caretRef = useRef<{ start: number; end: number } | null>(null);
  /** 正文高亮层：和 textarea 同字号同内边距，滚到哪跟到哪。 */
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  /** 命中层：只为了接住变量上的鼠标事件，跟高亮层同步滚动。 */
  const hitsRef = useRef<HTMLDivElement | null>(null);
  const raw = typeof value === "string" ? value : "";
  /**
   * 编辑框里放的是「显示形态」：${节点名.字段}。
   * 落库前再换回 ${节点id.字段}——运行时只认 id。
   *
   * 早先是「textarea 存 id、镜像层画标题」——两串字宽不一样，
   * 可 textarea 的光标、点击落点、选区全按它自己那串字符算：
   * 点到看得见的结尾，实际却落在 id 中间；再敲 `/` 就把哈希劈成两半，
   * 于是正文里冒出 `${fd3ab424c74e516/2d1e…}` 这种谁也读不懂的东西。
   * 现在两边字符完全一致，光标才对得上。
   */
  const refAlias = useMemo(
    () =>
      buildRefAlias(
        refGroups.filter(
          (group) => group.key !== WORKFLOW_GROUP_KEY && group.key !== SELF_GROUP_KEY
        )
      ),
    [refGroups]
  );

  const displayFromRaw = useCallback(
    (text: string) => displayWithAlias(text, refAlias),
    [refAlias]
  );

  const rawFromDisplay = (text: string) => rawWithAlias(text, refAlias);

  /**
   * 编辑框里的文本（显示形态）。光标、选区、点击、插入位置全部按它算，
   * 这样和 textarea 里真正排版的字符一一对应。
   */
  const [draft, setDraft] = useState(() => displayFromRaw(raw));
  /** 自己刚写回去的原串：值绕一圈回来时别再把光标拽走。 */
  const echoed = useRef<string | null>(null);

  useEffect(() => {
    if (raw === echoed.current) {
      return;
    }
    setDraft(displayFromRaw(raw));
  }, [raw, displayFromRaw]);

  const commit = (next: string) => {
    const nextRaw = rawFromDisplay(next);
    echoed.current = nextRaw;
    setDraft(next);
    // 正文一改，卡片里记下的变量区间就作废了，先收起来
    setPicker(null);
    onChange(nextRaw);
  };

  const text = draft;

  /** 正文切段（普通文字 / 变量引用），高亮层和命中层各画一遍。 */
  const parts = useMemo(() => splitRefs(text), [text]);

  const rememberCaret = () => {
    const element = controlRef.current;
    if (element) {
      caretRef.current = { start: element.selectionStart, end: element.selectionEnd };
    }
  };

  /**
   * 卡片里只放本节点「输入变量」表里定义的那些名字（SELF 组）。
   * 工作流输入、上游节点输出都不进来：正文只认本节点的入参名字，
   * 要引上游的东西，去输入变量表里把它绑成这个节点的一个入参。
   */
  const inputVars = useMemo(
    () => refGroups.filter((group) => group.key === SELF_GROUP_KEY).flatMap((group) => group.fields),
    [refGroups]
  );

  /** 打开变量小卡片，锚点定在光标处（在正文里就地展开）。 */
  const openPickerAt = (index: number) => {
    const element = controlRef.current;
    setPickerPoint(element ? caretSpot(element, index) : null);
    setPicker({ start: index, end: index });
  };

  const closePicker = () => {
    // 焦点还留在卡片里（比如按 Esc 关掉），就把光标还给正文，接着能打字。
    const active = document.activeElement;
    const insidePanel = active instanceof HTMLElement && Boolean(active.closest(".ni-qv"));
    setPicker(null);
    setPickerPoint(null);
    const element = controlRef.current;
    if (insidePanel && element) {
      const caret = caretRef.current;
      element.focus();
      if (caret) {
        element.setSelectionRange(caret.start, caret.end);
      }
    }
  };

  /** 选中变量写入正文：空区间是插入，点已有变量换来的区间是原位替换。 */
  const applyPick = (token: string) => {
    if (!picker) {
      return;
    }
    const start = Math.min(picker.start, text.length);
    const end = Math.min(Math.max(picker.end, start), text.length);
    // 卡片给的是原串（${节点id.字段}），写进编辑框前换成显示名
    const shown = displayFromRaw(token);
    commit(text.slice(0, start) + shown + text.slice(end));
    const next = start + shown.length;
    caretRef.current = { start: next, end: next };
    closePicker();
    requestAnimationFrame(() => {
      const element = controlRef.current;
      element?.focus();
      element?.setSelectionRange(next, next);
    });
  };

  return (
    <Section
      title={title}
      info={info}
      actions={
        <>
          <button
            type="button"
            ref={triggerRef}
            className={`ni-text-btn${picker ? " is-active" : ""}`}
            onClick={() => {
              rememberCaret();
              if (picker) {
                closePicker();
                return;
              }
              const element = controlRef.current;
              openPickerAt(element ? element.selectionStart : text.length);
            }}
            title="在光标处插入变量（也可以在正文里直接输入 /）"
          >
            <AtSign size={12} /> 插入变量
          </button>
          <button
            type="button"
            className="ni-icon-btn"
            title={expanded ? "收起编辑器" : "放大编辑器"}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
          <button type="button" className="ni-icon-btn" title="清空" onClick={() => commit("")}>
            <X size={13} />
          </button>
        </>
      }
    >
      <div
        className={`ni-prompt-box${reply ? " is-reply" : ""}${composing ? " is-composing" : ""}`}
        ref={boxRef}
      >
        {picker && (
          <VarQuickPicker
            anchor={boxRef.current}
            point={pickerPoint}
            inputs={inputVars}
            current={picker.current}
            ignore={triggerRef.current}
            onPick={applyPick}
            onClose={closePicker}
          />
        )}
        <div className="ni-prompt-mirror" ref={mirrorRef} aria-hidden="true">
          {parts.map((part, index) =>
            part.token ? (
              <span className="ni-prompt-ref" key={index}>
                {part.value}
              </span>
            ) : (
              <span key={index}>{part.value}</span>
            )
          )}
          {"\u200b"}
        </div>
        {/*
          命中层：镜像层画在 textarea 下面，字是透明的 textarea 盖在上面收走了所有鼠标事件，
          所以变量根本点不到。这里再铺一层同样排版、只有变量接鼠标的透明层，
          点变量就地弹出换变量小列表；点别处穿过去，光标照常落位。
        */}
        <div className="ni-prompt-mirror ni-prompt-hits" ref={hitsRef} aria-hidden="true">
          {parts.map((part, index) =>
            part.token ? (
              <span
                className="ni-prompt-hit"
                key={index}
                data-start={part.start}
                data-end={part.end}
                data-raw={part.raw}
                title="点击更换变量"
                onClick={() => {
                  // 顺手把光标放到变量末尾：不从卡片里选、继续写也不会跑到别处
                  const element = controlRef.current;
                  const end = part.end;
                  if (element) {
                    element.focus();
                    element.setSelectionRange(end, end);
                    caretRef.current = { start: end, end };
                  }
                  setPickerPoint(element ? caretSpot(element, end) : null);
                  setPicker({ start: part.start, end, current: part.raw });
                }}
              >
                {part.value}
              </span>
            ) : (
              <span key={index}>{part.value}</span>
            )
          )}
          {"\u200b"}
        </div>
        <textarea
          ref={controlRef}
          className={`${expanded ? "is-expanded" : ""}${composing ? " is-composing" : ""}`.trim() || undefined}
          rows={expanded ? 14 : reply ? 8 : 5}
          value={draft}
          spellCheck={false}
          placeholder={
            reply
              ? "写要回复给用户的内容。\n输入 / 可以插入本节点的输入变量。"
              : `${field.placeholder || "请输入提示词"}\n\n输入 / 可以插入本节点的输入变量`
          }
          onChange={(event) => commit(event.target.value)}
          onKeyDown={(event) => {
            // 行首、空白或标点后面的 / 才当变量入口，A/B、http:// 不算。
            if (
              event.key !== "/" ||
              event.ctrlKey ||
              event.metaKey ||
              event.altKey ||
              event.nativeEvent.isComposing
            ) {
              return;
            }
            const element = controlRef.current;
            if (!element) {
              return;
            }
            // 只有紧贴字母数字（A/B）、或紧跟 : / . （http://、./x、3/4 这种路径与数字）时才当普通斜杠；
            // 其余——换行、空格、中文标点、引号、变量结尾的 }——都算变量入口。
            const before = element.value.slice(0, element.selectionStart);
            const prev = before.slice(-1);
            const isEntry = prev === "" || (!/[A-Za-z0-9]/.test(prev) && !/[:/.]/.test(prev));
            if (!isEntry) {
              return;
            }
            event.preventDefault();
            caretRef.current = { start: element.selectionStart, end: element.selectionEnd };
            openPickerAt(element.selectionStart);
          }}
          onScroll={(event) => {
            const mirror = mirrorRef.current;
            if (mirror) {
              mirror.scrollTop = event.currentTarget.scrollTop;
              mirror.scrollLeft = event.currentTarget.scrollLeft;
            }
            const hits = hitsRef.current;
            if (hits) {
              hits.scrollTop = event.currentTarget.scrollTop;
              hits.scrollLeft = event.currentTarget.scrollLeft;
            }
          }}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onSelect={rememberCaret}
          onClick={rememberCaret}
          onBlur={rememberCaret}
        />
      </div>
    </Section>
  );
}

/* ---------------- 输出 ---------------- */

/** 输出契约里固定存在的两条分支：业务产物 Output 与运行时错误 Error。 */
const ERROR_FIELDS: NodeOutputProperty[] = [
  { name: "FailCode", type: "string", description: "运行时错误码" },
  { name: "FailMessage", type: "string", description: "运行时错误描述" }
];

/**
 * 按节点类型固定的默认输出变量（对齐元器的输出契约）。
 * 这些是平台预设，只读、不可改名/改类型/删除；用户只能往 Output 分支里新增自定义变量。
 * refPath 是运行时真实写入的字段：预设名 ${节点.Answer} 等由执行器的别名解析兜底，
 * 引用面板里也用预设名作为 token，保证「看到的字段名」和「能引用的字段名」一致。
 */
type PresetOutput = NodeOutputProperty & { refPath: string };

const PRESET_OUTPUTS: Partial<Record<NodeKind, PresetOutput[]>> = {
  template: [
    { name: "Answer", type: "string", description: "回复内容", refPath: "output" }
  ],
  llm: [
    { name: "Thought", type: "string", description: "大模型思考过程", refPath: "thinking" },
    { name: "Content", type: "string", description: "大模型运行输出内容", refPath: "output" }
  ],
  agent: [{ name: "Content", type: "string", description: "Agent 运行输出内容", refPath: "output" }]
};

const GENERIC_PRESET: PresetOutput[] = [
  { name: "Content", type: "string", description: "节点运行输出内容", refPath: "output" }
];

function presetOutputsOf(node: WorkflowNode): PresetOutput[] {
  // 参数提取的输出就是参数表本身：每加一个参数，下游就多一个可引用的字段。
  if (node.kind === "extract") {
    const rows = (node.params ?? [])
      .filter((param) => (param.name ?? "").trim() !== "")
      .map((param) => ({
        name: param.name.trim(),
        type: (param.type ?? "string") as NodePortType,
        description: param.label?.trim() || param.description?.trim() || "提取到的参数",
        refPath: param.name.trim()
      }));
    if (rows.length > 0) {
      return rows;
    }
  }
  return PRESET_OUTPUTS[node.kind] ?? GENERIC_PRESET;
}

function OutputSection({
  node,
  spec,
  hasFormatField,
  lastError,
  onChange
}: {
  node: WorkflowNode;
  spec?: NodeTypeSpec;
  hasFormatField: boolean;
  /** 最近一次运行的报错文本，有值就挂在 Error 分支下展示。 */
  lastError?: string;
  onChange: (next: WorkflowNode) => void;
}) {
  const preset = presetOutputsOf(node);
  // 预设名 + 平台默认端口名都不作为「自定义变量」展示，避免和只读预设重复。
  const reserved = useMemo(
    () =>
      new Set<string>([
        ...preset.map((item) => item.name),
        ...(spec?.ports.outputs ?? []).map((port) => port.name),
        "Output",
        "Error"
      ]),
    [preset, spec]
  );
  /** 只保留用户自己新增的输出变量；预设由平台固定，不写进 outputSchema。 */
  const customRows = useMemo(
    () => (node.outputSchema ?? []).filter((row) => !reserved.has(row.name)),
    [node.outputSchema, reserved]
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [copiedField, setCopiedField] = useState<string>();

  const toggleCollapse = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });

  const setCustomRows = (next: NodeOutputProperty[]) => {
    onChange({ ...node, outputSchema: next });
  };

  /** fieldPath 是相对节点输出的完整路径，如 Answer、Content、Error.FailMessage。 */
  const copyToken = async (fieldPath: string) => {
    const token = `${"$"}{${node.id}.${fieldPath}}`;
    try {
      await navigator.clipboard.writeText(token);
      setCopiedField(fieldPath);
      window.setTimeout(() => setCopiedField(undefined), 1400);
    } catch {
      setCopiedField(undefined);
    }
  };

  return (
    <Section
      title="输出变量"
      info="Output / Error 及分支下的默认变量由平台按节点类型固定，不能修改；想自定义，点 Output 右侧的 + 新增输出变量。点变量名旁的复制图标可复制下游引用。"
      actions={
        hasFormatField ? (
          <select
            className="ni-format"
            value={node.outputFormat ?? "text"}
            title="输出格式"
            onChange={(event) =>
              onChange({ ...node, outputFormat: event.target.value as "text" | "json" } as WorkflowNode)
            }
          >
            <option value="text">文本</option>
            <option value="json">JSON</option>
          </select>
        ) : undefined
      }
    >
      <div className="ni-var-thead is-out">
        <span />
        <span>变量名称</span>
        <span>变量类型</span>
        <span>变量描述</span>
        <span />
        <span />
      </div>
      <div className="ni-tree">
        <OutputBranch
          name="Output"
          desc="输出内容"
          open={!collapsed.has("__output__")}
          onToggle={() => toggleCollapse("__output__")}
          onAdd={() =>
            setCustomRows([...customRows, { name: `field${customRows.length + 1}`, type: "string" }])
          }
        >
          <PresetOutputRows
            nodeId={node.id}
            rows={preset}
            copiedField={copiedField}
            onCopy={(path) => void copyToken(path)}
          />
          {customRows.length > 0 ? (
            <OutputTree
              rows={customRows}
              prefix="custom."
              collapsed={collapsed}
              onToggle={toggleCollapse}
              onChange={setCustomRows}
            />
          ) : (
            <p className="ni-tree-empty">以上为默认输出变量；点 Output 右侧 + 可新增自定义变量</p>
          )}
        </OutputBranch>

        <OutputBranch
          name="Error"
          desc="运行时的报错信息"
          open={!collapsed.has("__error__")}
          onToggle={() => toggleCollapse("__error__")}
        >
          <PresetOutputRows
            nodeId={node.id}
            rows={ERROR_FIELDS.map((field) => ({ ...field, refPath: `Error.${field.name}` }))}
            prefix="Error."
            copiedField={copiedField}
            onCopy={(path) => void copyToken(path)}
          />
          <p className={`ni-tree-err${lastError ? " has-value" : ""}`} title={lastError ?? ""}>
            {lastError ? `上次运行失败：${lastError.split("\n")[0]}` : "未捕获到错误。节点失败且开启异常处理时写入。"}
          </p>
        </OutputBranch>
      </div>
    </Section>
  );
}

/** 只读预设行：字段名 / 类型 / 描述都不可点改，只提供「复制引用」。 */
function PresetOutputRows({
  nodeId,
  rows,
  prefix = "",
  copiedField,
  onCopy
}: {
  nodeId: string;
  rows: PresetOutput[];
  prefix?: string;
  copiedField?: string;
  /** 回传完整引用路径（含 Error. 前缀），外层用它生成 ${节点.路径} 并记录复制状态。 */
  onCopy: (path: string) => void;
}) {
  return (
    <>
      {rows.map((row, index) => {
        // 复制状态按「前缀 + 字段名」的完整引用路径记录，Error.FailCode 和 Output 下的同名行不会互相串台。
        const fieldPath = `${prefix}${row.name}`;
        return (
          <div className="ni-tree-item" key={`preset-${prefix}${index}`}>
            <div className="ni-tree-row">
              <span className="ni-tree-caret is-leaf" aria-hidden="true" />
              <span
                className="ni-tree-name is-static"
                title={`预设变量，不可修改；下游用 ${"$"}{${nodeId}.${fieldPath}} 引用`}
              >
                {row.name}
              </span>
              <span className="ni-tree-type-static">{row.type}</span>
              <span className="ni-tree-desc-static">{row.description}</span>
              <button
                type="button"
                className="ni-tree-copy"
                title={`复制引用 ${"$"}{${nodeId}.${fieldPath}}`}
                onClick={() => onCopy(fieldPath)}
              >
                {copiedField === fieldPath ? <Check size={11} /> : <Copy size={11} />}
              </button>
              <span className="ni-tree-add is-empty" aria-hidden="true" />
            </div>
          </div>
        );
      })}
    </>
  );
}

/** 输出树的一级分支：固定的 Output / Error 根，带展开箭头与引导线。 */
function OutputBranch({
  name,
  desc,
  open,
  onToggle,
  onAdd,
  children
}: {
  name: string;
  desc: string;
  open: boolean;
  onToggle: () => void;
  onAdd?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="ni-tree-item">
      <div className="ni-tree-row is-root">
        <button
          type="button"
          className="ni-tree-caret"
          title={open ? "收起子字段" : "展开子字段"}
          onClick={onToggle}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <span className="ni-tree-name is-static">{name}</span>
        <span className="ni-tree-type-static">object</span>
        <span className="ni-tree-desc-static">{desc}</span>
        {onAdd ? (
          <button type="button" className="ni-tree-add" title="添加子字段" onClick={onAdd}>
            <Plus size={12} />
          </button>
        ) : (
          <span className="ni-tree-add is-empty" aria-hidden="true" />
        )}
        <span className="ni-tree-add is-empty" aria-hidden="true" />
      </div>
      {open && <div className="ni-tree-children">{children}</div>}
    </div>
  );
}

/**
 * 输出字段树：每层用引导线连起来，可展开收起。
 * object / array 可挂子字段，最多四层；叶子仍能改名、换类型、写描述。
 */
function OutputTree({
  rows,
  prefix,
  collapsed,
  onToggle,
  onChange,
  readOnly
}: {
  rows: NodeOutputProperty[];
  prefix: string;
  collapsed?: Set<string>;
  onToggle?: (key: string) => void;
  onChange?: (next: NodeOutputProperty[]) => void;
  /** Error 分支由运行时写入，只读展示。 */
  readOnly?: boolean;
}) {
  const update = (index: number, patch: Partial<NodeOutputProperty>) => {
    if (!onChange) {
      return;
    }
    const copy = [...rows];
    copy[index] = { ...copy[index], ...patch };
    onChange(copy);
  };

  return (
    <>
      {rows.map((row, index) => {
        const key = `${prefix}${index}:${row.name}`;
        const container = row.type === "object" || row.type === "array";
        const children = row.properties ?? [];
        const open = !collapsed?.has(key);
        // 折叠态用含变量名的 key（改名后重置折叠），但 DOM key 必须稳定，否则输入一个字母就失焦。
        const rowKey = `${prefix}${index}`;
        return (
          <div className="ni-tree-item" key={rowKey}>
            <div className="ni-tree-row">
              {container && children.length > 0 && !readOnly ? (
                <button
                  type="button"
                  className="ni-tree-caret"
                  title={open ? "收起子字段" : "展开子字段"}
                  onClick={() => onToggle?.(key)}
                >
                  {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </button>
              ) : (
                <span className="ni-tree-caret is-leaf" aria-hidden="true" />
              )}
              {readOnly ? (
                <span className="ni-tree-name is-static">{row.name}</span>
              ) : (
                <input
                  className="ni-tree-name"
                  value={row.name}
                  placeholder="字段名"
                  spellCheck={false}
                  onChange={(event) => update(index, { name: event.target.value })}
                />
              )}
              {readOnly ? (
                <span className="ni-tree-type-static">{row.type}</span>
              ) : (
                <select
                  className="ni-tree-type"
                  value={row.type}
                  title={`字段类型：${row.type}`}
                  onChange={(event) => update(index, { type: event.target.value as NodePortType })}
                >
                  {PORT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {TYPE_LABEL[type]}
                    </option>
                  ))}
                </select>
              )}
              {readOnly ? (
                <span className="ni-tree-desc-static">{row.description}</span>
              ) : (
                <input
                  className="ni-tree-desc"
                  value={row.description ?? ""}
                  placeholder="变量描述"
                  title={row.description ?? ""}
                  spellCheck={false}
                  onChange={(event) => update(index, { description: event.target.value })}
                />
              )}
              {!readOnly && container ? (
                <button
                  type="button"
                  className="ni-tree-add"
                  title="添加子字段"
                  onClick={() => {
                    update(index, {
                      properties: [
                        ...children,
                        { name: `field${children.length + 1}`, type: "string" }
                      ]
                    });
                    if (!open) {
                      onToggle?.(key);
                    }
                  }}
                >
                  <Plus size={12} />
                </button>
              ) : (
                <span className="ni-tree-add is-empty" aria-hidden="true" />
              )}
              {readOnly ? (
                <span className="ni-tree-add is-empty" aria-hidden="true" />
              ) : (
                <button
                  type="button"
                  className="ni-tree-add is-remove"
                  title="删除该字段"
                  onClick={() => onChange?.(rows.filter((_, position) => position !== index))}
                >
                  <Minus size={12} />
                </button>
              )}
            </div>
            {container && children.length > 0 && open && (
              <div className="ni-tree-children">
                <OutputTree
                  rows={children}
                  prefix={`${key}.`}
                  collapsed={collapsed}
                  onToggle={onToggle}
                  onChange={(next) => update(index, { properties: next })}
                  readOnly={readOnly}
                />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

/* ---------------- 异常处理 ---------------- */

/**
 * 一个开关，不开就是默认行为：失败重试后中断整条流程。
 * 打开后失败不再卡流程，错误写进产物的 Error 分支供下游读取。
 */
function ErrorSection({
  node,
  onChange
}: {
  node: WorkflowNode;
  onChange: (next: WorkflowNode) => void;
}) {
  const enabled = node.errorPolicy?.enabled === true || node.errorPolicy?.strategy === "continue";

  const toggle = () => {
    if (enabled) {
      onChange({ ...node, errorPolicy: undefined });
      return;
    }
    onChange({ ...node, errorPolicy: { ...(node.errorPolicy ?? {}), enabled: true, strategy: undefined } });
  };

  return (
    <Section
      title="异常处理"
      info="打开后该节点失败不再中断流程，错误写入 Error 分支（FailCode / FailMessage），下游可直接引用。"
      actions={
        <button
          type="button"
          className={`ni-toggle${enabled ? " is-on" : ""}`}
          role="switch"
          aria-checked={enabled}
          title={enabled ? "已开启：失败不中断，错误写入 Error 分支" : "已关闭：失败重试后中断流程"}
          onClick={toggle}
        >
          <i />
        </button>
      }
    >
      {enabled ? (
        <p className="ni-err-line">
          失败时跳过该节点继续执行，<code>{"${节点ID.Error.FailMessage}"}</code> 里是原因。
        </p>
      ) : (
        <p className="ni-err-line is-muted">默认关闭：重试仍失败就中断流程，错误只记录在运行记录里。</p>
      )}
    </Section>
  );
}

/* ---------------- 容器子节点 ---------------- */

type BlockEditorProps = {
  block: NodeBlock;
  definition: WorkflowNode;
  specs: NodeTypeSpec[];
  usedIds: Set<string>;
  expandedChild?: string;
  childKind: NodeKind;
  refOptions: RefOption[];
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
  refOptions,
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
    <Section
      title={block.label}
      info={block.required ? "该分支必填，至少需要一个子节点。" : "容器内部的子节点，按顺序执行。"}
      actions={<span className="ni-count">{children.length} 个</span>}
    >
      {children.map((child, index) => {
        const childKey = `${block.key}-${index}`;
        const expanded = expandedChild === childKey;
        const childSpec = specs.find((item) => item.kind === child.kind);
        const isContainer = child.kind === "parallel" || child.kind === "condition" || child.kind === "loop";
        return (
          <div className="ni-child" key={childKey}>
            <div className="ni-child-head">
              <button type="button" className="ni-child-toggle" onClick={() => onExpand(childKey)}>
                {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <span className="ni-child-kind">
                  {childSpec?.label ?? child.kind}
                </span>
                <span className="ni-child-title">{child.title || child.id}</span>
              </button>
              <button
                type="button"
                className="ni-icon-mini"
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
                <Trash2 size={12} />
              </button>
            </div>

            {expanded && (
              <div className="ni-child-body">
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
                  <p className="ni-empty">嵌套容器暂不支持在此编辑结构，请在顶层使用同类型节点。</p>
                ) : (
                  childSpec?.fields.map((field) => (
                    <FieldRow
                      key={`${childKey}-${field.key}`}
                      field={field}
                      value={(child as Record<string, unknown>)[field.key]}
                      refOptions={refOptions}
                      onChange={(value) => updateChild(index, { ...child, [field.key]: value } as WorkflowNode)}
                    />
                  ))
                )}
              </div>
            )}
          </div>
        );
      })}

      <div className="ni-block-add">
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
          <Plus size={12} /> 添加子节点
        </button>
      </div>
    </Section>
  );
}

/* ---------------- 通用字段渲染 ---------------- */

type FieldRowProps = {
  field: NodeField;
  value: unknown;
  refOptions?: RefOption[];
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

function FieldRow({ field, value, refOptions, onChange }: FieldRowProps) {
  const controlRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);

  const insertRef = (token: string) => {
    const element = controlRef.current;
    const current = typeof value === "string" ? value : "";
    if (!element) {
      onChange(current + token);
      return;
    }
    const start = element.selectionStart ?? current.length;
    const end = element.selectionEnd ?? start;
    const next = current.slice(0, start) + token + current.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const refPicker = field.supportsRefs && refOptions && refOptions.length > 0 ? (
    <RefPicker options={refOptions} onPick={insertRef} />
  ) : null;

  if (field.type === "select" && field.options && field.options.length > 0) {
    const current = typeof value === "string" ? value : "";
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
    return <JsonField field={field} value={value} refOptions={refOptions} onChange={onChange} />;
  }

  if (field.type === "list") {
    const listText = Array.isArray(value) ? value.join("\n") : "";
    return (
      <label className="platform-field">
        <span>{field.label}</span>
        <textarea
          ref={(element) => {
            controlRef.current = element;
          }}
          rows={3}
          value={listText}
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
        {refPicker}
        {field.help && <small>{field.help}</small>}
      </label>
    );
  }

  if (field.type === "textarea") {
    return (
      <label className="platform-field">
        <span>{field.label}</span>
        <textarea
          ref={(element) => {
            controlRef.current = element;
          }}
          rows={3}
          value={typeof value === "string" ? value : ""}
          placeholder={field.placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
        {refPicker}
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
        ref={(element) => {
          controlRef.current = element;
        }}
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
      {refPicker}
      {field.help && <small>{field.help}</small>}
    </label>
  );
}

function JsonField({ field, value, refOptions, onChange }: FieldRowProps) {
  const [error, setError] = useState<string>();
  const controlRef = useRef<HTMLTextAreaElement | null>(null);
  const [draft, setDraft] = useState(() => (value === undefined ? "{}" : JSON.stringify(value, null, 2)));

  useEffect(() => {
    setDraft(value === undefined ? "{}" : JSON.stringify(value, null, 2));
  }, [value]);

  const insertRef = (token: string) => {
    const element = controlRef.current;
    const start = element?.selectionStart ?? draft.length;
    const end = element?.selectionEnd ?? start;
    const next = draft.slice(0, start) + token + draft.slice(end);
    setDraft(next);
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <label className="platform-field">
      <span>{field.label}</span>
      <textarea
        ref={controlRef}
        rows={5}
        value={draft}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const raw = draft.trim();
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
      {field.supportsRefs && refOptions && refOptions.length > 0 && (
        <RefPicker options={refOptions} onPick={insertRef} />
      )}
      {error ? <small className="platform-error-text">{error}</small> : field.help && <small>{field.help}</small>}
    </label>
  );
}

function RefPicker({ options, onPick }: { options: RefOption[]; onPick: (token: string) => void }) {
  const groups = useMemo(() => {
    const map = new Map<string, RefOption[]>();
    for (const option of options) {
      if (!map.has(option.group)) {
        map.set(option.group, []);
      }
      map.get(option.group)!.push(option);
    }
    return [...map.entries()];
  }, [options]);

  return (
    <div className="platform-ref-picker">
      <select
        value=""
        onChange={(event) => {
          if (event.target.value) {
            onPick(event.target.value);
          }
        }}
      >
        <option value="">＋ 插入变量</option>
        {groups.map(([group, items]) => (
          <optgroup key={group} label={group}>
            {items.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label} · {option.value}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <InfoTip text="支持 ${节点ID.字段} / ${input.字段名} 引用" />
    </div>
  );
}

/* ---------------- 数据辅助 ---------------- */

/**
 * 面板里的行只放 DSL 里真实存在的入参。
 * 节点类型的预设端口是「推荐参数」，真实值大多写在节点参数字段里（工具走 args、
 * 模板走 template、条件走 when、检索走 query），铺成空行只会让人以为必填项没填；
 * 它们在下面的「预设参数」区里按需插入。
 */
function currentInputBindings(node: WorkflowNode): NodeInputBinding[] {
  const fromInputs: NodeInputBinding[] = Object.entries(node.inputs ?? {}).map(([name, value]) => ({
    name,
    type: inferPortType(value),
    value: toEditable(value),
    source: typeof value === "string" && value.includes("${") ? "reference" : "literal"
  }));
  if (!node.inputBindings) {
    return fromInputs;
  }
  // 已保存的行排在前面；inputs 里有、但没登记成行的键补在后面，避免真值在面板上看不见。
  const known = new Set(node.inputBindings.map((item) => item.name));
  return [...node.inputBindings, ...fromInputs.filter((row) => !known.has(row.name))];
}

function inferPortType(value: unknown): NodePortType {
  if (typeof value === "number") {
    return "number";
  }
  if (typeof value === "boolean") {
    return "boolean";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (value && typeof value === "object") {
    return "object";
  }
  return "string";
}

function toEditable(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 引用框里只显示表达式主体，省掉 ${ } 两个外壳字符，完整值放在 title 上。 */
function refLabel(text: string): string {
  const matched = /^\$\{([^}]+)\}$/.exec(text);
  return matched ? matched[1] : text;
}

function fromEditable(text: string): unknown {
  if (text.trim() === "" || text.includes("${")) {
    return text.trim() === "" ? undefined : text;
  }
  const trimmed = text.trim();
  if (/^[\[{]/.test(trimmed) || /^(true|false|-?\d+(\.\d+)?)$/.test(trimmed)) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

/** 沿边反向找上游；未连边时退化为数组里排在当前节点之前的节点。 */
function upstreamNodes(workflow: WorkflowDefinition, nodeId: string): WorkflowNode[] {
  const incoming = new Map<string, string[]>();
  for (const edge of workflow.edges) {
    if (!incoming.has(edge.to)) {
      incoming.set(edge.to, []);
    }
    incoming.get(edge.to)!.push(edge.from);
  }
  const seen = new Set<string>();
  const stack = [...(incoming.get(nodeId) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    for (const parent of incoming.get(current) ?? []) {
      stack.push(parent);
    }
  }
  if (seen.size === 0) {
    const index = workflow.nodes.findIndex((node) => node.id === nodeId);
    return index > 0 ? workflow.nodes.slice(0, index) : [];
  }
  return workflow.nodes.filter((node) => seen.has(node.id));
}

/** 组装引用树：一层来源（工作流输入 / 上游节点），二层起是输出字段的嵌套。 */
function buildRefTree(
  workflow: WorkflowDefinition,
  upstream: WorkflowNode[],
  specs: NodeTypeSpec[]
): RefGroup[] {
  const groups: RefGroup[] = [];
  if (workflow.inputs.length > 0) {
    groups.push({
      key: "__input__",
      label: "工作流输入",
      kindLabel: "启动参数",
      color: "#4F7A57",
      fields: workflow.inputs.map((variable) => ({
        name: variable.name,
        path: variable.name,
        token: `${"$"}{input.${variable.name}}`,
        type: variable.type,
        desc: variable.description
      }))
    });
  }
  for (const node of upstream) {
    const spec = specs.find((item) => item.kind === node.kind);
    groups.push({
      key: node.id,
      label: node.title || node.id,
      kindLabel: spec?.label ?? node.kind,
      kind: node.kind,
      nodeId: node.id,
      fields: nodeRefFields(node, spec)
    });
  }
  return groups;
}

function nodeRefFields(node: WorkflowNode, spec?: NodeTypeSpec): RefField[] {
  const declared = node.outputSchema ?? [];
  const specPorts = spec?.ports.outputs ?? [];
  const fields: RefField[] = [];

  // 面板上的只读预设（Output.Answer / Output.Content / Thought）也要能在引用树里选到，
  // token 用预设名，运行时由输出契约别名解析到真实产物。
  for (const preset of presetOutputsOf(node)) {
    fields.push({
      name: preset.name,
      // 参数提取的字段挂在产物根上，不是 Output 分支下；其余预设仍是 Output.xxx。
      path: node.kind === "extract" ? preset.name : `Output.${preset.name}`,
      token: `${"$"}{${node.id}.${preset.name}}`,
      type: preset.type,
      desc: preset.description
    });
  }

  for (const port of specPorts) {
    const own = declared.find((item) => item.name === port.name);
    fields.push({
      name: port.name,
      path: port.name,
      token: `${"$"}{${node.id}.${port.name}}`,
      /** 节点上声明的类型优先：用户可能把 output 改成了 object。 */
      type: own?.type ?? port.type,
      desc: own?.description || port.label || port.description,
      children: refChildren(node.id, port.name, own?.properties ?? [])
    });
  }
  for (const item of declared) {
    if (specPorts.some((port) => port.name === item.name)) {
      continue;
    }
    fields.push({
      name: item.name,
      path: item.name,
      token: `${"$"}{${node.id}.${item.name}}`,
      type: item.type,
      desc: item.description,
      children: refChildren(node.id, item.name, item.properties ?? [])
    });
  }
  if (!fields.some((field) => field.name === "output")) {
    fields.unshift({
      name: "output",
      path: "output",
      token: `${"$"}{${node.id}.output}`,
      type: "string",
      desc: "主产物"
    });
  }
  // 只有开了异常处理的节点才会真的写 Error 分支，没开的列出来只会让人误引用空值。
  if (node.errorPolicy?.enabled === true || node.errorPolicy?.strategy === "continue" || node.errorPolicy?.strategy === "fallback") {
    fields.push({
      name: "Error",
      path: "Error",
      token: `${"$"}{${node.id}.Error}`,
      type: "object",
      desc: "运行时的报错信息",
      children: refChildren(node.id, "Error", ERROR_FIELDS)
    });
  }
  return fields;
}

function refChildren(nodeId: string, prefix: string, properties: NodeOutputProperty[]): RefField[] | undefined {
  if (properties.length === 0) {
    return undefined;
  }
  return properties.map((item) => ({
    name: item.name,
    path: `${prefix}.${item.name}`,
    token: `${"$"}{${nodeId}.${prefix}.${item.name}}`,
    type: item.type,
    desc: item.description,
    children: refChildren(nodeId, `${prefix}.${item.name}`, item.properties ?? [])
  }));
}

/** 摊平给原生 select 用（字段内联插入变量）。 */
function flattenRefGroups(groups: RefGroup[]): RefOption[] {
  const options: RefOption[] = [];
  const walk = (group: RefGroup, fields: RefField[]) => {
    for (const field of fields) {
      options.push({
        value: field.token,
        label: `${field.path}（${field.type}）`,
        group: `${group.label}（${group.kindLabel}）`,
        type: field.type
      });
      if (field.children?.length) {
        walk(group, field.children);
      }
    }
  };
  for (const group of groups) {
    walk(group, group.fields);
  }
  return options;
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
