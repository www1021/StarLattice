import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { registerPlatform, type PlatformOptions } from "../routes.js";
import { PlatformStateStore } from "../runtime/stateStore.js";
import { saveUserModel } from "../models/userModels.js";

type DebugStream = NonNullable<PlatformOptions["debugStream"]>;

type SseFrame = { event: string; data: Record<string, unknown> };

async function readSse(response: Response): Promise<SseFrame[]> {
  const raw = await response.text();
  return raw
    .split("\n\n")
    .filter((frame) => frame.trim())
    .map((frame) => {
      let event = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          data += line.slice(5).trim();
        }
      }
      return { event, data: data ? (JSON.parse(data) as Record<string, unknown>) : {} };
    });
}

async function withServer(
  options: {
    debugStream?: DebugStream;
    persistWorkflowConversation?: NonNullable<PlatformOptions["persistWorkflowConversation"]>;
    /** 默认给临时目录塞一条模型：密钥只能来自账号设置，环境变量不再兜底。 */
    withModels?: boolean;
  },
  run: (base: string, workflowId: string) => Promise<void>
) {
  const directory = mkdtempSync(path.join(tmpdir(), "starlattice-debug-chat-"));
  const store = new PlatformStateStore(path.join(directory, "platform.db"));
  // 用独立的模型设置目录：开发机上真存了模型的话，「没凭据时降级」这类用例会被带偏
  const previousSettingsDir = process.env.MODEL_SETTINGS_DIR;
  process.env.MODEL_SETTINGS_DIR = path.join(directory, "settings");
  if (options.withModels !== false) {
    saveUserModel({
      id: "test-model",
      label: "test-model",
      model: "test-model",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test-model"
    });
  }
  const app = express();
  app.use(express.json());
  registerPlatform(app, { store, ...options });
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/platform`;
  try {
    const list = (await fetch(`${base}/workflows`).then((response) => response.json())) as {
      workflows: Array<{ id: string }>;
    };
    assert.ok(list.workflows.length > 0);
    await run(base, list.workflows[0].id);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    if (previousSettingsDir === undefined) {
      delete process.env.MODEL_SETTINGS_DIR;
    } else {
      process.env.MODEL_SETTINGS_DIR = previousSettingsDir;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

function postChat(
  base: string,
  workflowId: string,
  message: string,
  input: Record<string, unknown> = {},
  extra: Record<string, unknown> = {}
): Promise<Response> {
  return fetch(`${base}/workflows/${encodeURIComponent(workflowId)}/debug/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, input, ...extra })
  });
}

/** 内置工作流有必填输入，按声明的类型给一组默认值，避免执行在校验阶段就失败。 */
async function defaultInputs(base: string, workflowId: string): Promise<Record<string, unknown>> {
  const detail = (await fetch(`${base}/workflows/${encodeURIComponent(workflowId)}`).then((r) =>
    r.json()
  )) as { workflow?: { definition?: { inputs?: Array<{ name: string; type: string }> } } };
  const input: Record<string, unknown> = {};
  for (const item of detail.workflow?.definition?.inputs ?? []) {
    input[item.name] =
      item.type === "number" ? 45 : item.type === "boolean" ? true : item.type === "object" ? {} : "勾股定理";
  }
  return input;
}

function answerOf(frames: SseFrame[]): string {
  return frames
    .filter((frame) => frame.event === "delta")
    .map((frame) => (typeof frame.data.content === "string" ? frame.data.content : ""))
    .join("");
}

test("寒暄走 SSE 流式回话，不触发工作流", async () => {
  await withServer(
    {
      debugStream: async ({ onDelta }: Parameters<DebugStream>[0]) => {
        for (const chunk of ["你好", "呀，我是", "这条工作流的调试助手。"]) {
          onDelta(chunk);
        }
      }
    },
    async (base, workflowId) => {
      const response = await postChat(base, workflowId, "你好");
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
      const frames = await readSse(response);
      assert.equal(frames.find((frame) => frame.event === "meta")?.data.intent, "greeting");
      assert.equal(frames.some((frame) => frame.event === "nodes"), false);
      assert.match(answerOf(frames), /你好呀，我是这条工作流的调试助手/);
      assert.equal(frames.find((frame) => frame.event === "done")?.data.usedModel, true);
    }
  );
});

test("教学提问走 chat：模型直接流式答内容，不下发节点也不跑工作流", async () => {
  await withServer(
    {
      debugStream: async ({ onDelta, messages, system }) => {
        assert.equal(messages[0]?.content, "如何让学生听课效率变高");
        assert.match(system, /不要提工作流、节点、运行状态/);
        for (const chunk of ["先把听课目标", "拆成几个小任务，", "中间穿插一次快速提问，", "下课前再收一次反馈。"]) {
          onDelta(chunk);
        }
      }
    },
    async (base, workflowId) => {
      const response = await postChat(base, workflowId, "如何让学生听课效率变高");
      assert.equal(response.status, 200);
      const frames = await readSse(response);
      assert.equal(frames.find((frame) => frame.event === "meta")?.data.intent, "chat");
      assert.equal(frames.some((frame) => frame.event === "nodes"), false);
      assert.equal(frames.some((frame) => frame.event === "status"), false);
      assert.ok(frames.filter((frame) => frame.event === "delta").length > 2);
      assert.match(answerOf(frames), /听课目标/);
      assert.match(answerOf(frames), /快速提问/);
      assert.equal(frames.find((frame) => frame.event === "done")?.data.runId, undefined);
    }
  );
});

