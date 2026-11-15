import { useEffect, useRef, useState } from "react";
import { accountStorage } from "../auth/accountStorage";
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  GraduationCap,
  LoaderCircle
} from "lucide-react";
import { platformApi } from "../platform/api";
import {
  cancelTrainingRun,
  isTerminalStatus,
  latestStepOutputOf,
  pendingInteractionOf,
  respondTrainingInteraction,
  startTrainingRun,
  waitForTrainingCheckpoint
} from "../platform/trainingRuns";
import type { InteractionRecord, TraceResponse } from "../platform/types";
import { SessionRunBar, SessionRunRail } from "../platform/SessionRunPanel";
import { ClassroomConfigPanel } from "./components/ClassroomConfigPanel";
import { ClassroomMetricsPanel } from "./components/ClassroomMetricsPanel";
import { ClassroomOperationPanel } from "./components/ClassroomOperationPanel";
import { ClassroomReportPanel } from "./components/ClassroomReportPanel";
import { ClassroomTimeline } from "./components/ClassroomTimeline";
import { TeacherInputBar } from "./components/TeacherInputBar";
import { VirtualStudentGrid } from "./components/VirtualStudentGrid";
import type {
  ClassroomActionType,
  ClassroomArtifact,
  ClassroomCitation,
  ClassroomConfig,
  ClassroomReport,
  ClassroomSpeakResponse,
  ClassroomState
} from "./types";

const classroomSessionWorkflow = "classroom-session-v1";

type ClassroomCreateOutput = { sessionId: string; classroomState: ClassroomState };

type ClassroomReportOutput = {
  report: ClassroomReport;
  citations?: ClassroomCitation[];
  saveError?: string;
  artifact?: ClassroomArtifact;
};


const defaultConfig: ClassroomConfig = {
  subject: "数学",
  grade: "初中",
  topic: "分数的意义",
  classType: "普通班",
  trainingGoal: "提问训练",
  difficulty: "普通",
  specialTrainingMode: "综合训练"
};
const classroomSnapshotKey = "yishixun.classroom.run.v2";

type ClassroomStatusTone = "info" | "loading" | "success" | "error";

type ClassroomTrainingPageProps = {
  selectedKnowledgeBaseIds?: string[];
  onOpenMaterials?: () => void;
  initialRunId?: string;
  onOpenMonitorRun?: (runId: string) => void;
  onOpenWorkflow?: (workflowId: string, nodeId?: string) => void;
};

const classroomRailSteps = [
  { id: "start", label: "开始训练", hint: "工作流入口" },
  { id: "create-classroom", label: "生成虚拟班级", hint: "classroom.create · 班级画像与学生 Agent" },
  { id: "turns", label: "逐轮试讲（人工 + 多 Agent）", hint: "教师发言 → 学生 Agent 反应 → 观察员点评" },
  { id: "report", label: "诊断报告与成果", hint: "classroom.report · 证据链与 Word 成果" },
  { id: "end", label: "训练结束" }
];

