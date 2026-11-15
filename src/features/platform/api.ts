import type {
  AgentRecord,
  AgentVersionsResponse,
  ApprovalDecision,
  BindKnowledgeResponse,
  EvolutionAlert,
  EvolutionCandidate,
  EvolutionChange,
  EvolutionDataset,
  EvolutionEvaluation,
  EvolutionGateDecision,
  EvolutionLedger,
  EvolutionObservation,
  EvolutionOverview,
  EvolutionRelease,
  EvolutionRollout,
  KnowledgeBaseOverview,
  KnowledgeCitation,
  KnowledgeDocument,
  InteractionRecord,
  InteractionResponse,
  McpCallResponse,
  McpRefreshResponse,
  McpServerView,
  McpServerWrite,
  MetricsReport,
  ModelProfileView,
  NodeTypesResponse,
  PlatformIssue,
  RegistryOverview,
  ReclaimerStatusView,
  RollbackAgentResponse,
  RunRecord,
  SaveAgentResponse,
  SaveTeamResponse,
  SaveToolResponse,
  SaveWorkflowResponse,
  SchedulerLeadershipView,
  SchedulerProcessView,
  SchedulerWorkerView,
  StarterKnowledgePack,
  StepRecord,
  TeamRecord,
  ToolRecord,
  TraceResponse,
  WhatIfResponse,
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
  return requestFrom<T>(`/api/platform${path}`, init);
}

async function requestFrom<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
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

