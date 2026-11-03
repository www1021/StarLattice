#!/usr/bin/env node
// 经营分析 MCP 服务器（stdio）。所有指标由固定 CSV 确定性计算，不依赖模型。
import { readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const SERVER_INFO = { name: "data-analysis-mcp", version: "1.0.0" };
const PROTOCOL_VERSION = "2025-06-18";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEMO_DIR = path.join(ROOT, "data", "demo");
const DEFAULT_SOURCE = "data/demo/sales.csv";
const REQUIRED_COLUMNS = [
  "order_id",
  "date",
  "region",
  "product",
  "channel",
  "units",
  "unit_price",
  "unit_cost",
  "refund_amount"
];

const TOOLS = [
  {
    name: "profile",
    title: "销售数据概况",
    description: "读取销售明细，返回订单数、销量、毛销售额、退款、净销售额、销货成本、毛利额与毛利率。",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "data/demo 下的 CSV 相对路径，默认 data/demo/sales.csv" }
      },
      additionalProperties: false
    }
  },
  {
    name: "metric_calc",
    title: "毛利核算",
    description: "按指定销售额口径计算毛利额与毛利率；gross 不扣退款，net 扣除退款，用于演示口径错误被验证拦截。",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "data/demo 下的 CSV 相对路径" },
        revenueBasis: {
          type: "string",
          enum: ["gross", "net"],
          description: "销售额口径：gross 为毛销售额，net 为扣除退款后的净销售额"
        }
      },
      required: ["revenueBasis"],
      additionalProperties: false
    }
  },
  {
    name: "groupby",
    title: "分组汇总",
    description: "按区域、品类、渠道或月份汇总净销售额、毛利额、退款与销量。",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "data/demo 下的 CSV 相对路径" },
        dimension: { type: "string", enum: ["region", "product", "channel", "month"] }
      },
      required: ["dimension"],
      additionalProperties: false
    }
  },
  {
    name: "trend",
    title: "销售趋势",
    description: "按月份或日期输出净销售额与毛利额趋势。",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "data/demo 下的 CSV 相对路径" },
        granularity: { type: "string", enum: ["month", "day"], default: "month" }
      },
      additionalProperties: false
    }
  },
  {
    name: "chart",
    title: "文本图表",
    description: "把分组结果渲染为终端文本柱状图或折线示意，便于在纯文本 trace 中快速比较。",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "data/demo 下的 CSV 相对路径" },
        dimension: { type: "string", enum: ["region", "product", "channel", "month"] },
        chartType: { type: "string", enum: ["bar", "line"], default: "bar" }
      },
      required: ["dimension"],
      additionalProperties: false
    }
  }
];

export function loadSales(source) {
  const relative = resolveSource(source);
  const text = readFileSync(path.join(ROOT, relative), "utf8");
  const [headerRow, ...dataRows] = parseCsv(text);
  if (!headerRow) {
    throw new Error(`销售数据为空：${relative}`);
  }
  const header = headerRow.map((item) => item.trim());
  const missing = REQUIRED_COLUMNS.filter((column) => !header.includes(column));
  if (missing.length > 0) {
    throw new Error(`销售数据缺少列：${missing.join("、")}`);
  }
  const index = new Map(header.map((column, position) => [column, position]));
  const rows = dataRows.map((row, rowIndex) => {
    const value = (column) => row[index.get(column)] ?? "";
    const numeric = (column) => {
      const parsed = Number(String(value(column)).replace(/,/g, ""));
      if (!Number.isFinite(parsed)) {
        throw new Error(`${relative} 第 ${rowIndex + 2} 行 ${column} 不是数字`);
      }
      return parsed;
    };
    const date = String(value("date")).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`${relative} 第 ${rowIndex + 2} 行 date 应为 YYYY-MM-DD`);
    }
    return {
      orderId: String(value("order_id")).trim(),
      date,
      month: date.slice(0, 7),
      region: String(value("region")).trim(),
      product: String(value("product")).trim(),
      channel: String(value("channel")).trim(),
      units: numeric("units"),
      unitPrice: numeric("unit_price"),
      unitCost: numeric("unit_cost"),
      refundAmount: numeric("refund_amount"),
      grossRevenue: numeric("units") * numeric("unit_price"),
      cogs: numeric("units") * numeric("unit_cost")
    };
  });
  if (rows.length === 0) {
    throw new Error(`销售数据没有明细行：${relative}`);
  }
  return { source: relative, rows };
}