export function ClassroomTrainingPage({
  selectedKnowledgeBaseIds = [],
  onOpenMaterials,
  initialRunId,
  onOpenMonitorRun,
  onOpenWorkflow
}: ClassroomTrainingPageProps) {
  const [config, setConfig] = useState<ClassroomConfig>(defaultConfig);
  const [classroom, setClassroom] = useState<ClassroomState>();
  const [runId, setRunId] = useState<string>();
  const [trace, setTrace] = useState<TraceResponse>();
  const [interaction, setInteraction] = useState<InteractionRecord>();
  const [teacherText, setTeacherText] = useState("");
  const [selectedStudentId, setSelectedStudentId] = useState<string>();
  const [report, setReport] = useState<ClassroomReport>();
  const [reportArtifact, setReportArtifact] = useState<ClassroomArtifact>();
  const [reportCitations, setReportCitations] = useState<ClassroomCitation[]>([]);
  const [status, setStatus] = useState<string>();
  const [statusTone, setStatusTone] = useState<ClassroomStatusTone>("info");
  const [isWorking, setIsWorking] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState("语音讲课未开启。");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [voiceTimelineText, setVoiceTimelineText] = useState("");
  const [voiceSupported] = useState(() =>
    typeof window !== "undefined" &&
    Boolean(window.SpeechRecognition || window.webkitSpeechRecognition)
  );
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const autoSendTimerRef = useRef<number | undefined>(undefined);
  const shouldKeepListeningRef = useRef(false);
  const classroomRef = useRef<ClassroomState | undefined>(undefined);
  const runIdRef = useRef<string | undefined>(undefined);
  const interactionRef = useRef<InteractionRecord | undefined>(undefined);
  const isWorkingRef = useRef(false);
  const statusRef = useRef<HTMLParagraphElement | null>(null);
  const reportPanelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return () => {
      shouldKeepListeningRef.current = false;
      recognitionRef.current?.abort();
      if (autoSendTimerRef.current) {
        window.clearTimeout(autoSendTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (initialRunId) {
      setStatusMessage("正在从运行监控恢复课堂运行...", "loading");
      void restoreRun(initialRunId);
      return;
    }

    const snapshot = readCachedClassroom();

    if (!snapshot) {
      return;
    }

    setClassroom(snapshot.classroom);
    setConfig(classroomToConfig(snapshot.classroom));
    setSelectedStudentId(snapshot.classroom.students[0]?.id);
    setStatusMessage("已恢复最近一次虚拟课堂，正在确认平台运行状态...", "loading");

    void restoreRun(snapshot.runId);
  }, [initialRunId]);

  useEffect(() => {
    classroomRef.current = classroom;

    if (classroom && runId) {
      cacheClassroom(runId, classroom);
    }
  }, [classroom, runId]);

  useEffect(() => {
    runIdRef.current = runId;
  }, [runId]);

  useEffect(() => {
    interactionRef.current = interaction;
  }, [interaction]);

  useEffect(() => {
    isWorkingRef.current = isWorking;
  }, [isWorking]);

  useEffect(() => {
    if (report && reportPanelRef.current) {
      reportPanelRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [report]);

  useEffect(() => {
    if (statusTone === "error" && statusRef.current) {
      statusRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [status, statusTone]);

  async function handleCreateClassroom() {
    setIsWorking(true);
    setStatusMessage("正在生成虚拟班级画像并启动训练运行...", "loading");
    setReport(undefined);
    setReportArtifact(undefined);
    setReportCitations([]);
    setInteraction(undefined);
    setTrace(undefined);

    try {
      await cancelTrainingRun(runIdRef.current);
      const run = await startTrainingRun(classroomSessionWorkflow, {
        ...config,
        knowledgeBaseIds: selectedKnowledgeBaseIds
      });
      setRunId(run.id);
      const trace = await waitForTrainingCheckpoint(run.id);
      const created = applyTrace(trace);
      if (created) {
        setSelectedStudentId(created.students[0]?.id);
        setStatusMessage("虚拟课堂已生成，可以开始试讲。", "success");
      }
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "虚拟课堂生成失败。",
        "error"
      );
    } finally {
      setIsWorking(false);
    }
  }

  async function handleSend(text = teacherText) {
    const currentInteraction = interactionRef.current;

    if (!classroom || !currentInteraction || !text.trim()) {
      return;
    }

    setIsWorking(true);
    setStatusMessage("虚拟学生正在根据教师表现作出反应...", "loading");
    setTeacherText("");

    try {
      const trace = await respondTrainingInteraction(
        currentInteraction.id,
        { text: text.trim(), action: "speak" },
        "参训教师"
      );
      applyTrace(trace);
      const spoke = latestStepOutputOf<ClassroomSpeakResponse>(trace, ["student-reactions"]);
      setInterimTranscript("");
      setVoiceTimelineText("");
      if (pendingInteractionOf(trace)) {
        setStatusMessage(spoke?.observerTips[0] || "课堂状态已更新。", "success");
      }
    } catch (error) {
      setTeacherText(text);
      setStatusMessage(
        error instanceof Error ? error.message : "教师发言处理失败。",
        "error"
      );
    } finally {
      setIsWorking(false);
    }
  }

  async function handleFinishTraining() {
    const currentInteraction = interactionRef.current;

    if (!classroom) {
      return;
    }

    setIsWorking(true);
    setStatusMessage(
      "正在结束课堂运行，汇总证据链、Agent 决策依据和 Word 报告...",
      "loading"
    );

    try {
      if (currentInteraction) {
        const trace = await respondTrainingInteraction(
          currentInteraction.id,
          { action: "finish" },
          "参训教师"
        );
        applyTrace(trace);
      } else {
        setStatusMessage("当前课堂没有等待中的输入节点，可查看已生成的报告。", "info");
      }
    } catch (error) {
      setStatusMessage(
        error instanceof Error
          ? `${error.message} 课堂状态已保留，可稍后再次结束训练。`
          : "诊断报告生成失败，课堂状态已保留，可稍后重试。",
        "error"
      );
    } finally {
      setIsWorking(false);
    }
  }

  /** 将平台 trace 的步骤输出映射回课堂页面状态，并处理暂停/终态。 */
  function applyTrace(trace: TraceResponse): ClassroomState | undefined {
    setTrace(trace);
    const created = latestStepOutputOf<ClassroomCreateOutput>(trace, ["create-classroom"]);
    const spoke = latestStepOutputOf<ClassroomSpeakResponse>(trace, ["student-reactions"]);
    const nextClassroom = spoke?.classroomState ?? created?.classroomState;

    if (nextClassroom) {
      setClassroom(nextClassroom);
    }

    setInteraction(pendingInteractionOf(trace));

    if (isTerminalStatus(trace.run.status)) {
      const reportOutput = latestStepOutputOf<ClassroomReportOutput>(trace, ["report"]);
      if (trace.run.status === "succeeded" && reportOutput) {
        setReport(reportOutput.report);
        setReportArtifact(reportOutput.artifact);
        setReportCitations(reportOutput.citations || []);
        if (!reportOutput.saveError) {
          clearCachedClassroom();
        }
        setStatusMessage(
          reportOutput.saveError
            ? `诊断报告已生成，但保存历史记录失败：${reportOutput.saveError}。`
            : reportOutput.artifact
              ? `诊断报告已生成，并已保存 Word 成果：${reportOutput.artifact.name}。`
              : "诊断报告已生成，历史记录已保存；Word 成果未返回。",
          reportOutput.saveError ? "error" : "success"
        );
      } else if (trace.run.status !== "succeeded") {
        const failedStep = [...trace.steps].reverse().find((step) => step.status === "failed");
        setStatusMessage(
          trace.run.error || failedStep?.error || "课堂运行已中断，请重新生成虚拟课堂。",
          "error"
        );
      }
    }

    return nextClassroom;
  }

  async function restoreRun(cachedRunId: string) {
    try {
      const trace = await platformApi.trace(cachedRunId);
      setRunId(trace.run.id);
      const restored = applyTrace(trace);
      if (restored) {
        setConfig(classroomToConfig(restored));
        setSelectedStudentId(
          (current) => current || restored.students[0]?.id
        );
      }
      if (pendingInteractionOf(trace)) {
        setStatusMessage("已恢复最近一次虚拟课堂，可继续试讲。", "success");
      } else if (!isTerminalStatus(trace.run.status)) {
        setStatusMessage("已恢复最近一次虚拟课堂，运行正在继续。", "info");
      }
    } catch {
      clearCachedClassroom();
      setClassroom(undefined);
      setInteraction(undefined);
      setTrace(undefined);
      setStatusMessage(
        "上次课堂运行已过期（服务重启或记录被清理），请重新生成虚拟课堂。",
        "error"
      );
    }
  }

  function handleDraftAction(actionType: ClassroomActionType) {
    if (!classroom) {
      return;
    }

    const selectedStudent = classroom.students.find(
      (student) => student.id === selectedStudentId
    );

    if (
      (actionType === "call_on_student" || actionType === "follow_up_student") &&
      !selectedStudent
    ) {
      setStatusMessage("请先在个别互动中选择点名对象，再生成话术。", "error");
      return;
    }

    setTeacherText(
      buildActionDraft({ actionType, classroom, selectedStudent })
    );
    setStatusMessage("已在输入框生成话术草稿，可修改后点击发送讲课。", "info");
  }

  function startVoiceInput() {
    if (!voiceSupported) {
      setVoiceStatus("当前浏览器不支持语音识别，请使用文字输入。");
      setStatusMessage("当前浏览器不支持语音识别，请使用文字输入。", "error");
      return;
    }

    if (disabledByState()) {
      return;
    }

    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!Recognition) {
      setVoiceStatus("当前浏览器不支持语音识别，请使用文字输入。");
      return;
    }

    recognitionRef.current?.abort();
    const recognition = new Recognition();
    recognition.lang = "zh-CN";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      let finalTranscript = "";
      let currentInterim = "";

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result[0]?.transcript?.trim() || "";

        if (!transcript) {
          continue;
        }

        if (result.isFinal) {
          finalTranscript += transcript;
        } else {
          currentInterim += transcript;
        }
      }

      if (currentInterim) {
        setInterimTranscript(currentInterim);
        setVoiceTimelineText(currentInterim);
        setVoiceStatus(`正在识别：${currentInterim}`);
      }

      if (finalTranscript) {
        setTeacherText((current) =>
          `${current}${current ? "\n" : ""}${finalTranscript}`.trim()
        );
        setInterimTranscript("");
        setVoiceTimelineText(finalTranscript);
        setVoiceStatus(`已识别：${finalTranscript}`);
        scheduleVoiceAutoSend(finalTranscript);
      }
    };
    recognition.onerror = (event) => {
      setVoiceStatus(`语音识别中断：${event.error}`);
      setStatusMessage(`语音识别中断：${event.error}，可继续使用文字输入。`, "error");
      setIsListening(false);
      shouldKeepListeningRef.current = false;
    };
    recognition.onend = () => {
      if (shouldKeepListeningRef.current) {
        try {
          recognition.start();
        } catch {
          setIsListening(false);
          shouldKeepListeningRef.current = false;
        }
      } else {
        setIsListening(false);
      }
    };

    try {
      recognition.start();
      recognitionRef.current = recognition;
      shouldKeepListeningRef.current = true;
      setIsListening(true);
      setVoiceStatus("语音识别已开启，说完一句话后会自动触发学生 Agent。");
      setStatusMessage("语音讲课已开启。", "success");
    } catch (error) {
      setVoiceStatus(error instanceof Error ? error.message : "语音识别启动失败。");
      setIsListening(false);
      shouldKeepListeningRef.current = false;
    }
  }

  function stopVoiceInput() {
    shouldKeepListeningRef.current = false;
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setIsListening(false);
    setInterimTranscript("");
    setVoiceTimelineText("");
    setVoiceStatus("语音讲课已停止。");
    setStatusMessage("语音输入已停止。", "info");
  }

  function scheduleVoiceAutoSend(transcript: string) {
    const cleaned = transcript.trim();

    if (autoSendTimerRef.current) {
      window.clearTimeout(autoSendTimerRef.current);
    }

    if (cleaned.replace(/\s/g, "").length < 4) {
      setVoiceStatus("语音内容过短，已保留到输入框，暂不自动发送。");
      return;
    }

    autoSendTimerRef.current = window.setTimeout(() => {
      if (!classroomRef.current || !interactionRef.current || isWorkingRef.current) {
        setVoiceStatus("系统正在处理上一句讲课内容，本句已保留在输入框。");
        return;
      }

      void handleSend(cleaned);
    }, 1200);
  }

  function disabledByState() {
    return !classroom || !interaction || isWorking;
  }

  function setStatusMessage(message: string, tone: ClassroomStatusTone = "info") {
    setStatus(message);
    setStatusTone(tone);
  }

  return (
    <section className="classroom-page" aria-label="虚拟课堂互动训练">
      <header className="classroom-page-header">
        <div>
          <span>
            <GraduationCap size={18} strokeWidth={2.2} />
            虚拟课堂互动
          </span>
          <h1>在会变化的虚拟班级中训练试讲、提问与控场</h1>
          <p>
            教师行为分析、学生群体、课堂事件、观察员、评价报告五类 Agent 协同，形成可解释证据链。
          </p>
        </div>
        <div className="classroom-observer-badge">
          <Bot size={20} strokeWidth={2.2} />
          <span>多智能体课堂</span>
        </div>
      </header>

      <SessionRunBar
        workflowId={classroomSessionWorkflow}
        workflowName="虚拟课堂交互会话"
        runId={runId}
        trace={trace}
        steps={classroomRailSteps}
        turnLabel="教师发言"
        onOpenMonitor={runId && onOpenMonitorRun ? () => onOpenMonitorRun(runId) : undefined}
        onOpenWorkflow={onOpenWorkflow ? (nodeId) => onOpenWorkflow(classroomSessionWorkflow, nodeId) : undefined}
      />

      <div className="session-run-layout">
        <div className="session-run-main">
      <ClassroomConfigPanel
        config={config}
        classroom={classroom}
        isLoading={isWorking}
        onChange={(patch) => setConfig((current) => ({ ...current, ...patch }))}
        onCreate={handleCreateClassroom}
      />

      {status ? (
        <p
          ref={statusRef}
          className={`classroom-status classroom-status-${statusTone}`}
          aria-live="polite"
        >
          {renderStatusIcon(statusTone)}
          <span>{status}</span>
        </p>
      ) : null}

      <div className="classroom-workbench">
        <VirtualStudentGrid students={classroom?.students || []} />
        <ClassroomTimeline
          items={classroom?.timeline || []}
          liveTeacherText={voiceTimelineText}
        />
        <ClassroomMetricsPanel
          metrics={classroom?.metrics}
          events={classroom?.events || []}
          currentStage={classroom?.currentStage}
        />
      </div>

      <ClassroomOperationPanel
        students={classroom?.students || []}
        events={classroom?.events || []}
        turnCount={classroom?.turnCount || 0}
        selectedStudentId={selectedStudentId}
        disabled={!classroom || !interaction || isWorking}
        onSelectStudent={setSelectedStudentId}
        onAction={(actionType) => handleDraftAction(actionType)}
      />

      <TeacherInputBar
        value={teacherText}
        disabled={!classroom || !interaction}
        isSubmitting={isWorking}
        onChange={setTeacherText}
        onSend={() => void handleSend()}
        onFinish={() => void handleFinishTraining()}
        onStartVoice={startVoiceInput}
        onStopVoice={stopVoiceInput}
        isListening={isListening}
        voiceSupported={voiceSupported}
        voiceStatus={voiceStatus}
        interimTranscript={interimTranscript}
      />

      {report ? (
        <div ref={reportPanelRef} className="classroom-report-anchor">
          <ClassroomReportPanel
            report={report}
            artifact={reportArtifact}
            citations={reportCitations}
            onOpenMaterials={onOpenMaterials}
            onClose={() => {
              setReport(undefined);
              setReportCitations([]);
            }}
          />
        </div>
      ) : null}
        </div>

        <SessionRunRail
          workflowId={classroomSessionWorkflow}
          workflowName="虚拟课堂交互会话"
          runId={runId}
          trace={trace}
          steps={classroomRailSteps}
          turnNodeId="teacher-turn"
          turnStepId="turns"
          turnLabel="教师发言"
          followupLabels={["学生 Agent 反应", "观察员点评"]}
          onOpenMonitor={runId && onOpenMonitorRun ? () => onOpenMonitorRun(runId) : undefined}
          onOpenWorkflow={onOpenWorkflow ? (nodeId) => onOpenWorkflow(classroomSessionWorkflow, nodeId) : undefined}
        />
      </div>
    </section>
  );
}

function buildActionDraft({
  actionType,
  classroom,
  selectedStudent
}: {
  actionType: ClassroomActionType;
  classroom: ClassroomState;
  selectedStudent?: ClassroomState["students"][number];
}): string {
  const topicFocus =
    classroom.topicKeywords?.slice(0, 4).join("、") || classroom.topic;
  const sourceQuestion =
    stripStudentNames(
      findLastTeacherQuestion(classroom) || "",
      classroom.students
    ).trim() || "请结合刚才的课堂内容回答。";

  if (actionType === "call_on_student" && selectedStudent) {
    return `${selectedStudent.name}，请你回答刚才这个问题：${sourceQuestion}`;
  }

  if (actionType === "follow_up_student" && selectedStudent) {
    return `${selectedStudent.name}，你为什么这样想？请围绕“${topicFocus}”再说清楚，并说明你的依据：${sourceQuestion}`;
  }

  if (actionType === "start_group_activity") {
    return `接下来我们进行同桌讨论，请每组用两分钟围绕“${topicFocus}”画一个例子，并选择一名同学说明自己的判断。`;
  }

  if (actionType === "pause_and_manage") {
    return `先安静一下，大家暂停讨论，注意听讲。我们先明确活动规则：发言必须回到“${topicFocus}”这个任务，不跑题、不插话，再继续。`;
  }

  return `我们压缩总结一下，只保留本节课的核心结论：围绕“${topicFocus}”先说判断依据，再处理拓展问题。`;
}

function findLastTeacherQuestion(classroom: ClassroomState): string | undefined {
  return [...classroom.timeline]
    .reverse()
    .find(
      (item) =>
        item.role === "teacher" &&
        (/teacher_(question|follow_up)/.test(item.eventType) ||
          /为什么|谁来|请|怎么看|能不能|说说|问题|？|\?/.test(item.content))
    )?.content;
}

function stripStudentNames(
  text: string,
  students: ClassroomState["students"]
): string {
  let cleaned = text;

  for (const student of students) {
    cleaned = cleaned.split(student.name).join("");
  }

  return cleaned
    .replace(/^[，,、\s]+/, "")
    .replace(/[，,、]{2,}/g, "，");
}

function classroomToConfig(classroom: ClassroomState): ClassroomConfig {
  return {
    subject: classroom.subject,
    grade: classroom.grade,
    topic: classroom.topic,
    classType: classroom.classType,
    trainingGoal: classroom.trainingGoal,
    difficulty: classroom.difficulty,
    specialTrainingMode: classroom.specialTrainingMode,
    topicKeywords: classroom.topicKeywords,
    commonMisconceptions: classroom.commonMisconceptions
  };
}

function renderStatusIcon(tone: ClassroomStatusTone) {
  if (tone === "loading") {
    return <LoaderCircle size={16} strokeWidth={2.2} aria-hidden="true" />;
  }

  if (tone === "success") {
    return <CheckCircle2 size={16} strokeWidth={2.2} aria-hidden="true" />;
  }

  return <AlertCircle size={16} strokeWidth={2.2} aria-hidden="true" />;
}

type ClassroomSnapshot = { runId: string; classroom: ClassroomState };

function cacheClassroom(runId: string, classroom: ClassroomState) {
  try {
    accountStorage.setItem(
      classroomSnapshotKey,
      JSON.stringify({ runId, classroom } satisfies ClassroomSnapshot)
    );
  } catch {
    // Local storage can be unavailable in restricted browser contexts.
  }
}

function clearCachedClassroom() {
  try {
    accountStorage.removeItem(classroomSnapshotKey);
  } catch {
    // Local storage can be unavailable in restricted browser contexts.
  }
}

function readCachedClassroom(): ClassroomSnapshot | undefined {
  try {
    const raw = accountStorage.getItem(classroomSnapshotKey);

    if (!raw) {
      return undefined;
    }

    const parsed = JSON.parse(raw) as ClassroomSnapshot;

    if (
      !parsed?.runId ||
      !parsed.classroom?.sessionId ||
      !Array.isArray(parsed.classroom.students)
    ) {
      return undefined;
    }

    return parsed;
  } catch {
    return undefined;
  }
}
