import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  NODE_KINDS,
  type HttpMethod,
  type NodeErrorPolicy,
  type NodeInputBinding,
  type NodeKind,
  type NodeOutputProperty,
  type NodePortType,
  type VerifyCheck,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowVariable,
  type WorkflowVariableType
} from "../types.js";

const VARIABLE_TYPES = new Set<WorkflowVariableType>(["string", "number", "boolean", "object"]);
const ERROR_STRATEGIES = new Set<string>(["abort", "continue", "fallback"]);
const HTTP_METHODS = new Set<string>(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const VERIFY_CHECK_TYPES = new Set<VerifyCheck["type"]>(["number_match"]);
const CLARIFY_MODES = new Set<string>(["high", "any", "never"]);
const EXTRACT_PARAM_TYPES = new Set(["string", "number", "boolean"]);
const VERIFY_EVIDENCE_VIEWS = new Set<string>(["pool", "cited", "split"]);

export class WorkflowSyntaxError extends Error {
  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "WorkflowSyntaxError";
  }
}

/**
 * 字段路径里出现的 key -> 中文标签，用来把 `nodes[12].params[0].label` 这种
 * 机器路径翻译成「节点「参数提取1」› 参数信息 第1项 › 标签」这种肉眼可读、能直接定位的位置。
 */
const FIELD_LABELS: Record<string, string> = {
  id: "ID",
  title: "标题",
  kind: "类型",
  description: "描述",
  prompt: "提示词",
  template: "模板",
  agent: "智能体",
  tool: "工具",
  url: "请求地址",
  method: "请求方法",
  query: "检索问题",
  verifier: "验证智能体",
  workflowId: "子工作流",
  when: "条件表达式",
  params: "参数信息",
  label: "标签",
  name: "名称",
  question: "追问话术",
  type: "类型",
  required: "是否必填",
  defaultValue: "默认值",
  placeholder: "占位提示",
  options: "选项",
  optionsFrom: "选项来源",
  inputs: "输入变量",
  inputBindings: "输入映射",
  outputSchema: "输出字段",
  errorPolicy: "出错策略",
  emitOutput: "输出开关",
  streamOutput: "流式开关",
  then: "条件成立分支",
  else: "条件不成立分支",
  body: "循环体",
  branches: "分支",
  edges: "连线",
  from: "起点",
  to: "终点",
  fromPort: "出口端口",
  knowledgeBaseIds: "知识库",
  teamId: "团队",
  version: "版本",
  outputs: "输出",
  args: "参数",
  requestBody: "请求体",
  headers: "请求头",
  system: "系统提示",
  generatePrompt: "生成提示",
  maxRounds: "最大追问轮数",
  onMissing: "缺失处理",
  askPrompt: "追问引导语",
  stubOutput: "桩输出",
  outputFormat: "输出格式",
  outputContract: "输出契约",
  capabilities: "能力",
  anchors: "锚点",
  tolerance: "容差",
  maxDurationMs: "最长耗时",
  maxTokens: "最大Token",
  agentVersion: "智能体版本"
};

type PathToken = { key?: string; index?: number };

/** 把 `nodes[12].params[0].label` 拆解成 [{key:nodes},{index:12},{key:params},{index:0},{key:label}]。 */
function parsePathTokens(path: string): PathToken[] {
  const tokens: PathToken[] = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(path)) !== null) {
    if (match[2] !== undefined) {
      tokens.push({ index: Number(match[2]) });
    } else {
      tokens.push({ key: match[1] });
    }
  }
  return tokens;
}

export type SyntaxErrorDescription = {
  /** 人类可读的位置，如「节点「参数提取1」› 参数信息 第1项 › 标签」。 */
  path: string;
  /** 纯问题文案，已剥掉前缀路径，如「应为非空字符串」。 */
  message: string;
  /** 报错归属节点 ID（含容器嵌套节点），没有则缺省（工作流级问题）。 */
  nodeId?: string;
  /** 若落在「参数提取」节点的某个参数上，给出参数下标，前端可滚到那一行。 */
  paramIndex?: number;
};

/**
 * 把编译期抛出的 WorkflowSyntaxError 翻译成「能看懂、能跳转」的诊断条目。
 * 解析失败发生在 parseWorkflowDefinition 内部，所以 source 仍是原始 DSL（或已存的解析结果），
 * 可以顺着 error.path 的索引一路走到出错的节点，把数组下标换成节点标题 / 字段中文名。
 */
