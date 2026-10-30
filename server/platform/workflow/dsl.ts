import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  NODE_KINDS,
  type NodeKind,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowVariable,
  type WorkflowVariableType
} from "../types.js";

const VARIABLE_TYPES = new Set<WorkflowVariableType>(["string", "number", "boolean", "object"]);

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
    edges: root.edges === undefined ? [] : asArray(root.edges, "edges").map((item, index) => parseEdge(item, `edges[${index}]`))
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
    case "agent":
      return {
        ...base,
        kind: "agent",
        agent: requireString(record.agent, `${location}.agent`),
        prompt: optionalString(record.prompt, `${location}.prompt`)
      };
    case "tool":
      return {
        ...base,
        kind: "tool",
        tool: requireString(record.tool, `${location}.tool`),
        args: record.args === undefined ? undefined : asRecord(record.args, `${location}.args`)
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
        threshold: record.threshold === undefined ? undefined : requireNumber(record.threshold, `${location}.threshold`)
      };
  }
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
    label: optionalString(record.label, `${location}.label`)
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
