import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Database,
  FileText,
  ImagePlus,
  Loader2,
  Pencil,
  Plus,
  Search,
  Trash2,
  Wand2,
  Wrench,
  X
} from "lucide-react";
import { platformApi } from "../platform/api";
import type {
  AgentChatConfig,
  AgentRecord,
  AgentVariable,
  KnowledgeBaseRef,
  ModelProfileView,
  ToolRecord
} from "../platform/types";
import { AgentAvatar } from "./AgentAvatar";
import { compressAvatar } from "./avatar";
import "./agents.css";

type AgentEditorProps = {
  /** 传了就是编辑，不传就是新建。 */
  agent?: AgentRecord;
  onClose: () => void;
  onSaved: (agent: AgentRecord) => void;
};

/** 面板宽度：名称 30、功能描述 200、提示词 20000。 */
const MAX_NAME = 30;
const MAX_DESCRIPTION = 200;
const MAX_PROMPT = 20000;
/** 跟后端 parseChatConfig 的 MAX_WELCOME 对齐；内置智能体开场白本来就长。 */
const MAX_WELCOME = 1000;
const DEFAULT_CONTEXT_TURNS = 6;

/** 提示词模板：只给骨架，具体内容留给用户填。 */
const PROMPT_TEMPLATES: Array<{ id: string; label: string; body: string }> = [
  {
    id: "retrieval",
    label: "检索 / 查询型",
    body: [
      "# 任务目标",
      "根据用户给出的主题，检索到相关资料再回答，答案必须来自检索结果。",
      "",
      "# 任务流程",
      "1. 从用户描述里提取检索关键词（主题、时间范围、作者等）。",
      "2. 调用检索工具查询，拿到结果后再组织答案。",
      "3. 按「题录 + 一句话结论」输出，注明来源。",
      "",
      "# 限制说明",
      "检索不到就直说没有找到，不编造文献、不虚构引用。"
    ].join("\n")
  },
  {
    id: "task",
    label: "任务执行型",
    body: [
      "# 任务目标",
      "把用户交代的事情拆成可执行的步骤，逐步完成并给出结果。",
      "",
      "# 任务流程",
      "1. 复述一遍目标，列出不确定的地方。",
      "2. 拆步骤，标明每步的输入与产出。",
      "3. 按步骤执行，遇到缺信息先问，不自己假设。",
      "",
      "# 限制说明",
      "不确定的事说不确定，不编造数据；没有的工具不假装调用。"
    ].join("\n")
  },
  {
    id: "tutor",
    label: "讲解 / 答疑型",
    body: [
      "# 任务目标",
      "把知识点讲清楚，让提问的人能自己复述出来。",
      "",
      "# 任务流程",
      "1. 先给一句话直答。",
      "2. 再解释原因，必要时举个例子。",
      "3. 最后点出容易错的地方。",
      "",
      "# 限制说明",
      "不堆术语，不写客套话；知识边界之外的问题明确说不知道。"
    ].join("\n")
  }
];

function describe(error: unknown) {
  return error instanceof Error ? error.message : "保存失败，稍后重试。";
}

/** 工具 id 形如 mcp.library.query，取末段当函数名/兜底名称。 */
function toolLabel(id: string) {
  const segments = id.split(".").filter(Boolean);
  return segments[segments.length - 1] || id;
}

/** 工具选择列表的分组标签：0=平台插件，1=自定义插件，2=平台工作流，3=外部 MCP，4=智能体转交。 */
const TOOL_GROUP_LABELS = ["平台插件", "自定义插件", "平台工作流", "MCP 工具", "智能体转交"] as const;

/** 委派工具的写法：agent://<智能体 id>。 */
const DELEGATION_PREFIX = "agent://";

/** 字数计数：贴着输入框右下角。 */
function FieldCounter({ value, max }: { value: number; max: number }) {
  return (
    <span className={`agent-counter ${value > max ? "is-over" : ""}`}>
      {value}/{max}
    </span>
  );
}

