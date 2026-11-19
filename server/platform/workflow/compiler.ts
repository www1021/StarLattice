import {
  type CompiledBlock,
  type CompiledEdge,
  type CompiledExpression,
  type CompiledGraph,
  type CompiledPlan,
  type CompiledStatement,
  type CompiledStep,
  type CompileIssue,
  type ComparisonOperator,
  type LeafNode,
  type NodeErrorPolicy,
  type NodeOutputProperty,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode
} from "../types.js";

// 容器嵌套上限。子流程展开时会带上父流的层级（baseDepth: depth + 1），
// 顶层总流再挂一层子流后，子流内部原有的「循环 → 条件 → 循环」会多占一层。
// 总流（1）→ 六线子流（2）→ 模式/意图闸门（3）→ 质量门禁（4）→ 改题循环（5）→ 循环体（6）
// 是真实存在的结构，留到 8 才能容纳两层子流嵌套；再深仍有 MAX_SUBWORKFLOW_DEPTH 兜底。
const MAX_DEPTH = 8;
const MAX_SUBWORKFLOW_DEPTH = 5;
const MAX_ROOT_NODES = 64;
const MAX_LOOP_ITERATIONS = 20;
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const REF_PATTERN = /\$\{([^}\s]+)\}/g;
const EXPRESSION_PATTERN = /^\s*\$\{([^}\s]+)\}\s*(?:(<=|>=|==|!=|<|>)\s*(.+?))?\s*$/;
/** loop 是保留作用域名，指向进入本轮前的循环状态，不作为节点 id 解析。 */
const LOOP_SCOPE_KEYS = new Set(["artifact", "issues", "score", "iteration", "retrievalQuery"]);
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export type WorkflowResolver = (id: string, version?: number) => WorkflowDefinition | undefined;

export type CompileOptions = {
  /** 解析被引用的子工作流；未提供时 subworkflow 节点会报 unknown-subworkflow。 */
  resolveWorkflow?: WorkflowResolver;
};

type InternalCompileOptions = CompileOptions & {
  pathPrefix?: string;
  baseDepth?: number;
  workflowStack?: string[];
};

export class WorkflowCompileError extends Error {
  constructor(readonly issues: CompileIssue[]) {
    super(`DSL 校验未通过（${issues.length} 项）：${issues[0]?.message ?? "未知错误"}`);
    this.name = "WorkflowCompileError";
  }
}

export function compileWorkflow(workflow: WorkflowDefinition, options: CompileOptions = {}): CompiledPlan {
  return new Compiler(workflow, options).compile();
}

class Compiler {
  private readonly issues: CompileIssue[] = [];
  private readonly nodesById = new Map<string, WorkflowNode>();
  private readonly nodePaths = new Map<string, string>();
  private readonly whenExpressions = new Map<string, CompiledExpression>();
  private readonly whileExpressions = new Map<string, CompiledExpression>();
  private readonly declaredInputs: Set<string>;
  private readonly steps: CompiledStep[] = [];
  private readonly resolveWorkflow?: WorkflowResolver;
  private readonly pathPrefix: string;
  private readonly baseDepth: number;
  /** 当前编译链上的工作流 id@version，用于拒绝直接/间接循环引用。 */
  private readonly workflowStack: string[];
  private maxDepth = 0;
  private subWorkflowCount = 0;

  constructor(private readonly workflow: WorkflowDefinition, options: InternalCompileOptions = {}) {
    this.declaredInputs = new Set(workflow.inputs.map((variable) => variable.name));
    this.resolveWorkflow = options.resolveWorkflow;
    this.pathPrefix = options.pathPrefix ?? "";
    this.baseDepth = options.baseDepth ?? 1;
    this.workflowStack = options.workflowStack ?? [workflowKey(workflow)];
  }

  compile(): CompiledPlan {
    const plan = this.compilePlan();
    if (this.issues.length) {
      throw new WorkflowCompileError(this.issues);
    }
    return plan;
  }

  /** 子流程递归编译使用：返回计划并把问题留在 this.issues，由父编译器统一抛出。 */
  private compilePlan(): CompiledPlan {
    this.validateHeader();
    this.collect(this.workflow.nodes, this.pathPrefix, this.baseDepth);
    this.validateAnchors();
    const order = this.topologicalOrder();
    const graph = this.issues.length ? emptyGraph() : this.buildGraph(order);
    const program = this.issues.length ? [] : this.expandRoot(order);
    if (this.issues.length === 0) {
      this.validateReferences(program);
    }
    return {
      workflow: this.workflow,
      program,
      graph,
      steps: this.steps,
      order,
      stats: {
        rootNodes: this.workflow.nodes.length,
        stepCount: this.steps.length,
        maxDepth: this.maxDepth,
        subWorkflows: this.subWorkflowCount
      }
    };
  }

