import assert from "node:assert/strict";
import test from "node:test";
import { compileWorkflow, WorkflowCompileError } from "./compiler.js";
import { parseWorkflowDefinition } from "./dsl.js";
import {
  branchAllows,
  CHOICE_OTHER_PORT,
  choicePortOf,
  inferChoicePorts,
  matchChoiceIndex,
  type RunScope
} from "../runtime/executor.js";

/** 一个最小的「开始 → 选项卡 → 结束」流程。 */
function tabWorkflow(human: Record<string, unknown>) {
  return {
    id: "choice-probe",
    name: "选项卡探针",
    version: 1,
    inputs: [{ name: "topics", type: "object" }],
    nodes: [
      { id: "start", kind: "start" },
      { id: "ask", kind: "human", ...human },
      { id: "end", kind: "end", inputs: { picked: "${ask.choice}" } }
    ],
    edges: [
      { from: "start", to: "ask" },
      { from: "ask", to: "end" }
    ]
  };
}

test("DSL 保留选项卡的选项、动态来源、模型与提示词", () => {
  const parsed = parseWorkflowDefinition(
    tabWorkflow({
      prompt: "你想通过什么方式来模拟开题答辩？",
      options: ["根据论文题目答辩", "上传材料答辩"],
      model: "qwen-max",
      generatePrompt: "用户选了 ${choice}，按这个方向继续。"
    })
  );
  const ask = parsed.nodes.find((node) => node.id === "ask");
  if (ask?.kind !== "human") {
    throw new Error("选项卡节点没有解析出来");
  }
  assert.deepEqual(ask.options, ["根据论文题目答辩", "上传材料答辩"]);
  assert.equal(ask.model, "qwen-max");
  assert.equal(ask.generatePrompt, "用户选了 ${choice}，按这个方向继续。");
  // 没填的字段不写进 DSL，避免空串污染运行判断
  assert.equal(ask.optionsFrom, undefined);
});

test("草稿里空选项、空引用都能保存（清空不等于非法）", () => {
  const parsed = parseWorkflowDefinition(
    tabWorkflow({
      prompt: "选一个",
      options: ["甲", ""],
      optionsFrom: "",
      generatePrompt: "",
      model: ""
    })
  );
  const ask = parsed.nodes.find((node) => node.id === "ask");
  if (ask?.kind !== "human") {
    throw new Error("选项卡节点没有解析出来");
  }
  assert.deepEqual(ask.options, ["甲", ""]);
  assert.equal(ask.optionsFrom, undefined);
  assert.equal(ask.generatePrompt, undefined);
  assert.equal(ask.model, undefined);
});

test("选项卡的生成提示词里引用不存在的节点会被编译器拦下", () => {
  const definition = parseWorkflowDefinition(
    tabWorkflow({
      prompt: "选一个",
      options: ["甲"],
      generatePrompt: "参考 ${ghost.output} 继续"
    })
  );
  assert.throws(
    () => compileWorkflow(definition),
    (error: unknown) =>
      error instanceof WorkflowCompileError &&
      error.issues.some((issue) => issue.code === "unknown-node-ref")
  );
});

test("生成提示词引用本节点输入变量与 choice 都算合法", () => {
  const definition = parseWorkflowDefinition(
    tabWorkflow({
      prompt: "选一个",
      options: ["甲"],
      generatePrompt: "围绕 ${choice} 展开；补充说明 ${note}",
      inputBindings: [{ name: "note", type: "string", value: "${input.topics}" }]
    })
  );
  const plan = compileWorkflow(definition);
  assert.ok(plan.order.includes("ask"));
});

test("选项卡的选项端口会一路带到编译后的执行图", () => {
  const definition = parseWorkflowDefinition({
    ...tabWorkflow({ prompt: "选一个", options: ["甲", "乙"] }),
    edges: [
      { from: "start", to: "ask" },
      { from: "ask", to: "end", fromPort: "choice:1" }
    ]
  });
  const plan = compileWorkflow(definition);
  const branch = plan.graph.edges.find((edge) => edge.from === "ask");
  assert.equal(branch?.fromPort, "choice:1");
});

