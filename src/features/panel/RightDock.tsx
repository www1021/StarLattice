import type { ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Bot, Brain, Check, ChevronRight, Split, X } from "lucide-react";
import type { AgentRecord } from "../platform/types";
import type { WorkflowChatOption } from "../workflowChat/session";
import { AgentAvatar } from "../agents/AgentAvatar";
import type { DockTab } from "./panelLayout";

type RightDockProps = {
  open: boolean;
  tab: DockTab;
  onTabChange: (tab: DockTab) => void;
  onToggle: () => void;
  agents: AgentRecord[];
  activeAgentId: string;
  onPickAgent: (id: string) => void;
  workflows: WorkflowChatOption[];
  activeWorkflowId: string;
  workflowChatOn: boolean;
  onPickWorkflow: (id: string) => void;
  onOpenRegistry: () => void;
  onOpenPlatform: () => void;
  /** 思考/文件标签里的内容，由调用方复用已有的洞察组件 */
  insightContent: ReactNode;
  hasInsight: boolean;
  generating: boolean;
};

const TABS: Array<{ key: DockTab; label: string; icon: typeof Bot }> = [
  { key: "agents", label: "智能体", icon: Bot },
  { key: "workflows", label: "工作流", icon: Split },
  { key: "insight", label: "思考文件", icon: Brain }
];

export function RightDock({
  open,
  tab,
  onTabChange,
  onToggle,
  agents,
  activeAgentId,
  onPickAgent,
  workflows,
  activeWorkflowId,
  workflowChatOn,
  onPickWorkflow,
  onOpenRegistry,
  onOpenPlatform,
  insightContent,
  hasInsight,
  generating
}: RightDockProps) {
  return (
    <>
      {!open ? (
        <button
          className="dock-rail"
          type="button"
          aria-label="展开智能体与工作流面板"
          title="展开智能体与工作流面板"
          onClick={onToggle}
        >
          <ChevronRight size={17} strokeWidth={2.4} />
          <span>智能体 / 工作流</span>
        </button>
      ) : null}

      <AnimatePresence>
        {open ? (
          <motion.div
            className="insight-layer"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
          >
            <motion.aside
              className="insight-panel right-dock"
              aria-label="智能体与工作流面板"
              initial={{ x: 40, opacity: 0, scale: 0.99 }}
              animate={{ x: 0, opacity: 1, scale: 1 }}
              exit={{ x: 40, opacity: 0, scale: 0.99 }}
              transition={{ type: "spring", stiffness: 380, damping: 34 }}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="insight-header">
                <div>
                  <span className="insight-kicker">AI Workspace</span>
                  <h2>智能体与工作流</h2>
                </div>
                <button
                  className="insight-close"
                  type="button"
                  aria-label="收起侧边面板"
                  title="收起面板"
                  onClick={onToggle}
                >
                  <X size={18} strokeWidth={2.4} />
                </button>
              </div>

              <div className="dock-tabs" role="tablist" aria-label="侧栏内容">
                {TABS.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.key}
                      className={tab === item.key ? "dock-tab dock-tab-active" : "dock-tab"}
                      type="button"
                      role="tab"
                      aria-selected={tab === item.key}
                      onClick={() => onTabChange(item.key)}
                    >
                      <Icon size={16} strokeWidth={2.2} />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </div>

              <div className="dock-body">
                {tab === "agents" ? (
                  <div className="dock-list">
                    <p className="dock-hint">选一个智能体，切过去就能直接对话。</p>
                    <button
                      className={`dock-card ${!activeAgentId ? "dock-card-active" : ""}`}
                      type="button"
                      disabled={generating}
                      onClick={() => onPickAgent("")}
                    >
                      <span className="dock-card-avatar dock-card-avatar-default">
                        <Bot size={19} strokeWidth={2.2} />
                      </span>
                      <span className="dock-card-main">
                        <strong>默认助手</strong>
                        <small>平台通用助手，不绑定自定义角色</small>
                      </span>
                      {!activeAgentId ? (
                        <Check size={16} strokeWidth={2.6} className="dock-card-check" />
                      ) : null}
                    </button>
                    {agents.map((agent) => (
                      <button
                        key={agent.id}
                        className={`dock-card ${
                          activeAgentId === agent.id ? "dock-card-active" : ""
                        }`}
                        type="button"
                        disabled={generating}
                        onClick={() => onPickAgent(agent.id)}
                      >
                        <span className="dock-card-avatar">
                          <AgentAvatar name={agent.name} avatar={agent.avatar} size={30} />
                        </span>
                        <span className="dock-card-main">
                          <strong>{agent.name}</strong>
                          <small>
                            {agent.description?.trim() ||
                              agent.role?.trim() ||
                              "按自定义提示词回答"}
                          </small>
                        </span>
                        {activeAgentId === agent.id ? (
                          <Check size={16} strokeWidth={2.6} className="dock-card-check" />
                        ) : null}
                      </button>
                    ))}
                    {!agents.length ? (
                      <p className="dock-empty">还没有自建智能体，去注册中心创建一个。</p>
                    ) : null}
                    <button className="dock-manage" type="button" onClick={onOpenRegistry}>
                      管理智能体 <ChevronRight size={15} strokeWidth={2.4} />
                    </button>
                  </div>
                ) : null}

                {tab === "workflows" ? (
                  <div className="dock-list">
                    <p className="dock-hint">绑定工作流后，给出具体任务就会跑一遍流程。</p>
                    {workflows.map((workflow) => {
                      const active = workflowChatOn && activeWorkflowId === workflow.id;
                      return (
                        <button
                          key={workflow.id}
                          className={`dock-card ${active ? "dock-card-active" : ""}`}
                          type="button"
                          disabled={generating}
                          onClick={() => onPickWorkflow(workflow.id)}
                        >
                          <span className="dock-card-avatar dock-card-avatar-default">
                            <Split size={18} strokeWidth={2.2} />
                          </span>
                          <span className="dock-card-main">
                            <strong>{workflow.name}</strong>
                            <small>{active ? "当前对话已绑定这条工作流" : workflow.id}</small>
                          </span>
                          {active ? (
                            <Check size={16} strokeWidth={2.6} className="dock-card-check" />
                          ) : null}
                        </button>
                      );
                    })}
                    {!workflows.length ? (
                      <p className="dock-empty">工作流列表为空，去平台搭一条流程。</p>
                    ) : null}
                    <button className="dock-manage" type="button" onClick={onOpenPlatform}>
                      管理工作流 <ChevronRight size={15} strokeWidth={2.4} />
                    </button>
                  </div>
                ) : null}

                {tab === "insight" ? (
                  hasInsight ? (
                    insightContent
                  ) : (
                    <div className="dock-insight-empty">
                      <Brain size={26} strokeWidth={1.8} />
                      <p>点一条回复上方的「思考」按钮，这里会显示思考摘要和生成文件。</p>
                    </div>
                  )
                ) : null}
              </div>
            </motion.aside>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}
