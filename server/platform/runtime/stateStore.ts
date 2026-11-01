import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type {
  AgentRecord,
  AgentVersionRecord,
  AgentWrite,
  ApprovalDecision,
  ApprovalRecord,
  ApprovalStatus,
  LoopIterationRecord,
  RegistrySummary,
  RunMode,
  RunRecord,
  McpServerConfig,
  McpServerWrite,
  RunStatus,
  StepRecord,
  StepStatus,
  TeamRecord,
  TeamWrite,
  ToolRecord,
  ToolWrite,
  VerifyDimension,
  VerifyResultRecord,
  WorkflowDefinition
} from "../types.js";
import { parseWorkflowDefinition } from "../workflow/dsl.js";

export const PLATFORM_TABLES = [
  "platform_agents",
  "platform_agent_versions",
  "platform_teams",
  "platform_tools",
  "platform_mcp_servers",
  "platform_workflows",
  "platform_runs",
  "platform_run_steps",
  "platform_approvals",
  "platform_verify_results",
  "platform_loop_iterations",
  "platform_eval_tasks"
] as const;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS platform_agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  role TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  tools TEXT NOT NULL DEFAULT '[]',
  model TEXT NOT NULL DEFAULT '',
  capabilities TEXT NOT NULL DEFAULT '[]',
  memory TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_agent_versions (
  agent_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, version)
);

CREATE TABLE IF NOT EXISTS platform_teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  agent_ids TEXT NOT NULL DEFAULT '[]',
  workflow_id TEXT,
  knowledge_base_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_tools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('builtin', 'mcp', 'http')),
  schema TEXT NOT NULL DEFAULT '{}',
  endpoint TEXT,
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('stdio', 'http')),
  command TEXT,
  args TEXT NOT NULL DEFAULT '[]',
  env TEXT NOT NULL DEFAULT '{}',
  url TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_connected_at TEXT,
  last_error TEXT,
  server_name TEXT,
  server_version TEXT,
  protocol_version TEXT,
  last_latency_ms REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_workflows (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  dsl TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (id, version)
);

CREATE TABLE IF NOT EXISTS platform_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  workflow_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'stub',
  input TEXT NOT NULL DEFAULT '{}',
  plan TEXT,
  output TEXT,
  error TEXT,
  step_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER
);

CREATE TABLE IF NOT EXISTS platform_run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES platform_runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  path TEXT NOT NULL,
  node_id TEXT NOT NULL,
  node_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  snapshot TEXT,
  input TEXT,
  output TEXT,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  duration_ms INTEGER
);

