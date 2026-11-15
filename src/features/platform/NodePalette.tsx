import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Layers3, ListTree, Pencil, Plus, Search, X } from "lucide-react";
import { NODE_CATEGORIES, NODE_VISUALS, nodeTintStyle } from "./nodeVisuals";
import type { NodeKind, NodeTypeSpec, WorkflowVariable } from "./types";

type PaletteTab = "nodes" | "templates" | "inputs";

type NodePaletteProps = {
  specs: NodeTypeSpec[];
  open: boolean;
  onToggle: () => void;
  onAdd: (kind: NodeKind) => void;
  inputs: WorkflowVariable[];
  onOpenInputs: () => void;
  /** 模板卡片由画布页注入，避免在这里反向依赖页面组件。 */
  templateSlot: ReactNode;
};

const TABS: { id: PaletteTab; label: string }[] = [
  { id: "nodes", label: "节点" },
  { id: "templates", label: "模板" },
  { id: "inputs", label: "输入" }
];

export function NodePalette({
  specs,
  open,
  onToggle,
  onAdd,
  inputs,
  onOpenInputs,
  templateSlot
}: NodePaletteProps) {
  const [tab, setTab] = useState<PaletteTab>("nodes");
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) {
      return specs;
    }
    return specs.filter(
      (spec) =>
        spec.label.toLowerCase().includes(keyword) ||
        spec.kind.toLowerCase().includes(keyword) ||
        spec.description.toLowerCase().includes(keyword)
    );
  }, [query, specs]);

  if (!open) {
    return (
      <aside className="platform-palette is-collapsed">
        <button
          type="button"
          className="platform-palette-toggle"
          onClick={onToggle}
          title="展开面板"
          aria-label="展开节点面板"
        >
          <Layers3 size={17} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="platform-palette">
      <header className="platform-palette-head">
        <div className="platform-palette-tabs" role="tablist" aria-label="画布侧栏">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className={`platform-palette-tab${tab === item.id ? " is-active" : ""}`}
              onClick={() => setTab(item.id)}
            >
              {item.label}
              {item.id === "inputs" && inputs.length > 0 ? (
                <span className="platform-palette-tab-count">{inputs.length}</span>
              ) : null}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="platform-palette-toggle"
          onClick={onToggle}
          title="收起面板"
          aria-label="收起节点面板"
        >
          <X size={15} />
        </button>
      </header>

      {tab === "nodes" && (
        <>
          <label className="platform-palette-search">
            <Search size={13} />
            <input
              value={query}
              placeholder="搜索节点"
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query && (
              <button type="button" aria-label="清空搜索" onClick={() => setQuery("")}>
                <X size={12} />
              </button>
            )}
          </label>

          <div className="platform-palette-list">
            {NODE_CATEGORIES.map((category) => {
              const items = filtered.filter((spec) => NODE_VISUALS[spec.kind].category === category.id);
              if (items.length === 0) {
                return null;
              }
              return (
                <section className="platform-palette-group" key={category.id}>
                  <h4>{category.label}</h4>
                  {items.map((spec) => {
                    const Icon = NODE_VISUALS[spec.kind].icon;
                    return (
                      <button
                        key={spec.kind}
                        type="button"
                        className="platform-palette-item"
                        title={spec.description}
                        draggable
                        onDragStart={(event) => {
                          event.dataTransfer.setData("application/x-platform-node", spec.kind);
                          event.dataTransfer.effectAllowed = "move";
                        }}
                        onClick={() => onAdd(spec.kind)}
                      >
                        <span className="platform-palette-icon" style={nodeTintStyle(spec.kind)}>
                          <Icon size={13} strokeWidth={2.1} />
                        </span>
                        <span className="platform-palette-text">
                          <strong>{spec.label}</strong>
                          <small>{spec.description}</small>
                        </span>
                        <Plus size={13} className="platform-palette-plus" />
                      </button>
                    );
                  })}
                </section>
              );
            })}
            {filtered.length === 0 && <p className="platform-palette-empty">没有匹配的节点。</p>}
          </div>
        </>
      )}

      {tab === "templates" && (
        <div className="platform-palette-list is-plain">
          <p className="platform-palette-note">套用模板会替换当前画布的节点与连线，先确认未保存的修改。</p>
          {templateSlot}
        </div>
      )}

      {tab === "inputs" && (
        <div className="platform-palette-list is-plain">
          {inputs.length === 0 ? (
            <p className="platform-palette-empty">还没有输入。工作流可以没有任何输入。</p>
          ) : (
            <div className="platform-input-chips">
              {inputs.map((variable) => (
                <div className="platform-input-chip" key={variable.name}>
                  <code>{variable.name}</code>
                  <em>{variable.type}</em>
                  {variable.required ? <i>必填</i> : null}
                </div>
              ))}
            </div>
          )}
          <button type="button" className="platform-palette-action" onClick={onOpenInputs}>
            <Pencil size={12} />
            编辑输入定义
          </button>
          <p className="platform-palette-note">
            <ListTree size={11} /> 运行面板按这里的定义生成字段。
          </p>
        </div>
      )}
    </aside>
  );
}
