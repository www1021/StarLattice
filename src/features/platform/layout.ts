import type { NodeKind, RunRecord, StepRecord, WorkflowDefinition, WorkflowNode } from "./types";

export type RunNodeStatus = "succeeded" | "failed" | "running";

const COLUMN_WIDTH = 300;
const ROW_HEIGHT = 170;

export function computeLayout(definition: WorkflowDefinition): Map<string, { x: number; y: number }> {
  const layers = new Map<string, number>(definition.nodes.map((node) => [node.id, 0]));
  const order = new Map<string, number>(definition.nodes.map((node, index) => [node.id, index]));

  for (let round = 0; round < definition.nodes.length; round += 1) {
    let changed = false;
    for (const edge of definition.edges) {
      if (!layers.has(edge.from) || !layers.has(edge.to)) {
        continue;
      }
      const candidate = layers.get(edge.from)! + 1;
      if (candidate > layers.get(edge.to)!) {
        layers.set(edge.to, candidate);
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }

  const byLayer = new Map<number, string[]>();
  definition.nodes.forEach((node) => {
    const layer = layers.get(node.id) ?? 0;
    byLayer.set(layer, [...(byLayer.get(layer) ?? []), node.id]);
  });

  const positions = new Map<string, { x: number; y: number }>();
  byLayer.forEach((ids, layer) => {
    ids.sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
    ids.forEach((id, row) => {
      positions.set(id, { x: 60 + layer * COLUMN_WIDTH, y: 80 + row * ROW_HEIGHT });
    });
  });
  return positions;
}

export function collectNodeIds(nodes: WorkflowNode[], ids = new Set<string>()): Set<string> {
  for (const node of nodes) {
    ids.add(node.id);
    collectNodeIds(node.branches ?? [], ids);
    collectNodeIds(node.then ?? [], ids);
    collectNodeIds(node.else ?? [], ids);
    collectNodeIds(node.body ?? [], ids);
  }
  return ids;
}

export function uniqueNodeId(base: string, used: Set<string>): string {
  const normalized = base.replace(/[^A-Za-z0-9_-]/g, "-") || "node";
  if (!used.has(normalized)) {
    return normalized;
  }
  let index = 2;
  while (used.has(`${normalized}-${index}`)) {
    index += 1;
  }
  return `${normalized}-${index}`;
}

export function createNode(kind: NodeKind, id: string, firstInputName = "topic"): WorkflowNode {
  const childId = `${id}-step`;
  const child: WorkflowNode = { id: childId, kind: "agent", title: "步骤 1", agent: "agent-id" };
  switch (kind) {
    case "agent":
      return { id, kind, title: "新 Agent 节点", agent: "agent-id", inputs: {} };
    case "tool":
      return { id, kind, title: "新工具节点", tool: "tool.id", args: {} };
    case "verify":
      return {
        id,
        kind,
        title: "新验证节点",
        verifier: "verifier-id",
        rubric: ["目标达成", "证据支撑"],
        threshold: 0.8
      };
    case "parallel":
      return { id, kind, title: "并行容器", branches: [child] };
    case "condition":
      return { id, kind, title: "条件容器", when: `\${input.${firstInputName}} == true`, then: [child], else: [] };
    case "loop":
      return { id, kind, title: "循环容器", maxIterations: 2, body: [child] };
  }
}

export function createLeafNode(kind: NodeKind, id: string): WorkflowNode {
  if (kind === "tool") {
    return { id, kind, title: "新工具步骤", tool: "tool.id", args: {} };
  }
  if (kind === "verify") {
    return { id, kind, title: "新验证步骤", verifier: "verifier-id", rubric: ["目标达成"], threshold: 0.8 };
  }
  return { id, kind: "agent", title: "新 Agent 步骤", agent: "agent-id" };
}

export const BLOCK_KEYS = ["branches", "then", "else", "body"] as const;
export type BlockKey = (typeof BLOCK_KEYS)[number];

export function blockChildren(node: WorkflowNode, blockKey: string): WorkflowNode[] {
  if (!(BLOCK_KEYS as readonly string[]).includes(blockKey)) {
    return [];
  }
  return (node[blockKey as BlockKey] as WorkflowNode[] | undefined) ?? [];
}

export function withBlockChildren(node: WorkflowNode, blockKey: string, children: WorkflowNode[]): WorkflowNode {
  return { ...node, [blockKey]: children };
}

export function aggregateStatuses(steps: StepRecord[]): Map<string, RunNodeStatus> {
  const statuses = new Map<string, RunNodeStatus>();
  for (const step of steps) {
    const root = step.path.split("/")[0];
    if (!root) {
      continue;
    }
    const current = statuses.get(root);
    if (current === "failed") {
      continue;
    }
    if (step.status === "failed") {
      statuses.set(root, "failed");
    } else if (step.status === "running") {
      if (current !== "succeeded") {
        statuses.set(root, "running");
      }
    } else if (step.status === "succeeded" && !current) {
      statuses.set(root, "succeeded");
    }
  }
  return statuses;
}

export function firstInputName(definition: WorkflowDefinition | undefined): string {
  return definition?.inputs?.[0]?.name ?? "topic";
}

export function isActiveRun(status: RunRecord["status"]): boolean {
  return status === "queued" || status === "running" || status === "verifying" || status === "revising";
}

export type RunStatusTone = "running" | "succeeded" | "failed";

export function runStatusTone(status: RunRecord["status"]): RunStatusTone {
  if (isActiveRun(status)) {
    return "running";
  }
  return status === "succeeded" ? "succeeded" : "failed";
}

export function stepStatusLabel(status: StepRecord["status"]): string {
  const labels: Record<StepRecord["status"], string> = {
    pending: "等待",
    running: "执行中",
    succeeded: "成功",
    failed: "失败",
    skipped: "跳过"
  };
  return labels[status] ?? status;
}

export function runStatusLabel(status: RunRecord["status"]): string {
  const labels: Record<RunRecord["status"], string> = {
    queued: "排队中",
    running: "运行中",
    succeeded: "成功",
    failed: "失败",
    rolled_back: "已回滚",
    verifying: "验证中",
    revising: "修正中"
  };
  return labels[status] ?? status;
}
