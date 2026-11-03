import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PlatformStateStore } from "../runtime/stateStore.js";
import { McpClient } from "./client.js";
import {
  DEMO_MCP_SERVER,
  McpManager,
  parseMcpEndpoint,
  parseMcpServerWrite,
  uniqueToolId
} from "./mcpManager.js";

const demoEntry = path.resolve("scripts", "mcp-demo-server.mjs");
const dataAnalysisEntry = path.resolve("scripts", "data-analysis-mcp.mjs");

function withStore(run: (store: PlatformStateStore) => Promise<void>) {
  const directory = mkdtempSync(path.join(tmpdir(), "yiban-mcp-"));
  const store = new PlatformStateStore(path.join(directory, "platform.db"));
  return run(store).finally(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
}

test("MCP client completes handshake, discovers tools and calls them over stdio", async () => {
  const { client, info } = await McpClient.open({
    transport: "stdio",
    command: process.execPath,
    args: [demoEntry]
  });
  try {
    assert.equal(info.serverName, "teaching-resource-mcp");
    assert.equal(info.protocolVersion, "2025-06-18");

    const tools = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ["classroom_feedback", "lesson_timing_check", "teaching_resource_search"].sort()
    );
    const searchSchema = tools.find((tool) => tool.name === "teaching_resource_search")?.inputSchema;
    assert.deepEqual(searchSchema?.required, ["query"]);

    const result = await client.callTool("teaching_resource_search", { query: "分数的意义", limit: 2 });
    assert.equal(result.isError, false);
    assert.match(textOf(result.content), /分数的意义/);
    const structured = result.structuredContent as { results?: Array<{ title?: string }> };
    assert.ok((structured.results?.length ?? 0) > 0);
  } finally {
    await client.close();
  }
});

test("data-analysis MCP computes deterministic gross and net metrics from the demo CSV", async () => {
  const { client, info } = await McpClient.open({
    transport: "stdio",
    command: process.execPath,
    args: [dataAnalysisEntry]
  });
  try {
    assert.equal(info.serverName, "data-analysis-mcp");
    const tools = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ["chart", "groupby", "metric_calc", "profile", "trend"].sort()
    );

    const profile = await client.callTool("profile", {});
    assert.equal(profile.isError, false);
    assert.match(textOf(profile.content), /净销售额：113,400\.00 元/);
    assert.match(textOf(profile.content), /毛利额：42,290\.00 元/);

    const gross = await client.callTool("metric_calc", { revenueBasis: "gross" });
    const net = await client.callTool("metric_calc", { revenueBasis: "net" });
    assert.match(textOf(gross.content), /毛利额：45,990\.00 元/);
    assert.match(textOf(gross.content), /毛利率：39\.27%/);
    assert.match(textOf(net.content), /毛利额：42,290\.00 元/);
    assert.match(textOf(net.content), /毛利率：37\.29%/);

    const region = await client.callTool("groupby", { dimension: "region" });
    assert.match(textOf(region.content), /华东：净销售额 48,900\.00 元/);
    const product = await client.callTool("groupby", { dimension: "product" });
    assert.match(textOf(product.content), /无线耳机：净销售额 53,400\.00 元/);
  } finally {
    await client.close();
  }
});

test("MCP client surfaces server errors without leaving the process running", async () => {
  const { client } = await McpClient.open({
    transport: "stdio",
    command: process.execPath,
    args: [demoEntry]
  });
  try {
    await assert.rejects(() => client.callTool("missing_tool", {}), /未知工具/);
  } finally {
    await client.close();
  }
});

test("MCP manager refreshes tools into the registry, meters latency and cleans stale tools", () =>
  withStore(async (store) => {
    const manager = new McpManager(store);
    try {
      const saved = await manager.save({
        ...DEMO_MCP_SERVER,
        command: process.execPath,
        args: [demoEntry]
      });
      assert.deepEqual(saved.envKeys, []);
      assert.equal(saved.toolCount, 0);

      const refreshed = await manager.refresh(saved.id);
      assert.equal(refreshed.info.serverName, "teaching-resource-mcp");
      assert.equal(refreshed.tools.length, 3);
      assert.ok(refreshed.latencyMs >= 0);
      assert.equal(refreshed.server.toolCount, 3);

      const tools = store.listTools().filter((tool) => tool.type === "mcp");
      assert.equal(tools.length, 3);
      const search = tools.find((tool) => tool.endpoint?.endsWith("/teaching_resource_search"));
      assert.ok(search);
      assert.equal(parseMcpEndpoint(search.endpoint)?.toolName, "teaching_resource_search");

      const result = await manager.call(saved.id, "teaching_resource_search", { query: "圆 面积", limit: 1 });
      assert.equal(result.isError, false);
      assert.ok(result.latencyMs >= 0);
      assert.match(result.text, /圆的面积/);

      await manager.remove(saved.id);
      assert.equal(store.getMcpServer(saved.id), undefined);
      assert.equal(store.listTools().filter((tool) => tool.type === "mcp").length, 0);
    } finally {
      await manager.closeAll();
    }
  }));

test("MCP config validation keeps env values server-side and rejects unsafe ids", () => {
  const saved = parseMcpServerWrite({
    id: "http-server",
    name: "HTTP Server",
    transport: "http",
    url: "https://mcp.example.edu/mcp",
    env: { MCP_TOKEN: "secret-value" },
    enabled: true
  });
  assert.deepEqual(saved.env, { MCP_TOKEN: "secret-value" });
  assert.throws(() => parseMcpServerWrite({ id: "../bad", name: "x", transport: "stdio", command: "node" }), /id/);
  assert.throws(() => parseMcpServerWrite({ id: "no-cmd", name: "x", transport: "stdio" }), /启动命令/);
  assert.throws(() => parseMcpServerWrite({ id: "bad-url", name: "x", transport: "http", url: "ftp://x" }), /地址/);

  const taken = new Set(["mcp.demo.resource_search"]);
  const unique = uniqueToolId("demo", "resource search", taken);
  assert.notEqual(unique, "mcp.demo.resource_search");
  assert.match(unique, /^mcp\.demo\.resource_search-/);
});

function textOf(content: unknown[]) {
  return content
    .map((item) => (typeof item === "object" && item !== null && "text" in item ? String(item.text) : ""))
    .join("\n");
}
