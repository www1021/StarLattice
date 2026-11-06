import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  NODE_KINDS,
  type HttpMethod,
  type NodeKind,
  type VerifyCheck,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowVariable,
  type WorkflowVariableType
} from "../types.js";

const VARIABLE_TYPES = new Set<WorkflowVariableType>(["string", "number", "boolean", "object"]);
const HTTP_METHODS = new Set<string>(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const VERIFY_CHECK_TYPES = new Set<VerifyCheck["type"]>(["number_match"]);

export class WorkflowSyntaxError extends Error {
  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "WorkflowSyntaxError";
  }
}

export function parseWorkflowDefinition(value: unknown): WorkflowDefinition {
  const root = asRecord(value, "workflow");
  const nodes = asArray(root.nodes, "nodes").map((node, index) => parseNode(node, `nodes[${index}]`));
  return {
    id: requireString(root.id, "id"),
    name: requireString(root.name, "name"),
    version: requireInteger(root.version, "version"),
    description: optionalString(root.description, "description"),
    inputs: root.inputs === undefined ? [] : asArray(root.inputs, "inputs").map((item, index) => parseVariable(item, `inputs[${index}]`)),
    nodes,
    edges: root.edges === undefined ? [] : asArray(root.edges, "edges").map((item, index) => parseEdge(item, `edges[${index}]`)),
    knowledgeBaseIds: parseKnowledgeBaseIds(root.knowledgeBaseIds),
    teamId: optionalString(root.teamId, "teamId")
  };
}

/** 读取 workflow 目录下的内置 DSL 文件（*.json），单个文件解析失败直接抛出文件名。 */
export function loadBuiltinWorkflows(
  directory = path.resolve("server", "platform", "workflow")
): WorkflowDefinition[] {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      const raw = JSON.parse(readFileSync(path.join(directory, file), "utf8")) as unknown;
      try {
        return parseWorkflowDefinition(raw);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new WorkflowSyntaxError(file, detail);
      }
    });
}

