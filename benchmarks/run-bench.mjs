#!/usr/bin/env node
import "dotenv/config";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { summarize } from "./summary.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const port = Number(process.env.BENCH_PORT || 8790);
const baseUrl = (process.env.BENCH_BASE_URL || `http://127.0.0.1:${port}`).replace(/\/$/, "");
const external = process.env.BENCH_EXTERNAL === "1";
const resultsDir = path.join(here, "results");
const tmpDir = path.join(here, ".tmp");
// 带端口后缀：并行分块若在同一毫秒启动，纯时间戳会撞车并互相覆盖结果与隔离库。
const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-p${port}`;
const jsonPath = path.join(resultsDir, `bench-${stamp}.json`);
const mdPath = path.join(resultsDir, `bench-${stamp}.md`);
const csvPath = path.join(resultsDir, `bench-${stamp}.csv`);
const knowledgeDocumentNames = new Map([
  ["分数的意义.md", "g5-math-fractions.md"],
  ["光合作用.md", "g7-bio-photosynthesis.md"],
  ["静夜思.md", "g2-chinese-jingyesi.md"],
  ["牛顿第一定律.md", "g8-physics-newton-first-law.md"],
  ["现在进行时.md", "g7-english-present-continuous.md"],
  ["辛亥革命.md", "g8-history-xinhai-revolution.md"],
  ["化学方程式.md", "g9-chemistry-equations.md"],
  ["细胞结构.md", "g7-bio-cell-structure.md"]
]);

mkdirSync(resultsDir, { recursive: true });
mkdirSync(tmpDir, { recursive: true });

let server;
let serverLog = "";
let shuttingDown = false;
let serverExit = null;
let knowledgeBaseIds = [];
const startedAt = Date.now();
try {
  buildCases();
  if (!external) {
    await ensurePortFree();
    server = startServer();
  }
  await waitForHealth(baseUrl, 60_000);
  await seedWorkflows(baseUrl);
  knowledgeBaseIds = await seedKnowledge(baseUrl);
  await runPromptfoo();
  const summary = summarize(readJson(jsonPath), { startedAt, baseUrl, external });
  writeFileSync(mdPath, summary.markdown);
  writeFileSync(csvPath, summary.csv);
  if (process.env.BENCH_SKIP_LATEST !== "1") {
    writeFileSync(path.join(resultsDir, "latest.md"), summary.markdown);
    writeFileSync(path.join(resultsDir, "latest.csv"), summary.csv);
  }
  console.log(`\n${summary.markdown}`);
  console.log(`报告：${mdPath}`);
  console.log(`CSV：${csvPath}`);
} catch (error) {
  if (serverLog && server?.exitCode !== null) {
    console.error("\n--- server log ---\n" + serverLog.slice(-4000));
  }
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
} finally {
  if (server) {
    shuttingDown = true;
    server.kill("SIGTERM");
  }
}

function buildCases() {
  const result = spawnSync(process.execPath, [path.join(here, "build-cases.mjs")], {
    cwd: root,
    stdio: "inherit"
  });
  if (result.status !== 0) {
    throw new Error(`生成评测用例失败，exit=${result.status ?? "null"}`);
  }
}

function startServer() {
  const tsx = path.join(root, "node_modules", ".bin", "tsx");
  const child = spawn(tsx, ["server/index.ts"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      PLATFORM_DB_PATH: path.join(tmpDir, `platform-${stamp}.db`),
      TRAINING_DB_PATH: path.join(tmpDir, `training-${stamp}.db`),
      KNOWLEDGE_DB_PATH: path.join(tmpDir, `knowledge-${stamp}.db`),
      PLATFORM_STUB_DELAY_MS: process.env.PLATFORM_STUB_DELAY_MS ?? "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => {
    serverLog += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    serverLog += chunk.toString();
  });
  child.on("exit", (code) => {
    if (shuttingDown) {
      return;
    }
    serverExit = code ?? 1;
    console.error(`基准服务提前退出，code=${serverExit}`);
  });
  return child;
}

async function ensurePortFree() {
  try {
    const response = await fetch(`${baseUrl}/api/platform/health`, {
      signal: AbortSignal.timeout(1500)
    });
    if (response.ok) {
      throw new Error(
        `端口 ${port} 已被占用（${baseUrl} 健康检查通过），请先结束该进程，或设置 BENCH_BASE_URL 复用服务`
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("已被占用")) {
      throw error;
    }
  }
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (serverExit !== null) {
      throw new Error(`基准服务启动失败，code=${serverExit}\n${serverLog.slice(-2000)}`);
    }
    try {
      const response = await fetch(`${url}/api/platform/health`);
      if (response.ok) {
        const health = await response.json();
        console.log(
          `平台就绪：${url} · runtime=${health.runtime?.mode ?? "unknown"} · workflows=${(health.builtinWorkflows ?? []).join(",")}`
        );
        return;
      }
      lastError = new Error(`health HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`等待 ${url} 就绪超时：${lastError?.message ?? "unknown"}`);
}

