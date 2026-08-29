import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalKnowledgeProvider } from "./knowledgeService.js";

test("local teaching resource library preserves metadata and removes its FTS entries", async () => {
  const folder = path.join(os.tmpdir(), `yijiaoxun-kb-${randomUUID()}`);
  const provider = new LocalKnowledgeProvider(path.join(folder, "knowledge.db"));
  const base = provider.createBase("数学课例资料");

  const document = await provider.addDocument(
    base.id,
    {
      originalname: "分数的意义.txt",
      buffer: Buffer.from(
        "分数的意义需要引导学生理解单位一、平均分和分子分母的关系。常见误区是把分母理解为具体数量。"
      ),
      size: 96
    } as Express.Multer.File,
    {
      resourceType: "优秀课例",
      subject: "数学",
      schoolStage: "初中",
      tags: ["分数", "常见误区"]
    }
  );

  assert.equal(document.resourceType, "优秀课例");
  assert.deepEqual(provider.listDocuments(base.id)[0]?.tags, ["分数", "常见误区"]);
  assert.equal(provider.search({ query: "分数 常见误区", knowledgeBaseIds: [base.id] }).length, 1);

  provider.renameBase(base.id, "数学课例资料（已整理）");
  assert.equal(provider.listBases().find((item) => item.id === base.id)?.name, "数学课例资料（已整理）");

  provider.deleteBase(base.id);
  assert.equal(provider.search({ query: "分数 常见误区", knowledgeBaseIds: [base.id] }).length, 0);

  rmSync(folder, { recursive: true, force: true });
});
