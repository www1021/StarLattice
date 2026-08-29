import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  GraduationCap,
  LoaderCircle
} from "lucide-react";
import {
  createClassroom,
  getClassroom,
  requestClassroomReport,
  restoreClassroom,
  sendTeacherSpeech
} from "./api";
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
  ClassroomState
} from "./types";

const defaultConfig: ClassroomConfig = {
  subject: "数学",
  grade: "初中",
  topic: "分数的意义",
  classType: "普通班",
  trainingGoal: "提问训练",
  difficulty: "普通",
  specialTrainingMode: "综合训练"
};
const classroomSnapshotKey = "yishixun.classroom.latest";

type ClassroomStatusTone = "info" | "loading" | "success" | "error";

type ClassroomTrainingPageProps = {
  selectedKnowledgeBaseIds?: string[];
  onOpenMaterials?: () => void;
};

export function ClassroomTrainingPage({
  selectedKnowledgeBaseIds = [],
  onOpenMaterials
}: ClassroomTrainingPageProps) {
  const [config, setConfig] = useState<ClassroomConfig>(defaultConfig);
  const [classroom, setClassroom] = useState<ClassroomState>();
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
    const cachedClassroom = readCachedClassroom();

    if (!cachedClassroom) {
      return;
    }

    setClassroom(cachedClassroom);
    setConfig(classroomToConfig(cachedClassroom));
    setSelectedStudentId(cachedClassroom.students[0]?.id);
    setStatusMessage("已恢复最近一次虚拟课堂，正在确认课堂会话状态...", "loading");

    void syncCachedClassroom(cachedClassroom);
  }, []);

  useEffect(() => {
    classroomRef.current = classroom;

    if (classroom) {
      cacheClassroom(classroom);
    }
  }, [classroom]);

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
    setStatusMessage("正在生成虚拟班级画像...", "loading");
    setReport(undefined);
    setReportArtifact(undefined);
    setReportCitations([]);

    try {
      const payload = await createClassroom({
        ...config,
        knowledgeBaseIds: selectedKnowledgeBaseIds
      });
      setClassroom(payload.classroomState);
      setSelectedStudentId(payload.classroomState.students[0]?.id);
      setStatusMessage("虚拟课堂已生成，可以开始试讲。", "success");
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
    if (!classroom || !text.trim()) {
      return;
    }

    setIsWorking(true);
    setStatusMessage("虚拟学生正在根据教师表现作出反应...", "loading");

    try {
      const payload = await sendTeacherSpeech(classroom.sessionId, text);
      setClassroom(payload.classroomState);
      setTeacherText("");
      setInterimTranscript("");
      setVoiceTimelineText("");
      setStatusMessage(payload.observerTips[0] || "课堂状态已更新。", "success");
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "教师发言处理失败。",
        "error"
      );
    } finally {
      setIsWorking(false);
    }
  }

  async function handleFinishTraining() {
    if (!classroom) {
      return;
    }

    setIsWorking(true);
    setStatusMessage(
      "正在汇总课堂证据链、Agent 决策依据和 Word 报告，模型增强较慢时会自动回退本地规则。",
      "loading"
    );

    try {
      const payload = await requestClassroomReport(classroom.sessionId);
      setReport(payload.report);
      setReportArtifact(payload.artifact);
      setReportCitations(payload.citations || []);
      if (!payload.saveError) {
        clearCachedClassroom();
      }
      setStatusMessage(
        payload.saveError
          ? `诊断报告已生成，但保存历史记录失败：${payload.saveError}。课堂状态已保留，可再次点击完成训练重试。`
          : payload.artifact
            ? `诊断报告已生成，并已保存 Word 成果：${payload.artifact.name}。`
            : "诊断报告已生成，历史记录已保存；Word 成果未返回，可再次点击完成训练重试。",
        payload.saveError ? "error" : "success"
      );
    } catch (error) {
      setStatusMessage(
        error instanceof Error
          ? `${error.message} 课堂状态已保留，可稍后再次点击完成训练重试。`
          : "诊断报告生成失败，课堂状态已保留，可稍后重试。",
        "error"
      );
    } finally {
      setIsWorking(false);
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
      if (!classroomRef.current || isWorkingRef.current) {
        setVoiceStatus("系统正在处理上一句讲课内容，本句已保留在输入框。");
        return;
      }

      void handleSend(cleaned);
    }, 1200);
  }

  function disabledByState() {
    return !classroom || isWorking;
  }

  async function syncCachedClassroom(cachedClassroom: ClassroomState) {
    try {
      const payload = await getClassroom(cachedClassroom.sessionId);
      setClassroom(payload.classroomState);
      setSelectedStudentId(
        (current) => current || payload.classroomState.students[0]?.id
      );
      setStatusMessage("已恢复最近一次虚拟课堂，可继续试讲。", "success");
    } catch {
      try {
        const payload = await restoreClassroom(cachedClassroom);
        setClassroom(payload.classroomState);
        setSelectedStudentId(
          (current) => current || payload.classroomState.students[0]?.id
        );
        setStatusMessage("已用本地快照恢复课堂会话，可继续试讲。", "success");
      } catch {
        clearCachedClassroom();
        setClassroom(undefined);
        setStatusMessage("最近课堂已过期，请重新生成虚拟课堂。", "error");
      }
    }
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
        disabled={!classroom || isWorking}
        onSelectStudent={setSelectedStudentId}
        onAction={(actionType) => handleDraftAction(actionType)}
      />

      <TeacherInputBar
        value={teacherText}
        disabled={!classroom}
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

function cacheClassroom(classroom: ClassroomState) {
  try {
    window.localStorage.setItem(classroomSnapshotKey, JSON.stringify(classroom));
  } catch {
    // Local storage can be unavailable in restricted browser contexts.
  }
}

function clearCachedClassroom() {
  try {
    window.localStorage.removeItem(classroomSnapshotKey);
  } catch {
    // Local storage can be unavailable in restricted browser contexts.
  }
}

function readCachedClassroom() {
  try {
    const raw = window.localStorage.getItem(classroomSnapshotKey);

    if (!raw) {
      return undefined;
    }

    const parsed = JSON.parse(raw) as ClassroomState;

    if (!parsed?.sessionId || !Array.isArray(parsed.students)) {
      return undefined;
    }

    return parsed;
  } catch {
    return undefined;
  }
}
