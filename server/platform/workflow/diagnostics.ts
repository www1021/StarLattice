import type { CompileIssue } from "../types.js";
import { CHOICE_OTHER_PORT, choiceValueOfCondition, inferChoicePorts } from "./choicePorts.js";

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
  human: [{ key: "prompt", label: "引导语" }],
  verify: [{ key: "verifier", label: "验证 Agent" }]
};

const CONTAINER_KEYS = ["branches", "then", "else", "body"] as const;
/** 形如 ${}、${input.}、${ .} 等没写完的引用。 */
const INCOMPLETE_REF = /\$\{\s*(?:input\.)?\s*\}/;
/** 平台内置作用域，不是节点 ID：Self-Loop 的 ${loop.issues}、运行输入 ${input.x} 等。 */
const RESERVED_REF_HEADS = new Set(["input", "loop", "system", "state", "env", "run"]);

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
      key === "when" ||
      key === "generatePrompt" ||
      key === "optionsFrom" ||
      key === "inputBindings"
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
  // 容器内部节点也可以被引用，检查引用目标时要把它们算进去。
  const allIds = new Set(ids);
  const collectIds = (node: DraftRecord) => {
    const id = text(node.id);
    if (id) {
      allIds.add(id);
    }
    for (const child of childNodes(node)) {
      collectIds(child);
    }
  };
  for (const node of topNodes) {
    collectIds(node);
  }

  // 1. 连接性：只按顶层节点与顶层边计算，避免容器内部节点被误报。
  const indegree = new Map<string, number>();
  const outdegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const id of ids) {
    indegree.set(id, 0);
    outdegree.set(id, 0);
    outgoing.set(id, []);
    incoming.set(id, []);
  }
  for (const edge of rawEdges) {
    if (!isRecord(edge)) {
      continue;
    }
    const from = text(edge.from);
    const to = text(edge.to);
    if (ids.has(from) && ids.has(to)) {
      outdegree.set(from, (outdegree.get(from) ?? 0) + 1);
      indegree.set(to, (indegree.get(to) ?? 0) + 1);
      outgoing.get(from)!.push(to);
      incoming.get(to)!.push(from);
    }
  }
  const titleOf = new Map<string, string>();
  for (const node of topNodes) {
    const id = text(node.id);
    if (id) {
      titleOf.set(id, text(node.title) || id);
    }
  }
  /** 报错文案里带标题，开发者才能在画布上一眼找到是哪个节点。 */
  const label = (id: string) => {
    const title = titleOf.get(id) ?? id;
    return title === id ? `「${id}」` : `「${title}」(${id})`;
  };
  const hasStart = topNodes.some((node) => node.kind === "start");
  const hasEnd = topNodes.some((node) => node.kind === "end");
  const startIds = topNodes
    .filter((node) => node.kind === "start")
    .map((node) => text(node.id))
    .filter(Boolean);
  const endIds = topNodes
    .filter((node) => node.kind === "end")
    .map((node) => text(node.id))
    .filter(Boolean);
  // 已经按「悬空」报过的节点不再重复报「到不了结束节点」。
  const dangling = new Set<string>();
  if (topNodes.length > 1) {
    for (const node of topNodes) {
      const id = text(node.id);
      if (!id) {
        continue;
      }
      const incomingCount = indegree.get(id) ?? 0;
      const outgoingCount = outdegree.get(id) ?? 0;
      if (incomingCount === 0 && outgoingCount === 0) {
        push(
          "disconnected-node",
          id,
          `节点${label(id)}没有连任何线：既没有输入也没有输出，请接进主流程或删掉`
        );
        dangling.add(id);
      } else if (hasStart && incomingCount === 0 && node.kind !== "start") {
        push(
          "missing-incoming-edge",
          id,
          `节点${label(id)}缺少输入连线，没有任何上游节点会触发它`
        );
      } else if (hasEnd && outgoingCount === 0 && node.kind !== "end") {
        dangling.add(id);
        push(
          "missing-outgoing-edge",
          id,
          `节点${label(id)}没有输出连线，产物不会汇入结束节点；请连到下一个节点或结束节点`
        );
      } else if (!hasEnd && outgoingCount === 0 && node.kind !== "end") {
        push(
          "missing-outgoing-edge",
          id,
          `节点${label(id)}没有输出连线，产物不会被后续节点使用`,
          "warning"
        );
      }
    }
  }

  /**
   * 选项卡端口：一个选项一个出口，删掉选项后挂在它上面的连线会永久不触发。
   * 这类问题运行期只表现为「这条分支没跑」，从画布上看不出来，所以放在诊断里点名。
   */
  const draftById = new Map(topNodes.map((node) => [text(node.id), node]));
  // 老连线没有 fromPort，先按「条件里的选项文本 → 剩余端口顺序」推断一次；
  // 推断完还是没端口的，运行期确实不会激活，这种情况必须点出来。
  const choiceOptionsById = new Map<string, string[]>();
  for (const node of topNodes) {
    if (text(node.kind) !== "human") {
      continue;
    }
    const options = choiceOptionsOf(node);
    if (options.length > 0) {
      choiceOptionsById.set(text(node.id), options);
    }
  }
  const inferredPorts = inferChoicePorts(
    rawEdges.map((edge) => {
      if (!isRecord(edge)) {
        return { from: "" };
      }
      const from = text(edge.from);
      return {
        from,
        fromPort: text(edge.fromPort) || undefined,
        choiceValue: choiceValueOfCondition(edge.when, from)
      };
    }),
    choiceOptionsById
  );
  rawEdges.forEach((edge, edgeIndex) => {
    if (!isRecord(edge)) {
      return;
    }
    const fromPort = text(edge.fromPort) || inferredPorts.get(edgeIndex);
    if (!fromPort) {
      // 源头是选项卡、却既没有端口也看不出属于哪个选项：运行期这条线两边都碰不上。
      const from = text(edge.from);
      const source = draftById.get(from);
      if (source && text(source.kind) === "human" && choiceCountOf(source) > 0) {
        push(
          "unbound-choice-edge",
          from,
          `节点${label(from)}的这条连线既没有从选项端口拉出来，条件里也没写是哪个选项，运行期不会激活；请在画布上从对应选项重新连一次`,
          "warning"
        );
      }
      return;
    }
    const from = text(edge.from);
    const source = draftById.get(from);
    const isOtherPort = fromPort === CHOICE_OTHER_PORT;
    const index = choicePortIndex(fromPort);
    if ((!isOtherPort && index === undefined) || !source) {
      push("unknown-edge-port", from, `连线上的端口「${fromPort}」无法识别，这条线不会被触发`, "warning");
      return;
    }
    if (text(source.kind) !== "human") {
      push(
        "unknown-edge-port",
        from,
        `只有选项卡按选项分出口，节点${label(from)}不支持端口绑定，这条线按普通连线处理`,
        "warning"
      );
      return;
    }
    const count = choiceCountOf(source);
    if (isOtherPort) {
      // 兜底口只在有选项时存在；一个选项都没有的话，这个端口压根不会被画出来。
      if (count === 0) {
        push(
          "stale-choice-port",
          from,
          `节点${label(from)}现在没有配置任何选项，「其他」兜底出口已经不存在了`,
          "warning"
        );
      }
      return;
    }
    // 走到这里 index 一定解析出来了（上面已经把「认不出的端口」挡掉）。
    if (index !== undefined && index >= count) {
      push(
        "stale-choice-port",
        from,
        `节点${label(from)}现在只有 ${count} 个选项，这条连线绑的第 ${index + 1} 个选项已经不在了，点击不会再走这条路`,
        "warning"
      );
    }
  });

  /**
   * 可达性：只有工作流自带开始 / 结束节点时才判。
   * 内置流程以零入度节点为入口、以叶子节点为终点，不能按 start/end 要求。
   * 有 start 却到不了的节点根本不会执行；有 end 却走不到的节点属于断链，都是硬错误。
   */
  const walk = (seeds: string[], next: (id: string) => string[]) => {
    const seen = new Set<string>();
    const queue = [...seeds];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (seen.has(current)) {
        continue;
      }
      seen.add(current);
      for (const id of next(current)) {
        if (!seen.has(id)) {
          queue.push(id);
        }
      }
    }
    return seen;
  };
  if (hasStart && startIds.length > 0) {
    const reached = walk(startIds, (id) => outgoing.get(id) ?? []);
    for (const node of topNodes) {
      const id = text(node.id);
      if (id && node.kind !== "start" && !reached.has(id)) {
        push(
          "unreachable-node",
          id,
          `节点${label(id)}从开始节点走不到，运行到这里之前流程就已经结束了`
        );
      }
    }
  }
  if (hasEnd && endIds.length > 0) {
    const canReachEnd = walk(endIds, (id) => incoming.get(id) ?? []);
    for (const node of topNodes) {
      const id = text(node.id);
      if (id && node.kind !== "end" && !canReachEnd.has(id) && !dangling.has(id)) {
        push(
          "dead-end-node",
          id,
          `节点${label(id)}的产物流不到结束节点，这条分支是断的`
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
    if (kind === "extract") {
      // 没有参数表的「参数提取」等于放行节点：画布上看不出来，只有跑起来才发现什么都没拦。
      const params = asArray(node.params).filter(isRecord);
      const names = params.map((param) => text(param.name)).filter(Boolean);
      if (names.length === 0) {
        push(
          "empty-extract-params",
          id,
          "参数提取节点还没定义参数，运行时会直接放行；先在上方「参数信息」里加一条要提取的参数"
        );
      }
      const duplicated = names.filter((name, index) => names.indexOf(name) !== index);
      if (duplicated.length > 0) {
        push(
          "duplicate-extract-param",
          id,
          `参数名重复：${[...new Set(duplicated)].join("、")}；同名参数只会保留第一条`
        );
      }
      for (const param of params) {
        if (!text(param.description) && !text(param.question)) {
          push(
            "vague-extract-param",
            id,
            `参数「${text(param.name) || "未命名"}」没写描述也没写追问话术，缺值时模型不知道该找什么`,
            "warning"
          );
          break;
        }
      }
    }
    const bindings = asArray(node.inputBindings).filter(isRecord);
    /** 本节点「输入变量」里声明的名字：正文写 ${name} 引用的是它们，不是某个节点。 */
    const declaredPorts = new Set(
      bindings.map((binding) => text(binding.name)).filter((name) => name !== "")
    );
    // 选项卡自带 choice：提示词里 ${choice} 指用户选中的那一项，不是节点。
    if (kind === "human" && (asArray(node.options).length > 0 || text(node.optionsFrom))) {
      declaredPorts.add("choice");
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
        // ${节点ID.字段} / ${节点ID.output.子字段}：目标节点必须存在，且优先是上游节点。
        // 子工作流节点的 inputs / outputs 是子流程作用域，编译器会在展开时单独校验，这里跳过。
        for (const match of source.matchAll(/\$\{([A-Za-z0-9_-]+)(?:\.[^}]*)?\}/g)) {
          const head = match[1];
          if (kind === "subworkflow" || RESERVED_REF_HEADS.has(head) || head === id || declaredPorts.has(head)) {
            continue;
          }
          if (!allIds.has(head)) {
            push("unknown-node-ref", id, `引用了不存在的节点 "${head}"；请检查节点 ID 是否已改过或删掉`);
          }
        }
      });
    }
    for (const binding of bindings) {
      const name = text(binding.name);
      if (!name) {
        continue;
      }
      if (
        binding.required === true &&
        (binding.value === undefined || binding.value === null || binding.value === "")
      ) {
        push(
          "empty-required-port",
          id,
          `输入参数「${name}」标了必填，但还没取值；下游节点会拿到空值`
        );
      }
      if (
        binding.source === "reference" &&
        typeof binding.value === "string" &&
        !binding.value.includes("${")
      ) {
        push(
          "invalid-port-ref",
          id,
          `输入参数「${name}」选择「引用上游节点」，但值不是 \${...} 引用`
        );
      }
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

/** choice:N → N；不是选项端口返回 undefined。 */
function choicePortIndex(port: string): number | undefined {
  if (!port.startsWith("choice:")) {
    return undefined;
  }
  const index = Number(port.slice("choice:".length));
  return Number.isInteger(index) && index >= 0 ? index : undefined;
}

/** 画布上真实存在的选项数量：去空、去重，与服务端 normalizeChoices 一致。 */
function choiceOptionsOf(node: DraftRecord): string[] {
  if (text(node.optionsFrom)) {
    return [];
  }
  const seen = new Set<string>();
  const list: string[] = [];
  for (const item of asArray(node.options)) {
    const value = text(item);
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    list.push(value);
  }
  return list;
}

function choiceCountOf(node: DraftRecord): number {
  if (text(node.optionsFrom)) {
    return 0;
  }
  const seen = new Set<string>();
  for (const item of asArray(node.options)) {
    const value = text(item);
    if (value) {
      seen.add(value);
    }
  }
  return seen.size;
}
