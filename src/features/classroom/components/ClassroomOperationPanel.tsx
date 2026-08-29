import { Hand, MessageSquareQuote, ShieldAlert, TimerReset, Users } from "lucide-react";
import type { ReactNode } from "react";
import type { ClassroomActionType, ClassroomEvent, StudentAgent } from "../types";

type ClassroomOperationPanelProps = {
  students: StudentAgent[];
  events: ClassroomEvent[];
  turnCount: number;
  selectedStudentId?: string;
  disabled: boolean;
  onSelectStudent: (studentId: string) => void;
  onAction: (actionType: ClassroomActionType) => void;
};

export function ClassroomOperationPanel({
  students,
  events,
  turnCount,
  selectedStudentId,
  disabled,
  onSelectStudent,
  onAction
}: ClassroomOperationPanelProps) {
  const hasStudents = students.length > 0;
  const hasManagementNeed = events.some(
    (event) =>
      !event.handled && (event.type === "off_topic" || event.type === "discipline_issue")
  );
  const hasTimeRisk = events.some(
    (event) => !event.handled && event.type === "time_risk"
  );
  const canSummarize = turnCount >= 3 || hasTimeRisk;

  return (
    <section className="classroom-operation-panel" aria-label="课堂操作区">
      <section className="classroom-operation-group" aria-label="个别互动">
        <div className="classroom-operation-heading">
          <div>
            <strong>个别互动</strong>
            <span>先选择学生，点击后在输入框生成话术，确认后发送。</span>
          </div>
        </div>
        <label>
          <span>点名对象</span>
          <select
            value={selectedStudentId || ""}
            disabled={disabled || !hasStudents}
            onChange={(event) => onSelectStudent(event.target.value)}
          >
            <option value="">请选择学生</option>
            {students.map((student) => (
              <option key={student.id} value={student.id}>
                {student.name} · {studentTypeLabel(student.type)}
              </option>
            ))}
          </select>
        </label>
        {!hasStudents ? (
          <p className="classroom-empty">生成课堂后可点名、追问或处理课堂事件。</p>
        ) : null}
        <div className="classroom-operation-actions">
          <OperationButton
            icon={<Hand size={16} strokeWidth={2.2} />}
            label="点名回答"
            description="生成让选中学生单独回答的话术"
            disabled={disabled || !selectedStudentId}
            onClick={() => onAction("call_on_student")}
          />
          <OperationButton
            icon={<MessageSquareQuote size={16} strokeWidth={2.2} />}
            label="追问理由"
            description="生成追问选中学生依据的话术"
            disabled={disabled || !selectedStudentId}
            onClick={() => onAction("follow_up_student")}
          />
        </div>
      </section>

      <section className="classroom-operation-group" aria-label="全班组织">
        <div className="classroom-operation-heading">
          <div>
            <strong>全班组织</strong>
            <span>面向全体学生，点击后在输入框生成话术，确认后发送。</span>
          </div>
        </div>
        <div className="classroom-operation-actions">
          <OperationButton
            icon={<Users size={16} strokeWidth={2.2} />}
            label="发起同伴讨论"
            description="生成同桌讨论活动的话术"
            disabled={disabled}
            onClick={() => onAction("start_group_activity")}
          />
          {canSummarize ? (
            <OperationButton
              icon={<TimerReset size={16} strokeWidth={2.2} />}
              label="进入课堂小结"
              description="生成只保留核心结论的收束话术"
              disabled={disabled}
              onClick={() => onAction("compress_summary")}
            />
          ) : null}
        </div>
        {hasManagementNeed ? (
          <div className="classroom-context-action" role="status">
            <div>
              <strong>当前需要控场</strong>
              <span>检测到跑题或纪律波动，可先将全班注意力拉回任务。</span>
            </div>
            <OperationButton
              icon={<ShieldAlert size={16} strokeWidth={2.2} />}
              label="提醒全班回到任务"
              description="生成拉回全班注意力的控场话术"
              disabled={disabled}
              onClick={() => onAction("pause_and_manage")}
            />
          </div>
        ) : null}
      </section>
    </section>
  );
}

function OperationButton({
  icon,
  label,
  description,
  disabled,
  onClick
}: {
  icon: ReactNode;
  label: string;
  description: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" disabled={disabled} onClick={onClick}>
      <span className="operation-card-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="operation-card-text">
        <strong>{label}</strong>
        <span>{description}</span>
      </span>
    </button>
  );
}

function studentTypeLabel(type: StudentAgent["type"]) {
  if (type === "top_student") {
    return "学霸型";
  }

  if (type === "weak_student") {
    return "基础薄弱型";
  }

  if (type === "silent_student") {
    return "沉默型";
  }

  if (type === "naughty_student") {
    return "调皮型";
  }

  return "误解型";
}
