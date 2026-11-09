// 基准工作流都是单链 DAG（并行/条件/循环都封装在单个节点内）。
// 这里做结构校验，避免节点漏连后以“根节点”身份空跑却仍返回成功。
export function assertWorkflowDag(dsl, source = dsl?.id ?? "workflow") {
  const nodes = Array.isArray(dsl?.nodes) ? dsl.nodes : [];
  if (nodes.length === 0) {
    throw new Error(`${source}: 工作流没有节点`);
  }
  const ids = new Set();
  for (const node of nodes) {
    if (!node.id) {
      throw new Error(`${source}: 存在缺少 id 的节点`);
    }
    if (ids.has(node.id)) {
      throw new Error(`${source}: 节点 id 重复：${node.id}`);
    }
    ids.add(node.id);
  }

  const incoming = new Map(nodes.map((node) => [node.id, []]));
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of Array.isArray(dsl.edges) ? dsl.edges : []) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      throw new Error(`${source}: 边 ${edge.from}->${edge.to} 引用了不存在的节点`);
    }
    incoming.get(edge.to).push(edge.from);
    outgoing.get(edge.from).push(edge.to);
  }

  const roots = nodes.filter((node) => incoming.get(node.id).length === 0).map((node) => node.id);
  if (roots.length !== 1) {
    throw new Error(`${source}: 顶层根节点必须唯一，当前 ${roots.join("、") || "(无)"}`);
  }
  const multiIn = nodes.filter((node) => incoming.get(node.id).length > 1).map((node) => node.id);
  if (multiIn.length > 0) {
    throw new Error(`${source}: 存在多入边节点，基准链不支持汇合：${multiIn.join("、")}`);
  }

  const ordered = [];
  let current = roots[0];
  while (current) {
    if (ordered.includes(current)) {
      throw new Error(`${source}: 检测到环：${ordered.join("->")}->${current}`);
    }
    ordered.push(current);
    const next = outgoing.get(current);
    if (next.length > 1) {
      throw new Error(`${source}: 节点 ${current} 有多条出边，基准链不支持分支：${next.join("、")}`);
    }
    current = next[0];
  }

  const unreachable = nodes.map((node) => node.id).filter((id) => !ordered.includes(id));
  if (unreachable.length > 0) {
    throw new Error(`${source}: 存在未连通节点：${unreachable.join("、")}`);
  }
  return ordered;
}