export function describeSyntaxError(source: unknown, error: WorkflowSyntaxError): SyntaxErrorDescription {
  const rawMessage = error.message.startsWith(`${error.path}: `)
    ? error.message.slice(error.path.length + 2)
    : error.message;

  const tokens = parsePathTokens(error.path);
  const segments: string[] = [];
  let current: unknown = source;
  let nodeId: string | undefined;
  let nodeTitle: string | undefined;
  let paramIndex: number | undefined;
  let lastWasArrayField = false;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.key !== undefined && isRecordLike(current)) {
      current = (current as Record<string, unknown>)[token.key];
    } else if (token.index !== undefined && Array.isArray(current)) {
      current = current[token.index];
    } else {
      current = undefined;
    }

    // 落在一个节点对象（有 kind 或 id）上时，记录它作为「当前节点上下文」。
    if (isRecordLike(current)) {
      const record = current as Record<string, unknown>;
      if (typeof record.kind === "string" || typeof record.id === "string") {
        nodeId = typeof record.id === "string" ? record.id : nodeId;
        nodeTitle = typeof record.title === "string" ? record.title : nodeTitle;
      }
    }

    if (token.key !== undefined) {
      const label = FIELD_LABELS[token.key] ?? token.key;
      segments.push(label);
      lastWasArrayField = false;
      // params[k] 紧跟在 params 之后：记下行号，方便前端滚到那一行的参数。
      if (token.key === "params" && tokens[i + 1]?.index !== undefined) {
        paramIndex = tokens[i + 1].index;
      }
    } else if (token.index !== undefined) {
      const human = `第${token.index + 1}项`;
      if (segments.length > 0 && !lastWasArrayField) {
        segments[segments.length - 1] = `${segments[segments.length - 1]} ${human}`;
        lastWasArrayField = true;
      } else {
        segments.push(human);
        lastWasArrayField = false;
      }
    }
  }

  const nodePrefix = nodeTitle
    ? `节点「${nodeTitle}」`
    : nodeId
      ? `节点 ${nodeId}`
      : null;
  const fieldPath = segments.join(" › ");
  const path = nodePrefix ? (fieldPath ? `${nodePrefix} › ${fieldPath}` : nodePrefix) : fieldPath || error.path;

  return { path, message: rawMessage, nodeId, paramIndex };
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseWorkflowDefinition(value: unknown): WorkflowDefinition {
  const root = asRecord(value, "workflow");
  const nodes = asArray(root.nodes, "nodes").map((node, index) => parseNode(node, `nodes[${index}]`));
  return {
    id: requireString(root.id, "id"),
    name: requireString(root.name, "name"),
    version: requireInteger(root.version, "version"),
    description: optionalString(root.description, "description"),
    inputs: root.inputs === undefined ? [] : asArray(root.inputs, "inputs").map((item, index) => parseVariable(item, `inputs[${index}]`)),
    nodes,
    edges: root.edges === undefined ? [] : asArray(root.edges, "edges").map((item, index) => parseEdge(item, `edges[${index}]`)),
    knowledgeBaseIds: parseKnowledgeBaseIds(root.knowledgeBaseIds),
    teamId: optionalString(root.teamId, "teamId")
  };
}

/** 读取 workflow 目录下的内置 DSL 文件（*.json），单个文件解析失败直接抛出文件名。 */
export function loadBuiltinWorkflows(
  directory = path.resolve("server", "platform", "workflow")
): WorkflowDefinition[] {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      const raw = JSON.parse(readFileSync(path.join(directory, file), "utf8")) as unknown;
      try {
        return parseWorkflowDefinition(raw);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new WorkflowSyntaxError(file, detail);
      }
    });
}

