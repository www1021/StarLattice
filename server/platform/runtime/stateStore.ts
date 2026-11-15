import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { currentAuth, ownerScope, ownerValue, ownerVisibleScope } from "../../auth/context.js";
import { ensureOwnerColumnsFor, PERSONAL_TABLES } from "../../auth/ownership.js";
import type {
  AgentRecord,
  AgentVersionRecord,
  AgentWrite,
  ApprovalDecision,
  ApprovalRecord,
  ApprovalStatus,
  HumanField,
  InteractionRecord,
  InteractionStatus,
  LoopIterationRecord,
  RegistrySummary,
  RunMode,
  RunRecord,
  RunCheckpoint,
  RunNodeRecord,
  RunNodeStatus,
  McpServerConfig,
  McpServerWrite,
  RunStatus,
  SchedulerAttempt,
  SchedulerAttemptStatus,
  SchedulerLease,
  SchedulerLeaseStatus,
  SchedulerQueueEntry,
  SchedulerQueueStatus,
  SchedulerWorker,
  SchedulerWorkerStatus,
  StepRecord,
  StepStatus,
  TeamRecord,
  TeamWrite,
  ToolRecord,
  ToolSource,
  ToolWrite,
  VerifyDimension,
  VerifyResultRecord,
  WorkflowDefinition
} from "../types.js";
import { parseWorkflowDefinition } from "../workflow/dsl.js";
import { PlatformError } from "../types.js";
import type {
  EvaluationDataset,
  EvaluationRun,
  EvolutionAlert,
  EvolutionCandidate,
  LedgerEvent,
  LedgerEventType,
  ReleaseManifest,
  ReleaseRollout,
  ReleaseStatus,
  RolloutArm,
  RolloutObservation,
  RolloutStatus,
  RunReleaseAssignment
} from "../evolution/types.js";
import { canonicalJson, sha256 } from "../evolution/util.js";

export const PLATFORM_TABLES = [
  "platform_agents",
  "chat_agents",
  "platform_agent_versions",
  "platform_teams",
  "platform_tools",
  "platform_mcp_servers",
  "platform_workflows",
  "platform_runs",
  "platform_run_steps",
  "platform_scheduler_leases",
  "platform_scheduler_queue",
  "platform_scheduler_workers",
  "platform_scheduler_attempts",
  "platform_run_nodes",
  "platform_run_checkpoints",
  "platform_scheduler_leader",
  "platform_approvals",
  "platform_interactions",
  "platform_verify_results",
  "platform_loop_iterations",
  "platform_eval_tasks",
  "platform_release_manifests",
  "platform_evolution_candidates",
  "platform_evaluation_datasets",
  "platform_evaluation_runs",
  "platform_release_rollouts",
  "platform_run_assignments",
  "platform_evolution_observations",
  "platform_evolution_alerts",
  "platform_evolution_ledger"
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

-- 用户自建智能体单独一张表：内置那批留在 platform_agents 里全员共享、只读，
-- 自建的只对 owner_id 本人可见。版本与记忆仍按 agent_id 共享同一套表，
-- 这样工作流按 id 引用时不用关心它到底住在哪张表。
CREATE TABLE IF NOT EXISTS chat_agents (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  tools TEXT NOT NULL DEFAULT '[]',
  capabilities TEXT NOT NULL DEFAULT '[]',
  memory TEXT NOT NULL DEFAULT '{}',
  config TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
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
  updated_at TEXT NOT NULL,
  owner_id TEXT
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
  definition TEXT,
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

CREATE TABLE IF NOT EXISTS platform_scheduler_leases (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT,
  task_id TEXT,
  task_path TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'released', 'expired')),
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  released_at TEXT,
  release_reason TEXT
);

CREATE TABLE IF NOT EXISTS platform_scheduler_queue (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  path TEXT NOT NULL,
  priority REAL NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'claimed', 'running', 'succeeded', 'failed', 'skipped', 'cancelled', 'expired')
  ),
  enqueued_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  wait_ms INTEGER,
  reason TEXT,
  required_capability TEXT,
  priority_class INTEGER NOT NULL DEFAULT 0,
  effective_priority REAL,
  profile TEXT,
  agent_id TEXT,
  claimed_by TEXT,
  claim_expires_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  deadline_at TEXT
);

CREATE TABLE IF NOT EXISTS platform_scheduler_workers (
  id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  pid INTEGER,
  slot INTEGER,
  lane TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  stopped_at TEXT,
  stop_reason TEXT,
  meta TEXT
);

CREATE TABLE IF NOT EXISTS platform_scheduler_attempts (
  id TEXT PRIMARY KEY,
  queue_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  worker_id TEXT,
  agent_id TEXT,
  status TEXT NOT NULL,
  lease_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  wait_ms INTEGER,
  error TEXT,
  trace TEXT,
  UNIQUE (queue_id, attempt)
);

CREATE TABLE IF NOT EXISTS platform_run_nodes (
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  path TEXT NOT NULL,
  status TEXT NOT NULL,
  priority REAL NOT NULL DEFAULT 0,
  ready_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  PRIMARY KEY (run_id, node_id)
);