function parseNode(value: unknown, location: string): WorkflowNode {
  const record = asRecord(value, location);
  const id = requireString(record.id, `${location}.id`);
  const kind = requireString(record.kind, `${location}.kind`);
  if (!(NODE_KINDS as readonly string[]).includes(kind)) {
    throw new WorkflowSyntaxError(`${location}.kind`, `未知节点类型 "${kind}"，仅支持 ${NODE_KINDS.join(" / ")}`);
  }
  const base = {
    id,
    title: optionalString(record.title, `${location}.title`),
    description: optionalString(record.description, `${location}.description`),
    inputs: record.inputs === undefined ? undefined : asRecord(record.inputs, `${location}.inputs`)
  };

  switch (kind as NodeKind) {
    case "start":
      return { ...base, kind: "start" };
    case "end":
      return { ...base, kind: "end" };
    case "agent":
      return {
        ...base,
        kind: "agent",
        agent: requireString(record.agent, `${location}.agent`),
        agentVersion: parseAgentVersion(record.agentVersion, `${location}.agentVersion`),
        prompt: optionalString(record.prompt, `${location}.prompt`)
      };
    case "tool":
      return {
        ...base,
        kind: "tool",
        tool: requireString(record.tool, `${location}.tool`),
        args: record.args === undefined ? undefined : asRecord(record.args, `${location}.args`)
      };
    case "knowledge":
      return {
        ...base,
        kind: "knowledge",
        query: requireString(record.query, `${location}.query`),
        knowledgeBaseIds:
          record.knowledgeBaseIds === undefined
            ? undefined
            : parseStringArray(record.knowledgeBaseIds, `${location}.knowledgeBaseIds`),
        topK:
          record.topK === undefined
            ? undefined
            : requireInteger(record.topK, `${location}.topK`)
      };
    case "http": {
      const method = requireString(record.method, `${location}.method`).toUpperCase();
      if (!HTTP_METHODS.has(method)) {
        throw new WorkflowSyntaxError(
          `${location}.method`,
          `HTTP 方法只支持 ${[...HTTP_METHODS].join(" / ")}`
        );
      }
      return {
        ...base,
        kind: "http",
        method: method as HttpMethod,
        url: requireString(record.url, `${location}.url`),
        headers:
          record.headers === undefined
            ? undefined
            : parseStringRecord(record.headers, `${location}.headers`),
        requestBody: record.requestBody,
        timeoutMs:
          record.timeoutMs === undefined
            ? undefined
            : requireInteger(record.timeoutMs, `${location}.timeoutMs`)
      };
    }
    case "llm":
      return {
        ...base,
        kind: "llm",
        prompt: requireString(record.prompt, `${location}.prompt`),
        system: optionalString(record.system, `${location}.system`),
        model: optionalString(record.model, `${location}.model`),
        thinking:
          record.thinking === undefined
            ? undefined
            : requireBoolean(record.thinking, `${location}.thinking`),
        temperature:
          record.temperature === undefined
            ? undefined
            : requireNumber(record.temperature, `${location}.temperature`),
        maxTokens:
          record.maxTokens === undefined
            ? undefined
            : requireInteger(record.maxTokens, `${location}.maxTokens`)
      };
    case "template":
      return {
        ...base,
        kind: "template",
        template: requireString(record.template, `${location}.template`)
      };
    case "subworkflow":
      return {
        ...base,
        kind: "subworkflow",
        workflowId: requireString(record.workflowId, `${location}.workflowId`),
        workflowVersion: parseAgentVersion(record.workflowVersion, `${location}.workflowVersion`),
        outputs:
          record.outputs === undefined
            ? undefined
            : parseStringRecord(record.outputs, `${location}.outputs`)
      };
    case "parallel":
      return {
        ...base,
        kind: "parallel",
        branches: asArray(record.branches, `${location}.branches`).map((branch, index) =>
          parseNode(branch, `${location}.branches[${index}]`)
        )
      };
    case "condition":
      return {
        ...base,
        kind: "condition",
        when: requireString(record.when, `${location}.when`),
        then: asArray(record.then, `${location}.then`).map((item, index) => parseNode(item, `${location}.then[${index}]`)),
        else:
          record.else === undefined
            ? undefined
            : asArray(record.else, `${location}.else`).map((item, index) => parseNode(item, `${location}.else[${index}]`))
      };
    case "loop":
      return {
        ...base,
        kind: "loop",
        maxIterations: requireInteger(record.maxIterations, `${location}.maxIterations`),
        while: optionalString(record.while, `${location}.while`),
        patience:
          record.patience === undefined
            ? undefined
            : requireInteger(record.patience, `${location}.patience`),
        budget:
          record.budget === undefined
            ? undefined
            : parseLoopBudget(record.budget, `${location}.budget`),
        body: asArray(record.body, `${location}.body`).map((item, index) => parseNode(item, `${location}.body[${index}]`))
      };
    case "verify":
      return {
        ...base,
        kind: "verify",
        verifier: requireString(record.verifier, `${location}.verifier`),
        rubric:
          record.rubric === undefined
            ? undefined
            : asArray(record.rubric, `${location}.rubric`).map((item, index) => requireString(item, `${location}.rubric[${index}]`)),
        threshold: record.threshold === undefined ? undefined : requireNumber(record.threshold, `${location}.threshold`),
        required:
          record.required === undefined
            ? undefined
            : parseStringArray(record.required, `${location}.required`),
        expectedKeywords:
          record.expectedKeywords === undefined
            ? undefined
            : parseStringArray(record.expectedKeywords, `${location}.expectedKeywords`),
        minChars:
          record.minChars === undefined
            ? undefined
            : requireInteger(record.minChars, `${location}.minChars`),
        verifiers:
          record.verifiers === undefined
            ? undefined
            : parseStringArray(record.verifiers, `${location}.verifiers`),
        requireEvidence:
          record.requireEvidence === undefined
            ? undefined
            : requireBoolean(record.requireEvidence, `${location}.requireEvidence`),
        checks:
          record.checks === undefined
            ? undefined
            : asArray(record.checks, `${location}.checks`).map((item, index) =>
                parseVerifyCheck(item, `${location}.checks[${index}]`)
              )
      };
    case "approve":
      return {
        ...base,
        kind: "approve",
        instructions: optionalString(record.instructions, `${location}.instructions`),
        assignee: optionalString(record.assignee, `${location}.assignee`),
        timeoutMs:
          record.timeoutMs === undefined
            ? undefined
            : requireInteger(record.timeoutMs, `${location}.timeoutMs`)
      };
    case "human": {
      const fields =
        record.fields === undefined
          ? undefined
          : asArray(record.fields, `${location}.fields`).map((item, index) =>
              parseHumanField(item, `${location}.fields[${index}]`)
            );
      return {
        ...base,
        kind: "human",
        prompt: requireString(record.prompt, `${location}.prompt`),
        fields,
        submitLabel: optionalString(record.submitLabel, `${location}.submitLabel`),
        assignee: optionalString(record.assignee, `${location}.assignee`),
        timeoutMs:
          record.timeoutMs === undefined
            ? undefined
            : requireInteger(record.timeoutMs, `${location}.timeoutMs`)
      };
    }
  }
}

const HUMAN_FIELD_TYPES = new Set(["text", "textarea", "number", "boolean", "select"]);

