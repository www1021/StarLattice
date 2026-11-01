import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

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

export function startBenchEnv({ here, port, stamp, extraEnv = {} }) {
  const root = path.resolve(here, "..");
  const tmpDir = path.join(here, ".tmp");
  mkdirSync(tmpDir, { recursive: true });
  let log = "";
  let exit = null;
  const child = spawn(path.join(root, "node_modules", ".bin", "tsx"), ["server/index.ts"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      PLATFORM_DB_PATH: path.join(tmpDir, `platform-${stamp}.db`),
      TRAINING_DB_PATH: path.join(tmpDir, `training-${stamp}.db`),
      KNOWLEDGE_DB_PATH: path.join(tmpDir, `knowledge-${stamp}.db`),
      PLATFORM_STUB_DELAY_MS: process.env.PLATFORM_STUB_DELAY_MS ?? "0",
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => {
    log += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    log += chunk.toString();
  });
  child.on("exit", (code) => {
    exit = code ?? 1;
  });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    child,
    log: () => log,
    isDead: () => exit !== null,
    exitCode: () => exit,
    stop: () => child.kill("SIGTERM")
  };
}

export async function waitForHealth(env, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (env.isDead()) {
      throw new Error(`基准服务启动失败，code=${env.exitCode()}\n${env.log().slice(-2000)}`);
    }
    try {
      const response = await fetch(`${env.baseUrl}/api/platform/health`);
      if (response.ok) {
        const health = await response.json();
        return health;
      }
      lastError = new Error(`health HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`等待 ${env.baseUrl} 就绪超时：${lastError?.message ?? "unknown"}`);
}

export async function seedWorkflows(baseUrl, here) {
  const workflowDir = path.join(here, "workflows");
  const files = readdirSync(workflowDir).filter((file) => file.endsWith(".json")).sort();
  const seeded = [];
  for (const file of files) {
    const dsl = JSON.parse(readFileSync(path.join(workflowDir, file), "utf8"));
    const response = await fetch(`${baseUrl}/api/platform/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dsl })
    });
    if (!response.ok) {
      throw new Error(`写入基准工作流 ${dsl.id} 失败：HTTP ${response.status} ${await safeText(response)}`);
    }
    const payload = await response.json();
    seeded.push({ id: dsl.id, plan: payload.plan ?? null });
  }
  return seeded;
}

export async function seedKnowledge(baseUrl, here) {
  const dir = path.join(here, "knowledge");
  const files = readdirSync(dir).filter((file) => file.endsWith(".md")).sort();
  const created = await fetch(`${baseUrl}/api/knowledge/bases`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "基准评测知识库" })
  });
  if (!created.ok) {
    throw new Error(`创建基准知识库失败：HTTP ${created.status} ${await safeText(created)}`);
  }
  const { base } = await created.json();
  const listed = await fetch(`${baseUrl}/api/knowledge/bases/${base.id}/documents`);
  const listedPayload = listed.ok ? await listed.json() : { documents: [] };
  const existing = new Set((listedPayload.documents ?? []).map((document) => document.name));

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
    const response = await fetch(`${baseUrl}/api/knowledge/bases/${base.id}/documents`, {
      method: "POST",
      body: form
    });
    if (!response.ok) {
      throw new Error(`上传基准文档 ${file} 失败：HTTP ${response.status} ${await safeText(response)}`);
    }
    added += 1;
  }
  return { baseId: base.id, name: base.name, documentCount: existing.size + added, added };
}

async function safeText(response) {
  try {
    return (await response.text()).slice(0, 400);
  } catch {
    return "";
  }
}
