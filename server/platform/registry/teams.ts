import { PlatformError, type TeamWrite } from "../types.js";

const idPattern = /^[a-z0-9][a-z0-9._-]*$/i;

export function parseTeamWrite(body: unknown, existing?: TeamWrite): TeamWrite {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new PlatformError("请求体必须是 JSON 对象。", 400);
  }
  const record = body as Record<string, unknown>;
  const id = requireId(record.id);
  const name = requireText(record.name, "name");

  return {
    id,
    name,
    description:
      record.description === undefined ? (existing?.description ?? "") : optionalText(record.description, "description"),
    agentIds:
      record.agentIds === undefined ? (existing?.agentIds ?? []) : parseStringList(record.agentIds, "agentIds"),
    workflowId:
      record.workflowId === undefined ? existing?.workflowId : optionalText(record.workflowId, "workflowId") || undefined,
    knowledgeBaseIds:
      record.knowledgeBaseIds === undefined
        ? (existing?.knowledgeBaseIds ?? [])
        : parseStringList(record.knowledgeBaseIds, "knowledgeBaseIds")
  };
}

function requireId(value: unknown): string {
  const id = requireText(value, "id");
  if (!idPattern.test(id)) {
    throw new PlatformError("id 只允许字母、数字、下划线和短横线，且以字母或数字开头。", 400);
  }
  return id;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PlatformError(`缺少必填字段：${field}。`, 400);
  }
  return value.trim();
}

function optionalText(value: unknown, field: string): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "string") {
    throw new PlatformError(`${field} 必须是字符串。`, 400);
  }
  return value.trim();
}

function parseStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new PlatformError(`${field} 必须是字符串数组。`, 400);
  }
  return [...new Set(value.map((item) => (item as string).trim()))];
}