test("运行期只激活选中项那一路的分支", () => {
  const scope: RunScope = {
    input: {},
    outputs: new Map([["ask", { choice: "乙", choiceIndex: 1 }]]),
    evidence: [],
    verifyRounds: 0
  };
  const wired = new Map([["ask", new Set(["choice:0", "choice:1", "choice:2"])]]);
  // 选中第 2 项，只有 choice:1 的边算激活；另外两条出边不再跟着跑。
  assert.equal(branchAllows({ from: "ask", to: "a", fromPort: choicePortOf(1) }, scope, wired), true);
  assert.equal(branchAllows({ from: "ask", to: "b", fromPort: choicePortOf(0) }, scope, wired), false);
  assert.equal(branchAllows({ from: "ask", to: "c", fromPort: choicePortOf(2) }, scope, wired), false);
  // 上游已经按端口分派时，没绑端口的老边不再无条件放行。
  assert.equal(branchAllows({ from: "ask", to: "d" }, scope, wired), false);
  // 单出口的旧流程（没有端口连线）保持原语义。
  assert.equal(branchAllows({ from: "ask", to: "e" }, scope, new Map()), true);
});

test("没命中预置选项时走「其他」兜底口", () => {
  const wired = new Map([["ask", new Set(["choice:0", "choice:1", CHOICE_OTHER_PORT])]]);
  // 用户自己写了一段：choiceIndex = -1，两条选项分支都不该跑，只有兜底口激活。
  const custom: RunScope = {
    input: {},
    outputs: new Map([["ask", { choice: "换个方式聊", choiceIndex: -1, choiceOther: true }]]),
    evidence: [],
    verifyRounds: 0
  };
  assert.equal(branchAllows({ from: "ask", to: "x", fromPort: CHOICE_OTHER_PORT }, custom, wired), true);
  assert.equal(branchAllows({ from: "ask", to: "y", fromPort: choicePortOf(0) }, custom, wired), false);
  assert.equal(branchAllows({ from: "ask", to: "z", fromPort: choicePortOf(1) }, custom, wired), false);

  // 什么都没选（连 choiceIndex 都没有）也算「都不命中」。
  const blank: RunScope = { input: {}, outputs: new Map([["ask", {}]]), evidence: [], verifyRounds: 0 };
  assert.equal(branchAllows({ from: "ask", to: "x", fromPort: CHOICE_OTHER_PORT }, blank, wired), true);
});

test("选中的选项没接线时回落到兜底，而不是卡死", () => {
  // 第二个选项用户忘了拉线，只连了选项 1 和「其他」。
  const wired = new Map([["ask", new Set(["choice:0", CHOICE_OTHER_PORT])]]);
  const scope: RunScope = {
    input: {},
    outputs: new Map([["ask", { choice: "乙", choiceIndex: 1 }]]),
    evidence: [],
    verifyRounds: 0
  };
  assert.equal(branchAllows({ from: "ask", to: "other", fromPort: CHOICE_OTHER_PORT }, scope, wired), true);
  assert.equal(branchAllows({ from: "ask", to: "first", fromPort: choicePortOf(0) }, scope, wired), false);
});

test("老流程的共口出边会按选项顺序补上端口", () => {
  const three = new Map([["ask", ["甲", "乙", "丙"]]]);
  const ports = inferChoicePorts(
    [{ from: "ask" }, { from: "ask" }, { from: "ask" }, { from: "start" }],
    three
  );
  assert.deepEqual(
    [...ports.entries()],
    [
      [0, "choice:0"],
      [1, "choice:1"],
      [2, "choice:2"]
    ]
  );
  // 多出一条：最后一个落到兜底口（两个选项 + 一条「其他」分支的老流程）。
  const two = new Map([["ask", ["甲", "乙"]]]);
  assert.deepEqual(
    [...inferChoicePorts([{ from: "ask" }, { from: "ask" }, { from: "ask" }], two).entries()],
    [
      [0, "choice:0"],
      [1, "choice:1"],
      [2, CHOICE_OTHER_PORT]
    ]
  );
  // 出边数和选项数对不上、也没有条件可依时就不猜，避免把并行分支误判成分支选项。
  assert.equal(inferChoicePorts([{ from: "ask" }, { from: "ask" }], three).size, 0);
  assert.equal(
    inferChoicePorts(
      [{ from: "ask" }, { from: "ask" }, { from: "ask" }, { from: "ask" }],
      two
    ).size,
    0
  );
  // 已经有端口的边保留原端口，剩下没端口的老边落剩余的选项口，而不是整体放弃。
  const mixed = inferChoicePorts(
    [{ from: "ask" }, { from: "ask", fromPort: "choice:0" }],
    two
  );
  assert.deepEqual([...mixed.entries()], [[0, "choice:1"]]);
});

