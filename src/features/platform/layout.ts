import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs";
import type { NodeKind, RunRecord, StepRecord, WorkflowDefinition, WorkflowNode } from "./types";

export type RunNodeStatus = "succeeded" | "failed" | "running";

const COLUMN_WIDTH = 330;
const ROW_HEIGHT = 205;
const ELK_NODE_WIDTH = 252;
const ELK_NODE_HEIGHT = 150;
const ELK_LAYER_GAP = 72;
const ELK_NODE_GAP = 50;

type ElkInstance = InstanceType<typeof ELK>;

let elkInstance: ElkInstance | undefined;

function getElk(): ElkInstance {
  if (!elkInstance) {
    elkInstance = new ELK();
  }
  return elkInstance;
}

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

/**
 * 用 ELK 计算顶层 DAG 的坐标。容器内部不展开，只按顶层节点与边布局。
 * 结果只用于画布展示，不写回 DSL。
 */
export async function computeElkLayout(
  definition: WorkflowDefinition
): Promise<Map<string, { x: number; y: number }>> {
  const nodeIds = new Set(definition.nodes.map((node) => node.id));
  const edges = definition.edges
    .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
    .map((edge, index) => ({
      id: `elk-edge-${index}-${edge.from}-${edge.to}`,
      sources: [edge.from],
      targets: [edge.to]
    }));

  const graph: ElkNode = {
    id: `workflow-${definition.id || "graph"}`,
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.spacing.nodeNodeBetweenLayers": String(ELK_LAYER_GAP),
      "elk.spacing.nodeNode": String(ELK_NODE_GAP),
      "elk.padding": "[top=0,left=0,bottom=0,right=0]"
    },
    children: definition.nodes.map((node) => ({
      id: node.id,
      width: ELK_NODE_WIDTH,
      height: ELK_NODE_HEIGHT
    })),
    edges
  };

  const result = await getElk().layout(graph);
  const positions = new Map<string, { x: number; y: number }>();
  for (const child of result.children ?? []) {
    positions.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
  }
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

export type NodeDefaults = {
  input?: string;
  agent?: string;
  tool?: string;
  verifier?: string;
  sourceId?: string;
};

export function createNode(kind: NodeKind, id: string, defaults: NodeDefaults = {}): WorkflowNode {
  const firstInputName = defaults.input ?? "topic";
  const agent = defaults.agent ?? "lesson-plan-agent";
  const tool = defaults.tool ?? "knowledge.search";
  const verifier = defaults.verifier ?? "observer-verifier";
  const childId = `${id}-step`;
  const child: WorkflowNode = { id: childId, kind: "agent", title: "步骤 1", agent };
  switch (kind) {
    case "start":
      return { id, kind, title: "流程开始" };
    case "end":
      return {
        id,
        kind,
        title: "流程结束",
        inputs: defaults.sourceId ? { result: `\${${defaults.sourceId}.output}` } : {}
      };
    case "knowledge":
      return {
        id,
        kind,
        title: "知识库检索",
        query: `\${input.${firstInputName}}`,
        topK: 5,
        inputs: { query: `\${input.${firstInputName}}` }
      };
    case "http":
      return {
        id,
        kind,
        title: "HTTP 请求",
        method: "GET",
        url: "https://",
        headers: {},
        inputs: {}
      };
    case "agent":
      return { id, kind, title: "新 Agent 节点", agent, inputs: {} };
    case "llm":
      return {
        id,
        kind,
        title: "新模型思考节点",
        prompt: `分析 \${input.${firstInputName}}，输出三条可执行建议。`,
        system: "你是一名专业顾问，回答要具体、可执行。",
        thinking: true,
        inputs: {}
      };
    case "tool":
      return { id, kind, title: "新工具节点", tool, args: {} };
    case "template":
      return {
        id,
        kind,
        title: "新文本模板节点",
        template: `# \${input.${firstInputName}}\n\n在这里填写模板内容。`,
        inputs: {}
      };
    case "subworkflow":
      return {
        id,
        kind,
        title: "新子工作流节点",
        workflowId: "",
        inputs: {},
        outputs: {}
      };
    case "verify":
      return {
        id,
        kind,
        title: "新验证节点",
        verifier,
        rubric: ["目标达成", "证据支撑"],
        threshold: 0.8
      };
    case "approve":
      return {
        id,
        kind,
        title: "新人工审批节点",
        instructions: "确认产物满足要求后通过。",
        assignee: "负责人",
        timeoutMs: 600000,
        inputs: {}
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
  if (kind === "knowledge") {
    return { id, kind, title: "新知识库检索步骤", query: "${input.topic}", topK: 5 };
  }
  if (kind === "http") {
    return { id, kind, title: "新 HTTP 请求步骤", method: "GET", url: "https://", headers: {} };
  }
  if (kind === "tool") {
    return { id, kind, title: "新工具步骤", tool: "tool.id", args: {} };
  }
  if (kind === "llm") {
    return {
      id,
      kind,
      title: "新模型思考步骤",
      prompt: "分析 ${input.topic}，输出三条可执行建议。",
      thinking: true
    };
  }
  if (kind === "template") {
    return { id, kind, title: "新文本模板步骤", template: "${input.topic}" };
  }
  if (kind === "subworkflow") {
    return { id, kind, title: "新子工作流步骤", workflowId: "", inputs: {}, outputs: {} };
  }
  if (kind === "verify") {
    return { id, kind, title: "新验证步骤", verifier: "verifier-id", rubric: ["目标达成"], threshold: 0.8 };
  }
  if (kind === "approve") {
    return { id, kind, title: "新人工审批步骤", instructions: "确认后通过。", timeoutMs: 600000 };
  }
  return { id, kind: "agent", title: "新 Agent 步骤", agent: "agent-id" };
}

/** 连线上的语义标签：只在容器/验证/审批出边自动补，普通数据流保持干净。 */
export function defaultEdgeLabel(source: WorkflowNode | undefined): string | undefined {
  switch (source?.kind) {
    case "approve":
      return "通过";
    case "condition":
      return "分支后";
    case "loop":
      return "循环后";
    case "parallel":
      return "并行后";
    default:
      return undefined;
  }
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
    } else if (step.status === "running" || step.status === "waiting") {
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
  return (
    status === "queued" ||
    status === "running" ||
    status === "verifying" ||
    status === "revising" ||
    status === "waiting_approval"
  );
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
    waiting: "待审批",
    succeeded: "成功",
    failed: "失败",
    skipped: "跳过"
  };
  return labels[status] ?? status;
}

export function selfLoopActionLabel(action: string): string {
  const labels: Record<string, string> = {
    rewrite: "重写输出",
    swap_agent: "换 Agent",
    retrieve: "补检索"
  };
  return labels[action] ?? action;
}

export function runStatusLabel(status: RunRecord["status"]): string {
  const labels: Record<RunRecord["status"], string> = {
    queued: "排队中",
    running: "运行中",
    succeeded: "成功",
    failed: "失败",
    rolled_back: "已回滚",
    cancelled: "已取消",
    verifying: "验证中",
    revising: "修正中",
    waiting_approval: "等待审批"
  };
  return labels[status] ?? status;
}