function parseNode(value: unknown, location: string): WorkflowNode {
  const record = asRecord(value, location);
  const id = requireString(record.id, `${location}.id`);
  const kind = requireString(record.kind, `${location}.kind`);
  if (!(NODE_KINDS as readonly string[]).includes(kind)) {
    throw new WorkflowSyntaxError(`${location}.kind`, `未知节点类型 "${kind}"，仅支持 ${NODE_KINDS.join(" / ")}`);
  }
  const base = {
    id,
    title: optionalString(record.title, `${location}.title`),
    description: optionalString(record.description, `${location}.description`),
    inputs: record.inputs === undefined ? undefined : asRecord(record.inputs, `${location}.inputs`),
    inputBindings:
      record.inputBindings === undefined
        ? undefined
        : parseInputBindings(record.inputBindings, `${location}.inputBindings`),
    outputSchema:
      record.outputSchema === undefined
        ? undefined
        : parseOutputProperties(record.outputSchema, `${location}.outputSchema`),
    errorPolicy:
      record.errorPolicy === undefined
        ? undefined
        : parseErrorPolicy(record.errorPolicy, `${location}.errorPolicy`),
    emitOutput: parseOptionalBoolean(record.emitOutput, `${location}.emitOutput`),
    streamOutput: parseOptionalBoolean(record.streamOutput, `${location}.streamOutput`)
  };

  switch (kind as NodeKind) {
    case "start":
      return { ...base, kind: "start" };
    case "end":
      return { ...base, kind: "end" };
    case "agent":
      return {
        ...base,
        kind: "agent",
        agent: requireString(record.agent, `${location}.agent`),
        agentVersion: parseAgentVersion(record.agentVersion, `${location}.agentVersion`),
        capabilities:
          record.capabilities === undefined
            ? undefined
            : parseStringArray(record.capabilities, `${location}.capabilities`),
        prompt: optionalString(record.prompt, `${location}.prompt`),
        outputFormat: parseOutputFormat(record.outputFormat, `${location}.outputFormat`),
        outputContract:
          record.outputContract === undefined
            ? undefined
            : parseOutputContract(record.outputContract, `${location}.outputContract`),
        stubOutput:
          record.stubOutput === undefined
            ? undefined
            : asRecord(record.stubOutput, `${location}.stubOutput`),
        loopRole: parseLoopRole(record.loopRole, `${location}.loopRole`),
        promoteToAgent: optionalString(record.promoteToAgent, `${location}.promoteToAgent`),
        toolCalling: parseOptionalBoolean(record.toolCalling, `${location}.toolCalling`),
        model: optionalString(record.model, `${location}.model`)
      };
    case "tool":
      return {
        ...base,
        kind: "tool",
        tool: requireString(record.tool, `${location}.tool`),
        args: record.args === undefined ? undefined : asRecord(record.args, `${location}.args`)
      };
    case "knowledge":
      return {
        ...base,
        kind: "knowledge",
        query: requireString(record.query, `${location}.query`),
        knowledgeBaseIds:
          record.knowledgeBaseIds === undefined
            ? undefined
            : parseStringArray(record.knowledgeBaseIds, `${location}.knowledgeBaseIds`),
        topK:
          record.topK === undefined
            ? undefined
            : requireInteger(record.topK, `${location}.topK`)
      };
    case "http": {
      const method = requireString(record.method, `${location}.method`).toUpperCase();
      if (!HTTP_METHODS.has(method)) {
        throw new WorkflowSyntaxError(
          `${location}.method`,
          `HTTP 方法只支持 ${[...HTTP_METHODS].join(" / ")}`
        );
      }
      return {
        ...base,
        kind: "http",
        method: method as HttpMethod,
        url: requireString(record.url, `${location}.url`),
        headers:
          record.headers === undefined
            ? undefined
            : parseStringRecord(record.headers, `${location}.headers`),
        requestBody: record.requestBody,
        timeoutMs:
          record.timeoutMs === undefined
            ? undefined
            : requireInteger(record.timeoutMs, `${location}.timeoutMs`)
      };
    }
    case "llm":
      return {
        ...base,
        kind: "llm",
        prompt: requireString(record.prompt, `${location}.prompt`),
        system: optionalString(record.system, `${location}.system`),
        model: optionalString(record.model, `${location}.model`),
        thinking:
          record.thinking === undefined
            ? undefined
            : requireBoolean(record.thinking, `${location}.thinking`),
        temperature:
          record.temperature === undefined
            ? undefined
            : requireNumber(record.temperature, `${location}.temperature`),
        topP: record.topP === undefined ? undefined : requireNumber(record.topP, `${location}.topP`),
        maxTokens:
          record.maxTokens === undefined
            ? undefined
            : requireInteger(record.maxTokens, `${location}.maxTokens`)
      };
    case "clarify": {
      const clarifyOn = optionalString(record.clarifyOn, `${location}.clarifyOn`);
      if (clarifyOn !== undefined && !CLARIFY_MODES.has(clarifyOn)) {
        throw new WorkflowSyntaxError(
          `${location}.clarifyOn`,
          `只支持 ${[...CLARIFY_MODES].join(" / ")}`
        );
      }
      return {
        ...base,
        kind: "clarify",
        prompt: optionalString(record.prompt, `${location}.prompt`),
        model: optionalString(record.model, `${location}.model`),
        clarifyOn: clarifyOn as "high" | "any" | "never" | undefined,
        maxQuestions:
          record.maxQuestions === undefined
            ? undefined
            : requireInteger(record.maxQuestions, `${location}.maxQuestions`),
        assignee: optionalString(record.assignee, `${location}.assignee`),
        timeoutMs:
          record.timeoutMs === undefined
            ? undefined
            : requireInteger(record.timeoutMs, `${location}.timeoutMs`),
        stubOutput:
          record.stubOutput === undefined
            ? undefined
            : asRecord(record.stubOutput, `${location}.stubOutput`)
      };
    }
    case "extract": {
      const onMissing = optionalString(record.onMissing, `${location}.onMissing`);
      if (onMissing !== undefined && onMissing !== "fail" && onMissing !== "continue") {
        throw new WorkflowSyntaxError(`${location}.onMissing`, "只支持 fail / continue");
      }
      return {
        ...base,
        kind: "extract",
        // 参数表是节点的核心定义：允许暂时为空（草稿里刚拖出来还没填），运行时按空表直接放行。
        params:
          record.params === undefined
            ? []
            : asArray(record.params, `${location}.params`).map((item, index) =>
                parseExtractParam(item, `${location}.params[${index}]`)
              ),
        prompt: optionalString(record.prompt, `${location}.prompt`),
        model: optionalString(record.model, `${location}.model`),
        askPrompt: optionalString(record.askPrompt, `${location}.askPrompt`),
        maxRounds:
          record.maxRounds === undefined
            ? undefined
            : requireInteger(record.maxRounds, `${location}.maxRounds`),
        onMissing: onMissing as "fail" | "continue" | undefined,
        assignee: optionalString(record.assignee, `${location}.assignee`),
        timeoutMs:
          record.timeoutMs === undefined
            ? undefined
            : requireInteger(record.timeoutMs, `${location}.timeoutMs`),
        stubOutput:
          record.stubOutput === undefined
            ? undefined
            : asRecord(record.stubOutput, `${location}.stubOutput`)
      };
    }
    case "template":
      return {
        ...base,
        kind: "template",
        template: requireString(record.template, `${location}.template`)
      };
    case "subworkflow":
      return {
        ...base,
        kind: "subworkflow",
        workflowId: requireString(record.workflowId, `${location}.workflowId`),
        workflowVersion: parseAgentVersion(record.workflowVersion, `${location}.workflowVersion`),
        outputs:
          record.outputs === undefined
            ? undefined
            : parseStringRecord(record.outputs, `${location}.outputs`)
      };
    case "parallel":
      return {
        ...base,
        kind: "parallel",
        branches: asArray(record.branches, `${location}.branches`).map((branch, index) =>
          parseNode(branch, `${location}.branches[${index}]`)
        )
      };
    case "condition":
      return {
        ...base,
        kind: "condition",
        when: requireString(record.when, `${location}.when`),
        then: asArray(record.then, `${location}.then`).map((item, index) => parseNode(item, `${location}.then[${index}]`)),
        else:
          record.else === undefined
            ? undefined
            : asArray(record.else, `${location}.else`).map((item, index) => parseNode(item, `${location}.else[${index}]`))
      };
    case "loop":
      return {
        ...base,
        kind: "loop",
        maxIterations: requireInteger(record.maxIterations, `${location}.maxIterations`),
        while: optionalString(record.while, `${location}.while`),
        patience:
          record.patience === undefined
            ? undefined
            : requireInteger(record.patience, `${location}.patience`),
        budget:
          record.budget === undefined
            ? undefined
            : parseLoopBudget(record.budget, `${location}.budget`),
        body: asArray(record.body, `${location}.body`).map((item, index) => parseNode(item, `${location}.body[${index}]`))
      };
    case "verify":
      return {
        ...base,
        kind: "verify",
        verifier: requireString(record.verifier, `${location}.verifier`),
        rubric:
          record.rubric === undefined
            ? undefined
            : asArray(record.rubric, `${location}.rubric`).map((item, index) => requireString(item, `${location}.rubric[${index}]`)),
        threshold: record.threshold === undefined ? undefined : requireNumber(record.threshold, `${location}.threshold`),
        required:
          record.required === undefined
            ? undefined
            : parseStringArray(record.required, `${location}.required`),
        expectedKeywords:
          record.expectedKeywords === undefined
            ? undefined
            : parseStringArray(record.expectedKeywords, `${location}.expectedKeywords`),
        minChars:
          record.minChars === undefined
            ? undefined
            : requireInteger(record.minChars, `${location}.minChars`),
        verifiers:
          record.verifiers === undefined
            ? undefined
            : parseStringArray(record.verifiers, `${location}.verifiers`),
        requireEvidence:
          record.requireEvidence === undefined
            ? undefined
            : requireBoolean(record.requireEvidence, `${location}.requireEvidence`),
        minCitations:
          record.minCitations === undefined
            ? undefined
            : requireInteger(record.minCitations, `${location}.minCitations`),
        requiredSections:
          record.requiredSections === undefined
            ? undefined
            : parseStringArray(record.requiredSections, `${location}.requiredSections`),
        verifierModels:
          record.verifierModels === undefined
            ? undefined
            : parseStringRecord(record.verifierModels, `${location}.verifierModels`),
        evidenceView:
          record.evidenceView === undefined
            ? undefined
            : parseEvidenceView(record.evidenceView, `${location}.evidenceView`),
        checks:
          record.checks === undefined
            ? undefined
            : asArray(record.checks, `${location}.checks`).map((item, index) =>
                parseVerifyCheck(item, `${location}.checks[${index}]`)
              ),
        model: optionalString(record.model, `${location}.model`)
      };
    case "approve":
      return {
        ...base,
        kind: "approve",
        instructions: optionalString(record.instructions, `${location}.instructions`),
        assignee: optionalString(record.assignee, `${location}.assignee`),
        timeoutMs:
          record.timeoutMs === undefined
            ? undefined
            : requireInteger(record.timeoutMs, `${location}.timeoutMs`)
      };
    case "human": {
      const fields =
        record.fields === undefined
          ? undefined
          : asArray(record.fields, `${location}.fields`).map((item, index) =>
              parseHumanField(item, `${location}.fields[${index}]`)
            );
      return {
        ...base,
        kind: "human",
        prompt: requireString(record.prompt, `${location}.prompt`),
        fields,
        submitLabel: optionalString(record.submitLabel, `${location}.submitLabel`),
        assignee: optionalString(record.assignee, `${location}.assignee`),
        timeoutMs:
          record.timeoutMs === undefined
            ? undefined
            : requireInteger(record.timeoutMs, `${location}.timeoutMs`),
        // 选项卡：选项既是「给用户点的」，也是「选完交给模型的输入」，保存时必须整串留下。
        // 这里放宽成「允许空串」：草稿阶段用户点了「添加选项」还没填，也能正常保存；
        // 空项在运行时由 normalizeChoices 过滤掉。
        options:
          record.options === undefined
            ? undefined
            : asArray(record.options, `${location}.options`).map((item, index) => {
                if (typeof item !== "string") {
                  throw new WorkflowSyntaxError(
                    `${location}.options[${index}]`,
                    "选项应为字符串"
                  );
                }
                return item;
              }),
        optionsFrom: looseText(record.optionsFrom),
        generatePrompt: looseText(record.generatePrompt),
        model: looseText(record.model)
      };
    }
  }
}