  private validateHeader() {
    if (this.workflow.version < 1) {
      this.error("invalid-version", "version", "version 必须大于等于 1");
    }
    if (this.workflow.nodes.length === 0) {
      this.error("empty-workflow", "nodes", "工作流至少需要一个节点");
    }
    if (this.workflow.nodes.length > MAX_ROOT_NODES) {
      this.error("too-many-nodes", "nodes", `顶层节点不能超过 ${MAX_ROOT_NODES} 个`);
    }
    if (this.workflow.schedulerMode !== undefined && this.workflow.schedulerMode !== "planner" && this.workflow.schedulerMode !== "static") {
      this.error("invalid-scheduler-mode", "schedulerMode", "schedulerMode 只能是 planner 或 static");
    }
    const seen = new Set<string>();
    this.workflow.inputs.forEach((variable, index) => {
      if (!ID_PATTERN.test(variable.name)) {
        this.error("invalid-input-name", `inputs[${index}].name`, `输入名 "${variable.name}" 只能包含字母、数字、下划线和短横线`);
      }
      if (seen.has(variable.name)) {
        this.error("duplicate-input", `inputs[${index}]`, `输入 "${variable.name}" 重复声明`);
      }
      seen.add(variable.name);
    });
  }

  /** 顶层只允许一个开始/结束节点；它们不参与容器内部执行。 */
  private validateAnchors() {
    const starts = this.workflow.nodes.filter((node) => node.kind === "start");
    const ends = this.workflow.nodes.filter((node) => node.kind === "end");
    if (starts.length > 1) {
      this.error("duplicate-start", starts[1].id, "每个工作流只允许一个开始节点");
    }
    if (ends.length > 1) {
      this.error("duplicate-end", ends[1].id, "每个工作流只允许一个结束节点");
    }
  }

