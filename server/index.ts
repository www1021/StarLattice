import "dotenv/config";
import express from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import { computePsychometrics, normalizeItems } from "./platform/exam/psychometrics.js";
import { checkRubric, computeClassroomEvidence } from "./platform/classroom/classroomEvidence.js";
import { classifyRisk, queryStudentProfiles } from "./platform/teacher/teacherTools.js";
import { WebSocket, WebSocketServer } from "ws";
import {
  type ArtifactRequest,
  generateArtifacts,
  getGeneratedFilePath
} from "./artifactService.js";
import {
  createTrainingEvaluation,
  inferTrainingType
} from "./evaluationService.js";
import {
  ClassroomService,
  ClassroomServiceError
} from "./classroom/classroomService.js";
import type {
  ClassroomActionType,
  ClassroomConfig,
  ClassroomReport,
  ClassroomState
} from "./classroom/classroomTypes.js";
import {
  buildInternshipReflectionArtifact,
  buildInternshipReflectionSearchQuery,
  diagnoseInternshipReflectionDraft,
  generateInternshipReflectionDraft,
  internshipDiagnosticToEvaluation,
  normalizeInternshipEvidence,
  normalizeInternshipReflectionInput,
  refineInternshipReflectionDraft,
  renderInternshipReflectionText,
  type InternshipEvidenceItem,
  type InternshipReflectionDraft,
  type InternshipReflectionInput
} from "./internshipReflectionService.js";
import {
  buildLessonPlanArtifact,
  buildLessonPlanSearchQuery,
  compareLessonPlanDrafts,
  diagnoseLessonPlanDraft,
  generateLessonPlanDraft,
  lessonDiagnosticToEvaluation,
  normalizeLessonPlanInput,
  refineLessonPlanDraft,
  renderLessonPlanText,
  type LessonPlanComparison,
  type LessonPlanDraft,
  type LessonPlanInput
} from "./lessonPlanService.js";
import {
  type ChatMessage,
  type ImageContentBlock,
  buildOfficeAssistantSystemPrompt,
  isQwenConfigured,
  streamQwenChat,
  type TextContentBlock,
  UpstreamModelError
} from "./qwenOpenAiClient.js";
import { resolveModel } from "./platform/models/catalog.js";
import { narrateNodeResult } from "./platform/chat/workflowNarration.js";
import {
  buildAgentChatSystemPrompt,
  contextTurnsOf,
  trimMessagesByTurns
} from "./platform/chat/agentChat.js";
import {
  needsExternalEvidence,
  runChatToolLoop,
  toToolChatMessages,
  type ChatToolProgress,
  type ChatToolTrace
} from "./platform/chat/agentTools.js";
import {
  buildChatToolsWithDelegation,
  delegationTargetId,
  isDelegationToolId,
  pickDelegationRoute,
  runAgentDelegation
} from "./platform/chat/agentDelegation.js";
import { AuthStore } from "./auth/store.js";
import { registerAuth, resolveRequestAuth } from "./auth/routes.js";
import {
  authFromResponse,
  bindConnectionAuth,
  currentAuth,
  resumeAuth,
  runWithAuth
} from "./auth/context.js";
import {
  backfillOrphanRows,
  backfillOwnerData,
  deleteOwnerData,
  ensureOwnerColumns,
  quarantineLegacySettings
} from "./auth/ownership.js";
import {
  generateMiniMaxLessonPlanDraft,
  generateStreamingMiniMaxLessonPlanDraft,
  isMiniMaxLessonPlanConfigured,
  MiniMaxLessonPlanError
} from "./minimaxLessonPlanClient.js";
import {
  IMAKnowledgeProvider,
  type KnowledgeCitation,
  type KnowledgeDocumentMetadata,
  KnowledgeError,
  KnowledgeProviderRegistry,
  LocalKnowledgeProvider
} from "./knowledgeService.js";
import {
  normalizeTrainingType,
  SQLiteChatRepository,
  type StoredArtifact,
  type StoredCitation,
  type StoredChatMessage,
  type TrainingEvaluation
} from "./storage/chatRepository.js";
import {
  answerPendingSpeakQuestion,
  buildSpeakConversationMessages,
  buildSpeakSessionSnapshot,
  createSpeakTrainingEvaluation,
  getSpeakTrainingConfig,
  processSpeakTrainingTurn,
  renderSpeakTrainingAssistantMessage,
  SpeakTrainingSession,
  type SpeakRealtimeClientEvent,
  type SpeakRealtimeServerEvent,
  type SpeakStageId,
  type SpeakTrainingTurnResult
} from "./speakTrainingService.js";
import {
  enhanceDefenseOptimizationWithAi,
  generateSpeakAiEnhancement
} from "./speakTrainingAiService.js";
import {
  getXfyunSpeechConfig,
  isXfyunSpeechConfigured,
  synthesizeXfyunSpeech,
  XfyunIatStream,
  XfyunSpeechError
} from "./xfyunSpeechService.js";
import { registerCounseling } from "./counseling/routes.js";
import { registerPlatform } from "./platform/routes.js";
import { PlatformStateStore } from "./platform/runtime/stateStore.js";
import { WorkflowExecutor } from "./platform/runtime/executor.js";
import { McpManager, type WorkflowProgressEvent } from "./platform/mcp/mcpManager.js";
import { runWorkflowTool, syncWorkflowTools } from "./platform/mcp/workflowTools.js";
import { PluginService } from "./platform/plugins/pluginService.js";
import { PLUGIN_TOOL_ENDPOINT_PREFIX, syncPluginTools } from "./platform/plugins/pluginTools.js";
import { buildPluginResultText } from "./platform/plugins/resultText.js";
import type { McpCallResult, ToolRecord } from "./platform/types.js";

/** 插件/工具结果里文本字段的最大长度，超长截断（对话侧还有 6000 上限兜底）。 */
const MAX_TOOL_TEXT_LENGTH = 6000;
import {
  isPlatformLiveEnabled
} from "./platform/runtime/liveHandlers.js";
import { createPlatformHandlers } from "./platform/runtime/handlersFactory.js";
import { ProcessWorkerPool } from "./platform/workers/pool.js";
import { SchedulerReclaimer } from "./platform/scheduler/reclaimer.js";
import { createLlmDimensionScorer, isLlmVerifyEnabled } from "./platform/verify/liveScorer.js";
import { EvolutionService } from "./platform/evolution/service.js";
import { seedEvolutionDatasets } from "./platform/evolution/datasets.js";
import {
  observeOperation,
  recordTrainingEvaluationScores,
  summarizeText
} from "./observability.js";

type ChatStreamRequest = {
  conversationId?: string;
  enableThinking?: boolean | string;
  knowledgeBaseIds?: unknown;
  messages?: unknown;
  trainingType?: unknown;
  assistantMode?: unknown;
  /** 本轮使用的模型 id；留空表示跟随设置里的默认模型。 */
  model?: unknown;
  /** 自建智能体 id；带上就走它的角色、提示词与模型。 */
  agentId?: unknown;
  /** 智能体提示词里的 {{变量}} 取值，按会话传。 */
  variables?: unknown;
};

type StreamPhaseStep = {
  id: string;
  label: string;
  detail: string;
};

const lessonPlanStreamGenerateSteps: StreamPhaseStep[] = [
  {
    id: "lesson-context",
    label: "理解课程信息",
    detail: "服务端已读取教案输入字段，准备进入知识库检索。"
  },
  {
    id: "lesson-knowledge",
    label: "检索知识库证据",
    detail: "服务端正在检索课程标准、教材片段和优秀课例。"
  },
  {
    id: "lesson-structure",
    label: "流式生成教案草稿",
    detail: "模型可用时正在输出教案 JSON token；不可用时会回退本地模板。"
  },
  {
    id: "lesson-diagnosis",
    label: "诊断薄弱维度",
    detail: "服务端正在计算目标、学情、活动、互动、反思和育人维度。"
  },
  {
    id: "lesson-artifact",
    label: "保存训练结果",
    detail: "服务端正在保存历史记录、评价和知识库引用。"
  }
];

const lessonPlanStreamRefineSteps: StreamPhaseStep[] = [
  {
    id: "lesson-refine-issues",
    label: "读取诊断建议",
    detail: "服务端已读取上一版教案和诊断问题。"
  },
  {
    id: "lesson-refine-evidence",
    label: "复核证据来源",
    detail: "服务端正在重新检索并对齐知识库引用。"
  },
  {
    id: "lesson-refine-draft",
    label: "流式生成优化稿",
    detail: "模型可用时正在输出优化稿 token；不可用时会回退本地优化规则。"
  },
  {
    id: "lesson-refine-score",
    label: "重新诊断评分",
    detail: "服务端正在检查优化稿是否回应薄弱维度。"
  },
  {
    id: "lesson-refine-artifact",
    label: "保存优化结果",
    detail: "服务端正在更新历史记录、评价和最终结果。"
  }
];

const reflectionStreamGenerateSteps: StreamPhaseStep[] = [
  {
    id: "reflection-context",
    label: "还原课堂事实",
    detail: "服务端正在读取实习班级、课题、日期、课堂片段和观察重点。"
  },
  {
    id: "reflection-evidence",
    label: "整理证据材料",
    detail: "服务端正在解析上传材料并检索知识库证据。"
  },
  {
    id: "reflection-model",
    label: "生成反思结构",
    detail: "服务端正在组织观察证据、问题诊断、原因分析和改进行动。"
  },
  {
    id: "reflection-diagnosis",
    label: "评估反思质量",
    detail: "服务端正在计算证据、理论连接、改进闭环和育人意识维度。"
  },
  {
    id: "reflection-artifact",
    label: "保存反思结果",
    detail: "服务端正在保存历史记录、评价和证据链。"
  }
];

const reflectionStreamRefineSteps: StreamPhaseStep[] = [
  {
    id: "reflection-refine-issues",
    label: "读取诊断建议",
    detail: "服务端已读取上一版反思和诊断问题。"
  },
  {
    id: "reflection-refine-evidence",
    label: "复核证据链",
    detail: "服务端正在对齐课堂事实、上传材料和知识库依据。"
  },
  {
    id: "reflection-refine-draft",
    label: "生成优化反思",
    detail: "服务端正在让改写内容对应具体证据和后续行动。"
  },
  {
    id: "reflection-refine-score",
    label: "重新诊断评分",
    detail: "服务端正在复核优化稿是否适合提交和归档。"
  },
  {
    id: "reflection-refine-artifact",
    label: "保存优化结果",
    detail: "服务端正在更新历史记录、评价和证据摘要。"
  }
];

const app = express();
const httpServer = http.createServer(app);
const speakTrainingSessions = new SpeakTrainingSession();
const classroomService = new ClassroomService();
const chatRepository = new SQLiteChatRepository(process.env.TRAINING_DB_PATH);
const knowledgeProvider = new KnowledgeProviderRegistry(
  new LocalKnowledgeProvider(process.env.KNOWLEDGE_DB_PATH || undefined),
  new IMAKnowledgeProvider()
);
const port = Number(process.env.PORT || 8787);
// 默认只监听本机；容器/局域网部署时用 HOST=0.0.0.0 显式放开。
const host = process.env.HOST?.trim() || "127.0.0.1";
const defaultLessonPlanAiTimeoutMs = 15_000;
const maxUploadCount = 5;
const maxUploadTotalBytes = 10 * 1024 * 1024;
const maxExtractedTextCharacters = 60000;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: maxUploadCount,
    fileSize: maxUploadTotalBytes
  }
});
const supportedImageTypes = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["webp", "image/webp"],
  ["gif", "image/gif"]
]);
const supportedTextExtensions = new Set(["txt", "md", "csv", "json"]);

/**
 * 认证必须挂在所有业务路由之前：公开接口先注册，再一个 app.use 兜住其余 /api。
 * 顺序反了会把登录接口自己也锁在外面，或者让业务端点绕过鉴权。
 */
const authStore = new AuthStore();
registerAuth(app, {
  store: authStore,
  // 这台机器默认允许自助注册：谁都可能是新用户，不该先找所有者要邀请。
  // 真要收敛成「只允许所有者添加成员」，显式设 AUTH_ALLOW_SIGNUP=0 即可。
  allowSignup: process.env.AUTH_ALLOW_SIGNUP !== "0",
  onFirstUser: (userId) => backfillOwnerData(userId, authStore),
  onDeleteUser: (userId) => deleteOwnerData(userId, path.resolve("generated"))
});

/**
 * body 解析把请求带出了鉴权建立的异步上下文（见 resumeAuth 的说明），
 * 所有解析器都要在完成回调里把身份接回来，否则后面的业务代码看不见账号。
 */
const readJsonBody = express.json({ limit: "1mb" });
app.use((request, response, next) => {
  readJsonBody(request, response, (error?: unknown) => {
    resumeAuth(authFromResponse(response), () => next(error as Error | undefined));
  });
});
const counseling = registerCounseling(app, httpServer, chatRepository);
const counselingService = counseling.service;
const platformStore = new PlatformStateStore();
// 三个业务库的表都建好了，再统一补 owner_id 列与索引。
ensureOwnerColumns();
// 单账号环境里，账号体系之后才加隔离列的老数据（比如历史运行记录）归属是空的，
// 直接补给这个账号；多账号时不动，宁可看不见也不乱判给谁。
if (authStore.countUsers() === 1) {
  const only = authStore.firstUser();
  if (only) {
    backfillOrphanRows(only.id);
  }
}
// 分账号之前留下的全局模型配置已经被首账号接管的话，把根目录那份收进 _legacy，
// 免得无身份的后台调用落到共享目录、把某个账号的 API Key 当成平台凭据用。
quarantineLegacySettings();
seedEvolutionDatasets(platformStore);
const platformEvolution = new EvolutionService({ store: platformStore });
const platformLiveEnabled = isPlatformLiveEnabled();
if (process.env.PLATFORM_LIVE_AGENTS === "1" && !platformLiveEnabled) {
  console.warn(
    "[platform] PLATFORM_LIVE_AGENTS=1，但所有账号的模型目录里都没有带凭据的模型；平台仍用 stub 执行器。请到「设置 → 模型与密钥」添加模型后重启。"
  );
}
const platformMcp = new McpManager(platformStore);
// 门禁默认使用无模型执行器：候选与基线在相同条件下配对比较，日常验证不消耗 token。
const platformStubExecutor = new WorkflowExecutor(
  platformStore,
  {},
  {
    releaseProvider: {
      resolveRelease: (releaseId) => platformEvolution.resolveRelease(releaseId)
    }
  }
);
const platformLiveHandlers = createPlatformHandlers({
  getAgent: (id) => platformStore.getAgent(id),
  getAgentVersion: (id, version) => platformStore.getAgentVersion(id, version),
  getTool: (id) => platformStore.getTool(id),
  callMcpTool: (tool, args) => platformMcp.callToolRecord(tool, args),
  searchKnowledge,
  trainingTool: (tool, input) => executeTrainingTool(tool, input)
});
/**
 * 动态调度执行平面：叶子步骤交给常驻 Worker 子进程，父进程只做 DAG 编排与状态落库。
 * 默认关闭（PLATFORM_WORKER_PROCESSES=0），需要多进程执行时显式开启。
 */
const workerProcessCount = Math.max(0, Math.min(64, Math.trunc(Number(process.env.PLATFORM_WORKER_PROCESSES) || 0)));
const platformWorkerPool =
  workerProcessCount > 0
    ? new ProcessWorkerPool({
        size: workerProcessCount,
        store: platformStore,
        services: {
          searchKnowledge: (options) => searchKnowledge(options),
          callMcpTool: (tool, args) => platformMcp.callToolRecord(tool, args),
          trainingTool: (tool, input) => executeTrainingTool(tool, input)
        }
      })
    : undefined;
if (platformWorkerPool) {
  console.log(`[platform] 已启用 ${platformWorkerPool.size} 个 Worker 子进程执行叶子步骤。`);
}
httpServer.on("close", () => {
  void platformWorkerPool?.drain("HTTP 服务关闭");
});
const configuredCapacity = Number(process.env.PLATFORM_SCHEDULER_CAPACITY);
const platformExecutor = new WorkflowExecutor(
  platformStore,
  platformLiveHandlers,
  {
    ...(platformLiveEnabled
      ? { timeoutMs: Number(process.env.PLATFORM_STEP_TIMEOUT_MS) || 120_000 }
      : {}),
    ...(isLlmVerifyEnabled() ? { dimensionScorer: createLlmDimensionScorer() } : {}),
    ...(platformWorkerPool
      ? {
          workerPool: platformWorkerPool,
          schedulerCapacity:
            Number.isFinite(configuredCapacity) && configuredCapacity > 0
              ? configuredCapacity
              : platformWorkerPool.size
        }
      : {}),
    // 发布运行固定使用发布快照，自循环补丁不再直接写注册表，而是进入演化候选。
    releaseProvider: {
      resolveRelease: (releaseId) => platformEvolution.resolveRelease(releaseId)
    },
    onRunFinished: (runId) => platformEvolution.observeRun(runId),
    onPromptCandidate: (signal) => platformEvolution.createCandidateFromSelfLoop(signal)
  }
);
platformEvolution.attachExecutors({ live: platformExecutor, stub: platformStubExecutor });
/**
 * 周期回收器：多实例部署时只有拿到租约的进程清理过期 Worker/租约与孤儿运行。
 * 自动续跑默认关闭（PLATFORM_SCHEDULER_AUTO_RESUME=0），避免重启后悄悄消耗真实模型额度。
 */
