/**
 * 选项卡出口的端口命名，运行期和诊断共用一份，免得一边改字面量一边忘了另一边。
 * 前端对应实现是 src/features/platform/choicePorts.ts，两边必须一致。
 */

/** 兜底出口：用户选的东西不在预置选项里（手动输入或点了「其他」）就走这条。 */
export const CHOICE_OTHER_PORT = "choice:other";

/** 第 index 个选项的出口；index < 0 表示兜底。 */
export function choicePortOf(index: number): string {
  return index < 0 ? CHOICE_OTHER_PORT : `choice:${index}`;
}

/** 空白不影响「是不是同一句话」的判断：选项常从文档里粘过来，末尾换行、中间全角空格都算同一项。 */
function squash(value: string): string {
  return value.replace(/\s+/g, "");
}

/**
 * 文本落在第几个选项上。先精确匹配，再忽略空白匹配，都没有就 -1。
 * 选项卡的 choiceIndex 和出边端口都用它算，两边必须同口径。
 */
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

/**
 * 这段文字是不是「其他 / 兜底」的写法。
 *
 * 早期做分支只能写条件表达式，兜底那条线的条件常写成「choice == 其他情况」，
 * 而「其他情况」通常不在选项卡的选项列表里。升级到端口后要能把这种线认回兜底口，
 * 否则它会被当成一条永远不成立的分支。先按选项匹配、再走这里，所以不会抢正经选项。
 */
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

/**
 * 条件表达式的右值 → 端口。命中某个选项就用选项口，认得出是兜底词就用兜底口，
 * 两者都不是时返回 undefined：条件里写的是一句永远选不到的话，这条线本来就不该被激活，
 * 硬塞进兜底口会把「不该走」改成「走了兜底」。
 */
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

export type ChoicePortEdge = {
  from: string;
  fromPort?: string;
  /** 条件右值：仅当条件是「源节点的 choice == 某个文本」时才有值。 */
  choiceValue?: string;
};

/**
 * 从 DSL 的条件字符串里读出「选了哪个选项就走这条线」。
 *
 * 编译后的边用 CompiledExpression（见 executor 的 choiceConditionValue），
 * 这里面向还没编译的草稿：诊断和画布打开流程时都要先看一眼老连线本来属于哪个选项。
 */
export function choiceValueOfCondition(when: unknown, nodeId: string): string | undefined {
  if (typeof when !== "string") {
    return undefined;
  }
  const match = when.trim().match(/^\$\{\s*([^}]+?)\s*\}\s*==\s*([\s\S]+)$/);
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

/**
 * 老流程迁移：早期选项卡只有卡片右下角一个共用出口，几条出边绑不到具体选项上。
 *
 * 补端口按两条线索来，优先级从高到低：
 * 1. 边自己写了 fromPort —— 用户拖线时就是从那个端口拉出来的，原样保留。
 * 2. 边上写着「选项 == 某个文本」的条件 —— 这是升级前表达分支的唯一方式，
 *    文本能对上哪个选项就落哪个端口，对得上兜底词就落兜底口。这条最准，
 *    因为它是用户明确表达过的分支语义，比数出边数量猜顺序可靠得多。
 * 3. 什么都没写的边 —— 只有「全部边都没端口、且数量正好等于选项数（或选项数 +1）」
 *    时才按声明顺序补，这是纯位置猜测，数量对不上就不猜。
 *
 * 关键点：只要有一条边已经有端口，以前会整体跳过推断，剩下的老边就永远没有端口，
 * 运行期这些边一条都激活不了（或者被兜底口顶掉）。现在逐条处理，新老连线混着的流程也能修好。
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

    // 线索 2：条件里写了选项文本的边先落位，一个端口只给一条边。
    for (const index of indexes) {
      const edge = edges[index];
      if (edge.fromPort || edge.choiceValue === undefined) {
        continue;
      }
      const port = choicePortFromCondition(options, edge.choiceValue);
      if (!port || taken.has(port)) {
        continue;
      }
      taken.add(port);
      ports.set(index, port);
    }

    // 线索 3：还剩没端口的边，按剩余端口顺序补；数量对不上就不猜，留给用户自己连线。
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
    // 全都没端口、也没有条件可依时，只有数量正好等于选项数（或选项数 +1）才按顺序补，
    // 纯位置猜测只在「看上去就是一选项一分支」时成立。已经有一部分落位的混合场景，
    // 剩下几条按剩余端口顺序补即可，用户自己连的那几条不会被动。
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