/** 输入/输出端口的类型白名单；与 nodeTypes.ts 的 NodePortSpec 保持一致。 */
const PORT_TYPES = new Set([
  "string", "number", "boolean", "object", "array", "file"
]);
const PORT_SOURCES = new Set(["literal", "reference", "variable", "system"]);

function parseInputBindings(value: unknown, location: string): NodeInputBinding[] {
  return asArray(value, location).map((item, index) => {
    const at = `${location}[${index}]`;
    const record = asRecord(item, at);
    const type = requireString(record.type, `${at}.type`);
    if (!PORT_TYPES.has(type)) {
      throw new WorkflowSyntaxError(`${at}.type`, `端口类型只支持 ${[...PORT_TYPES].join(" / ")}`);
    }
    if (record.source !== undefined) {
      const source = requireString(record.source, `${at}.source`);
      if (!PORT_SOURCES.has(source)) {
        throw new WorkflowSyntaxError(`${at}.source`, `取值来源只支持 ${[...PORT_SOURCES].join(" / ")}`);
      }
    }
    const defaultValue = record.defaultValue;
    if (
      defaultValue !== undefined &&
      typeof defaultValue !== "string" &&
      typeof defaultValue !== "number" &&
      typeof defaultValue !== "boolean"
    ) {
      throw new WorkflowSyntaxError(`${at}.defaultValue`, "默认值只能是字符串、数字或布尔值");
    }
    return {
      name: requireString(record.name, `${at}.name`),
      type: type as NodePortType,
      required: record.required === undefined ? undefined : requireBoolean(record.required, `${at}.required`),
      description: optionalString(record.description, `${at}.description`),
      defaultValue,
      source: optionalString(record.source, `${at}.source`) as
        | "literal"
        | "reference"
        | "variable"
        | "system"
        | undefined,
      value: record.value
    };
  });
}