test("新老连线混着的选项卡：条件里的选项文本优先于端口顺序", () => {
  // 真实出问题的那条流程：选项 1 的线是「一选项一端口」之前画的（只有条件、没有 fromPort），
  // 选项 2 和「其他」是后来拖的（有 fromPort）。以前只要有一条边带端口就整体不推断，
  // 选第一项时端口对不上，运行期就静悄悄跑了兜底分支。
  const options = ["根据论文题目进行模拟开题答辩", "上传相关论文材料进行模拟开题答辩"];
  const ports = inferChoicePorts(
    [
      { from: "ask", choiceValue: "根据论文题目进行模拟开题答辩" },
      { from: "ask", fromPort: "choice:1" },
      { from: "ask", fromPort: CHOICE_OTHER_PORT, choiceValue: "其他情况" }
    ],
    new Map([["ask", options]])
  );
  assert.deepEqual([...ports.entries()], [[0, "choice:0"]]);

  // 落位之后：选第一项只激活第一条线，兜底线不再被顶起来。
  const wired = new Map([
    ["ask", new Set(["choice:0", "choice:1", CHOICE_OTHER_PORT])]
  ]);
  const scope: RunScope = {
    input: {},
    outputs: new Map([["ask", { choice: options[0], choiceIndex: 0 }]]),
    evidence: [],
    verifyRounds: 0
  };
  assert.equal(branchAllows({ from: "ask", to: "title", fromPort: "choice:0" }, scope, wired), true);
  assert.equal(branchAllows({ from: "ask", to: "file", fromPort: "choice:1" }, scope, wired), false);
  assert.equal(
    branchAllows({ from: "ask", to: "fallback", fromPort: CHOICE_OTHER_PORT }, scope, wired),
    false
  );
});

test("条件里的「其他情况」认回兜底口，乱写的条件不会被塞进兜底", () => {
  const options = ["甲", "乙"];
  const ports = inferChoicePorts(
    [
      { from: "ask", choiceValue: "甲" },
      { from: "ask", choiceValue: "其他情况" }
    ],
    new Map([["ask", options]])
  );
  assert.deepEqual([...ports.entries()], [
    [0, "choice:0"],
    [1, CHOICE_OTHER_PORT]
  ]);
  // 条件写的是一句永远选不到的文本：不推断，保持原样（这条线本来就不该激活）。
  assert.equal(
    inferChoicePorts([{ from: "ask", choiceValue: "随便聊聊" }], new Map([["ask", options]])).size,
    0
  );
});

test("命中项没接线、兜底也没接线时不会凭空跑起来", () => {
  // 只连了选项 1，用户选了选项 2：这一轮什么都不该走，而不是跑到兜底或直接报错。
  const wired = new Map([["ask", new Set(["choice:0"])]]);
  const scope: RunScope = {
    input: {},
    outputs: new Map([["ask", { choice: "乙", choiceIndex: 1 }]]),
    evidence: [],
    verifyRounds: 0
  };
  assert.equal(branchAllows({ from: "ask", to: "other", fromPort: CHOICE_OTHER_PORT }, scope, wired), false);
  assert.equal(branchAllows({ from: "ask", to: "first", fromPort: choicePortOf(0) }, scope, wired), false);
});

test("选项匹配容忍粘来的空白，选第一项不会被误判成「其他」", () => {
  const choices = ["根据论文题目进行模拟开题答辩", "上传相关论文材料进行模拟开题答辩"];
  assert.equal(matchChoiceIndex(choices, "根据论文题目进行模拟开题答辩"), 0);
  // 末尾带了换行 / 中间夹了全角空格：仍然算选中第一项，而不是走兜底。
  assert.equal(matchChoiceIndex(choices, "根据论文题目进行模拟开题答辩 \n"), 0);
  assert.equal(matchChoiceIndex(choices, "根据论文题目进行　模拟开题答辩"), 0);
  // 真的不在列表里才返回 -1（走「其他」）。
  assert.equal(matchChoiceIndex(choices, "先聊聊选题方向"), -1);
  assert.equal(matchChoiceIndex(choices, "   "), -1);
});
