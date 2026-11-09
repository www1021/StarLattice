import assert from "node:assert/strict";
import test from "node:test";
import { PlatformError } from "../types.js";
import {
  getModelCatalog,
  resolveAgentModel,
  resolveModel,
  resolveVerificationModel,
  validateAgentModel
} from "./catalog.js";

function withEnv(values: Record<string, string | undefined>) {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
}

test("node model overrides agent model, and agent model overrides the platform default", () => {
  const restore = withEnv({
    QWEN_API_KEY: "test-key",
    PLATFORM_LIVE_MODEL: "default-model",
    PLATFORM_MODEL_FAST: "fast-model",
    PLATFORM_MODEL_REASONING: "strong-model"
  });
  try {
    const fromAgent = resolveAgentModel({ agentModel: "fast" });
    assert.equal(fromAgent.id, "fast");
    assert.equal(fromAgent.model, "fast-model");
    assert.equal(fromAgent.source, "agent");

    const fromNode = resolveAgentModel({ nodeModel: "reasoning", agentModel: "fast" });
    assert.equal(fromNode.id, "reasoning");
    assert.equal(fromNode.model, "strong-model");
    assert.equal(fromNode.source, "node");

    const byDefault = resolveAgentModel({ agentModel: "platform-default" });
    assert.equal(byDefault.model, "default-model");
  } finally {
    restore();
  }
});

test("unknown models fall back explicitly instead of resolving silently", () => {
  const restore = withEnv({
    QWEN_API_KEY: "test-key",
    PLATFORM_LIVE_MODEL: "default-model"
  });
  try {
    const raw = resolveModel("vendor-model-x");
    assert.equal(raw.model, "vendor-model-x");
    assert.equal(raw.source, "fallback");
    assert.equal(raw.fallback?.requestedModel, "vendor-model-x");

    const denied = resolveModel("vendor-model-x", { allowRaw: false });
    assert.equal(denied.id, "platform-default");
    assert.equal(denied.source, "fallback");
    assert.match(denied.fallback?.reason ?? "", /不在模型目录/);
  } finally {
    restore();
  }
});

test("budget exhaustion downgrades a high-cost model to the low-cost profile", () => {
  const restore = withEnv({
    QWEN_API_KEY: "test-key",
    PLATFORM_LIVE_MODEL: "default-model",
    PLATFORM_MODEL_FAST: "fast-model",
    PLATFORM_MODEL_REASONING: "strong-model"
  });
  try {
    const downgraded = resolveModel("reasoning", { budgetExceeded: true });
    assert.equal(downgraded.id, "fast");
    assert.equal(downgraded.source, "budget-downgrade");
    assert.equal(downgraded.downgraded?.from, "reasoning");

    const preserved = resolveModel("reasoning", { budgetExceeded: true, downgrade: false });
    assert.equal(preserved.id, "reasoning");
  } finally {
    restore();
  }
});

test("verification model prefers node, then agent, then PLATFORM_VERIFY_MODEL", () => {
  const restore = withEnv({
    QWEN_API_KEY: "test-key",
    PLATFORM_LIVE_MODEL: "default-model",
    PLATFORM_MODEL_FAST: "fast-model",
    PLATFORM_VERIFY_MODEL: "fast"
  });
  try {
    assert.equal(resolveVerificationModel({ nodeModel: "verifier" }).id, "verifier");
    assert.equal(resolveVerificationModel({ agentModel: "reasoning" }).id, "reasoning");
    const envPick = resolveVerificationModel({ agentModel: "platform-default" });
    assert.equal(envPick.id, "fast");
    assert.equal(envPick.source, "verifier");
  } finally {
    restore();
  }
});

test("agent model validation rejects unknown logical ids with 422", () => {
  assert.equal(validateAgentModel(undefined), "platform-default");
  assert.equal(validateAgentModel("fast"), "fast");
  assert.throws(
    () => validateAgentModel("not-registered"),
    (error: unknown) =>
      error instanceof PlatformError &&
      error.status === 422 &&
      /可用逻辑模型/.test(error.message)
  );
});

test("PLATFORM_MODEL_CATALOG registers custom OpenAI-compatible providers", () => {
  const restore = withEnv({
    QWEN_API_KEY: "test-key",
    CUSTOM_KEY: "custom-key",
    PLATFORM_MODEL_CATALOG: JSON.stringify([
      {
        id: "local-strong",
        label: "本地推理",
        model: "local-model",
        baseUrl: "https://local.example/v1",
        apiKeyEnv: "CUSTOM_KEY",
        tags: ["reasoning"],
        costTier: "high"
      }
    ])
  });
  try {
    const profile = getModelCatalog().find((item) => item.id === "local-strong");
    assert.ok(profile);
    assert.equal(profile.provider, "openai-compatible");
    assert.equal(profile.apiKey, "custom-key");
    assert.equal(profile.baseUrl, "https://local.example/v1");

    const resolution = resolveModel("local-strong");
    assert.equal(resolution.model, "local-model");
    assert.equal(resolution.source, "default");
  } finally {
    restore();
  }
});

test("a logical model alias inherits the target provider instead of sending the id upstream", () => {
  const restore = withEnv({
    QWEN_API_KEY: "test-key",
    MINIMAX_API_KEY: "minimax-key",
    PLATFORM_VERIFY_MODEL: "minimax"
  });
  try {
    const resolution = resolveModel("verifier");
    assert.equal(resolution.provider, "minimax");
    assert.match(resolution.baseUrl, /minimax/);
    assert.equal(resolution.apiKey, "minimax-key");
    assert.notEqual(resolution.model, "minimax");
  } finally {
    restore();
  }
});
