import type { PlatformStateStore } from "../runtime/stateStore.js";
import type { PluginService } from "./pluginService.js";
import type { ToolRecord } from "../types.js";

export const PLUGIN_TOOL_ENDPOINT_PREFIX = "plugin://";
export const PLUGIN_TOOL_SERVER_ID = "platform-plugins";
export const PLUGIN_TOOL_SERVER_NAME = "平台插件";

export function isPluginToolEndpoint(endpoint: string | undefined) {
  return typeof endpoint === "string" && endpoint.startsWith(PLUGIN_TOOL_ENDPOINT_PREFIX);
}

export function pluginToolId(pluginId: string) {
  return `plugin.${pluginId}`;
}

function jsonTypeOf(paramType: string | undefined): string {
  if (paramType === "int" || paramType === "number") {
    return "number";
  }
  if (paramType === "bool" || paramType === "boolean") {
    return "boolean";
  }
  if (paramType === "list" || paramType === "array") {
    return "array";
  }
  return "string";
}

type ParamGroup = {
  name: string;
  description?: string;
  type?: string;
  required?: boolean;
  default?: string;
  enabled?: boolean;
};

/** 从插件的参数分组定义推导 function calling 的 JSON schema。 */
function pluginToolSchema(config: Record<string, unknown>): Record<string, unknown> {
  const groups = config.paramGroups as
    | { header?: ParamGroup[]; query?: ParamGroup[]; body?: ParamGroup[] }
    | undefined;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const param of [...(groups?.query ?? []), ...(groups?.body ?? []), ...(groups?.header ?? [])]) {
    if (!param?.name || param.enabled === false) {
      continue;
    }
    properties[param.name] = {
      type: jsonTypeOf(param.type),
      description: param.description?.trim() || param.name
    };
    if (param.required === true) {
      required.push(param.name);
    }
  }
  return { type: "object", properties, required, additionalProperties: true };
}

/**
 * 把「插件页」里状态为已启用（active）的用户插件同步为 Agent 可挂的工具：
 * 工具 id 为 plugin.<插件 id>，endpoint 为 plugin://<插件 id>，输入 schema
 * 来自插件的参数分组定义。官方插件是展示目录（无真实密钥/代码），不同步。
 * 每次全量重建：先清掉旧同步记录，再按当前插件列表写入，删插件即自动摘除工具。
 */
export function syncPluginTools(pluginService: PluginService, store: PlatformStateStore): ToolRecord[] {
  store.deleteToolsWithEndpointPrefix(PLUGIN_TOOL_ENDPOINT_PREFIX);
  const tools: ToolRecord[] = [];
  const { plugins } = pluginService.list();
  for (const view of plugins) {
    if (view.official || view.status !== "active") {
      continue;
    }
    const detail = pluginService.get(view.id);
    if (!detail) {
      continue;
    }
    tools.push(
      store.saveTool(
        {
          id: pluginToolId(view.id),
          name: `插件：${view.name}`,
          type: "builtin",
          schema: pluginToolSchema(detail.config ?? {}),
          endpoint: `${PLUGIN_TOOL_ENDPOINT_PREFIX}${view.id}`,
          description: detail.description,
          enabled: true
        },
        // 插件目前没有账号归属概念，工具全员可见，与插件页保持一致。
        null
      )
    );
  }
  return tools;
}
