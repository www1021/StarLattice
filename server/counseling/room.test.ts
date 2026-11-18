import assert from "node:assert/strict";
import test from "node:test";
import {
  extractStudentName,
  normalizeRoomMessages,
  openRoomTurn,
  resolveRoomCase,
  roomSystemPrompt
} from "./room.js";

test("聊天室按话题关键词匹配虚拟个案，显式 caseId 优先", () => {
  assert.equal(resolveRoomCase("最近考试考差了，心情不好").id, "academic");
  assert.equal(resolveRoomCase("跟室友作息冲突，不想回宿舍").id, "dormitory");
  assert.equal(resolveRoomCase("他最近说不想活了").id, "safety");
  assert.equal(resolveRoomCase("随便聊聊", "relationship").id, "relationship");
  // 认不出话题时退回成绩压力这个最通用的个案，不要报错。
  assert.equal(resolveRoomCase("今天天气不错").id, "academic");
});

test("开导者模式用个案原话开场，被开导者模式由老师先开口", () => {
  const student = resolveRoomCase("成绩");
  const asCounselor = openRoomTurn("counselor", student);
  const asSeeker = openRoomTurn("seeker", student);
  assert.equal(asCounselor, student.opening);
  assert.ok(asSeeker.includes("我在"));
  assert.notEqual(asSeeker, asCounselor);
});

test("聊天室系统提示按角色区分，且都禁止跳出角色", () => {
  const student = resolveRoomCase("宿舍冲突");
  const counselor = roomSystemPrompt({ mode: "counselor", messages: [], topic: "宿舍冲突" }, student);
  const seeker = roomSystemPrompt({ mode: "seeker", messages: [], topic: "宿舍冲突" }, student);
  assert.ok(counselor.includes(student.name));
  assert.ok(counselor.includes("1 到 3 句"));
  assert.ok(seeker.includes("2 到 4 句"));
  assert.ok(seeker.includes("12356"));
  assert.ok(counselor.includes("绝不承认自己是 AI"));
  assert.ok(seeker.includes("绝不承认自己是 AI"));
});

test("聊天室只保留合法角色、压掉超长内容并截断历史", () => {
  const messages = [
    { role: "user" as const, content: "x".repeat(4000) },
    { role: "assistant" as const, content: "收到" }
  ];
  const normalized = normalizeRoomMessages(messages);
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0]?.content.length, 2000);

  const long = Array.from({ length: 80 }, (_, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `第 ${index} 句`
  }));
  const trimmed = normalizeRoomMessages(long);
  assert.equal(trimmed.length, 60);
  assert.equal(trimmed[trimmed.length - 1]?.content, "第 79 句");
});

test("从话题里取学生姓名，取不到就不编", () => {
  assert.equal(extractStudentName("我们班有个学生叫林小满，因为成绩问题情绪低落"), "林小满");
  assert.equal(extractStudentName("叫王浩因为成绩考差了"), "王浩");
  assert.equal(extractStudentName("学生陈予最近不想回宿舍"), "陈予");
  assert.equal(extractStudentName("今天天气不错"), undefined);
  // 点名了谁就演谁，别换成个案里的默认姓名。
  assert.equal(resolveRoomCase("班上有学生叫林小满，成绩下滑").name, "林小满");
  assert.equal(resolveRoomCase("班上有学生叫林小满，成绩下滑").id, "academic");
});
