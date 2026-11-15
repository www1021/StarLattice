import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from "./types";

/**
 * 兜底端口：用户选的东西不在预置选项里（或者点了「其他」自己写），就走这条。
 * 端口 id 固定成 choice:other，服务端 server/platform/runtime/executor.ts 必须用同一个字面量。
 */
export const CHOICE_OTHER_PORT = "choice:other";

/**
 * 选项卡的输出端口：一个选项一个端口，端口 id 用序号索引。
 * 服务端 server/platform/runtime/executor.ts 里的 choicePortOf 必须与这里保持一致，
 * 否则连线上的端口在运行期认不出来，分支会被全部跳过。
 */
export function choicePortOf(index: number): string {
  return index < 0 ? CHOICE_OTHER_PORT : `choice:${index}`;
}

/** 端口是不是兜底出口。 */
export function isChoiceOtherPort(port?: string | null): boolean {
  return port === CHOICE_OTHER_PORT;
}

/** 从端口 id 反解选项序号；兜底口和其它端口都返回 undefined。 */
export function choiceIndexOfPort(port?: string | null): number | undefined {
  if (!port || !port.startsWith("choice:")) {
    return undefined;
  }
  const index = Number(port.slice("choice:".length));
  return Number.isInteger(index) && index >= 0 ? index : undefined;
}

/**
 * 画布上能画出来的选项：只认手动填写的那批。
 * 去空、去重与服务端 humanChoices.normalizeChoices 完全一致——
 * 端口序号要和运行期的 choiceIndex 对得上，否则第 N 条分支永远选不中。
 */
export function choiceOptionsOf(node: WorkflowNode): string[] {
  if (node.kind !== "human" || node.optionsFrom !== undefined) {
    return [];
  }
  const seen = new Set<string>();
  const list: string[] = [];
  for (const item of node.options ?? []) {
    const text = item.trim();
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    list.push(text);
  }
  return list;
}

function squash(value: string): string {
  return value.replace(/\s+/g, "");
}

/** 文本落在第几个选项上：精确匹配优先，再忽略空白匹配。与服务端 matchOptionIndex 同口径。 */
export function matchOptionIndex(options: string[], text: string): number {
  const exact = options.indexOf(text);
  if (exact >= 0) {
    return exact;
  }
  const target = squash(text);
  if (!target) {
    return -1;
  }
  return options.findIndex((item) => squash(item) === target);
}

/** 「其他 / 兜底」这类写法：条件里写它，指的是兜底分支。 */
export function isOtherChoiceText(text: string): boolean {
  const value = squash(text).toLowerCase();
  if (!value) {
    return false;
  }
  if (value.includes("其他") || value.includes("其它") || value.includes("兜底")) {
    return true;
  }
  return value === "other" || value === "else" || value === "default" || value === "custom";
}

/** 条件右值 → 端口；对不上任何选项、也认不出是兜底词时返回 undefined。 */
export function choicePortFromCondition(options: string[], value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    return undefined;
  }
  const index = matchOptionIndex(options, text);
  if (index >= 0) {
    return choicePortOf(index);
  }
  return isOtherChoiceText(text) ? CHOICE_OTHER_PORT : undefined;
}

/**
 * 从 DSL 的条件字符串里读出「选了哪个选项就走这条线」。
 * 早期选项卡没有端口，分支只能写成 `${节点.choice} == 某个选项`；
 * 这些老连线升级后没有 fromPort，只能靠条件里的文本认回对应端口。
 */