function parseHumanField(value: unknown, location: string) {
  const record = asRecord(value, location);
  const type = optionalString(record.type, `${location}.type`) ?? "text";
  if (!HUMAN_FIELD_TYPES.has(type)) {
    throw new WorkflowSyntaxError(
      `${location}.type`,
      `未知的输入类型 "${type}"，仅支持 ${[...HUMAN_FIELD_TYPES].join(" / ")}`
    );
  }
  const options =
    record.options === undefined
      ? undefined
      : asArray(record.options, `${location}.options`).map((item, index) =>
          requireString(item, `${location}.options[${index}]`)
        );
  if (type === "select" && (!options || options.length === 0)) {
    throw new WorkflowSyntaxError(`${location}.options`, "select 字段至少需要一个选项");
  }
  const defaultValue = record.defaultValue;
  if (
    defaultValue !== undefined &&
    typeof defaultValue !== "string" &&
    typeof defaultValue !== "number" &&
    typeof defaultValue !== "boolean"
  ) {
    throw new WorkflowSyntaxError(`${location}.defaultValue`, "默认值只能是字符串、数字或布尔值");
  }
  return {
    key: requireString(record.key, `${location}.key`),
    label: requireString(record.label, `${location}.label`),
    type: type as "text" | "textarea" | "number" | "boolean" | "select",
    required:
      record.required === undefined ? undefined : requireBoolean(record.required, `${location}.required`),
    options,
    defaultValue,
    placeholder: optionalString(record.placeholder, `${location}.placeholder`),
    description: optionalString(record.description, `${location}.description`)
  };
}

function parseStringArray(value: unknown, location: string): string[] {
  return asArray(value, location).map((item, index) => requireString(item, `${location}[${index}]`));
}

function parseVerifyCheck(value: unknown, location: string): VerifyCheck {
  const record = asRecord(value, location);
  const type = requireString(record.type, `${location}.type`);
  if (!VERIFY_CHECK_TYPES.has(type as VerifyCheck["type"])) {
    throw new WorkflowSyntaxError(
      `${location}.type`,
      `未知的验证检查类型 "${type}"，仅支持 ${[...VERIFY_CHECK_TYPES].join(" / ")}`
    );
  }
  return {
    type: type as VerifyCheck["type"],
    tolerance:
      record.tolerance === undefined ? undefined : requireNumber(record.tolerance, `${location}.tolerance`)
  };
}

function parseStringRecord(value: unknown, location: string): Record<string, string> {
  const record = asRecord(value, location);
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, requireString(item, `${location}.${key}`)])
  );
}

function parseLoopBudget(value: unknown, location: string) {
  const record = asRecord(value, location);
  return {
    maxDurationMs:
      record.maxDurationMs === undefined
        ? undefined
        : requireInteger(record.maxDurationMs, `${location}.maxDurationMs`),
    maxTokens:
      record.maxTokens === undefined
        ? undefined
        : requireInteger(record.maxTokens, `${location}.maxTokens`)
  };
}

function parseAgentVersion(value: unknown, location: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const version = requireInteger(value, location);
  if (version < 1) {
    throw new WorkflowSyntaxError(location, "应为正整数");
  }
  return version;
}

function parseKnowledgeBaseIds(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const ids = asArray(value, "knowledgeBaseIds").map((item, index) =>
    requireString(item, `knowledgeBaseIds[${index}]`)
  );
  return [...new Set(ids)];
}

function parseVariable(value: unknown, location: string): WorkflowVariable {
  const record = asRecord(value, location);
  const type = requireString(record.type, `${location}.type`);
  if (!VARIABLE_TYPES.has(type as WorkflowVariableType)) {
    throw new WorkflowSyntaxError(`${location}.type`, `不支持的输入类型 "${type}"`);
  }
  return {
    name: requireString(record.name, `${location}.name`),
    type: type as WorkflowVariableType,
    required: record.required === undefined ? undefined : requireBoolean(record.required, `${location}.required`),
    description: optionalString(record.description, `${location}.description`)
  };
}

function parseEdge(value: unknown, location: string): WorkflowEdge {
  const record = asRecord(value, location);
  return {
    from: requireString(record.from, `${location}.from`),
    to: requireString(record.to, `${location}.to`),
    label: optionalString(record.label, `${location}.label`),
    when: optionalString(record.when, `${location}.when`)
  };
}

function asRecord(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkflowSyntaxError(location, "应为对象");
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, location: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new WorkflowSyntaxError(location, "应为数组");
  }
  return value;
}

function requireString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WorkflowSyntaxError(location, "应为非空字符串");
  }
  return value.trim();
}

function optionalString(value: unknown, location: string): string | undefined {
  return value === undefined ? undefined : requireString(value, location);
}

function requireInteger(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new WorkflowSyntaxError(location, "应为整数");
  }
  return value;
}

function requireNumber(value: unknown, location: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new WorkflowSyntaxError(location, "应为数字");
  }
  return value;
}

function requireBoolean(value: unknown, location: string): boolean {
  if (typeof value !== "boolean") {
    throw new WorkflowSyntaxError(location, "应为布尔值");
  }
  return value;
}
