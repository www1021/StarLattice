import type { CompileIssue } from "../types.js";

/**
 * 调试门禁用的静态诊断。
 *
 * 与 compiler.ts 的区别：编译器检查「能不能跑」（环、引用顺序、类型），
 * 这里检查「有没有连好、有没有填全」，面向画布上的人，文案直接可展示。
 * 故意不参与 compileWorkflow，避免影响保存 / 运行 / 既有测试。
 * 输入允许是未解析的 DSL 草稿，因此全部按宽松结构读取。
 */

type DraftRecord = Record<string, unknown>;

type DiagnosticSeverity = "error" | "warning";

export type WorkflowDiagnostic = CompileIssue & {
  /** error 阻断进入调试视图；warning 只提示。 */
  severity: DiagnosticSeverity;
};

/** 与 nodeTypes.ts 的 required 字段保持一致；key -> 中文标签。 */
const REQUIRED_FIELDS: Record<string, { key: string; label: string }[]> = {
  agent: [{ key: "agent", label: "Agent" }],
  tool: [{ key: "tool", label: "工具" }],
  knowledge: [{ key: "query", label: "检索问题" }],
  http: [
    { key: "method", label: "请求方法" },
    { key: "url", label: "请求地址" }
  ],
  llm: [{ key: "prompt", label: "提示词" }],
  template: [{ key: "template", label: "模板内容" }],
  subworkflow: [{ key: "workflowId", label: "子工作流" }],
  condition: [{ key: "when", label: "条件表达式" }],
  human: [{ key: "prompt", label: "提示词" }],
  verify: [{ key: "verifier", label: "验证 Agent" }]
};

const CONTAINER_KEYS = ["branches", "then", "else", "body"] as const;
/** 形如 ${}、${input.}、${ .} 等没写完的引用。 */
const INCOMPLETE_REF = /\$\{\s*(?:input\.)?\s*\}/;

function isRecord(value: unknown): value is DraftRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nodeId(node: DraftRecord): string {
  return text(node.id) || "(未命名节点)";
}

function childNodes(node: DraftRecord): DraftRecord[] {
  const children: DraftRecord[] = [];
  for (const key of CONTAINER_KEYS) {
    const value = node[key];
    if (!Array.isArray(value)) {
      continue;
    }
    // parallel.branches 是「分支数组的数组」，需要多展一层。
    if (key === "branches") {
      for (const branch of value) {
        if (Array.isArray(branch)) {
          for (const item of branch) {
            if (isRecord(item)) {
              children.push(item);
            }
          }
        } else if (isRecord(branch)) {
          children.push(branch);
        }
      }
    } else {
      for (const item of value) {
        if (isRecord(item)) {
          children.push(item);
        }
      }
    }
  }
  return children;
}

/** 收集节点上所有带引用的文本字段，用于查残缺引用与空值。 */
function referenceSources(node: DraftRecord): { field: string; value: unknown }[] {
  const sources: { field: string; value: unknown }[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (
      key === "inputs" ||
      key === "args" ||
      key === "outputs" ||
      key === "headers" ||
      key === "requestBody" ||
      key === "prompt" ||
      key === "system" ||
      key === "template" ||
      key === "query" ||
      key === "url" ||
      key === "when"
    ) {
      sources.push({ field: key, value });
    }
  }
  return sources;
}

function walkValues(value: unknown, visit: (text: string) => void): void {
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      walkValues(item, visit);
    }
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      walkValues(item, visit);
    }
  }
}

/**
 * 对一条 DSL 草稿做调试前诊断。
 * 连接性只检查顶层节点（容器内部由容器自己连接），字段检查递归到所有节点。
 */