function knowledgeRequest<T>(path: string, init?: RequestInit): Promise<T> {
  return requestFrom<T>(`/api/knowledge${path}`, init);
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

  startRun: (workflowId: string, input: Record<string, unknown>, stopAfter?: string) =>
    request<{ run: RunRecord }>("/runs", {
      method: "POST",
      body: JSON.stringify({ workflowId, input, async: true, ...(stopAfter ? { stopAfter } : {}) })
    }),

  listRuns: (limit = 20) => request<{ runs: RunRecord[] }>(`/runs?limit=${limit}`),

  trace: (runId: string) => request<TraceResponse>(`/runs/${encodeURIComponent(runId)}/trace`),

  schedulerWorkers: () =>
    request<{
      workers: SchedulerWorkerView[];
      processes: SchedulerProcessView[];
      workerId: string;
    }>("/scheduler/workers"),

  schedulerLeadership: () =>
    request<{ leadership?: SchedulerLeadershipView; reclaimer?: ReclaimerStatusView }>(
      "/scheduler/leadership"
    ),

  reclaimNow: (force = false) =>
    request<Record<string, unknown>>("/scheduler/reclaim", {
      method: "POST",
      body: JSON.stringify({ force })
    }),

  whatIf: (input: {
    runId?: string;
    tasks?: unknown[];
    capacity?: number;
    policies?: string[];
  }) =>
    request<WhatIfResponse>("/scheduler/whatif", {
      method: "POST",
      body: JSON.stringify(input)
    }),

  resumeRun: (runId: string) =>
    request<{ run: RunRecord; resumedFrom: string }>(
      `/runs/${encodeURIComponent(runId)}/resume`,
      { method: "POST" }
    ),

  killSchedulerWorker: (workerId: string) =>
    request<{ workerId: string; killed: boolean; aborted: number }>(
      `/scheduler/workers/${encodeURIComponent(workerId)}/kill`,
      { method: "POST" }
    ),

  metricsSummary: (workflowId?: string, limit = 200) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (workflowId) {
      params.set("workflowId", workflowId);
    }
    return request<MetricsReport>(`/metrics/summary?${params.toString()}`);
  },


  cancelRun: (runId: string) =>
    request<{ run: RunRecord }>(`/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" }),

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

  listInteractions: (runId?: string, status?: InteractionRecord["status"]) => {
    const params = new URLSearchParams();
    if (runId) {
      params.set("runId", runId);
    }
    if (status) {
      params.set("status", status);
    }
    return request<{ interactions: InteractionRecord[] }>(
      `/interactions${params.size ? `?${params.toString()}` : ""}`
    );
  },

  respondInteraction: (
    interactionId: string,
    values: Record<string, unknown>,
    actor?: string
  ) =>
    request<InteractionResponse>(`/interactions/${encodeURIComponent(interactionId)}/respond`, {
      method: "POST",
      body: JSON.stringify({ values, ...(actor ? { actor } : {}) })
    }),

  listModels: () => request<{ models: ModelProfileView[]; total: number }>("/models"),
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

  knowledgeStarterPacks: () => knowledgeRequest<{ packs: StarterKnowledgePack[] }>("/starter-packs"),

  importKnowledgeStarterPack: (id: string) =>
    knowledgeRequest<{ base: { id: string; name: string } }>(
      `/starter-packs/${encodeURIComponent(id)}/import`,
      { method: "POST" }
    ),

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
    request<SaveToolResponse>("/tools", { method: "POST", body: JSON.stringify(tool) }),

  evolution: {
    overview: () => requestFrom<EvolutionOverview>("/api/evolution/overview"),

    releases: (workflowId?: string) =>
      requestFrom<{ releases: EvolutionRelease[] }>(
        `/api/evolution/releases${workflowId ? `?workflowId=${encodeURIComponent(workflowId)}` : ""}`
      ),

    release: (id: string) =>
      requestFrom<{
        release: EvolutionRelease;
        integrity: { hash: string; verified: boolean };
        artifactSummary: {
          workflowId: string;
          workflowVersion: number;
          workflowCount: number;
          agentCount: number;
        };
      }>(`/api/evolution/releases/${encodeURIComponent(id)}`),

    createBaseline: (input: { workflowId: string; version?: number; createdBy?: string; label?: string }) =>
      requestFrom<{ release: EvolutionRelease }>("/api/evolution/releases", {
        method: "POST",
        body: JSON.stringify(input)
      }),

    rollbackRelease: (id: string, input: { reviewer?: string; reason?: string }) =>
      requestFrom<{ release: EvolutionRelease; restored: EvolutionRelease }>(
        `/api/evolution/releases/${encodeURIComponent(id)}/rollback`,
        { method: "POST", body: JSON.stringify(input) }
      ),

    candidates: (workflowId?: string) =>
      requestFrom<{ candidates: EvolutionCandidate[] }>(
        `/api/evolution/candidates${workflowId ? `?workflowId=${encodeURIComponent(workflowId)}` : ""}`
      ),

    candidate: (id: string) =>
      requestFrom<{ candidate: EvolutionCandidate; evaluations: EvolutionEvaluation[] }>(
        `/api/evolution/candidates/${encodeURIComponent(id)}`
      ),

    createCandidate: (input: {
      workflowId: string;
      baseReleaseId?: string;
      title: string;
      summary?: string;
      source?: EvolutionCandidate["source"];
      proposedBy?: string;
      changes: Array<Omit<EvolutionChange, "id"> & { id?: string }>;
    }) =>
      requestFrom<{ candidate: EvolutionCandidate }>("/api/evolution/candidates", {
        method: "POST",
        body: JSON.stringify(input)
      }),

    gate: (id: string, input: { mode?: "stub" | "live"; datasetId?: string; maxCases?: number }) =>
      requestFrom<{
        candidate: EvolutionCandidate;
        evaluationRun: EvolutionEvaluation;
        decision: EvolutionGateDecision;
      }>(`/api/evolution/candidates/${encodeURIComponent(id)}/gate`, {
        method: "POST",
        body: JSON.stringify(input)
      }),

    approve: (id: string, input: { reviewer: string; comment?: string }) =>
      requestFrom<{ candidate: EvolutionCandidate }>(
        `/api/evolution/candidates/${encodeURIComponent(id)}/approve`,
        { method: "POST", body: JSON.stringify(input) }
      ),

    reject: (id: string, input: { reviewer?: string; comment?: string }) =>
      requestFrom<{ candidate: EvolutionCandidate }>(
        `/api/evolution/candidates/${encodeURIComponent(id)}/reject`,
        { method: "POST", body: JSON.stringify(input) }
      ),

    promote: (id: string, input: { reviewer: string; comment?: string; canaryPercent?: number }) =>
      requestFrom<{
        candidate: EvolutionCandidate;
        release: EvolutionRelease;
        rollout?: EvolutionRollout;
      }>(`/api/evolution/candidates/${encodeURIComponent(id)}/promote`, {
        method: "POST",
        body: JSON.stringify(input)
      }),

    rollouts: () =>
      requestFrom<{ rollouts: EvolutionRollout[] }>("/api/evolution/rollouts"),

    rollout: (id: string) =>
      requestFrom<{
        rollout: EvolutionRollout;
        observations: EvolutionObservation[];
        guardrail?: Record<string, unknown>;
      }>(`/api/evolution/rollouts/${encodeURIComponent(id)}`),

    promoteRollout: (id: string, input: { reviewer: string }) =>
      requestFrom<{ rollout: EvolutionRollout; release: EvolutionRelease }>(
        `/api/evolution/rollouts/${encodeURIComponent(id)}/promote`,
        { method: "POST", body: JSON.stringify(input) }
      ),

    stopRollout: (id: string, input: { reviewer?: string; reason?: string }) =>
      requestFrom<{ rollout: EvolutionRollout; release: EvolutionRelease }>(
        `/api/evolution/rollouts/${encodeURIComponent(id)}/stop`,
        { method: "POST", body: JSON.stringify(input) }
      ),

    alerts: (acknowledged?: boolean) =>
      requestFrom<{ alerts: EvolutionAlert[] }>(
        `/api/evolution/alerts${acknowledged === undefined ? "" : `?acknowledged=${acknowledged}`}`
      ),

    acknowledgeAlert: (id: string) =>
      requestFrom<{ alert: EvolutionAlert }>(
        `/api/evolution/alerts/${encodeURIComponent(id)}/ack`,
        { method: "POST" }
      ),

    ledger: (limit = 200) =>
      requestFrom<EvolutionLedger>(`/api/evolution/ledger?limit=${limit}`),

    datasets: (workflowId?: string) =>
      requestFrom<{ datasets: EvolutionDataset[] }>(
        `/api/evolution/datasets${workflowId ? `?workflowId=${encodeURIComponent(workflowId)}` : ""}`
      )
  }
};