CREATE TABLE IF NOT EXISTS platform_run_checkpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_scheduler_leader (
  id TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
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

CREATE TABLE IF NOT EXISTS platform_interactions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES platform_runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  fields TEXT NOT NULL DEFAULT '[]',
  context TEXT,
  status TEXT NOT NULL,
  response TEXT,
  actor TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS platform_verify_results (  id TEXT PRIMARY KEY,
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
  model_before TEXT,
  model_after TEXT,
  changes TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_agent_memory (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS platform_release_manifests (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL,
  origin TEXT NOT NULL,
  parent_release_id TEXT,
  candidate_id TEXT,
  artifact TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  change_summary TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  activated_at TEXT,
  retired_at TEXT,
  UNIQUE (workflow_id, version)
);

CREATE TABLE IF NOT EXISTS platform_evolution_candidates (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  base_release_id TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  changes TEXT NOT NULL DEFAULT '[]',
  proposed_by TEXT NOT NULL,
  status TEXT NOT NULL,
  gate TEXT,
  security TEXT,
  eval_run_id TEXT,
  draft_release_id TEXT,
  promoted_release_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  decision_comment TEXT
);

CREATE TABLE IF NOT EXISTS platform_evaluation_datasets (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  description TEXT NOT NULL DEFAULT '',
  cases TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  UNIQUE (workflow_id, name, version)
);

CREATE TABLE IF NOT EXISTS platform_evaluation_runs (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  base_release_id TEXT NOT NULL,
  candidate_release_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  decision TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS platform_release_rollouts (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  base_release_id TEXT NOT NULL,
  percent INTEGER NOT NULL,
  status TEXT NOT NULL,
  min_samples_per_arm INTEGER NOT NULL DEFAULT 3,
  max_error_rate_delta REAL NOT NULL DEFAULT 0.05,
  max_score_drop REAL NOT NULL DEFAULT 0.05,
  rollback_reason TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS platform_run_assignments (
  run_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  base_release_id TEXT,
  experiment_id TEXT,
  arm TEXT NOT NULL,
  rollout_id TEXT,
  assignment_key TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_evolution_observations (
  id TEXT PRIMARY KEY,
  rollout_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  arm TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  status TEXT NOT NULL,
  passed INTEGER NOT NULL DEFAULT 0,
  score REAL,
  duration_ms INTEGER,
  tokens INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (rollout_id, run_id)
);

CREATE TABLE IF NOT EXISTS platform_evolution_alerts (
  id TEXT PRIMARY KEY,
  severity TEXT NOT NULL,
  kind TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  acknowledged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_evolution_ledger (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_platform_releases_workflow ON platform_release_manifests(workflow_id, version);
CREATE INDEX IF NOT EXISTS idx_platform_candidates_workflow ON platform_evolution_candidates(workflow_id, created_at);
CREATE INDEX IF NOT EXISTS idx_platform_rollouts_workflow ON platform_release_rollouts(workflow_id, status);
CREATE INDEX IF NOT EXISTS idx_platform_observations_rollout ON platform_evolution_observations(rollout_id, arm);
CREATE INDEX IF NOT EXISTS idx_platform_assignments_release ON platform_run_assignments(release_id);
CREATE INDEX IF NOT EXISTS idx_platform_runs_workflow ON platform_runs(workflow_id, started_at);CREATE INDEX IF NOT EXISTS idx_platform_steps_run ON platform_run_steps(run_id, sequence);
CREATE INDEX IF NOT EXISTS idx_platform_approvals_run ON platform_approvals(run_id, status);
CREATE INDEX IF NOT EXISTS idx_platform_approvals_status ON platform_approvals(status, created_at);
CREATE INDEX IF NOT EXISTS idx_platform_verify_run ON platform_verify_results(run_id);
CREATE INDEX IF NOT EXISTS idx_platform_loops_run ON platform_loop_iterations(run_id);
CREATE INDEX IF NOT EXISTS idx_platform_tools_endpoint ON platform_tools(endpoint);
CREATE INDEX IF NOT EXISTS idx_platform_leases_agent ON platform_scheduler_leases(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_platform_leases_run ON platform_scheduler_leases(run_id, status);
CREATE INDEX IF NOT EXISTS idx_platform_queue_run ON platform_scheduler_queue(run_id, enqueued_at);
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
  owner_id?: string | null;
};

type SchedulerLeaseRow = {
  id: string;
  run_id: string;
  step_id: string | null;
  task_id: string | null;
  task_path: string;
  agent_id: string;
  worker_id: string;
  status: SchedulerLeaseStatus;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
  released_at: string | null;
  release_reason: string | null;
};

type SchedulerQueueRow = {
  id: string;
  run_id: string;
  node_id: string;
  path: string;
  priority: number;
  status: SchedulerQueueStatus;
  enqueued_at: string;
  started_at: string | null;
  finished_at: string | null;
  wait_ms: number | null;
  reason: string | null;
  required_capability: string | null;
  priority_class: number;
  effective_priority: number | null;
  profile: string | null;
  agent_id: string | null;
  claimed_by: string | null;
  claim_expires_at: string | null;
  attempts: number;
  max_attempts: number;
  deadline_at: string | null;
};

type SchedulerWorkerRow = {
  id: string;
  host: string;
  pid: number | null;
  slot: number | null;
  lane: string;
  capabilities: string;
  capacity: number;
  status: SchedulerWorkerStatus;
  started_at: string;
  heartbeat_at: string;
  expires_at: string;
  stopped_at: string | null;
  stop_reason: string | null;
  meta: string | null;
};

type SchedulerAttemptRow = {
  id: string;
  queue_id: string;
  attempt: number;
  worker_id: string | null;
  agent_id: string | null;
  status: SchedulerAttemptStatus;
  lease_id: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  wait_ms: number | null;
  error: string | null;
  trace: string | null;
};

type RunNodeRow = {
  run_id: string;
  node_id: string;
  path: string;
  status: RunNodeStatus;
  priority: number;
  ready_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  attempts: number;
  error: string | null;
};

type RunCheckpointRow = {
  id: string;
  run_id: string;
  sequence: number;
  state: string;
  created_at: string;
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
  /** platform_agents 补列后才有；为 null 表示内置那批。 */
  owner_id?: string | null;
};

type ChatAgentRow = AgentRow & {
  owner_id: string | null;
  description: string;
  avatar: string;
  config: string;
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
  /** 为空是内置工具，非空是某个账号自己连 MCP 同步出来的。 */
  owner_id?: string | null;
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
  owner_id?: string | null;
};

type RunRow = {
  id: string;
  workflow_id: string;
  workflow_version: number;
  status: RunStatus;
  mode: RunMode;
  input: string;
  plan: string | null;
  definition: string | null;
  output: string | null;
  error: string | null;
  step_count: number;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  release_id: string | null;
  experiment_id: string | null;
  arm: string | null;
  priority_class: number | null;
  deadline_at: string | null;
  cancel_requested_at: string | null;
  resume_count: number | null;
  scheduler_state: string | null;
};

type ReleaseRow = {
  id: string;
  workflow_id: string;
  version: number;
  label: string;
  status: ReleaseStatus;
  origin: ReleaseManifest["origin"];
  parent_release_id: string | null;
  candidate_id: string | null;
  artifact: string;
  artifact_hash: string;
  change_summary: string;
  created_by: string;
  created_at: string;
  activated_at: string | null;
  retired_at: string | null;
};

type CandidateRow = {
  id: string;
  workflow_id: string;
  base_release_id: string;
  source: EvolutionCandidate["source"];
  title: string;
  summary: string;
  changes: string;
  proposed_by: string;
  status: EvolutionCandidate["status"];
  gate: string | null;
  security: string | null;
  eval_run_id: string | null;
  draft_release_id: string | null;
  promoted_release_id: string | null;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
  decided_by: string | null;
  decision_comment: string | null;
};

type DatasetRow = {
  id: string;
  workflow_id: string;
  name: string;
  version: number;
  description: string;
  cases: string;
  created_at: string;
};

type EvaluationRunRow = {
  id: string;
  candidate_id: string;
  dataset_id: string;
  base_release_id: string;
  candidate_release_id: string;
  mode: EvaluationRun["mode"];
  status: EvaluationRun["status"];
  decision: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
};

type RolloutRow = {
  id: string;
  workflow_id: string;
  release_id: string;
  base_release_id: string;
  percent: number;
  status: RolloutStatus;
  min_samples_per_arm: number;
  max_error_rate_delta: number;
  max_score_drop: number;
  rollback_reason: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};

type AssignmentRow = {
  run_id: string;
  workflow_id: string;
  release_id: string;
  base_release_id: string | null;
  experiment_id: string | null;
  arm: RolloutArm;
  rollout_id: string | null;
  assignment_key: string | null;
  created_at: string;
};

type ObservationRow = {
  id: string;
  rollout_id: string;
  run_id: string;
  arm: RolloutArm;
  workflow_id: string;
  release_id: string;
  status: string;
  passed: number;
  score: number | null;
  duration_ms: number | null;
  tokens: number | null;
  created_at: string;
};

type AlertRow = {
  id: string;
  severity: EvolutionAlert["severity"];
  kind: EvolutionAlert["kind"];
  entity_type: string;
  entity_id: string;
  title: string;
  detail: string;
  acknowledged: number;
  created_at: string;
};

type LedgerRow = {
  seq: number;
  type: LedgerEventType;
  entity_type: string;
  entity_id: string;
  payload: string;
  prev_hash: string;
  hash: string;
  created_at: string;
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

type InteractionRow = {
  id: string;
  run_id: string;
  step_id: string;
  node_id: string;
  path: string;
  title: string;
  prompt: string;
  fields: string;
  context: string | null;
  status: InteractionStatus;
  response: string | null;
  actor: string | null;
  expires_at: string | null;
  created_at: string;
  decided_at: string | null;
};

type VerifyRow = {  id: string;
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
  model_before: string | null;
  model_after: string | null;
  changes: string;
  created_at: string;
};

export type StoredWorkflow = {
  definition: WorkflowDefinition;
  status: string;
  createdAt: string;
  updatedAt: string;
  /** 归属账号；null 是内置共享的那份。保存前用来判断「当前账号能不能覆盖」。 */
  ownerId: string | null;
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
  /** 内置（全员可见）还是自建（只有本人可见）。 */
  source: ToolSource;
  /** 归属账号；为空表示内置。 */
  ownerId: string | null;
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
  modelBefore?: string;
  modelAfter?: string;
  changes: string[];
};

export class PlatformStateStore {
  readonly dbPath: string;
  private readonly db: Database.Database;

  /**
   * Worker 子进程以只读模式打开同一台账：跳过迁移与“中断运行”清理，
   * 否则每个子进程启动/补位都会把父进程正在执行的运行标成失败。
   */
  constructor(
    dbPath = process.env.PLATFORM_DB_PATH || path.resolve("data", "platform.db"),
    options: { readonly?: boolean } = {}
  ) {
    this.dbPath = dbPath;
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 3000");
    if (options.readonly) {
      this.db.pragma("query_only = ON");
      return;
    }
    this.db.exec(SCHEMA);
    this.ensureStepColumns();
    this.ensureVerifyColumns();
    this.ensureRunColumns();
    this.ensureSchedulerColumns();
    this.ensureSchedulerIndexes();
    this.ensureMcpColumns();
    this.ensureLoopColumns();
    ensureOwnerColumnsFor(this.db, PERSONAL_TABLES.platform);
    // Agent 与工具单独补列：内置那批要留成「无主」，好让所有账号都能读到，不能走首账号回填。
    ensureOwnerColumnsFor(this.db, ["platform_agents", "platform_tools"]);
    this.adoptOrphanMcpTools();
    this.failInterruptedRuns();
  }

  /**
   * 工具表加归属列之前，MCP 同步出来的工具一律是「无主」，
   * 补列之后它们会被当成内置工具暴露给所有人。这里按 endpoint 前缀认回所属连接。
   */
  private adoptOrphanMcpTools() {
    this.db
      .prepare(
        `
        UPDATE platform_tools
        SET owner_id = (
          SELECT s.owner_id FROM platform_mcp_servers s
          WHERE platform_tools.endpoint LIKE 'mcp://' || s.id || '/%'
            AND s.owner_id IS NOT NULL
          LIMIT 1
        )
        WHERE owner_id IS NULL
          AND type = 'mcp'
          AND EXISTS (
            SELECT 1 FROM platform_mcp_servers s
            WHERE platform_tools.endpoint LIKE 'mcp://' || s.id || '/%'
              AND s.owner_id IS NOT NULL
          )
        `
      )
      .run();
  }

  /**
   * 执行上下文与审批等待点都在进程内，重启后没有任何非终态运行能继续。
   * 启动时统一标失败并写明原因，避免监控台永久显示“运行中”。
   */
  private failInterruptedRuns() {
    const now = new Date().toISOString();
    const runs = this.db
      .prepare(
        "SELECT id, status FROM platform_runs WHERE status IN ('queued', 'running', 'verifying', 'revising', 'waiting_approval', 'waiting_input')"
      )
      .all() as Array<{ id: string; status: RunStatus }>;
    if (runs.length === 0) {
      return;
    }
    const transaction = this.db.transaction(() => {
      for (const run of runs) {
        const reason =
          run.status === "waiting_approval"
            ? "服务重启，审批等待点已失效，请重新运行工作流。"
            : run.status === "waiting_input"
              ? "服务重启，人工输入等待点已失效，请重新运行工作流。"
              : "服务重启，运行已中断，请重新运行工作流。";
        this.db
          .prepare(
            "UPDATE platform_interactions SET status = 'expired', decided_at = ? WHERE run_id = ? AND status = 'pending'"
          )
          .run(now, run.id);
        this.db
          .prepare(
            `
            UPDATE platform_runs
            SET status = 'failed', error = ?, finished_at = ?,
                scheduler_state = 'interrupted',
                duration_ms = CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER)
            WHERE id = ?
            `
          )
          .run(reason, now, now, run.id);
        this.db
          .prepare(
            "UPDATE platform_run_steps SET status = 'failed', error = ?, finished_at = ? WHERE run_id = ? AND status IN ('pending', 'running', 'waiting')"
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
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("plan")) {
      this.db.exec("ALTER TABLE platform_runs ADD COLUMN plan TEXT");
    }
    if (!names.has("definition")) {
      this.db.exec("ALTER TABLE platform_runs ADD COLUMN definition TEXT");
    }
    if (!names.has("release_id")) {
      this.db.exec("ALTER TABLE platform_runs ADD COLUMN release_id TEXT");
    }
    if (!names.has("experiment_id")) {
      this.db.exec("ALTER TABLE platform_runs ADD COLUMN experiment_id TEXT");
    }
    if (!names.has("arm")) {
      this.db.exec("ALTER TABLE platform_runs ADD COLUMN arm TEXT");
    }
    if (!names.has("priority_class")) {
      this.db.exec("ALTER TABLE platform_runs ADD COLUMN priority_class INTEGER NOT NULL DEFAULT 0");
    }
    if (!names.has("deadline_at")) {
      this.db.exec("ALTER TABLE platform_runs ADD COLUMN deadline_at TEXT");
    }
    if (!names.has("cancel_requested_at")) {
      this.db.exec("ALTER TABLE platform_runs ADD COLUMN cancel_requested_at TEXT");
    }
    if (!names.has("resume_count")) {
      this.db.exec("ALTER TABLE platform_runs ADD COLUMN resume_count INTEGER NOT NULL DEFAULT 0");
    }
    if (!names.has("scheduler_state")) {
      this.db.exec("ALTER TABLE platform_runs ADD COLUMN scheduler_state TEXT");
    }
  }

  /**
   * 调度队列与租约的增量迁移。
   * 旧库的 queue 表带 status CHECK 约束，新增 claimed/cancelled 需要重建表；
   * 重建前先补列，保证 SELECT 复制语句在两代 schema 上都能工作。
   */
  private ensureSchedulerColumns() {
    const leaseColumns = new Set(
      (this.db.prepare("PRAGMA table_info(platform_scheduler_leases)").all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    );
    if (!leaseColumns.has("task_id")) {
      this.db.exec("ALTER TABLE platform_scheduler_leases ADD COLUMN task_id TEXT");
    }

    const queueColumns = new Set(
      (this.db.prepare("PRAGMA table_info(platform_scheduler_queue)").all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    );
    const additions: Array<[string, string]> = [
      ["required_capability", "TEXT"],
      ["priority_class", "INTEGER NOT NULL DEFAULT 0"],
      ["effective_priority", "REAL"],
      ["profile", "TEXT"],
      ["agent_id", "TEXT"],
      ["claimed_by", "TEXT"],
      ["claim_expires_at", "TEXT"],
      ["attempts", "INTEGER NOT NULL DEFAULT 0"],
      ["max_attempts", "INTEGER NOT NULL DEFAULT 1"],
      ["deadline_at", "TEXT"]
    ];
    for (const [name, type] of additions) {
      if (!queueColumns.has(name)) {
        this.db.exec(`ALTER TABLE platform_scheduler_queue ADD COLUMN ${name} ${type}`);
      }
    }

    const definition = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'platform_scheduler_queue'")
      .get() as { sql: string } | undefined;
    if (!definition?.sql.includes("'claimed'")) {
      const migrate = this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE platform_scheduler_queue_v2 (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            path TEXT NOT NULL,
            priority REAL NOT NULL,
            status TEXT NOT NULL CHECK (
              status IN ('queued', 'claimed', 'running', 'succeeded', 'failed', 'skipped', 'cancelled', 'expired')
            ),
            enqueued_at TEXT NOT NULL,
            started_at TEXT,
            finished_at TEXT,
            wait_ms INTEGER,
            reason TEXT,
            required_capability TEXT,
            priority_class INTEGER NOT NULL DEFAULT 0,
            effective_priority REAL,
            profile TEXT,
            agent_id TEXT,
            claimed_by TEXT,
            claim_expires_at TEXT,
            attempts INTEGER NOT NULL DEFAULT 0,
            max_attempts INTEGER NOT NULL DEFAULT 1,
            deadline_at TEXT
          )
        `);
        this.db.exec(`
          INSERT INTO platform_scheduler_queue_v2
            (id, run_id, node_id, path, priority, status, enqueued_at, started_at, finished_at,
             wait_ms, reason, required_capability, priority_class, effective_priority, profile,
             agent_id, claimed_by, claim_expires_at, attempts, max_attempts, deadline_at)
          SELECT
            id, run_id, node_id, path, priority, status, enqueued_at, started_at, finished_at,
            wait_ms, reason, required_capability, priority_class, effective_priority, profile,
            agent_id, claimed_by, claim_expires_at, attempts, max_attempts, deadline_at
          FROM platform_scheduler_queue
        `);
        this.db.exec("DROP TABLE platform_scheduler_queue");
        this.db.exec("ALTER TABLE platform_scheduler_queue_v2 RENAME TO platform_scheduler_queue");
      });
      migrate();
    }
  }

  private ensureSchedulerIndexes() {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_scheduler_queue_ready
        ON platform_scheduler_queue(status, effective_priority DESC, enqueued_at);
      CREATE INDEX IF NOT EXISTS idx_scheduler_queue_run
        ON platform_scheduler_queue(run_id, status);
      CREATE INDEX IF NOT EXISTS idx_scheduler_attempts_queue
        ON platform_scheduler_attempts(queue_id, attempt);
      CREATE INDEX IF NOT EXISTS idx_run_nodes_status
        ON platform_run_nodes(run_id, status);
      CREATE INDEX IF NOT EXISTS idx_run_checkpoints_run
        ON platform_run_checkpoints(run_id, sequence DESC, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS ux_scheduler_lease_active_task
        ON platform_scheduler_leases(task_id)
        WHERE status = 'active' AND task_id IS NOT NULL;
    `);
  }

  // T1.7 之前的数据库没有 detail 列，启动时补齐。
  private ensureLoopColumns() {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(platform_loop_iterations)").all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    );
    if (!columns.has("model_before")) {
      this.db.exec("ALTER TABLE platform_loop_iterations ADD COLUMN model_before TEXT");
    }
    if (!columns.has("model_after")) {
      this.db.exec("ALTER TABLE platform_loop_iterations ADD COLUMN model_after TEXT");
    }
  }

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

  /**
   * 播种「随代码分发的共享对话智能体」（如研途引航系列）。
   * 与内置 Agent 的策略一致：INSERT 遇到同 id 已存在就跳过，本机的私人改动优先；
   * 已存在但带主人的行放回无主，避免「我建了这批、别人拉代码后又多出一批」的重复。
   */
  seedSharedChatAgents(
    seeds: Array<{
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
    }>
  ): number {
    const now = new Date().toISOString();
    const insert = this.db.prepare(
      `
      INSERT INTO chat_agents
        (id, owner_id, name, description, avatar, role, prompt, model, tools,
         capabilities, memory, config, version, enabled, created_at, updated_at)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
      `
    );
    let inserted = 0;
    const transaction = this.db.transaction(() => {
      for (const seed of seeds) {
        inserted += insert.run(
          seed.id,
          seed.name,
          seed.description ?? "",
          seed.avatar ?? "",
          seed.role ?? "",
          seed.prompt,
          seed.model,
          JSON.stringify(seed.tools ?? []),
          JSON.stringify(seed.capabilities ?? []),
          JSON.stringify(seed.memory ?? {}),
          JSON.stringify(seed.config ?? {}),
          seed.enabled === false ? 0 : 1,
          now,
          now
        ).changes;
        // 同 id 的历史私人行放回共享，跟内置工作流的 releaseBuiltinWorkflow 同思路。
        this.db
          .prepare("UPDATE chat_agents SET owner_id = NULL WHERE id = ? AND owner_id IS NOT NULL")
          .run(seed.id);
      }
    });
    transaction();
    return inserted;
  }

  seedAgents(seeds: AgentWrite[]): number {
    const now = new Date().toISOString();
    const statement = this.db.prepare(
      `
      INSERT INTO platform_agents
        (id, name, version, role, prompt, tools, model, capabilities, memory, enabled, created_at, updated_at, owner_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
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

    // 只给从未被修改过的内置 Agent 补默认模型分工；用户改过的记录（version > 1）保持不动。
    const refreshModels = this.db.transaction(() => {
      const update = this.db.prepare(
        `
        UPDATE platform_agents SET model = ?
        WHERE id = ? AND model = 'platform-default' AND version = 1 AND created_at = updated_at
        `
      );
      for (const seed of seeds) {
        if (seed.model !== "platform-default") {
          update.run(seed.model, seed.id);
        }
      }
    });
    refreshModels();
    return inserted;
  }

  saveAgent(agent: AgentWrite): AgentRecord {
    const ownerId = ownerValue();
    const located = this.locateAgent(agent.id);
    if (ownerId && located) {
      // 内置 Agent 是各账号共用的那一份，能读但不能改，否则一个人改了所有人跟着变。
      if (located.table === "platform" && located.ownerId === null) {
        throw new PlatformError("内置 Agent 是只读的，要改请另存一个自己的。", 403);
      }
      // 共享对话智能体（无主行）随代码分发：部署者（owner 角色）可编辑且保持共享，
      // 成员只读——直接改会同步给所有人，得另存一份自己的。
      if (located.table === "chat" && located.ownerId === null) {
        if (currentAuth()?.role !== "owner") {
          throw new PlatformError("共享智能体是只读的，要改请另存一个自己的。", 403);
        }
        const existing = this.getAgent(agent.id);
        const now = new Date().toISOString();
        if (existing) {
          this.recordAgentVersion(existing, existing.updatedAt);
        }
        this.writeChatAgent(agent, null, existing, now);
        const saved = this.getAgent(agent.id)!;
        this.recordAgentVersion(saved, now);
        return saved;
      }
      // 别人的自建智能体对当前账号等同于不存在。
      if (located.ownerId !== ownerId) {
        throw new PlatformError("Agent 不存在。", 404);
      }
    }
    const existing = this.getAgent(agent.id);
    const now = new Date().toISOString();
    if (existing) {
      this.recordAgentVersion(existing, existing.updatedAt);
    }
    // 老数据（含内置）继续留在 platform_agents：自循环改写内置提示词这类无身份的
    // 后台路径依赖它，迁走会让历史版本和运行记录对不上。新建的一律进 chat_agents。
    if (located?.table === "platform") {
      this.writePlatformAgent(agent, ownerId, existing, now);
    } else {
      this.writeChatAgent(agent, located?.ownerId ?? ownerId, existing, now);
    }
    const saved = this.getAgent(agent.id)!;
    this.recordAgentVersion(saved, now);
    return saved;
  }

  private writePlatformAgent(
    agent: AgentWrite,
    ownerId: string | null,
    existing: AgentRecord | undefined,
    now: string
  ) {
    this.db
      .prepare(
        `
        INSERT INTO platform_agents
          (id, name, version, role, prompt, tools, model, capabilities, memory, enabled, created_at, updated_at, owner_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        now,
        ownerId
      );
  }

  private writeChatAgent(
    agent: AgentWrite,
    ownerId: string | null,
    existing: AgentRecord | undefined,
    now: string
  ) {
    this.db
      .prepare(
        `
        INSERT INTO chat_agents
          (id, owner_id, name, description, avatar, role, prompt, model, tools,
           capabilities, memory, config, version, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          avatar = excluded.avatar,
          role = excluded.role,
          prompt = excluded.prompt,
          model = excluded.model,
          tools = excluded.tools,
          capabilities = excluded.capabilities,
          memory = excluded.memory,
          config = excluded.config,
          version = excluded.version,
          enabled = excluded.enabled,
          updated_at = excluded.updated_at
        `
      )
      .run(
        agent.id,
        ownerId,
        agent.name,
        agent.description ?? "",
        agent.avatar ?? "",
        agent.role,
        agent.prompt,
        agent.model,
        JSON.stringify(agent.tools),
        JSON.stringify(agent.capabilities ?? []),
        JSON.stringify(agent.memory ?? {}),
        JSON.stringify(agent.chatConfig ?? {}),
        agent.version,
        agent.enabled ? 1 : 0,
        existing?.createdAt ?? now,
        now
      );
  }

  /** 自建智能体住在 chat_agents，内置与历史自定义的住在 platform_agents。 */
  private locateAgent(
    id: string
  ): { table: "platform" | "chat"; ownerId: string | null } | undefined {
    const chat = this.db
      .prepare("SELECT owner_id FROM chat_agents WHERE id = ?")
      .get(id) as { owner_id: string | null } | undefined;
    if (chat) {
      return { table: "chat", ownerId: chat.owner_id };
    }
    const platform = this.db
      .prepare("SELECT owner_id FROM platform_agents WHERE id = ?")
      .get(id) as { owner_id: string | null } | undefined;
    return platform ? { table: "platform", ownerId: platform.owner_id } : undefined;
  }

  /**
   * 删除自建智能体；内置不允许删。
   * 版本与记忆按 agent_id 共享同一套表，这里一并清掉，避免换个同 id 又读回旧记忆。
   */
  deleteAgent(id: string): boolean {
    const ownerId = ownerValue();
    const located = this.locateAgent(id);
    if (!located) {
      return false;
    }
    if (located.table === "platform" && located.ownerId === null) {
      throw new PlatformError("内置 Agent 不能删除。", 403);
    }
    // 共享对话智能体是随代码分发的公共资产，只允许部署者移除。
    if (located.table === "chat" && located.ownerId === null) {
      if (currentAuth()?.role !== "owner") {
        throw new PlatformError("共享智能体不能删除。", 403);
      }
    } else if (ownerId && located.ownerId !== ownerId) {
      throw new PlatformError("Agent 不存在。", 404);
    }
    const transaction = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM ${located.table === "chat" ? "chat_agents" : "platform_agents"} WHERE id = ?`).run(id);
      this.db.prepare("DELETE FROM platform_agent_versions WHERE agent_id = ?").run(id);
      this.db.prepare("DELETE FROM platform_agent_memory WHERE agent_id = ?").run(id);
    });
    transaction();
    return true;
  }

  getAgent(id: string): AgentRecord | undefined {
    const ownerId = ownerValue();
    const platformRow = ownerId
      ? (this.db
          .prepare(
            "SELECT * FROM platform_agents WHERE id = ? AND (owner_id IS NULL OR owner_id = ?)"
          )
          .get(id, ownerId) as AgentRow | undefined)
      : (this.db.prepare("SELECT * FROM platform_agents WHERE id = ?").get(id) as
          | AgentRow
          | undefined);
    if (platformRow) {
      return toAgentRecord(platformRow, "platform");
    }
    const chatRow = ownerId
      ? (this.db
          .prepare("SELECT * FROM chat_agents WHERE id = ? AND (owner_id IS NULL OR owner_id = ?)")
          .get(id, ownerId) as ChatAgentRow | undefined)
      : (this.db.prepare("SELECT * FROM chat_agents WHERE id = ?").get(id) as
          | ChatAgentRow
          | undefined);
    return chatRow ? toAgentRecord(chatRow, "chat") : undefined;
  }

  /**
   * 跨运行记忆：只有 Agent 配置 memory.persist=true 时才写入，
   * 保留最近 maxEntries 条（默认 3），避免把历史产物无限堆进提示词。
   */
  appendAgentMemory(entry: {
    agentId: string;
    workflowId: string;
    key: string;
    value: string;
    maxEntries?: number;
  }) {
    this.db
      .prepare(
        "INSERT INTO platform_agent_memory (id, agent_id, workflow_id, key, value, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(randomUUID(), entry.agentId, entry.workflowId, entry.key, entry.value, new Date().toISOString());
    this.db
      .prepare(
        `DELETE FROM platform_agent_memory
         WHERE agent_id = ? AND workflow_id = ?
           AND id NOT IN (
             SELECT id FROM platform_agent_memory
             WHERE agent_id = ? AND workflow_id = ?
             ORDER BY created_at DESC, rowid DESC LIMIT ?
           )`
      )
      .run(
        entry.agentId,
        entry.workflowId,
        entry.agentId,
        entry.workflowId,
        Math.max(1, Math.trunc(entry.maxEntries ?? 3))
      );
  }

  listAgentMemory(agentId: string, workflowId: string, limit = 5) {
    return this.db
      .prepare(
        `SELECT key, value, created_at FROM platform_agent_memory
         WHERE agent_id = ? AND workflow_id = ?
         ORDER BY created_at DESC, rowid DESC LIMIT ?`
      )
      .all(agentId, workflowId, Math.max(1, Math.trunc(limit))) as Array<{
      key: string;
      value: string;
      created_at: string;
    }>;
  }

  listAgents(): AgentRecord[] {
    const ownerId = ownerValue();
    // 内置（owner_id 为空）对所有账号可见，自定义的只对本人可见。
    const platformRows = ownerId
      ? (this.db
          .prepare(
            "SELECT * FROM platform_agents WHERE owner_id IS NULL OR owner_id = ? ORDER BY role ASC, name ASC"
          )
          .all(ownerId) as AgentRow[])
      : (this.db
          .prepare("SELECT * FROM platform_agents ORDER BY role ASC, name ASC")
          .all() as AgentRow[]);
    // 自建智能体同样只出本人那一份；它是工作流可引用的，所以并入同一份清单，
    // 工作流节点按 id 挑人时不会因为「它住在另一张表」而找不到。
    const chatRows = ownerId
      ? (this.db
          .prepare(
            "SELECT * FROM chat_agents WHERE owner_id IS NULL OR owner_id = ? ORDER BY updated_at DESC"
          )
          .all(ownerId) as ChatAgentRow[])
      : (this.db.prepare("SELECT * FROM chat_agents ORDER BY updated_at DESC").all() as ChatAgentRow[]);
    return [...chatRows.map((row) => toAgentRecord(row, "chat")), ...platformRows.map((row) => toAgentRecord(row, "platform"))];
  }

  /** 聊天页只列自建智能体；内置那批是工作流零件，不适合当对话人格。 */
  listChatAgents(): AgentRecord[] {
    const ownerId = ownerValue();
    // 无主行（owner_id 为空）是随代码分发的共享智能体，全员可见；
    // 带主人的只对本人可见。
    const rows = ownerId
      ? (this.db
          .prepare(
            "SELECT * FROM chat_agents WHERE owner_id IS NULL OR owner_id = ? ORDER BY updated_at DESC"
          )
          .all(ownerId) as ChatAgentRow[])
      : (this.db.prepare("SELECT * FROM chat_agents ORDER BY updated_at DESC").all() as ChatAgentRow[]);
    return rows.map((row) => toAgentRecord(row, "chat"));
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
      enabled: target.enabled,
      description: target.description,
      avatar: target.avatar,
      chatConfig: target.chatConfig
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
      enabled: record.enabled,
      description: record.description,
      avatar: record.avatar,
      chatConfig: record.chatConfig
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
    // 种子工具留空 owner_id：它们是产品自带的，所有账号都该看得到。
    const statement = this.db.prepare(
      `
      INSERT INTO platform_tools
        (id, name, type, schema, endpoint, description, enabled, created_at, updated_at, owner_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
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

  /**
   * 写入工具。ownerId 用来让 MCP 同步显式指定归属（服务器是谁的，工具就是谁的）；
   * 不传则取当前请求的账号。
   *
   * 主键是工具 id，两个人给 MCP 服务器起同名 id 时会撞在一起，
   * 这里直接报错而不是把别人的工具悄悄改掉。
   */
  saveTool(tool: ToolWrite, ownerId?: string | null): ToolRecord {
    const existingRow = this.db
      .prepare("SELECT owner_id, created_at FROM platform_tools WHERE id = ?")
      .get(tool.id) as { owner_id: string | null; created_at: string } | undefined;
    const currentOwner = ownerValue();
    const owner = existingRow ? existingRow.owner_id : (ownerId === undefined ? currentOwner : ownerId);
    if (existingRow && existingRow.owner_id && existingRow.owner_id !== owner) {
      throw new PlatformError(`工具「${tool.id}」已被其他账号占用，请换一个服务器 id。`, 409);
    }
    // 内置工具是全站共用的：账号自己拿同名 id 来保存不能把它改掉。
    // 同步类调用（MCP / 工作流）会显式传 ownerId，不走这条拦截。
    if (existingRow && existingRow.owner_id === null && ownerId === undefined && currentOwner) {
      throw new PlatformError(`「${tool.id}」是内置工具，不能覆盖。`, 400);
    }
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO platform_tools
          (id, name, type, schema, endpoint, description, enabled, created_at, updated_at, owner_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          type = excluded.type,
          schema = excluded.schema,
          endpoint = excluded.endpoint,
          description = excluded.description,
          enabled = excluded.enabled,
          updated_at = excluded.updated_at
        WHERE platform_tools.owner_id IS excluded.owner_id
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
        existingRow?.created_at ?? now,
        now,
        owner
      );
    return this.getTool(tool.id)!;
  }

  getTool(id: string): ToolRecord | undefined {
    const owner = ownerVisibleScope("platform_tools");
    const row = this.db
      .prepare(`SELECT * FROM platform_tools WHERE id = ?${owner.and}`)
      .get(id, ...owner.params) as ToolRow | undefined;
    return row ? toToolRecord(row) : undefined;
  }

  /** 内置工具 + 自己连 MCP 同步出来的，别人的一概不返回。 */
  listTools(): ToolRecord[] {
    const owner = ownerVisibleScope("platform_tools");
    const rows = this.db
      .prepare(`SELECT * FROM platform_tools WHERE ${owner.condition} ORDER BY type ASC, name ASC`)
      .all(...owner.params) as ToolRow[];
    return rows.map(toToolRecord);
  }

  /** 全库工具 id：MCP 同步时用来避免和别人的 id 撞车。 */
  listAllToolIds(): string[] {
    const rows = this.db.prepare("SELECT id FROM platform_tools").all() as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  deleteTool(id: string): boolean {
    const owner = ownerVisibleScope("platform_tools");
    return this.db
      .prepare(`DELETE FROM platform_tools WHERE id = ?${owner.and}`)
      .run(id, ...owner.params).changes > 0;
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
        (id, name, transport, command, args, env, url, enabled, created_at, updated_at, owner_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          now,
          ownerValue()
        ).changes;
      }
    });
    transaction();
    return inserted;
  }

  listMcpServers(): McpServerConfig[] {
    // 内置示例连接（owner 为空）所有账号都能看到并直接用；自己加的只有自己看得到。
    const owner = ownerVisibleScope("platform_mcp_servers");
    const rows = this.db
      .prepare(`SELECT * FROM platform_mcp_servers WHERE ${owner.condition} ORDER BY name ASC`)
      .all(...owner.params) as McpServerRow[];
    return rows.map(toMcpServerConfig);
  }

  getMcpServer(id: string): McpServerConfig | undefined {
    const owner = ownerVisibleScope("platform_mcp_servers");
    const row = this.db
      .prepare(`SELECT * FROM platform_mcp_servers WHERE id = ?${owner.and}`)
      .get(id, ...owner.params) as McpServerRow | undefined;
    return row ? toMcpServerConfig(row) : undefined;
  }

  saveMcpServer(server: McpServerWrite, existing?: McpServerConfig): McpServerConfig {
    const previous = existing ?? this.getMcpServer(server.id);
    const now = new Date().toISOString();
    const ownerId = ownerValue();
    // 连接 id 是主键：别人已经用掉的 id 不能静默改写，否则会替人换掉服务器配置。
    const rider = this.db
      .prepare("SELECT owner_id FROM platform_mcp_servers WHERE id = ?")
      .get(server.id) as { owner_id: string | null } | undefined;
    if (rider && rider.owner_id && rider.owner_id !== ownerId) {
      throw new PlatformError(`连接 id「${server.id}」已被其他账号占用，请换一个。`, 409);
    }
    this.db
      .prepare(
        `
        INSERT INTO platform_mcp_servers
          (id, name, transport, command, args, env, url, enabled, last_connected_at, last_error, created_at, updated_at, owner_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          transport = excluded.transport,
          command = excluded.command,
          args = excluded.args,
          env = excluded.env,
          url = excluded.url,
          enabled = excluded.enabled,
          updated_at = excluded.updated_at
        WHERE platform_mcp_servers.owner_id IS excluded.owner_id
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
        now,
        // 内置示例连接被谁改都还是内置，不能因为一次保存就变成某个人的私有连接。
        rider ? rider.owner_id : ownerId
      );
    return this.getMcpServer(server.id)!;
  }

  deleteMcpServer(id: string): boolean {
    const owner = ownerVisibleScope("platform_mcp_servers");
    return this.db
      .prepare(`DELETE FROM platform_mcp_servers WHERE id = ?${owner.and}`)
      .run(id, ...owner.params).changes > 0;
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
    const owner = ownerVisibleScope("platform_mcp_servers");
    if (status.error !== undefined) {
      this.db
        .prepare(`UPDATE platform_mcp_servers SET last_error = ?, updated_at = ? WHERE id = ?${owner.and}`)
        .run(status.error, now, id, ...owner.params);
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
        WHERE id = ?${owner.and}
        `
      )
      .run(
        status.connectedAt ?? now,
        status.info?.serverName ?? null,
        status.info?.serverVersion ?? null,
        status.info?.protocolVersion ?? null,
        status.latencyMs ?? null,
        now,
        id,
        ...owner.params
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

  /**
   * 落库一个工作流版本。
   * ownerId 不传时归当前账号；显式传 null 用于「部署者改共享流程，新版本仍共享」，
   * 否则 upsert 的 owner 条件会把共享行漏掉（NULL ≠ 当前账号）变成静默 no-op。
   */
  saveWorkflow(definition: WorkflowDefinition, ownerId?: string | null) {
    const now = new Date().toISOString();
    const resolvedOwner = ownerId === undefined ? ownerValue() : ownerId;
    this.db
      .prepare(
        `
        INSERT INTO platform_workflows (id, version, name, description, dsl, status, created_at, updated_at, owner_id)
        VALUES (?, ?, ?, ?, ?, 'published', ?, ?, ?)
        ON CONFLICT(id, version) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          dsl = excluded.dsl,
          updated_at = excluded.updated_at
        WHERE platform_workflows.owner_id IS excluded.owner_id
        `
      )
      .run(
        definition.id,
        definition.version,
        definition.name,
        definition.description ?? "",
        JSON.stringify(definition),
        now,
        now,
        resolvedOwner
      );
  }

  getWorkflow(id: string, version?: number): StoredWorkflow | undefined {
    const owner = ownerVisibleScope("platform_workflows");
    const row =
      version === undefined
        ? (this.db
            .prepare(`SELECT * FROM platform_workflows WHERE id = ?${owner.and} ORDER BY version DESC LIMIT 1`)
            .get(id, ...owner.params) as WorkflowRow | undefined)
        : (this.db
            .prepare(`SELECT * FROM platform_workflows WHERE id = ? AND version = ?${owner.and}`)
            .get(id, version, ...owner.params) as WorkflowRow | undefined);
    if (!row) {
      return undefined;
    }
    return {
      definition: parseWorkflowDefinition(JSON.parse(row.dsl)),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ownerId: row.owner_id
    };
  }

  /**
   * 查某个 (id, version) 行的归属，不管当前账号的可见域。
   * 保存前用来识别「要写的版本号已被别人/共享行占用」这种看不见的冲突，
   * 否则 upsert 的 owner 条件会静默 no-op，响应再查回来就是空。
   */
  workflowVersionOwner(id: string, version: number): string | null | undefined {
    const row = this.db
      .prepare("SELECT owner_id FROM platform_workflows WHERE id = ? AND version = ?")
      .get(id, version) as { owner_id: string | null } | undefined;
    return row ? row.owner_id : undefined;
  }

  listWorkflows(): WorkflowSummary[] {
    // 内置工作流对所有账号可见；自己存过新版本后，列表里看到的是自己那一版。
    const owner = ownerVisibleScope("w");
    const inner = ownerVisibleScope("platform_workflows");
    const rows = this.db
      .prepare(
        `
        SELECT w.* FROM platform_workflows w
        JOIN (
          SELECT id, MAX(version) AS version FROM platform_workflows
          WHERE ${inner.condition}
          GROUP BY id
        ) latest ON latest.id = w.id AND latest.version = w.version
        WHERE ${owner.condition}
        ORDER BY w.updated_at DESC
        `
      )
      .all(...inner.params, ...owner.params) as WorkflowRow[];
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
        updatedAt: row.updated_at,
        source: row.owner_id ? "custom" : "builtin",
        ownerId: row.owner_id ?? null
      };
    });
  }

  /**
   * 把内置工作流的某个版本放回「无主」。
   *
   * 早先按「首个账号接管无主数据」回填过一次，内置流程也一并被划给了那个账号，
   * 结果第二个账号登进来工作流列表是空的。启动时按内置文件校正回来，
   * 只动版本号与内置文件一致的那几行，用户自己存的新版本不受影响。
   */
  releaseBuiltinWorkflow(id: string, version: number): number {
    return this.db
      .prepare("UPDATE platform_workflows SET owner_id = NULL WHERE id = ? AND version = ? AND owner_id IS NOT NULL")
      .run(id, version).changes;
  }

  createRun(input: {
    workflowId: string;
    workflowVersion: number;
    workflowInput: Record<string, unknown>;
    mode: RunMode;
    status?: RunStatus;
    plan?: unknown;
    definition?: WorkflowDefinition;
    releaseId?: string;
    experimentId?: string;
    arm?: string;
    priorityClass?: number;
    deadlineAt?: string;
    schedulerState?: string;
    /** 从检查点恢复的次数；同一恢复链上累加。 */
    resumeCount?: number;
  }): RunRecord {
    const id = `run_${randomUUID()}`;
    // 后台调度创建运行时没有请求身份，归属顺着工作流走，避免落成谁都查不到的无主记录。
    const ownerId = ownerValue() ?? this.workflowOwnerId(input.workflowId);
    this.db
      .prepare(
        `
        INSERT INTO platform_runs
          (id, workflow_id, workflow_version, status, mode, input, plan, definition,
           release_id, experiment_id, arm, priority_class, deadline_at, scheduler_state,
           resume_count, step_count, started_at, owner_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
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
        input.definition === undefined ? null : JSON.stringify(input.definition),
        input.releaseId ?? null,
        input.experimentId ?? null,
        input.arm ?? null,
        input.priorityClass ?? 0,
        input.deadlineAt ?? null,
        input.schedulerState ?? null,
        input.resumeCount ?? 0,
        new Date().toISOString(),
        ownerId
      );
    // 刚创建的这一条必然属于自己（或继承自工作流），直接按主键读回，避免受归属过滤影响。
    const row = this.db.prepare("SELECT * FROM platform_runs WHERE id = ?").get(id) as RunRow;
    return toRunRecord(row);
  }

  /** 工作流的主人；无身份路径创建运行时用来继承归属。 */
  private workflowOwnerId(workflowId: string): string | null {
    const row = this.db
      .prepare(
        "SELECT owner_id FROM platform_workflows WHERE id = ? AND owner_id IS NOT NULL ORDER BY rowid LIMIT 1"
      )
      .get(workflowId) as { owner_id: string } | undefined;
    return row?.owner_id ?? null;
  }

  /** 保存时默认追加版本，避免覆盖已被历史运行引用的 DSL。 */
  nextWorkflowVersion(id: string): number {
    // 全局取最大版本：主键是 (id, version)，只按自己可见的范围算会和内置版本撞车。
    const row = this.db
      .prepare("SELECT MAX(version) AS version FROM platform_workflows WHERE id = ?")
      .get(id) as { version: number | null } | undefined;
    return (row?.version ?? 0) + 1;
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
    // 有身份时只认自己的运行；调度器、恢复器没有身份，仍是全量。
    const owner = ownerScope("platform_runs");
    const row = this.db
      .prepare(`SELECT * FROM platform_runs WHERE id = ?${owner.and}`)
      .get(id, ...owner.params) as RunRow | undefined;
    return row ? toRunRecord(row) : undefined;
  }

  listRuns(limit = 20): RunRecord[] {
    const owner = ownerScope("platform_runs");
    const rows = this.db
      .prepare(
        `SELECT * FROM platform_runs WHERE 1 = 1${owner.and} ORDER BY started_at DESC, rowid DESC LIMIT ?`
      )
      .all(...owner.params, Math.min(Math.max(limit, 1), 100)) as RunRow[];
    return rows.map(toRunRecord);
  }

  /** 长时间停留在 queued 的运行：通常是落库后进程崩溃、还没开始执行。 */
  listQueuedRunsOlderThan(cutoff: Date, limit = 50): RunRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM platform_runs WHERE status = 'queued' AND started_at <= ? ORDER BY started_at ASC LIMIT ?"
      )
      .all(cutoff.toISOString(), Math.min(Math.max(limit, 1), 200)) as RunRow[];
    return rows.map(toRunRecord);
  }

  /** 上次进程退出时被统一标记为 failed 的运行；带检查点的可以由恢复器续跑。 */
  listInterruptedRunsSince(since: Date, limit = 50): RunRecord[] {
    const rows = this.db
      .prepare(
        `
        SELECT * FROM platform_runs
        WHERE status = 'failed' AND scheduler_state = 'interrupted' AND started_at >= ?
        ORDER BY started_at DESC LIMIT ?
        `
      )
      .all(since.toISOString(), Math.min(Math.max(limit, 1), 200)) as RunRow[];
    return rows.map(toRunRecord);
  }

  hasRunCheckpoint(runId: string): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM platform_run_checkpoints WHERE run_id = ? LIMIT 1").get(runId)
    );
  }

  isRunCancelRequested(runId: string): boolean {
    const row = this.db
      .prepare("SELECT cancel_requested_at FROM platform_runs WHERE id = ?")
      .get(runId) as { cancel_requested_at: string | null } | undefined;
    return Boolean(row?.cancel_requested_at);
  }

  acquireSchedulerLease(input: {
    runId: string;
    stepId?: string;
    taskId?: string;
    taskPath: string;
    agentId: string;
    workerId: string;
    ttlMs: number;
  }): SchedulerLease {
    const now = Date.now();
    const id = `lease_${randomUUID()}`;
    const ttl = Math.max(1000, Math.floor(input.ttlMs));
    this.db
      .prepare(
        `
        INSERT INTO platform_scheduler_leases
          (id, run_id, step_id, task_id, task_path, agent_id, worker_id, status,
           acquired_at, heartbeat_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
        `
      )
      .run(
        id,
        input.runId,
        input.stepId ?? null,
        input.taskId ?? null,
        input.taskPath,
        input.agentId,
        input.workerId,
        new Date(now).toISOString(),
        new Date(now).toISOString(),
        new Date(now + ttl).toISOString()
      );
    return this.getSchedulerLease(id)!;
  }

  getSchedulerLease(id: string): SchedulerLease | undefined {
    const row = this.db.prepare("SELECT * FROM platform_scheduler_leases WHERE id = ?").get(id) as
      | SchedulerLeaseRow
      | undefined;
    return row ? toSchedulerLease(row) : undefined;
  }

  /** 心跳只会延长仍在生效的租约，已被回收的租约不会被复活。 */
  heartbeatSchedulerLease(id: string, ttlMs: number): SchedulerLease | undefined {
    const now = Date.now();
    const ttl = Math.max(1000, Math.floor(ttlMs));
    const result = this.db
      .prepare(
        "UPDATE platform_scheduler_leases SET heartbeat_at = ?, expires_at = ? WHERE id = ? AND status = 'active'"
      )
      .run(new Date(now).toISOString(), new Date(now + ttl).toISOString(), id);
    return result.changes > 0 ? this.getSchedulerLease(id) : undefined;
  }

  releaseSchedulerLease(id: string, reason: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE platform_scheduler_leases SET status = 'released', released_at = ?, release_reason = ? WHERE id = ? AND status = 'active'"
      )
      .run(new Date().toISOString(), reason, id);
    return result.changes > 0;
  }

  releaseRunSchedulerLeases(runId: string, reason: string): number {
    const result = this.db
      .prepare(
        "UPDATE platform_scheduler_leases SET status = 'released', released_at = ?, release_reason = ? WHERE run_id = ? AND status = 'active'"
      )
      .run(new Date().toISOString(), reason, runId);
    return result.changes;
  }

  expireSchedulerLeases(now = Date.now()): number {
    const iso = new Date(now).toISOString();
    const result = this.db
      .prepare(
        "UPDATE platform_scheduler_leases SET status = 'expired', released_at = ?, release_reason = 'heartbeat_timeout' WHERE status = 'active' AND expires_at <= ?"
      )
      .run(iso, iso);
    return result.changes;
  }

  listSchedulerLeases(
    options: {
      active?: boolean;
      agentId?: string;
      runId?: string;
      status?: SchedulerLeaseStatus;
      limit?: number;
    } = {}
  ): SchedulerLease[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (options.active) {
      where.push("status = 'active' AND expires_at > ?");
      args.push(new Date().toISOString());
    }
    if (options.status) {
      where.push("status = ?");
      args.push(options.status);
    }
    if (options.agentId) {
      where.push("agent_id = ?");
      args.push(options.agentId);
    }
    if (options.runId) {
      where.push("run_id = ?");
      args.push(options.runId);
    }
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const rows = this.db
      .prepare(
        `SELECT * FROM platform_scheduler_leases${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""}
         ORDER BY acquired_at DESC, rowid DESC LIMIT ?`
      )
      .all(...args, limit) as SchedulerLeaseRow[];
    return rows.map(toSchedulerLease);
  }

  /** 真实在飞负载：按执行中的租约统计，先回收过期租约，避免故障 Worker 永久占位。 */
  activeLeaseLoads(): Record<string, { inFlight: number }> {
    this.expireSchedulerLeases();
    const rows = this.db
      .prepare(
        "SELECT agent_id, COUNT(*) AS in_flight FROM platform_scheduler_leases WHERE status = 'active' AND expires_at > ? GROUP BY agent_id"
      )
      .all(new Date().toISOString()) as Array<{ agent_id: string; in_flight: number }>;
    const loads: Record<string, { inFlight: number }> = {};
    for (const row of rows) {
      loads[row.agent_id] = { inFlight: row.in_flight };
    }
    return loads;
  }

  enqueueSchedulerTask(input: {
    runId: string;
    nodeId: string;
    path: string;
    priority: number;
    reason?: string;
    requiredCapability?: string;
    priorityClass?: number;
    effectivePriority?: number;
    profile?: Record<string, unknown>;
    agentId?: string;
    maxAttempts?: number;
    deadlineAt?: string;
  }): string {
    const id = `queue_${randomUUID()}`;
    this.db
      .prepare(
        `
        INSERT INTO platform_scheduler_queue
          (id, run_id, node_id, path, priority, status, enqueued_at, reason,
           required_capability, priority_class, effective_priority, profile,
           agent_id, max_attempts, deadline_at)
        VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        id,
        input.runId,
        input.nodeId,
        input.path,
        input.priority,
        new Date().toISOString(),
        input.reason ?? null,
        input.requiredCapability ?? null,
        input.priorityClass ?? 0,
        input.effectivePriority ?? input.priority,
        input.profile === undefined ? null : canonicalJson(input.profile),
        input.agentId ?? null,
        input.maxAttempts ?? 1,
        input.deadlineAt ?? null
      );
    return id;
  }

  startSchedulerTask(id: string) {
    const entry = this.getSchedulerQueueEntry(id);
    if (!entry) {
      return;
    }
    const startedAt = Date.now();
    this.db
      .prepare(
        `UPDATE platform_scheduler_queue
         SET status = 'running', started_at = ?, wait_ms = ?, claimed_by = NULL, claim_expires_at = NULL
         WHERE id = ? AND status IN ('queued', 'claimed')`
      )
      .run(
        new Date(startedAt).toISOString(),
        Math.max(0, startedAt - Date.parse(entry.enqueuedAt)),
        id
      );
  }

  finishSchedulerTask(id: string, status: SchedulerQueueStatus, reason?: string) {
    this.db
      .prepare(
        "UPDATE platform_scheduler_queue SET status = ?, finished_at = ?, reason = COALESCE(?, reason) WHERE id = ?"
      )
      .run(status, new Date().toISOString(), reason ?? null, id);
  }

  getSchedulerQueueEntry(id: string): SchedulerQueueEntry | undefined {
    const row = this.db.prepare("SELECT * FROM platform_scheduler_queue WHERE id = ?").get(id) as
      | SchedulerQueueRow
      | undefined;
    return row ? toSchedulerQueueEntry(row) : undefined;
  }

  listSchedulerQueue(runId: string, limit = 200): SchedulerQueueEntry[] {
    const capped = Math.min(Math.max(limit, 1), 500);
    const rows = this.db
      .prepare(
        "SELECT * FROM platform_scheduler_queue WHERE run_id = ? ORDER BY enqueued_at ASC, rowid ASC LIMIT ?"
      )
      .all(runId, capped) as SchedulerQueueRow[];
    return rows.map(toSchedulerQueueEntry);
  }

  /** 全局队列：跨运行取未认领任务，按持久化的有效优先级与入队时间排序。 */
  listQueuedSchedulerTasks(limit = 200): SchedulerQueueEntry[] {
    const capped = Math.min(Math.max(limit, 1), 1000);
    const rows = this.db
      .prepare(
        `SELECT * FROM platform_scheduler_queue WHERE status = 'queued'
         ORDER BY effective_priority DESC, enqueued_at ASC, rowid ASC LIMIT ?`
      )
      .all(capped) as SchedulerQueueRow[];
    return rows.map(toSchedulerQueueEntry);
  }

  /**
   * 认领任务：只有 queued 能被认领，attempts 在认领时自增，
   * 保证 Worker 中途失联时可以从尝试次数判断是否还有重派机会。
   */
  claimSchedulerTask(id: string, workerId: string, ttlMs = 15000): SchedulerQueueEntry | undefined {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE platform_scheduler_queue
         SET status = 'claimed', claimed_by = ?, claim_expires_at = ?, attempts = attempts + 1
         WHERE id = ? AND status = 'queued'`
      )
      .run(workerId, new Date(now + Math.max(1000, ttlMs)).toISOString(), id);
    return result.changes > 0 ? this.getSchedulerQueueEntry(id) : undefined;
  }

  /** 运行停止或失败时撤销该运行尚未开始的任务，已认领/运行中的任务由执行方自行收尾。 */
  cancelQueuedSchedulerTasks(runId: string, reason: string): number {
    const result = this.db
      .prepare(
        `UPDATE platform_scheduler_queue
         SET status = 'cancelled', finished_at = ?, reason = ?
         WHERE run_id = ? AND status = 'queued'`
      )
      .run(new Date().toISOString(), reason, runId);
    return result.changes;
  }

  /**
   * 回收认领超时任务：还有重派机会的回到 queued，否则落为 expired。
   * 认领者仍是同一进程时 normal 路径会先完成，因此这里只处理真正卡死的认领。
   */
  reclaimExpiredSchedulerTasks(now = Date.now()): { requeued: string[]; expired: string[] } {
    const iso = new Date(now).toISOString();
    const stale = this.db
      .prepare(
        `SELECT * FROM platform_scheduler_queue
         WHERE status = 'claimed' AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?`
      )
      .all(iso) as SchedulerQueueRow[];
    const requeued: string[] = [];
    const expired: string[] = [];
    const requeue = this.db.prepare(
      `UPDATE platform_scheduler_queue
       SET status = 'queued', claimed_by = NULL, claim_expires_at = NULL
       WHERE id = ? AND status = 'claimed'`
    );
    const expire = this.db.prepare(
      `UPDATE platform_scheduler_queue
       SET status = 'expired', finished_at = ?, reason = 'claim_timeout'
       WHERE id = ? AND status = 'claimed'`
    );
    const transaction = this.db.transaction(() => {
      for (const row of stale) {
        if (row.attempts < row.max_attempts) {
          if (requeue.run(row.id).changes > 0) {
            requeued.push(row.id);
          }
        } else if (expire.run(iso, row.id).changes > 0) {
          expired.push(row.id);
        }
      }
    });
    transaction();
    return { requeued, expired };
  }

  upsertSchedulerWorker(input: {
    id: string;
    host: string;
    pid?: number;
    slot?: number;
    lane: string;
    capabilities: string[];
    capacity?: number;
    status?: SchedulerWorkerStatus;
    ttlMs?: number;
    meta?: Record<string, unknown>;
  }): SchedulerWorker {
    const now = Date.now();
    const ttl = Math.max(1000, input.ttlMs ?? 30000);
    this.db
      .prepare(
        `
        INSERT INTO platform_scheduler_workers
          (id, host, pid, slot, lane, capabilities, capacity, status,
           started_at, heartbeat_at, expires_at, meta)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          host = excluded.host,
          pid = excluded.pid,
          slot = excluded.slot,
          lane = excluded.lane,
          capabilities = excluded.capabilities,
          capacity = excluded.capacity,
          status = excluded.status,
          heartbeat_at = excluded.heartbeat_at,
          expires_at = excluded.expires_at,
          stopped_at = NULL,
          stop_reason = NULL,
          meta = excluded.meta
        `
      )
      .run(
        input.id,
        input.host,
        input.pid ?? null,
        input.slot ?? null,
        input.lane,
        canonicalJson(input.capabilities),
        Math.max(1, input.capacity ?? 1),
        input.status ?? "starting",
        new Date(now).toISOString(),
        new Date(now).toISOString(),
        new Date(now + ttl).toISOString(),
        input.meta === undefined ? null : canonicalJson(input.meta)
      );
    return this.getSchedulerWorker(input.id)!;
  }

  getSchedulerWorker(id: string): SchedulerWorker | undefined {
    const row = this.db
      .prepare("SELECT * FROM platform_scheduler_workers WHERE id = ?")
      .get(id) as SchedulerWorkerRow | undefined;
    return row ? toSchedulerWorker(row) : undefined;
  }

  heartbeatSchedulerWorker(id: string, ttlMs: number): boolean {
    const now = Date.now();
    const ttl = Math.max(1000, Math.floor(ttlMs));
    const result = this.db
      .prepare(
        "UPDATE platform_scheduler_workers SET heartbeat_at = ?, expires_at = ? WHERE id = ? AND status != 'dead'"
      )
      .run(new Date(now).toISOString(), new Date(now + ttl).toISOString(), id);
    return result.changes > 0;
  }

  setSchedulerWorkerStatus(id: string, status: SchedulerWorkerStatus, stopReason?: string): boolean {
    const stoppedAt = status === "dead" ? new Date().toISOString() : null;
    const result = this.db
      .prepare(
        `
        UPDATE platform_scheduler_workers
        SET status = ?,
            stop_reason = COALESCE(?, stop_reason),
            stopped_at = CASE WHEN ? = 'dead' THEN ? ELSE stopped_at END
        WHERE id = ?
        `
      )
      .run(status, stopReason ?? null, status, stoppedAt, id);
    return result.changes > 0;
  }

  listSchedulerWorkers(
    options: { status?: SchedulerWorkerStatus; lane?: string; capability?: string; limit?: number } = {}
  ): SchedulerWorker[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (options.status) {
      where.push("status = ?");
      args.push(options.status);
    }
    if (options.lane) {
      where.push("lane = ?");
      args.push(options.lane);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const rows = this.db
      .prepare(
        `SELECT * FROM platform_scheduler_workers${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""}
         ORDER BY heartbeat_at DESC, rowid DESC LIMIT ?`
      )
      .all(...args, limit) as SchedulerWorkerRow[];
    const workers = rows.map(toSchedulerWorker);
    return options.capability
      ? workers.filter((worker) => worker.capabilities.includes(options.capability!))
      : workers;
  }

  /** 心跳过期的 Worker 视为失联，状态落为 dead，供回收器重派其任务。 */
  expireSchedulerWorkers(now = Date.now()): number {
    const iso = new Date(now).toISOString();
    const result = this.db
      .prepare(
        `
        UPDATE platform_scheduler_workers
        SET status = 'dead', stopped_at = ?, stop_reason = 'heartbeat_timeout'
        WHERE status != 'dead' AND expires_at <= ?
        `
      )
      .run(iso, iso);
    return result.changes;
  }

  startSchedulerAttempt(input: {
    queueId: string;
    attempt: number;
    workerId?: string;
    agentId?: string;
    leaseId?: string;
    waitMs?: number;
    trace?: Record<string, unknown>;
  }): SchedulerAttempt {
    const id = `attempt_${randomUUID()}`;
    this.db
      .prepare(
        `
        INSERT INTO platform_scheduler_attempts
          (id, queue_id, attempt, worker_id, agent_id, status, lease_id,
           started_at, wait_ms, trace)
        VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)
        `
      )
      .run(
        id,
        input.queueId,
        input.attempt,
        input.workerId ?? null,
        input.agentId ?? null,
        input.leaseId ?? null,
        new Date().toISOString(),
        input.waitMs ?? null,
        input.trace === undefined ? null : canonicalJson(input.trace)
      );
    return this.getSchedulerAttempt(id)!;
  }

  getSchedulerAttempt(id: string): SchedulerAttempt | undefined {
    const row = this.db
      .prepare("SELECT * FROM platform_scheduler_attempts WHERE id = ?")
      .get(id) as SchedulerAttemptRow | undefined;
    return row ? toSchedulerAttempt(row) : undefined;
  }

  finishSchedulerAttempt(id: string, status: SchedulerAttemptStatus, error?: string): boolean {
    const attempt = this.getSchedulerAttempt(id);
    if (!attempt) {
      return false;
    }
    const finishedAt = new Date().toISOString();
    const result = this.db
      .prepare(
        `
        UPDATE platform_scheduler_attempts
        SET status = ?, finished_at = ?, duration_ms = ?, error = COALESCE(?, error)
        WHERE id = ?
        `
      )
      .run(
        status,
        finishedAt,
        Math.max(0, Date.parse(finishedAt) - Date.parse(attempt.startedAt)),
        error ?? null,
        id
      );
    return result.changes > 0;
  }

  listSchedulerAttempts(
    options: { queueId?: string; runId?: string; limit?: number } = {}
  ): SchedulerAttempt[] {
    const where: string[] = [];
    const args: unknown[] = [];
    let join = "";
    if (options.queueId) {
      where.push("a.queue_id = ?");
      args.push(options.queueId);
    }
    if (options.runId) {
      join = " JOIN platform_scheduler_queue q ON q.id = a.queue_id";
      where.push("q.run_id = ?");
      args.push(options.runId);
    }
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
    const rows = this.db
      .prepare(
        `SELECT a.* FROM platform_scheduler_attempts a${join}
         ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY a.started_at DESC, a.rowid DESC LIMIT ?`
      )
      .all(...args, limit) as SchedulerAttemptRow[];
    return rows.map(toSchedulerAttempt);
  }

  /** 幂等登记运行的 DAG 节点；已存在的节点不会被重置，避免恢复时覆盖进度。 */
  insertRunNodes(
    runId: string,
    nodes: Array<{ nodeId: string; path: string; status?: RunNodeStatus; priority?: number }>
  ) {
    const insert = this.db.prepare(
      `
      INSERT INTO platform_run_nodes (run_id, node_id, path, status, priority)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(run_id, node_id) DO NOTHING
      `
    );
    const transaction = this.db.transaction(() => {
      for (const node of nodes) {
        insert.run(runId, node.nodeId, node.path, node.status ?? "pending", node.priority ?? 0);
      }
    });
    transaction();
  }

  setRunNodeStatus(
    runId: string,
    nodeId: string,
    status: RunNodeStatus,
    options: { attempts?: number; error?: string } = {}
  ): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `
        UPDATE platform_run_nodes
        SET status = ?,
            ready_at = CASE WHEN ? = 'ready' AND ready_at IS NULL THEN ? ELSE ready_at END,
            started_at = CASE WHEN ? = 'running' AND started_at IS NULL THEN ? ELSE started_at END,
            finished_at = CASE WHEN ? IN ('succeeded', 'failed', 'skipped', 'cancelled') THEN ? ELSE finished_at END,
            attempts = COALESCE(?, attempts),
            error = COALESCE(?, error)
        WHERE run_id = ? AND node_id = ?
        `
      )
      .run(
        status,
        status,
        now,
        status,
        now,
        status,
        now,
        options.attempts ?? null,
        options.error ?? null,
        runId,
        nodeId
      );
    return result.changes > 0;
  }

  getRunNode(runId: string, nodeId: string): RunNodeRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM platform_run_nodes WHERE run_id = ? AND node_id = ?")
      .get(runId, nodeId) as RunNodeRow | undefined;
    return row ? toRunNode(row) : undefined;
  }

  listRunNodes(runId: string): RunNodeRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM platform_run_nodes WHERE run_id = ? ORDER BY rowid ASC")
      .all(runId) as RunNodeRow[];
    return rows.map(toRunNode);
  }

  saveRunCheckpoint(input: {
    runId: string;
    sequence: number;
    state: Record<string, unknown>;
  }): RunCheckpoint {
    const id = `checkpoint_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO platform_run_checkpoints (id, run_id, sequence, state, created_at)
        VALUES (?, ?, ?, ?, ?)
        `
      )
      .run(id, input.runId, input.sequence, canonicalJson(input.state), createdAt);
    return { id, runId: input.runId, sequence: input.sequence, state: input.state, createdAt };
  }

  latestRunCheckpoint(runId: string): RunCheckpoint | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM platform_run_checkpoints WHERE run_id = ? ORDER BY sequence DESC, created_at DESC LIMIT 1"
      )
      .get(runId) as RunCheckpointRow | undefined;
    return row ? toRunCheckpoint(row) : undefined;
  }

  listRunCheckpoints(runId: string, limit = 20): RunCheckpoint[] {
    const capped = Math.min(Math.max(limit, 1), 200);
    const rows = this.db
      .prepare(
        "SELECT * FROM platform_run_checkpoints WHERE run_id = ? ORDER BY sequence DESC, created_at DESC LIMIT ?"
      )
      .all(runId, capped) as RunCheckpointRow[];
    return rows.map(toRunCheckpoint);
  }

  /** 调度器 leader：单行租约，避免多实例重复调度。 */
  acquireSchedulerLeadership(holder: string, ttlMs = 15000): boolean {
    const now = Date.now();
    const ttl = Math.max(1000, Math.floor(ttlMs));
    let acquired = false;
    const transaction = this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM platform_scheduler_leader WHERE id = 'global'")
        .get() as { holder: string; expires_at: string } | undefined;
      if (row && row.holder !== holder && Date.parse(row.expires_at) > now) {
        return;
      }
      this.db
        .prepare(
          `
          INSERT INTO platform_scheduler_leader (id, holder, heartbeat_at, expires_at)
          VALUES ('global', ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            holder = excluded.holder,
            heartbeat_at = excluded.heartbeat_at,
            expires_at = excluded.expires_at
          `
        )
        .run(holder, new Date(now).toISOString(), new Date(now + ttl).toISOString());
      acquired = true;
    });
    transaction.immediate();
    return acquired;
  }

  heartbeatSchedulerLeadership(holder: string, ttlMs = 15000): boolean {
    const now = Date.now();
    const ttl = Math.max(1000, Math.floor(ttlMs));
    const result = this.db
      .prepare(
        "UPDATE platform_scheduler_leader SET heartbeat_at = ?, expires_at = ? WHERE id = 'global' AND holder = ?"
      )
      .run(new Date(now).toISOString(), new Date(now + ttl).toISOString(), holder);
    return result.changes > 0;
  }

  releaseSchedulerLeadership(holder: string): boolean {
    const result = this.db
      .prepare("DELETE FROM platform_scheduler_leader WHERE id = 'global' AND holder = ?")
      .run(holder);
    return result.changes > 0;
  }

  getSchedulerLeadership():
    | { holder: string; heartbeatAt: string; expiresAt: string }
    | undefined {
    const row = this.db
      .prepare("SELECT * FROM platform_scheduler_leader WHERE id = 'global'")
      .get() as { holder: string; heartbeat_at: string; expires_at: string } | undefined;
    return row
      ? { holder: row.holder, heartbeatAt: row.heartbeat_at, expiresAt: row.expires_at }
      : undefined;
  }

  /** 取消标志落库，跨进程的调度器与 Worker 都能看到；重复请求保持幂等。 */
  requestRunCancel(runId: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE platform_runs SET cancel_requested_at = COALESCE(cancel_requested_at, ?) WHERE id = ?"
      )
      .run(new Date().toISOString(), runId);
    return result.changes > 0;
  }

  updateRunSchedulerState(runId: string, state: string): boolean {
    const result = this.db
      .prepare("UPDATE platform_runs SET scheduler_state = ? WHERE id = ?")
      .run(state, runId);
    return result.changes > 0;
  }

  incrementRunResumeCount(runId: string): boolean {
    const result = this.db
      .prepare("UPDATE platform_runs SET resume_count = resume_count + 1 WHERE id = ?")
      .run(runId);
    return result.changes > 0;
  }

  setRunResumeCount(runId: string, count: number): boolean {
    const result = this.db
      .prepare("UPDATE platform_runs SET resume_count = ? WHERE id = ?")
      .run(Math.max(0, Math.trunc(count)), runId);
    return result.changes > 0;
  }

  listRunsForMetrics(workflowIds: string[] = [], limit = 1000): RunRecord[] {
    const capped = Math.min(Math.max(limit, 1), 5000);
    const owner = ownerScope("platform_runs");
    if (workflowIds.length === 0) {
      const rows = this.db
        .prepare(
          `SELECT * FROM platform_runs WHERE 1 = 1${owner.and} ORDER BY started_at DESC, rowid DESC LIMIT ?`
        )
        .all(...owner.params, capped) as RunRow[];
      return rows.map(toRunRecord);
    }
    const placeholders = workflowIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM platform_runs WHERE workflow_id IN (${placeholders})${owner.and} ORDER BY started_at DESC, rowid DESC LIMIT ?`
      )
      .all(...workflowIds, ...owner.params, capped) as RunRow[];
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

  /** 运行中重调度后把改派原因写回步骤输入，监控台可直接看到，不需要额外事件表。 */
  annotateStepInput(id: string, patch: Record<string, unknown>) {
    const row = this.db
      .prepare("SELECT input FROM platform_run_steps WHERE id = ?")
      .get(id) as { input: string | null } | undefined;
    if (!row) {
      return;
    }
    const current = fromJson<Record<string, unknown>>(row.input) ?? {};
    this.db
      .prepare("UPDATE platform_run_steps SET input = ? WHERE id = ?")
      .run(JSON.stringify({ ...current, ...patch }), id);
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
    if (!row) {
      return undefined;
    }
    // 有身份时确认这条审批挂在自己的运行下面，别人的审批等同于不存在。
    if (ownerValue() && !this.getRun(row.run_id)) {
      return undefined;
    }
    return toApprovalRecord(row);
  }

  listApprovals(options: { runId?: string; status?: ApprovalStatus; limit?: number } = {}): ApprovalRecord[] {
    const clauses: string[] = [];
    const params: string[] = [];
    // 审批是运行的子资源，按运行归属过滤：有身份时看不到别人运行下的审批。
    const runOwner = ownerScope("r");
    clauses.push(`run_id IN (SELECT r.id FROM platform_runs r WHERE 1 = 1${runOwner.and})`);
    params.push(...runOwner.params);
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

  createInteraction(input: {
    runId: string;
    stepId: string;
    nodeId: string;
    path: string;
    title: string;
    prompt: string;
    fields: HumanField[];
    context?: Record<string, unknown>;
    expiresAt?: string;
  }): InteractionRecord {
    const id = `itx_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO platform_interactions
          (id, run_id, step_id, node_id, path, title, prompt, fields, context, status, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        `
      )
      .run(
        id,
        input.runId,
        input.stepId,
        input.nodeId,
        input.path,
        input.title,
        input.prompt,
        JSON.stringify(input.fields),
        input.context === undefined ? null : JSON.stringify(input.context),
        input.expiresAt ?? null,
        createdAt
      );
    return this.getInteraction(id)!;
  }

  getInteraction(id: string): InteractionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM platform_interactions WHERE id = ?").get(id) as
      | InteractionRow
      | undefined;
    if (!row) {
      return undefined;
    }
    // 同审批：别人的运行挂起的人工输入任务，当前账号既看不到也答不了。
    if (ownerValue() && !this.getRun(row.run_id)) {
      return undefined;
    }
    return toInteractionRecord(row);
  }

  listInteractions(
    options: { runId?: string; status?: InteractionStatus; limit?: number } = {}
  ): InteractionRecord[] {
    const clauses: string[] = [];
    const params: string[] = [];
    // 同审批：交互任务也挂在运行下面，跟着运行归属走。
    const runOwner = ownerScope("r");
    clauses.push(`run_id IN (SELECT r.id FROM platform_runs r WHERE 1 = 1${runOwner.and})`);
    params.push(...runOwner.params);
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
      .prepare(
        `SELECT * FROM platform_interactions ${where} ORDER BY created_at ASC, rowid ASC LIMIT ?`
      )
      .all(...params, limit) as InteractionRow[];
    return rows.map(toInteractionRecord);
  }

  decideInteraction(
    id: string,
    status: Exclude<InteractionStatus, "pending">,
    response?: Record<string, unknown>,
    actor?: string
  ): InteractionRecord | undefined {
    this.db
      .prepare(
        "UPDATE platform_interactions SET status = ?, response = ?, actor = ?, decided_at = ? WHERE id = ? AND status = 'pending'"
      )
      .run(
        status,
        response === undefined ? null : JSON.stringify(response),
        actor ?? null,
        new Date().toISOString(),
        id
      );
    return this.getInteraction(id);
  }

  recordLoopIteration(input: RecordLoopInput): string {
    const id = randomUUID();
    this.db
      .prepare(
        `
        INSERT INTO platform_loop_iterations
          (id, run_id, loop_node_id, iteration, score_before, score_after, action, model_before, model_after, changes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        input.modelBefore ?? null,
        input.modelAfter ?? null,
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
      modelBefore: row.model_before ?? undefined,
      modelAfter: row.model_after ?? undefined,
      changes: fromJson<string[]>(row.changes) ?? [],
      createdAt: row.created_at
    }));
  }

  // ---------------------------------------------------------------------------
  // 演化控制面：发布快照、候选、评测、灰度、告警与哈希链账本。
  // ---------------------------------------------------------------------------

  nextReleaseVersion(workflowId: string): number {
    const row = this.db
      .prepare("SELECT MAX(version) AS version FROM platform_release_manifests WHERE workflow_id = ?")
      .get(workflowId) as { version: number | null } | undefined;
    return (row?.version ?? 0) + 1;
  }

  saveRelease(manifest: ReleaseManifest): ReleaseManifest {
    this.db
      .prepare(
        `
        INSERT INTO platform_release_manifests
          (id, workflow_id, version, label, status, origin, parent_release_id, candidate_id,
           artifact, artifact_hash, change_summary, created_by, created_at, activated_at, retired_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        manifest.id,
        manifest.workflowId,
        manifest.version,
        manifest.label,
        manifest.status,
        manifest.origin,
        manifest.parentReleaseId ?? null,
        manifest.candidateId ?? null,
        canonicalJson(manifest.artifact),
        manifest.artifactHash,
        manifest.changeSummary,
        manifest.createdBy,
        manifest.createdAt,
        manifest.activatedAt ?? null,
        manifest.retiredAt ?? null
      );
    return manifest;
  }

  getRelease(id: string): ReleaseManifest | undefined {
    const row = this.db
      .prepare("SELECT * FROM platform_release_manifests WHERE id = ?")
      .get(id) as ReleaseRow | undefined;
    return row ? toReleaseManifest(row) : undefined;
  }

  listReleases(workflowId = "", limit = 100): ReleaseManifest[] {
    const capped = Math.min(Math.max(limit, 1), 500);
    const rows = (
      workflowId
        ? this.db
            .prepare(
              "SELECT * FROM platform_release_manifests WHERE workflow_id = ? ORDER BY workflow_id ASC, version DESC LIMIT ?"
            )
            .all(workflowId, capped)
        : this.db
            .prepare("SELECT * FROM platform_release_manifests ORDER BY created_at DESC, rowid DESC LIMIT ?")
            .all(capped)
    ) as ReleaseRow[];
    return rows.map(toReleaseManifest);
  }

  /** 当前承接流量的发布：同一工作流只保留一个 active/canary。 */
  activeReleaseFor(workflowId: string): ReleaseManifest | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM platform_release_manifests WHERE workflow_id = ? AND status IN ('active', 'canary') ORDER BY version DESC LIMIT 1"
      )
      .get(workflowId) as ReleaseRow | undefined;
    return row ? toReleaseManifest(row) : undefined;
  }

  updateReleaseStatus(
    id: string,
    status: ReleaseStatus,
    patch: { activatedAt?: string; retiredAt?: string } = {}
  ): ReleaseManifest | undefined {
    this.db
      .prepare(
        "UPDATE platform_release_manifests SET status = ?, activated_at = COALESCE(?, activated_at), retired_at = COALESCE(?, retired_at) WHERE id = ?"
      )
      .run(status, patch.activatedAt ?? null, patch.retiredAt ?? null, id);
    return this.getRelease(id);
  }

  saveCandidate(candidate: EvolutionCandidate): EvolutionCandidate {
    this.db
      .prepare(
        `
        INSERT INTO platform_evolution_candidates
          (id, workflow_id, base_release_id, source, title, summary, changes, proposed_by, status,
           gate, security, eval_run_id, draft_release_id, promoted_release_id,
           created_at, updated_at, decided_at, decided_by, decision_comment)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        candidate.id,
        candidate.workflowId,
        candidate.baseReleaseId,
        candidate.source,
        candidate.title,
        candidate.summary,
        JSON.stringify(candidate.changes),
        candidate.proposedBy,
        candidate.status,
        candidate.gate === undefined ? null : JSON.stringify(candidate.gate),
        candidate.security === undefined ? null : JSON.stringify(candidate.security),
        candidate.evalRunId ?? null,
        candidate.draftReleaseId ?? null,
        candidate.promotedReleaseId ?? null,
        candidate.createdAt,
        candidate.updatedAt,
        candidate.decidedAt ?? null,
        candidate.decidedBy ?? null,
        candidate.decisionComment ?? null
      );
    return candidate;
  }

  getCandidate(id: string): EvolutionCandidate | undefined {
    const row = this.db
      .prepare("SELECT * FROM platform_evolution_candidates WHERE id = ?")
      .get(id) as CandidateRow | undefined;
    return row ? toCandidate(row) : undefined;
  }

  listCandidates(workflowId = "", limit = 50): EvolutionCandidate[] {
    const capped = Math.min(Math.max(limit, 1), 200);
    const rows = (
      workflowId
        ? this.db
            .prepare(
              "SELECT * FROM platform_evolution_candidates WHERE workflow_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?"
            )
            .all(workflowId, capped)
        : this.db
            .prepare("SELECT * FROM platform_evolution_candidates ORDER BY created_at DESC, rowid DESC LIMIT ?")
            .all(capped)
    ) as CandidateRow[];
    return rows.map(toCandidate);
  }

  updateCandidate(
    id: string,
    patch: Partial<
      Pick<
        EvolutionCandidate,
        | "status"
        | "gate"
        | "security"
        | "evalRunId"
        | "draftReleaseId"
        | "promotedReleaseId"
        | "decidedAt"
        | "decidedBy"
        | "decisionComment"
      >
    >
  ): EvolutionCandidate | undefined {
    const current = this.getCandidate(id);
    if (!current) {
      return undefined;
    }
    const next: EvolutionCandidate = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString()
    };
    this.db
      .prepare(
        `
        UPDATE platform_evolution_candidates SET
          status = ?, gate = ?, security = ?, eval_run_id = ?, draft_release_id = ?,
          promoted_release_id = ?, updated_at = ?, decided_at = ?, decided_by = ?, decision_comment = ?
        WHERE id = ?
        `
      )
      .run(
        next.status,
        next.gate === undefined ? null : JSON.stringify(next.gate),
        next.security === undefined ? null : JSON.stringify(next.security),
        next.evalRunId ?? null,
        next.draftReleaseId ?? null,
        next.promotedReleaseId ?? null,
        next.updatedAt,
        next.decidedAt ?? null,
        next.decidedBy ?? null,
        next.decisionComment ?? null,
        id
      );
    return next;
  }

  saveDataset(dataset: EvaluationDataset): EvaluationDataset {
    this.db
      .prepare(
        `
        INSERT INTO platform_evaluation_datasets
          (id, workflow_id, name, version, description, cases, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name, version = excluded.version, description = excluded.description,
          cases = excluded.cases
        `
      )
      .run(
        dataset.id,
        dataset.workflowId,
        dataset.name,
        dataset.version,
        dataset.description,
        JSON.stringify(dataset.cases),
        dataset.createdAt
      );
    return dataset;
  }

  getDataset(id: string): EvaluationDataset | undefined {
    const row = this.db
      .prepare("SELECT * FROM platform_evaluation_datasets WHERE id = ?")
      .get(id) as DatasetRow | undefined;
    return row ? toDataset(row) : undefined;
  }

  listDatasets(workflowId = ""): EvaluationDataset[] {
    const rows = (
      workflowId
        ? this.db
            .prepare(
              "SELECT * FROM platform_evaluation_datasets WHERE workflow_id = ? ORDER BY created_at DESC, rowid DESC"
            )
            .all(workflowId)
        : this.db
            .prepare("SELECT * FROM platform_evaluation_datasets ORDER BY created_at DESC, rowid DESC")
            .all()
    ) as DatasetRow[];
    return rows.map(toDataset);
  }

  saveEvaluationRun(run: EvaluationRun): EvaluationRun {
    this.db
      .prepare(
        `
        INSERT INTO platform_evaluation_runs
          (id, candidate_id, dataset_id, base_release_id, candidate_release_id, mode, status, decision, error, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          decision = excluded.decision,
          error = excluded.error,
          finished_at = excluded.finished_at
        `
      )
      .run(
        run.id,
        run.candidateId,
        run.datasetId,
        run.baseReleaseId,
        run.candidateReleaseId,
        run.mode,
        run.status,
        run.decision === undefined ? null : JSON.stringify(run.decision),
        run.error ?? null,
        run.startedAt,
        run.finishedAt ?? null
      );
    return run;
  }

  getEvaluationRun(id: string): EvaluationRun | undefined {
    const row = this.db
      .prepare("SELECT * FROM platform_evaluation_runs WHERE id = ?")
      .get(id) as EvaluationRunRow | undefined;
    return row ? toEvaluationRun(row) : undefined;
  }

  listEvaluationRuns(candidateId = "", limit = 50): EvaluationRun[] {
    const capped = Math.min(Math.max(limit, 1), 200);
    const rows = (
      candidateId
        ? this.db
            .prepare(
              "SELECT * FROM platform_evaluation_runs WHERE candidate_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?"
            )
            .all(candidateId, capped)
        : this.db
            .prepare("SELECT * FROM platform_evaluation_runs ORDER BY started_at DESC, rowid DESC LIMIT ?")
            .all(capped)
    ) as EvaluationRunRow[];
    return rows.map(toEvaluationRun);
  }

  saveRollout(rollout: ReleaseRollout): ReleaseRollout {
    this.db
      .prepare(
        `
        INSERT INTO platform_release_rollouts
          (id, workflow_id, release_id, base_release_id, percent, status, min_samples_per_arm,
           max_error_rate_delta, max_score_drop, rollback_reason, created_by, created_at, updated_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        rollout.id,
        rollout.workflowId,
        rollout.releaseId,
        rollout.baseReleaseId,
        rollout.percent,
        rollout.status,
        rollout.minSamplesPerArm,
        rollout.maxErrorRateDelta,
        rollout.maxScoreDrop,
        rollout.rollbackReason ?? null,
        rollout.createdBy,
        rollout.createdAt,
        rollout.updatedAt,
        rollout.finishedAt ?? null
      );
    return rollout;
  }

  getRollout(id: string): ReleaseRollout | undefined {
    const row = this.db
      .prepare("SELECT * FROM platform_release_rollouts WHERE id = ?")
      .get(id) as RolloutRow | undefined;
    return row ? toRollout(row) : undefined;
  }

  listRollouts(workflowId = "", limit = 50): ReleaseRollout[] {
    const capped = Math.min(Math.max(limit, 1), 200);
    const rows = (
      workflowId
        ? this.db
            .prepare(
              "SELECT * FROM platform_release_rollouts WHERE workflow_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?"
            )
            .all(workflowId, capped)
        : this.db
            .prepare("SELECT * FROM platform_release_rollouts ORDER BY created_at DESC, rowid DESC LIMIT ?")
            .all(capped)
    ) as RolloutRow[];
    return rows.map(toRollout);
  }

  activeRolloutFor(workflowId: string): ReleaseRollout | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM platform_release_rollouts WHERE workflow_id = ? AND status = 'canary' ORDER BY created_at DESC, rowid DESC LIMIT 1"
      )
      .get(workflowId) as RolloutRow | undefined;
    return row ? toRollout(row) : undefined;
  }

  updateRollout(
    id: string,
    patch: Partial<
      Pick<ReleaseRollout, "status" | "rollbackReason" | "percent" | "finishedAt">
    >
  ): ReleaseRollout | undefined {
    const current = this.getRollout(id);
    if (!current) {
      return undefined;
    }
    const next: ReleaseRollout = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString()
    };
    this.db
      .prepare(
        "UPDATE platform_release_rollouts SET status = ?, percent = ?, rollback_reason = ?, updated_at = ?, finished_at = ? WHERE id = ?"
      )
      .run(
        next.status,
        next.percent,
        next.rollbackReason ?? null,
        next.updatedAt,
        next.finishedAt ?? null,
        id
      );
    return next;
  }

  saveAssignment(assignment: RunReleaseAssignment): RunReleaseAssignment {
    this.db
      .prepare(
        `
        INSERT INTO platform_run_assignments
          (run_id, workflow_id, release_id, base_release_id, experiment_id, arm, rollout_id, assignment_key, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          release_id = excluded.release_id, arm = excluded.arm, rollout_id = excluded.rollout_id
        `
      )
      .run(
        assignment.runId,
        assignment.workflowId,
        assignment.releaseId,
        assignment.baseReleaseId ?? null,
        assignment.experimentId ?? null,
        assignment.arm,
        assignment.rolloutId ?? null,
        assignment.assignmentKey ?? null,
        assignment.createdAt
      );
    return assignment;
  }

  getAssignment(runId: string): RunReleaseAssignment | undefined {
    const row = this.db
      .prepare("SELECT * FROM platform_run_assignments WHERE run_id = ?")
      .get(runId) as AssignmentRow | undefined;
    return row ? toAssignment(row) : undefined;
  }

  recordObservation(observation: RolloutObservation): RolloutObservation {
    this.db
      .prepare(
        `
        INSERT INTO platform_evolution_observations
          (id, rollout_id, run_id, arm, workflow_id, release_id, status, passed, score, duration_ms, tokens, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(rollout_id, run_id) DO NOTHING
        `
      )
      .run(
        observation.id,
        observation.rolloutId,
        observation.runId,
        observation.arm,
        observation.workflowId,
        observation.releaseId,
        observation.status,
        observation.passed ? 1 : 0,
        observation.score ?? null,
        observation.durationMs ?? null,
        observation.tokens ?? null,
        observation.createdAt
      );
    return observation;
  }

  listObservations(rolloutId: string): RolloutObservation[] {
    const rows = this.db
      .prepare("SELECT * FROM platform_evolution_observations WHERE rollout_id = ? ORDER BY created_at ASC, rowid ASC")
      .all(rolloutId) as ObservationRow[];
    return rows.map(toObservation);
  }

  appendAlert(alert: EvolutionAlert): EvolutionAlert {
    this.db
      .prepare(
        `
        INSERT INTO platform_evolution_alerts
          (id, severity, kind, entity_type, entity_id, title, detail, acknowledged, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        alert.id,
        alert.severity,
        alert.kind,
        alert.entityType,
        alert.entityId,
        alert.title,
        alert.detail,
        alert.acknowledged ? 1 : 0,
        alert.createdAt
      );
    return alert;
  }

  listAlerts(options: { acknowledged?: boolean; limit?: number } = {}): EvolutionAlert[] {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options.acknowledged !== undefined) {
      clauses.push("acknowledged = ?");
      params.push(options.acknowledged ? 1 : 0);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM platform_evolution_alerts ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...params, limit) as AlertRow[];
    return rows.map(toAlert);
  }

  acknowledgeAlert(id: string): EvolutionAlert | undefined {
    this.db.prepare("UPDATE platform_evolution_alerts SET acknowledged = 1 WHERE id = ?").run(id);
    const row = this.db
      .prepare("SELECT * FROM platform_evolution_alerts WHERE id = ?")
      .get(id) as AlertRow | undefined;
    return row ? toAlert(row) : undefined;
  }

  appendLedgerEvent(
    type: LedgerEventType,
    entityType: string,
    entityId: string,
    payload: Record<string, unknown>
  ): LedgerEvent {
    const transaction = this.db.transaction(() => {
      const last = this.db
        .prepare("SELECT hash FROM platform_evolution_ledger ORDER BY seq DESC LIMIT 1")
        .get() as { hash: string } | undefined;
      const prevHash = last?.hash ?? "0".repeat(64);
      const createdAt = new Date().toISOString();
      const body = canonicalJson({ type, entityType, entityId, payload });
      const hash = sha256(`${prevHash}\n${body}\n${createdAt}`);
      const result = this.db
        .prepare(
          `
          INSERT INTO platform_evolution_ledger
            (type, entity_type, entity_id, payload, prev_hash, hash, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(type, entityType, entityId, JSON.stringify(payload), prevHash, hash, createdAt);
      return {
        seq: Number(result.lastInsertRowid),
        type,
        entityType,
        entityId,
        payload,
        prevHash,
        hash,
        createdAt
      } satisfies LedgerEvent;
    });
    return transaction();
  }

  listLedger(limit = 200): LedgerEvent[] {
    const capped = Math.min(Math.max(limit, 1), 1000);
    const rows = this.db
      .prepare("SELECT * FROM platform_evolution_ledger ORDER BY seq DESC LIMIT ?")
      .all(capped) as LedgerRow[];
    return rows.reverse().map(toLedgerEvent);
  }

  /** 重算哈希链，返回第一处断裂位置；空账本视为有效。 */
  verifyLedger(): { valid: boolean; events: number; brokenAt?: number } {
    const rows = this.db
      .prepare("SELECT * FROM platform_evolution_ledger ORDER BY seq ASC")
      .all() as LedgerRow[];
    let prevHash = "0".repeat(64);
    for (const row of rows) {
      const body = canonicalJson({
        type: row.type,
        entityType: row.entity_type,
        entityId: row.entity_id,
        payload: fromJson<Record<string, unknown>>(row.payload) ?? {}
      });
      const expected = sha256(`${prevHash}\n${body}\n${row.created_at}`);
      if (row.prev_hash !== prevHash || row.hash !== expected) {
        return { valid: false, events: rows.length, brokenAt: row.seq };
      }
      prevHash = row.hash;
    }
    return { valid: true, events: rows.length };
  }
}

function toSchedulerLease(row: SchedulerLeaseRow): SchedulerLease {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id ?? undefined,
    taskId: row.task_id ?? undefined,
    taskPath: row.task_path,
    agentId: row.agent_id,
    workerId: row.worker_id,
    status: row.status,
    acquiredAt: row.acquired_at,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at,
    releasedAt: row.released_at ?? undefined,
    releaseReason: row.release_reason ?? undefined
  };
}

function toSchedulerQueueEntry(row: SchedulerQueueRow): SchedulerQueueEntry {  return {
    id: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    path: row.path,
    priority: row.priority,
    status: row.status,
    enqueuedAt: row.enqueued_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    waitMs: row.wait_ms ?? undefined,
    reason: row.reason ?? undefined,
    requiredCapability: row.required_capability ?? undefined,
    priorityClass: row.priority_class,
    effectivePriority: row.effective_priority ?? row.priority,
    profile: row.profile === null ? undefined : fromJson<Record<string, unknown>>(row.profile),
    agentId: row.agent_id ?? undefined,
    claimedBy: row.claimed_by ?? undefined,
    claimExpiresAt: row.claim_expires_at ?? undefined,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    deadlineAt: row.deadline_at ?? undefined
  };
}

function toSchedulerWorker(row: SchedulerWorkerRow): SchedulerWorker {
  return {
    id: row.id,
    host: row.host,
    pid: row.pid ?? undefined,
    slot: row.slot ?? undefined,
    lane: row.lane,
    capabilities: fromJson<string[]>(row.capabilities) ?? [],
    capacity: row.capacity,
    status: row.status,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at,
    stoppedAt: row.stopped_at ?? undefined,
    stopReason: row.stop_reason ?? undefined,
    meta: row.meta === null ? undefined : fromJson<Record<string, unknown>>(row.meta)
  };
}

function toSchedulerAttempt(row: SchedulerAttemptRow): SchedulerAttempt {
  return {
    id: row.id,
    queueId: row.queue_id,
    attempt: row.attempt,
    workerId: row.worker_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    status: row.status,
    leaseId: row.lease_id ?? undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    waitMs: row.wait_ms ?? undefined,
    error: row.error ?? undefined,
    trace: row.trace === null ? undefined : fromJson<Record<string, unknown>>(row.trace)
  };
}

function toRunNode(row: RunNodeRow): RunNodeRecord {
  return {
    runId: row.run_id,
    nodeId: row.node_id,
    path: row.path,
    status: row.status,
    priority: row.priority,
    readyAt: row.ready_at ?? undefined,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    attempts: row.attempts,
    error: row.error ?? undefined
  };
}

function toRunCheckpoint(row: RunCheckpointRow): RunCheckpoint {
  return {
    id: row.id,
    runId: row.run_id,
    sequence: row.sequence,
    state: fromJson<Record<string, unknown>>(row.state) ?? {},
    createdAt: row.created_at
  };
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

function toInteractionRecord(row: InteractionRow): InteractionRecord {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    nodeId: row.node_id,
    path: row.path,
    title: row.title,
    prompt: row.prompt,
    fields: JSON.parse(row.fields) as HumanField[],
    context: row.context === null ? undefined : (JSON.parse(row.context) as Record<string, unknown>),
    status: row.status,
    response: row.response === null ? undefined : (JSON.parse(row.response) as Record<string, unknown>),
    actor: row.actor ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    createdAt: row.created_at,
    decidedAt: row.decided_at ?? undefined
  };
}

function toStepRecord(row: StepRow): StepRecord {  return {
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
    definition: row.definition === null ? undefined : fromJson<WorkflowDefinition>(row.definition),
    output: row.output === null ? undefined : fromJson<Record<string, unknown>>(row.output),
    error: row.error ?? undefined,
    stepCount: row.step_count,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    releaseId: row.release_id ?? undefined,
    experimentId: row.experiment_id ?? undefined,
    arm: row.arm ?? undefined,
    priorityClass: row.priority_class ?? undefined,
    deadlineAt: row.deadline_at ?? undefined,
    cancelRequestedAt: row.cancel_requested_at ?? undefined,
    resumeCount: row.resume_count ?? undefined,
    schedulerState: row.scheduler_state ?? undefined
  };
}

function toReleaseManifest(row: ReleaseRow): ReleaseManifest {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    version: row.version,
    label: row.label,
    status: row.status,
    origin: row.origin,
    parentReleaseId: row.parent_release_id ?? undefined,
    candidateId: row.candidate_id ?? undefined,
    artifact: fromJson<ReleaseManifest["artifact"]>(row.artifact) ?? {
      workflow: {} as ReleaseManifest["artifact"]["workflow"],
      workflows: [],
      agents: []
    },
    artifactHash: row.artifact_hash,
    changeSummary: row.change_summary,
    createdBy: row.created_by,
    createdAt: row.created_at,
    activatedAt: row.activated_at ?? undefined,
    retiredAt: row.retired_at ?? undefined
  };
}

function toCandidate(row: CandidateRow): EvolutionCandidate {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    baseReleaseId: row.base_release_id,
    source: row.source,
    title: row.title,
    summary: row.summary,
    changes: fromJson<EvolutionCandidate["changes"]>(row.changes) ?? [],
    proposedBy: row.proposed_by,
    status: row.status,
    gate: row.gate === null ? undefined : fromJson<EvolutionCandidate["gate"]>(row.gate),
    security: row.security === null ? undefined : fromJson<EvolutionCandidate["security"]>(row.security),
    evalRunId: row.eval_run_id ?? undefined,
    draftReleaseId: row.draft_release_id ?? undefined,
    promotedReleaseId: row.promoted_release_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at ?? undefined,
    decidedBy: row.decided_by ?? undefined,
    decisionComment: row.decision_comment ?? undefined
  };
}

function toDataset(row: DatasetRow): EvaluationDataset {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    name: row.name,
    version: row.version,
    description: row.description,
    cases: fromJson<EvaluationDataset["cases"]>(row.cases) ?? [],
    createdAt: row.created_at
  };
}

function toEvaluationRun(row: EvaluationRunRow): EvaluationRun {
  return {
    id: row.id,
    candidateId: row.candidate_id,
    datasetId: row.dataset_id,
    baseReleaseId: row.base_release_id,
    candidateReleaseId: row.candidate_release_id,
    mode: row.mode,
    status: row.status,
    decision: row.decision === null ? undefined : fromJson<EvaluationRun["decision"]>(row.decision),
    error: row.error ?? undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined
  };
}

function toRollout(row: RolloutRow): ReleaseRollout {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    releaseId: row.release_id,
    baseReleaseId: row.base_release_id,
    percent: row.percent,
    status: row.status,
    minSamplesPerArm: row.min_samples_per_arm,
    maxErrorRateDelta: row.max_error_rate_delta,
    maxScoreDrop: row.max_score_drop,
    rollbackReason: row.rollback_reason ?? undefined,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at ?? undefined
  };
}

function toAssignment(row: AssignmentRow): RunReleaseAssignment {
  return {
    runId: row.run_id,
    workflowId: row.workflow_id,
    releaseId: row.release_id,
    baseReleaseId: row.base_release_id ?? undefined,
    experimentId: row.experiment_id ?? undefined,
    arm: row.arm,
    rolloutId: row.rollout_id ?? undefined,
    assignmentKey: row.assignment_key ?? undefined,
    createdAt: row.created_at
  };
}

function toObservation(row: ObservationRow): RolloutObservation {
  return {
    id: row.id,
    rolloutId: row.rollout_id,
    runId: row.run_id,
    arm: row.arm,
    workflowId: row.workflow_id,
    releaseId: row.release_id,
    status: row.status,
    passed: row.passed === 1,
    score: row.score ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    tokens: row.tokens ?? undefined,
    createdAt: row.created_at
  };
}

function toAlert(row: AlertRow): EvolutionAlert {
  return {
    id: row.id,
    severity: row.severity,
    kind: row.kind,
    entityType: row.entity_type,
    entityId: row.entity_id,
    title: row.title,
    detail: row.detail,
    acknowledged: row.acknowledged === 1,
    createdAt: row.created_at
  };
}

function toLedgerEvent(row: LedgerRow): LedgerEvent {
  return {
    seq: row.seq,
    type: row.type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    payload: fromJson<Record<string, unknown>>(row.payload) ?? {},
    prevHash: row.prev_hash,
    hash: row.hash,
    createdAt: row.created_at
  };
}

function toAgentRecord(row: AgentRow, table: "platform" | "chat"): AgentRecord {
  const chat = row as Partial<ChatAgentRow>;
  const owned = row.owner_id ?? null;
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
    updatedAt: row.updated_at,
    source: table === "chat" || owned ? "custom" : "builtin",
    description: typeof chat.description === "string" ? chat.description : "",
    avatar: typeof chat.avatar === "string" ? chat.avatar : "",
    chatConfig: chat.config ? (fromJson<AgentRecord["chatConfig"]>(chat.config) ?? {}) : undefined
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
    updatedAt: row.updated_at,
    source: row.owner_id ? "custom" : "builtin"
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
    updatedAt: row.updated_at,
    ownerId: row.owner_id ?? null
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