function parseOutputProperties(value: unknown, location: string): NodeOutputProperty[] {
  return asArray(value, location).map((item, index) => {
    const at = `${location}[${index}]`;
    const record = asRecord(item, at);
    const type = requireString(record.type, `${at}.type`);
    if (!PORT_TYPES.has(type)) {
      throw new WorkflowSyntaxError(`${at}.type`, `端口类型只支持 ${[...PORT_TYPES].join(" / ")}`);
    }
    return {
      name: requireString(record.name, `${at}.name`),
      type: type as NodePortType,
      required: record.required === undefined ? undefined : requireBoolean(record.required, `${at}.required`),
      description: optionalString(record.description, `${at}.description`),
      properties:
        record.properties === undefined
          ? undefined
          : parseOutputProperties(record.properties, `${at}.properties`)
    };
  });
}

const HUMAN_FIELD_TYPES = new Set(["text", "textarea", "number", "boolean", "select"]);

function parseErrorPolicy(value: unknown, location: string): NodeErrorPolicy {
  const record = asRecord(value, location);
  const strategy =
    record.strategy === undefined ? undefined : requireString(record.strategy, `${location}.strategy`);
  if (strategy !== undefined && !ERROR_STRATEGIES.has(strategy)) {
    throw new WorkflowSyntaxError(
      `${location}.strategy`,
      `异常处理方式只支持 ${[...ERROR_STRATEGIES].join(" / ")}`
    );
  }
  return {
    enabled: parseOptionalBoolean(record.enabled, `${location}.enabled`),
    strategy: strategy as NodeErrorPolicy["strategy"],
    retries:
      record.retries === undefined ? undefined : requireInteger(record.retries, `${location}.retries`),
    retryIntervalMs:
      record.retryIntervalMs === undefined
        ? undefined
        : requireInteger(record.retryIntervalMs, `${location}.retryIntervalMs`),
    timeoutMs:
      record.timeoutMs === undefined
        ? undefined
        : requireInteger(record.timeoutMs, `${location}.timeoutMs`),
    fallbackValue: record.fallbackValue
  };
}

