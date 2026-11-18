import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { analyzeMoves, applyTurn, buildReport, createSession, makeCue } from "./engine.js";
import { CounselingService } from "./service.js";
import { SQLiteChatRepository } from "../storage/chatRepository.js";

test("normalizes a virtual safety exercise and preserves its urgent risk setting", () => {
  const session = createSession({
    caseId: "safety",
    mode: "guided",
    emotion: "低落",
    intensity: 5,
    trust: 30,
    openness: 30,
    risk: "ordinary"
  });

  assert.equal(session.config.risk, "urgent");
  assert.equal(session.events[0]?.severity, "critical");
});

test("accepts a Chinese description from a chat agent and infers the case", () => {
  const session = createSession("班上有学生因为成绩问题，情绪有点异常");
  assert.equal(session.student.id, "academic");
  assert.equal(session.config.mode, "guided");
  assert.equal(session.config.intensity, 4);
});

test("fills missing fields from case defaults and maps Chinese enums", () => {
  const session = createSession({ caseId: "relationship", emotion: "难过", risk: "重点关注", intensity: "3" });
  assert.equal(session.config.emotion, "低落");
  assert.equal(session.config.risk, "screening");
  assert.equal(session.config.intensity, 3);
  assert.equal(session.config.trust, 35);
  assert.equal(session.config.openness, 25);
});

test("never downgrades a safety scenario described in free text", () => {
  const session = createSession({ note: "学生说想消失就好了", risk: "普通" });
  assert.equal(session.student.id, "safety");
  assert.equal(session.config.risk, "urgent");
  assert.equal(session.events[0]?.severity, "critical");
});

test("recognizes empathy, direct safety confirmation, boundary language, and a support plan", () => {
  const session = createSession({
    caseId: "safety",
    mode: "guided",
    emotion: "低落",
    intensity: 5,
    trust: 30,
    openness: 30,
    risk: "urgent"
  });

  applyTurn(
    session,
    "听起来你已经很害怕了。你现在身边有人吗？此刻有没有伤害自己的想法，或者觉得自己不安全？",
    "safety-1",
    "text"
  );
  applyTurn(
    session,
    "涉及你的生命安全时，我会先向你说明，再联系必要的支持。我们现在一起联系学校心理中心和值班老师，可以吗？",
    "safety-2",
    "text"
  );

  const report = buildReport(session);
  assert.equal(report.safetyStatus, "actions_observed");
  assert.ok(report.dimensions.find((item) => item.name === "倾听共情")!.score >= 80);
  assert.ok(report.dimensions.find((item) => item.name === "安全确认")!.score >= 80);
  assert.ok(report.dimensions.find((item) => item.name === "边界与支持计划")!.score >= 80);
});

test("marks judgement and unconditional secrecy as separate coaching risks", () => {
  assert.deepEqual(analyzeMoves("你就是太矫情了，别想太多。"), ["judgment"]);
  assert.equal(makeCue("我保证绝对保密，不会告诉任何人。", "risk-1")?.severity, "critical");
  assert.equal(makeCue("你就是太矫情了，别想太多。", "risk-2")?.severity, "warning");
});

test("saves an unfinished session into history without creating an evaluation", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "yiban-counseling-"));
  const dbPath = path.join(directory, "training.db");
  const repository = new SQLiteChatRepository(dbPath);
  const service = new CounselingService(repository);
  try {
    const session = service.create({
      caseId: "academic",
      mode: "guided",
      emotion: "焦虑",
      intensity: 4,
      trust: 45,
      openness: 40,
      risk: "ordinary"
    });
    await service.turn(session.id, "听起来你很担心让家人失望，愿意说说最难熬的时刻吗？", "draft-1", "text");
    await service.saveDraft(session.id);
    const stored = repository.getConversation(session.id);
    assert.equal(stored?.trainingType, "谈心谈话");
    assert.match(stored?.title || "", /^谈心谈话（未完成）：/);
    assert.equal(repository.getEvaluation(session.id), undefined);
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
