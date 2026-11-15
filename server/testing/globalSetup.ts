import { configureTestModels } from "./modelFixtures.js";

/**
 * 测试进程启动时先备好一份模型目录。
 *
 * 模型密钥现在只能来自「设置面板按账号保存的模型」，环境变量不再兜底。
 * 以前那些走到 resolveModel 的用例其实是靠开发机 .env 里的密钥才跑通的，
 * 现在把这件事显式化：默认就有一条可用模型，用例不必人人重复声明。
 *
 * 需要「一个模型都没配」语义的用例，自己把 MODEL_SETTINGS_DIR 指到空目录即可
 * （catalog.test.ts 里的 withTempSettings 就是这么做的）。
 */
configureTestModels(
  [
    { id: "test-model", model: "test-model", tags: ["fast", "reasoning"], costTier: "medium" },
    { id: "cheap-model", model: "cheap-model", tags: ["low-cost"], costTier: "low" },
    { id: "strong-model", model: "strong-model", tags: ["reasoning", "strong"], costTier: "high" }
  ],
  { defaultId: "test-model" }
);