export function diagnoseWorkflow(dsl: unknown): WorkflowDiagnostic[] {
  if (!isRecord(dsl)) {
    return [];
  }
  const issues: WorkflowDiagnostic[] = [];
  const push = (code: string, path: string, message: string, severity: DiagnosticSeverity = "error") => {
    issues.push({ code, path, message, severity });
  };

  const rawNodes = asArray(dsl.nodes);
  const rawEdges = asArray(dsl.edges);
  const topNodes = rawNodes.filter(isRecord);
  const ids = new Set(topNodes.map((node) => text(node.id)).filter(Boolean));

  // 1. 连接性：只按顶层节点与顶层边计算，避免容器内部节点被误报。
  const indegree = new Map<string, number>();
  const outdegree = new Map<string, number>();
  for (const id of ids) {
    indegree.set(id, 0);
    outdegree.set(id, 0);
  }
  for (const edge of rawEdges) {
    if (!isRecord(edge)) {
      continue;
    }
    const from = text(edge.from);
    const to = text(edge.to);
    if (ids.has(from)) {
      outdegree.set(from, (outdegree.get(from) ?? 0) + 1);
    }
    if (ids.has(to)) {
      indegree.set(to, (indegree.get(to) ?? 0) + 1);
    }
  }
  const hasStart = topNodes.some((node) => node.kind === "start");
  const hasEnd = topNodes.some((node) => node.kind === "end");
  if (topNodes.length > 1) {
    for (const node of topNodes) {
      const id = text(node.id);
      if (!id) {
        continue;
      }
      const incoming = indegree.get(id) ?? 0;
      const outgoing = outdegree.get(id) ?? 0;
      const path = id;
      if (incoming === 0 && outgoing === 0) {
        push("disconnected-node", path, "该节点未被连接：没有输入连线，也没有输出连线");
      } else if (hasStart && incoming === 0 && node.kind !== "start") {
        push("missing-incoming-edge", path, "该节点未被连接：缺少输入连线，请从开始节点或其他节点连过来");
      } else if (hasEnd && outgoing === 0 && node.kind !== "end") {
        push(
          "missing-outgoing-edge",
          path,
          "该节点没有输出连线，产物不会汇入结束节点",
          "warning"
        );
      }
    }
  }

  // 2. 必填字段与引用：递归所有节点（含容器内部）。
  const declaredInputs = new Set(
    asArray(dsl.inputs)
      .filter(isRecord)
      .map((input) => text(input.name))
      .filter(Boolean)
  );
  const visit = (node: DraftRecord) => {
    const id = nodeId(node);
    const kind = text(node.kind);
    for (const field of REQUIRED_FIELDS[kind] ?? []) {
      if (!text(node[field.key])) {
        push("empty-required-field", id, `该节点的「${field.label}」未填写`);
      }
    }
    for (const { field, value } of referenceSources(node)) {
      if (isRecord(value)) {
        for (const [key, item] of Object.entries(value)) {
          if (typeof item === "string" && item.trim() === "") {
            push("empty-input-ref", id, `引用参数未填写：${field}.${key} 是空的`);
          }
        }
      }
      walkValues(value, (source) => {
        if (INCOMPLETE_REF.test(source)) {
          push("incomplete-ref", id, `引用参数未填写：${field} 里有未写完的 \${...} 引用`);
        }
        for (const match of source.matchAll(/\$\{input\.([A-Za-z0-9_-]+)\}/g)) {
          if (!declaredInputs.has(match[1])) {
            push(
              "unknown-input-ref",
              id,
              `引用参数未填写：\${input.${match[1]}} 对应的输入没有在工作流输入定义里声明`
            );
          }
        }
      });
    }
    if (node.outputFormat === "json" && !isRecord(node.stubOutput)) {
      push(
        "missing-stub-output",
        id,
        "该节点声明 JSON 输出但缺少 stubOutput 夹具，stub 模式下会运行失败",
        "warning"
      );
    }
    for (const child of childNodes(node)) {
      visit(child);
    }
  };
  for (const node of topNodes) {
    visit(node);
  }

  // 同一节点同一规则只报一次，避免长文本里重复引用刷屏。
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.code}|${issue.path}|${issue.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function hasBlockingIssue(issues: WorkflowDiagnostic[]): boolean {
  return issues.some((issue) => issue.severity === "error");
}
