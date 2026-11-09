import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertWorkflowDag } from "./workflow-dag.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const workflowDir = path.join(here, "workflows");
const files = readdirSync(workflowDir).filter((file) => file.endsWith(".json")).sort();

function load(file) {
  return JSON.parse(readFileSync(path.join(workflowDir, file), "utf8"));
}

test("every benchmark workflow is a single connected chain", () => {
  assert.ok(files.length >= 8, `工作流数量异常：${files.length}`);
  for (const file of files) {
    const chain = assertWorkflowDag(load(file), file);
    assert.equal(chain.length, load(file).nodes.length, `${file} 链长与节点数不一致`);
  }
});

test("finalize and deliverable are connected in comparable arms", () => {
  for (const file of files) {
    const dsl = load(file);
    if (dsl.id === "bench-single-agent" || dsl.id === "bench-topic-single-agent") {
      continue;
    }
    const chain = assertWorkflowDag(dsl, file);
    const finalize = chain.indexOf("finalize");
    const deliverable = chain.indexOf("deliverable");
    assert.ok(finalize >= 0, `${file} 缺少 finalize`);
    assert.equal(deliverable, finalize + 1, `${file} 的 deliverable 必须紧跟 finalize`);
    const node = dsl.nodes.find((item) => item.id === "deliverable");
    assert.match(node.template, /\$\{finalize\.output\}/, `${file} 未拼接 finalize 正文`);
    assert.match(node.template, /\$\{retrieve\.output\}/, `${file} 未拼接检索来源`);
  }
});

test("detached node is rejected before spending model tokens", () => {
  const dsl = load("topic-full-platform.json");
  const broken = {
    ...dsl,
    edges: dsl.edges.filter((edge) => edge.from !== "finalize")
  };
  assert.throws(() => assertWorkflowDag(broken, "broken"), /未连通节点：finalize|根节点必须唯一/);
});

test("edge to unknown node is rejected", () => {
  const dsl = load("single-agent-fair.json");
  const broken = { ...dsl, edges: [...dsl.edges, { from: "finalize", to: "missing" }] };
  assert.throws(() => assertWorkflowDag(broken, "broken"), /不存在的节点/);
});