  private collect(nodes: WorkflowNode[], parentPath: string, depth: number) {
    if (depth > MAX_DEPTH) {
      this.error("max-depth", parentPath || "nodes", `嵌套层级超过 ${MAX_DEPTH} 层`);
      return;
    }
    this.maxDepth = Math.max(this.maxDepth, depth);
    for (const node of nodes) {
      const location = parentPath ? `${parentPath}/${node.id}` : node.id;
      if (!ID_PATTERN.test(node.id)) {
        this.error("invalid-node-id", location, `节点 id "${node.id}" 只能包含字母、数字、下划线和短横线`);
      }
      if (this.nodesById.has(node.id)) {
        this.error("duplicate-node-id", location, `节点 id "${node.id}" 重复；全流程 id 必须唯一`);
      } else {
        this.nodesById.set(node.id, node);
        this.nodePaths.set(node.id, location);
      }

      // 参数表是编辑器写回的声明式结构：这里只做结构性校验，
      // 必填缺失交给 diagnostics 以 warning 提示，避免草稿无法保存。
      const bindingNames = new Set<string>();
      (node.inputBindings ?? []).forEach((binding, index) => {
        if (!ID_PATTERN.test(binding.name)) {
          this.error("invalid-port-name", `${location}.inputBindings[${index}]`, `输入参数名 "${binding.name}" 只能包含字母、数字、下划线和短横线`);
        }
        if (bindingNames.has(binding.name)) {
          this.error("duplicate-port-name", `${location}.inputBindings[${index}]`, `输入参数 "${binding.name}" 重复声明`);
        }
        bindingNames.add(binding.name);
      });
      this.validateOutputSchema(node.outputSchema ?? [], `${location}.outputSchema`);
      this.validateErrorPolicy(node.errorPolicy, `${location}.errorPolicy`);

      switch (node.kind) {
        case "start":
        case "end":
          if (depth > this.baseDepth) {
            this.error("anchor-in-container", location, "开始 / 结束节点只能放在工作流顶层，不能嵌套在容器里");
          }
          break;
        case "agent": {
          const capabilities = node.capabilities ?? [];
          if (capabilities.length > 12) {
            this.error("invalid-agent-capabilities", `${location}.capabilities`, "agent.capabilities 最多 12 项");
          }
          for (const [index, capability] of capabilities.entries()) {
            if (capability.trim() === "") {
              this.error(
                "invalid-agent-capabilities",
                `${location}.capabilities[${index}]`,
                "能力标签不能为空"
              );
            }
          }
          break;
        }
        case "tool":
        case "template":
          break;
        case "knowledge":
          if (
            node.topK !== undefined &&
            (!Number.isInteger(node.topK) || node.topK < 1 || node.topK > 20)
          ) {
            this.error("invalid-knowledge-top-k", location, "knowledge.topK 必须在 1 到 20 之间");
          }
          for (const [index, id] of (node.knowledgeBaseIds ?? []).entries()) {
            if (id.trim() === "") {
              this.error("invalid-knowledge-base", `${location}.knowledgeBaseIds[${index}]`, "知识库 ID 不能为空");
            }
          }
          break;
        case "http": {
          if (!HTTP_METHODS.has(node.method)) {
            this.error("invalid-http-method", location, `HTTP 方法不支持 "${node.method}"`);
          }
          let url: URL | undefined;
          try {
            url = new URL(node.url);
          } catch {
            this.error("invalid-http-url", `${location}.url`, "HTTP 节点地址不是合法 URL");
          }
          if (url && url.protocol !== "http:" && url.protocol !== "https:") {
            this.error("invalid-http-url", `${location}.url`, "HTTP 节点只支持 http / https 地址");
          }
          if (
            node.timeoutMs !== undefined &&
            (!Number.isInteger(node.timeoutMs) || node.timeoutMs < 1000 || node.timeoutMs > 120_000)
          ) {
            this.error("invalid-http-timeout", location, "http.timeoutMs 必须在 1000 到 120000 之间");
          }
          break;
        }
        case "clarify": {
          if (
            node.maxQuestions !== undefined &&
            (!Number.isInteger(node.maxQuestions) || node.maxQuestions < 1 || node.maxQuestions > 3)
          ) {
            this.error("invalid-clarify-questions", location, "clarify.maxQuestions 必须在 1 到 3 之间");
          }
          if (
            node.timeoutMs !== undefined &&
            (!Number.isInteger(node.timeoutMs) || node.timeoutMs < 1000 || node.timeoutMs > 86_400_000)
          ) {
            this.error("invalid-clarify-timeout", location, "clarify.timeoutMs 必须在 1000 到 86400000 之间");
          }
          break;
        }
        case "extract": {
          // 参数名会变成下游引用字段名，必须和节点 id 同一套规则，否则引用面板里点不出来。
          const names = new Set<string>();
          for (const [index, param] of node.params.entries()) {
            if (!ID_PATTERN.test(param.name)) {
              this.error(
                "invalid-extract-param",
                `${location}.params[${index}].name`,
                `参数名 "${param.name}" 只能包含字母、数字、下划线和短横线`
              );
            }
            if (names.has(param.name)) {
              this.error(
                "duplicate-extract-param",
                `${location}.params[${index}].name`,
                `参数 "${param.name}" 重复定义`
              );
            }
            names.add(param.name);
          }
          if (
            node.maxRounds !== undefined &&
            (!Number.isInteger(node.maxRounds) || node.maxRounds < 1 || node.maxRounds > 5)
          ) {
            this.error("invalid-extract-rounds", `${location}.maxRounds`, "extract.maxRounds 必须在 1 到 5 之间");
          }
          if (
            node.timeoutMs !== undefined &&
            (!Number.isInteger(node.timeoutMs) || node.timeoutMs < 1000 || node.timeoutMs > 86_400_000)
          ) {
            this.error("invalid-extract-timeout", `${location}.timeoutMs`, "extract.timeoutMs 必须在 1000 到 86400000 之间");
          }
          break;
        }
        case "llm":
          if (node.temperature !== undefined && (node.temperature < 0 || node.temperature > 2)) {
            this.error("invalid-llm-temperature", location, "llm.temperature 必须在 0 到 2 之间");
          }          if (node.topP !== undefined && (node.topP < 0 || node.topP > 1)) {
            this.error("invalid-llm-top-p", location, "llm.topP 必须在 0 到 1 之间");
          }
          if (
            node.maxTokens !== undefined &&
            (!Number.isInteger(node.maxTokens) || node.maxTokens < 1 || node.maxTokens > 32768)
          ) {
            this.error("invalid-llm-max-tokens", location, "llm.maxTokens 必须在 1 到 32768 之间");
          }
          break;
        case "subworkflow": {
          if (
            node.workflowVersion !== undefined &&
            (!Number.isInteger(node.workflowVersion) || node.workflowVersion < 1)
          ) {
            this.error("invalid-subworkflow-version", location, "subworkflow.workflowVersion 必须是正整数");
          }
          const outputs = node.outputs ?? {};
          for (const [key, value] of Object.entries(outputs)) {
            if (!ID_PATTERN.test(key)) {
              this.error(
                "invalid-subworkflow-output",
                `${location}.outputs.${key}`,
                `输出名 "${key}" 只能包含字母、数字、下划线和短横线`
              );
            }
            if (typeof value !== "string" || value.trim() === "") {
              this.error(
                "invalid-subworkflow-output",
                `${location}.outputs.${key}`,
                "输出映射值必须是非空引用表达式"
              );
            }
          }
          break;
        }
        case "parallel":
          if (node.branches.length === 0) {
            this.error("empty-parallel", location, "parallel 节点至少需要一个分支");
          }
          this.collect(node.branches, location, depth + 1);
          break;
        case "condition": {
          const expression = this.parseExpression(node.when, `${location}.when`);
          if (expression) {
            this.whenExpressions.set(location, expression);
          }
          if (node.then.length === 0) {
            this.error("empty-condition", location, "condition 节点的 then 分支不能为空");
          }
          this.collect(node.then, location, depth + 1);
          this.collect(node.else ?? [], location, depth + 1);
          break;
        }
        case "loop": {
          if (!Number.isInteger(node.maxIterations) || node.maxIterations < 1 || node.maxIterations > MAX_LOOP_ITERATIONS) {
            this.error("invalid-loop-limit", location, `loop.maxIterations 必须在 1 到 ${MAX_LOOP_ITERATIONS} 之间`);
          }
          if (node.body.length === 0) {
            this.error("empty-loop", location, "loop 节点的 body 不能为空");
          }
          if (node.while) {
            const expression = this.parseExpression(node.while, `${location}.while`);
            if (expression) {
              this.whileExpressions.set(location, expression);
            }
          }
          if (
            node.patience !== undefined &&
            (!Number.isInteger(node.patience) || node.patience < 1 || node.patience > 10)
          ) {
            this.error("invalid-loop-patience", location, "loop.patience 必须在 1 到 10 之间");
          }
          if (node.budget?.maxDurationMs !== undefined) {
            if (
              !Number.isInteger(node.budget.maxDurationMs) ||
              node.budget.maxDurationMs < 0 ||
              node.budget.maxDurationMs > 3_600_000
            ) {
              this.error(
                "invalid-loop-budget",
                location,
                "loop.budget.maxDurationMs 必须在 0 到 3600000 之间（0 表示不限制）"
              );
            }
          }
          if (node.budget?.maxTokens !== undefined) {
            if (
              !Number.isInteger(node.budget.maxTokens) ||
              node.budget.maxTokens < 0 ||
              node.budget.maxTokens > 10_000_000
            ) {
              this.error(
                "invalid-loop-budget",
                location,
                "loop.budget.maxTokens 必须在 0 到 10000000 之间（0 表示不限制）"
              );
            }
          }
          this.collect(node.body, location, depth + 1);
          break;
        }
        case "approve":
          if (
            node.timeoutMs !== undefined &&
            (!Number.isInteger(node.timeoutMs) || node.timeoutMs < 1000 || node.timeoutMs > 86_400_000)
          ) {
            this.error("invalid-approve-timeout", location, "approve.timeoutMs 必须在 1000 到 86400000 之间");
          }
          break;
        case "human": {
          if (node.timeoutMs !== undefined && (!Number.isInteger(node.timeoutMs) || node.timeoutMs < 1000 || node.timeoutMs > 86_400_000)) {
            this.error("invalid-human-timeout", location, "human.timeoutMs 必须在 1000 到 86400000 之间");
          }
          const keys = new Set<string>();
          for (const [index, field] of (node.fields ?? []).entries()) {
            if (keys.has(field.key)) {
              this.error(
                "duplicate-human-field",
                `${location}.fields[${index}].key`,
                `输入字段 key "${field.key}" 重复`
              );
            }
            keys.add(field.key);
            if (!ID_PATTERN.test(field.key)) {
              this.error(
                "invalid-human-field",
                `${location}.fields[${index}].key`,
                `输入字段 key "${field.key}" 只能包含字母、数字、下划线和短横线`
              );
            }
          }
          break;
        }
        case "verify":
          if (node.threshold !== undefined && (node.threshold < 0 || node.threshold > 1)) {
            this.error("invalid-threshold", location, "verify.threshold 必须在 0 到 1 之间");
          }
          if (
            node.minChars !== undefined &&
            (!Number.isInteger(node.minChars) || node.minChars < 0 || node.minChars > 20000)
          ) {
            this.error("invalid-verify-min-chars", location, "verify.minChars 必须在 0 到 20000 之间");
          }
          if (
            node.minCitations !== undefined &&
            (!Number.isInteger(node.minCitations) ||
              node.minCitations < 0 ||
              node.minCitations > 50)
          ) {
            this.error(
              "invalid-verify-min-citations",
              location,
              "verify.minCitations 必须在 0 到 50 之间"
            );
          }
          if (node.requiredSections !== undefined) {
            if (node.requiredSections.length === 0 || node.requiredSections.length > 12) {
              this.error(
                "invalid-verify-sections",
                location,
                "verify.requiredSections 需要 1 到 12 个小节名称"
              );
            } else if (node.requiredSections.some((section) => section.trim() === "")) {
              this.error(
                "invalid-verify-sections",
                location,
                "verify.requiredSections 不能包含空小节名称"
              );
            }
          }
          if (node.verifierModels !== undefined) {
            const entries = Object.entries(node.verifierModels);
            if (entries.length === 0 || entries.length > 8) {
              this.error(
                "invalid-verify-models",
                location,
                "verify.verifierModels 需要 1 到 8 个 Agent id 到模型 id 的映射"
              );
            } else if (entries.some(([id, model]) => id.trim() === "" || model.trim() === "")) {
              this.error(
                "invalid-verify-models",
                location,
                "verify.verifierModels 的 Agent id 与模型 id 都不能为空"
              );
            }
          }
          if (node.verifiers !== undefined && (node.verifiers.length === 0 || node.verifiers.length > 5)) {
            this.error("invalid-verify-verifiers", location, "verify.verifiers 需要 1 到 5 个 Agent id");
          }
          if (node.rubric !== undefined && node.rubric.length > 8) {
            this.error("invalid-verify-rubric", location, "verify.rubric 最多 8 个维度");
          }
          node.checks?.forEach((check, index) => {
            const checkType: string = check.type;
            if (checkType !== "number_match") {
              this.error(
                "unknown-verify-check",
                `${location}.checks[${index}].type`,
                `未知的验证检查类型 "${checkType}"，仅支持 number_match`
              );
            }
            if (check.tolerance !== undefined && (check.tolerance < 0 || check.tolerance > 1)) {
              this.error(
                "invalid-verify-tolerance",
                `${location}.checks[${index}].tolerance`,
                "verify.checks.tolerance 必须在 0 到 1 之间"
              );
            }
            if (check.anchors !== undefined) {
              if (check.anchors.length === 0 || check.anchors.length > 12) {
                this.error(
                  "invalid-verify-anchors",
                  `${location}.checks[${index}].anchors`,
                  "verify.checks.anchors 需要 1 到 12 个指标标签"
                );
              } else if (check.anchors.some((anchor) => anchor.trim() === "")) {
                this.error(
                  "invalid-verify-anchors",
                  `${location}.checks[${index}].anchors`,
                  "verify.checks.anchors 不能包含空标签"
                );
              }
            }
          });
          break;
      }
    }
  }

