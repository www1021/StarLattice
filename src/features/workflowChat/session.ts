/** 工作流会话的纯逻辑：与 11000 行的 main.tsx 隔离，便于单独测试。 */

export type WorkflowInputVariable = {
  name: string;
  type: string;
  required?: boolean;
};

export type WorkflowChatOption = {
  id: string;
  name: string;
};

/**
 * 把对话里的一句自然语言映射到工作流的结构化输入。
 * 字符串字段统一填这句话，避免 subject / grade 这类必填字段为空导致校验直接失败；
 * 其余类型给零值。想精确控制各字段的值，去画布的调试面板里填。
 */
export function buildWorkflowChatInput(
  variables: WorkflowInputVariable[],
  text: string
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const variable of variables) {
    if (!variable.name) {
      continue;
    }
    switch (variable.type) {
      case "number":
        input[variable.name] = 0;
        break;
      case "boolean":
        input[variable.name] = false;
        break;
      case "object":
        input[variable.name] = {};
        break;
      default:
        input[variable.name] = text;
    }
  }
  return input;
}

/** 从 GET /workflows/:id 的返回体里安全取出输入声明，坏数据一律当空数组。 */
export function readWorkflowVariables(detail: unknown): WorkflowInputVariable[] {
  const record = detail as {
    workflow?: { definition?: { inputs?: unknown } };
  } | null;
  const inputs = record?.workflow?.definition?.inputs;
  if (!Array.isArray(inputs)) {
    return [];
  }
  return inputs
    .filter((item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && !Array.isArray(item)
    )
    .map((item) => ({
      name: typeof item.name === "string" ? item.name : "",
      type: typeof item.type === "string" ? item.type : "string",
      required: item.required === true
    }))
    .filter((item) => Boolean(item.name));
}

/** 从 GET /workflows 的返回体里取出可选工作流列表。 */
export function readWorkflowOptions(payload: unknown): WorkflowChatOption[] {
  const workflows = (payload as { workflows?: unknown } | null)?.workflows;
  if (!Array.isArray(workflows)) {
    return [];
  }
  return workflows
    .filter((item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && !Array.isArray(item)
    )
    .map((item) => ({
      id: typeof item.id === "string" ? item.id : "",
      name: typeof item.name === "string" ? item.name : ""
    }))
    .filter((item) => Boolean(item.id));
}
