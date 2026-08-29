import { BookOpen, Download, X } from "lucide-react";
import type { ClassroomArtifact, ClassroomCitation, ClassroomReport } from "../types";

type ClassroomReportPanelProps = {
  report: ClassroomReport;
  artifact?: ClassroomArtifact;
  citations?: ClassroomCitation[];
  onOpenMaterials?: () => void;
  onClose: () => void;
};

const eventTypeLabels: Record<ClassroomReport["eventReview"][number]["type"], string> = {
  wrong_answer: "错误答案",
  no_response: "无人回应",
  off_topic: "跑题",
  time_risk: "进度风险",
  discipline_issue: "纪律波动"
};

export function ClassroomReportPanel({
  report,
  artifact,
  citations = [],
  onOpenMaterials,
  onClose
}: ClassroomReportPanelProps) {
  const pendingEventCount = report.eventReview.filter((event) => !event.handled).length;

  return (
    <section className="classroom-report-panel" aria-label="课后诊断报告">
      <header>
        <div>
          <span>课后诊断报告</span>
          <h2>{report.overallScore} 分</h2>
          <p>{report.summary}</p>
          <div className="report-summary-stats" aria-label="报告关键指标">
            <span>{report.dimensionScores.length} 项维度</span>
            <span>{report.evidenceChains.length} 条证据链</span>
            <span>{pendingEventCount ? `${pendingEventCount} 个待处理事件` : "事件已复盘"}</span>
            <span>{report.agentDecisionEvidence?.length || 0} 条 Agent 依据</span>
          </div>
          <small>
            {report.providerMode === "llm" ? "真实 LLM 增强诊断" : "规则引擎诊断"}
            {report.savedConversationId ? " · 已保存到历史记录与成长档案" : ""}
            {artifact ? " · Word 成果已生成" : ""}
          </small>
          {artifact ? (
            <a className="report-artifact-link" href={artifact.url} target="_blank" rel="noreferrer">
              <Download size={16} strokeWidth={2.2} />
              <span>{artifact.name}</span>
            </a>
          ) : (
            <p className="report-artifact-empty">报告已生成；若 Word 成果未出现，可再次点击完成训练重试保存。</p>
          )}
        </div>
        <button type="button" onClick={onClose} aria-label="关闭诊断报告">
          <X size={20} strokeWidth={2.2} />
        </button>
      </header>
      <div className="report-grid">
        <section className="report-evidence-chain">
          <strong>课堂证据链</strong>
          <div className="evidence-chain-list">
            {report.evidenceChains.length ? (
              report.evidenceChains.map((chain) => (
                <article key={chain.id}>
                  <span>{chain.studentAgent}</span>
                  <p>教师行为：{chain.teacherMove}</p>
                  <p>学生反应：{chain.studentResponse}</p>
                  <small>{chain.eventOrMetric}</small>
                  <small>{chain.observerAdvice}</small>
                </article>
              ))
            ) : (
              <p className="classroom-empty">完成更多互动后会形成课堂证据链。</p>
            )}
          </div>
        </section>
        <section className="report-sources">
          <div className="report-sources-heading">
            <strong>本次参考资料</strong>
            {onOpenMaterials ? (
              <button type="button" onClick={onOpenMaterials}>
                <BookOpen size={15} strokeWidth={2.1} />
                回看资料
              </button>
            ) : null}
          </div>
          {citations.length ? (
            <div className="report-sources-list">
              {citations.slice(0, 3).map((citation) => (
                <article key={citation.id}>
                  <span>{citation.documentName}</span>
                  <small>{citation.knowledgeBaseName}</small>
                  <p>{citation.snippet}</p>
                </article>
              ))}
            </div>
          ) : (
            <p className="classroom-empty">本次未引用资料，课堂训练基于通用训练框架进行。</p>
          )}
        </section>
        <section>
          <strong>六项能力评分</strong>
          <div className="report-dimensions">
            {report.dimensionScores.map((dimension) => (
              <article key={dimension.name}>
                <div>
                  <span>{dimension.name}</span>
                  <b>{dimension.score}</b>
                </div>
                <i>
                  <em style={{ width: `${dimension.score}%` }} />
                </i>
                <p>{dimension.comment}</p>
              </article>
            ))}
          </div>
        </section>
        <section>
          <strong>关键事件回顾</strong>
          <div className="report-events">
            {report.eventReview.length ? (
              report.eventReview.map((event, index) => (
                <article key={`${event.type}-${index}`}>
                  <span>
                    {eventTypeLabels[event.type]} · {event.handled ? "已处理" : "待改进"}
                  </span>
                  <p>{event.description}</p>
                  <small>{event.comment}</small>
                </article>
              ))
            ) : (
              <p className="classroom-empty">本轮未触发明显突发事件。</p>
            )}
          </div>
        </section>
        <ReportList title="优点总结" items={report.strengths} />
        <ReportList title="问题诊断" items={report.issues} />
        <ReportList title="改进建议" items={report.suggestions} />
        <section className="report-next-task">
          <strong>下一轮训练任务</strong>
          <p>{report.nextTrainingTask}</p>
        </section>
      </div>
    </section>
  );
}

function ReportList({ title, items }: { title: string; items: string[] }) {
  return (
    <section>
      <strong>{title}</strong>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}
