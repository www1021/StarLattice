import { readFileSync } from "node:fs";
import path from "node:path";
import type { PluginRecord } from "../types.js";

/**
 * 随代码分发的共享插件（课程示例：文献检索、幸运抽奖等）。
 * 插件表没有归属列，所有用户插件本来就对全员可见；
 * 播种只负责把这份清单写进新环境的 plugins.db，同 id 已存在就跳过。
 */
type SharedPluginRow = {
  id: string;
  name: string;
  type: "api" | "code";
  description: string;
  official: number;
  status: string;
  domain: string | null;
  runtime: string | null;
  endpoint: string | null;
  method: string | null;
  calls: number;
  tool_count: number;
  ref_count: number;
  version: string;
  config: Record<string, unknown>;
};

function load(): PluginRecord[] {
  try {
    const file = path.resolve("server", "platform", "plugins", "sharedPlugins.json");
    const rows = JSON.parse(readFileSync(file, "utf8")) as SharedPluginRow[];
    const now = new Date().toISOString();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      description: row.description,
      official: row.official === 1,
      status: row.status as PluginRecord["status"],
      domain: row.domain ?? undefined,
      runtime: row.runtime ?? undefined,
      endpoint: row.endpoint ?? undefined,
      method: row.method ?? undefined,
      calls: row.calls,
      toolCount: row.tool_count,
      references: row.ref_count,
      version: row.version,
      createdAt: now,
      updatedAt: now,
      config: row.config
    }));
  } catch {
    // 文件缺失或损坏时静默跳过，不让播种挡住启动。
    return [];
  }
}

export const SHARED_PLUGINS: PluginRecord[] = load();
