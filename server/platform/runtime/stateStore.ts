import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type {
  AgentRecord,
  AgentWrite,
  LoopIterationRecord,
  RegistrySummary,
  RunMode,
  RunRecord,
  RunStatus,
  StepRecord,
  StepStatus,
  ToolRecord,
  ToolWrite,
  VerifyDimension,
  VerifyResultRecord,
  WorkflowDefinition
} from "../types.js";
import { parseWorkflowDefinition } from "../workflow/dsl.js";

export const PLATFORM_TABLES = [
  "platform_agents",
  "platform_tools",
  "platform_workflows",
  "platform_runs",
  "platform_run_steps",
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
  input TEXT,
  output TEXT,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  duration_ms INTEGER
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
CREATE INDEX IF NOT EXISTS idx_platform_verify_run ON platform_verify_results(run_id);
CREATE INDEX IF NOT EXISTS idx_platform_loops_run ON platform_loop_iterations(run_id);
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

type RunRow = {
  id: string;
  workflow_id: string;
  workflow_version: number;
  status: RunStatus;
  mode: RunMode;
  input: string;
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
  input: string | null;
  output: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
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
    return inserted;
  }

  saveAgent(agent: AgentWrite): AgentRecord {
    const existing = this.getAgent(agent.id);
    const now = new Date().toISOString();
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
    return this.getAgent(agent.id)!;
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
  }): RunRecord {
    const id = `run_${randomUUID()}`;
    this.db
      .prepare(
        `
        INSERT INTO platform_runs
          (id, workflow_id, workflow_version, status, mode, input, step_count, started_at)
        VALUES (?, ?, ?, 'running', ?, ?, 0, ?)
        `
      )
      .run(
        id,
        input.workflowId,
        input.workflowVersion,
        input.mode,
        JSON.stringify(input.workflowInput),
        new Date().toISOString()
      );
    return this.getRun(id)!;
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

  completeStep(id: string, status: StepStatus, output?: unknown, error?: string) {
    const row = this.db
      .prepare("SELECT started_at FROM platform_run_steps WHERE id = ?")
      .get(id) as { started_at: string | null } | undefined;
    const finishedAt = new Date().toISOString();
    this.db
      .prepare("UPDATE platform_run_steps SET status = ?, output = ?, error = ?, finished_at = ?, duration_ms = ? WHERE id = ?")
      .run(
        status,
        output === undefined ? null : JSON.stringify(output),
        error ?? null,
        finishedAt,
        row?.started_at ? Date.parse(finishedAt) - Date.parse(row.started_at) : null,
        id
      );
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
          (id, run_id, step_id, verifier, score, confidence, dimensions, issues, evidence, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      createdAt: row.created_at
    }));
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

function toStepRecord(row: StepRow): StepRecord {
  return {
    id: row.id,
    runId: row.run_id,
    sequence: row.sequence,
    path: row.path,
    nodeId: row.node_id,
    nodeKind: row.node_kind,
    status: row.status,
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
