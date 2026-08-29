import { useEffect, useRef } from "react";
import type { ClassroomEvent, ClassroomMetrics } from "../types";

type ClassroomMetricsPanelProps = {
  metrics?: ClassroomMetrics;
  events: ClassroomEvent[];
  currentStage?: string;
};

const metricLabels: Array<[keyof ClassroomMetrics, string]> = [
  ["participation", "学生参与度"],
  ["understanding", "学生理解度"],
  ["discipline", "纪律状态"],
  ["progress", "教学进度"],
  ["interactionQuality", "互动质量"],
  ["goalAchievement", "目标达成度"]
];

const eventTypeLabels: Record<ClassroomEvent["type"], string> = {
  wrong_answer: "错误答案",
  no_response: "无人回应",
  off_topic: "跑题",
  time_risk: "进度风险",
  discipline_issue: "纪律波动"
};

export function ClassroomMetricsPanel({
  metrics,
  events,
  currentStage = "未知"
}: ClassroomMetricsPanelProps) {
  const eventListRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const eventList = eventListRef.current;

    if (!eventList) {
      return;
    }

    eventList.scrollTo({
      top: eventList.scrollHeight,
      behavior: "smooth"
    });
  }, [events.length]);

  return (
    <aside className="classroom-metrics-panel" aria-label="课堂状态面板">
      <header>
        <strong>课堂状态</strong>
        <span>当前阶段：{currentStage}</span>
      </header>
      <div className="metric-list">
        {metricLabels.map(([key, label]) => {
          const value = metrics?.[key] ?? 0;

          return (
            <div className="metric-row" key={key}>
              <div>
                <span>{label}</span>
                <b>{value}%</b>
              </div>
              <i>
                <em style={{ width: `${value}%` }} />
              </i>
            </div>
          );
        })}
      </div>
      <section className="classroom-event-list">
        <strong>课堂事件</strong>
        <div className="classroom-event-scroll" ref={eventListRef} tabIndex={0} aria-label="课堂事件记录">
          {events.length ? (
            events.map((event) => (
              <article className={event.handled ? "handled" : ""} key={event.id}>
                <span>
                  {eventTypeLabels[event.type]} · {event.handled ? "已处理" : event.severity}
                </span>
                <p>{event.description}</p>
              </article>
            ))
          ) : (
            <p className="classroom-empty">
              当前未触发突发事件。继续提问、追问或组织活动后，事件 Agent 会记录沉默、答错、跑题、纪律和进度风险。
            </p>
          )}
        </div>
      </section>
    </aside>
  );
}