export function profile(source) {
  const { source: relative, rows } = loadSales(source);
  const totals = totalsOf(rows);
  const text = [
    `销售数据概况（${relative}）`,
    `订单数：${totals.orders}`,
    `销量：${totals.units} 件`,
    `销售额（毛额）：${money(totals.grossRevenue)} 元`,
    `退款额：${money(totals.refunds)} 元`,
    `净销售额：${money(totals.netRevenue)} 元`,
    `销货成本：${money(totals.cogs)} 元`,
    `毛利额：${money(totals.grossProfit)} 元`,
    `毛利率：${percent(totals.grossMargin)}`,
    `退款率：${percent(totals.refundRate)}`
  ].join("\n");
  return { ...totals, source: relative, text };
}

export function metricCalc(source, revenueBasis) {
  const basis = revenueBasis === "gross" ? "gross" : revenueBasis === "net" ? "net" : undefined;
  if (!basis) {
    throw new Error("revenueBasis 必须是 gross 或 net");
  }
  const { source: relative, rows } = loadSales(source);
  const totals = totalsOf(rows);
  const revenueBase = basis === "gross" ? totals.grossRevenue : totals.netRevenue;
  const grossProfit = round2(revenueBase - totals.cogs);
  const grossMargin = revenueBase > 0 ? grossProfit / revenueBase : 0;
  const label = basis === "gross" ? "毛销售额（未扣退款）" : "净销售额（已扣退款）";
  const text = [
    `毛利核算（销售额口径：${basis}）`,
    `口径说明：${label}`,
    `销售额基准：${money(revenueBase)} 元`,
    `销货成本：${money(totals.cogs)} 元`,
    `毛利额：${money(grossProfit)} 元`,
    `毛利率：${percent(grossMargin)}`
  ].join("\n");
  return {
    source: relative,
    revenueBasis: basis,
    revenueBase: round2(revenueBase),
    cogs: round2(totals.cogs),
    grossProfit,
    grossMargin: round4(grossMargin),
    text
  };
}

export function groupby(source, dimension) {
  const { source: relative, rows } = loadSales(source);
  const keyOf = dimensionKey(dimension);
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }
  const entries = [...groups.entries()].map(([key, items]) => ({
    key,
    ...totalsOf(items)
  }));
  entries.sort((left, right) =>
    dimension === "month"
      ? left.key.localeCompare(right.key)
      : right.netRevenue - left.netRevenue || left.key.localeCompare(right.key)
  );
  const title = `${dimensionLabel(dimension)}分析（净额口径，${dimension === "month" ? "按月份排序" : "按净销售额排序"}）`;
  const lines = [title];
  for (const entry of entries) {
    if (dimension === "product") {
      lines.push(
        `${entry.key}：净销售额 ${money(entry.netRevenue)} 元，毛利额 ${money(entry.grossProfit)} 元，销量 ${entry.units} 件`
      );
    } else if (dimension === "month") {
      lines.push(
        `${entry.key}：净销售额 ${money(entry.netRevenue)} 元，毛利额 ${money(entry.grossProfit)} 元`
      );
    } else {
      lines.push(
        `${entry.key}：净销售额 ${money(entry.netRevenue)} 元，毛利额 ${money(entry.grossProfit)} 元，退款 ${money(entry.refunds)} 元`
      );
    }
  }
  return {
    source: relative,
    dimension,
    rows: entries.map((entry) => ({
      key: entry.key,
      orders: entry.orders,
      units: entry.units,
      grossRevenue: round2(entry.grossRevenue),
      refunds: round2(entry.refunds),
      netRevenue: round2(entry.netRevenue),
      cogs: round2(entry.cogs),
      grossProfit: round2(entry.grossProfit)
    })),
    text: lines.join("\n")
  };
}

export function trend(source, granularity = "month") {
  if (granularity !== "month" && granularity !== "day") {
    throw new Error("granularity 必须是 month 或 day");
  }
  const { rows } = loadSales(source);
  const keyOf = (row) => (granularity === "month" ? row.month : row.date);
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }
  const entries = [...groups.entries()]
    .map(([key, items]) => ({ key, ...totalsOf(items) }))
    .sort((left, right) => left.key.localeCompare(right.key));
  const text = [
    `${granularity === "month" ? "月度" : "每日"}趋势（净额口径）`,
    ...entries.map(
      (entry) =>
        `${entry.key}：净销售额 ${money(entry.netRevenue)} 元，毛利额 ${money(entry.grossProfit)} 元`
    )
  ].join("\n");
  return { granularity, rows: entries, text };
}

