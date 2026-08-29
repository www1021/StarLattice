import { useEffect, useRef } from "react";
import { Bot, Megaphone, UserRound, UsersRound } from "lucide-react";
import type {
  AnswerQuality,
  ClassroomTimelineItem,
  TimelineRole
} from "../types";

type ClassroomTimelineProps = {
  items: ClassroomTimelineItem[];
  liveTeacherText?: string;
};

const roleLabels: Record<TimelineRole, string> = {
  teacher: "教师",
  student: "学生",
  observer: "观察员",
  system: "系统"
};

const answerQualityLabels: Record<AnswerQuality, string> = {
  acknowledgement: "课堂回应：问候",
  correct: "回答质量：正确",
  partial: "回答质量：部分理解",
  misconception: "回答质量：典型误区",
  silent: "回答质量：沉默",
  off_topic: "回答质量：跑题"
};

export function ClassroomTimeline({ items, liveTeacherText }: ClassroomTimelineProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const liveText = liveTeacherText?.trim();

  useEffect(() => {
    const list = listRef.current;

    if (!list) {
      return;
    }

    list.scrollTo({
      top: list.scrollHeight,
      behavior: "smooth"
    });
  }, [items.length, liveText]);

  return (
    <section className="classroom-timeline-panel" aria-label="课堂互动时间线">
      <header>
        <strong>课堂互动</strong>
        <span>教师发言、学生反应、观察员提示和课堂事件</span>
      </header>
      <div className="classroom-timeline-list" ref={listRef}>
        {items.length ? (
          items.map((item) => (
            <article className={`timeline-item ${item.role}`} key={item.id}>
              <div className="timeline-icon">{renderRoleIcon(item.role)}</div>
              <div>
                <span>{roleLabels[item.role]} · {item.speaker}</span>
                {item.role === "student" && item.answerQuality ? (
                  <div className="timeline-answer-tags">
                    <small>{answerQualityLabels[item.answerQuality]}</small>
                  </div>
                ) : null}
                <p>{item.content}</p>
              </div>
            </article>
          ))
        ) : (
          <p className="classroom-empty">
            发送第一句试讲后，教师发言、学生反应、观察员建议和课堂事件会按时间记录。
          </p>
        )}
        {liveText ? (
          <article className="timeline-item teacher live" aria-live="polite">
            <div className="timeline-icon">{renderRoleIcon("teacher")}</div>
            <div>
              <span>教师 · 正在讲课</span>
              <p>{liveText}</p>
            </div>
          </article>
        ) : null}
      </div>
    </section>
  );
}

function renderRoleIcon(role: TimelineRole) {
  if (role === "teacher") {
    return <UserRound size={17} strokeWidth={2.2} />;
  }

  if (role === "student") {
    return <UsersRound size={17} strokeWidth={2.2} />;
  }

  if (role === "observer") {
    return <Bot size={17} strokeWidth={2.2} />;
  }

  return <Megaphone size={17} strokeWidth={2.2} />;
}
