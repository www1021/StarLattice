import assert from "node:assert/strict";
import test from "node:test";
import {
  CHOICE_OTHER_PORT,
  choiceIndexOfPort,
  choiceOptionsOf,
  choicePortOf,
  inferChoicePorts,
  isChoiceOtherPort,
  migrateChoiceEdgePorts,
  whenChoiceValue
} from "./choicePorts";
import type { WorkflowDefinition, WorkflowNode } from "./types";

/** 这套规则和后端 executor 里的同名函数必须一致，否则连线位置和运行结果会对不上。 */
test("端口命名：选项走序号，兜底固定成 choice:other", () => {
  assert.equal(choicePortOf(0), "choice:0");
  assert.equal(choicePortOf(2), "choice:2");
  assert.equal(choicePortOf(-1), CHOICE_OTHER_PORT);
  assert.equal(isChoiceOtherPort(CHOICE_OTHER_PORT), true);
  assert.equal(isChoiceOtherPort("choice:0"), false);
  // 反解只认序号，兜底口不给序号
  assert.equal(choiceIndexOfPort("choice:1"), 1);
  assert.equal(choiceIndexOfPort(CHOICE_OTHER_PORT), undefined);
  assert.equal(choiceIndexOfPort(undefined), undefined);
});

test("卡片上的选项行：去空去重，动态来源不画选项行", () => {
  const node = {
    id: "ask",
    kind: "human",
    title: "选项卡",
    prompt: "选一个",
    options: [" 甲 ", "乙", "甲", ""]
  } as WorkflowNode;
  assert.deepEqual(choiceOptionsOf(node), ["甲", "乙"]);
  assert.deepEqual(choiceOptionsOf({ ...node, optionsFrom: "${input.topics}" } as WorkflowNode), []);
  assert.deepEqual(choiceOptionsOf({ ...node, kind: "llm" } as WorkflowNode), []);
});

test("老连线迁移：出边数比选项多一条时，最后一条落兜底口", () => {
  const twoOptions = new Map([["ask", ["甲", "乙"]]]);
  // 两个选项各一条：按顺序补。
  assert.deepEqual(
    [...inferChoicePorts([{ from: "ask" }, { from: "ask" }], twoOptions).entries()],
    [
      [0, "choice:0"],
      [1, "choice:1"]
    ]
  );
  // 多出来的那一条就是兜底分支。
  assert.deepEqual(
    [...inferChoicePorts([{ from: "ask" }, { from: "ask" }, { from: "ask" }], twoOptions).entries()],
    [
      [0, "choice:0"],
      [1, "choice:1"],
      [2, CHOICE_OTHER_PORT]
    ]
  );
  // 数量对不上（并行分支）就不猜。
  assert.equal(
    inferChoicePorts(
      [{ from: "ask" }, { from: "ask" }, { from: "ask" }, { from: "ask" }],
      twoOptions
    ).size,
    0
  );
  // 已经有端口的边保留，剩下没端口的老边落剩余选项口。
  assert.deepEqual(
    [...inferChoicePorts([{ from: "ask" }, { from: "ask", fromPort: "choice:0" }], twoOptions).entries()],
    [[0, "choice:1"]]
  );
});

test("条件里的选项文本决定端口，混合新老连线也能落对位置", () => {
  const options = ["根据论文题目进行模拟开题答辩", "上传相关论文材料进行模拟开题答辩"];
  const ports = inferChoicePorts(
    [
      { from: "ask", when: "${ask.choice} == 根据论文题目进行模拟开题答辩" },
      { from: "ask", fromPort: "choice:1" },
      { from: "ask", fromPort: CHOICE_OTHER_PORT, when: "${ask.choice} == 其他情况" }
    ],
    new Map([["ask", options]])
  );
  assert.deepEqual([...ports.entries()], [[0, "choice:0"]]);
});

test("条件文本读取：只认本节点的 choice 等值比较", () => {
  assert.equal(
    whenChoiceValue({ from: "ask", when: "${ask.choice} == 甲" }, "ask"),
    "甲"
  );
  assert.equal(
    whenChoiceValue({ from: "ask", when: '${ask.choice} == "甲 乙"' }, "ask"),
    "甲 乙"
  );
  // 引用了别的节点，或不是等值比较：都不算选项归属。
  assert.equal(whenChoiceValue({ from: "ask", when: "${other.choice} == 甲" }, "ask"), undefined);
  assert.equal(whenChoiceValue({ from: "ask", when: "${ask.choice} != 甲" }, "ask"), undefined);
  assert.equal(whenChoiceValue({ from: "ask", when: "${ask.output} == 甲" }, "ask"), undefined);
  assert.equal(whenChoiceValue({ from: "ask" }, "ask"), undefined);
});

test("打开旧流程时把推断出的端口写回定义", () => {
  const definition = {
    id: "wf",
    name: "旧流程",
    version: 1,
    inputs: [],
    nodes: [
      { id: "ask", kind: "human", title: "选项卡", prompt: "选", options: ["甲", "乙"] },
      { id: "a", kind: "template", title: "a", template: "x" },
      { id: "b", kind: "template", title: "b", template: "y" },
      { id: "c", kind: "template", title: "c", template: "z" }
    ],
    edges: [
      { from: "ask", to: "a", when: "${ask.choice} == 甲" },
      { from: "ask", to: "b", fromPort: "choice:1" },
      { from: "ask", to: "c", fromPort: CHOICE_OTHER_PORT }
    ]
  } as unknown as WorkflowDefinition;
  const { definition: next, changed } = migrateChoiceEdgePorts(definition);
  assert.equal(changed, true);
  assert.equal(next.edges[0].fromPort, "choice:0");
  assert.equal(next.edges[1].fromPort, "choice:1");
  // 原对象不被就地修改，撤销栈才不会串。
  assert.equal(definition.edges[0].fromPort, undefined);
  // 再跑一次没有变化。
  assert.equal(migrateChoiceEdgePorts(next).changed, false);
});
