import {
  PlatformError,
  type KnowledgeBaseOverview,
  type KnowledgeWorkflowRef,
  type TeamRecord,
  type TeamWrite,
  type WorkflowDefinition
} from "../types.js";

/** 平台层只需要知识库的最小能力，具体实现由 server/index.ts 适配现有 knowledgeProvider。 */
export type KnowledgeProviderPort = {
  listBases(): Promise<KnowledgeBaseSummaryLike[]>;
  createBase(name: string): unknown;
  renameBase(id: string, name: string): unknown;
  deleteBase(id: string): void;
  listDocuments(id: string): Promise<unknown[]>;
  deleteDocument(baseId: string, documentId: string): void;
  search(options: { query: string; knowledgeBaseIds: string[]; topK?: number }): Promise<unknown[]>;
};

export type KnowledgeBaseSummaryLike = {
  id: string;
  name: string;
  source: string;
  providerStatus?: string;
  documentCount: number;
  createdAt: string;
};

export type KnowledgeBindingRequest = {
  teamId?: string;
  workflowId?: string;
  bound: boolean;
};

export function parseKnowledgeBaseName(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PlatformError("知识库名称不能为空。", 400);
  }
  return value.trim();
}

export function parseKnowledgeBindingRequest(value: unknown): KnowledgeBindingRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PlatformError("请求体必须是 JSON 对象。", 400);
  }
  const record = value as Record<string, unknown>;
  const teamId = optionalId(record.teamId, "teamId");
  const workflowId = optionalId(record.workflowId, "workflowId");
  if ((teamId ? 1 : 0) + (workflowId ? 1 : 0) !== 1) {
    throw new PlatformError("teamId 与 workflowId 必须二选一。", 400);
  }
  if (record.bound !== undefined && typeof record.bound !== "boolean") {
    throw new PlatformError("bound 必须是布尔值。", 400);
  }
  return { teamId, workflowId, bound: record.bound !== false };
}

export function bindTeamKnowledge(team: TeamRecord, baseId: string, bound: boolean): TeamWrite {
  return {
    id: team.id,
    name: team.name,
    description: team.description,
    agentIds: team.agentIds,
    workflowId: team.workflowId,
    knowledgeBaseIds: toggleId(team.knowledgeBaseIds, baseId, bound)
  };
}

export function bindWorkflowKnowledge(
  definition: WorkflowDefinition,
  baseId: string,
  bound: boolean
): WorkflowDefinition {
  const current = definition.knowledgeBaseIds ?? [];
  const next = toggleId(current, baseId, bound);
  if (sameIds(current, next)) {
    return definition;
  }
  // 升版本可保证绑定在服务重启、内置 DSL 重新播种后仍是最新版本。
  return {
    ...definition,
    version: definition.version + 1,
    knowledgeBaseIds: next.length > 0 ? next : undefined
  };
}

export function buildKnowledgeOverview(
  bases: KnowledgeBaseSummaryLike[],
  teams: TeamRecord[],
  workflows: KnowledgeWorkflowRef[]
): KnowledgeBaseOverview {
  return {
    bases: bases.map((base) => ({
      id: base.id,
      name: base.name,
      source: base.source,
      providerStatus: base.providerStatus,
      documentCount: base.documentCount,
      createdAt: base.createdAt,
      teamIds: teams.filter((team) => team.knowledgeBaseIds.includes(base.id)).map((team) => team.id),
      workflowIds: workflows.filter((workflow) => workflow.knowledgeBaseIds.includes(base.id)).map((workflow) => workflow.id)
    })),
    teams,
    workflows
  };
}

function optionalId(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new PlatformError(`${field} 必须是非空字符串。`, 400);
  }
  return value.trim();
}

function toggleId(ids: string[], baseId: string, bound: boolean): string[] {
  return bound
    ? ids.includes(baseId) ? [...ids] : [...ids, baseId]
    : ids.filter((id) => id !== baseId);
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
