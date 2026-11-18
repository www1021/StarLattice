import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PlatformError } from "../types.js";
import {
  getModelCatalog,
  getModelProfile,
  isAnyModelConfigured,
  resolveAgentModel,
  resolveModel,
  resolveVerificationModel,
  validateAgentModel
} from "./catalog.js";
import { saveUserModel, setDefaultModelId } from "./userModels.js";
import { collectModelIds, listRemoteModels } from "./remoteModels.js";
import { probeModel, readErrorDetail } from "./probe.js";
import { normalizeBaseUrl } from "./baseUrl.js";

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

/** 每条用例用独立的设置目录，避免读到开发机上真实的 data/settings。 */
function withTempSettings(fn: () => void) {
  const dir = mkdtempSync(path.join(tmpdir(), "starlattice-models-"));
  const restore = withEnv({
    MODEL_SETTINGS_DIR: dir,
    QWEN_API_KEY: undefined,
    QUEEN_ACCESS_KEY: undefined,
    DASHSCOPE_API_KEY: undefined,
    AI_API_KEY: undefined,
    QWEN_MODEL: undefined,
    AI_MODEL: undefined,
    PLATFORM_LIVE_MODEL: undefined,
    PLATFORM_MODEL_FAST: undefined,
    PLATFORM_MODEL_REASONING: undefined,
    PLATFORM_VERIFY_MODEL: undefined,
    PLATFORM_MODEL_CATALOG: undefined
  });
  try {
    fn();
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
}

function addModel(id: string, options: { label?: string; costTier?: "low" | "medium" | "high"; model?: string } = {}) {
  saveUserModel({
    id,
    label: options.label ?? id,
    model: options.model ?? id,
    baseUrl: "https://api.example.com/v1",
    apiKey: `sk-${id}`,
    costTier: options.costTier ?? "medium"
  });
}

test("预置模型还没有密钥时，解析直接报出可操作的提示", () => {
  withTempSettings(() => {
    const catalog = getModelCatalog();
    // 首次使用只有三条预置骨架：地址、模型名给好，密钥空着。
    assert.deepEqual(
      catalog.map((item) => item.id),
      ["dashscope-qwen-plus", "dashscope-qwen-flash", "deepseek-deepseek-flash"]
    );
    assert.equal(catalog.every((item) => item.apiKey === ""), true);
    assert.equal(isAnyModelConfigured(), false);
    assert.throws(
      () => resolveModel(undefined),
      (error: unknown) =>
        error instanceof PlatformError && error.status === 422 && /设置 → 模型与密钥/.test(error.message)
    );
  });
});

test("目录只来自设置里加的模型，默认模型由用户选择决定", () => {
  withTempSettings(() => {
    addModel("deepseek-chat", { costTier: "low" });
    addModel("strong", { label: "强模型", model: "gpt-4o", costTier: "high" });
    setDefaultModelId("strong");

    const catalog = getModelCatalog();
    const ids = catalog.map((item) => item.id);
    // 预置骨架也在目录里，用户自己加的两条同样在。
    assert.equal(ids.includes("deepseek-chat"), true);
    assert.equal(ids.includes("strong"), true);
    assert.equal(ids.includes("dashscope-qwen-plus"), true);

    const byDefault = resolveModel(undefined);
    assert.equal(byDefault.id, "strong");
    assert.equal(byDefault.model, "gpt-4o");

    const explicit = resolveModel("deepseek-chat");
    assert.equal(explicit.id, "deepseek-chat");
    assert.equal(explicit.source, "default");
  });
});

test("编辑模型时密钥留空不覆盖，填了才换", () => {
  withTempSettings(() => {
    addModel("keep-key");
    // 只改显示名称、不传密钥：原密钥必须原样留着，否则用户改个名字就把密钥弄丢了。
    saveUserModel({
      id: "keep-key",
      label: "改过名字",
      model: "keep-key",
      baseUrl: "https://api.example.com/v1"
    });
    const kept = getModelProfile("keep-key");
    assert.equal(kept?.label, "改过名字");
    assert.equal(kept?.apiKey, "sk-keep-key");

    // 真传了新密钥就换掉。
    saveUserModel({
      id: "keep-key",
      model: "keep-key",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-brand-new"
    });
    assert.equal(getModelProfile("keep-key")?.apiKey, "sk-brand-new");
  });
});

test("角色 id 跟随默认模型，不再自带一套写死的档案", () => {
  withTempSettings(() => {
    addModel("deepseek-chat", { model: "deepseek-chat" });
    setDefaultModelId("deepseek-chat");

    for (const role of ["fast", "reasoning", "verifier", "vision"]) {
      const resolved = resolveModel(role, { source: "agent" });
      assert.equal(resolved.id, role);
      assert.equal(resolved.model, "deepseek-chat");
      assert.match(resolved.baseUrl, /api\.example\.com/);
    }

    const fromAgent = resolveAgentModel({ agentModel: "fast" });
    assert.equal(fromAgent.model, "deepseek-chat");
    assert.equal(fromAgent.source, "agent");

    assert.equal(resolveVerificationModel({}).model, "deepseek-chat");
  });
});

test("未知模型显式回退，不静默替换成别的东西", () => {
  withTempSettings(() => {
    addModel("deepseek-chat", { model: "deepseek-chat" });

    const raw = resolveModel("vendor-model-x");
    assert.equal(raw.model, "vendor-model-x");
    assert.equal(raw.source, "fallback");
    assert.equal(raw.fallback?.requestedModel, "vendor-model-x");

    const denied = resolveModel("vendor-model-x", { allowRaw: false });
    assert.equal(denied.id, "deepseek-chat");
    assert.equal(denied.source, "fallback");
    assert.match(denied.fallback?.reason ?? "", /不在模型列表/);

    assert.equal(getModelProfile("platform-default")?.id, "deepseek-chat");
  });
});

test("预算用尽时降级到成本最低的那条模型", () => {
  withTempSettings(() => {
    addModel("cheap", { costTier: "low", model: "cheap-model" });
    addModel("strong", { costTier: "high", model: "strong-model" });
    setDefaultModelId("strong");

    const downgraded = resolveModel("strong", { budgetExceeded: true });
    assert.equal(downgraded.id, "cheap");
    assert.equal(downgraded.source, "budget-downgrade");
    assert.equal(downgraded.downgraded?.from, "strong");

    const preserved = resolveModel("strong", { budgetExceeded: true, downgrade: false });
    assert.equal(preserved.id, "strong");
  });
});

test("环境变量里留着密钥也不算配了模型", () => {
  withTempSettings(() => {
    const restore = withEnv({
      QUEEN_ACCESS_KEY: "local-env-key",
      QWEN_API_KEY: "local-env-key",
      PLATFORM_LIVE_MODEL: "env-model"
    });
    try {
      // 密钥只有一个来源：设置面板。环境变量里的那把不再参与组装。
      // 目录里只剩三条没有密钥的预置骨架。
      assert.equal(getModelCatalog().length, 3);
      assert.equal(getModelProfile("platform-default")?.id, "dashscope-qwen-plus");
      assert.equal(isAnyModelConfigured(), false);
      assert.throws(() => resolveModel("platform-default"), /还没有填写 API Key/);
    } finally {
      restore();
    }
  });
});

test("环境变量里的模型目录不再生效，只认设置里加的", () => {
  withTempSettings(() => {
    addModel("local-base");
    const restore = withEnv({
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
      const ids = getModelCatalog().map((item) => item.id);
      assert.equal(ids.includes("local-base"), true);
      // 环境变量里那份目录不再被读进来。
      assert.equal(ids.includes("local-strong"), false);
      // 未登记的 id 不会凭空冒出一条带密钥的档案：只能按上游模型名直连默认接口，并打 fallback 标记。
      const resolution = resolveModel("local-strong");
      assert.equal(resolution.model, "local-strong");
      assert.equal(resolution.source, "fallback");
      assert.equal(resolution.apiKey, "sk-local-base");
      assert.equal(resolution.baseUrl, "https://api.example.com/v1");
    } finally {
      restore();
    }
  });
});

test("Agent 保存时接受角色 id 与已配置的模型 id，其余报 422", () => {
  withTempSettings(() => {
    addModel("deepseek-chat");
    assert.equal(validateAgentModel(undefined), "platform-default");
    assert.equal(validateAgentModel("fast"), "fast");
    assert.equal(validateAgentModel("deepseek-chat"), "deepseek-chat");
    assert.throws(
      () => validateAgentModel("not-registered"),
      (error: unknown) =>
        error instanceof PlatformError && error.status === 422 && /可用模型/.test(error.message)
    );
  });
});

test("模型名字里不允许带 URL 凭据，长度也有限制", () => {
  withTempSettings(() => {
    assert.throws(
      () =>
        saveUserModel({
          model: "some-model",
          baseUrl: "https://user:pass@api.example.com/v1",
          apiKey: "sk-test"
        }),
      (error: unknown) => error instanceof PlatformError && error.status === 422
    );
    assert.throws(
      () =>
        saveUserModel({
          model: "some-model",
          baseUrl: "file:///etc/passwd",
          apiKey: "sk-test"
        }),
      (error: unknown) => error instanceof PlatformError && error.status === 422
    );
  });
});

test("模型列表能从各家响应结构里抠出 ID 并去重排序", () => {
  assert.deepEqual(collectModelIds({ data: [{ id: "qwen-plus" }, { id: "qwen3-max" }] }), [
    "qwen-plus",
    "qwen3-max"
  ]);
  assert.deepEqual(collectModelIds({ data: ["gpt-4o", "gpt-4o", "o4-mini"] }), ["gpt-4o", "o4-mini"]);
  assert.deepEqual(collectModelIds({ models: [{ name: "glm-4.6" }, { model: "glm-4-flash" }] }), [
    "glm-4-flash",
    "glm-4.6"
  ]);
  assert.deepEqual(collectModelIds({ output: { models: [{ model: "hunyuan-turbos-latest" }] } }), [
    "hunyuan-turbos-latest"
  ]);
  assert.deepEqual(collectModelIds({ object: "list" }), []);
  assert.deepEqual(collectModelIds(null), []);
});

test("地址不合法时不去发请求，直接返回可读错误", async () => {
  const result = await listRemoteModels({ baseUrl: "api.example.com/v1", apiKey: "sk-test" });
  assert.equal(result.ok, false);
  assert.equal(result.models.length, 0);
  assert.match(result.message, /http/);
});

test("404 且上游说模型不存在时，提示要指到模型名而不是 baseUrl", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { message: "Model not exist." } }), {
      status: 404,
      headers: { "content-type": "application/json" }
    })) as typeof fetch;
  try {
    const result = await probeModel({
      baseUrl: "https://api.example.com/v1",
      model: "qwen3-max",
      apiKey: "sk-test"
    });
    assert.equal(result.status, 404);
    assert.match(result.message, /模型名称/);
    assert.doesNotMatch(result.message, /baseUrl 通常要带/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("上游回显的密钥残段不会原样透给前端", () => {
  const detail = readErrorDetail(
    JSON.stringify({ error: { message: "Authentication Fails, Your api key: ****heck is invalid" } }),
    "sk-full-key"
  );
  assert.doesNotMatch(detail, /heck/);
  assert.match(detail, /\*\*\*/);
});

test("接口地址会归一，整条 /chat/completions 粘进来也不会拼重", () => {
  assert.equal(normalizeBaseUrl("https://api.deepseek.com/v1/"), "https://api.deepseek.com/v1");
  assert.equal(
    normalizeBaseUrl(" https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions "),
    "https://dashscope.aliyuncs.com/compatible-mode/v1"
  );
  assert.equal(normalizeBaseUrl("http://127.0.0.1:11434/v1"), "http://127.0.0.1:11434/v1");
});