const reclaimInterval = Number(process.env.PLATFORM_SCHEDULER_RECLAIM_MS);
const schedulerReclaimer = new SchedulerReclaimer({
  store: platformStore,
  executor: platformExecutor,
  intervalMs: Number.isFinite(reclaimInterval) ? reclaimInterval : 15000,
  autoResume: process.env.PLATFORM_SCHEDULER_AUTO_RESUME === "1",
  ...(Number(process.env.PLATFORM_SCHEDULER_GRACE_MS) > 0
    ? { graceMs: Number(process.env.PLATFORM_SCHEDULER_GRACE_MS) }
    : {}),
  ...(Number(process.env.PLATFORM_SCHEDULER_RECOVER_MS) > 0
    ? { recoverWindowMs: Number(process.env.PLATFORM_SCHEDULER_RECOVER_MS) }
    : {})
});
schedulerReclaimer.start();
httpServer.on("close", () => {
  schedulerReclaimer.stop();
});
registerPlatform(app, {
  store: platformStore,
  executor: platformExecutor,
  evolution: platformEvolution,
  mcp: platformMcp,
  reclaimer: schedulerReclaimer,
  /** 主聊天页的工作流会话复用聊天业务的会话库，平台模块不直接持有 chatRepository。 */
  persistWorkflowConversation: async (input) => {
    const conversationId = input.conversationId || randomUUID();
    const messages: StoredChatMessage[] = input.messages;
    await chatRepository.saveConversation({
      conversationId,
      title: buildConversationTitle(messages),
      trainingType: "通用对话",
      assistantMode: "office",
      messages,
      knowledgeBaseIds: [],
      attachmentNames: [],
      artifacts: [],
      citations: [],
      workflowId: input.workflowId,
      lastRunId: input.runId
    });
    return conversationId;
  },
  knowledge: {
    listBases: () => knowledgeProvider.listBases(),
    createBase: (name) => knowledgeProvider.createBase(name),
    renameBase: (id, name) => knowledgeProvider.renameBase(id, name),
    deleteBase: (id) => knowledgeProvider.deleteBase(id),
    listDocuments: (id) => knowledgeProvider.listDocuments(id),
    deleteDocument: (baseId, documentId) => knowledgeProvider.deleteDocument(baseId, documentId),
    search: (options) => searchKnowledge(options)
  }
});
// 工作流即工具：注册为平台内联 MCP 工具，工具节点可像调用外部 MCP 一样调用工作流。
platformMcp.setWorkflowRunner((tool, args, onNodeProgress) =>
  runWorkflowTool(platformStore, platformExecutor, tool, args, onNodeProgress)
);
// 平台插件（builtin）同样内联执行：知识库检索、课堂/谈心训练、报告与导出等本地服务。
platformMcp.setBuiltinRunner((tool, args) => executeBuiltinTool(tool, args));
syncWorkflowTools(platformStore);
// 插件页的自建插件同步为 Agent 可挂的工具（plugin:// 端点，执行走插件调用器）。
const platformPlugins = new PluginService();
syncPluginTools(platformPlugins, platformStore);

/**
 * 内置工作流引用的是示例资料包 id；导入资料包后本地库会生成 kb_ 前缀的新 id。
 * 检索前把包 id 解析到已导入的同名资料库，避免跨环境演示时引用落空。
 */
async function resolveKnowledgeBaseIds(ids: string[]): Promise<string[]> {
  if (ids.length === 0) {
    return ids;
  }
  const bases = await knowledgeProvider.listBases();
  const known = new Set(bases.map((base) => base.id));
  const packs = knowledgeProvider.listStarterPacks();
  return ids.map((id) => {
    if (known.has(id)) {
      return id;
    }
    const pack = packs.find((item) => item.id === id);
    if (!pack) {
      return id;
    }
    return bases.find((base) => base.name === `我的资料包：${pack.name}`)?.id ?? id;
  });
}

async function searchKnowledge(options: {
  query: string;
  knowledgeBaseIds: string[];
  topK?: number;
}) {
  const resolved = await resolveKnowledgeBaseIds(options.knowledgeBaseIds);
  return observeOperation(
    "knowledge.search",
    {
      input: {
        query: summarizeText(options.query, 800),
        knowledgeBaseCount: options.knowledgeBaseIds.length,
        topK: options.topK
      },
      metadata: {
        operation: "knowledge.search"
      }
    },
    async (observation) => {
      const citations = await knowledgeProvider.search({ ...options, knowledgeBaseIds: resolved });

      observation.update({
        output: {
          citationCount: citations.length,
          sources: [...new Set(citations.map((citation) => citation.source))],
          documents: citations.slice(0, 6).map((citation) => ({
            knowledgeBaseName: citation.knowledgeBaseName,
            documentName: citation.documentName,
            source: citation.source,
            score: citation.score,
            snippet: summarizeText(citation.snippet, 240)
          }))
        }
      });

      return citations;
    },
    { asType: "retriever" }
  );
}

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.post("/api/classroom/create", (request, response) => {
  try {
    response.status(201).json(classroomService.createClassroom(request.body || {}));
  } catch (error) {
    handleClassroomError(error, response);
  }
});

app.get("/api/classroom/:sessionId", (request, response) => {
  try {
    const classroomState = classroomService.getClassroom(request.params.sessionId);

    if (!classroomState) {
      throw new ClassroomServiceError(404, "虚拟课堂会话不存在，请重新生成课堂。");
    }

    response.json({
      sessionId: classroomState.sessionId,
      classroomState
    });
  } catch (error) {
    handleClassroomError(error, response);
  }
});

app.post("/api/classroom/restore", (request, response) => {
  try {
    response.json(classroomService.restoreClassroom(request.body?.classroomState));
  } catch (error) {
    handleClassroomError(error, response);
  }
});

app.post("/api/classroom/teacher-speak", async (request, response) => {
  try {
    const sessionId =
      typeof request.body?.sessionId === "string" ? request.body.sessionId : "";
    const teacherText =
      typeof request.body?.teacherText === "string" ? request.body.teacherText : "";

    response.json(await classroomService.teacherSpeak(sessionId, teacherText));
  } catch (error) {
    handleClassroomError(error, response);
  }
});

app.post("/api/classroom/action", async (request, response) => {
  try {
    response.json(
      await classroomService.classroomAction({
        sessionId:
          typeof request.body?.sessionId === "string" ? request.body.sessionId : "",
        actionType: normalizeClassroomActionType(request.body?.actionType),
        targetStudentId:
          typeof request.body?.targetStudentId === "string"
            ? request.body.targetStudentId
            : undefined,
        teacherText:
          typeof request.body?.teacherText === "string"
            ? request.body.teacherText
            : undefined
      })
    );
  } catch (error) {
    handleClassroomError(error, response);
  }
});

app.post("/api/classroom/report", async (request, response) => {
  try {
    const sessionId =
      typeof request.body?.sessionId === "string" ? request.body.sessionId : "";
    response.json(await generateClassroomReportPayload(sessionId));
  } catch (error) {
    handleClassroomError(error, response);
  }
});

async function generateClassroomReportPayload(sessionId: string) {
  const report = await classroomService.generateReport(sessionId);
  const classroomState = classroomService.getClassroom(sessionId);
  const citations = classroomState
    ? await searchKnowledge({
        query: `${classroomState.subject} ${classroomState.grade} ${classroomState.topic} ${classroomState.trainingGoal}`,
        knowledgeBaseIds: classroomState.knowledgeBaseIds || [],
        topK: 3
      })
    : [];
  let saveError: string | undefined;
  let artifact: StoredArtifact | undefined;

  if (classroomState) {
    try {
      const result = await saveClassroomTrainingResult(
        classroomState,
        report,
        citations.map(toStoredCitation)
      );
      const conversationId = result.conversationId;
      artifact = result.artifact;
      classroomService.markSaved(sessionId, conversationId);
      report.savedConversationId = conversationId;
    } catch (error) {
      saveError = error instanceof Error ? error.message : "课堂报告已生成，但保存历史记录失败。";
    }
  }

  return { report, citations, saveError, artifact };
}

/**
 * 平台插件（builtin://）的执行分发：把注册表里的插件端点接到本地服务实现。
 * 对话 Agent、工作流 tool 节点与 agent 节点的工具调用共用这一条通路。
 */