  private parseExpression(source: string, location: string): CompiledExpression | undefined {
    const match = source.match(EXPRESSION_PATTERN);
    if (!match) {
      this.error(
        "unsupported-expression",
        location,
        `条件表达式只支持 "\${节点或输入.字段} 运算符 值" 形式，当前为 "${source}"`
      );
      return undefined;
    }
    const [, ref, operator, rawValue] = match;
    const expression: CompiledExpression = { source, ref };
    if (operator) {
      expression.operator = operator as ComparisonOperator;
      expression.value = parseLiteral(rawValue);
    }
    return expression;
  }

  private topologicalOrder(): string[] {
    const rootIds = this.workflow.nodes.map((node) => node.id);
    const declarationIndex = new Map(rootIds.map((id, index) => [id, index]));
    const adjacency = new Map<string, string[]>(rootIds.map((id) => [id, []]));
    const indegree = new Map<string, number>(rootIds.map((id) => [id, 0]));
    const seenEdges = new Set<string>();

    this.workflow.edges.forEach((edge, index) => {
      const location = `edges[${index}]`;
      if (!this.nodesById.has(edge.from)) {
        this.error("unknown-edge-node", location, `边引用了不存在的节点 "${edge.from}"`);
        return;
      }
      if (!this.nodesById.has(edge.to)) {
        this.error("unknown-edge-node", location, `边引用了不存在的节点 "${edge.to}"`);
        return;
      }
      if (this.nodesById.get(edge.to)!.kind === "start") {
        this.error("start-has-incoming", location, `开始节点 "${edge.to}" 不能有入边`);
        return;
      }
      if (this.nodesById.get(edge.from)!.kind === "end") {
        this.error("end-has-outgoing", location, `结束节点 "${edge.from}" 不能有出边`);
        return;
      }
      if (!declarationIndex.has(edge.from) || !declarationIndex.has(edge.to)) {
        this.error("nested-edge", location, "边只能连接顶层节点；嵌套节点请写在 parallel/condition/loop 内部");
        return;
      }
      const key = `${edge.from}->${edge.to}`;
      if (seenEdges.has(key)) {
        this.error("duplicate-edge", location, `重复的边 ${key}`);
        return;
      }
      seenEdges.add(key);
      adjacency.get(edge.from)!.push(edge.to);
      indegree.set(edge.to, indegree.get(edge.to)! + 1);
    });

    const byDeclaration = (left: string, right: string) =>
      declarationIndex.get(left)! - declarationIndex.get(right)!;
    const ready = rootIds.filter((id) => indegree.get(id) === 0).sort(byDeclaration);
    const order: string[] = [];

    while (ready.length > 0) {
      const id = ready.shift()!;
      order.push(id);
      for (const next of adjacency.get(id)!) {
        indegree.set(next, indegree.get(next)! - 1);
        if (indegree.get(next) === 0) {
          ready.push(next);
          ready.sort(byDeclaration);
        }
      }
    }

    if (order.length !== rootIds.length) {
      const cycle = this.findCycle(adjacency, rootIds, order);
      this.error("cycle", cycle.join(" -> "), `工作流存在环：${cycle.join(" -> ")}`);
    }
    return order;
  }

