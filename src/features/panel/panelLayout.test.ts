import assert from "node:assert/strict";
import test from "node:test";
import {
  clamp,
  readLayout,
  writeLayout,
  isCompactViewport,
  DEFAULT_LAYOUT,
  SIDEBAR_MIN,
  SIDEBAR_MAX,
  DOCK_MIN,
  DOCK_MAX,
  LAYOUT_STORAGE_KEY
} from "./panelLayout.js";

/** 内存版 Storage，避免测试碰真实 localStorage。 */
function memoryStorage(seed?: string) {
  const data = new Map<string, string>();
  if (seed) {
    data.set(LAYOUT_STORAGE_KEY, seed);
  }
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    }
  };
}

test("clamp 把宽度限制在范围内", () => {
  assert.equal(clamp(100, 200, 400), 200);
  assert.equal(clamp(500, 200, 400), 400);
  assert.equal(clamp(300, 200, 400), 300);
});

test("读不到布局时返回默认值", () => {
  assert.deepEqual(readLayout(memoryStorage()), DEFAULT_LAYOUT);
});

test("坏 JSON 不会让读布局崩掉", () => {
  assert.deepEqual(readLayout(memoryStorage("{not json")), DEFAULT_LAYOUT);
});

test("越界的宽度会被夹回合法范围", () => {
  const store = memoryStorage(
    JSON.stringify({ sidebarWidth: 9999, dockWidth: 1, dockOpen: true, dockTab: "insight" })
  );
  const layout = readLayout(store);
  assert.equal(layout.sidebarWidth, SIDEBAR_MAX);
  assert.equal(layout.dockWidth, DOCK_MIN);
  assert.equal(layout.dockOpen, true);
  assert.equal(layout.dockTab, "insight");
});

test("非法的标签回退到默认", () => {
  const store = memoryStorage(JSON.stringify({ dockTab: "unknown", dockOpen: "yes" }));
  const layout = readLayout(store);
  assert.equal(layout.dockTab, DEFAULT_LAYOUT.dockTab);
  assert.equal(layout.dockOpen, DEFAULT_LAYOUT.dockOpen);
});

test("写入后能原样读回", () => {
  const store = memoryStorage();
  const layout = {
    sidebarWidth: 300,
    dockWidth: 460,
    dockOpen: true,
    dockTab: "workflows" as const
  };
  writeLayout(layout, store);
  assert.deepEqual(readLayout(store), layout);
});

test("窄屏判定门槛", () => {
  assert.equal(isCompactViewport(959), true);
  assert.equal(isCompactViewport(960), false);
  assert.equal(isCompactViewport(1440), false);
});
