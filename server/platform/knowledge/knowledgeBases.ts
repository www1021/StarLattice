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

const UNREADABLE_NAME_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^kb[_-]/i, reason: "不要使用 kb_ 开头的内部 ID" },
  { pattern: /^T\d+-kb\b/i, reason: "不要使用测试编号" },
  { pattern: /^\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/, reason: "不要用日期开头命名" },
  { pattern: /\d{8,}/, reason: "不要使用时间戳或长编号" },
  { pattern: /^(test|tmp|temp|copy|debug)[-_0-9]/i, reason: "不要使用测试或临时前缀" }
];

/**
 * 知识库名称是评委和同事看到的第一层信息，必须说明用途。
 * ID、时间戳和测试编号仍会作为数据库主键存在，但不允许充当名称。
 */
export function parseKnowledgeBaseName(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PlatformError("知识库名称不能为空。", 400);
  }
  const name = value.trim();
  if (name.length < 4 || name.length > 40) {
    throw new PlatformError("知识库名称需为 4–40 个字符。", 400);
  }
  for (const rule of UNREADABLE_NAME_PATTERNS) {
    if (rule.pattern.test(name)) {
      throw new PlatformError(
        `知识库名称要能看懂用途：${rule.reason}。建议使用「场景-主题-用途」，例如 教育-初中数学-分数教案语料。`,
        400
      );
    }
  }
  if (!/[\u4e00-\u9fa5A-Za-z]/.test(name)) {
    throw new PlatformError(
      "知识库名称至少包含一个中文或英文词语，不能只有编号。",
      400
    );
  }
  return name;
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