CREATE TABLE IF NOT EXISTS platform_approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES platform_runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  title TEXT NOT NULL,
  instructions TEXT,
  assignee TEXT,
  status TEXT NOT NULL,
  context TEXT,
  reviewer TEXT,
  comment TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS platform_verify_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES platform_runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  verifier TEXT NOT NULL DEFAULT '',
  score REAL NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  dimensions TEXT NOT NULL DEFAULT '[]',
  issues TEXT NOT NULL DEFAULT '[]',
  evidence TEXT NOT NULL DEFAULT '[]',
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_loop_iterations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES platform_runs(id) ON DELETE CASCADE,
  loop_node_id TEXT NOT NULL,
  iteration INTEGER NOT NULL,
  score_before REAL,
  score_after REAL,
  action TEXT NOT NULL DEFAULT 'revise',
  changes TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_eval_tasks (
  id TEXT PRIMARY KEY,
  task_set TEXT NOT NULL,
  input TEXT NOT NULL DEFAULT '{}',
  expected TEXT NOT NULL DEFAULT '{}',
  rubric TEXT NOT NULL DEFAULT '[]',
  threshold REAL NOT NULL DEFAULT 0.8,
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_platform_runs_workflow ON platform_runs(workflow_id, started_at);
CREATE INDEX IF NOT EXISTS idx_platform_steps_run ON platform_run_steps(run_id, sequence);
CREATE INDEX IF NOT EXISTS idx_platform_approvals_run ON platform_approvals(run_id, status);
CREATE INDEX IF NOT EXISTS idx_platform_approvals_status ON platform_approvals(status, created_at);
CREATE INDEX IF NOT EXISTS idx_platform_verify_run ON platform_verify_results(run_id);
CREATE INDEX IF NOT EXISTS idx_platform_loops_run ON platform_loop_iterations(run_id);
CREATE INDEX IF NOT EXISTS idx_platform_tools_endpoint ON platform_tools(endpoint);
`;

type WorkflowRow = {
  id: string;
  version: number;
  name: string;
  description: string;
  dsl: string;
  status: string;
  created_at: string;
  updated_at: string;
};

type AgentRow = {
  id: string;
  name: string;
  version: number;
  role: string;
  prompt: string;
  tools: string;
  model: string;
  capabilities: string;
  memory: string;
  enabled: number;
  created_at: string;
  updated_at: string;
};

type AgentVersionRow = {
  agent_id: string;
  version: number;
  snapshot: string;
  created_at: string;
};

type TeamRow = {
  id: string;
  name: string;
  description: string;
  agent_ids: string;
  workflow_id: string | null;
  knowledge_base_ids: string;
  created_at: string;
  updated_at: string;
};

type ToolRow = {
  id: string;
  name: string;
  type: ToolRecord["type"];
  schema: string;
  endpoint: string | null;
  description: string;
  enabled: number;
  created_at: string;
  updated_at: string;
};

type McpServerRow = {
  id: string;
  name: string;
  transport: McpServerConfig["transport"];
  command: string | null;
  args: string;
  env: string;
  url: string | null;
  enabled: number;
  last_connected_at: string | null;
  last_error: string | null;
  server_name: string | null;
  server_version: string | null;
  protocol_version: string | null;
  last_latency_ms: number | null;
  created_at: string;
  updated_at: string;
};

type RunRow = {
  id: string;
  workflow_id: string;
  workflow_version: number;
  status: RunStatus;
  mode: RunMode;
  input: string;
  plan: string | null;
  output: string | null;
  error: string | null;
  step_count: number;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
};

type StepRow = {
  id: string;
  run_id: string;
  sequence: number;
  path: string;
  node_id: string;
  node_kind: StepRecord["nodeKind"];
  status: StepStatus;
  attempts: number;
  snapshot: string | null;
  input: string | null;
  output: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
};

type ApprovalRow = {
  id: string;
  run_id: string;
  step_id: string;
  node_id: string;
  title: string;
  instructions: string | null;
  assignee: string | null;
  status: ApprovalStatus;
  context: string | null;
  reviewer: string | null;
  comment: string | null;
  expires_at: string | null;
  created_at: string;
  decided_at: string | null;
};

type VerifyRow = {
  id: string;
  run_id: string;
  step_id: string;
  verifier: string;
  score: number;
  confidence: number;
  dimensions: string;
  issues: string;
  evidence: string;
  detail: string | null;
  created_at: string;
};

type LoopRow = {
  id: string;
  run_id: string;
  loop_node_id: string;
  iteration: number;
  score_before: number | null;
  score_after: number | null;
  action: string;
  changes: string;
  created_at: string;
};

export type StoredWorkflow = {
  definition: WorkflowDefinition;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowSummary = {
  id: string;
  name: string;
  version: number;
  description: string;
  status: string;
  nodeCount: number;
  createdAt: string;
  updatedAt: string;
};

export type StepSnapshot = {
  stepId: string;
  path: string;
  sequence: number;
  data: {
    outputs: Record<string, unknown>;
    verifyRounds: number;
    lastVerifyScore?: number;
  };
};

export type BeginStepInput = {
  runId: string;
  sequence: number;
  path: string;
  nodeId: string;
  nodeKind: StepRecord["nodeKind"];
  input: unknown;
};

export type RecordVerifyInput = {
  runId: string;
  stepId: string;
  verifier: string;
  score: number;
  confidence: number;
  dimensions: VerifyDimension[];
  issues: string[];
  evidence: string[];
  detail?: Record<string, unknown>;
};

export type RecordLoopInput = {
  runId: string;
  loopNodeId: string;
  iteration: number;
  scoreBefore?: number;
  scoreAfter?: number;
  action: string;
  changes: string[];
};

export class PlatformStateStore {
  readonly dbPath: string;
  private readonly db: Database.Database;

  constructor(dbPath = process.env.PLATFORM_DB_PATH || path.resolve("data", "platform.db")) {
    this.dbPath = dbPath;
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 3000");
    this.db.exec(SCHEMA);
    this.ensureStepColumns();
    this.ensureVerifyColumns();
    this.ensureRunColumns();
    this.ensureMcpColumns();
    this.expireStaleApprovals();
  }

  /** 审批等待点是进程内的；服务重启后没有运行可以恢复，把残留待审明确置为失败/超时。 */
  private expireStaleApprovals() {
    const now = new Date().toISOString();
    const reason = "服务重启，审批等待点已失效，请重新运行工作流。";
    const waitingRuns = this.db
      .prepare("SELECT id FROM platform_runs WHERE status = 'waiting_approval'")
      .all() as Array<{ id: string }>;
    if (waitingRuns.length === 0) {
      return;
    }
    const transaction = this.db.transaction(() => {
      for (const run of waitingRuns) {
        this.db
          .prepare(
            `
            UPDATE platform_runs
            SET status = 'failed', error = ?, finished_at = ?,
                duration_ms = CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER)
            WHERE id = ?
            `
          )
          .run(reason, now, now, run.id);
        this.db
          .prepare(
            "UPDATE platform_run_steps SET status = 'failed', error = ?, finished_at = ? WHERE run_id = ? AND status = 'waiting'"
          )
          .run(reason, now, run.id);
        this.db
          .prepare(
            "UPDATE platform_approvals SET status = 'expired', comment = COALESCE(comment, ?), decided_at = ? WHERE run_id = ? AND status = 'pending'"
          )
          .run(reason, now, run.id);
      }
    });
    transaction();
  }

  private ensureMcpColumns() {
    const columns = this.db
      .prepare("PRAGMA table_info(platform_mcp_servers)")
      .all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    const additions: Array<[string, string]> = [
      ["server_name", "TEXT"],
      ["server_version", "TEXT"],
      ["protocol_version", "TEXT"],
      ["last_latency_ms", "REAL"]
    ];
    for (const [name, type] of additions) {
      if (!names.has(name)) {
        this.db.exec(`ALTER TABLE platform_mcp_servers ADD COLUMN ${name} ${type}`);
      }
    }
  }

  // D1.2 之前的数据库没有 plan 列，启动时补齐。
  private ensureRunColumns() {
    const columns = this.db
      .prepare("PRAGMA table_info(platform_runs)")
      .all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "plan")) {
      this.db.exec("ALTER TABLE platform_runs ADD COLUMN plan TEXT");
    }
  }

  // T1.7 之前的数据库没有 detail 列，启动时补齐。
  private ensureVerifyColumns() {
    const columns = this.db
      .prepare("PRAGMA table_info(platform_verify_results)")
      .all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "detail")) {
      this.db.exec("ALTER TABLE platform_verify_results ADD COLUMN detail TEXT");
    }
  }

  // T1.4 之前的数据库没有 attempts / snapshot，启动时按需补齐，避免删库重来。
  private ensureStepColumns() {
    const columns = this.db
      .prepare("PRAGMA table_info(platform_run_steps)")
      .all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("attempts")) {
      this.db.exec("ALTER TABLE platform_run_steps ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1");
    }
    if (!names.has("snapshot")) {
      this.db.exec("ALTER TABLE platform_run_steps ADD COLUMN snapshot TEXT");
    }
  }

  close() {
    this.db.close();
  }

  health() {
    const rows = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const tables = rows
      .map((row) => row.name)
      .filter((name) => (PLATFORM_TABLES as readonly string[]).includes(name));
    return {
      database: this.dbPath,
      tables,
      tableCount: tables.length,
      expectedTableCount: PLATFORM_TABLES.length
    };
  }

  seedAgents(seeds: AgentWrite[]): number {
    const now = new Date().toISOString();
    const statement = this.db.prepare(
      `
      INSERT INTO platform_agents
        (id, name, version, role, prompt, tools, model, capabilities, memory, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
      `
    );
    let inserted = 0;
    const transaction = this.db.transaction(() => {
      for (const seed of seeds) {
        inserted += statement.run(
          seed.id,
          seed.name,
          seed.version,
          seed.role,
          seed.prompt,
          JSON.stringify(seed.tools),
          seed.model,
          JSON.stringify(seed.capabilities),
          JSON.stringify(seed.memory),
          seed.enabled ? 1 : 0,
          now,
          now
        ).changes;
      }
    });
    transaction();
    const backfill = this.db.transaction(() => {
      for (const seed of seeds) {
        const count = this.db
          .prepare("SELECT COUNT(*) AS total FROM platform_agent_versions WHERE agent_id = ?")
          .get(seed.id) as { total: number };
        if (count.total > 0) {
          continue;
        }
        const stored = this.getAgent(seed.id);
        if (stored) {
          this.recordAgentVersion(stored, stored.updatedAt);
        }
      }
    });
    backfill();
    return inserted;
  }

  saveAgent(agent: AgentWrite): AgentRecord {
    const existing = this.getAgent(agent.id);
    const now = new Date().toISOString();
    if (existing) {
      this.recordAgentVersion(existing, existing.updatedAt);
    }
    this.db
      .prepare(
        `
        INSERT INTO platform_agents
          (id, name, version, role, prompt, tools, model, capabilities, memory, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          version = excluded.version,
          role = excluded.role,
          prompt = excluded.prompt,
          tools = excluded.tools,
          model = excluded.model,
          capabilities = excluded.capabilities,
          memory = excluded.memory,
          enabled = excluded.enabled,
          updated_at = excluded.updated_at
        `
      )
      .run(
        agent.id,
        agent.name,
        agent.version,
        agent.role,
        agent.prompt,
        JSON.stringify(agent.tools),
        agent.model,
        JSON.stringify(agent.capabilities),
        JSON.stringify(agent.memory),
        agent.enabled ? 1 : 0,
        existing?.createdAt ?? now,
        now
      );
    const saved = this.getAgent(agent.id)!;
    this.recordAgentVersion(saved, now);
    return saved;
  }

  getAgent(id: string): AgentRecord | undefined {
    const row = this.db.prepare("SELECT * FROM platform_agents WHERE id = ?").get(id) as AgentRow | undefined;
    return row ? toAgentRecord(row) : undefined;
  }

  listAgents(): AgentRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM platform_agents ORDER BY role ASC, name ASC")
      .all() as AgentRow[];
    return rows.map(toAgentRecord);
  }

  listAgentVersions(agentId: string): AgentVersionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM platform_agent_versions WHERE agent_id = ? ORDER BY version DESC")
      .all(agentId) as AgentVersionRow[];
    return rows.map((row) => ({
      agentId: row.agent_id,
      version: row.version,
      snapshot: JSON.parse(row.snapshot) as AgentWrite,
      createdAt: row.created_at
    }));
  }

  getAgentVersion(agentId: string, version: number): AgentRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM platform_agent_versions WHERE agent_id = ? AND version = ?")
      .get(agentId, version) as AgentVersionRow | undefined;
    if (!row) {
      return undefined;
    }
    const snapshot = JSON.parse(row.snapshot) as AgentWrite;
    return { ...snapshot, createdAt: row.created_at, updatedAt: row.created_at };
  }

  maxAgentVersion(agentId: string): number {
    const row = this.db
      .prepare("SELECT MAX(version) AS version FROM platform_agent_versions WHERE agent_id = ?")
      .get(agentId) as { version: number | null } | undefined;
    return Number(row?.version ?? this.getAgent(agentId)?.version ?? 0);
  }

  rollbackAgent(agentId: string, version: number): AgentRecord | undefined {
    const target = this.getAgentVersion(agentId, version);
    if (!target || !this.getAgent(agentId)) {
      return undefined;
    }
    return this.saveAgent({
      id: target.id,
      name: target.name,
      version: target.version,
      role: target.role,
      prompt: target.prompt,
      tools: target.tools,
      model: target.model,
      capabilities: target.capabilities,
      memory: target.memory,
      enabled: target.enabled
    });
  }

  agentCallCounts(): Record<string, number> {
    const rows = this.db
      .prepare("SELECT output FROM platform_run_steps WHERE node_kind = 'agent' AND status = 'succeeded'")
      .all() as Array<{ output: string | null }>;
    const counts: Record<string, number> = {};
    for (const row of rows) {
      if (!row.output) {
        continue;
      }
      try {
        const parsed = JSON.parse(row.output) as { agent?: unknown };
        if (typeof parsed.agent === "string") {
          counts[parsed.agent] = (counts[parsed.agent] ?? 0) + 1;
        }
      } catch {
        continue;
      }
    }
    return counts;
  }

  saveTeam(team: TeamWrite): TeamRecord {
    const existing = this.getTeam(team.id);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO platform_teams
          (id, name, description, agent_ids, workflow_id, knowledge_base_ids, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          agent_ids = excluded.agent_ids,
          workflow_id = excluded.workflow_id,
          knowledge_base_ids = excluded.knowledge_base_ids,
          updated_at = excluded.updated_at
        `
      )
      .run(
        team.id,
        team.name,
        team.description,
        JSON.stringify(team.agentIds),
        team.workflowId ?? null,
        JSON.stringify(team.knowledgeBaseIds),
        existing?.createdAt ?? now,
        now
      );
    return this.getTeam(team.id)!;
  }

  getTeam(id: string): TeamRecord | undefined {
    const row = this.db.prepare("SELECT * FROM platform_teams WHERE id = ?").get(id) as TeamRow | undefined;
    return row ? toTeamRecord(row) : undefined;
  }

  listTeams(): TeamRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM platform_teams ORDER BY name ASC")
      .all() as TeamRow[];
    return rows.map(toTeamRecord);
  }

  private recordAgentVersion(record: AgentRecord, createdAt: string) {
    const snapshot: AgentWrite = {
      id: record.id,
      name: record.name,
      version: record.version,
      role: record.role,
      prompt: record.prompt,
      tools: record.tools,
      model: record.model,
      capabilities: record.capabilities,
      memory: record.memory,
      enabled: record.enabled
    };
    this.db
      .prepare(
        `
        INSERT INTO platform_agent_versions (agent_id, version, snapshot, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(agent_id, version) DO NOTHING
        `
      )
      .run(record.id, record.version, JSON.stringify(snapshot), createdAt);
  }

  seedTools(seeds: ToolWrite[]): number {
    const now = new Date().toISOString();
    const statement = this.db.prepare(
      `
      INSERT INTO platform_tools
        (id, name, type, schema, endpoint, description, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
      `
    );
    let inserted = 0;
    const transaction = this.db.transaction(() => {
      for (const seed of seeds) {
        inserted += statement.run(
          seed.id,
          seed.name,
          seed.type,
          JSON.stringify(seed.schema),
          seed.endpoint ?? null,
          seed.description,
          seed.enabled ? 1 : 0,
          now,
          now
        ).changes;
      }
    });
    transaction();
    return inserted;
  }

  saveTool(tool: ToolWrite): ToolRecord {
    const existing = this.getTool(tool.id);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO platform_tools
          (id, name, type, schema, endpoint, description, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          type = excluded.type,
          schema = excluded.schema,
          endpoint = excluded.endpoint,
          description = excluded.description,
          enabled = excluded.enabled,
          updated_at = excluded.updated_at
        `
      )
      .run(
        tool.id,
        tool.name,
        tool.type,
        JSON.stringify(tool.schema),
        tool.endpoint ?? null,
        tool.description,
        tool.enabled ? 1 : 0,
        existing?.createdAt ?? now,
        now
      );
    return this.getTool(tool.id)!;
  }

  getTool(id: string): ToolRecord | undefined {
    const row = this.db.prepare("SELECT * FROM platform_tools WHERE id = ?").get(id) as ToolRow | undefined;
    return row ? toToolRecord(row) : undefined;
  }

  listTools(): ToolRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM platform_tools ORDER BY type ASC, name ASC")
      .all() as ToolRow[];
    return rows.map(toToolRecord);
  }

  deleteTool(id: string): boolean {
    return this.db.prepare("DELETE FROM platform_tools WHERE id = ?").run(id).changes > 0;
  }

  deleteToolsWithEndpointPrefix(prefix: string): number {
    return this.db
      .prepare("DELETE FROM platform_tools WHERE endpoint LIKE ? ESCAPE '\\'")
      .run(`${escapeLike(prefix)}%`).changes;
  }

  seedMcpServers(seeds: McpServerWrite[]): number {
    const now = new Date().toISOString();
    const statement = this.db.prepare(
      `
      INSERT INTO platform_mcp_servers
        (id, name, transport, command, args, env, url, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
      `
    );
    let inserted = 0;
    const transaction = this.db.transaction(() => {
      for (const seed of seeds) {
        inserted += statement.run(
          seed.id,
          seed.name,
          seed.transport,
          seed.command ?? null,
          JSON.stringify(seed.args),
          JSON.stringify(seed.env ?? {}),
          seed.url ?? null,
          seed.enabled ? 1 : 0,
          now,
          now
        ).changes;
      }
    });
    transaction();
    return inserted;
  }

  listMcpServers(): McpServerConfig[] {
    const rows = this.db
      .prepare("SELECT * FROM platform_mcp_servers ORDER BY name ASC")
      .all() as McpServerRow[];
    return rows.map(toMcpServerConfig);
  }

  getMcpServer(id: string): McpServerConfig | undefined {
    const row = this.db
      .prepare("SELECT * FROM platform_mcp_servers WHERE id = ?")
      .get(id) as McpServerRow | undefined;
    return row ? toMcpServerConfig(row) : undefined;
  }

  saveMcpServer(server: McpServerWrite, existing?: McpServerConfig): McpServerConfig {
    const previous = existing ?? this.getMcpServer(server.id);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO platform_mcp_servers
          (id, name, transport, command, args, env, url, enabled, last_connected_at, last_error, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          transport = excluded.transport,
          command = excluded.command,
          args = excluded.args,
          env = excluded.env,
          url = excluded.url,
          enabled = excluded.enabled,
          updated_at = excluded.updated_at
        `
      )
      .run(
        server.id,
        server.name,
        server.transport,
        server.command ?? null,
        JSON.stringify(server.args),
        JSON.stringify(server.env ?? previous?.env ?? {}),
        server.url ?? null,
        server.enabled ? 1 : 0,
        previous?.lastConnectedAt ?? null,
        previous?.lastError ?? null,
        previous?.createdAt ?? now,
        now
      );
    return this.getMcpServer(server.id)!;
  }

  deleteMcpServer(id: string): boolean {
    return this.db.prepare("DELETE FROM platform_mcp_servers WHERE id = ?").run(id).changes > 0;
  }

  markMcpServerStatus(
    id: string,
    status: {
      connectedAt?: string;
      error?: string;
      info?: { serverName: string; serverVersion: string; protocolVersion: string };
      latencyMs?: number;
    }
  ) {
    const now = new Date().toISOString();
    if (status.error !== undefined) {
      this.db
        .prepare("UPDATE platform_mcp_servers SET last_error = ?, updated_at = ? WHERE id = ?")
        .run(status.error, now, id);
      return;
    }
    this.db
      .prepare(
        `
        UPDATE platform_mcp_servers
        SET last_error = NULL,
            last_connected_at = ?,
            server_name = COALESCE(?, server_name),
            server_version = COALESCE(?, server_version),
            protocol_version = COALESCE(?, protocol_version),
            last_latency_ms = COALESCE(?, last_latency_ms),
            updated_at = ?
        WHERE id = ?
        `
      )
      .run(
        status.connectedAt ?? now,
        status.info?.serverName ?? null,
        status.info?.serverVersion ?? null,
        status.info?.protocolVersion ?? null,
        status.latencyMs ?? null,
        now,
        id
      );
  }

  registrySummary(): RegistrySummary {
    const agents = this.listAgents();
    const tools = this.listTools();
    const toolsByType: RegistrySummary["toolsByType"] = { builtin: 0, mcp: 0, http: 0 };
    for (const tool of tools) {
      toolsByType[tool.type] += 1;
    }
    return {
      agentCount: agents.length,
      toolCount: tools.length,
      agentsByRole: countBy(agents.map((item) => item.role)),
      toolsByType
    };
  }

  saveWorkflow(definition: WorkflowDefinition) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO platform_workflows (id, version, name, description, dsl, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'published', ?, ?)
        ON CONFLICT(id, version) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          dsl = excluded.dsl,
          updated_at = excluded.updated_at
        `
      )
      .run(
        definition.id,
        definition.version,
        definition.name,
        definition.description ?? "",
        JSON.stringify(definition),
        now,
        now
      );
  }

  getWorkflow(id: string, version?: number): StoredWorkflow | undefined {
    const row =
      version === undefined
        ? (this.db
            .prepare("SELECT * FROM platform_workflows WHERE id = ? ORDER BY version DESC LIMIT 1")
            .get(id) as WorkflowRow | undefined)
        : (this.db
            .prepare("SELECT * FROM platform_workflows WHERE id = ? AND version = ?")
            .get(id, version) as WorkflowRow | undefined);
    if (!row) {
      return undefined;
    }
    return {
      definition: parseWorkflowDefinition(JSON.parse(row.dsl)),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  listWorkflows(): WorkflowSummary[] {
    const rows = this.db
      .prepare(
        `
        SELECT w.* FROM platform_workflows w
        JOIN (
          SELECT id, MAX(version) AS version FROM platform_workflows GROUP BY id
        ) latest ON latest.id = w.id AND latest.version = w.version
        ORDER BY w.updated_at DESC
        `
      )
      .all() as WorkflowRow[];
    return rows.map((row) => {
      const definition = parseWorkflowDefinition(JSON.parse(row.dsl));
      return {
        id: row.id,
        name: row.name,
        version: row.version,
        description: row.description,
        status: row.status,
        nodeCount: definition.nodes.length,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    });
  }

  createRun(input: {
    workflowId: string;
    workflowVersion: number;
    workflowInput: Record<string, unknown>;
    mode: RunMode;
    status?: RunStatus;
    plan?: unknown;
  }): RunRecord {
    const id = `run_${randomUUID()}`;
    this.db
      .prepare(
        `
        INSERT INTO platform_runs
          (id, workflow_id, workflow_version, status, mode, input, plan, step_count, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
        `
      )
      .run(
        id,
        input.workflowId,
        input.workflowVersion,
        input.status ?? "queued",
        input.mode,
        JSON.stringify(input.workflowInput),
        input.plan === undefined ? null : JSON.stringify(input.plan),
        new Date().toISOString()
      );
    return this.getRun(id)!;
  }

  updateRunStatus(id: string, status: RunStatus) {
    this.db.prepare("UPDATE platform_runs SET status = ? WHERE id = ?").run(status, id);
  }

  finishRun(id: string, status: RunStatus, output?: Record<string, unknown>, error?: string) {
    const run = this.getRun(id);
    if (!run) {
      return;
    }
    const finishedAt = new Date().toISOString();
    this.db
      .prepare("UPDATE platform_runs SET status = ?, output = ?, error = ?, finished_at = ?, duration_ms = ? WHERE id = ?")
      .run(
        status,
        output === undefined ? null : JSON.stringify(output),
        error ?? null,
        finishedAt,
        Date.parse(finishedAt) - Date.parse(run.startedAt),
        id
      );
  }

  getRun(id: string): RunRecord | undefined {
    const row = this.db.prepare("SELECT * FROM platform_runs WHERE id = ?").get(id) as RunRow | undefined;
    return row ? toRunRecord(row) : undefined;
  }

  listRuns(limit = 20): RunRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM platform_runs ORDER BY started_at DESC, rowid DESC LIMIT ?")
      .all(Math.min(Math.max(limit, 1), 100)) as RunRow[];
    return rows.map(toRunRecord);
  }

  listRunsForMetrics(workflowIds: string[] = [], limit = 1000): RunRecord[] {
    const capped = Math.min(Math.max(limit, 1), 5000);
    if (workflowIds.length === 0) {
      const rows = this.db
        .prepare("SELECT * FROM platform_runs ORDER BY started_at DESC, rowid DESC LIMIT ?")
        .all(capped) as RunRow[];
      return rows.map(toRunRecord);
    }
    const placeholders = workflowIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM platform_runs WHERE workflow_id IN (${placeholders}) ORDER BY started_at DESC, rowid DESC LIMIT ?`
      )
      .all(...workflowIds, capped) as RunRow[];
    return rows.map(toRunRecord);
  }

  countLoopIterationsByRun(runIds: string[]): Map<string, number> {
    const counts = new Map<string, number>();
    if (runIds.length === 0) {
      return counts;
    }
    const placeholders = runIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT run_id, COUNT(*) AS total FROM platform_loop_iterations WHERE run_id IN (${placeholders}) GROUP BY run_id`
      )
      .all(...runIds) as Array<{ run_id: string; total: number }>;
    for (const row of rows) {
      counts.set(row.run_id, row.total);
    }
    return counts;
  }

  beginStep(input: BeginStepInput): string {
    const id = randomUUID();
    const transaction = this.db.transaction(() => {
      this.db
        .prepare(
          `
          INSERT INTO platform_run_steps
            (id, run_id, sequence, path, node_id, node_kind, status, input, started_at)
          VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)
          `
        )
        .run(
          id,
          input.runId,
          input.sequence,
          input.path,
          input.nodeId,
          input.nodeKind,
          toJson(input.input),
          new Date().toISOString()
        );
      this.db.prepare("UPDATE platform_runs SET step_count = step_count + 1 WHERE id = ?").run(input.runId);
    });
    transaction();
    return id;
  }

  updateStepStatus(id: string, status: StepStatus) {
    this.db.prepare("UPDATE platform_run_steps SET status = ? WHERE id = ?").run(status, id);
  }

  completeStep(
    id: string,
    status: StepStatus,
    output?: unknown,
    error?: string,
    extra: { attempts?: number; snapshot?: string } = {}
  ) {
    const row = this.db
      .prepare("SELECT started_at FROM platform_run_steps WHERE id = ?")
      .get(id) as { started_at: string | null } | undefined;
    const finishedAt = new Date().toISOString();
    this.db
      .prepare(
        `
        UPDATE platform_run_steps
        SET status = ?, output = ?, error = ?, finished_at = ?, duration_ms = ?, attempts = ?, snapshot = ?
        WHERE id = ?
        `
      )
      .run(
        status,
        output === undefined ? null : JSON.stringify(output),
        error ?? null,
        finishedAt,
        row?.started_at ? Date.parse(finishedAt) - Date.parse(row.started_at) : null,
        extra.attempts ?? 1,
        extra.snapshot ?? null,
        id
      );
  }

  // 失败回滚只恢复到最近一次成功步骤的快照，不做反向执行。
  latestSnapshot(runId: string): StepSnapshot | undefined {
    const row = this.db
      .prepare(
        `
        SELECT id, path, sequence, snapshot FROM platform_run_steps
        WHERE run_id = ? AND snapshot IS NOT NULL
        ORDER BY finished_at DESC, sequence DESC LIMIT 1
        `
      )
      .get(runId) as
      | { id: string; path: string; sequence: number; snapshot: string }
      | undefined;
    if (!row) {
      return undefined;
    }
    const data = fromJson<StepSnapshot["data"]>(row.snapshot);
    if (!data || typeof data.outputs !== "object" || data.outputs === null) {
      return undefined;
    }
    return {
      stepId: row.id,
      path: row.path,
      sequence: row.sequence,
      data: {
        outputs: data.outputs,
        verifyRounds: data.verifyRounds ?? 0,
        lastVerifyScore: data.lastVerifyScore
      }
    };
  }

  listSteps(runId: string): StepRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM platform_run_steps WHERE run_id = ? ORDER BY sequence ASC")
      .all(runId) as StepRow[];
    return rows.map(toStepRecord);
  }

  getStep(stepId: string): StepRecord | undefined {
    const row = this.db.prepare("SELECT * FROM platform_run_steps WHERE id = ?").get(stepId) as StepRow | undefined;
    return row ? toStepRecord(row) : undefined;
  }

  nextSequence(runId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM platform_run_steps WHERE run_id = ?")
      .get(runId) as { next: number };
    return row.next;
  }

  recordVerifyResult(input: RecordVerifyInput): string {
    const id = randomUUID();
    this.db
      .prepare(
        `
        INSERT INTO platform_verify_results
          (id, run_id, step_id, verifier, score, confidence, dimensions, issues, evidence, detail, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        id,
        input.runId,
        input.stepId,
        input.verifier,
        input.score,
        input.confidence,
        JSON.stringify(input.dimensions),
        JSON.stringify(input.issues),
        JSON.stringify(input.evidence),
        input.detail === undefined ? null : JSON.stringify(input.detail),
        new Date().toISOString()
      );
    return id;
  }

  listVerifyResults(runId: string): VerifyResultRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM platform_verify_results WHERE run_id = ? ORDER BY rowid ASC")
      .all(runId) as VerifyRow[];
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      stepId: row.step_id,
      verifier: row.verifier,
      score: row.score,
      confidence: row.confidence,
      dimensions: fromJson<VerifyDimension[]>(row.dimensions) ?? [],
      issues: fromJson<string[]>(row.issues) ?? [],
      evidence: fromJson<string[]>(row.evidence) ?? [],
      detail: row.detail === null ? undefined : fromJson<Record<string, unknown>>(row.detail),
      createdAt: row.created_at
    }));
  }

  createApproval(input: {
    runId: string;
    stepId: string;
    nodeId: string;
    title: string;
    instructions?: string;
    assignee?: string;
    context?: Record<string, unknown>;
    expiresAt?: string;
  }): ApprovalRecord {
    const id = `apv_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO platform_approvals
          (id, run_id, step_id, node_id, title, instructions, assignee, status, context, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
        `
      )
      .run(
        id,
        input.runId,
        input.stepId,
        input.nodeId,
        input.title,
        input.instructions ?? null,
        input.assignee ?? null,
        input.context === undefined ? null : JSON.stringify(input.context),
        input.expiresAt ?? null,
        createdAt
      );
    return this.getApproval(id)!;
  }

  getApproval(id: string): ApprovalRecord | undefined {
    const row = this.db.prepare("SELECT * FROM platform_approvals WHERE id = ?").get(id) as
      | ApprovalRow
      | undefined;
    return row ? toApprovalRecord(row) : undefined;
  }

  listApprovals(options: { runId?: string; status?: ApprovalStatus; limit?: number } = {}): ApprovalRecord[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (options.runId) {
      clauses.push("run_id = ?");
      params.push(options.runId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const rows = this.db
      .prepare(`SELECT * FROM platform_approvals ${where} ORDER BY created_at ASC, rowid ASC LIMIT ?`)
      .all(...params, limit) as ApprovalRow[];
    return rows.map(toApprovalRecord);
  }

  decideApproval(
    id: string,
    status: ApprovalDecision | "expired",
    reviewer?: string,
    comment?: string
  ): ApprovalRecord | undefined {
    this.db
      .prepare(
        "UPDATE platform_approvals SET status = ?, reviewer = ?, comment = ?, decided_at = ? WHERE id = ? AND status = 'pending'"
      )
      .run(status, reviewer ?? null, comment ?? null, new Date().toISOString(), id);
    return this.getApproval(id);
  }

  recordLoopIteration(input: RecordLoopInput): string {
    const id = randomUUID();
    this.db
      .prepare(
        `
        INSERT INTO platform_loop_iterations
          (id, run_id, loop_node_id, iteration, score_before, score_after, action, changes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        id,
        input.runId,
        input.loopNodeId,
        input.iteration,
        input.scoreBefore ?? null,
        input.scoreAfter ?? null,
        input.action,
        JSON.stringify(input.changes),
        new Date().toISOString()
      );
    return id;
  }

  listLoopIterations(runId: string): LoopIterationRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM platform_loop_iterations WHERE run_id = ? ORDER BY loop_node_id ASC, iteration ASC")
      .all(runId) as LoopRow[];
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      loopNodeId: row.loop_node_id,
      iteration: row.iteration,
      scoreBefore: row.score_before ?? undefined,
      scoreAfter: row.score_after ?? undefined,
      action: row.action,
      changes: fromJson<string[]>(row.changes) ?? [],
      createdAt: row.created_at
    }));
  }
}

function toApprovalRecord(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    nodeId: row.node_id,
    title: row.title,
    instructions: row.instructions ?? undefined,
    assignee: row.assignee ?? undefined,
    status: row.status,
    context: row.context === null ? undefined : (JSON.parse(row.context) as Record<string, unknown>),
    reviewer: row.reviewer ?? undefined,
    comment: row.comment ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    createdAt: row.created_at,
    decidedAt: row.decided_at ?? undefined
  };
}

function toStepRecord(row: StepRow): StepRecord {
  return {
    id: row.id,
    runId: row.run_id,
    sequence: row.sequence,
    path: row.path,
    nodeId: row.node_id,
    nodeKind: row.node_kind,
    status: row.status,
    attempts: row.attempts,
    input: fromJson(row.input),
    output: fromJson(row.output),
    error: row.error ?? undefined,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    durationMs: row.duration_ms ?? undefined
  };
}

function toRunRecord(row: RunRow): RunRecord {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowVersion: row.workflow_version,
    status: row.status,
    mode: row.mode,
    input: fromJson<Record<string, unknown>>(row.input) ?? {},
    plan: row.plan === null ? undefined : fromJson(row.plan),
    output: row.output === null ? undefined : fromJson<Record<string, unknown>>(row.output),
    error: row.error ?? undefined,
    stepCount: row.step_count,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    durationMs: row.duration_ms ?? undefined
  };
}

function toAgentRecord(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    role: row.role,
    prompt: row.prompt,
    tools: fromJson<string[]>(row.tools) ?? [],
    model: row.model,
    capabilities: fromJson<AgentRecord["capabilities"]>(row.capabilities) ?? [],
    memory: fromJson<Record<string, unknown>>(row.memory) ?? {},
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toTeamRecord(row: TeamRow): TeamRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    agentIds: fromJson<string[]>(row.agent_ids) ?? [],
    workflowId: row.workflow_id ?? undefined,
    knowledgeBaseIds: fromJson<string[]>(row.knowledge_base_ids) ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toToolRecord(row: ToolRow): ToolRecord {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    schema: fromJson<Record<string, unknown>>(row.schema) ?? {},
    endpoint: row.endpoint ?? undefined,
    description: row.description,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toMcpServerConfig(row: McpServerRow): McpServerConfig {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    command: row.command ?? undefined,
    args: fromJson<string[]>(row.args) ?? [],
    env: fromJson<Record<string, string>>(row.env) ?? {},
    url: row.url ?? undefined,
    enabled: row.enabled === 1,
    lastConnectedAt: row.last_connected_at ?? undefined,
    lastError: row.last_error ?? undefined,
    serverName: row.server_name ?? undefined,
    serverVersion: row.server_version ?? undefined,
    protocolVersion: row.protocol_version ?? undefined,
    lastLatencyMs: row.last_latency_ms ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function toJson(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value);
}

function fromJson<T>(value: string | null): T | undefined {
  if (value === null) {
    return undefined;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}