  /** 顶层依赖图供执行器做就绪队列调度；嵌套容器仍走原有编译块。 */
  private buildGraph(order: string[]): CompiledGraph {
    const nodeIds = new Set(this.workflow.nodes.map((node) => node.id));
    const indegree = new Map<string, number>(order.map((id) => [id, 0]));
    const edges: CompiledEdge[] = [];

    this.workflow.edges.forEach((edge, index) => {
      if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
        return;
      }
      const location = `edges[${index}].when`;
      const when = edge.when ? this.parseExpression(edge.when, location) : undefined;
      if (when) {
        this.validateEdgeCondition(when, edge, location);
      }
      edges.push({
        from: edge.from,
        to: edge.to,
        label: edge.label,
        when,
        fromPort: edge.fromPort
      });
      indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    });

    return {
      nodes: order,
      edges,
      entry: order.filter((id) => (indegree.get(id) ?? 0) === 0)
    };
  }

  private validateEdgeCondition(
    expression: CompiledExpression,
    edge: WorkflowEdge,
    location: string
  ) {
    const [head, ...rest] = expression.ref.split(".");
    if (head === "input") {
      const name = rest.join(".");
      if (!name) {
        this.error("invalid-input-ref", location, "工作流输入引用应写成 ${input.字段名}");
        return;
      }
      if (!this.declaredInputs.has(name)) {
        this.error("unknown-input", location, `未声明的工作流输入 "${name}"`);
      }
      return;
    }
    if (head === "loop") {
      this.error("loop-ref-outside-loop", location, "边条件不能使用循环作用域 ${loop.*}");
      return;
    }

    const allNodeIds = collectDefinitionIds(this.workflow.nodes);
    if (!allNodeIds.has(head)) {
      this.error("unknown-node-ref", location, `边条件引用了不存在的节点 "${head}"`);
      return;
    }

    // 边条件在 from 完成后求值，因此只能引用上游；引用目标或其下游会在运行期恒为空。
    if (this.downstreamNodeIds(edge.to).has(head)) {
      this.error(
        "reference-order",
        location,
        `边条件不能引用目标节点 "${head}" 或其下游节点的输出`
      );
    }
  }

  private downstreamNodeIds(start: string): Set<string> {
    const adjacency = new Map<string, string[]>();
    for (const edge of this.workflow.edges) {
      adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
    }

    const result = new Set<string>();
    const queue = [start];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (result.has(id)) {
        continue;
      }
      result.add(id);
      const node = this.nodesById.get(id);
      if (node) {
        collectDefinitionIds([node], result);
      }
      for (const next of adjacency.get(id) ?? []) {
        queue.push(next);
      }
    }
    return result;
  }

  private findCycle(adjacency: Map<string, string[]>, rootIds: string[], sorted: string[]): string[] {
    const finished = new Set(sorted);
    const state = new Map<string, "visiting" | "done">();
    const stack: string[] = [];

    const visit = (id: string): string[] | undefined => {
      if (state.get(id) === "done") {
        return undefined;
      }
      if (state.get(id) === "visiting") {
        return [...stack.slice(stack.indexOf(id)), id];
      }
      state.set(id, "visiting");
      stack.push(id);
      for (const next of adjacency.get(id) ?? []) {
        const found = visit(next);
        if (found) {
          return found;
        }
      }
      stack.pop();
      state.set(id, "done");
      return undefined;
    };

    for (const id of rootIds) {
      if (finished.has(id)) {
        continue;
      }
      const found = visit(id);
      if (found) {
        return found;
      }
    }
    return [];
  }

  private expandRoot(order: string[]): CompiledBlock {
    return order.map((id) => this.expandStatement(this.nodesById.get(id)!, this.pathPrefix, this.baseDepth));
  }

  private expandBlock(nodes: WorkflowNode[], parentPath: string, depth: number): CompiledBlock {
    return nodes.map((node) => this.expandStatement(node, parentPath, depth));
  }

  private expandStatement(node: WorkflowNode, parentPath: string, depth: number): CompiledStatement {
    const location = parentPath ? `${parentPath}/${node.id}` : node.id;

    if (node.kind === "subworkflow") {
      return this.expandSubWorkflow(node, location, depth);
    }

    if (
      node.kind === "start" ||
      node.kind === "end" ||
      node.kind === "agent" ||
      node.kind === "llm" ||
      node.kind === "clarify" ||
      node.kind === "extract" ||
      node.kind === "knowledge" ||
      node.kind === "tool" ||
      node.kind === "http" ||
      node.kind === "template" ||
      node.kind === "verify" ||
      node.kind === "approve" ||
      node.kind === "human"
    ) {
      const step: CompiledStep = { path: location, nodeId: node.id, depth, node };
      this.steps.push(step);
      return { type: "step", step };
    }

    if (node.kind === "parallel") {
      return {
        type: "parallel",
        path: location,
        nodeId: node.id,
        title: node.title ?? node.id,
        branches: node.branches.map((branch) => [this.expandStatement(branch, location, depth + 1)])
      };
    }

    if (node.kind === "condition") {
      return {
        type: "condition",
        path: location,
        nodeId: node.id,
        title: node.title ?? node.id,
        when: this.whenExpressions.get(location)!,
        then: this.expandBlock(node.then, location, depth + 1),
        otherwise: this.expandBlock(node.else ?? [], location, depth + 1)
      };
    }

    return {
      type: "loop",
      path: location,
      nodeId: node.id,
      title: node.title ?? node.id,
      maxIterations: node.maxIterations,
      while: this.whileExpressions.get(location),
      patience: node.patience,
      budget: node.budget,
      body: this.expandBlock(node.body, location, depth + 1)
    };
  }

  /**
   * 子流程在编译期递归展开：父计划里保存子程序，运行时仍由同一执行器在独立作用域执行。
   * 递归链与深度在这里拦截，避免运行期才发现循环引用。
   */
  private expandSubWorkflow(
    node: Extract<WorkflowNode, { kind: "subworkflow" }>,
    location: string,
    depth: number
  ): CompiledStatement {
    const base = {
      type: "subworkflow" as const,
      path: location,
      nodeId: node.id,
      title: node.title ?? node.id,
      node
    };
    const definition = this.resolveWorkflow?.(node.workflowId, node.workflowVersion);
    if (!definition) {
      this.error(
        "unknown-subworkflow",
        `${location}.workflowId`,
        node.workflowVersion === undefined
          ? `引用的子工作流 "${node.workflowId}" 不存在或尚未保存`
          : `引用的子工作流 "${node.workflowId}" v${node.workflowVersion} 不存在`
      );
      return { ...base, program: [], definition: undefined };
    }

    const key = workflowKey(definition);
    if (this.workflowStack.includes(key)) {
      this.error(
        "subworkflow-cycle",
        location,
        `子工作流存在循环引用：${[...this.workflowStack, key].join(" -> ")}`
      );
      return { ...base, program: [], definition };
    }
    if (this.workflowStack.length >= MAX_SUBWORKFLOW_DEPTH) {
      this.error(
        "subworkflow-depth",
        location,
        `子工作流嵌套超过 ${MAX_SUBWORKFLOW_DEPTH} 层上限`
      );
      return { ...base, program: [], definition };
    }

    const provided = new Set(Object.keys(node.inputs ?? {}));
    for (const variable of definition.inputs) {
      if (variable.required && !provided.has(variable.name)) {
        this.error(
          "subworkflow-missing-input",
          `${location}.inputs.${variable.name}`,
          `子工作流 "${definition.id}" 的必填输入 "${variable.name}" 未映射`
        );
      }
    }

    const childIds = collectDefinitionIds(definition.nodes);
    const declaredInputs = new Set(definition.inputs.map((variable) => variable.name));
    for (const [name, expression] of Object.entries(node.outputs ?? {})) {
      const refs: string[] = [];
      gatherRefs(expression, refs);
      for (const ref of refs) {
        const [head] = ref.split(".");
        if (head === "input") {
          const inputName = ref.slice("input.".length);
          if (!declaredInputs.has(inputName)) {
            this.error(
              "unknown-subworkflow-output-ref",
              `${location}.outputs.${name}`,
              `输出映射引用了子流程未声明的输入 "${inputName}"`
            );
          }
          continue;
        }
        if (head === "loop" || !childIds.has(head)) {
          this.error(
            "unknown-subworkflow-output-ref",
            `${location}.outputs.${name}`,
            `输出映射只能引用子流程节点或 input.*，当前为 "${head}"`
          );
        }
      }
    }

    const child = new Compiler(definition, {
      resolveWorkflow: this.resolveWorkflow,
      workflowStack: [...this.workflowStack, key],
      pathPrefix: location,
      baseDepth: depth + 1
    });
    const childPlan = child.compilePlan();
    this.issues.push(...child.issues);
    this.steps.push(...childPlan.steps);
    this.maxDepth = Math.max(this.maxDepth, childPlan.stats.maxDepth);
    this.subWorkflowCount += 1;

    return { ...base, program: childPlan.program, definition };
  }

  /** 按执行顺序模拟作用域：并行分支互不可见，条件分支合并可见，循环体输出回写外层。 */
  private validateReferences(program: CompiledBlock) {
    this.validateBlock(program, new Set<string>(), false);
  }

  private validateBlock(block: CompiledBlock, environment: Set<string>, inLoop: boolean) {
    for (const statement of block) {
      if (statement.type === "step") {
        for (const ref of collectNodeRefs(statement.step.node)) {
          this.checkRef(ref, environment, statement.step.path, inLoop, localPortsOf(statement.step.node));
        }
        environment.add(statement.step.nodeId);
        continue;
      }

      if (statement.type === "subworkflow") {
        // 输入映射在父作用域解析；输出映射在子作用域解析，已由 expandSubWorkflow 单独校验。
        for (const ref of collectNodeRefs(statement.node)) {
          this.checkRef(ref, environment, statement.path, inLoop, localPortsOf(statement.node));
        }
        environment.add(statement.nodeId);
        continue;
      }

      if (statement.type === "parallel") {
        const branchEnvironments = statement.branches.map((branch) => {
          const branchEnvironment = new Set(environment);
          this.validateBlock(branch, branchEnvironment, inLoop);
          return branchEnvironment;
        });
        branchEnvironments.forEach((branchEnvironment) => branchEnvironment.forEach((id) => environment.add(id)));
        continue;
      }

      if (statement.type === "condition") {
        this.checkRef(statement.when.ref, environment, statement.path, inLoop);
        const thenEnvironment = new Set(environment);
        this.validateBlock(statement.then, thenEnvironment, inLoop);
        const elseEnvironment = new Set(environment);
        this.validateBlock(statement.otherwise, elseEnvironment, inLoop);
        thenEnvironment.forEach((id) => environment.add(id));
        elseEnvironment.forEach((id) => environment.add(id));
        continue;
      }

      const bodyEnvironment = new Set(environment);
      this.validateBlock(statement.body, bodyEnvironment, true);
      if (statement.while) {
        this.checkRef(statement.while.ref, bodyEnvironment, statement.path, true);
      }
      bodyEnvironment.forEach((id) => environment.add(id));
    }
  }

  private checkRef(
    ref: string,
    environment: Set<string>,
    location: string,
    inLoop: boolean,
    /** 当前节点自己声明的输入变量名：正文里 ${name} 引用的是它们，不是同名的节点。 */
    locals?: Set<string>
  ) {
    const [head, ...rest] = ref.split(".");
    if (locals?.has(head)) {
      return;
    }
    if (head === "input") {
      const name = rest.join(".");
      if (!name) {
        this.error("invalid-input-ref", location, "工作流输入引用应写成 ${input.字段名}");
        return;
      }
      if (!this.declaredInputs.has(name)) {
        this.error("unknown-input", location, `未声明的工作流输入 "${name}"`);
      }
      return;
    }
    if (head === "loop") {
      if (!inLoop) {
        this.error("loop-ref-outside-loop", location, "循环作用域 ${loop.*} 只能在 loop 节点体内使用");
        return;
      }
      if (!rest.length || !LOOP_SCOPE_KEYS.has(rest[0])) {
        this.error(
          "unknown-loop-ref",
          location,
          `循环作用域只支持 ${[...LOOP_SCOPE_KEYS].join("、")}，当前为 "${rest[0] ?? ""}"`
        );
      }
      return;
    }
    if (!this.nodesById.has(head)) {
      this.error("unknown-node-ref", location, `引用了不存在的节点 "${head}"`);
      return;
    }
    if (!environment.has(head)) {
      this.error(
        "reference-order",
        location,
        `节点 "${head}" 的输出在当前步骤尚不可用；请调整依赖顺序，或避免跨并行分支互相引用`
      );
    }
  }

  /** 输出字段树逐层校验命名与重复；层级不设限，靠 UI 控制展开深度。 */
  private validateOutputSchema(properties: NodeOutputProperty[], location: string) {
    const names = new Set<string>();
    properties.forEach((property, index) => {
      const at = `${location}[${index}]`;
      if (!ID_PATTERN.test(property.name)) {
        this.error("invalid-port-name", at, `输出参数名 "${property.name}" 只能包含字母、数字、下划线和短横线`);
      }
      if (names.has(property.name)) {
        this.error("duplicate-port-name", at, `输出参数 "${property.name}" 重复声明`);
      }
      names.add(property.name);
      if (property.properties?.length) {
        this.validateOutputSchema(property.properties, `${at}.properties`);
      }
    });
  }

  /** 异常处理的取值边界；范围外直接报错，避免配成 0 秒超时这类隐性故障。 */
  private validateErrorPolicy(policy: NodeErrorPolicy | undefined, location: string) {
    if (!policy) {
      return;
    }
    if (policy.retries !== undefined && (!Number.isInteger(policy.retries) || policy.retries < 0 || policy.retries > 5)) {
      this.error("invalid-error-policy", `${location}.retries`, "重试次数只能是 0 到 5 的整数");
    }
    if (
      policy.retryIntervalMs !== undefined &&
      (!Number.isInteger(policy.retryIntervalMs) || policy.retryIntervalMs < 0 || policy.retryIntervalMs > 60_000)
    ) {
      this.error("invalid-error-policy", `${location}.retryIntervalMs`, "重试间隔只能是 0 到 60000 毫秒");
    }
    if (
      policy.timeoutMs !== undefined &&
      (!Number.isInteger(policy.timeoutMs) || policy.timeoutMs < 1_000 || policy.timeoutMs > 600_000)
    ) {
      this.error("invalid-error-policy", `${location}.timeoutMs`, "节点超时只能是 1000 到 600000 毫秒");
    }
    if (policy.strategy === "fallback" && policy.fallbackValue === undefined) {
      this.error("invalid-error-policy", `${location}.fallbackValue`, "选择「兜底值」时必须在 fallbackValue 里给出替代产物");
    }
  }

  private error(code: string, path: string, message: string) {
    this.issues.push({ code, path, message });
  }
}