async function executeBuiltinTool(
  tool: ToolRecord,
  args: Record<string, unknown>
): Promise<McpCallResult> {
  const startedAt = Date.now();
  const reply = (
    data: unknown,
    text?: string,
    isError = false,
    meta?: { serverName?: string; tool?: string }
  ) => {
    const message =
      text ??
      (typeof data === "string" ? data : JSON.stringify(data, null, 2)).slice(0, MAX_TOOL_TEXT_LENGTH);
    return {
      serverId: "builtin",
      serverName: meta?.serverName ?? "平台插件",
      tool: meta?.tool ?? tool.id,
      latencyMs: Date.now() - startedAt,
      isError,
      content: [{ type: "text" as const, text: message }],
      text: message,
      structuredContent: isError ? undefined : data
    };
  };
  try {
    const endpoint = (tool.endpoint ?? "").replace(/^builtin:\/\//, "");
    switch (endpoint) {
      case "knowledge/search": {
        const query = readToolString(args.query, "query");
        const citations = await searchKnowledge({
          query,
          knowledgeBaseIds: Array.isArray(args.knowledgeBaseIds)
            ? (args.knowledgeBaseIds as string[])
            : [],
          topK: typeof args.topK === "number" ? args.topK : 5
        });
        return reply({ query, citationCount: citations.length, citations });
      }
      case "classroom/simulate": {
        // 与 classroom.turn 的差别只在语义：模拟允许不带会话，先用默认班级画像开一间。
        let sessionId = typeof args.sessionId === "string" ? args.sessionId : "";
        if (!sessionId) {
          const created = await classroomService.createClassroom({
            subject: typeof args.subject === "string" ? args.subject : "综合",
            grade: typeof args.grade === "string" ? args.grade : "高一",
            topic: readToolString(args.teacherText ?? args.topic, "teacherText").slice(0, 60),
            knowledgeBaseIds: Array.isArray(args.knowledgeBaseIds)
              ? (args.knowledgeBaseIds as string[])
              : []
          });
          sessionId = created.sessionId;
        }
        const result = await classroomService.teacherSpeak(
          sessionId,
          readToolString(args.teacherText, "teacherText")
        );
        return reply({ sessionId, ...result });
      }
      case "report/build": {
        const observer = (args.observer ?? {}) as Record<string, unknown>;
        const score = typeof args.score === "number" ? args.score : 0;
        const iterations = typeof args.iterations === "number" ? args.iterations : 0;
        const passed = score >= 0.8;
        return reply({
          summary: `训练完成：${iterations} 轮迭代，综合得分 ${(score * 100).toFixed(0)} 分（${passed ? "达标" : "未达标"}）。`,
          score,
          iterations,
          passed,
          strengths: Array.isArray(observer.strengths) ? observer.strengths : [],
          improvements: Array.isArray(observer.improvements) ? observer.improvements : [],
          generatedAt: new Date().toISOString()
        });
      }
      case "verify/rubric": {
        const artifactText =
          typeof args.output === "string"
            ? args.output
            : JSON.stringify(args.output ?? {}, null, 2);
        const rubric = Array.isArray(args.rubric) ? (args.rubric as string[]) : [];
        const threshold = typeof args.threshold === "number" ? args.threshold : 0.8;
        // 轻量启发式评分：按维度关键词命中 + 内容充分度打分（与工作流 verify 节点的 stub 层同源思路）。
        const dimensions = rubric.map((name) => {
          const tokens = String(name)
            .split(/[\s、,，/]/)
            .filter((token) => token.length >= 2);
          const hit = tokens.some((token) => artifactText.includes(token));
          const lengthFactor = Math.min(1, artifactText.length / 600);
          const value = Math.min(1, 0.4 + (hit ? 0.35 : 0) + 0.25 * lengthFactor);
          return {
            name,
            score: Number(value.toFixed(3)),
            comment: hit ? "内容覆盖了该维度的关键词" : "未明确命中该维度的关键词，建议补充对应论述"
          };
        });
        const score =
          dimensions.length > 0
            ? dimensions.reduce((sum, item) => sum + item.score, 0) / dimensions.length
            : 0;
        return reply({
          score: Number(score.toFixed(3)),
          threshold,
          passed: score >= threshold,
          confidence: 0.6,
          dimensions,
          note: "插件侧为启发式评分；需要分层验证请使用工作流的 verify 节点。"
        });
      }
      case "exam/psychometrics": {
        const items = normalizeItems(args.items);
        if (items.length === 0) {
          return reply(
            "测量失败：没有可用的题目数据，请为每题提供 id、fullScore、highGroupAvg、lowGroupAvg。",
            undefined,
            true
          );
        }
        return reply(
          computePsychometrics(items, {
            difficultyRange: Array.isArray(args.difficultyRange)
              ? (args.difficultyRange as unknown[]).map(Number)
              : undefined,
            discriminationMin:
              typeof args.discriminationMin === "number" ? args.discriminationMin : undefined
          })
        );
      }
      case "teacher/student-profile": {
        return reply(
          queryStudentProfiles({
            students: Array.isArray(args.students) ? (args.students as never) : [],
            scoreBelow: typeof args.scoreBelow === "number" ? args.scoreBelow : undefined,
            tags: Array.isArray(args.tags) ? (args.tags as unknown[]).map((tag) => String(tag)) : undefined,
            order: args.order === "asc" || args.order === "desc" ? args.order : undefined,
            limit: typeof args.limit === "number" ? args.limit : undefined
          })
        );
      }
      case "teacher/risk-classify": {
        const text = typeof args.text === "string" ? args.text : "";
        if (!text.trim()) {
          return reply("风险判定失败：没有可用的事件描述，请提供 text。", undefined, true);
        }
        return reply(
          classifyRisk({
            text,
            history: Array.isArray(args.history)
              ? (args.history as Array<{ date?: unknown; level?: unknown; note?: unknown }>).map((item) => ({
                  date: typeof item.date === "string" ? item.date : undefined,
                  level: typeof item.level === "string" ? item.level : undefined,
                  note: typeof item.note === "string" ? item.note : undefined
                }))
              : []
          })
        );
      }
      case "classroom/evidence": {
        const utterances = Array.isArray(args.utterances)
          ? (args.utterances as Array<{ speaker?: unknown; text?: unknown; startSec?: unknown; endSec?: unknown }>)
              .map((item) => ({
                speaker: typeof item.speaker === "string" ? item.speaker : "",
                text: typeof item.text === "string" ? item.text : "",
                startSec: typeof item.startSec === "number" ? item.startSec : undefined,
                endSec: typeof item.endSec === "number" ? item.endSec : undefined
              }))
          : [];
        if (utterances.length === 0) {
          return reply("证据统计失败：没有可用的发言记录，请提供 utterances 数组。", undefined, true);
        }
        return reply(computeClassroomEvidence(utterances));
      }
      case "rubric/check": {
        const dimensions = Array.isArray(args.dimensions)
          ? (args.dimensions as Array<{ dimension?: unknown; scores?: unknown }>)
              .map((item) => ({
                dimension: typeof item.dimension === "string" ? item.dimension : "",
                scores: Array.isArray(item.scores) ? (item.scores as unknown[]).map(Number) : []
              }))
          : [];
        if (dimensions.length === 0) {
          return reply("一致性判定失败：没有可用的维度分数，请提供 dimensions 数组。", undefined, true);
        }
        return reply(
          checkRubric({
            dimensions,
            redlines: Array.isArray(args.redlines)
              ? (args.redlines as Array<{ code?: unknown; hit?: unknown; evidence?: unknown }>).map((item) => ({
                  code: typeof item.code === "string" ? item.code : "",
                  hit: Boolean(item.hit),
                  evidence: typeof item.evidence === "string" ? item.evidence : undefined
                }))
              : [],
            maxSpread: typeof args.maxSpread === "number" ? args.maxSpread : undefined,
            passScore: typeof args.passScore === "number" ? args.passScore : undefined
          })
        );
      }
      case "export/docx": {
        const [artifact] = await generateArtifacts([
          {
            name: typeof args.name === "string" && args.name.trim() ? args.name : "插件导出",
            type: "docx",
            title: typeof args.title === "string" ? args.title : undefined,
            content: typeof args.content === "string" ? args.content : undefined,
            sections: Array.isArray(args.sections) ? args.sections : undefined
          }
        ]);
        if (!artifact) {
          return reply("导出失败：未能生成文档（请检查 name/content 参数）。", undefined, true);
        }
        return reply({ id: artifact.id, name: artifact.name, type: artifact.type, url: artifact.url, size: artifact.size });
      }
      default: {
        // 插件页自建插件：plugin:// 端点走插件调用器（api 插件发真实请求，code 插件跑代码）。
        if (endpoint.startsWith(PLUGIN_TOOL_ENDPOINT_PREFIX)) {
          const pluginId = endpoint.slice(PLUGIN_TOOL_ENDPOINT_PREFIX.length);
          const result = await platformPlugins.test(pluginId, args);
          const plugin = platformPlugins.get(pluginId);
          const pluginLabel = plugin?.name ?? tool.name.replace(/^插件：/, "");
          const toolName =
            typeof plugin?.config?.toolName === "string" && plugin.config.toolName.trim()
              ? plugin.config.toolName.trim()
              : "run";
          if (!result.ok) {
            const text = `插件执行失败：${result.error ?? "未知错误"}`;
            return reply(text, text.slice(0, MAX_TOOL_TEXT_LENGTH), true, {
              serverName: pluginLabel,
              tool: toolName
            });
          }
          // 不要把原始 JSON 的前 1200 字截断稿直接交给模型：字段会被拦腰砍断，
          // 模型只能回一句「内容被截断了」。这里按题录字段投影，条数按预算取。
          const text = buildPluginResultText({
            detail: result.detail,
            preview: result.preview,
            query: readPluginQuery(args)
          });
          return reply(
            { preview: result.preview, detail: result.detail, request: result.request },
            text.slice(0, MAX_TOOL_TEXT_LENGTH),
            false,
            { serverName: pluginLabel, tool: toolName }
          );
        }
        // 课堂与谈心系列直接复用训练工具的确定性入口。
        const training = await executeTrainingTool(tool.id, args);
        if (training !== undefined) {
          return reply(training);
        }
        return reply(`插件「${tool.id}」没有可用的执行实现（端点 ${endpoint || "未声明"}）。`, undefined, true);
      }
    }
  } catch (error) {
    return reply(error instanceof Error ? error.message : String(error), undefined, true);
  }
}

/**
 * 插件调用里的检索词：参数名由用户在插件编辑器里定，常见的几种都认一下，
 * 用来判断「中文查英文库」并提醒模型换关键词。
 */
function readPluginQuery(args: Record<string, unknown>): string {
  for (const key of ["search", "query", "q", "keyword", "keywords", "term"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

/**
 * 训练工具的确定性入口：课堂与谈心谈话的会话状态仍由原服务维护，
 * 但每次调用都发生在平台工作流节点中，因此运行监控能看到完整会话轨迹。
 */
async function executeTrainingTool(tool: string, input: Record<string, unknown>) {
  if (tool === "classroom.create") {
    return classroomService.createClassroom(
      input as Partial<ClassroomConfig> & { knowledgeBaseIds?: string[] }
    );
  }
  if (tool === "classroom.turn") {
    return classroomService.teacherSpeak(
      readToolString(input.sessionId, "sessionId"),
      readToolString(input.teacherText, "teacherText")
    );
  }
  if (tool === "classroom.feedback") {
    return buildClassroomFeedback(readToolString(input.sessionId, "sessionId"));
  }
  if (tool === "classroom.report") {
    return generateClassroomReportPayload(readToolString(input.sessionId, "sessionId"));
  }
  if (tool === "counseling.create") {
    return { session: counselingService.create(input.config) };
  }
  if (tool === "counseling.turn") {
    const sessionId = readToolString(input.sessionId, "sessionId");
    const text = readToolString(input.text, "text");
    const turnId =
      typeof input.turnId === "string" && input.turnId.trim()
        ? input.turnId
        : `turn_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;
    return { session: await counselingService.turn(sessionId, text, turnId, "text") };
  }
  if (tool === "counseling.feedback") {
    return buildCounselingFeedback(readToolString(input.sessionId, "sessionId"));
  }
  if (tool === "counseling.finish") {
    return { session: await counselingService.finish(readToolString(input.sessionId, "sessionId")) };
  }
  return undefined;
}

function buildClassroomFeedback(sessionId: string) {
  const state = classroomService.getClassroom(sessionId);
  if (!state) {
    throw new ClassroomServiceError(404, "课堂不存在，无法生成观察员点评。");
  }
  const teacherIndex = state.timeline.map((item) => item.role).lastIndexOf("teacher");
  const currentTurn = teacherIndex >= 0 ? state.timeline.slice(teacherIndex) : state.timeline.slice(-8);
  const studentEvidence = currentTurn
    .filter((item) => item.role === "student")
    .slice(0, 4)
    .map((item) => ({
      student: item.speaker,
      content: item.content,
      answerQuality: item.answerQuality,
      validated: item.validationPassed
    }));
  const turnStartedAt = currentTurn[0]?.timestamp ?? 0;
  const risks = state.events
    .filter(
      (event) =>
        event.timestamp >= turnStartedAt &&
        (event.severity === "medium" || event.severity === "high")
    )
    .map((event) => event.description);
  const observerTips = currentTurn
    .filter((item) => item.role === "observer")
    .map((item) => item.content);
  const metrics = state.metrics;
  const nextMoves = [
    metrics.participation < 55 ? "点名尚未发言的学生，扩大参与面。" : "",
    metrics.understanding < 60 ? "回到关键概念，用一个具体例子复述并请学生判断。" : "",
    metrics.discipline < 60 ? "先处理课堂事件，再推进教学内容。" : "",
    metrics.interactionQuality < 60 ? "把封闭提问改成追问理由的开放问题。" : "",
    ...risks.slice(0, 1).map((risk) => `先回应：${risk}`)
  ].filter(Boolean);
  return {
    turn: state.turnCount,
    summary: `第 ${state.turnCount} 轮：${studentEvidence.length} 名学生响应，参与度 ${metrics.participation}，理解度 ${metrics.understanding}。`,
    observerTips,
    studentEvidence,
    risks,
    nextMoves: nextMoves.length ? nextMoves.slice(0, 3) : ["用一两句话收束本轮，再推进下一个教学环节。"],
    metrics
  };
}

function buildCounselingFeedback(sessionId: string) {
  const session = counselingService.get(sessionId);
  const latestEvidence = session.evidence[session.evidence.length - 1];
  const latestEvent = latestEvidence
    ? [...session.events].reverse().find((event) => event.turnId === latestEvidence.turnId)
    : session.events[session.events.length - 1];
  const state = session.state;
  const suggestions = [
    latestEvent?.severity === "critical" ? `优先处理安全风险：${latestEvent.suggestion}` : "",
    state.tension >= 60 ? "先降低威胁感：承认学生的感受，暂缓追问事实。" : "",
    state.openness < 40 ? "用开放式问题替代连续追问，给学生留出组织语言的时间。" : "",
    state.trust < 40 ? "说明谈话边界与保密例外，先建立安全感。" : "",
    latestEvent?.suggestion ?? ""
  ].filter(Boolean);
  return {
    turn: session.evidence.length,
    state,
    moves: latestEvidence?.moves ?? [],
    event: latestEvent
      ? { title: latestEvent.title, severity: latestEvent.severity, suggestion: latestEvent.suggestion }
      : undefined,
    suggestions: suggestions.length ? suggestions.slice(0, 3) : ["小结已了解的信息，并确认下一步支持。"]
  };
}

function readToolString(value: unknown, key: string) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ClassroomServiceError(400, `训练工具缺少参数 ${key}。`);
  }
  return value;
}

app.get("/api/files/:id", (request, response) => {
  const id = path.basename(request.params.id);
  const context = currentAuth();
  const owner = authStore.getFileOwner(id);
  // 随机文件名不构成权限控制；必须核对归属，猜到 id 也不能拿别人的导出件。
  if (!context || !owner || owner !== context.userId) {
    authStore.recordEvent({
      userId: context?.userId ?? null,
      action: "file.download",
      target: id,
      result: "denied"
    });
    response.status(404).json({ message: "文件不存在" });
    return;
  }
  response.download(getGeneratedFilePath(id));
});

app.get("/api/conversations", (_request, response) => {
  response.json({ conversations: chatRepository.listConversations() });
});

app.get("/api/conversations/:id", (request, response) => {
  const conversation = chatRepository.getConversation(request.params.id);

  if (!conversation) {
    response.status(404).json({ message: "训练记录不存在。" });
    return;
  }

  response.json({ conversation });
});

app.post("/api/evaluations", express.json({ limit: "1mb" }), async (request, response) => {
  const conversationId =
    typeof request.body?.conversationId === "string"
      ? request.body.conversationId
      : "";
  const conversation = chatRepository.getConversation(conversationId);

  if (!conversation) {
    response.status(404).json({ message: "训练记录不存在，无法生成评价。" });
    return;
  }

  await observeOperation(
    "training.evaluation.create",
    {
      input: {
        conversationId: conversation.id,
        trainingType: conversation.trainingType,
        messageCount: conversation.messages.length,
        citationCount: conversation.citations.length
      }
    },
    async (observation) => {
      const evaluation = createTrainingEvaluation({
        conversationId: conversation.id,
        trainingType:
          conversation.trainingType === "通用对话"
            ? "教案诊断"
            : conversation.trainingType,
        messages: conversation.messages,
        citations: conversation.citations
      });
      await chatRepository.saveEvaluation(evaluation);
      observation.update({
        output: {
          overallScore: evaluation.overallScore,
          dimensionCount: evaluation.dimensions.length
        }
      });
      recordTrainingEvaluationScores(observation, evaluation);
      response.status(201).json({ evaluation });
    }
  );
});

app.get("/api/growth/summary", (_request, response) => {
  response.json({ summary: chatRepository.getGrowthSummary() });
});

app.post("/api/growth/report", express.json({ limit: "1mb" }), async (request, response) => {
  const type = request.body?.type === "docx" ? "docx" : "md";
  const summary = chatRepository.getGrowthSummary();
  chatRepository.saveGrowthSnapshot(summary);
  const [artifact] = await generateArtifacts([
    buildGrowthReportArtifact(summary, type)
  ]);

  response.status(201).json({ artifact });
});

app.post("/api/lesson-plans/generate", async (request, response) => {
  try {
    const input = normalizeLessonPlanInput(request.body);
    await observeOperation(
      "lesson.plan.generate",
      {
        input: {
          subject: input.subject,
          grade: input.grade,
          topic: input.topic,
          knowledgeBaseCount: input.knowledgeBaseIds.length
        },
        metadata: {
          mode: "generate"
        }
      },
      async (observation) => {
        const citations = (
          await searchKnowledge({
            query: buildLessonPlanSearchQuery(input),
            knowledgeBaseIds: input.knowledgeBaseIds,
            topK: 4
          })
        ).map(toStoredCitation);
        const draft = await createLessonPlanDraftWithOptionalAi({
          input,
          citations,
          mode: "generate"
        });
        const diagnostic = diagnoseLessonPlanDraft(draft, citations);
        const comparison = compareLessonPlanDrafts({
          currentDraft: draft,
          diagnostic,
          citations
        });
        const conversationId = randomUUID();
        const evaluation = lessonDiagnosticToEvaluation(
          conversationId,
          diagnostic,
          citations
        );

        await saveLessonPlanTraining({
          conversationId,
          input,
          draft,
          citations,
          evaluation,
          action: "生成教案",
          comparison
        });

        observation.update({
          output: {
            conversationId,
            title: draft.title,
            citationCount: citations.length,
            overallScore: evaluation.overallScore,
            weakestDimension: evaluation.dimensions.at(-1)?.name
          }
        });
        recordTrainingEvaluationScores(observation, evaluation);

        response.status(201).json({
          conversationId,
          draft,
          diagnostic,
          citations,
          evaluation,
          comparison
        });
      },
      { asType: "chain" }
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "教案生成失败，请稍后重试。";
    response.status(400).json({ message });
  }
});

app.post("/api/lesson-plans/refine", async (request, response) => {
  try {
    const input = normalizeLessonPlanInput(request.body?.input || request.body);
    const currentDraft = isRecord(request.body?.draft)
      ? (request.body.draft as LessonPlanDraft)
      : undefined;
    await observeOperation(
      "lesson.plan.refine",
      {
        input: {
          subject: input.subject,
          grade: input.grade,
          topic: input.topic,
          knowledgeBaseCount: input.knowledgeBaseIds.length,
          hasCurrentDraft: Boolean(currentDraft)
        },
        metadata: {
          mode: "refine"
        }
      },
      async (observation) => {
        const citations = (
          await searchKnowledge({
            query: buildLessonPlanSearchQuery(input),
            knowledgeBaseIds: input.knowledgeBaseIds,
            topK: 4
          })
        ).map(toStoredCitation);
        const draft = await createLessonPlanDraftWithOptionalAi({
          input,
          citations,
          currentDraft,
          mode: "refine"
        });
        const diagnostic = diagnoseLessonPlanDraft(draft, citations);
        const comparison = compareLessonPlanDrafts({
          previousDraft: currentDraft,
          currentDraft: draft,
          diagnostic,
          citations
        });
        const conversationId =
          typeof request.body?.conversationId === "string"
            ? request.body.conversationId
            : randomUUID();
        const evaluation = lessonDiagnosticToEvaluation(
          conversationId,
          diagnostic,
          citations
        );

        await saveLessonPlanTraining({
          conversationId,
          input,
          draft,
          citations,
          evaluation,
          action: "按建议优化教案",
          comparison
        });

        observation.update({
          output: {
            conversationId,
            title: draft.title,
            citationCount: citations.length,
            overallScore: evaluation.overallScore,
            version: draft.version
          }
        });
        recordTrainingEvaluationScores(observation, evaluation);

        response.status(201).json({
          conversationId,
          draft,
          diagnostic,
          citations,
          evaluation,
          comparison
        });
      },
      { asType: "chain" }
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "教案优化失败，请稍后重试。";
    response.status(400).json({ message });
  }
});

app.post("/api/lesson-plans/generate/stream", async (request, response) => {
  await streamLessonPlanRequest(request, response, "generate");
});

app.post("/api/lesson-plans/refine/stream", async (request, response) => {
  await streamLessonPlanRequest(request, response, "refine");
});

app.post("/api/lesson-plans/export", async (request, response) => {
  const draft = isRecord(request.body?.draft)
    ? (request.body.draft as LessonPlanDraft)
    : undefined;

  if (!draft) {
    response.status(400).json({ message: "缺少可导出的教案内容。" });
    return;
  }

  try {
    const [artifact] = await generateArtifacts([buildLessonPlanArtifact(draft)]);
    response.status(201).json({ artifact });
  } catch {
    response.status(400).json({ message: "教案 Word 导出失败，请稍后重试。" });
  }
});

app.post("/api/internship-reflections/generate", parseReflectionUpload, async (request, response) => {
  try {
    const input = normalizeInternshipReflectionInput(parseJsonField(request.body?.input) || request.body);
    const uploadedEvidence = await summarizeInternshipEvidence(getUploadedFiles(request));
    const evidence = [
      ...normalizeInternshipEvidence(parseJsonField(request.body?.evidence)),
      ...uploadedEvidence
    ];
    const citations = (
      await searchKnowledge({
        query: buildInternshipReflectionSearchQuery(input),
        knowledgeBaseIds: input.knowledgeBaseIds,
        topK: 4
      })
    ).map(toStoredCitation);
    const priorTrainingLinks = buildReflectionPriorTrainingLinks();
    const draft = generateInternshipReflectionDraft({
      input,
      evidence,
      citations,
      priorTrainingLinks
    });
    const savedEvidence = draft.evidence;
    const diagnostic = diagnoseInternshipReflectionDraft(draft, citations);
    const conversationId =
      typeof request.body?.conversationId === "string"
        ? request.body.conversationId
        : randomUUID();
    const evaluation = internshipDiagnosticToEvaluation(
      conversationId,
      diagnostic,
      citations
    );

    await saveInternshipReflectionTraining({
      conversationId,
      input,
      draft,
      citations,
      evidence: savedEvidence,
      evaluation,
      action: "生成实习日志与反思"
    });

    response.status(201).json({
      conversationId,
      draft,
      diagnostic,
      citations,
      evidence: savedEvidence,
      evaluation
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "实习反思生成失败，请稍后重试。";
    response.status(400).json({ message });
  }
});

app.post("/api/internship-reflections/generate/stream", parseReflectionUpload, async (request, response) => {
  await streamInternshipReflectionRequest(request, response, "generate");
});

app.post("/api/internship-reflections/refine/stream", parseReflectionUpload, async (request, response) => {
  await streamInternshipReflectionRequest(request, response, "refine");
});

app.post("/api/internship-reflections/refine", parseReflectionUpload, async (request, response) => {
  try {
    const input = normalizeInternshipReflectionInput(
      parseJsonField(request.body?.input) || request.body
    );
    const currentDraft = isRecord(parseJsonField(request.body?.draft))
      ? (parseJsonField(request.body?.draft) as InternshipReflectionDraft)
      : isRecord(request.body?.draft)
        ? (request.body.draft as InternshipReflectionDraft)
        : undefined;
    const uploadedEvidence = await summarizeInternshipEvidence(getUploadedFiles(request));
    const evidence = [
      ...normalizeInternshipEvidence(parseJsonField(request.body?.evidence)),
      ...uploadedEvidence
    ];
    const citations = (
      await searchKnowledge({
        query: buildInternshipReflectionSearchQuery(input),
        knowledgeBaseIds: input.knowledgeBaseIds,
        topK: 4
      })
    ).map(toStoredCitation);
    const priorTrainingLinks = buildReflectionPriorTrainingLinks();
    const draft = refineInternshipReflectionDraft({
      input,
      currentDraft,
      evidence: evidence.length ? evidence : currentDraft?.evidence || [],
      citations,
      priorTrainingLinks
    });
    const savedEvidence = draft.evidence;
    const diagnostic = diagnoseInternshipReflectionDraft(draft, citations);
    const conversationId =
      typeof request.body?.conversationId === "string"
        ? request.body.conversationId
        : randomUUID();
    const evaluation = internshipDiagnosticToEvaluation(
      conversationId,
      diagnostic,
      citations
    );

    await saveInternshipReflectionTraining({
      conversationId,
      input,
      draft,
      citations,
      evidence: savedEvidence,
      evaluation,
      action: "按建议优化实习反思"
    });

    response.status(201).json({
      conversationId,
      draft,
      diagnostic,
      citations,
      evidence: savedEvidence,
      evaluation
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "实习反思优化失败，请稍后重试。";
    response.status(400).json({ message });
  }
});

app.post("/api/internship-reflections/export", async (request, response) => {
  const draft = isRecord(request.body?.draft)
    ? (request.body.draft as InternshipReflectionDraft)
    : undefined;

  if (!draft) {
    response.status(400).json({ message: "缺少可导出的实习反思内容。" });
    return;
  }

  try {
    const [artifact] = await generateArtifacts([
      buildInternshipReflectionArtifact(draft)
    ]);
    response.status(201).json({ artifact });
  } catch {
    response.status(400).json({ message: "实习反思 Word 导出失败，请稍后重试。" });
  }
});

app.get("/api/knowledge/providers", (_request, response) => {
  response.json({ providers: knowledgeProvider.listProviderInfos() });
});

app.post("/api/knowledge/providers/ima/test", async (_request, response) => {
  const result = await knowledgeProvider.testImaConnection();
  response.status(result.ok ? 200 : 400).json({ result });
});

app.post("/api/knowledge/providers/ima/sync", async (_request, response) => {
  const result = await knowledgeProvider.syncImaBases();
  response.status(result.ok ? 200 : 400).json({ result });
});

app.get("/api/knowledge/bases", async (_request, response) => {
  response.json({ bases: await knowledgeProvider.listBases() });
});

app.get("/api/knowledge/starter-packs", (_request, response) => {
  response.json({ packs: knowledgeProvider.listStarterPacks() });
});

app.post("/api/knowledge/starter-packs/:id/import", (request, response) => {
  try {
    response.status(201).json({ base: knowledgeProvider.importStarterPack(request.params.id) });
  } catch (error) {
    const status = error instanceof KnowledgeError ? error.status : 400;
    const message = error instanceof Error ? error.message : "示例资料包导入失败。";
    response.status(status).json({ message });
  }
});

app.post("/api/knowledge/bases", (request, response) => {
  const name =
    typeof request.body?.name === "string" ? request.body.name : "默认知识库";
  response.status(201).json({ base: knowledgeProvider.createBase(name) });
});

app.patch("/api/knowledge/bases/:id", (request, response) => {
  try {
    const name = typeof request.body?.name === "string" ? request.body.name : "";
    response.json({ base: knowledgeProvider.renameBase(request.params.id, name) });
  } catch (error) {
    const status = error instanceof KnowledgeError ? error.status : 400;
    const message = error instanceof Error ? error.message : "资料库重命名失败。";
    response.status(status).json({ message });
  }
});

app.delete("/api/knowledge/bases/:id", (request, response) => {
  try {
    knowledgeProvider.deleteBase(request.params.id);
    response.status(204).end();
  } catch (error) {
    const status = error instanceof KnowledgeError ? error.status : 400;
    const message = error instanceof Error ? error.message : "资料库删除失败。";
    response.status(status).json({ message });
  }
});

app.get("/api/knowledge/bases/:id/documents", async (request, response) => {
  response.json({
    documents: await knowledgeProvider.listDocuments(request.params.id)
  });
});

app.delete("/api/knowledge/bases/:baseId/documents/:documentId", (request, response) => {
  try {
    knowledgeProvider.deleteDocument(
      request.params.baseId,
      request.params.documentId
    );
    response.status(204).end();
  } catch (error) {
    const status = error instanceof KnowledgeError ? error.status : 400;
    const message =
      error instanceof Error ? error.message : "知识库文档删除失败";
    response.status(status).json({ message });
  }
});

app.get("/api/knowledge/documents/:id/chunks", async (request, response) => {
  response.json({
    chunks: await knowledgeProvider.listDocumentChunks(request.params.id)
  });
});

app.post("/api/knowledge/bases/:id/documents", (request, response) => {
  upload.single("file")(request, response, (error) =>
    resumeAuth(authFromResponse(response), async () => {
      if (error) {
        respondToUploadError(response, error);
        return;
      }

      if (!request.file) {
        response.status(400).json({ message: "file is required" });
        return;
      }

      try {
        const document = await knowledgeProvider.addDocument(
          request.params.id,
          request.file,
          parseKnowledgeDocumentMetadata(request.body)
        );
        response.status(201).json({ document });
      } catch (knowledgeError) {
        const status =
          knowledgeError instanceof KnowledgeError ? knowledgeError.status : 400;
        const message =
          knowledgeError instanceof Error
            ? knowledgeError.message
            : "知识库文件解析失败";
        response.status(status).json({ message });
      }
    })
  );
});

app.post("/api/knowledge/search", async (request, response) => {
  const query = typeof request.body?.query === "string" ? request.body.query : "";
  const citations = await searchKnowledge({
    query,
    knowledgeBaseIds: parseStringArray(request.body?.knowledgeBaseIds),
    topK: Number(request.body?.topK || 6)
  });
  response.json({ citations });
});

app.get("/api/speak-training/config", (_request, response) => {
  response.json({
    config: {
      ...getSpeakTrainingConfig(),
      iflytekConfigured: isXfyunSpeechConfigured()
    }
  });
});

app.post("/api/speak-training/oralize-material", async (request, response) => {
  const body = request.body as {
    materialTitle?: unknown;
    materialText?: unknown;
    currentStageId?: unknown;
    currentStageName?: unknown;
    existingDraft?: unknown;
    examPaper?: unknown;
  };
  const materialText = typeof body.materialText === "string" ? body.materialText.trim() : "";
  const materialTitle =
    typeof body.materialTitle === "string" ? body.materialTitle.trim() : "参考素材";
  const currentStageName =
    typeof body.currentStageName === "string" ? body.currentStageName.trim() : "当前说课环节";
  const existingDraft =
    typeof body.existingDraft === "string" ? body.existingDraft.trim().slice(0, 1200) : "";
  const examPaper =
    body.examPaper && typeof body.examPaper === "object"
      ? (body.examPaper as {
          grade?: unknown;
          subject?: unknown;
          topic?: unknown;
          textbookHint?: unknown;
          studentHint?: unknown;
        })
      : undefined;

  if (!materialText) {
    response.status(400).json({ message: "请选择需要转化的参考素材。" });
    return;
  }

  if (!isQwenConfigured()) {
    response.status(503).json({
      message: "还没有可用的模型。请先到「设置 → 模型与密钥」里添加模型并填入自己的 API Key。"
    });
    return;
  }

  const examContext = examPaper
    ? [
        `套卷课题：${typeof examPaper.topic === "string" ? examPaper.topic : "未提供"}`,
        `学段学科：${typeof examPaper.grade === "string" ? examPaper.grade : ""}${
          typeof examPaper.subject === "string" ? examPaper.subject : ""
        }`,
        `教材提示：${typeof examPaper.textbookHint === "string" ? examPaper.textbookHint : "未提供"}`,
        `学情提示：${typeof examPaper.studentHint === "string" ? examPaper.studentHint : "未提供"}`
      ].join("\n")
    : "未选择套卷，请按当前说课环节生成通用但具体的表达。";

  try {
    const result = await streamQwenChat({
      system: [
        "你是师范生说课训练助手，负责把备课参考资料转化为考场上自然、连贯、可直接说出口的中文表达。",
        "只输出一段 80 至 180 字的第一人称说课稿，不要 Markdown、标题、序号、引号或解释。",
        "保留资料中的关键教学依据，但不要出现‘课标依据’‘教材提示’‘学情提示’等资料标签，也不要逐字复述参考资料。",
        "表达要贴合指定说课环节和套卷情境；如已有我的文稿，避免与它重复。"
      ].join("\n"),
      messages: [
        {
          role: "user",
          content: [
            `参考素材名称：${materialTitle.slice(0, 120)}`,
            `当前环节：${currentStageName.slice(0, 80)}`,
            `参考素材：${materialText.slice(0, 1800)}`,
            examContext,
            existingDraft ? `我的已有文稿：${existingDraft}` : "我的已有文稿：暂无"
          ].join("\n\n")
        }
      ],
      maxTokens: 360,
      onDelta() {},
      onThinkingDelta() {}
    });
    const oralDraft = result.visibleAssistantContent.trim();

    if (!oralDraft) {
      throw new Error("模型未返回可用的口语表达。");
    }

    response.json({ oralDraft });
  } catch (error) {
    const message =
      error instanceof UpstreamModelError
        ? "口语表达生成服务暂不可用，请稍后重试。"
        : error instanceof Error
          ? error.message
          : "口语表达生成失败，请稍后重试。";
    response.status(502).json({ message });
  }
});

app.post("/api/speak-training/turn", parseSpeakAudioUpload, async (request, response) => {
  const body = request.body as {
    conversationId?: string;
    transcript?: string;
    text?: string;
    source?: string;
    currentStageId?: string;
    knowledgeBaseIds?: unknown;
    pauseDurationMs?: string;
    durationSec?: string;
    segmentStartedAt?: string;
    reRecordOfSegmentId?: string;
    retrainTargetStageId?: string;
    retrainTitle?: string;
  };
  const transcript = String(body.transcript || body.text || "").trim();
  const audioUploaded = Boolean(request.file);
  const requestedStageId = body.currentStageId
    ? normalizeSpeakStageId(body.currentStageId)
    : undefined;
  const session = speakTrainingSessions.getOrCreate(
    body.conversationId,
    requestedStageId
  );
  const knowledgeBaseIds = parseStringArray(body.knowledgeBaseIds);

  try {
    await observeOperation(
      "speak.training.turn",
      {
        input: {
          conversationId: session.conversationId,
          transcript: summarizeText(transcript),
          source: normalizeSpeakSource(body.source, audioUploaded),
          currentStageId: requestedStageId || "完整说课",
          knowledgeBaseCount: knowledgeBaseIds.length,
          audioUploaded
        }
      },
      async (observation) => {
        const citations = transcript
          ? await searchKnowledge({
              query: transcript,
              knowledgeBaseIds,
              topK: 5
            })
          : [];
        const storedCitations = citations.map(toStoredCitation);

        const result = processSpeakTrainingTurn({
          session,
          transcript,
          source: normalizeSpeakSource(body.source, audioUploaded),
          currentStageId: requestedStageId,
          pauseDurationMs: Number(body.pauseDurationMs || 0),
          durationSec: parseOptionalNumber(body.durationSec),
          segmentStartedAt: body.segmentStartedAt,
          reRecordOfSegmentId: body.reRecordOfSegmentId,
          retrainTargetStageId: body.retrainTargetStageId
            ? normalizeSpeakStageId(body.retrainTargetStageId)
            : undefined,
          retrainTitle: body.retrainTitle,
          citations: storedCitations,
          audioUploaded
        });

        await applySpeakAiEnhancement(result, storedCitations);

        speakTrainingSessions.update(result.session);
        let saveError: string | undefined;

        try {
          await saveSpeakTrainingResult(result, knowledgeBaseIds, storedCitations);
        } catch (error) {
          saveError = error instanceof Error ? error.message : "说课训练结果保存失败。";
          console.warn(`[speak:training] save skipped: ${saveError}`);
        }

        observation.update({
          output: {
            conversationId: result.conversationId,
            currentStage: result.currentStage.name,
            roleCommentCount: result.roleComments.length,
            shouldInterrupt: result.interruption.shouldInterrupt,
            triggerType: result.interruption.triggerType,
            citationCount: citations.length,
            overallScore: result.evaluation.overallScore,
            saveError
          }
        });
        recordTrainingEvaluationScores(observation, result.evaluation);
        response.json({ ...result, saveError });
      },
      { asType: "chain" }
    );
  } catch (error) {
    console.warn("[speak:training] turn failed:", error instanceof Error ? error.message : error);
    if (!response.headersSent) {
      response.status(500).json({
        message: error instanceof Error ? error.message : "说课训练提交失败。"
      });
    }
  }
});

app.post("/api/speak-training/answer", async (request, response) => {
  const conversationId =
    typeof request.body?.conversationId === "string" ? request.body.conversationId : "";
  const questionId =
    typeof request.body?.questionId === "string" ? request.body.questionId : undefined;
  const text = typeof request.body?.text === "string" ? request.body.text : "";
  const knowledgeBaseIds = parseStringArray(request.body?.knowledgeBaseIds);

  if (!conversationId || !text.trim()) {
    response.status(400).json({ message: "缺少训练会话或答辩内容。" });
    return;
  }

  let session = speakTrainingSessions.getOrCreate(conversationId);
  session = answerPendingSpeakQuestion(session, text, questionId);
  try {
    const aiOptimization = await enhanceDefenseOptimizationWithAi({
      session,
      plan: session.defenseOptimization
    });
    if (aiOptimization) {
      session.defenseOptimization = aiOptimization;
    }
  } catch (error) {
    console.warn("[speak:ai] optimization fallback:", error instanceof Error ? error.message : error);
  }
  speakTrainingSessions.update(session);
  const answeredQuestion = questionId
    ? [...session.questions, ...session.defenseQuestions].find(
        (question) => question.id === questionId && question.status === "answered"
      )
    : [...session.questions, ...session.defenseQuestions]
        .filter((question) => question.status === "answered")
        .at(-1);
  const citations = text.trim()
    ? await searchKnowledge({
        query: text,
        knowledgeBaseIds,
        topK: 3
      })
    : [];
  const evaluation = createSpeakTrainingEvaluation({
    conversationId: session.conversationId,
    session,
    citations: citations.map(toStoredCitation)
  });

  await saveSpeakTrainingSessionOnly(session, knowledgeBaseIds, citations.map(toStoredCitation));
  response.json({
    session,
    questions: session.questions,
    defenseQuestions: session.defenseQuestions,
    answeredQuestion: answeredQuestion
      ? {
          id: answeredQuestion.id,
          roleName: answeredQuestion.roleName,
          score: answeredQuestion.score,
          feedback: answeredQuestion.feedback
        }
      : undefined,
    evaluation,
    report: session.report,
    defenseOptimization: session.defenseOptimization
  });
});

app.post("/api/speak-training/tts", async (request, response) => {
  const text = typeof request.body?.text === "string" ? request.body.text : "";
  const role =
    request.body?.role === "researcher" ||
    request.body?.role === "teacher" ||
    request.body?.role === "expert" ||
    request.body?.role === "system"
      ? request.body.role
      : "system";

  try {
    const audio = await synthesizeXfyunSpeech({ text, role });
    response.json(audio);
  } catch (error) {
    const message =
      error instanceof XfyunSpeechError || error instanceof Error
        ? error.message
        : "讯飞语音合成失败。";
    response.status(400).json({ message });
  }
});

app.post("/api/chat/stream", parseChatUpload, async (request, response) => {
  const body = request.body as ChatStreamRequest;
  const messages = normalizeMessages(body.messages);
  const enableThinking = parseBoolean(body.enableThinking);
  // 输入框里手选的知识库优先；没选时才回落到智能体自己挂的默认知识库。
  const requestedKnowledgeBaseIds = parseStringArray(body.knowledgeBaseIds);
  const requestedTrainingType = normalizeTrainingType(body.trainingType);
  const assistantMode = body.assistantMode === "office" ? "office" : "education";
  // 输入框下方选的那条模型；没选就跟随设置里的默认，解析失败时退回默认，不打断对话。
  const requestedModelId = typeof body.model === "string" ? body.model.trim() : "";
  // 自建智能体：带了 agentId 就用它的角色、提示词和模型。
  // 找不到不静默退回默认助手——用户明明选了「文献阅读」，却收到默认人格的回答，
  // 只会以为「我配的 agent 没生效」，不如直接把原因说清楚。
  const chatAgentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
  const chatAgent = chatAgentId ? platformStore.getAgent(chatAgentId) : undefined;
  if (chatAgentId && !chatAgent) {
    response.status(404).json({
      message: "找不到这个智能体，可能已被删除或不属于当前账号。请重新选一个再发。"
    });
    return;
  }
  const agentVariables = parseAgentVariables(body.variables);
  // 智能体挂的知识库等于「这个助手的资料边界」：调到它就自动带上，不必每次手动选。
  const knowledgeBaseIds =
    requestedKnowledgeBaseIds.length > 0
      ? requestedKnowledgeBaseIds
      : await resolveKnowledgeBaseIds(chatAgent?.chatConfig?.knowledgeBaseIds ?? []);
  const knowledgeBaseNames = knowledgeBaseIds.length
    ? (await knowledgeProvider.listBases())
        .filter((base) => knowledgeBaseIds.includes(base.id))
        .map((base) => base.name)
    : [];
  // 上下文轮数由智能体配置决定；没配就是默认 6 轮。裁剪放在后端，
  // 否则客户端改个请求体就能绕过，聊天迟早撞模型上下文上限。
  const modelInputMessages = chatAgent
    ? trimMessagesByTurns(messages, contextTurnsOf(chatAgent))
    : messages;
  const isKnowledgeBaseOverview = isKnowledgeBaseOverviewRequest(
    getLastUserText(messages)
  );

  if (messages.length === 0) {
    response.status(400).json({ message: "messages is required" });
    return;
  }

  await observeOperation(
    "chat.stream",
    {
      input: {
        messageCount: messages.length,
        lastUserText: summarizeText(getLastUserText(messages)),
        trainingType: requestedTrainingType,
        assistantMode,
        knowledgeBaseCount: knowledgeBaseIds.length,
        attachmentCount: getUploadedFiles(request).length
      },
      metadata: {
        enableThinking
      }
    },
    async (observation) => {
  let modelMessages: ChatMessage[];
  let citations: KnowledgeCitation[] = [];

  try {
    modelMessages = await attachUploadedFilesToMessages(
      modelInputMessages,
      getUploadedFiles(request)
    );
    if (!isKnowledgeBaseOverview) {
      citations = await searchKnowledge({
        query: getLastUserText(messages),
        knowledgeBaseIds,
        topK: 6
      });
      modelMessages = attachKnowledgeContextToMessages(modelMessages, citations);
    }
  } catch (error) {
    const status =
      error instanceof UploadPreparationError ? error.status : 400;
    const message =
      error instanceof Error ? error.message : "上传文件解析失败，请稍后重试";
    response.status(status).json({ message });
    return;
  }

  const conversationId = body.conversationId || randomUUID();
  const abortController = new AbortController();
  let assistantContent = "";
  let thinkingContent = "";
  let chatToolCalls: ChatToolTrace[] = [];
  let evaluation: TrainingEvaluation | undefined;
  let metricsSent = false;
  /** 转交的子智能体已经流式吐过正文了，主循环结尾就别再整段重发。 */
  let answerStreamed = false;
  const requestStartedAt = Date.now();
  /** 工作流首帧先给一句过程提示，进度细节只走 workflow_step / progress_note，不进正文。 */
  let narratedWorkflowIntro = false;
  /** 已经播报过的节点，避免 running→succeeded 两次都写一行。 */
  const narratedSteps = new Set<string>();
  /**
   * 过程小字：只出现在回答还没开始的时候，用来交代「现在在做什么」。
   * 前端拿它铺成一行行小字，正文一开始就折叠起来，不占正文版面。
   */
  const emitProgressNote = (text: string) => {
    const line = text.trim();
    if (!line) return;
    writeSse(response, "progress_note", { text: line });
  };
  /** 工具调用的过程小字：只说在查什么、查完没有，不复述内部端点。 */
  const emitToolNote = (progress: ChatToolProgress) => {
    if (progress.kind === "delegation") return;
    if (progress.stage === "running") {
      emitProgressNote(`在查「${progress.name}」…`);
      return;
    }
    if (progress.stage === "skipped") return;
    emitProgressNote(
      progress.ok === false
        ? `「${progress.name}」没查到，换个说法再试。`
        : `「${progress.name}」查完了，正在整理。`
    );
  };
  const emitWorkflowStep = (event: WorkflowProgressEvent) => {
    const inChild = Boolean(event.path);
    const staged =
      event.status === "running"
        ? "执行中"
        : event.status === "failed"
          ? "失败"
          : event.durationMs !== undefined
            ? `${(event.durationMs / 1000).toFixed(1)}s`
            : "完成";
    const stepText = `${inChild ? "↳ " : ""}${event.title} · ${staged}`;
    writeSse(response, "workflow_step", {
      ...event,
      stepKind: event.kind,
      stepStatus: event.status,
      stepText,
      ...(event.interaction ? { interaction: event.interaction } : {})
    });

    // 人工节点挂起：告诉用户去发言框填写，运行会在收到回答后继续。
    if (event.interaction) {
      writeSse(response, "delta", {
        content: `\n轮到你了：${event.interaction.prompt || `请填写「${event.interaction.title}」`}。在下方发言框填写后提交，我会接着往下跑。\n\n`
      });
    }

    if (event.status === "running" && !narratedWorkflowIntro) {
      narratedWorkflowIntro = true;
      emitProgressNote("先把材料过一遍，理清这次要处理什么。");
    }

    // 节点产物转成一句过程小字：等待时用户至少能看到「查到什么了」。
    if (event.status === "succeeded" && event.resultExcerpt) {
      const stepKey = `${event.workflowId}:${event.path ?? ""}:${event.nodeId}:${event.sequence}`;
      if (!narratedSteps.has(stepKey)) {
        narratedSteps.add(stepKey);
        const line = narrateNodeResult(event.nodeId, event.title, event.resultExcerpt);
        if (line) emitProgressNote(line);
      }
    }
  };

  response.on("close", () => {
    if (!response.writableEnded) {
      abortController.abort();
    }
  });

  response.writeHead(200, {
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no"
  });
  response.flushHeaders?.();

  for (const citation of citations) {
    writeSse(response, "citation", citation);
  }

  try {
    let artifactRequests: unknown[] = [];
    // 关掉逐字回复时，这一轮的文字先攒着，结束后一次性下发。
    let bufferedContent = "";

    if (isKnowledgeBaseOverview) {
      assistantContent = await buildKnowledgeBaseOverview(knowledgeBaseIds);
      writeSse(response, "delta", { content: assistantContent });
    } else {
      // 智能体的模型优先于输入框里那条：模型是智能体的一部分配置，
      // 让它被一个全局下拉随手覆盖，用户会觉得「我明明配了却不生效」。
      const picked = resolveChatModel(chatAgent?.model || requestedModelId);
      // 智能体引用的工具只认注册中心里「已启用 + 可执行」的那几条，
      // 配置里写了但工具被停用时，宁可不告诉模型有这件武器。
      const chatToolCatalog = chatAgent
        ? buildChatToolsWithDelegation({
            agent: chatAgent,
            getAgent: (id) => platformStore.getAgent(id),
            getTool: (id) => platformStore.getTool(id)
          })
        : [];
      const systemPrompt = chatAgent
        ? buildAgentChatSystemPrompt(chatAgent, {
            variables: agentVariables,
            toolNames: chatToolCatalog.map((item) => item.tool.name || item.toolId),
            knowledgeBaseNames,
            delegationTargets: chatToolCatalog
              .filter((item) => item.kind === "delegation")
              .map((item) => item.tool.name.replace(/^转交给/, ""))
          })
        : assistantMode === "office"
          ? buildOfficeAssistantSystemPrompt()
          : undefined;
      const typewriter = chatAgent?.chatConfig?.typewriter !== false;

      if (chatToolCatalog.length > 0) {
        // 挂了工具就不走流式：工具执行期间没有正文可吐，
        // 「先调完工具、再一次性给结论」比「先吐一半、回头再补」更可信。
        // 归属明确的问题（比如问文献）先做一次路由，直接交给对口专项智能体，
        // 不给模型「先反问年级专业」的机会。追问式短句（只给题量、时长、难度）自己判不出，
        // 带上上一轮助手原话补任务词，否则模型会随手挑一个专项。
        const lastUserText = getLastUserText(modelMessages);
        // 短句多半是追问（只补题量、时长、难度）。这时既要靠上一轮助手原话判归属，
        // 也要把上一轮用户原话带上，否则专项只拿到「10 道题」，连年级学科都要猜。
        const isFollowUp = lastUserText.trim().length <= 40;
        const previousUserText = isFollowUp ? getPreviousUserText(modelMessages) : "";
        const route = pickDelegationRoute(lastUserText, chatToolCatalog, {
          contextText: isFollowUp ? getPreviousAssistantText(modelMessages) : "",
          questionText: previousUserText
            ? `${previousUserText}\n\n补充：${lastUserText}`
            : lastUserText
        });
        const toolRun = await runChatToolLoop({
          system: systemPrompt,
          messages: toToolChatMessages(modelMessages),
          catalog: chatToolCatalog,
          presetToolCall: route?.call,
          // 转交成功后由专项智能体作答，主智能体不再二次改写。
          stopAfterDelegation: true,
          callTool: async (tool, args) => {
            if (isDelegationToolId(tool.id) && chatAgent) {
              const question = typeof args.question === "string" ? args.question : "";
              const targetId = delegationTargetId(tool.id);
              const target = platformStore.getAgent(targetId);
              let delegatedBadgeSent = false;
              // 转交一命中就先给一句过程反馈，别让用户盯着空白等。
              if (!narratedWorkflowIntro) {
                narratedWorkflowIntro = true;
                emitProgressNote(`交给「${target?.name ?? "专项助手"}」处理，正在整理答复。`);
              }
              return runAgentDelegation({
                host: chatAgent,
                targetId,
                question,
                getAgent: (id) => platformStore.getAgent(id),
                getTool: (id) => platformStore.getTool(id),
                callTool: (childTool, childArgs) =>
                  platformMcp.callToolRecord(childTool, childArgs, emitWorkflowStep),
                // 子智能体用自己的模型；它没配就用主持有者的模型，免得直接掉回默认。
                resolveModel: (id) => resolveChatModel(id || picked.model || ""),
                maxTokens: target?.chatConfig?.maxTokens ?? undefined,
                signal: abortController.signal,
                // 正文边生成边吐：首个子字到达时先把徽标切成子智能体，再逐段推 delta。
                // 这样正文第一个字出现时就带着正确的署名，且不再等整段写完。
                onAnswerDelta(delta) {
                  if (!delegatedBadgeSent && target) {
                    delegatedBadgeSent = true;
                    writeSse(response, "delegated", {
                      agentId: target.id,
                      agentName: target.name,
                      agentAvatar: target.avatar
                    });
                  }
                  answerStreamed = true;
                  assistantContent += delta;
                  if (typewriter) {
                    writeSse(response, "delta", { content: delta });
                  } else {
                    bufferedContent += delta;
                  }
                },
                // 子智能体调用检索工具的进度也要发到前端，否则整条链路看不到工具条。
                onProgress(progress) {
                  emitToolNote(progress);
                  writeSse(response, "tool", {
                    toolId: progress.toolId,
                    name: progress.name,
                    stage: progress.stage,
                    ok: progress.ok,
                    summary: progress.summary,
                    latencyMs: progress.latencyMs,
                    kind: progress.kind,
                    serverName: progress.serverName,
                    toolName: progress.toolName,
                    targetAgent: progress.targetAgent
                  });
                }
              });
            }
            // 知识库工具没带范围时用智能体挂的库，模型只写 query 也能查到东西。
            const toolArgs =
              tool.id === "knowledge.search" &&
              !(Array.isArray(args.knowledgeBaseIds) && (args.knowledgeBaseIds as unknown[]).length > 0)
                ? { ...args, knowledgeBaseIds }
                : args;
            return platformMcp.callToolRecord(tool, toolArgs, emitWorkflowStep);
          },
          model: picked.model,
          provider: picked.provider,
          maxTokens: chatAgent?.chatConfig?.maxTokens ?? undefined,
          temperature: chatAgent?.chatConfig?.temperature ?? undefined,
          signal: abortController.signal,
          onProgress(progress) {
            emitToolNote(progress);
            writeSse(response, "tool", {
              toolId: progress.toolId,
              name: progress.name,
              stage: progress.stage,
              ok: progress.ok,
              summary: progress.summary,
              latencyMs: progress.latencyMs,
              kind: progress.kind,
              serverName: progress.serverName,
              toolName: progress.toolName,
              targetAgent: progress.targetAgent
            });
          }
        });
        chatToolCalls = toolRun.calls;
        if (toolRun.delegatedAnswer) {
          // 正文用专项智能体的原话，徽标也换成它：学生问文献，看到的就是文献阅读Agent的答复。
          if (answerStreamed) {
            // 子智能体已经逐段流式吐过正文、徽标也在首字时切好了，这里只补全存档用的完整文本。
            // 注意别覆盖：回调里累加的 assistantContent 就是原文，delegatedAnswer.answer 是截断后的同一份。
            assistantContent = assistantContent || toolRun.delegatedAnswer.answer;
          } else {
            assistantContent = toolRun.delegatedAnswer.answer;
            writeSse(response, "delegated", {
              agentId: toolRun.delegatedAnswer.agentId,
              agentName: toolRun.delegatedAnswer.agentName,
              agentAvatar: toolRun.delegatedAnswer.avatar
            });
          }
        } else {
          assistantContent = toolRun.content;
        }
        // 流式已经逐段发过就不再整段重发，否则正文会显示两遍。
        // 关掉逐字回复时，流式那段只是攒在 bufferedContent 里，这里要补一次下发。
        if (!answerStreamed) {
          writeSse(response, "delta", { content: bufferedContent || assistantContent });
        } else if (bufferedContent) {
          writeSse(response, "delta", { content: bufferedContent });
        }
        bufferedContent = "";
      } else {
        // 智能体真的一个工具都没配、用户却在要文献/数据时，先说清楚「本轮不会调用插件」，
        // 否则模型会顺着提示词演一句「我为你启动 XX Agent」，再凭记忆编一串带 DOI 的文献。
        // 配了工具但目标不可用（比如子 Agent 被停用）不算这一种，别误报「未绑定」。
        if (chatAgent && chatAgent.tools.length === 0) {
          const lastUser = [...modelMessages].reverse().find((message) => message.role === "user");
          const lastText = lastUser && typeof lastUser.content === "string" ? lastUser.content : "";
          if (needsExternalEvidence(lastText)) {
            writeSse(response, "tool", {
              toolId: "no-tool-bound",
              name: "未配置检索工具",
              stage: "skipped",
              summary:
                "这个智能体没有可用的检索或数据工具，本轮回答不是查出来的；需要真实文献请换到绑了检索工具的智能体。"
            });
          }
        }
        const streamResult = await streamQwenChat({
          system: systemPrompt,
          messages: modelMessages,
          model: picked.model,
          provider: picked.provider,
          enableThinking,
          maxTokens: chatAgent?.chatConfig?.maxTokens ?? undefined,
          temperature: chatAgent?.chatConfig?.temperature ?? undefined,
          signal: abortController.signal,
          onDelta(content) {
            if (!metricsSent) {
              metricsSent = true;
              if (enableThinking) {
                writeSse(response, "metrics", {
                  thinkingSeconds: roundSeconds(Date.now() - requestStartedAt)
                });
              }
            }

            assistantContent += content;
            if (typewriter) {
              writeSse(response, "delta", { content });
            } else {
              bufferedContent += content;
            }
          },
          onThinkingDelta(content) {
            if (!enableThinking) {
              return;
            }

            thinkingContent += content;
            writeSse(response, "thinking_delta", { content });
          }
        });
        artifactRequests = streamResult.artifactRequests;
      }
    }
    // 关掉逐字时这里才把整段文字送出去；开着的走上面的增量，不必重复发。
    if (bufferedContent) {
      writeSse(response, "delta", { content: bufferedContent });
    }
    const artifacts = await generateArtifacts(
      coerceArtifactRequests(artifactRequests)
    );

    for (const artifact of artifacts) {
      writeSse(response, "artifact", artifact);
    }

    const storedMessages: StoredChatMessage[] = [
      ...messages.map((message) => ({
        role: message.role,
        content: contentToStoredString(message.content)
      })),
      {
        role: "assistant",
        content: assistantContent,
        // 留痕：重开这段会话时，气泡上方还能看到「查了哪些工具」。
        // 转交记录也在里面（toolId 是 agent://xxx），前端据此把署名还给专项智能体。
        ...(chatToolCalls.length > 0
          ? {
              toolNotes: chatToolCalls.map((call) => ({
                toolId: call.toolId,
                name: call.name,
                ok: call.ok,
                latencyMs: call.latencyMs,
                summary: call.summary,
                kind: call.kind,
                serverName: call.serverName,
                toolName: call.toolName
              }))
            }
          : {})
      }
    ];

    // 智能体对话按「通用对话」存档：它没有教学培训的评分口径，
    // 走教案/说课那条分支会硬算出一份没有意义的评价。
    if (assistantMode === "office" || chatAgent) {
      await chatRepository.saveConversation({
        conversationId,
        title: buildConversationTitle(storedMessages),
        trainingType: "通用对话",
        assistantMode: assistantMode === "office" ? "office" : "education",
        agentId: chatAgent?.id,
        messages: storedMessages,
        knowledgeBaseIds,
        attachmentNames: getUploadedFiles(request).map((file) => file.originalname),
        artifacts: artifacts.map(toStoredArtifact),
        citations: citations.map(toStoredCitation)
      });
      observation.update({
        output: {
          conversationId,
          assistantMode,
          agentId: chatAgent?.id,
          contextTurns: chatAgent ? contextTurnsOf(chatAgent) : undefined,
          contextMessageCount: modelMessages.length,
          toolCallCount: chatToolCalls.length,
          toolNames: chatToolCalls.map((call) => call.name),
          citationCount: citations.length,
          artifactCount: artifacts.length,
          assistantCharacterCount: assistantContent.length,
          thinkingCharacterCount: thinkingContent.length
        }
      });
      writeSse(response, "done", {
        conversationId,
        agentId: chatAgent?.id,
        thinkingText: enableThinking ? thinkingContent || undefined : undefined
      });
      return;
    }

    const trainingType =
      requestedTrainingType ||
      inferTrainingType(storedMessages.map((message) => message.content).join("\n"));

    await chatRepository.saveConversation({
      conversationId,
      title: buildConversationTitle(storedMessages),
      trainingType,
      messages: storedMessages,
      knowledgeBaseIds,
      attachmentNames: getUploadedFiles(request).map((file) => file.originalname),
      artifacts: artifacts.map(toStoredArtifact),
      citations: citations.map(toStoredCitation)
    });
    evaluation = createTrainingEvaluation({
      conversationId,
      trainingType,
      messages: storedMessages,
      citations: citations.map(toStoredCitation)
    });
    await chatRepository.saveEvaluation(evaluation);
    observation.update({
      output: {
        conversationId,
        trainingType,
        citationCount: citations.length,
        artifactCount: artifacts.length,
        assistantCharacterCount: assistantContent.length,
        thinkingCharacterCount: thinkingContent.length,
        overallScore: evaluation.overallScore
      }
    });
    recordTrainingEvaluationScores(observation, evaluation);
    writeSse(response, "evaluation", evaluation);
    writeSse(response, "done", {
      conversationId,
      evaluation,
      thinkingText: enableThinking ? thinkingContent || undefined : undefined
    });
  } catch (error) {
    if (abortController.signal.aborted) {
      return;
    }

    const message =
      error instanceof UpstreamModelError && error.status === undefined
        ? error.message
        : "模型服务暂时不可用，请稍后重试";
    observation.update({
      level: "ERROR",
      statusMessage: message,
      output: {
        error: error instanceof Error ? error.message : String(error)
      }
    });
    writeSse(response, "error", { message });
  } finally {
    response.end();
  }
    },
    { asType: "chain" }
  );
});

const speakRealtimeServer = new WebSocketServer({
  noServer: true
});

httpServer.on("upgrade", (request, socket, head) => {
  const pathname = request.url?.split("?")[0];
  const target = pathname === "/api/speak-training/realtime"
    ? speakRealtimeServer
    : pathname === "/api/counseling/realtime"
      ? counseling.realtime
      : undefined;

  if (!target) {
    socket.destroy();
    return;
  }

  // upgrade 不走 Express 中间件，这里是实时语音通道唯一的鉴权口子。
  const context = resolveRequestAuth(request, authStore);
  if (!context) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  runWithAuth(context, () => {
    target.handleUpgrade(request, socket, head, (connection) => {
      // 连接回调及其注册的消息监听器都要留在同一身份里，
      // 否则后续写会话快照会掉回「无身份」而绕过归属过滤。
      runWithAuth(context, () => target.emit("connection", connection, request));
    });
  });
});

speakRealtimeServer.on("connection", (socket) => {
  // 同谈心谈话：ws 的消息与关闭回调都拿不到 upgrade 时的身份，显式包一层。
  const wrap = bindConnectionAuth();
  let session = speakTrainingSessions.getOrCreate();
  let knowledgeBaseIds: string[] = [];
  let lastCitations: StoredCitation[] = [];
  let xfyunIat: XfyunIatStream | undefined;
  let xfyunBuffer = "";
  let receivedAudioFrameCount = 0;

  async function handleRealtimeTranscript(
    text: string,
    pauseDurationMs?: number,
    durationSec?: number
  ) {
    const trimmedText = text.trim();

    if (!trimmedText) {
      return;
    }

    const latestSegment = session.segments.at(-1);
    const isDuplicateTranscript =
      latestSegment &&
      normalizeRealtimeTranscript(latestSegment.text) ===
        normalizeRealtimeTranscript(trimmedText) &&
      Date.now() - new Date(latestSegment.endedAt).getTime() < 10000;

    if (isDuplicateTranscript) {
      return;
    }

    await observeOperation(
      "speak.training.realtime_turn",
      {
        input: {
          conversationId: session.conversationId,
          transcript: summarizeText(trimmedText),
          pauseDurationMs,
          knowledgeBaseCount: knowledgeBaseIds.length
        }
      },
      async (observation) => {
        sendSpeakRealtimeEvent(socket, { type: "transcript_delta", text: trimmedText });

        const citations = await searchKnowledge({
          query: trimmedText,
          knowledgeBaseIds,
          topK: 5
        });
        lastCitations = citations.map(toStoredCitation);
        const result = processSpeakTrainingTurn({
          session,
          transcript: trimmedText,
          source: "realtime",
          pauseDurationMs,
          durationSec,
          citations: lastCitations
        });
        await applySpeakAiEnhancement(result, lastCitations);
        session = speakTrainingSessions.update(result.session);
        sendSpeakRealtimeEvent(socket, { type: "session", session });
        sendSpeakRealtimeEvent(socket, {
          type: "stage_update",
          currentStage: result.currentStage,
          stageProgress: result.stageProgress,
          report: result.report
        });
        sendSpeakRealtimeEvent(socket, {
          type: "interruption_candidate",
          interruption: result.interruption
        });

        if (result.interruption.shouldInterrupt) {
          const question = result.questions.at(-1);
          sendSpeakRealtimeEvent(socket, {
            type: "interrupt",
            interruption: result.interruption
          });

          if (question) {
            sendSpeakRealtimeEvent(socket, {
              type: "role_question",
              question
            });
          }
        }

        for (const item of result.tts) {
          sendSpeakRealtimeEvent(socket, {
            type: "tts_instruction",
            role: item.role,
            voiceStyle: item.voiceStyle,
            text: item.text
          });
        }

        sendSpeakRealtimeEvent(socket, {
          type: "final_evaluation",
          evaluation: result.evaluation,
          report: result.report
        });
        await saveSpeakTrainingResult(result, knowledgeBaseIds, lastCitations);
        observation.update({
          output: {
            conversationId: result.conversationId,
            currentStage: result.currentStage.name,
            shouldInterrupt: result.interruption.shouldInterrupt,
            triggerType: result.interruption.triggerType,
            citationCount: citations.length,
            overallScore: result.evaluation.overallScore
          }
        });
        recordTrainingEvaluationScores(observation, result.evaluation);
      },
      { asType: "chain" }
    );
  }

  function getOrCreateXfyunIat() {
    if (xfyunIat) {
      return xfyunIat;
    }

    const config = getXfyunSpeechConfig();

    if (!config) {
      throw new XfyunSpeechError("讯飞实时听写未配置，请补充 AppID、APIKey 和 APISecret。");
    }

    xfyunIat = new XfyunIatStream(config, {
      onTranscript(text, isFinal) {
        xfyunBuffer += text;
        sendSpeakRealtimeEvent(socket, {
          type: "asr_delta",
          text,
          final: isFinal,
          provider: "iflytek"
        });

        if (isFinal || /[。！？；]$/.test(xfyunBuffer)) {
          const transcript = xfyunBuffer;
          xfyunBuffer = "";
          void handleRealtimeTranscript(transcript);
        }

        if (isFinal) {
          xfyunIat = undefined;
        }
      },
      onError(message) {
        sendSpeakRealtimeEvent(socket, { type: "error", message });
      }
    });
    console.info("[speak:realtime] xfyun iat stream created");
    return xfyunIat;
  }

  sendSpeakRealtimeEvent(socket, { type: "session", session });

  socket.on("message", (rawMessage) => wrap(async () => {
    try {
      const event = JSON.parse(String(rawMessage)) as SpeakRealtimeClientEvent & {
        knowledgeBaseIds?: unknown;
      };

      if (event.type === "start") {
        session = speakTrainingSessions.getOrCreate(
          event.conversationId,
          normalizeSpeakStageId(event.currentStageId)
        );
        knowledgeBaseIds = parseStringArray(event.knowledgeBaseIds);
        sendSpeakRealtimeEvent(socket, { type: "session", session });
        return;
      }

      if (event.type === "user_response") {
        session = answerPendingSpeakQuestion(session, event.text, event.questionId);
        speakTrainingSessions.update(session);
        sendSpeakRealtimeEvent(socket, { type: "session", session });
        await saveSpeakTrainingSessionOnly(session, knowledgeBaseIds, lastCitations);
        return;
      }

      if (event.type === "transcript_delta") {
        const text = event.text.trim();

        if (!text) {
          return;
        }

        if (!event.final && !event.pauseDurationMs) {
          sendSpeakRealtimeEvent(socket, { type: "transcript_delta", text });
          return;
        }

        await handleRealtimeTranscript(text, event.pauseDurationMs, event.durationSec);
        return;
      }

      if (event.type === "audio_frame") {
        if (getSpeakTrainingConfig().asrProvider !== "iflytek") {
          sendSpeakRealtimeEvent(socket, {
            type: "error",
            message: "当前未启用讯飞实时听写，请设置 SPEAK_ASR_PROVIDER=iflytek。"
          });
          return;
        }

        receivedAudioFrameCount += 1;

        if (receivedAudioFrameCount === 1 || receivedAudioFrameCount % 50 === 0) {
          console.info(
            `[speak:realtime] received audio frames=${receivedAudioFrameCount}`
          );
        }

        await getOrCreateXfyunIat().sendAudioFrame(event.audio);
        return;
      }

      if (event.type === "audio_end") {
        console.info(
          `[speak:realtime] audio_end received frames=${receivedAudioFrameCount}`
        );

        if (!xfyunIat) {
          sendSpeakRealtimeEvent(socket, {
            type: "error",
            message: "没有收到可识别的音频帧，请确认麦克风权限已允许，并重新录制。"
          });
          return;
        }

        const segmentCountBeforeFinish = session.segments.length;
        await xfyunIat?.finish();
        xfyunIat = undefined;

        if (xfyunBuffer.trim()) {
          const transcript = xfyunBuffer;
          xfyunBuffer = "";
          await handleRealtimeTranscript(transcript, 2600);
          return;
        }

        if (session.segments.length === segmentCountBeforeFinish) {
          sendSpeakRealtimeEvent(socket, {
            type: "error",
            message: "讯飞没有返回识别文本。请说满 3 秒以上，确认麦克风音量条有输入后再结束。"
          });
        }

        return;
      }

      if (event.type === "pause") {
        const lastSegment = session.segments.at(-1);

        if (!lastSegment) {
          return;
        }

        const result = processSpeakTrainingTurn({
          session,
          transcript: lastSegment.text,
          source: "realtime",
          pauseDurationMs: event.durationMs,
          durationSec: Math.round(event.durationMs / 1000),
          citations: lastCitations
        });
        session = speakTrainingSessions.update(result.session);
        sendSpeakRealtimeEvent(socket, {
          type: "interruption_candidate",
          interruption: result.interruption
        });
        await saveSpeakTrainingResult(result, knowledgeBaseIds, lastCitations);
        return;
      }

      if (event.type === "finish") {
        await saveSpeakTrainingSessionOnly(session, knowledgeBaseIds, lastCitations);
        const evaluation = createSpeakTrainingEvaluation({
          conversationId: session.conversationId,
          session,
          citations: lastCitations
        });
        sendSpeakRealtimeEvent(socket, {
          type: "final_evaluation",
          evaluation,
          report: session.report
        });
        socket.close(1000, "finished");
      }
    } catch (error) {
      sendSpeakRealtimeEvent(socket, {
        type: "error",
        message: error instanceof Error ? error.message : "实时说课事件处理失败。"
      });
    }
  }));

  socket.on("close", () => wrap(() => {
    xfyunIat?.close();
    void wrap(() => saveSpeakTrainingSessionOnly(session, knowledgeBaseIds, lastCitations));
  }));
});

httpServer.listen(port, host, () => {
  console.log(`AI chat server listening on http://${host}:${port}`);
});

function parseSpeakAudioUpload(
  request: express.Request,
  response: express.Response,
  next: express.NextFunction
) {
  if (!request.is("multipart/form-data")) {
    next();
    return;
  }

  upload.single("audio")(request, response, (error) => {
    resumeAuth(authFromResponse(response), () => {
      if (!error) {
        next();
        return;
      }

      if (error instanceof multer.MulterError) {
        respondToUploadError(response, error);
        return;
      }

      response.status(400).json({ message: "说课音频解析失败，请稍后重试" });
    });
  });
}

async function saveSpeakTrainingResult(
  result: SpeakTrainingTurnResult,
  knowledgeBaseIds: string[],
  citations: StoredCitation[]
) {
  const assistantContent = renderSpeakTrainingAssistantMessage(result);
  const messages = [
    ...buildSpeakConversationMessages(result.session),
    {
      role: "assistant" as const,
      content: assistantContent
    }
  ];

  await chatRepository.saveConversation({
    conversationId: result.conversationId,
    title: buildSpeakConversationTitle(result.session.segments[0]?.text),
    trainingType: "说课陪练",
    messages,
    knowledgeBaseIds,
    attachmentNames: [],
    artifacts: [],
    citations
  });
  await chatRepository.saveSpeakTrainingSession(
    result.conversationId,
    buildSpeakSessionSnapshot(result.session)
  );
  await chatRepository.saveEvaluation(result.evaluation);
}

async function applySpeakAiEnhancement(
  result: SpeakTrainingTurnResult,
  citations: StoredCitation[]
) {
  try {
    const enhancement = await generateSpeakAiEnhancement({
      session: result.session,
      report: result.report,
      citations
    });

    if (!enhancement) {
      return;
    }

    const answeredAiQuestions = result.session.defenseQuestions.filter(
      (question) => question.source === "ai" && question.status === "answered"
    );
    result.session.defenseQuestions = [
      ...answeredAiQuestions,
      ...enhancement.questions
    ].slice(0, 3);
    result.session.aiFocusHints = enhancement.focusHints;
    result.defenseQuestions = result.session.defenseQuestions;
  } catch (error) {
    console.warn("[speak:ai] question fallback:", error instanceof Error ? error.message : error);
  }
}

async function saveClassroomTrainingResult(
  state: ClassroomState,
  report: ClassroomReport,
  citations: StoredCitation[]
) {
  const conversationId = state.savedConversationId || `classroom_${randomUUID()}`;
  let artifacts: StoredArtifact[] = [];
  const messages: StoredChatMessage[] = [
    {
      role: "user",
      content: `虚拟课堂配置：${state.grade}${state.subject}《${state.topic}》，${state.classType}，训练目标：${state.trainingGoal}，难度：${state.difficulty}，专项：${state.specialTrainingMode || "综合训练"}。`
    },
    ...state.timeline.map((item) => ({
      role: item.role === "teacher" ? ("user" as const) : ("assistant" as const),
      content: `${item.speaker}：${item.content}`
    })),
    {
      role: "assistant",
      content: renderClassroomReportText(report)
    }
  ];
  const evaluation: TrainingEvaluation = {
    id: `eval_${randomUUID()}`,
    conversationId,
    trainingType: "模拟课堂",
    overallScore: report.overallScore,
    dimensions: report.dimensionScores,
    diagnosis: report.issues,
    suggestions: report.suggestions,
    nextTask: report.nextTrainingTask,
    citations,
    createdAt: new Date(report.generatedAt).toISOString()
  };

  try {
    const generatedArtifacts = await generateArtifacts([
      buildClassroomReportArtifact(state, report)
    ]);
    artifacts = generatedArtifacts.map(toStoredArtifact);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown classroom report export error";
    console.warn(`Classroom report artifact skipped: ${message}`);
  }

  await chatRepository.saveConversation({
    conversationId,
    title: buildClassroomConversationTitle(state),
    trainingType: "模拟课堂",
    messages,
    knowledgeBaseIds: state.knowledgeBaseIds || [],
    attachmentNames: [],
    artifacts,
    citations
  });
  await chatRepository.saveEvaluation(evaluation);

  return {
    conversationId,
    artifact: artifacts[0]
  };
}

function buildClassroomReportArtifact(
  state: ClassroomState,
  report: ClassroomReport
): ArtifactRequest {
  return {
    name: `${state.subject}-${state.topic}-模拟课堂诊断报告.docx`,
    type: "docx",
    title: `${state.grade}${state.subject}《${state.topic}》模拟课堂诊断报告`,
    content: [
      `课堂类型：${state.classType}`,
      `训练目标：${state.trainingGoal}`,
      `专项模式：${state.specialTrainingMode || "综合训练"}`,
      `总分：${report.overallScore}`,
      `生成方式：${report.providerMode === "llm" ? "LLM 增强诊断" : "规则增强诊断"}`
    ].join("\n"),
    sections: [
      {
        heading: "一、课堂报告摘要",
        body: report.summary
      },
      {
        heading: "二、能力维度评分",
        bullets: report.dimensionScores.map(
          (dimension) => `${dimension.name} ${dimension.score}分：${dimension.comment}`
        )
      },
      {
        heading: "三、课堂事件复盘",
        bullets: report.eventReview.length
          ? report.eventReview.map(
              (event) =>
                `${event.type}：${event.description}；${event.handled ? "已处理" : "待改进"}；${event.comment}`
            )
          : ["本轮未触发明显突发事件。"]
      },
      {
        heading: "四、课堂证据链",
        bullets: report.evidenceChains.map(
          (chain) =>
            `${chain.studentAgent}：教师行为“${chain.teacherMove}”；学生反应“${chain.studentResponse}”；证据：${chain.eventOrMetric}；建议：${chain.observerAdvice}`
        )
      },
      {
        heading: "五、Agent 决策依据",
        bullets: report.agentDecisionEvidence.map(
          (item) => `${item.agentName}：${item.decision}；依据：${item.basis}；影响：${item.impact}`
        )
      },
      {
        heading: "六、优势与问题",
        bullets: [
          ...report.strengths.map((item) => `优势：${item}`),
          ...report.issues.map((item) => `问题：${item}`)
        ]
      },
      {
        heading: "七、改进建议与下一轮任务",
        bullets: [...report.suggestions, `下一轮任务：${report.nextTrainingTask}`]
      }
    ]
  };
}

function renderClassroomReportText(report: ClassroomReport) {
  return [
    `总体评分：${report.overallScore}`,
    report.summary,
    `维度评分：${report.dimensionScores
      .map((dimension) => `${dimension.name}${dimension.score}分：${dimension.comment}`)
      .join("；")}`,
    `事件复盘：${
      report.eventReview.length
        ? report.eventReview
            .map(
              (event) =>
                `${event.description}（${event.handled ? "已处理" : "待处理"}）：${event.comment}`
            )
            .join("；")
        : "本轮未触发明显课堂事件。"
    }`,
    `Agent协作：${report.agentCollaboration.map((step) => `${step.agentName}：${step.output}`).join("；")}`,
    `证据链：${report.evidenceChains
      .map(
        (chain, index) =>
          `${index + 1}. 教师行为“${chain.teacherMove}” -> ${chain.studentAgent}：“${chain.studentResponse}” -> ${chain.eventOrMetric} -> ${chain.observerAdvice}`
      )
      .join("；")}`,
    `决策证据：${report.agentDecisionEvidence.map((item) => `${item.agentName}：${item.decision}；依据：${item.basis}；影响：${item.impact}`).join("；")}`,
    `优点：${report.strengths.join("；")}`,
    `问题：${report.issues.join("；")}`,
    `建议：${report.suggestions.join("；")}`,
    `下一轮任务：${report.nextTrainingTask}`
  ].join("\n");
}

function buildClassroomConversationTitle(state: ClassroomState) {
  const title = `虚拟课堂：${state.grade}${state.subject}《${state.topic}》`;
  return title.length > 28 ? `${title.slice(0, 28)}...` : title;
}

function normalizeClassroomActionType(value: unknown): ClassroomActionType {
  const actionTypes: ClassroomActionType[] = [
    "call_on_student",
    "follow_up_student",
    "start_group_activity",
    "pause_and_manage",
    "compress_summary"
  ];

  return actionTypes.includes(value as ClassroomActionType)
    ? (value as ClassroomActionType)
    : "call_on_student";
}

async function saveSpeakTrainingSessionOnly(
  session: SpeakTrainingTurnResult["session"],
  knowledgeBaseIds: string[],
  citations: StoredCitation[]
) {
  if (session.segments.length === 0) {
    return;
  }

  const evaluation = createSpeakTrainingEvaluation({
    conversationId: session.conversationId,
    session,
    citations
  });
  const messages = buildSpeakConversationMessages(session);

  await chatRepository.saveConversation({
    conversationId: session.conversationId,
    title: buildSpeakConversationTitle(session.segments[0]?.text),
    trainingType: "说课陪练",
    messages,
    knowledgeBaseIds,
    attachmentNames: [],
    artifacts: [],
    citations
  });
  await chatRepository.saveSpeakTrainingSession(
    session.conversationId,
    buildSpeakSessionSnapshot(session)
  );
  await chatRepository.saveEvaluation(evaluation);
}

function buildSpeakConversationTitle(text?: string) {
  const compact = (text || "说课训练").replace(/\s+/g, " ").trim();
  return compact.length > 24 ? `${compact.slice(0, 24)}...` : compact;
}

function normalizeSpeakStageId(value: unknown): SpeakStageId | undefined {
  const stageIds: SpeakStageId[] = [
    "textbook",
    "student",
    "objective",
    "keyPoint",
    "method",
    "process",
    "activity",
    "assessment",
    "reflection"
  ];

  return stageIds.includes(value as SpeakStageId)
    ? (value as SpeakStageId)
    : undefined;
}

function normalizeRealtimeTranscript(text: string) {
  return text.replace(/\s+/g, "").replace(/[，。！？、；：,.!?;:]/g, "");
}

function normalizeSpeakSource(
  value: unknown,
  audioUploaded: boolean
): SpeakTrainingTurnResult["session"]["segments"][number]["source"] {
  if (
    value === "text" ||
    value === "browser_asr" ||
    value === "audio_upload" ||
    value === "realtime"
  ) {
    return value;
  }

  return audioUploaded ? "audio_upload" : "text";
}

function sendSpeakRealtimeEvent(
  socket: WebSocket,
  event: SpeakRealtimeServerEvent
) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(event));
  }
}

function parseChatUpload(
  request: express.Request,
  response: express.Response,
  next: express.NextFunction
) {
  if (!request.is("multipart/form-data")) {
    next();
    return;
  }

  upload.array("files", maxUploadCount)(request, response, (error) => {
    resumeAuth(authFromResponse(response), () => {
      if (!error) {
        next();
        return;
      }

      if (error instanceof multer.MulterError) {
        respondToUploadError(response, error);
        return;
      }

      response.status(400).json({ message: "上传文件解析失败，请稍后重试" });
    });
  });
}

function parseReflectionUpload(
  request: express.Request,
  response: express.Response,
  next: express.NextFunction
) {
  if (!request.is("multipart/form-data")) {
    next();
    return;
  }

  upload.array("files", maxUploadCount)(request, response, (error) => {
    resumeAuth(authFromResponse(response), () => {
      if (!error) {
        next();
        return;
      }

      if (error instanceof multer.MulterError) {
        respondToUploadError(response, error);
        return;
      }

      response.status(400).json({ message: "实习证据材料上传失败，请稍后重试。" });
    });
  });
}

function respondToUploadError(response: express.Response, error: unknown) {
  if (error instanceof multer.MulterError) {
    const isTooLarge = error.code === "LIMIT_FILE_SIZE";
    response.status(isTooLarge ? 413 : 400).json({
      message: isTooLarge
        ? `文件大小不能超过 ${formatFileSize(maxUploadTotalBytes)}。`
        : `最多一次上传 ${maxUploadCount} 个文件。`
    });
    return;
  }

  response.status(400).json({ message: "上传文件解析失败，请稍后重试" });
}

/**
 * 把界面上选的模型 id 解析成上游调用参数。
 * 解析不出来（还没配模型、id 被删）就返回空，让客户端回落到环境变量，对话不因此中断。
 */
function resolveChatModel(id: string): {
  model?: string;
  provider?: { baseUrl: string; apiKey: string; label?: string };
} {
  if (!id) {
    return {};
  }
  try {
    const resolution = resolveModel(id, { source: "default", allowRaw: false });
    if (!resolution.baseUrl || !resolution.apiKey) {
      return {};
    }
    return {
      model: resolution.model,
      provider: { baseUrl: resolution.baseUrl, apiKey: resolution.apiKey, label: resolution.label }
    };
  } catch {
    return {};
  }
}

/** 会话里填的变量值；只收能写进提示词的纯文本，长度截断防止塞爆上下文。 */
function parseAgentVariables(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const variables: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    // 变量名允许中英文，与 agentChat 里的校验保持一致。
    if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(key) || typeof item !== "string") {
      continue;
    }
    variables[key] = item.trim().slice(0, 500);
  }
  return variables;
}