function parseHumanField(value: unknown, location: string) {
  const record = asRecord(value, location);
  const type = optionalString(record.type, `${location}.type`) ?? "text";
  if (!HUMAN_FIELD_TYPES.has(type)) {
    throw new WorkflowSyntaxError(
      `${location}.type`,
      `未知的输入类型 "${type}"，仅支持 ${[...HUMAN_FIELD_TYPES].join(" / ")}`
    );
  }
  const options =
    record.options === undefined
      ? undefined
      : asArray(record.options, `${location}.options`).map((item, index) =>
          requireString(item, `${location}.options[${index}]`)
        );
  if (type === "select" && (!options || options.length === 0)) {
    throw new WorkflowSyntaxError(`${location}.options`, "select 字段至少需要一个选项");
  }
  const defaultValue = record.defaultValue;
  if (
    defaultValue !== undefined &&
    typeof defaultValue !== "string" &&
    typeof defaultValue !== "number" &&
    typeof defaultValue !== "boolean"
  ) {
    throw new WorkflowSyntaxError(`${location}.defaultValue`, "默认值只能是字符串、数字或布尔值");
  }
  return {
    key: requireString(record.key, `${location}.key`),
    label: requireString(record.label, `${location}.label`),
    type: type as "text" | "textarea" | "number" | "boolean" | "select",
    required:
      record.required === undefined ? undefined : requireBoolean(record.required, `${location}.required`),
    options,
    defaultValue,
    placeholder: optionalString(record.placeholder, `${location}.placeholder`),
    description: optionalString(record.description, `${location}.description`)
  };
}

