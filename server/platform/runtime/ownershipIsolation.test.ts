import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runWithAuth, type AuthContext } from "../../auth/context.js";
import { loadBuiltinWorkflows } from "../workflow/dsl.js";
import { BUILTIN_TOOLS } from "../registry/tools.js";
import { PlatformStateStore } from "./stateStore.js";

const ALICE: AuthContext = {
  userId: "user-alice",
  username: "alice",
  displayName: "Alice",
  role: "owner",
  sessionId: "session-alice"
};

const BOB: AuthContext = {
  userId: "user-bob",
  username: "bob",
  displayName: "Bob",
  role: "member",
  sessionId: "session-bob"
};

function withUser<T>(user: AuthContext, callback: () => T): T {
  return runWithAuth(user, callback);
}

function newStore() {
  const directory = mkdtempSync(path.join(tmpdir(), "yiban-owner-"));
  const store = new PlatformStateStore(path.join(directory, "platform.db"));
  return {
    store,
    cleanup() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

test("工具：自建的只有本人看得到，内置的对所有人可见", () => {
  const { store, cleanup } = newStore();
  try {
    store.seedTools(BUILTIN_TOOLS);
    const builtinId = BUILTIN_TOOLS[0]!.id;

    withUser(ALICE, () => {
      store.saveTool({
        id: "mcp.alice.query",
        name: "Alice 的检索工具",
        type: "mcp",
        schema: { type: "object" },
        endpoint: "mcp://alice/query",
        description: "只有 Alice 能用",
        enabled: true
      });
      const ids = store.listTools().map((tool) => tool.id);
      assert.ok(ids.includes(builtinId), "内置工具对 Alice 可见");
      assert.ok(ids.includes("mcp.alice.query"));
    });

    withUser(BOB, () => {
      const ids = store.listTools().map((tool) => tool.id);
      assert.ok(ids.includes(builtinId), "内置工具对 Bob 同样可见");
      assert.ok(!ids.includes("mcp.alice.query"), "Bob 看不到 Alice 的工具");
      assert.equal(store.getTool("mcp.alice.query"), undefined);
      assert.equal(store.deleteTool("mcp.alice.query"), false, "Bob 删不掉 Alice 的工具");
    });

    withUser(ALICE, () => {
      assert.ok(store.getTool("mcp.alice.query"), "Alice 自己仍然读得到");
      assert.equal(store.listTools().find((tool) => tool.id === "mcp.alice.query")?.source, "custom");
      assert.equal(store.listTools().find((tool) => tool.id === builtinId)?.source, "builtin");
    });
  } finally {
    cleanup();
  }
});

test("工具：内置行不能被同名保存覆盖", () => {
  const { store, cleanup } = newStore();
  try {
    store.seedTools(BUILTIN_TOOLS);
    const builtin = BUILTIN_TOOLS[0]!;
    withUser(ALICE, () => {
      assert.throws(
        () =>
          store.saveTool({
            ...builtin,
            name: "被改掉的内置工具",
            enabled: false
          }),
        /内置工具/
      );
    });
    assert.equal(store.getTool(builtin.id)?.name, builtin.name);
  } finally {
    cleanup();
  }
});

test("MCP 连接：id 全局唯一，别人的连接不能读写", () => {
  const { store, cleanup } = newStore();
  try {
    withUser(ALICE, () => {
      store.saveMcpServer({
        id: "shared-name",
        name: "Alice 的连接",
        transport: "stdio",
        command: "npx",
        args: ["demo"],
        enabled: true
      });
    });

    withUser(BOB, () => {
      assert.equal(store.getMcpServer("shared-name"), undefined);
      assert.equal(store.listMcpServers().length, 0);
      assert.throws(
        () =>
          store.saveMcpServer({
            id: "shared-name",
            name: "Bob 的连接",
            transport: "stdio",
            command: "npx",
            args: ["other"],
            enabled: true
          }),
        /已被其他账号占用/
      );
    });

    withUser(ALICE, () => {
      assert.equal(store.listMcpServers().length, 1);
    });
  } finally {
    cleanup();
  }
});

test("工作流：内置的共见，自建的互不可见，存新版本不会撞主键", () => {
  const { store, cleanup } = newStore();
  try {
    const builtin = loadBuiltinWorkflows().find((item) => item.id === "classroom-v1");
    assert.ok(builtin);
    // 启动时无身份写入 = 内置
    store.saveWorkflow(builtin);

    withUser(ALICE, () => {
      const ids = store.listWorkflows().map((item) => item.id);
      assert.ok(ids.includes("classroom-v1"), "内置工作流对 Alice 可见");
      assert.equal(store.listWorkflows().find((item) => item.id === "classroom-v1")?.source, "builtin");

      const next = store.nextWorkflowVersion("classroom-v1");
      assert.equal(next, 2);
      store.saveWorkflow({ ...builtin, version: next, name: "Alice 改过的课堂流程" });
    });

    withUser(BOB, () => {
      const mine = store.listWorkflows().find((item) => item.id === "classroom-v1");
      assert.equal(mine?.version, 1, "Bob 看到的仍是内置版本");
      assert.equal(mine?.name, builtin.name);
      assert.equal(store.nextWorkflowVersion("classroom-v1"), 3, "版本号按全库最大值递增，避免撞主键");
    });

    withUser(ALICE, () => {
      assert.equal(store.getWorkflow("classroom-v1")?.definition.version, 2);
    });
  } finally {
    cleanup();
  }
});

test("释放内置工作流：按版本放回共享，自建的新版本仍归本人", () => {
  const { store, cleanup } = newStore();
  try {
    const builtin = loadBuiltinWorkflows().find((item) => item.id === "classroom-v1");
    assert.ok(builtin);
    withUser(ALICE, () => {
      // 模拟「首个账号接管了内置数据」的现场
      store.saveWorkflow(builtin);
      store.saveWorkflow({ ...builtin, version: 2, name: "Alice 的改动" });
    });
    assert.equal(store.releaseBuiltinWorkflow("classroom-v1", 1), 1, "内置版本被放回共享");
    assert.equal(store.releaseBuiltinWorkflow("classroom-v1", 1), 0, "重复释放不再生效");
    assert.equal(store.releaseBuiltinWorkflow("classroom-v1", 2), 1, "版本号指定哪一行就动哪一行");

    withUser(BOB, () => {
      assert.equal(store.getWorkflow("classroom-v1")?.definition.name, "Alice 的改动", "同版本号已被释放，Bob 读到的是最新那条");
    });
  } finally {
    cleanup();
  }
});
