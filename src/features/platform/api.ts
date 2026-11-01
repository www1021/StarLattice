import type {
  AgentRecord,
  AgentVersionsResponse,
  ApprovalDecision,
  BindKnowledgeResponse,
  KnowledgeBaseOverview,
  KnowledgeCitation,
  KnowledgeDocument,
  McpCallResponse,
  McpRefreshResponse,
  McpServerView,
  McpServerWrite,
  MetricsReport,
  NodeTypesResponse,
  PlatformIssue,
  RegistryOverview,
  RollbackAgentResponse,
  RunRecord,
  SaveAgentResponse,
  SaveTeamResponse,
  SaveToolResponse,
  SaveWorkflowResponse,
  StepRecord,
  TeamRecord,
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

/** 上传复用既有知识库服务（multipart），其余管理接口走平台命名空间。 */
export async function uploadKnowledgeDocument(
  baseId: string,
  file: File
): Promise<{ document: KnowledgeDocument }> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(
    `/api/knowledge/bases/${encodeURIComponent(baseId)}/documents`,
    { method: "POST", body: form }
  );
  const raw = await response.text();
  const payload = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  if (!response.ok) {
    throw new PlatformApiError(
      typeof payload.message === "string" ? payload.message : `上传失败（${response.status}）`,
      [],
      response.status
    );
  }
  return payload as { document: KnowledgeDocument };
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

  getWorkflow: (id: string, version?: number) =>
    request<{ workflow: WorkflowDetail }>(
      `/workflows/${encodeURIComponent(id)}${version === undefined ? "" : `?version=${version}`}`
    ),

  saveWorkflow: (dsl: WorkflowDefinition) =>
    request<SaveWorkflowResponse>("/workflows", { method: "POST", body: JSON.stringify({ dsl }) }),

  startRun: (workflowId: string, input: Record<string, unknown>) =>
    request<{ run: RunRecord }>("/runs", {
      method: "POST",
      body: JSON.stringify({ workflowId, input, async: true })
    }),

  listRuns: (limit = 20) => request<{ runs: RunRecord[] }>(`/runs?limit=${limit}`),

  trace: (runId: string) => request<TraceResponse>(`/runs/${encodeURIComponent(runId)}/trace`),

  metricsSummary: (workflowId?: string, limit = 200) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (workflowId) {
      params.set("workflowId", workflowId);
    }
    return request<MetricsReport>(`/metrics/summary?${params.toString()}`);
  },


  retryRun: (runId: string) =>
    request<{ run: RunRecord; retryOf: string }>(`/runs/${encodeURIComponent(runId)}/retry`, {
      method: "POST"
    }),

  retryStep: (runId: string, stepId: string) =>
    request<{ step: StepRecord; trace: TraceResponse }>(
      `/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/retry`,
      { method: "POST" }
    ),

  decideApproval: (
    approvalId: string,
    input: { decision: ApprovalDecision; reviewer?: string; comment?: string }
  ) =>
    request<{ approvalId: string; decision: ApprovalDecision }>(
      `/approvals/${encodeURIComponent(approvalId)}/decide`,
      { method: "POST", body: JSON.stringify(input) }
    ),

  listAgents: () => request<{ agents: AgentRecord[]; total: number }>("/agents"),

  getAgent: (id: string) => request<{ agent: AgentRecord }>(`/agents/${encodeURIComponent(id)}`),

  saveAgent: (agent: Partial<AgentRecord> & { id: string; name: string }) =>
    request<SaveAgentResponse>("/agents", { method: "POST", body: JSON.stringify(agent) }),

  listAgentVersions: (id: string) =>
    request<AgentVersionsResponse>(`/agents/${encodeURIComponent(id)}/versions`),

  rollbackAgent: (id: string, version: number) =>
    request<RollbackAgentResponse>(`/agents/${encodeURIComponent(id)}/rollback`, {
      method: "POST",
      body: JSON.stringify({ version })
    }),

  registry: () => request<RegistryOverview>("/registry"),

  listTeams: () => request<{ teams: TeamRecord[]; total: number }>("/teams"),

  saveTeam: (team: Partial<TeamRecord> & { id: string; name: string }) =>
    request<SaveTeamResponse>("/teams", { method: "POST", body: JSON.stringify(team) }),

  knowledgeBases: () => request<KnowledgeBaseOverview>("/knowledge-bases"),

  createKnowledgeBase: (name: string) =>
    request<{ base: { id: string; name: string } }>("/knowledge-bases", {
      method: "POST",
      body: JSON.stringify({ name })
    }),

  deleteKnowledgeBase: (id: string) =>
    request<Record<string, never>>(`/knowledge-bases/${encodeURIComponent(id)}`, { method: "DELETE" }),

  knowledgeDocuments: (id: string) =>
    request<{ documents: KnowledgeDocument[] }>(`/knowledge-bases/${encodeURIComponent(id)}/documents`),

  deleteKnowledgeDocument: (baseId: string, documentId: string) =>
    request<Record<string, never>>(
      `/knowledge-bases/${encodeURIComponent(baseId)}/documents/${encodeURIComponent(documentId)}`,
      { method: "DELETE" }
    ),

  searchKnowledge: (query: string, knowledgeBaseIds: string[], topK = 6) =>
    request<{ citations: KnowledgeCitation[] }>("/knowledge-bases/search", {
      method: "POST",
      body: JSON.stringify({ query, knowledgeBaseIds, topK })
    }),

  bindKnowledgeBase: (
    id: string,
    target: { teamId?: string; workflowId?: string; bound: boolean }
  ) =>
    request<BindKnowledgeResponse>(`/knowledge-bases/${encodeURIComponent(id)}/bind`, {
      method: "POST",
      body: JSON.stringify(target)
    }),

  mcpServers: () =>
    request<{ servers: McpServerView[]; total: number; connected: number }>("/mcp/servers"),

  saveMcpServer: (server: McpServerWrite) =>
    request<{ server: McpServerView; created: boolean }>("/mcp/servers", {
      method: "POST",
      body: JSON.stringify(server)
    }),

  refreshMcpServer: (id: string) =>
    request<McpRefreshResponse>(`/mcp/servers/${encodeURIComponent(id)}/refresh`, { method: "POST" }),

  callMcpTool: (id: string, tool: string, args: Record<string, unknown>) =>
    request<McpCallResponse>(`/mcp/servers/${encodeURIComponent(id)}/call`, {
      method: "POST",
      body: JSON.stringify({ tool, args })
    }),

  deleteMcpServer: (id: string) =>
    request<{ deleted: boolean }>(`/mcp/servers/${encodeURIComponent(id)}`, { method: "DELETE" }),

  listTools: () => request<{ tools: ToolRecord[]; total: number }>("/tools"),

  getTool: (id: string) => request<{ tool: ToolRecord }>(`/tools/${encodeURIComponent(id)}`),

  saveTool: (tool: Partial<ToolRecord> & { id: string; name: string; type: ToolRecord["type"] }) =>
    request<SaveToolResponse>("/tools", { method: "POST", body: JSON.stringify(tool) })
};