/** 参数提取的参数定义；名字必须能当下游引用，所以按节点 id 的规则校验。 */
function parseExtractParam(value: unknown, location: string) {
  const record = asRecord(value, location);
  const name = requireString(record.name, `${location}.name`).trim();
  if (name === "") {
    throw new WorkflowSyntaxError(`${location}.name`, "参数名不能为空");
  }
  const type = optionalString(record.type, `${location}.type`);
  if (type !== undefined && !EXTRACT_PARAM_TYPES.has(type)) {
    throw new WorkflowSyntaxError(
      `${location}.type`,
      `参数类型只支持 ${[...EXTRACT_PARAM_TYPES].join(" / ")}`
    );
  }
  const defaultValue = record.defaultValue;
  if (
    defaultValue !== undefined &&
    typeof defaultValue !== "string" &&
    typeof defaultValue !== "number" &&
    typeof defaultValue !== "boolean"
  ) {
    throw new WorkflowSyntaxError(`${location}.defaultValue`, "默认值只能是字符串、数字或布尔值");
  }
  return {
    name,
    label: optionalString(record.label, `${location}.label`),
    description: optionalString(record.description, `${location}.description`),
    type: type as "string" | "number" | "boolean" | undefined,
    // 没说就是必填：参数提取的价值就在「缺了会拦住」，默认选填等于默认不生效。
    required:
      record.required === undefined ? undefined : requireBoolean(record.required, `${location}.required`),
    question: optionalString(record.question, `${location}.question`),
    defaultValue:
      defaultValue === undefined ? undefined : String(defaultValue)
  };
}

function parseStringArray(value: unknown, location: string): string[] {
  return asArray(value, location).map((item, index) => requireString(item, `${location}[${index}]`));
}

function parseVerifyCheck(value: unknown, location: string): VerifyCheck {
  const record = asRecord(value, location);
  const type = requireString(record.type, `${location}.type`);
  if (!VERIFY_CHECK_TYPES.has(type as VerifyCheck["type"])) {
    throw new WorkflowSyntaxError(
      `${location}.type`,
      `未知的验证检查类型 "${type}"，仅支持 ${[...VERIFY_CHECK_TYPES].join(" / ")}`
    );
  }
  return {
    type: type as VerifyCheck["type"],
    tolerance:
      record.tolerance === undefined ? undefined : requireNumber(record.tolerance, `${location}.tolerance`),
    anchors:
      record.anchors === undefined ? undefined : parseStringArray(record.anchors, `${location}.anchors`)
  };
}

function parseStringRecord(value: unknown, location: string): Record<string, string> {
  const record = asRecord(value, location);
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, requireString(item, `${location}.${key}`)])
  );
}

function parseEvidenceView(
  value: unknown,
  location: string
): "pool" | "cited" | "split" | undefined {
  if (value === undefined) {
    return undefined;
  }
  const view = requireString(value, location);
  if (!VERIFY_EVIDENCE_VIEWS.has(view)) {
    throw new WorkflowSyntaxError(
      location,
      `证据视图只支持 ${[...VERIFY_EVIDENCE_VIEWS].join(" / ")}`
    );
  }
  return view as "pool" | "cited" | "split";
}

function parseLoopBudget(value: unknown, location: string) {
  const record = asRecord(value, location);
  return {
    maxDurationMs:
      record.maxDurationMs === undefined
        ? undefined
        : requireInteger(record.maxDurationMs, `${location}.maxDurationMs`),
    maxTokens:
      record.maxTokens === undefined
        ? undefined
        : requireInteger(record.maxTokens, `${location}.maxTokens`)
  };
}

const LOOP_ROLES = new Set(["diagnose", "revise"]);

function parseLoopRole(value: unknown, location: string): "diagnose" | "revise" | undefined {
  if (value === undefined) {
    return undefined;
  }
  const role = requireString(value, location);
  if (!LOOP_ROLES.has(role)) {
    throw new WorkflowSyntaxError(location, `循环角色只支持 ${[...LOOP_ROLES].join(" / ")}`);
  }
  return role as "diagnose" | "revise";
}

