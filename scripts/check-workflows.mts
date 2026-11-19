import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compileWorkflow } from "../server/platform/workflow/compiler.js";
import { diagnoseWorkflow } from "../server/platform/workflow/diagnostics.js";
import type { WorkflowDefinition } from "../server/platform/types.js";

const dir = fileURLToPath(new URL("../server/platform/workflow/", import.meta.url));
const ids = readdirSync(dir)
  .filter((name) => name.endsWith(".json"))
  .map((name) => name.slice(0, -5))
  .sort();

const defs = new Map<string, WorkflowDefinition>();
for (const id of ids) {
  defs.set(
    id,
    JSON.parse(readFileSync(`${dir}${id}.json`, "utf8")) as WorkflowDefinition
  );
}
const resolveWorkflow = (id: string) => defs.get(id);

let failed = 0;
for (const id of ids) {
  const definition = defs.get(id)!;
  const issues = diagnoseWorkflow(definition).filter((issue) => issue.severity === "error");
  try {
    compileWorkflow(definition, { resolveWorkflow });
  } catch (error) {
    failed += 1;
    console.log(`✗ ${id} 编译失败：${(error as Error).message}`);
    continue;
  }
  if (issues.length > 0) {
    failed += 1;
    console.log(`✗ ${id} 诊断有阻塞项`);
    for (const issue of issues) console.log(`    - ${issue.code} ${issue.path}: ${issue.message}`);
    continue;
  }
  console.log(`✓ ${id} v${definition.version}`);
}
console.log(failed === 0 ? `全部通过（${ids.length} 个工作流）` : `${failed} 个工作流未通过`);
process.exit(failed === 0 ? 0 : 1);
