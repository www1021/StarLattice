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

test("imports GBK text uploads without mojibake", async () => {
  const folder = path.join(os.tmpdir(), `yijiaoxun-kb-${randomUUID()}`);
  const provider = new LocalKnowledgeProvider(path.join(folder, "knowledge.db"));
  const base = provider.createBase("编码测试");
  const gbk = Buffer.from([
    0xb3, 0xf5, 0xd6, 0xd0, 0xca, 0xfd, 0xd1, 0xa7, 0xb7, 0xd6, 0xca, 0xfd, 0xb5, 0xc4, 0xd2,
    0xe2, 0xd2, 0xe5, 0xa3, 0xba, 0xd1, 0xa7, 0xc9, 0xfa, 0xd3, 0xa6, 0xc0, 0xed, 0xbd, 0xe2,
    0xb5, 0xa5, 0xce, 0xbb, 0xd2, 0xbb, 0xa1, 0xa2, 0xc6, 0xbd, 0xbe, 0xf9, 0xb7, 0xd6, 0xba,
    0xcd, 0xb7, 0xd6, 0xd7, 0xd3, 0xb7, 0xd6, 0xc4, 0xb8, 0xb5, 0xc4, 0xb9, 0xd8, 0xcf, 0xb5,
    0xa3, 0xac, 0xb2, 0xa2, 0xc4, 0xdc, 0xd3, 0xc3, 0xc9, 0xfa, 0xbb, 0xee, 0xc7, 0xe9, 0xbe,
    0xb3, 0xbd, 0xe2, 0xca, 0xcd, 0xb7, 0xd6, 0xca, 0xfd, 0xa1, 0xa3
  ]);

  await provider.addDocument(
    base.id,
    {
      originalname: Buffer.from("编码测试.txt", "utf8").toString("latin1"),
      buffer: gbk,
      size: gbk.length
    } as Express.Multer.File,
    { resourceType: "教研资料", subject: "数学", schoolStage: "初中" }
  );

  const [hit] = provider.search({ query: "分数", knowledgeBaseIds: [base.id] });
  assert.equal(hit?.documentName, "编码测试.txt");
  assert.equal(hit?.snippet.includes("初中数学分数的意义"), true);
  assert.equal(hit?.snippet.includes("\uFFFD"), false);

  rmSync(folder, { recursive: true, force: true });
});