export function whenChoiceValue(
  edge: Pick<WorkflowEdge, "from" | "when">,
  nodeId: string
): string | undefined {
  const when = edge.when?.trim();
  if (!when) {
    return undefined;
  }
  const match = when.match(/^\$\{\s*([^}]+?)\s*\}\s*==\s*([\s\S]+)$/);
  if (!match) {
    return undefined;
  }
  const [, ref, rawValue] = match;
  const [head, ...rest] = ref.split(".");
  if (head !== nodeId || rest.join(".") !== "choice") {
    return undefined;
  }
  const value = rawValue.trim().replace(/^["'“”]|["'“”]$/g, "").trim();
  return value || undefined;
}

export type ChoicePortEdge = Pick<WorkflowEdge, "from" | "fromPort" | "when">;

/**
 * 老流程迁移：早期选项卡只有卡片右下角一个共用出口，几条出边都绑不到选项上。
 *
 * 补端口按三条线索，优先级从高到低：
 * 1. 边自己写了 fromPort —— 用户拖线时就是从那个端口拉出来的，原样保留。
 * 2. 边上的条件写了「选项 == 某文本」—— 升级前表达分支的唯一方式，文本对上哪个选项就落哪个口，
 *    对上「其他情况」这类词就落兜底口。这条最准，因为分支语义是用户明确写下的。
 * 3. 什么线索都没有 —— 只有所有边都没端口、且数量正好是选项数（或选项数 +1）时才按顺序补，
 *    纯位置猜测只在「一选项一分支」时成立，数量对不上就不猜。
 *
 * 以前只要有一条边已经有端口就整体跳过推断，结果新老连线混着的流程里，老边永远拿不到端口，
 * 运行期要么不激活，要么被兜底口顶掉——选项卡选了第一项却跑了兜底分支就是这么来的。
 */
export function inferChoicePorts(
  edges: ChoicePortEdge[],
  optionsByNode: Map<string, string[]>
): Map<number, string> {
  const ports = new Map<number, string>();
  const byNode = new Map<string, number[]>();
  edges.forEach((edge, index) => {
    const list = byNode.get(edge.from) ?? [];
    list.push(index);
    byNode.set(edge.from, list);
  });

  for (const [nodeId, options] of optionsByNode) {
    const indexes = byNode.get(nodeId) ?? [];
    if (indexes.length === 0 || options.length === 0) {
      continue;
    }
    const taken = new Set<string>();
    for (const index of indexes) {
      const port = edges[index].fromPort;
      if (port) {
        taken.add(port);
      }
    }

    for (const index of indexes) {
      const edge = edges[index];
      if (edge.fromPort) {
        continue;
      }
      const port = choicePortFromCondition(options, whenChoiceValue(edge, nodeId));
      if (!port || taken.has(port)) {
        continue;
      }
      taken.add(port);
      ports.set(index, port);
    }

    const pending = indexes.filter((index) => !edges[index].fromPort && !ports.has(index));
    if (pending.length === 0) {
      continue;
    }
    const free = [...options.map((_, order) => choicePortOf(order)), CHOICE_OTHER_PORT].filter(
      (port) => !taken.has(port)
    );
    if (free.length === 0 || pending.length > free.length) {
      continue;
    }
    const untouched =
      indexes.every((index) => !edges[index].fromPort) && !indexes.some((index) => ports.has(index));
    if (
      untouched &&
      indexes.length !== options.length &&
      indexes.length !== options.length + 1
    ) {
      continue;
    }
    pending.forEach((index, order) => ports.set(index, free[order]));
  }
  return ports;
}

/**
 * 把推断出来的端口写回定义：连线从此明确挂在某个选项口上，
 * 不用每次打开流程都重新猜，保存后运行期也只看 fromPort。
 * 没推断出端口的边原样保留（宁可不猜，也不要把分支接到错误的选项上）。
 */
export function migrateChoiceEdgePorts(definition: WorkflowDefinition): {
  definition: WorkflowDefinition;
  changed: boolean;
} {
  const optionsByNode = new Map<string, string[]>();
  for (const node of definition.nodes) {
    const options = choiceOptionsOf(node);
    if (options.length > 0) {
      optionsByNode.set(node.id, options);
    }
  }
  if (optionsByNode.size === 0 || definition.edges.length === 0) {
    return { definition, changed: false };
  }
  const inferred = inferChoicePorts(definition.edges, optionsByNode);
  if (inferred.size === 0) {
    return { definition, changed: false };
  }
  let changed = false;
  const edges = definition.edges.map((edge, index) => {
    const port = inferred.get(index);
    if (!port || edge.fromPort) {
      return edge;
    }
    changed = true;
    return { ...edge, fromPort: port };
  });
  return changed ? { definition: { ...definition, edges }, changed } : { definition, changed };
}
