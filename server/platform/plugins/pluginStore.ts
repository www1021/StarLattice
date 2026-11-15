import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PluginRecord, PluginStatus, PluginType } from "../types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('api', 'code')),
  description TEXT NOT NULL DEFAULT '',
  official INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  domain TEXT,
  runtime TEXT,
  endpoint TEXT,
  method TEXT,
  calls INTEGER NOT NULL DEFAULT 0,
  tool_count INTEGER NOT NULL DEFAULT 1,
  ref_count INTEGER NOT NULL DEFAULT 0,
  version TEXT NOT NULL DEFAULT '0.1.0',
  config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export type PluginRow = {
  id: string;
  name: string;
  type: PluginType;
  description: string;
  official: number;
  status: PluginStatus;
  domain: string | null;
  runtime: string | null;
  endpoint: string | null;
  method: string | null;
  calls: number;
  tool_count: number;
  ref_count: number;
  version: string;
  config: string;
  created_at: string;
  updated_at: string;
};

function rowToRecord(row: PluginRow): PluginRecord {
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(row.config) as Record<string, unknown>;
  } catch {
    config = {};
  }
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    description: row.description,
    official: row.official === 1,
    status: row.status,
    domain: row.domain ?? undefined,
    runtime: row.runtime ?? undefined,
    endpoint: row.endpoint ?? undefined,
    method: row.method ?? undefined,
    calls: row.calls,
    toolCount: row.tool_count,
    references: row.ref_count,
    version: row.version,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    config
  };
}

function recordToRow(record: PluginRecord): PluginRow {
  return {
    id: record.id,
    name: record.name,
    type: record.type,
    description: record.description,
    official: record.official ? 1 : 0,
    status: record.status,
    domain: record.domain ?? null,
    runtime: record.runtime ?? null,
    endpoint: record.endpoint ?? null,
    method: record.method ?? null,
    calls: record.calls,
    tool_count: record.toolCount,
    ref_count: record.references,
    version: record.version,
    config: JSON.stringify(record.config ?? {}),
    created_at: record.createdAt,
    updated_at: record.updatedAt
  };
}

/**
 * 插件落库：每个用户自建插件一行，官方插件不落这张表（由 catalog 直接给出）。
 * 沿用平台其它模块的约定，单独开一个 data/plugins.db，不污染 platform.db。
 */
export class PluginStore {
  private readonly db: Database.Database;

  constructor(dbPath = process.env.PLUGINS_DB_PATH || path.resolve("data", "plugins.db")) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  list(): PluginRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM plugins ORDER BY updated_at DESC")
      .all() as PluginRow[];
    return rows.map(rowToRecord);
  }

  get(id: string): PluginRecord | undefined {
    const row = this.db.prepare("SELECT * FROM plugins WHERE id = ?").get(id) as
      | PluginRow
      | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  /**
   * 播种随代码分发的共享插件（如课程示例）。同 id 已存在就跳过，本机改动优先。
   * 插件表本身没有归属列——所有用户插件对全员可见，播种只是让新环境也拿到这批。
   */
  seedShared(seeds: PluginRecord[]): number {
    let inserted = 0;
    const transaction = this.db.transaction(() => {
      for (const seed of seeds) {
        const row = recordToRow(seed);
        inserted += this.db
          .prepare(
            `INSERT OR IGNORE INTO plugins (
              id, name, type, description, official, status, domain, runtime, endpoint,
              method, calls, tool_count, ref_count, version, config, created_at, updated_at
            ) VALUES (
              @id, @name, @type, @description, @official, @status, @domain, @runtime, @endpoint,
              @method, @calls, @tool_count, @ref_count, @version, @config, @created_at, @updated_at
            )`
          )
          .run(row).changes;
      }
    });
    transaction();
    return inserted;
  }

  create(input: Omit<PluginRecord, "createdAt" | "updatedAt"> & { createdAt?: string }): PluginRecord {
    const now = new Date().toISOString();
    const record: PluginRecord = {
      ...input,
      createdAt: input.createdAt ?? now,
      updatedAt: now
    };
    const row = recordToRow(record);
    this.db
      .prepare(
        `INSERT INTO plugins (
          id, name, type, description, official, status, domain, runtime, endpoint,
          method, calls, tool_count, ref_count, version, config, created_at, updated_at
        ) VALUES (
          @id, @name, @type, @description, @official, @status, @domain, @runtime, @endpoint,
          @method, @calls, @tool_count, @ref_count, @version, @config, @created_at, @updated_at
        )`
      )
      .run(row);
    return record;
  }

  update(id: string, patch: Partial<PluginRecord>): PluginRecord {
    const existing = this.get(id);
    if (!existing) {
      throw new Error("plugin-not-found");
    }
    const merged: PluginRecord = {
      ...existing,
      ...patch,
      id: existing.id,
      official: existing.official,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString()
    };
    const row = recordToRow(merged);
    this.db
      .prepare(
        `UPDATE plugins SET
          name = @name, type = @type, description = @description, status = @status,
          domain = @domain, runtime = @runtime, endpoint = @endpoint, method = @method,
          calls = @calls, tool_count = @tool_count, ref_count = @ref_count,
          version = @version, config = @config, updated_at = @updated_at
        WHERE id = @id`
      )
      .run(row);
    return merged;
  }

  incrementCalls(id: string, by = 1): void {
    this.db.prepare("UPDATE plugins SET calls = calls + ? WHERE id = ?").run(by, id);
  }

  remove(id: string): boolean {
    const result = this.db.prepare("DELETE FROM plugins WHERE id = ?").run(id);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}

export function newPluginId(): string {
  return `pl-${randomUUID().slice(0, 8)}`;
}
