import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { PlatformError, type McpCallResult, type ToolRecord } from "../types.js";
import type { PlatformStateStore } from "../runtime/stateStore.js";
import type { WorkflowExecutor, WorkflowNodeProgress } from "../runtime/executor.js";

export const WORKFLOW_TOOL_ENDPOINT_PREFIX = "workflow://";
export const WORKFLOW_TOOL_SERVER_ID = "platform-workflows";
export const WORKFLOW_TOOL_SERVER_NAME = "平台工作流";

const MAX_WORKFLOW_TOOL_DEPTH = 5;
const MAX_TEXT_LENGTH = 4000;

const callStack = new AsyncLocalStorage<Set<string>>();

/**
 * 把已保存的工作流注册为平台内联 MCP 工具：
 * 工具 id 为 workflow.<工作流 id>，endpoint 为 workflow://<工作流 id>，
 * 输入 schema 直接来自工作流声明的 inputs，供工具节点与 Agent 调用。
 */
export function syncWorkflowTools(store: PlatformStateStore): ToolRecord[] {
  const tools: ToolRecord[] = [];
  for (const summary of store.listWorkflows()) {
    const stored = store.getWorkflow(summary.id);
    if (!stored) {
      continue;
    }
    const definition = stored.definition;
    const id = workflowToolId(definition.id);
    const schema = workflowInputSchema(definition.inputs);
    const description = workflowToolDescription(definition.name, definition.version, definition.inputs);
    const endpoint = `${WORKFLOW_TOOL_ENDPOINT_PREFIX}${definition.id}`;
    const existing = store.getTool(id);
    if (
      existing &&
      existing.name === `工作流：${definition.name}` &&
      existing.endpoint === endpoint &&
      existing.description === description &&
      existing.enabled &&
      JSON.stringify(existing.schema) === JSON.stringify(schema)
    ) {
      tools.push(existing);
      continue;
    }
    tools.push(
      store.saveTool(
        {
          id,
          name: `工作流：${definition.name}`,
          type: "mcp",
          schema,
          endpoint,
          description,
          enabled: true
        },
        // 工具跟着工作流走：内置流程的工具全员可用，自建流程的工具只有主人能用。
        summary.ownerId ?? null
      )
    );
  }
  return tools;
}

export function workflowToolId(workflowId: string) {
  return `workflow.${workflowId}`;
}

export function isWorkflowToolEndpoint(endpoint: string | undefined) {
  return typeof endpoint === "string" && endpoint.startsWith(WORKFLOW_TOOL_ENDPOINT_PREFIX);
}

/**
 * 平台内联执行：每次调用都会生成独立的运行记录，便于监控与成本核算。
 * 递归调用同一工作流直接被拒绝，嵌套深度上限 5，避免工具互相调用形成死循环。
 */
export async function runWorkflowTool(
  store: PlatformStateStore,
  executor: WorkflowExecutor,
  tool: ToolRecord,
  args: Record<string, unknown>,
  onNodeProgress?: (event: WorkflowNodeProgress) => void
): Promise<McpCallResult> {
  const workflowId = workflowIdFromTool(tool);
  const startedAt = performance.now();
  const fail = (message: string): McpCallResult => ({
    serverId: WORKFLOW_TOOL_SERVER_ID,
    serverName: WORKFLOW_TOOL_SERVER_NAME,
    tool: tool.id,
    latencyMs: Math.round(performance.now() - startedAt),
    isError: true,
    content: [{ type: "text", text: message }],
    text: message,
    structuredContent: { workflowId, status: "failed" }
  });

  const stored = store.getWorkflow(workflowId);
  if (!stored) {
    return fail(`工作流「${workflowId}」不存在或已被删除，无法作为工具调用。`);
  }

  const stack = callStack.getStore() ?? new Set<string>();
  if (stack.has(workflowId)) {
    return fail(`工作流「${workflowId}」检测到递归调用，已阻断以避免无限执行。`);
  }
  if (stack.size >= MAX_WORKFLOW_TOOL_DEPTH) {
    return fail(`工作流工具嵌套超过 ${MAX_WORKFLOW_TOOL_DEPTH} 层，已阻断。`);
  }

  try {
    const result = await callStack.run(new Set([...stack, workflowId]), () =>
      executor.run(stored.definition, args, { ...(onNodeProgress ? { onNodeProgress } : {}) })
    );
    const status = result.run.status;
    const output = finalOutputOf(result.steps);
    const payload = {
      runId: result.run.id,
      workflowId,
      workflowVersion: stored.definition.version,
      status,
      output
    };
    const text = status === "succeeded" ? describeOutput(output) : `工作流「${stored.definition.name}」运行状态：${status}。`;
    return {
      serverId: WORKFLOW_TOOL_SERVER_ID,
      serverName: WORKFLOW_TOOL_SERVER_NAME,
      tool: tool.id,
      latencyMs: Math.round(performance.now() - startedAt),
      isError: status !== "succeeded",
      content: [{ type: "text", text }],
      text,
      structuredContent: payload
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(`工作流「${stored.definition.name}」调用失败：${message}`);
  }
}

function workflowIdFromTool(tool: ToolRecord) {
  const workflowId = tool.endpoint?.slice(WORKFLOW_TOOL_ENDPOINT_PREFIX.length).trim() ?? "";
  if (
    !workflowId ||
    tool.id !== workflowToolId(workflowId) ||
    !tool.endpoint?.startsWith(WORKFLOW_TOOL_ENDPOINT_PREFIX)
  ) {
    throw new PlatformError(`工具「${tool.id}」不是可执行的工作流工具。`, 400);
  }
  return workflowId;
}

function workflowInputSchema(inputs: Array<{ name: string; type: string; required?: boolean; description?: string }>) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const input of inputs) {
    properties[input.name] = {
      type: input.type,
      ...(input.description ? { description: input.description } : {})
    };
    if (input.required) {
      required.push(input.name);
    }
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: true
  };
}

function workflowToolDescription(
  name: string,
  version: number,
  inputs: Array<{ name: string; type: string; required?: boolean }>
) {
  const fields = inputs.length > 0
    ? inputs.map((input) => `${input.name}${input.required ? "（必填）" : ""}`).join("、")
    : "无输入";
  return `以工具方式调用平台工作流「${name}」v${version}，每次调用生成独立运行记录。输入字段：${fields}。`;
}

/** 优先返回 end 节点声明的对外输出，其次回退到最后一个非验证步骤的产物。 */
function finalOutputOf(steps: Array<{ nodeKind: string; output?: unknown }>) {
  const end = [...steps].reverse().find((step) => step.nodeKind === "end");
  const payload = end?.output;
  if (isRecord(payload) && isRecord(payload.outputs)) {
    return payload.outputs;
  }
  const last = [...steps].reverse().find((step) => step.nodeKind !== "verify" && step.output !== undefined);
  return last?.output;
}

function describeOutput(output: unknown) {
  if (output === undefined) {
    return "工作流执行完成，但未声明可用的输出字段。";
  }
  const text = typeof output === "string" ? output : JSON.stringify(output, null, 2);
  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}…` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
