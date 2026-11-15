import assert from "node:assert/strict";
import test from "node:test";
import { suppressedFallbacks } from "../runtime/executor.js";

/**
 * 「条件优先、无条件兜底」是分支节点在画布上的默认直觉：
 * 一个节点连出一条带条件的分支和一条默认线，用户要的是二选一。
 * 这些用例锁住这条语义，避免以后改调度时又退回「两条一起跑」。
 */

test("条件分支走通时，同源的无条件线让位", () => {
  const edges = [{ when: "${score.value} >= 0.8" }, {}];
  // 两条都「本身可走」，但条件成立 → 只走条件那条。
  assert.deepEqual([...suppressedFallbacks(edges, [true, true])], [1]);
});

test("条件不成立时，无条件线照常兜底", () => {
  const edges = [{ when: "${score.value} >= 0.8" }, {}];
  assert.equal(suppressedFallbacks(edges, [false, true]).size, 0);
});

test("两条都无条件时保持并行，不互相压制", () => {
  assert.equal(suppressedFallbacks([{}, {}], [true, true]).size, 0);
});

test("都带条件时各判各的，条件成立与否互不影响", () => {
  const edges = [{ when: "${a.flag}" }, { when: "${b.flag}" }];
  assert.equal(suppressedFallbacks(edges, [true, false]).size, 0);
  assert.equal(suppressedFallbacks(edges, [false, false]).size, 0);
});

test("条件边自己走不通（端口没接线）就不算成立", () => {
  const edges = [{ when: "${a.flag}" }, {}];
  // 第一条虽然条件表达式为真，但端口分派没放行 → 不压制兜底线。
  assert.equal(suppressedFallbacks(edges, [false, true]).size, 0);
});