function normalizeMessages(messages: ChatStreamRequest["messages"]): ChatMessage[] {  const values = parseMessages(messages);

  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .filter(
      (message): message is { role: "user" | "assistant"; content: string } =>
        isRecord(message) &&
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string"
    )
    .map((message) => ({
      role: message.role,
      content: message.content
    }));
}

function parseMessages(messages: unknown) {
  if (typeof messages !== "string") {
    return messages;
  }

  try {
    return JSON.parse(messages) as unknown;
  } catch {
    return undefined;
  }
}

function parseJsonField(value: unknown) {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function parseBoolean(value: ChatStreamRequest["enableThinking"]) {
  return value === true || value === "true";
}

function parseStringArray(value: unknown) {
  if (typeof value === "string") {
    try {
      return parseStringArray(JSON.parse(value) as unknown);
    } catch {
      return value ? [value] : [];
    }
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function parseKnowledgeDocumentMetadata(value: unknown): KnowledgeDocumentMetadata {
  const body = isRecord(value) ? value : {};
  const resourceType =
    typeof body.resourceType === "string" ? body.resourceType : undefined;
  const subject = typeof body.subject === "string" ? body.subject : undefined;
  const schoolStage =
    typeof body.schoolStage === "string" ? body.schoolStage : undefined;

  return {
    resourceType: resourceType as KnowledgeDocumentMetadata["resourceType"],
    subject,
    schoolStage,
    tags: parseStringArray(body.tags)
  };
}

function parseOptionalNumber(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : undefined;
}

function getUploadedFiles(request: express.Request) {
  const files = request.files;

  if (!files) {
    return [];
  }

  if (Array.isArray(files)) {
    return files;
  }

  return Object.values(files).flat();
}

async function summarizeInternshipEvidence(files: Express.Multer.File[]) {
  if (files.length === 0) {
    return [];
  }

  validateUploadedFiles(files);

  const evidence: InternshipEvidenceItem[] = [];

  for (const [index, file] of files.entries()) {
    const extension = getFileExtension(file.originalname);
    const imageMediaType = supportedImageTypes.get(extension);
    const id = `evidence_${randomUUID()}`;

    if (imageMediaType) {
      evidence.push({
        id,
        name: file.originalname,
        type: "image",
        summary:
          "已上传课堂图片证据，可用于观察板书呈现、课堂活动、学生作品或听课记录中的教学线索。",
        observationPoints: [
          "提取图片中的课堂情境和教学材料信息",
          "结合反思文本判断可改进的教学行为",
          "建议对包含学生正脸或个人信息的图片进行脱敏后归档"
        ],
        privacyNote: "若图片包含学生正脸、姓名或学号，建议脱敏后再长期保存。"
      });
      continue;
    }

    const text =
      extension === "pdf"
        ? await extractPdfText(file)
        : file.buffer.toString("utf8");
    const normalized = text.replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
    const summary = normalized
      ? normalized.slice(0, 180)
      : "该材料未提取到可读文本，可作为课堂证据附件记录。";

    evidence.push({
      id,
      name: file.originalname,
      type: extension === "pdf" ? "document" : "text",
      summary,
      observationPoints: [
        `材料${index + 1}可作为课堂观察和课后反思依据`,
        "从材料中提取问题现象、学生反应或教学改进线索"
      ]
    });
  }

  return evidence;
}

async function attachUploadedFilesToMessages(
  messages: ChatMessage[],
  files: Express.Multer.File[]
) {
  if (files.length === 0) {
    return messages;
  }

  validateUploadedFiles(files);

  const lastUserIndex = findLastUserMessageIndex(messages);

  if (lastUserIndex < 0) {
    throw new UploadPreparationError("上传文件需要和用户消息一起发送。", 400);
  }

  const currentUserMessage = messages[lastUserIndex];
  const contentBlocks: Array<TextContentBlock | ImageContentBlock> = [
    {
      type: "text",
      text:
        typeof currentUserMessage.content === "string" &&
        currentUserMessage.content.trim()
          ? currentUserMessage.content
          : "请分析我上传的文件。"
    }
  ];

  for (const file of files) {
    contentBlocks.push(...(await fileToContentBlocks(file)));
  }

  return messages.map((message, index) =>
    index === lastUserIndex ? { ...message, content: contentBlocks } : message
  );
}

function validateUploadedFiles(files: Express.Multer.File[]) {
  if (files.length > maxUploadCount) {
    throw new UploadPreparationError(`最多一次上传 ${maxUploadCount} 个文件。`, 400);
  }

  const totalSize = files.reduce((total, file) => total + file.size, 0);

  if (totalSize > maxUploadTotalBytes) {
    throw new UploadPreparationError(
      `附件总大小不能超过 ${formatFileSize(maxUploadTotalBytes)}。`,
      413
    );
  }

  for (const file of files) {
    const extension = getFileExtension(file.originalname);

    if (
      !supportedImageTypes.has(extension) &&
      extension !== "pdf" &&
      !supportedTextExtensions.has(extension)
    ) {
      throw new UploadPreparationError(
        `暂不支持 ${file.originalname}，请上传图片、PDF、TXT、MD、CSV 或 JSON。`,
        415
      );
    }
  }
}

async function fileToContentBlocks(file: Express.Multer.File) {
  const extension = getFileExtension(file.originalname);
  const imageMediaType = supportedImageTypes.get(extension);

  if (imageMediaType) {
    return [
      {
        type: "text" as const,
        text: `\n\n[上传图片：${file.originalname}]`
      },
      {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: imageMediaType,
          data: file.buffer.toString("base64")
        }
      }
    ];
  }

  const text =
    extension === "pdf"
      ? await extractPdfText(file)
      : file.buffer.toString("utf8");

  return [
    {
      type: "text" as const,
      text: formatUploadedTextContent(file.originalname, text)
    }
  ];
}

async function extractPdfText(file: Express.Multer.File) {
  const parser = new PDFParse({ data: file.buffer });

  try {
    const result = await parser.getText();
    return result.text;
  } catch {
    throw new UploadPreparationError(`PDF ${file.originalname} 解析失败。`, 400);
  } finally {
    await parser.destroy();
  }
}

function formatUploadedTextContent(fileName: string, content: string) {
  const normalizedContent = content.replace(/\u0000/g, "").trim();
  const clippedContent =
    normalizedContent.length > maxExtractedTextCharacters
      ? `${normalizedContent.slice(0, maxExtractedTextCharacters)}\n\n[文件内容较长，已截取前 ${maxExtractedTextCharacters} 个字符]`
      : normalizedContent;

  if (!clippedContent) {
    return `\n\n[上传文件：${fileName}]\n文件没有提取到可读取文本。`;
  }

  return `\n\n[上传文件：${fileName}]\n${clippedContent}`;
}

function findLastUserMessageIndex(messages: ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      return index;
    }
  }

  return -1;
}

