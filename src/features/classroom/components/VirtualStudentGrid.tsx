import { X } from "lucide-react";
import { useState } from "react";
import type { StudentAgent, StudentStatus, StudentType } from "../types";

type VirtualStudentGridProps = {
  students: StudentAgent[];
};

const typeLabels: Record<StudentType, string> = {
  top_student: "学霸型",
  weak_student: "基础薄弱型",
  silent_student: "沉默型",
  naughty_student: "调皮型",
  misunderstanding_student: "误解型"
};

const statusLabels: Record<StudentStatus, string> = {
  focused: "专注",
  confused: "困惑",
  silent: "沉默",
  active: "活跃",
  distracted: "分心"
};

export function VirtualStudentGrid({ students }: VirtualStudentGridProps) {
  const [profileStudentId, setProfileStudentId] = useState<string>();
  const profileStudent = students.find((student) => student.id === profileStudentId);

  return (
    <section className="classroom-students-panel" aria-label="虚拟学生座位区">
      <header>
        <strong>虚拟学生</strong>
        <span>{students.length ? `${students.length} 名学生 Agent` : "等待生成"}</span>
      </header>
      <div className="student-seat-grid">
        {students.length ? (
          students.map((student) => (
            <button
              className={`student-seat ${student.currentStatus}`}
              type="button"
              aria-pressed={profileStudentId === student.id}
              aria-label={`查看${student.name}的学生画像`}
              key={student.id}
              onClick={() => setProfileStudentId(student.id)}
            >
              <div className="student-avatar" aria-hidden="true">
                {student.name.slice(0, 1)}
              </div>
              <div>
                <strong>{student.name}</strong>
                <span>{typeLabels[student.type]}</span>
              </div>
              <small>{statusLabels[student.currentStatus]}</small>
              <p>{student.lastReaction || "等待课堂互动"}</p>
              <em>查看画像</em>
            </button>
          ))
        ) : (
          <p className="classroom-empty">
            生成虚拟课堂后，这里会出现不同基础、性格和误区的学生 Agent。
          </p>
        )}
      </div>
      {profileStudent ? (
        <section className="student-profile-overlay" role="dialog" aria-label={`${profileStudent.name} 学生画像`}>
          <header>
            <div>
              <span>{profileStudent.name} · {typeLabels[profileStudent.type]}</span>
              <strong>{statusLabels[profileStudent.currentStatus]} · {profileStudent.emotionState}</strong>
            </div>
            <button type="button" onClick={() => setProfileStudentId(undefined)} aria-label="关闭学生画像">
              <X size={17} strokeWidth={2.2} />
            </button>
          </header>
          <dl>
            <div>
              <dt>基础</dt>
              <dd>{profileStudent.knowledgeFoundation}</dd>
            </div>
            <div>
              <dt>意愿</dt>
              <dd>{profileStudent.participationWillingness}%</dd>
            </div>
            <div>
              <dt>误区</dt>
              <dd>{profileStudent.misconception}</dd>
            </div>
          </dl>
          <div className="student-profile-memory" aria-label={`${profileStudent.name} 最近互动记忆`}>
            <strong>最近互动</strong>
            {profileStudent.recentMemory?.length ? (
              profileStudent.recentMemory.slice(0, 2).map((memory) => (
                <p key={memory}>{memory}</p>
              ))
            ) : (
              <p>尚未产生互动记录。</p>
            )}
          </div>
        </section>
      ) : null}
    </section>
  );
}