async function seedWorkflows(url) {
  const workflowDir = path.join(here, "workflows");
  const files = readdirSync(workflowDir).filter((file) => file.endsWith(".json")).sort();
  for (const file of files) {
    const dsl = JSON.parse(readFileSync(path.join(workflowDir, file), "utf8"));
    const response = await fetch(`${url}/api/platform/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dsl })
    });
    const payload = await safeJson(response);
    if (!response.ok) {
      throw new Error(`写入基准工作流 ${dsl.id} 失败：HTTP ${response.status} ${JSON.stringify(payload)}`);
    }
    console.log(
      `已写入 ${dsl.id} · ${payload.plan?.rootNodes ?? "?"} 顶层 / ${payload.plan?.stepCount ?? "?"} 步骤`
    );
  }
}

async function seedKnowledge(url) {
  const dir = path.join(here, "knowledge");
  const files = readdirSync(dir).filter((file) => file.endsWith(".md")).sort();
  const created = await fetch(`${url}/api/knowledge/bases`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "基准评测知识库" })
  });
  if (!created.ok) {
    throw new Error(`创建基准知识库失败：HTTP ${created.status} ${await safeText(created)}`);
  }
  const { base } = await created.json();
  const listed = await safeJson(await fetch(`${url}/api/knowledge/bases/${base.id}/documents`));
  const existing = new Set((listed.documents ?? []).map((document) => document.name));

  let added = 0;
  for (const file of files) {
    const name = knowledgeDocumentNames.get(file) ?? file;
    if (existing.has(name)) {
      continue;
    }
    const form = new FormData();
    form.append(
      "file",
      new Blob([readFileSync(path.join(dir, file))], { type: "text/markdown" }),
      name
    );
    const response = await fetch(`${url}/api/knowledge/bases/${base.id}/documents`, {
      method: "POST",
      body: form
    });
    if (!response.ok) {
      throw new Error(`上传基准文档 ${file} 失败：HTTP ${response.status} ${await safeText(response)}`);
    }
    added += 1;
  }
  console.log(`知识库就绪：${base.name} · 文档 ${existing.size + added} 篇（本次新增 ${added}）`);
  return [base.id];
}

async function runPromptfoo() {
  const bin = path.join(root, "node_modules", ".bin", "promptfoo");
  const args = [
    "eval",
    "-c",
    "promptfooconfig.yaml",
    "--output",
    jsonPath,
    "--max-concurrency",
    "1"
  ];
  const limit = Number(process.env.BENCH_LIMIT || 0);
  if (Number.isFinite(limit) && limit > 0) {
    args.push("--filter-first-n", String(Math.trunc(limit)));
  }
  if (process.env.BENCH_RANGE) {
    args.push("--filter-range", process.env.BENCH_RANGE);
  }
  if (process.env.BENCH_PATTERN) {
    args.push("--filter-pattern", process.env.BENCH_PATTERN);
  }
  console.log(`\n运行 promptfoo：${bin} ${args.join(" ")}\n`);
  const code = await new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: path.join(here, "promptfoo"),
      env: {
        ...process.env,
        BENCH_BASE_URL: baseUrl,
        BENCH_KNOWLEDGE_BASE_IDS: knowledgeBaseIds.join(","),
        PROMPTFOO_DISABLE_TELEMETRY: "1",
        PROMPTFOO_DISABLE_UPDATE: "1"
      },
      stdio: "inherit"
    });
    const watchdog = setInterval(() => {
      if (serverExit !== null) {
        child.kill("SIGTERM");
      }
    }, 2000);
    child.on("exit", (exitCode) => {
      clearInterval(watchdog);
      resolve(exitCode ?? 1);
    });
  });
  if (serverExit !== null) {
    throw new Error(`基准服务在评测中途退出（code=${serverExit}），本次结果不完整，未写入报告`);
  }
  if (!readFileSyncSafe(jsonPath)) {
    throw new Error(`promptfoo 未生成结果文件（exit=${code}）`);
  }
  if (code !== 0) {
    console.log(`promptfoo exit=${code}（断言未全通过属预期，继续汇总）`);
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function readFileSyncSafe(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function safeText(response) {
  try {
    return (await response.text()).slice(0, 400);
  } catch {
    return "";
  }
}
