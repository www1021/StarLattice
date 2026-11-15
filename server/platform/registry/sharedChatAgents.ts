import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 随代码分发的共享对话智能体（研途引航系列）。
 * 启动时由 registerPlatform 播种进 chat_agents，owner_id 为空、全员可见；
 * 同 id 已存在的行不会被覆盖，各环境的本地改动优先。
 */
export type SharedChatAgentSeed = {
  id: string;
  name: string;
  description?: string;
  avatar?: string;
  role?: string;
  prompt: string;
  model: string;
  tools?: string[];
  capabilities?: string[];
  memory?: Record<string, unknown>;
  config?: Record<string, unknown>;
  enabled?: boolean;
  /** 共享资产的版本；高于库里旧行时同步提示词与工具绑定，避免新代码配老数据。 */
  version?: number;
};

function load(): SharedChatAgentSeed[] {
  try {
    const file = path.resolve("server", "platform", "registry", "sharedChatAgents.json");
    return JSON.parse(readFileSync(file, "utf8")) as SharedChatAgentSeed[];
  } catch {
    // 文件缺失或损坏时静默跳过，不让播种挡住启动。
    return [];
  }
}

export const SHARED_CHAT_AGENTS: SharedChatAgentSeed[] = load();