export function chart(source, dimension, chartType = "bar") {
  if (chartType !== "bar" && chartType !== "line") {
    throw new Error("chartType 必须是 bar 或 line");
  }
  const result = groupby(source, dimension);
  const max = Math.max(...result.rows.map((row) => row.netRevenue), 1);
  const width = 36;
  const lines = [`${dimensionLabel(dimension)}净销售额（${chartType}）`];
  for (const row of result.rows) {
    const value = money(row.netRevenue);
    if (chartType === "bar") {
      const filled = Math.max(1, Math.round((row.netRevenue / max) * width));
      lines.push(`${row.key} ${value} | ${"█".repeat(filled)}`);
    } else {
      const position = Math.round((row.netRevenue / max) * width);
      lines.push(`${row.key} ${value} | ${`${" ".repeat(position)}●`}`);
    }
  }
  return { dimension, chartType, rows: result.rows, text: lines.join("\n") };
}

function callTool(name, args) {
  switch (name) {
    case "profile": {
      const result = profile(args.source);
      return { text: result.text, structuredContent: result };
    }
    case "metric_calc": {
      const result = metricCalc(args.source, args.revenueBasis);
      return { text: result.text, structuredContent: result };
    }
    case "groupby": {
      const result = groupby(args.source, args.dimension);
      return { text: result.text, structuredContent: result };
    }
    case "trend": {
      const result = trend(args.source, args.granularity);
      return { text: result.text, structuredContent: result };
    }
    case "chart": {
      const result = chart(args.source, args.dimension, args.chartType);
      return { text: result.text, structuredContent: result };
    }
    default:
      throw Object.assign(new Error(`未知工具：${name}`), { code: -32602 });
  }
}

function totalsOf(rows) {
  const totals = rows.reduce(
    (accumulator, row) => {
      accumulator.orders += 1;
      accumulator.units += row.units;
      accumulator.grossRevenue += row.grossRevenue;
      accumulator.refunds += row.refundAmount;
      accumulator.cogs += row.cogs;
      return accumulator;
    },
    { orders: 0, units: 0, grossRevenue: 0, refunds: 0, cogs: 0 }
  );
  const netRevenue = totals.grossRevenue - totals.refunds;
  const grossProfit = netRevenue - totals.cogs;
  return {
    orders: totals.orders,
    units: totals.units,
    grossRevenue: round2(totals.grossRevenue),
    refunds: round2(totals.refunds),
    netRevenue: round2(netRevenue),
    cogs: round2(totals.cogs),
    grossProfit: round2(grossProfit),
    grossMargin: round4(netRevenue > 0 ? grossProfit / netRevenue : 0),
    refundRate: round4(totals.grossRevenue > 0 ? totals.refunds / totals.grossRevenue : 0)
  };
}

function dimensionKey(dimension) {
  if (dimension === "region") {
    return (row) => row.region;
  }
  if (dimension === "product") {
    return (row) => row.product;
  }
  if (dimension === "channel") {
    return (row) => row.channel;
  }
  if (dimension === "month") {
    return (row) => row.month;
  }
  throw new Error("dimension 必须是 region、product、channel 或 month");
}

function dimensionLabel(dimension) {
  return { region: "区域", product: "品类", channel: "渠道", month: "月度" }[dimension] ?? dimension;
}

function resolveSource(source) {
  const raw = String(source ?? "").trim() || DEFAULT_SOURCE;
  if (path.isAbsolute(raw) || raw.split(/[\\/]/).includes("..")) {
    throw new Error("source 只能是 data/demo 下的相对路径");
  }
  const resolved = path.resolve(ROOT, raw);
  if (resolved !== DEMO_DIR && !resolved.startsWith(`${DEMO_DIR}${path.sep}`)) {
    throw new Error("source 只能是 data/demo 下的相对路径");
  }
  return path.relative(ROOT, resolved).split(path.sep).join("/");
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((items) => items.some((item) => item.trim() !== ""));
}

function money(value) {
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function percent(value) {
  return `${(Number(value) * 100).toFixed(2)}%`;
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function round4(value) {
  return Math.round(Number(value) * 10000) / 10000;
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function startServer() {
  const reader = createInterface({ input: process.stdin });
  reader.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }
    const { id, method, params } = message ?? {};
    if (method === undefined) {
      return;
    }
    try {
      switch (method) {
        case "initialize":
          respond(id, {
            protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions: "提供销售数据概况、毛利核算、分组汇总、趋势与文本图表五类确定性工具。"
          });
          return;
        case "notifications/initialized":
        case "notifications/cancelled":
          return;
        case "ping":
          respond(id, {});
          return;
        case "tools/list":
          respond(id, { tools: TOOLS });
          return;
        case "tools/call": {
          const name = String(params?.name ?? "");
          const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
          const { text, structuredContent } = callTool(name, args);
          respond(id, {
            content: [{ type: "text", text }],
            structuredContent,
            isError: false
          });
          return;
        }
        default:
          respondError(id, -32601, `不支持的方法：${method}`);
      }
    } catch (error) {
      respondError(id, error?.code ?? -32603, error?.message ?? "工具执行失败。");
    }
  });
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  startServer();
}