test("显式 forceRun 绕过意图分类，问句也会执行工作流", async () => {
  await withServer(
    {
      debugStream: async ({ onDelta }: Parameters<DebugStream>[0]) => {
        onDelta("这一轮按流程跑完了");
      }
    },
    async (base, workflowId) => {
      const input = await defaultInputs(base, workflowId);
      const response = await postChat(base, workflowId, "如何让学生听课效率变高", input, {
        forceRun: true
      });
      assert.equal(response.status, 200);
      const frames = await readSse(response);
      assert.equal(frames.find((frame) => frame.event === "meta")?.data.intent, "run");
      assert.ok(frames.some((frame) => frame.event === "nodes"));
      assert.equal(typeof frames.find((frame) => frame.event === "done")?.data.runId, "string");
    }
  );
});

test("persist=true 时把这一轮对话落库，并把 conversationId 放进 done", async () => {
  const captured: Array<Parameters<NonNullable<PlatformOptions["persistWorkflowConversation"]>>[0]> =
    [];
  await withServer(
    {
      debugStream: async ({ onDelta }: Parameters<DebugStream>[0]) => {
        onDelta("先把");
        onDelta("目标拆小");
      },
      persistWorkflowConversation: async (input) => {
        captured.push(input);
        return "conv_from_store";
      }
    },
    async (base, workflowId) => {
      const response = await postChat(
        base,
        workflowId,
        "如何让学生听课效率变高",
        {},
        {
          persist: true,
          conversationId: "conv_existing",
          history: [{ role: "user", content: "如何让学生听课效率变高" }]
        }
      );
      assert.equal(response.status, 200);
      const frames = await readSse(response);
      assert.equal(
        frames.find((frame) => frame.event === "done")?.data.conversationId,
        "conv_from_store"
      );
      assert.equal(captured.length, 1);
      assert.equal(captured[0].workflowId, workflowId);
      assert.equal(captured[0].conversationId, "conv_existing");
      assert.equal(captured[0].runId, undefined);
      assert.deepEqual(captured[0].messages, [
        { role: "user", content: "如何让学生听课效率变高" },
        { role: "assistant", content: "先把目标拆小" }
      ]);

      // 调试面板不传 persist，不应写进会话库。
      const plain = await postChat(base, workflowId, "你好");
      await plain.text();
      assert.equal(captured.length, 1);
    }
  );
});

test("任务输入跑工作流，节点数据只作折叠区下发，回复仍是文字流", async () => {
  await withServer(
    {
      debugStream: async ({ onDelta, messages }: Parameters<DebugStream>[0]) => {
        assert.match(messages[0]?.content ?? "", /最终交付内容/);
        for (const chunk of ["教案", "已经生成", "，共 4 个环节。"]) {
          onDelta(chunk);
        }
      }
    },
    async (base, workflowId) => {
      const input = await defaultInputs(base, workflowId);
      const response = await postChat(base, workflowId, "围绕勾股定理生成一份教案", input);
      assert.equal(response.status, 200);
      const frames = await readSse(response);
      assert.equal(frames.find((frame) => frame.event === "meta")?.data.intent, "run");
      const nodes = frames.find((frame) => frame.event === "nodes");
      assert.ok(Array.isArray(nodes?.data.nodes));
      assert.ok((nodes?.data.nodes as unknown[]).length > 0);
      assert.equal(frames.filter((frame) => frame.event === "delta").length > 1, true);
      assert.match(answerOf(frames), /教案已经生成/);
      assert.equal(typeof frames.find((frame) => frame.event === "done")?.data.runId, "string");
    }
  );
});

test("没有配置模型时降级为本地逐字回复，界面仍有流式文字", async () => {
  await withServer({ withModels: false }, async (base, workflowId) => {
    const response = await postChat(base, workflowId, "你好");
    assert.equal(response.status, 200);
    const frames = await readSse(response);
    assert.ok(frames.some((frame) => frame.event === "notice"));
    assert.match(answerOf(frames), /你好呀/);
    assert.equal(frames.find((frame) => frame.event === "done")?.data.usedModel, false);
  });
});

test("空消息与不存在的工作流在开流之前返回明确错误", async () => {
  await withServer({}, async (base, workflowId) => {
    const empty = await postChat(base, workflowId, "   ");
    assert.equal(empty.status, 400);

    const missing = await fetch(`${base}/workflows/not-exist/debug/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "你好" })
    });
    assert.equal(missing.status, 404);
  });
});
