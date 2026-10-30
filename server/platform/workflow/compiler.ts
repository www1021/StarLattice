import {
  type CompiledBlock,
  type CompiledExpression,
  type CompiledPlan,
  type CompiledStatement,
  type CompiledStep,
  type CompileIssue,
  type ComparisonOperator,
  type LeafNode,
  type WorkflowDefinition,
  type WorkflowNode
} from "../types.js";

const MAX_DEPTH = 4;
const MAX_ROOT_NODES = 64;
const MAX_LOOP_ITERATIONS = 20;
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const REF_PATTERN = /\$\{([^}\s]+)\}/g;
const EXPRESSION_PATTERN = /^\s*\$\{([^}\s]+)\}\s*(?:(<=|>=|==|!=|<|>)\s*(.+?))?\s*$/;

export class WorkflowCompileError extends Error {
  constructor(readonly issues: CompileIssue[]) {
    super(`DSL 校验未通过（${issues.length} 项）：${issues[0]?.message ?? "未知错误"}`);
    this.name = "WorkflowCompileError";
  }
}

export function compileWorkflow(workflow: WorkflowDefinition): CompiledPlan {
  return new Compiler(workflow).compile();
}

class Compiler {
  private readonly issues: CompileIssue[] = [];
  private readonly nodesById = new Map<string, WorkflowNode>();
  private readonly nodePaths = new Map<string, string>();
  private readonly whenExpressions = new Map<string, CompiledExpression>();
  private readonly whileExpressions = new Map<string, CompiledExpression>();
  private readonly declaredInputs: Set<string>;
  private readonly steps: CompiledStep[] = [];
  private maxDepth = 0;

  constructor(private readonly workflow: WorkflowDefinition) {
    this.declaredInputs = new Set(workflow.inputs.map((variable) => variable.name));
  }

  compile(): CompiledPlan {
    this.validateHeader();
    this.collect(this.workflow.nodes, "", 1);
    const order = this.topologicalOrder();
    if (this.issues.length) {
      throw new WorkflowCompileError(this.issues);
    }
    const program = this.expandRoot(order);
    this.validateReferences(program);
    if (this.issues.length) {
      throw new WorkflowCompileError(this.issues);
    }
    return {
      workflow: this.workflow,
      program,
      steps: this.steps,
      order,
      stats: {
        rootNodes: this.workflow.nodes.length,
        stepCount: this.steps.length,
        maxDepth: this.maxDepth
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

      switch (node.kind) {
        case "agent":
        case "tool":
          break;
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
          this.collect(node.body, location, depth + 1);
          break;
        }
        case "verify":
          if (node.threshold !== undefined && (node.threshold < 0 || node.threshold > 1)) {
            this.error("invalid-threshold", location, "verify.threshold 必须在 0 到 1 之间");
          }
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
    return order.map((id) => this.expandStatement(this.nodesById.get(id)!, "", 1));
  }

  private expandBlock(nodes: WorkflowNode[], parentPath: string, depth: number): CompiledBlock {
    return nodes.map((node) => this.expandStatement(node, parentPath, depth));
  }

  private expandStatement(node: WorkflowNode, parentPath: string, depth: number): CompiledStatement {
    const location = parentPath ? `${parentPath}/${node.id}` : node.id;

    if (node.kind === "agent" || node.kind === "tool" || node.kind === "verify") {
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
      body: this.expandBlock(node.body, location, depth + 1)
    };
  }

  /** 按执行顺序模拟作用域：并行分支互不可见，条件分支合并可见，循环体输出回写外层。 */
  private validateReferences(program: CompiledBlock) {
    this.validateBlock(program, new Set<string>());
  }

  private validateBlock(block: CompiledBlock, environment: Set<string>) {
    for (const statement of block) {
      if (statement.type === "step") {
        for (const ref of collectNodeRefs(statement.step.node)) {
          this.checkRef(ref, environment, statement.step.path);
        }
        environment.add(statement.step.nodeId);
        continue;
      }

      if (statement.type === "parallel") {
        const branchEnvironments = statement.branches.map((branch) => {
          const branchEnvironment = new Set(environment);
          this.validateBlock(branch, branchEnvironment);
          return branchEnvironment;
        });
        branchEnvironments.forEach((branchEnvironment) => branchEnvironment.forEach((id) => environment.add(id)));
        continue;
      }

      if (statement.type === "condition") {
        this.checkRef(statement.when.ref, environment, statement.path);
        const thenEnvironment = new Set(environment);
        this.validateBlock(statement.then, thenEnvironment);
        const elseEnvironment = new Set(environment);
        this.validateBlock(statement.otherwise, elseEnvironment);
        thenEnvironment.forEach((id) => environment.add(id));
        elseEnvironment.forEach((id) => environment.add(id));
        continue;
      }

      const bodyEnvironment = new Set(environment);
      this.validateBlock(statement.body, bodyEnvironment);
      if (statement.while) {
        this.checkRef(statement.while.ref, bodyEnvironment, statement.path);
      }
      bodyEnvironment.forEach((id) => environment.add(id));
    }
  }

  private checkRef(ref: string, environment: Set<string>, location: string) {
    const [head, ...rest] = ref.split(".");
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

  private error(code: string, path: string, message: string) {
    this.issues.push({ code, path, message });
  }
}

function collectNodeRefs(node: LeafNode): string[] {
  const values: unknown[] = [node.inputs];
  if (node.kind === "tool") {
    values.push(node.args);
  }
  if (node.kind === "agent") {
    values.push(node.prompt);
  }
  const refs: string[] = [];
  values.forEach((value) => gatherRefs(value, refs));
  return refs;
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