function collectNodeRefs(node: LeafNode): string[] {
  const values: unknown[] = [node.inputs, (node.inputBindings ?? []).map((binding) => binding.value)];
  // 兜底值同属节点产物，里面写的引用也要参与顺序与存在性校验。
  if (node.errorPolicy?.fallbackValue !== undefined) {
    values.push(node.errorPolicy.fallbackValue);
  }
  if (node.kind === "tool") {
    values.push(node.args);
  }
  if (node.kind === "agent") {
    values.push(node.prompt);
  }
  if (node.kind === "llm") {
    values.push(node.prompt, node.system);
  }
  if (node.kind === "clarify") {
    values.push(node.prompt);
  }
  if (node.kind === "extract") {
    // 抽取提示词与追问话术都可能引用上游变量，写错名字要在编译期就报出来。
    values.push(node.prompt, node.askPrompt);
    node.params.forEach((param) => values.push(param.description, param.question));
  }
  if (node.kind === "knowledge") {
    values.push(node.query, node.knowledgeBaseIds);
  }
  if (node.kind === "http") {
    values.push(node.url, node.headers, node.requestBody);
  }
  if (node.kind === "template") {
    values.push(node.template);
  }
  if (node.kind === "human") {
    // 选项卡的生成提示词与动态选项来源同样是引用，写错名字要在编译期就报出来。
    values.push(node.generatePrompt, node.optionsFrom);
  }
  // subworkflow.outputs 在子流程作用域内解析，由 expandSubWorkflow 单独校验。
  const refs: string[] = [];
  values.forEach((value) => gatherRefs(value, refs));
  return refs;
}

