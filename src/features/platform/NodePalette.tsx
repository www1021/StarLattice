import { useMemo, useState } from "react";
import { Layers3, Plus, Search, X } from "lucide-react";
import { NODE_CATEGORIES, NODE_VISUALS } from "./nodeVisuals";
import type { NodeKind, NodeTypeSpec } from "./types";

type NodePaletteProps = {
  specs: NodeTypeSpec[];
  open: boolean;
  onToggle: () => void;
  onAdd: (kind: NodeKind) => void;
};

export function NodePalette({ specs, open, onToggle, onAdd }: NodePaletteProps) {
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
          title="展开节点库"
          aria-label="展开节点库"
        >
          <Layers3 size={17} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="platform-palette">
      <header className="platform-palette-head">
        <div>
          <strong>节点库</strong>
          <small>{specs.length} 类 · 点击或拖入画布</small>
        </div>
        <button
          type="button"
          className="platform-palette-toggle"
          onClick={onToggle}
          title="收起节点库"
          aria-label="收起节点库"
        >
          <X size={15} />
        </button>
      </header>

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
                    <span
                      className="platform-palette-icon"
                      style={{
                        background: `${spec.accent}14`,
                        color: spec.accent
                      }}
                    >
                      <Icon size={15} strokeWidth={1.9} />
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
    </aside>
  );
}