export function AgentEditor({ agent, onClose, onSaved }: AgentEditorProps) {
  const [name, setName] = useState(agent?.name ?? "");
  const [description, setDescription] = useState(agent?.description ?? "");
  const [avatar, setAvatar] = useState(agent?.avatar ?? "");
  const [prompt, setPrompt] = useState(agent?.prompt ?? "");
  const [model, setModel] = useState(agent?.model ?? "");
  const [tools, setTools] = useState<string[]>(agent?.tools ?? []);
  const [config, setConfig] = useState<AgentChatConfig>(agent?.chatConfig ?? {});
  const [models, setModels] = useState<ModelProfileView[]>([]);
  const [toolOptions, setToolOptions] = useState<ToolRecord[]>([]);
  const [agentOptions, setAgentOptions] = useState<AgentRecord[]>([]);
  const [knowledgeOptions, setKnowledgeOptions] = useState<KnowledgeBaseRef[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [polishing, setPolishing] = useState(false);
  const [toolQuery, setToolQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // 面板在表单靠下的位置，展开后自动滚进来，省得用户以为按钮没反应。
    if (pickerOpen) {
      pickerRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [pickerOpen]);

  useEffect(() => {
    let cancelled = false;
    platformApi
      .listModels()
      .then((result) => {
        if (!cancelled) {
          setModels(result.models.filter((item) => item.configured));
        }
      })
      .catch(() => {
        // 模型列表拿不到不影响填其他字段，保存时后端还会再校验一次
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    platformApi
      .listTools()
      .then((result) => {
        if (!cancelled) {
          // 能在对话里真正执行的工具：平台插件（builtin）+ 已启用的 MCP 工具，停用的不列出来免得白挂。
          setToolOptions(
            result.tools.filter((item) => (item.type === "mcp" || item.type === "builtin") && item.enabled)
          );
        }
      })
      .catch(() => {
        // 工具列表拿不到时仍然可以保存，只是选不了新工具
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    platformApi
      .listAgents("chat")
      .then((result) => {
        if (!cancelled) {
          // 转交工具在配置里只存 agent://<id>，面板上要显示成对方的名字，
          // 所以这里把「能对话的智能体」也拉一份，纯粹用来做 id → 名字的翻译。
          // scope=chat 是为了排除内置的工作流零件（评分器、虚拟学生那些）。
          setAgentOptions(result.agents ?? []);
        }
      })
      .catch(() => {
        // 拿不到列表时委派仍能保存，只是面板上会退回显示 id
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    platformApi
      .knowledgeBases()
      .then((result) => {
        if (!cancelled) {
          setKnowledgeOptions(result.bases ?? []);
        }
      })
      .catch(() => {
        // 知识库列表拿不到不影响保存，保存时后端只校验 id 列表本身
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const variables = config.variables ?? [];
  // 角色定位从表单里拿掉了：功能描述已经承担「你是谁、什么场景用你」。
  // 老数据里的 role 原样带回，避免编辑一次就把工作流依赖的角色丢空。
  const role = agent?.role ?? "";
  const advancedOpen = Boolean(
    agent &&
      ((agent.chatConfig?.contextTurns ?? DEFAULT_CONTEXT_TURNS) !== DEFAULT_CONTEXT_TURNS ||
        agent.chatConfig?.maxTokens ||
        agent.chatConfig?.temperature ||
        agent.chatConfig?.typewriter === false ||
        agent.chatConfig?.welcome ||
        (agent.chatConfig?.quickPrompts?.length ?? 0) > 0 ||
        (agent.chatConfig?.variables?.length ?? 0) > 0)
  );

  function patchConfig(next: Partial<AgentChatConfig>) {
    setConfig((current) => {
      const merged = { ...current, ...next };
      // 空值要真的删掉，否则后端会当「沿用旧值」，改回默认就改不动了
      for (const key of Object.keys(merged) as Array<keyof AgentChatConfig>) {
        const value = merged[key];
        if (value === undefined || value === null || value === "") {
          delete merged[key];
        }
      }
      return merged;
    });
  }

  async function pickAvatar(file: File | undefined) {
    if (!file) {
      return;
    }
    try {
      setAvatar(await compressAvatar(file));
      setError("");
    } catch (cause) {
      setError(describe(cause));
    }
  }

  function toggleTool(id: string) {
    setTools((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    );
  }

  const knowledgeBaseIds = config.knowledgeBaseIds ?? [];

  function toggleKnowledgeBase(id: string) {
    const next = knowledgeBaseIds.includes(id)
      ? knowledgeBaseIds.filter((item) => item !== id)
      : [...knowledgeBaseIds, id];
    patchConfig({ knowledgeBaseIds: next });
  }

  function applyTemplate(body: string) {
    setTemplateOpen(false);
    // 已经写过的提示词不覆盖，接在后面，避免一键点掉用户自己的内容。
    setPrompt((current) => (current.trim() ? `${current.trim()}\n\n${body}` : body));
  }

  async function polishPrompt() {
    if (polishing) {
      return;
    }
    if (prompt.trim().length < 8) {
      setError("先写几句提示词，再点一键优化。");
      return;
    }
    setPolishing(true);
    setError("");
    try {
      const result = await platformApi.polishPrompt({
        prompt,
        name,
        description,
        ...(model ? { model } : {})
      });
      setPrompt(result.prompt);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setPolishing(false);
    }
  }

  function updateVariable(index: number, patch: Partial<AgentVariable>) {
    patchConfig({
      variables: variables.map((item, current) =>
        current === index ? { ...item, ...patch } : item
      )
    });
  }

  function removeVariable(index: number) {
    patchConfig({ variables: variables.filter((_, current) => current !== index) });
  }

  function addVariable() {
    patchConfig({
      variables: [
        ...variables,
        { key: `var_${variables.length + 1}`, label: "", required: false, defaultValue: "" }
      ]
    });
  }

  async function save() {
    if (!name.trim()) {
      setError("先给这个智能体起个名字。");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const result = await platformApi.saveAgent({
        ...(agent ? { id: agent.id } : {}),
        name: name.trim(),
        description: description.trim(),
        avatar,
        role,
        prompt: prompt.trim(),
        model,
        tools,
        chatConfig: config
      });
      onSaved(result.agent);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setSaving(false);
    }
  }

  /**
   * 委派工具也要能显示成人话：配置里只存 agent://teacher-prep，
   * 面板上要显示「转交给备课专项」。顺手把它们也放进选择列表，
   * 否则删掉一个就再也加不回来。
   */
  const delegationOptions: ToolRecord[] = agentOptions
    .filter((item) => item.id !== agent?.id && item.enabled)
    .map((item) => ({
      id: `${DELEGATION_PREFIX}${item.id}`,
      name: `转交给${item.name}`,
      type: "builtin" as const,
      schema: { type: "object" },
      endpoint: DELEGATION_PREFIX,
      description: ["把问题交给「" + item.name + "」处理", item.description || item.role]
        .filter(Boolean)
        .join("："),
      enabled: true,
      createdAt: "",
      updatedAt: "",
      source: "builtin" as const
    }));
  const allToolOptions = [...toolOptions, ...delegationOptions];

  const keyword = toolQuery.trim().toLowerCase();
  const visibleTools = allToolOptions.filter((item) => {
    if (!keyword) {
      return true;
    }
    return `${item.name} ${item.description} ${item.id}`.toLowerCase().includes(keyword);
  });
  // 平台插件排最前，其次自定义插件、平台工作流、外部 MCP、智能体转交，组内按名称排，方便扫读。
  const toolGroupOf = (item: ToolRecord) => {
    if ((item.endpoint ?? "").startsWith(DELEGATION_PREFIX)) {
      return 4;
    }
    return item.type === "builtin"
      ? (item.endpoint ?? "").startsWith("plugin://")
        ? 1
        : 0
      : (item.endpoint ?? "").startsWith("workflow://")
        ? 2
        : 3;
  };
  const groupedTools = [...visibleTools].sort(
    (left, right) => toolGroupOf(left) - toolGroupOf(right) || left.name.localeCompare(right.name, "zh-Hans-CN")
  );

  return (
    <div
      className="agent-editor-mask"
      role="dialog"
      aria-modal="true"
      aria-label={agent ? "编辑智能体" : "添加 Agent"}
    >
      <div className="agent-editor">
        <header>
          <div className="agent-editor-heading">
            <span>{agent ? "编辑智能体" : "添加 Agent"}</span>
            <h2>{agent ? agent.name : "自己定义一个能对话的智能体"}</h2>
          </div>
          <div className="agent-editor-aside">
            <div className="agent-avatar-block">
              <button
                type="button"
                className="agent-avatar-pick"
                onClick={() => fileRef.current?.click()}
                title={avatar ? "换一张头像" : "点这里上传头像，不传就用默认机器人"}
              >
                <AgentAvatar name={name || "智能体"} avatar={avatar} size={60} />
                <span>
                  <Pencil size={11} />
                </span>
              </button>
              {avatar && (
                <button type="button" className="agent-link" onClick={() => setAvatar("")}>
                  默认头像
                </button>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(event) => void pickAvatar(event.target.files?.[0])}
            />
            <button type="button" className="agent-icon-button" aria-label="关闭" onClick={onClose}>
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="agent-editor-body">
          <label className="agent-field">
            <span className="agent-label">
              <span>
                Agent 名称<em>*</em>
              </span>
              <FieldCounter value={name.length} max={MAX_NAME} />
            </span>
            <input
              value={name}
              maxLength={MAX_NAME}
              placeholder="请使用简洁明确的名称描述 Agent 功能，例如：文献查询助手"
              onChange={(event) => setName(event.target.value)}
            />
          </label>

          <label className="agent-field">
            <span className="agent-label">
              <span>
                选择模型<em>*</em>
              </span>
            </span>
            <select value={model} onChange={(event) => setModel(event.target.value)}>
              <option value="">跟随设置里的默认模型</option>
              {/* 配置里可能直接写上游模型名（比如 qwen-flash），它不在模型档案里。
                  补一条，否则下拉框会显示成「跟随默认」，把真实配置藏起来。 */}
              {model && !models.some((item) => item.id === model) ? (
                <option value={model}>直连 {model}</option>
              ) : null}
              {models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}（{item.model}）
                </option>
              ))}
            </select>
            {models.length === 0 && (
              <small className="agent-hint">
                这个账号还没有可用模型。先去「设置 → 模型与密钥」加一个，再回来选。
              </small>
            )}
          </label>

          <label className="agent-field">
            <span className="agent-label">
              <span>
                功能描述<em>*</em>
              </span>
              <FieldCounter value={description.length} max={MAX_DESCRIPTION} />
            </span>
            <textarea
              rows={2}
              maxLength={MAX_DESCRIPTION}
              value={description}
              placeholder="负责 <功能> 的 Agent，完成 <典型场景> 的特定任务。"
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>

          <div className="agent-field">
            <div className="agent-label-row">
              <span className="agent-label">
                <span>提示词</span>
              </span>
              <div className="agent-prompt-actions">
                <div className="agent-template-wrap">
                  <button
                    type="button"
                    className="agent-chip-button"
                    aria-expanded={templateOpen}
                    onClick={() => setTemplateOpen((open) => !open)}
                  >
                    <FileText size={12} />
                    模板
                  </button>
                  {templateOpen && (
                    <div className="agent-template-menu">
                      {PROMPT_TEMPLATES.map((item) => (
                        <button
                          type="button"
                          key={item.id}
                          onClick={() => applyTemplate(item.body)}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className="agent-chip-button is-accent"
                  disabled={polishing}
                  onClick={() => void polishPrompt()}
                >
                  {polishing ? <Loader2 size={12} className="is-spinning" /> : <Wand2 size={12} />}
                  一键优化
                </button>
              </div>
            </div>
            <textarea
              className="agent-prompt"
              value={prompt}
              maxLength={MAX_PROMPT}
              rows={9}
              placeholder={
                "通过填写描述，设定以下内容\n# 任务目标\n# 任务流程\n# 限制说明\n\n需要按场景填参数时，在提示词里写 {{变量名}}，再到「高级设置 → 变量」里加同名的变量。"
              }
              onChange={(event) => setPrompt(event.target.value)}
            />
            <div className="agent-field-foot">
              <FieldCounter value={prompt.length} max={MAX_PROMPT} />
            </div>
          </div>

          <section className="agent-section">
            <div className="agent-section-head">
              <h3>工具</h3>
              <button
                type="button"
                className="agent-chip-button"
                onClick={() => setPickerOpen((open) => !open)}
              >
                <Plus size={12} />
                添加工具
              </button>
            </div>
            {tools.length === 0 && !pickerOpen ? (
              <p className="agent-hint">
                还没有工具。点「添加工具」从平台插件、MCP 接入，或直接转交给平台里别的智能体。
              </p>
            ) : null}

            {tools.length > 0 && (
              <div className="agent-tool-list">
                {tools.map((toolId) => {
                  const tool = allToolOptions.find((item) => item.id === toolId);
                  const missingHint = toolId.startsWith(DELEGATION_PREFIX)
                    ? "要转交的智能体已停用或不存在，这条转交暂时用不了"
                    : "这个工具当前不可用（已停用或没发现了）";
                  return (
                    <span
                      className={`agent-tool-chip ${tool ? "" : "is-missing"}`}
                      key={toolId}
                      title={tool?.description ?? missingHint}
                    >
                      <Wrench size={12} />
                      <span>{tool?.name ?? toolLabel(toolId)}</span>
                      <button
                        type="button"
                        aria-label={`移除 ${tool?.name ?? toolId}`}
                        onClick={() => toggleTool(toolId)}
                      >
                        <X size={12} />
                      </button>
                    </span>
                  );
                })}
              </div>
            )}

            {pickerOpen && (
              <div className="agent-tool-picker" ref={pickerRef}>
                <div className="agent-tool-picker-head">
                  <Search size={13} />
                  <input
                    value={toolQuery}
                    placeholder="搜索工具名或用途"
                    aria-label="搜索工具"
                    onChange={(event) => setToolQuery(event.target.value)}
                  />
                  <button
                    type="button"
                    className="agent-icon-button is-small"
                    aria-label="收起工具列表"
                    onClick={() => setPickerOpen(false)}
                  >
                    <X size={13} />
                  </button>
                </div>
                <div className="agent-tool-picker-list">
                  {groupedTools.length === 0 ? (
                    <p className="agent-hint">
                      {allToolOptions.length === 0
                        ? "还没有可用工具。平台插件（知识库检索、课堂训练等）默认就有；也可以去「MCP 接入」连服务器同步更多工具。"
                        : "没有匹配的工具。"}
                    </p>
                  ) : (
                    groupedTools.map((item, index) => {
                      const picked = tools.includes(item.id);
                      const showGroupHead =
                        index === 0 || toolGroupOf(item) !== toolGroupOf(groupedTools[index - 1]);
                      const groupLabel = TOOL_GROUP_LABELS[toolGroupOf(item)];
                      return (
                        <div key={item.id}>
                          {showGroupHead && (
                            <p className="agent-tool-group-head">{groupLabel}</p>
                          )}
                          <button
                            type="button"
                            className={`agent-tool-option ${picked ? "is-picked" : ""}`}
                            onClick={() => toggleTool(item.id)}
                          >
                            <span className="agent-tool-option-name">
                              {item.name}
                              {picked && <Check size={12} />}
                            </span>
                            <small>{item.description || item.id}</small>
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </section>

          <section className="agent-section">
            <div className="agent-section-head">
              <h3>知识库</h3>
              <span className="agent-section-note">选中后，这个智能体每次回答都会先查这些资料</span>
            </div>
            {knowledgeBaseIds.length > 0 ? (
              <div className="agent-tool-list">
                {knowledgeBaseIds.map((baseId) => {
                  const base = knowledgeOptions.find((item) => item.id === baseId);
                  return (
                    <span
                      className={`agent-tool-chip ${base ? "" : "is-missing"}`}
                      key={baseId}
                      title={base ? `${base.documentCount} 篇文档` : "这个知识库当前不可用（可能已删除）"}
                    >
                      <Database size={12} />
                      <span>{base?.name ?? baseId}</span>
                      <button
                        type="button"
                        aria-label={`移除知识库 ${base?.name ?? baseId}`}
                        onClick={() => toggleKnowledgeBase(baseId)}
                      >
                        <X size={12} />
                      </button>
                    </span>
                  );
                })}
              </div>
            ) : null}
            {knowledgeOptions.length === 0 ? (
              <p className="agent-hint">
                还没有知识库。先去「知识库」页新建一个，或导入示例资料包，再回来挂到这里。
              </p>
            ) : (
              <div className="agent-kb-list">
                {knowledgeOptions.map((base) => {
                  const picked = knowledgeBaseIds.includes(base.id);
                  return (
                    <button
                      type="button"
                      key={base.id}
                      className={`agent-kb-option ${picked ? "is-picked" : ""}`}
                      onClick={() => toggleKnowledgeBase(base.id)}
                    >
                      <span className="agent-kb-option-name">
                        {base.name}
                        {picked ? <Check size={12} /> : null}
                      </span>
                      <small>{base.documentCount} 篇</small>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          <details className="agent-advanced" open={advancedOpen}>
            <summary>
              <ChevronDown size={14} />
              高级设置
              <small>变量、上下文轮数、回复长度、逐字显示、开场语</small>
            </summary>
            <div className="agent-advanced-body">
              <div className="agent-variables">
                <div className="agent-variables-head">
                  <strong>变量</strong>
                  <span>
                    提示词里写 <code>{"{{变量名}}"}</code>，聊天时按填的值替换。
                  </span>
                  <button type="button" className="agent-chip-button" onClick={addVariable}>
                    <Plus size={12} />
                    添加
                  </button>
                </div>
                {variables.length === 0 ? (
                  <p className="agent-hint">还没有变量。不需要就跳过。</p>
                ) : (
                  variables.map((item, index) => (
                    <div className="agent-variable-row" key={index}>
                      <input
                        value={item.key}
                        placeholder="变量名"
                        aria-label="变量名"
                        onChange={(event) => updateVariable(index, { key: event.target.value })}
                      />
                      <input
                        value={item.label}
                        placeholder="说明（给填的人看）"
                        aria-label="变量说明"
                        onChange={(event) => updateVariable(index, { label: event.target.value })}
                      />
                      <input
                        value={item.defaultValue}
                        placeholder="默认值"
                        aria-label="默认值"
                        onChange={(event) => updateVariable(index, { defaultValue: event.target.value })}
                      />
                      <label className="agent-variable-required">
                        <input
                          type="checkbox"
                          checked={item.required}
                          onChange={(event) => updateVariable(index, { required: event.target.checked })}
                        />
                        必填
                      </label>
                      <button
                        type="button"
                        className="agent-icon-button is-small"
                        aria-label="删除这个变量"
                        onClick={() => removeVariable(index)}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))
                )}
              </div>

              <div className="agent-grid">
                <label>
                  上下文轮数
                  <input
                    type="number"
                    min={1}
                    max={30}
                    value={config.contextTurns ?? DEFAULT_CONTEXT_TURNS}
                    onChange={(event) =>
                      patchConfig({ contextTurns: Number(event.target.value) || DEFAULT_CONTEXT_TURNS })
                    }
                  />
                </label>
                <label>
                  回复上限（token）
                  <input
                    type="number"
                    min={64}
                    max={32000}
                    placeholder="默认"
                    value={config.maxTokens ?? ""}
                    onChange={(event) =>
                      patchConfig({ maxTokens: event.target.value === "" ? null : Number(event.target.value) })
                    }
                  />
                </label>
                <label>
                  温度
                  <input
                    type="number"
                    min={0}
                    max={2}
                    step={0.1}
                    placeholder="默认"
                    value={config.temperature ?? ""}
                    onChange={(event) =>
                      patchConfig({
                        temperature: event.target.value === "" ? null : Number(event.target.value)
                      })
                    }
                  />
                </label>
              </div>
              <label className="agent-switch">
                <input
                  type="checkbox"
                  checked={config.typewriter !== false}
                  onChange={(event) => patchConfig({ typewriter: event.target.checked })}
                />
                逐字回复（挂了工具时，工具执行完才会一次性给出结论）
              </label>
              <label className="agent-field">
                <span className="agent-label">
                  <span>欢迎语</span>
                  <FieldCounter
                    value={(config.welcome ?? "").length}
                    max={MAX_WELCOME}
                  />
                </span>
                <textarea
                  rows={3}
                  maxLength={MAX_WELCOME}
                  value={config.welcome ?? ""}
                  placeholder="空对话时显示的一段话，可以换行"
                  onChange={(event) => patchConfig({ welcome: event.target.value })}
                />
              </label>
              <label className="agent-field">
                <span className="agent-label">快捷指令</span>
                <textarea
                  rows={3}
                  placeholder={"一行一条，例如：\n帮我查近三年关于项目式学习的文献\n把这个主题拆成三个检索式"}
                  value={(config.quickPrompts ?? []).join("\n")}
                  onChange={(event) =>
                    patchConfig({
                      quickPrompts: event.target.value
                        .split("\n")
                        .map((line) => line.trim())
                        .filter((line) => line !== "")
                    })
                  }
                />
              </label>
            </div>
          </details>
        </div>

        {error && <p className="agent-error">{error}</p>}

        <footer>
          <button type="button" className="platform-button is-ghost" onClick={onClose} disabled={saving}>
            关闭
          </button>
          <button type="button" className="platform-button is-primary" onClick={() => void save()} disabled={saving}>
            {saving && <Loader2 size={14} className="is-spinning" />}
            {agent ? "保存修改" : "创建智能体"}
          </button>
        </footer>
      </div>
    </div>
  );
}