function getLastUserText(messages: ChatMessage[]) {
  const lastUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user");

  if (!lastUserMessage) {
    return "";
  }

  return contentToStoredString(lastUserMessage.content);
}

/**
 * 上一轮助手说了什么。只给「追问」用：用户回一句「10 道题左右，15 分钟，难度中等」，
 * 单看这句判不出该找哪个专项，得靠上一轮提到的「小测」「教案」补上任务词。
 */
function getPreviousAssistantText(messages: ChatMessage[]) {
  return getNeighbourText(messages, "assistant");
}

/** 上一轮用户自己说的话：转交时带上它，专项才知道是哪个年级、哪个课题。 */
function getPreviousUserText(messages: ChatMessage[]) {
  return getNeighbourText(messages, "user").slice(-600);
}

function getNeighbourText(messages: ChatMessage[], role: ChatMessage["role"]) {
  const lastUserIndex = messages.map((message) => message.role).lastIndexOf("user");
  if (lastUserIndex <= 0) {
    return "";
  }
  for (let index = lastUserIndex - 1; index >= 0; index -= 1) {
    if (messages[index].role === role) {
      return contentToStoredString(messages[index].content).slice(-400);
    }
  }
  return "";
}

function isKnowledgeBaseOverviewRequest(value: string) {
  const text = value.replace(/\s+/g, "").trim();

  return (
    /(这个|该|所选|当前|已选|此)?(知识库|资料库).*(有什么作用|有什么用|能做什么|里面有什么|包含什么|有哪些资料|有些什么|作用|用途)/.test(
      text
    ) ||
    /(有什么作用|有什么用|能做什么|里面有什么|包含什么|有哪些资料|有些什么|作用|用途).*(这个|该|所选|当前|已选|此)?(知识库|资料库)/.test(
      text
    )
  );
}