function collectDefinitionIds(nodes: WorkflowNode[], ids = new Set<string>()): Set<string> {
  for (const node of nodes) {
    ids.add(node.id);
    if (node.kind === "parallel") {
      collectDefinitionIds(node.branches, ids);
    } else if (node.kind === "condition") {
      collectDefinitionIds(node.then, ids);
      collectDefinitionIds(node.else ?? [], ids);
    } else if (node.kind === "loop") {
      collectDefinitionIds(node.body, ids);
    }
  }
  return ids;
}

function emptyGraph(): CompiledGraph {
  return { nodes: [], edges: [], entry: [] };
}

function workflowKey(workflow: WorkflowDefinition): string {
  return `${workflow.id}@${workflow.version}`;
}

/** 节点「输入变量」表里声明的名字，正文里按名字引用时用它放行。 */
function localPortsOf(node: WorkflowNode): Set<string> {
  const names = new Set(
    (node.inputBindings ?? [])
      .map((binding) => (typeof binding.name === "string" ? binding.name.trim() : ""))
      .filter((name) => name !== "")
  );
  // 选项卡提交时运行时自带 choice（用户选中的那一项），提示词里引用它不需要声明成入参。
  if (node.kind === "human" && ((node.options?.length ?? 0) > 0 || node.optionsFrom?.trim())) {
    names.add("choice");
  }
  return names;
}

function gatherRefs(value: unknown, refs: string[]): string[] {
  if (typeof value === "string") {
    for (const match of value.matchAll(REF_PATTERN)) {
      refs.push(match[1]);
    }
  } else if (Array.isArray(value)) {
    value.forEach((item) => gatherRefs(item, refs));
  } else if (value !== null && typeof value === "object") {
    Object.values(value).forEach((item) => gatherRefs(item, refs));
  }
  return refs;
}

function parseLiteral(raw: string | undefined): string | number | boolean {
  const value = (raw ?? "").trim();
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }
  if (value === "true" || value === "false") {
    return value === "true";
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
