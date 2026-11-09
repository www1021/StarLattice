import type { AgentRecord, WorkflowDefinition } from "../types.js";
import type { EvolutionChange, ReleaseArtifact } from "./types.js";
import { canonicalJson, sha256 } from "./util.js";

/**
 * 把候选变更应用到发布快照，返回新快照与哈希。
 * 这里是唯一允许修改快照的入口，原快照保持不变，便于回滚与审计。
 */
export function applyEvolutionChanges(
  artifact: ReleaseArtifact,
  changes: EvolutionChange[],
  header: string
): { artifact: ReleaseArtifact; hash: string } {
  const agents = artifact.agents.map((agent) => cloneAgent(agent));
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  let workflows = artifact.workflows.map((workflow) => cloneWorkflow(workflow));

  for (const change of changes) {
    if (change.kind === "prompt_patch") {
      const agent = byId.get(change.target);
      if (!agent) {
        continue;
      }
      agent.prompt = `${agent.prompt}\n\n## ${header}\n${change.after.trim()}`;
      continue;
    }
    if (change.kind === "model_route") {
      const agent = byId.get(change.target);
      if (agent) {
        agent.model = change.after.trim();
      }
      continue;
    }
    if (change.kind === "tool_policy") {
      const agent = byId.get(change.target);
      if (agent) {
        agent.tools = change.after
          .split(/[,，\s]+/)
          .map((item) => item.trim())
          .filter(Boolean);
      }
      continue;
    }
    if (change.kind === "agent_swap") {
      workflows = workflows.map((workflow) => swapAgent(workflow, change.target, change.after.trim()));
    }
  }

  const next = {
    workflow: workflows.find((workflow) => workflow.id === artifact.workflow.id) ?? cloneWorkflow(artifact.workflow),
    workflows,
    agents
  };
  return { artifact: next, hash: sha256(canonicalJson(next)) };
}

function swapAgent(workflow: WorkflowDefinition, target: string, agentId: string): WorkflowDefinition {
  const next = cloneWorkflow(workflow);
  next.nodes = next.nodes.map((node) => {
    if (node.kind !== "agent" || node.id !== target) {
      return node;
    }
    return { ...node, agent: agentId, agentVersion: undefined };
  });
  return next;
}

function cloneAgent(agent: AgentRecord): AgentRecord {
  return {
    ...agent,
    tools: [...agent.tools],
    capabilities: agent.capabilities.map((capability) => ({ ...capability })),
    memory: JSON.parse(JSON.stringify(agent.memory)) as Record<string, unknown>
  };
}

function cloneWorkflow(workflow: WorkflowDefinition): WorkflowDefinition {
  return JSON.parse(JSON.stringify(workflow)) as WorkflowDefinition;
}