async function buildKnowledgeBaseOverview(knowledgeBaseIds: string[]) {
  if (!knowledgeBaseIds.length) {
    return "当前没有选择知识库。请先在输入框上方选择一个知识库，再询问它包含什么资料或可以用于哪些问题。";
  }

  const bases = await knowledgeProvider.listBases();
  const selectedBases = bases.filter((base) => knowledgeBaseIds.includes(base.id));

  if (!selectedBases.length) {
    return "所选知识库暂时无法读取。请重新选择后再试。";
  }

  const sections = await Promise.all(
    selectedBases.map(async (base) => {
      const documents = await knowledgeProvider.listDocuments(base.id);
      const recentDocuments = [...documents]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, 3);
      const resourceTypes = [...new Set(documents.map((document) => document.resourceType))];
      const tags = [...new Set(documents.flatMap((document) => document.tags))].slice(0, 8);
      const subjects = [...new Set(documents.map((document) => document.subject).filter(Boolean))];
      const scope = subjects.length ? subjects.join("、") : resourceTypes.join("、") || "教学资料";
      const recentNames = recentDocuments.map((document) => document.name);

      return [
        `「${base.name}」`,
        `资料数量：${base.documentCount} ${base.source === "ima" ? "条内容" : "份文档"}`,
        `文件类型：${resourceTypes.length ? resourceTypes.join("、") : "暂未提供"}`,
        `标签：${tags.length ? tags.join("、") : "暂未设置"}`,
        `最近资料：${recentNames.length ? recentNames.join("、") : base.source === "ima" ? "外部知识库会在提问时实时检索" : "暂未上传资料"}`,
        `可用于回答：围绕${scope}的教学目标、重点难点、教学活动、课例设计或常见学习问题。`,
        `示例问题："${scope}中有哪些可用于课堂设计的依据？"`
      ].join("\n");
    })
  );

  return `我已读取所选知识库的真实资料信息：\n\n${sections.join("\n\n")}`;
}

