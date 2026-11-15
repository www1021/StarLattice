import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SQLiteChatRepository } from "./chatRepository.js";

type TempContext = {
  dbPath: string;
  open: () => SQLiteChatRepository;
};

function withTempRepository(run: (context: TempContext) => Promise<void>) {
  return async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "starlattice-workflow-chat-"));
    const dbPath = path.join(directory, "training.db");
    const opened: SQLiteChatRepository[] = [];
    try {
      await run({
        dbPath,
        open: () => {
          const repository = new SQLiteChatRepository(dbPath);
          opened.push(repository);
          return repository;
        }
      });
    } finally {
      for (const repository of opened) {
        repository.close();
      }
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

const baseInput = {
  title: "如何让学生听课效率变高",
  trainingType: "通用对话" as const,
  assistantMode: "office" as const,
  messages: [
    { role: "user" as const, content: "如何让学生听课效率变高" },
    { role: "assistant" as const, content: "先把听课目标拆小。" }
  ],
  knowledgeBaseIds: [],
  attachmentNames: [],
  artifacts: [],
  citations: []
};

test(
  "工作流会话字段能写入并在列表与详情里读回",
  withTempRepository(async ({ open }) => {
    const repository = open();
    await repository.saveConversation({
      ...baseInput,
      conversationId: "wf-conv-1",
      workflowId: "teaching-pipeline-v1",
      lastRunId: "run_abc123"
    });

    const summary = repository.listConversations().find((item) => item.id === "wf-conv-1");
    assert.equal(summary?.workflowId, "teaching-pipeline-v1");
    assert.equal(summary?.lastRunId, "run_abc123");

    const detail = repository.getConversation("wf-conv-1");
    assert.equal(detail?.workflowId, "teaching-pipeline-v1");
    assert.equal(detail?.lastRunId, "run_abc123");
    assert.deepEqual(detail?.messages, baseInput.messages);
  })
);

test(
  "旧库重启后补列不报错，普通会话不带上工作流标记",
  withTempRepository(async ({ open }) => {
    const first = open();
    await first.saveConversation({ ...baseInput, conversationId: "normal-1" });
    // 模拟进程重启：同一个文件再构造一次，迁移必须可重复执行。
    first.close();
    const second = open();
    await second.saveConversation({
      ...baseInput,
      conversationId: "wf-conv-2",
      workflowId: "lesson-design-v1"
    });

    const normal = second.getConversation("normal-1");
    assert.equal(normal?.workflowId, undefined);
    assert.equal(normal?.lastRunId, undefined);
    assert.equal(second.getConversation("wf-conv-2")?.workflowId, "lesson-design-v1");
  })
);

test(
  "续聊覆盖保存时保留工作流绑定并更新最近一次 run",
  withTempRepository(async ({ open }) => {
    const repository = open();
    await repository.saveConversation({
      ...baseInput,
      conversationId: "wf-conv-3",
      workflowId: "teaching-pipeline-v1",
      lastRunId: "run_first"
    });
    await repository.saveConversation({
      ...baseInput,
      conversationId: "wf-conv-3",
      messages: [...baseInput.messages, { role: "user" as const, content: "再讲细一点" }],
      workflowId: "teaching-pipeline-v1",
      lastRunId: "run_second"
    });

    const detail = repository.getConversation("wf-conv-3");
    assert.equal(detail?.workflowId, "teaching-pipeline-v1");
    assert.equal(detail?.lastRunId, "run_second");
    assert.equal(detail?.messages.length, 3);
    assert.equal(repository.listConversations().length, 1);
  })
);
