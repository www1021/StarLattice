import assert from "node:assert/strict";
import test from "node:test";
import { BUILTIN_AGENTS } from "../registry/agents.js";
import type { AgentRecord } from "../types.js";
import { buildAgentSystemPrompt } from "./liveHandlers.js";

test("injects registry tools and memory into the agent system prompt", () => {
  const authored = BUILTIN_AGENTS.find((agent) => agent.id === "lesson-plan-agent");
  assert.ok(authored);
  const agent: AgentRecord = {
    ...authored,
    version: 1,
    enabled: true,
    createdAt: "",
    updatedAt: ""
  };

  const prompt = buildAgentSystemPrompt(agent);
  assert.match(prompt, /knowledge\.search/);
  assert.match(prompt, /记忆配置/);
  assert.match(prompt, /lessonPlanDraft/);
});