function attachKnowledgeContextToMessages(
  messages: ChatMessage[],
  citations: KnowledgeCitation[]
) {
  if (citations.length === 0) {
    return messages;
  }

  const lastUserIndex = findLastUserMessageIndex(messages);

  if (lastUserIndex < 0) {
    return messages;
  }

  const contextBlock: TextContentBlock = {
    type: "text",
    text: formatKnowledgeContext(citations)
  };

  return messages.map((message, index) => {
    if (index !== lastUserIndex) {
      return message;
    }

    if (typeof message.content === "string") {
      return {
        ...message,
        content: [
          { type: "text" as const, text: message.content },
          contextBlock
        ]
      };
    }

    return {
      ...message,
      content: [...message.content, contextBlock]
    };
  });
}

function formatKnowledgeContext(citations: KnowledgeCitation[]) {
  return [
    "\n\n[知识库检索结果]",
    "请优先基于以下资料回答；如果资料不足，再补充通用教学建议，并明确不要编造资料来源。",
    ...citations.map(
      (citation, index) =>
        `${index + 1}. 来源：${citation.documentName}\n片段：${citation.snippet}`
    )
  ].join("\n");
}

function buildConversationTitle(messages: StoredChatMessage[]) {
  const firstUserMessage = messages.find((message) => message.role === "user");
  const text = firstUserMessage?.content.replace(/\s+/g, " ").trim() || "教学实训记录";

  return text.length > 28 ? `${text.slice(0, 28)}...` : text;
}

async function streamLessonPlanRequest(
  request: express.Request,
  response: express.Response,
  mode: "generate" | "refine"
) {
  const input = normalizeLessonPlanInput(
    mode === "refine" ? request.body?.input || request.body : request.body
  );
  const currentDraft = isRecord(request.body?.draft)
    ? (request.body.draft as LessonPlanDraft)
    : undefined;
  const conversationId =
    mode === "refine" && typeof request.body?.conversationId === "string"
      ? request.body.conversationId
      : randomUUID();
  const abortController = new AbortController();
  const phaseSteps =
    mode === "generate" ? lessonPlanStreamGenerateSteps : lessonPlanStreamRefineSteps;

  response.on("close", () => {
    if (!response.writableEnded) {
      abortController.abort();
    }
  });

  response.writeHead(200, {
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no"
  });
  response.flushHeaders?.();

  try {
    await observeOperation(
      mode === "generate" ? "lesson.plan.generate.stream" : "lesson.plan.refine.stream",
      {
        input: {
          subject: input.subject,
          grade: input.grade,
          topic: input.topic,
          knowledgeBaseCount: input.knowledgeBaseIds.length,
          hasCurrentDraft: Boolean(currentDraft)
        },
        metadata: {
          mode,
          transport: "sse"
        }
      },
      async (observation) => {
        writeStreamPhase(response, phaseSteps, 0);
        const citations = (
          await searchKnowledge({
            query: buildLessonPlanSearchQuery(input),
            knowledgeBaseIds: input.knowledgeBaseIds,
            topK: 4
          })
        ).map(toStoredCitation);

        for (const citation of citations) {
          writeSse(response, "citation", citation);
        }

        writeStreamPhase(response, phaseSteps, 1);
        let streamedCharacterCount = 0;
        const draft = await createStreamingLessonPlanDraftWithOptionalAi({
          input,
          citations,
          currentDraft,
          mode,
          signal: abortController.signal,
          onDelta(content) {
            streamedCharacterCount += content.length;
            writeSse(response, "delta", { content });
          },
          onThinkingDelta(content) {
            writeSse(response, "thinking_delta", { content });
          }
        });

        writeStreamPhase(response, phaseSteps, 2);
        const diagnostic = diagnoseLessonPlanDraft(draft, citations);
        const comparison = compareLessonPlanDrafts({
          previousDraft: currentDraft,
          currentDraft: draft,
          diagnostic,
          citations
        });
        const evaluation = lessonDiagnosticToEvaluation(
          conversationId,
          diagnostic,
          citations
        );

        writeStreamPhase(response, phaseSteps, 3);
        await saveLessonPlanTraining({
          conversationId,
          input,
          draft,
          citations,
          evaluation,
          action: mode === "generate" ? "生成教案" : "按建议优化教案",
          comparison
        });

        writeStreamPhase(response, phaseSteps, 4);
        writeSse(response, "evaluation", evaluation);
        writeSse(response, "done", {
          conversationId,
          draft,
          diagnostic,
          citations,
          evaluation,
          comparison
        });

        observation.update({
          output: {
            conversationId,
            title: draft.title,
            citationCount: citations.length,
            overallScore: evaluation.overallScore,
            streamedCharacterCount
          }
        });
        recordTrainingEvaluationScores(observation, evaluation);
      },
      { asType: "chain" }
    );
  } catch (error) {
    if (!abortController.signal.aborted) {
      const message =
        error instanceof Error
          ? error.message
          : mode === "generate"
            ? "教案生成失败，请稍后重试。"
            : "教案优化失败，请稍后重试。";
      writeSse(response, "error", { message });
    }
  } finally {
    response.end();
  }
}