const OUTPUT_FORMATS = new Set(["text", "json"]);

function parseOptionalBoolean(value: unknown, location: string): boolean | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  // 属性面板的 select 控件输出字符串，这里统一归一化，避免保存后无法再次编译。
  if (value === "true" || value === "false") {
    return value === "true";
  }
  throw new WorkflowSyntaxError(location, "必须是布尔值");
}

function parseOutputFormat(value: unknown, location: string): "text" | "json" | undefined {
  if (value === undefined) {
    return undefined;
  }
  const format = requireString(value, location);
  if (!OUTPUT_FORMATS.has(format)) {
    throw new WorkflowSyntaxError(location, `输出格式只支持 ${[...OUTPUT_FORMATS].join(" / ")}`);
  }
  return format as "text" | "json";
}

function parseOutputContract(value: unknown, location: string) {
  const record = asRecord(value, location);
  const required =
    record.required === undefined
      ? undefined
      : parseStringArray(record.required, `${location}.required`);
  let enums: Record<string, string[]> | undefined;
  if (record.enums !== undefined) {
    const rawEnums = asRecord(record.enums, `${location}.enums`);
    enums = Object.fromEntries(
      Object.entries(rawEnums).map(([key, item]) => [
        key,
        parseStringArray(item, `${location}.enums.${key}`)
      ])
    );
  }
  return { required, enums };
}

function parseAgentVersion(value: unknown, location: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const version = requireInteger(value, location);
  if (version < 1) {
    throw new WorkflowSyntaxError(location, "应为正整数");
  }
  return version;
}

function parseKnowledgeBaseIds(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const ids = asArray(value, "knowledgeBaseIds").map((item, index) =>
    requireString(item, `knowledgeBaseIds[${index}]`)
  );
  return [...new Set(ids)];
}

function parseVariable(value: unknown, location: string): WorkflowVariable {
  const record = asRecord(value, location);
  const type = requireString(record.type, `${location}.type`);
  if (!VARIABLE_TYPES.has(type as WorkflowVariableType)) {
    throw new WorkflowSyntaxError(`${location}.type`, `不支持的输入类型 "${type}"`);
  }
  // 默认值允许空串（元器原版常用 "" 表示无默认），所以不能走 optionalString。
  const defaultValue = record.defaultValue;
  if (
    defaultValue !== undefined &&
    typeof defaultValue !== "string" &&
    typeof defaultValue !== "number" &&
    typeof defaultValue !== "boolean"
  ) {
    throw new WorkflowSyntaxError(`${location}.defaultValue`, "默认值只能是字符串、数字或布尔值");
  }
  return {
    name: requireString(record.name, `${location}.name`),
    type: type as WorkflowVariableType,
    required: record.required === undefined ? undefined : requireBoolean(record.required, `${location}.required`),
    description: optionalString(record.description, `${location}.description`),
    ...(defaultValue === undefined ? {} : { defaultValue })
  };
}

function parseEdge(value: unknown, location: string): WorkflowEdge {
  const record = asRecord(value, location);
  return {
    from: requireString(record.from, `${location}.from`),
    to: requireString(record.to, `${location}.to`),
    label: optionalString(record.label, `${location}.label`),
    when: optionalString(record.when, `${location}.when`),
    // 选项卡的选项端口；老数据没有这个字段，按单端口处理。
    fromPort: optionalString(record.fromPort, `${location}.fromPort`)
  };
}

function asRecord(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkflowSyntaxError(location, "应为对象");
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, location: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new WorkflowSyntaxError(location, "应为数组");
  }
  return value;
}

function requireString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WorkflowSyntaxError(location, "应为非空字符串");
  }
  return value.trim();
}

function optionalString(value: unknown, location: string): string | undefined {
  return value === undefined ? undefined : requireString(value, location);
}

/** 清空即等于没填：面板里把输入框删干净会存空串，不该让保存失败。 */
function looseText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireInteger(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new WorkflowSyntaxError(location, "应为整数");
  }
  return value;
}

function requireNumber(value: unknown, location: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new WorkflowSyntaxError(location, "应为数字");
  }
  return value;
}

function requireBoolean(value: unknown, location: string): boolean {
  if (typeof value !== "boolean") {
    throw new WorkflowSyntaxError(location, "应为布尔值");
  }
  return value;
}
