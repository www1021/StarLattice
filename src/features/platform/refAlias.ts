/**
 * 正文里的变量引用要在「存的原串」和「编辑框里显示的样子」之间来回换。
 *
 * 存的是 ${节点id.字段}——运行时按 id 取产物，改不了。
 * 但 32 位哈希没法读，所以编辑框里显示节点标题。
 *
 * 早先只在渲染层做替换（textarea 里仍是 id），两串字宽不同，
 * 光标和点击按 textarea 自己的字符算，点哪儿都偏——点变量结尾会落进 id 中间，
 * 再敲 `/` 就把哈希劈成两半。现在编辑框直接放显示文本，落库前换回 id，
 * 两边字符完全一致，光标才对得上。
 */

export type RefAliasSource = {
  /** 节点 id（工作流输入 / 本节点输入这两类分组不算）。 */
  key: string;
  /** 节点标题，正文里用它代替 id。 */
  label: string;
};

export type RefAlias = {
  labelOfId: Map<string, string>;
  idByLabel: Map<string, string>;
  /** 按长度倒序的别名表：反查时用最长前缀匹配，标题带「.」也不会切错。 */
  labelsByLength: string[];
};

/** 工作流输入的固定命名空间：${input.x} 不能被同名节点抢走。 */
const INPUT_NAMESPACE = "input";

/**
 * 同名节点补 #2、#3 后缀，保证别名能反查回唯一的 id。
 * 顺序按传入的引用分组顺序（= 工作流节点顺序），因此同一次会话里稳定。
 */
export function buildRefAlias(groups: RefAliasSource[]): RefAlias {
  const labelOfId = new Map<string, string>();
  const idByLabel = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const group of groups) {
    const title = group.label.trim();
    // 节点标题正好叫 input 时不给别名：${input.x} 是工作流输入的命名空间，
    // 让一个节点把它占了，正文里两种引用就分不清了。这种情况直接显示 id。
    const base = !title || title === INPUT_NAMESPACE ? group.key : title;
    const times = (seen.get(base) ?? 0) + 1;
    seen.set(base, times);
    const alias = times === 1 ? base : `${base}#${times}`;
    labelOfId.set(group.key, alias);
    idByLabel.set(alias, group.key);
  }
  return {
    labelOfId,
    idByLabel,
    labelsByLength: [...idByLabel.keys()].sort((a, b) => b.length - a.length)
  };
}

/** 存的原串 → 编辑框里给人看的样子。 */
export function displayFromRaw(text: string, alias: RefAlias): string {
  if (alias.labelOfId.size === 0) {
    return text;
  }
  return text.replace(/\$\{([^}]*)\}/g, (whole, inner: string) => {
    const dot = inner.indexOf(".");
    if (dot <= 0) {
      return whole; // ${变量名}，本来就是这个样子
    }
    const head = inner.slice(0, dot);
    if (head === INPUT_NAMESPACE) {
      return whole;
    }
    const label = alias.labelOfId.get(head);
    return label ? "${" + label + inner.slice(dot) + "}" : whole;
  });
}

/** 编辑框里的文本 → 落库原串。 */
export function rawFromDisplay(text: string, alias: RefAlias): string {
  if (alias.idByLabel.size === 0) {
    return text;
  }
  return text.replace(/\$\{([^}]*)\}/g, (whole, inner: string) => {
    // 只认「别名.字段」：节点引用一定带字段名，这样 ${变量名} 不会被误当成节点。
    for (const label of alias.labelsByLength) {
      if (inner.startsWith(label + ".")) {
        return "${" + (alias.idByLabel.get(label) ?? label) + inner.slice(label.length) + "}";
      }
    }
    return whole;
  });
}
