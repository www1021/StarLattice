import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveUserModel, setDefaultModelId } from "../platform/models/userModels.js";

export type TestModelSpec = {
  id: string;
  model?: string;
  label?: string;
  tags?: string[];
  costTier?: "low" | "medium" | "high";
};

/**
 * 测试用：把「这个账号已经配好模型」落成一份临时设置目录。
 *
 * 模型密钥现在只有这一个来源（设置面板按账号保存），环境变量不再兜底，
 * 所以需要「已配置模型」的用例都得先调它。返回的函数负责还原并清理目录。
 */
export function configureTestModels(
  models: TestModelSpec[] = [{ id: "test-model" }],
  options: { defaultId?: string } = {}
): () => void {
  const dir = mkdtempSync(path.join(tmpdir(), "starlattice-test-models-"));
  const previous = process.env.MODEL_SETTINGS_DIR;
  process.env.MODEL_SETTINGS_DIR = dir;

  for (const spec of models) {
    saveUserModel({
      id: spec.id,
      label: spec.label ?? spec.id,
      model: spec.model ?? spec.id,
      baseUrl: "https://api.example.com/v1",
      apiKey: `sk-${spec.id}`,
      tags: spec.tags ?? [],
      costTier: spec.costTier ?? "medium"
    });
  }
  const defaultId = options.defaultId ?? models[0]?.id;
  if (defaultId) {
    setDefaultModelId(defaultId);
  }

  return () => {
    if (previous === undefined) {
      delete process.env.MODEL_SETTINGS_DIR;
    } else {
      process.env.MODEL_SETTINGS_DIR = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  };
}

/** 单模型场景的简写。 */
export function configureTestModel(
  options: TestModelSpec = { id: "test-model" }
): () => void {
  return configureTestModels([options]);
}