async function streamInternshipReflectionRequest(
  request: express.Request,
  response: express.Response,
  mode: "generate" | "refine"
) {
  const input = normalizeInternshipReflectionInput(
    parseJsonField(request.body?.input) || request.body
  );
  const currentDraft = isRecord(parseJsonField(request.body?.draft))
    ? (parseJsonField(request.body?.draft) as InternshipReflectionDraft)
    : isRecord(request.body?.draft)
      ? (request.body.draft as InternshipReflectionDraft)
      : undefined;
  const conversationId =
    typeof request.body?.conversationId === "string"
      ? request.body.conversationId
      : randomUUID();
  const phaseSteps =
    mode === "generate" ? reflectionStreamGenerateSteps : reflectionStreamRefineSteps;

  response.writeHead(200, {
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no"
  });
  response.flushHeaders?.();

  try {
    writeStreamPhase(response, phaseSteps, 0);
    const uploadedEvidence = await summarizeInternshipEvidence(getUploadedFiles(request));
    const evidence = [
      ...normalizeInternshipEvidence(parseJsonField(request.body?.evidence)),
      ...uploadedEvidence
    ];

    writeStreamPhase(response, phaseSteps, 1);
    const citations = (
      await searchKnowledge({
        query: buildInternshipReflectionSearchQuery(input),
        knowledgeBaseIds: input.knowledgeBaseIds,
        topK: 4
      })
    ).map(toStoredCitation);

    for (const citation of citations) {
      writeSse(response, "citation", citation);
    }

    writeStreamPhase(response, phaseSteps, 2);
    const draft =
      mode === "refine"
        ? refineInternshipReflectionDraft({
            input,
            currentDraft,
            evidence: evidence.length ? evidence : currentDraft?.evidence || [],
            citations,
            priorTrainingLinks: buildReflectionPriorTrainingLinks()
          })
        : generateInternshipReflectionDraft({
            input,
            evidence,
            citations,
            priorTrainingLinks: buildReflectionPriorTrainingLinks()
          });

    writeStreamPhase(response, phaseSteps, 3);
    const diagnostic = diagnoseInternshipReflectionDraft(draft, citations);
    const evaluation = internshipDiagnosticToEvaluation(
      conversationId,
      diagnostic,
      citations
    );
    const savedEvidence = draft.evidence;

    await saveInternshipReflectionTraining({
      conversationId,
      input,
      draft,
      citations,
      evidence: savedEvidence,
      evaluation,
      action:
        mode === "generate"
          ? "生成实习日志与反思"
          : "按建议优化实习日志与反思"
    });

    writeStreamPhase(response, phaseSteps, 4);
    writeSse(response, "evaluation", evaluation);
    writeSse(response, "done", {
      conversationId,
      draft,
      diagnostic,
      citations,
      evidence: savedEvidence,
      evaluation
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : mode === "generate"
          ? "实习反思生成失败，请稍后重试。"
          : "实习反思优化失败，请稍后重试。";
    writeSse(response, "error", { message });
  } finally {
    response.end();
  }
}

async function createLessonPlanDraftWithOptionalAi({
  input,
  citations,
  currentDraft,
  mode
}: {
  input: LessonPlanInput;
  citations: StoredCitation[];
  currentDraft?: LessonPlanDraft;
  mode: "generate" | "refine";
}) {
  return observeOperation(
    "lesson.plan.ai_or_fallback",
    {
      input: {
        mode,
        topic: input.topic,
        citationCount: citations.length,
        aiConfigured: isMiniMaxLessonPlanConfigured()
      }
    },
    async (observation) => {
      if (isMiniMaxLessonPlanConfigured()) {
        try {
          const aiDraft = await withLessonPlanAiTimeout(
            generateMiniMaxLessonPlanDraft({
              input,
              citations,
              currentDraft,
              mode
            })
          );

          if (aiDraft) {
            observation.update({
              output: {
                source: "ai",
                title: aiDraft.title,
                sectionCount: aiDraft.sections.length
              }
            });
            return aiDraft;
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "MiniMax lesson plan failed";
          const status =
            error instanceof MiniMaxLessonPlanError && error.status
              ? ` (${error.status})`
              : "";
          console.warn(`MiniMax lesson plan fallback${status}: ${message}`);
          observation.update({
            metadata: {
              fallback: true,
              fallbackReason: message,
              fallbackStatus:
                error instanceof MiniMaxLessonPlanError ? error.status : undefined
            }
          });
        }
      }

      const fallbackDraft =
        mode === "refine"
          ? refineLessonPlanDraft(input, currentDraft, citations)
          : generateLessonPlanDraft(input, citations);

      if (isMiniMaxLessonPlanConfigured()) {
        fallbackDraft.sourceNote = `${fallbackDraft.sourceNote} 远端教案增强暂不可用，已自动回退本地教案模板。`;
      }

      observation.update({
        output: {
          source: "fallback",
          title: fallbackDraft.title,
          sectionCount: fallbackDraft.sections.length
        }
      });

      return fallbackDraft;
    },
    { asType: "chain" }
  );
}

async function createStreamingLessonPlanDraftWithOptionalAi({
  input,
  citations,
  currentDraft,
  mode,
  signal,
  onDelta,
  onThinkingDelta
}: {
  input: LessonPlanInput;
  citations: StoredCitation[];
  currentDraft?: LessonPlanDraft;
  mode: "generate" | "refine";
  signal?: AbortSignal;
  onDelta: (content: string) => void;
  onThinkingDelta: (content: string) => void;
}) {
  return observeOperation(
    "lesson.plan.ai_or_fallback.stream",
    {
      input: {
        mode,
        topic: input.topic,
        citationCount: citations.length,
        aiConfigured: isMiniMaxLessonPlanConfigured()
      }
    },
    async (observation) => {
      if (isMiniMaxLessonPlanConfigured()) {
        try {
          const aiDraft = await generateStreamingMiniMaxLessonPlanDraft({
            input,
            citations,
            currentDraft,
            mode,
            signal,
            onDelta,
            onThinkingDelta
          });

          if (aiDraft) {
            observation.update({
              output: {
                source: "ai_stream",
                title: aiDraft.title,
                sectionCount: aiDraft.sections.length
              }
            });
            return aiDraft;
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Streaming lesson plan failed";
          const status =
            error instanceof MiniMaxLessonPlanError && error.status
              ? ` (${error.status})`
              : "";
          console.warn(`Streaming lesson plan fallback${status}: ${message}`);
          observation.update({
            metadata: {
              fallback: true,
              fallbackReason: message,
              fallbackStatus:
                error instanceof MiniMaxLessonPlanError ? error.status : undefined
            }
          });
        }
      }

      const fallbackDraft =
        mode === "refine"
          ? refineLessonPlanDraft(input, currentDraft, citations)
          : generateLessonPlanDraft(input, citations);

      if (isMiniMaxLessonPlanConfigured()) {
        fallbackDraft.sourceNote = `${fallbackDraft.sourceNote} 远端流式教案增强暂不可用，已自动回退本地教案模板。`;
      }

      observation.update({
        output: {
          source: "fallback",
          title: fallbackDraft.title,
          sectionCount: fallbackDraft.sections.length
        }
      });

      return fallbackDraft;
    },
    { asType: "chain" }
  );
}

async function withLessonPlanAiTimeout<T>(operation: Promise<T>) {
  const timeoutMs = getLessonPlanAiTimeoutMs();

  if (timeoutMs <= 0) {
    return operation;
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(
            new MiniMaxLessonPlanError(
              `远端教案增强超过 ${timeoutMs}ms 未返回，已启用本地回退。`
            )
          );
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function getLessonPlanAiTimeoutMs() {
  const configured = Number(process.env.LESSON_PLAN_AI_TIMEOUT_MS);

  if (Number.isFinite(configured)) {
    return Math.max(0, configured);
  }

  return defaultLessonPlanAiTimeoutMs;
}

async function saveLessonPlanTraining({
  conversationId,
  input,
  draft,
  citations,
  evaluation,
  action,
  comparison
}: {
  conversationId: string;
  input: LessonPlanInput;
  draft: LessonPlanDraft;
  citations: StoredCitation[];
  evaluation: TrainingEvaluation;
  action: string;
  comparison?: LessonPlanComparison;
}) {
  const messages: StoredChatMessage[] = [
    {
      role: "user",
      content: [
        `${action}：${input.subject} ${input.grade}《${input.topic}》`,
        `课时：${input.duration}`,
        `教材背景：${input.textbookContext}`,
        `学情：${input.studentProfile}`,
        `知识库：${input.knowledgeBaseIds.length ? input.knowledgeBaseIds.join("、") : "未选择"}`,
        `技能：${input.skills.join("、") || "未启用"}`
      ].join("\n")
    },
    {
      role: "assistant",
      content: [
        renderLessonPlanText(draft),
        `诊断总分：${evaluation.overallScore}`,
        `诊断维度：${evaluation.dimensions
          .map((dimension) => `${dimension.name}${dimension.score}分`)
          .join("；")}`,
        `问题：${evaluation.diagnosis.join("；")}`,
        `建议：${evaluation.suggestions.join("；")}`,
        comparison
          ? [
              `前后对比：${comparison.summary}`,
              ...comparison.items.map(
                (item) =>
                  `${item.dimension}：优化前 ${item.before}；优化后 ${item.after}；改动说明 ${item.improvement}`
              ),
              `对比证据：${comparison.evidence.join("；")}`
            ].join("\n")
          : undefined,
        `下一步：${evaluation.nextTask}`
      ]
        .filter(Boolean)
        .join("\n\n")
    }
  ];

  await chatRepository.saveConversation({
    conversationId,
    title: draft.title,
    trainingType: "教案诊断",
    messages,
    knowledgeBaseIds: input.knowledgeBaseIds,
    attachmentNames: [],
    artifacts: [],
    citations
  });
  await chatRepository.saveEvaluation(evaluation);
}

async function saveInternshipReflectionTraining({
  conversationId,
  input,
  draft,
  citations,
  evidence,
  evaluation,
  action
}: {
  conversationId: string;
  input: InternshipReflectionInput;
  draft: InternshipReflectionDraft;
  citations: StoredCitation[];
  evidence: InternshipEvidenceItem[];
  evaluation: TrainingEvaluation;
  action: string;
}) {
  const messages: StoredChatMessage[] = [
    {
      role: "user",
      content: `${action}：${input.internshipDate} ${input.schoolClass} ${input.subjectTopic}`
    },
    {
      role: "assistant",
      content: renderInternshipReflectionText(draft)
    }
  ];
  let artifacts: StoredArtifact[] = [];

  try {
    const generatedArtifacts = await generateArtifacts([
      buildInternshipReflectionArtifact(draft)
    ]);
    artifacts = generatedArtifacts.map(toStoredArtifact);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown internship reflection export error";
    console.warn(`Internship reflection artifact skipped: ${message}`);
  }

  await chatRepository.saveConversation({
    conversationId,
    title: draft.title,
    trainingType: "实习反思",
    messages,
    knowledgeBaseIds: input.knowledgeBaseIds,
    attachmentNames: evidence.map((item) => item.name),
    artifacts,
    citations
  });
  await chatRepository.saveEvaluation(evaluation);
}

function buildReflectionPriorTrainingLinks() {
  const summary = chatRepository.getGrowthSummary();
  const weakText = summary.weakDimensions.length
    ? summary.weakDimensions
        .map((dimension) => `${dimension.name}${dimension.score}分`)
        .join("、")
    : "目标活动评价一致性、理论依据和课堂应变";

  return [
    `关联教案诊断：已沉淀 ${summary.trainingTypeCounts["教案诊断"]} 次教案训练，结合 ${weakText} 回看目标、活动、评价证据是否一致。`,
    `关联说课陪练：已沉淀 ${summary.trainingTypeCounts["说课陪练"]} 次说课训练，把理论依据、学情解释和答辩风险转化为本次反思的原因分析。`,
    `关联模拟课堂：已沉淀 ${summary.trainingTypeCounts["模拟课堂"]} 次模拟课堂训练，将学生沉默、错误回答、跑题或控场波动对应到下一次追问与反馈动作。`
  ];
}

function toStoredArtifact(artifact: {
  id: string;
  name: string;
  type: string;
  url: string;
  size: number;
}): StoredArtifact {
  return artifact;
}

function toStoredCitation(citation: KnowledgeCitation): StoredCitation {
  return {
    id: citation.id,
    knowledgeBaseId: citation.knowledgeBaseId,
    knowledgeBaseName: citation.knowledgeBaseName,
    documentId: citation.documentId,
    documentName: citation.documentName,
    snippet: citation.snippet,
    source: citation.source,
    score: citation.score
  };
}

function buildGrowthReportArtifact(
  summary: ReturnType<typeof chatRepository.getGrowthSummary>,
  type: "md" | "docx"
): ArtifactRequest {
  const dimensions =
    summary.dimensionAverages
      .map((dimension) => `${dimension.name}：${dimension.score}分，${dimension.comment}`)
      .join("\n") || "暂未形成评价数据。";
  const recent =
    summary.recentEvaluations
      .map(
        (evaluation) =>
          `${evaluation.trainingType}：${evaluation.overallScore}分；下一步：${evaluation.nextTask}`
      )
      .join("\n") || "完成一次训练后，这里会沉淀评价记录。";
  const weak =
    summary.weakDimensions
      .map((dimension) => `${dimension.name}（${dimension.score}分）`)
      .join("、") || "暂无薄弱项";
  const trainingTypeSummaries =
    summary.trainingTypeSummaries
      .map(
        (item) =>
          `${item.trainingType}：${item.status}｜${item.count} 次｜均分 ${item.averageScore || "--"}｜证据 ${item.evidenceCount} 条｜成果 ${item.artifactCount} 个｜最新：${item.latestTitle || "暂无"}｜下一步：${item.nextAction}`
      )
      .join("\n") || "暂未形成训练覆盖数据。";
  const timeline =
    summary.growthTimeline
      .map(
        (item) =>
          `${item.trainingType}｜${item.title}｜${item.score || "--"}分｜薄弱项：${item.weakDimensions.join("、") || "暂无"}｜下一步：${item.nextTask}`
      )
      .join("\n") || "完成训练后会形成证据时间线。";
  const representativeArtifacts =
    summary.representativeArtifacts
      .map(
        (item) =>
          `${item.trainingType}｜${item.title}｜${item.score || "--"}分｜${item.reason}`
      )
      .join("\n") || "生成教案、课堂报告或实习反思后会出现代表性成果。";
  const capabilityMatrix =
    summary.capabilityMatrix
      .map(
        (item) =>
          `${item.name}：${item.score}分\n证据：${item.evidence}\n下一步：${item.nextAction}`
      )
      .join("\n\n") || "暂未形成能力成长矩阵。";
  const reflectionSummary = [
    `反思次数：${summary.reflectionSummary.totalReflections} 次`,
    `最新反思：${summary.reflectionSummary.latestTitle || "暂无"}`,
    `最新得分：${summary.reflectionSummary.latestScore || "--"}`,
    `反思证据：${summary.reflectionSummary.evidenceCount} 条`,
    `下一步：${summary.reflectionSummary.nextAction}`
  ].join("\n");
  return {
    name: `StarLattice成长档案.${type}`,
    type,
    title: "StarLattice 师范生教学能力成长档案",
    content: [
      `累计训练：${summary.totalTrainings} 次`,
      `平均得分：${summary.averageScore || 0} 分`,
      `当前成长阶段：${summary.growthStage}`,
      `当前薄弱项：${weak}`,
      `本轮成长行动：${summary.recommendedAction.objective}`,
      `行动原因：${summary.recommendedAction.reason}`,
      `完成标准：${summary.recommendedAction.completionCriteria}`,
      `训练覆盖：\n${trainingTypeSummaries}`,
      `训练证据时间线：\n${timeline}`,
      `能力成长矩阵：\n${capabilityMatrix}`,
      `代表性成果：\n${representativeArtifacts}`,
      `推荐下一步：${summary.recommendedNextTask}`
    ].join("\n\n"),
    sections: [
      {
        heading: "阶段成长摘要",
        body: `当前处于「${summary.growthStage}」阶段。累计完成 ${summary.totalTrainings} 次训练，平均得分 ${summary.averageScore || 0} 分，当前薄弱项为 ${weak}。${summary.recommendedAction.objective}`
      },
      {
        heading: "本轮成长行动",
        body: [
          `推荐训练：${summary.recommendedAction.trainingType}`,
          `推荐原因：${summary.recommendedAction.reason}`,
          `训练目标：${summary.recommendedAction.objective}`,
          `完成标准：${summary.recommendedAction.completionCriteria}`
        ].join("\n")
      },
      {
        heading: "训练覆盖",
        body: trainingTypeSummaries
      },
      {
        heading: "训练证据时间线",
        body: timeline
      },
      {
        heading: "能力成长矩阵",
        body: capabilityMatrix
      },
      {
        heading: "代表性成果",
        body: representativeArtifacts
      },
      {
        heading: "实习反思成长摘要",
        body: reflectionSummary
      },
      {
        heading: "能力维度概览",
        body: dimensions
      },
      {
        heading: "最近训练反馈",
        body: recent
      },
    ]
  };
}

function contentToStoredString(content: ChatMessage["content"]) {
  if (typeof content === "string") {
    return content;
  }

  return content
    .map((block) =>
      block.type === "text" ? block.text : `[上传图片：${block.source.media_type}]`
    )
    .join("\n");
}

function getFileExtension(fileName: string) {
  return path.extname(fileName).replace(".", "").toLowerCase();
}

function formatFileSize(size: number) {
  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function writeSse(
  response: express.Response,
  event:
    | "delta"
    | "thinking_delta"
    | "phase"
    | "metrics"
    | "artifact"
    | "citation"
    | "evaluation"
    | "tool"
    | "workflow_step"
    | "progress_note"
    | "delegated"
    | "done"
    | "error",
  data: unknown
) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function writeStreamPhase(
  response: express.Response,
  steps: StreamPhaseStep[],
  activeIndex: number
) {
  const boundedIndex = Math.min(Math.max(activeIndex, 0), steps.length - 1);
  const activeStep = steps[boundedIndex];

  writeSse(response, "phase", {
    stepId: activeStep?.id,
    label: activeStep?.label,
    detail: activeStep?.detail,
    steps,
    activeStepId: activeStep?.id,
    completedStepIds: steps.slice(0, boundedIndex).map((step) => step.id)
  });
}

function roundSeconds(milliseconds: number) {
  return Math.max(0.1, Math.round((milliseconds / 1000) * 10) / 10);
}

function handleClassroomError(error: unknown, response: express.Response) {
  const status = error instanceof ClassroomServiceError ? error.status : 400;
  const message =
    error instanceof Error ? error.message : "虚拟课堂服务暂时不可用。";

  response.status(status).json({ message });
}

function coerceArtifactRequests(values: unknown[]): ArtifactRequest[] {
  return values
    .filter((value): value is Record<string, unknown> => Boolean(value))
    .map((value) => ({
      name: typeof value.name === "string" ? value.name : "生成文件.md",
      type:
        value.type === "md" || value.type === "docx" || value.type === "pptx"
          ? value.type
          : "md",
      title: typeof value.title === "string" ? value.title : undefined,
      content: typeof value.content === "string" ? value.content : undefined,
      sections: Array.isArray(value.sections)
        ? value.sections.map((section) => coerceSection(section))
        : undefined,
      slides: Array.isArray(value.slides)
        ? value.slides.map((slide) => coerceSlide(slide))
        : undefined
    }));
}

function coerceSection(value: unknown) {
  const section = isRecord(value) ? value : {};
  return {
    heading: typeof section.heading === "string" ? section.heading : undefined,
    body: typeof section.body === "string" ? section.body : undefined,
    bullets: Array.isArray(section.bullets)
      ? section.bullets.filter((item): item is string => typeof item === "string")
      : undefined
  };
}

function coerceSlide(value: unknown) {
  const slide = isRecord(value) ? value : {};
  return {
    title: typeof slide.title === "string" ? slide.title : undefined,
    notes: typeof slide.notes === "string" ? slide.notes : undefined,
    bullets: Array.isArray(slide.bullets)
      ? slide.bullets.filter((item): item is string => typeof item === "string")
      : undefined
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

class UploadPreparationError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "UploadPreparationError";
  }
}
