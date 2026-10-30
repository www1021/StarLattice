import type {
  AgentRecord,
  NodeTypesResponse,
  PlatformIssue,
  RunRecord,
  SaveAgentResponse,
  SaveToolResponse,
  SaveWorkflowResponse,
  StepRecord,
  ToolRecord,
  TraceResponse,
  WorkflowDefinition,
  WorkflowDetail,
  WorkflowSummary
} from "./types";

export class PlatformApiError extends Error {
  constructor(message: string, readonly issues: PlatformIssue[] = [], readonly status = 0) {
    super(message);
    this.name = "PlatformApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/platform${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }
  });
  const raw = await response.text();
  const payload = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  if (!response.ok) {
    throw new PlatformApiError(
      typeof payload.message === "string" ? payload.message : `请求失败（${response.status}）`,
      Array.isArray(payload.issues) ? (payload.issues as PlatformIssue[]) : [],
      response.status
    );
  }
  return payload as T;
}

export const platformApi = {
  nodeTypes: () => request<NodeTypesResponse>("/node-types"),

  listWorkflows: () => request<{ workflows: WorkflowSummary[] }>("/workflows"),

  getWorkflow: (id: string) => request<{ workflow: WorkflowDetail }>(`/workflows/${encodeURIComponent(id)}`),

  saveWorkflow: (dsl: WorkflowDefinition) =>
    request<SaveWorkflowResponse>("/workflows", { method: "POST", body: JSON.stringify({ dsl }) }),

  startRun: (workflowId: string, input: Record<string, unknown>) =>
    request<{ run: RunRecord }>("/runs", {
      method: "POST",
      body: JSON.stringify({ workflowId, input, async: true })
    }),

  listRuns: (limit = 20) => request<{ runs: RunRecord[] }>(`/runs?limit=${limit}`),

  trace: (runId: string) => request<TraceResponse>(`/runs/${encodeURIComponent(runId)}/trace`),

  retryRun: (runId: string) =>
    request<{ run: RunRecord; retryOf: string }>(`/runs/${encodeURIComponent(runId)}/retry`, {
      method: "POST"
    }),

  retryStep: (runId: string, stepId: string) =>
    request<{ step: StepRecord; trace: TraceResponse }>(
      `/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/retry`,
      { method: "POST" }
    ),

  listAgents: () => request<{ agents: AgentRecord[]; total: number }>("/agents"),

  getAgent: (id: string) => request<{ agent: AgentRecord }>(`/agents/${encodeURIComponent(id)}`),

  saveAgent: (agent: Partial<AgentRecord> & { id: string; name: string }) =>
    request<SaveAgentResponse>("/agents", { method: "POST", body: JSON.stringify(agent) }),

  listTools: () => request<{ tools: ToolRecord[]; total: number }>("/tools"),

  getTool: (id: string) => request<{ tool: ToolRecord }>(`/tools/${encodeURIComponent(id)}`),

  saveTool: (tool: Partial<ToolRecord> & { id: string; name: string; type: ToolRecord["type"] }) =>
    request<SaveToolResponse>("/tools", { method: "POST", body: JSON.stringify(tool) })
};
