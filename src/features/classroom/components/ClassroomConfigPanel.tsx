import { Wand2 } from "lucide-react";
import type { ClassroomConfig, ClassroomState } from "../types";

type ClassroomConfigPanelProps = {
  config: ClassroomConfig;
  classroom?: ClassroomState;
  isLoading: boolean;
  onChange: (patch: Partial<ClassroomConfig>) => void;
  onCreate: () => void;
};

const subjects = ["语文", "数学", "英语", "思政", "科学"];
const grades = ["小学", "初中", "高中"];
const classTypes = ["普通班", "基础薄弱班", "活跃班", "纪律较差班"];
const goals = ["课堂导入训练", "提问训练", "控场训练", "活动组织训练", "课堂总结训练"];
const difficulties = ["简单", "普通", "挑战"];
const specialModes = [
  "综合训练",
  "错误答案引导训练",
  "控场专项训练",
  "基础薄弱学生讲解训练",
  "课堂提问设计训练",
  "小组活动组织训练"
];

export function ClassroomConfigPanel({
  config,
  classroom,
  isLoading,
  onChange,
  onCreate
}: ClassroomConfigPanelProps) {
  return (
    <section className="classroom-config-panel" aria-label="课堂场景配置">
      <div className="classroom-config-grid">
        <SelectField
          label="学科"
          value={config.subject}
          options={subjects}
          onChange={(subject) => onChange({ subject })}
        />
        <SelectField
          label="年级"
          value={config.grade}
          options={grades}
          onChange={(grade) => onChange({ grade })}
        />
        <label>
          <span>课题</span>
          <input
            value={config.topic}
            onChange={(event) => onChange({ topic: event.target.value })}
            placeholder="如：分数的意义"
          />
        </label>
        <SelectField
          label="班级类型"
          value={config.classType}
          options={classTypes}
          onChange={(classType) => onChange({ classType })}
        />
        <SelectField
          label="训练目标"
          value={config.trainingGoal}
          options={goals}
          onChange={(trainingGoal) => onChange({ trainingGoal })}
        />
        <SelectField
          label="难度"
          value={config.difficulty}
          options={difficulties}
          onChange={(difficulty) => onChange({ difficulty })}
        />
        <SelectField
          label="专项模式"
          value={config.specialTrainingMode || "综合训练"}
          options={specialModes}
          onChange={(specialTrainingMode) => onChange({ specialTrainingMode })}
        />
      </div>
      {!classroom ? (
        <div className="classroom-config-actions">
          <button className="classroom-create-button" type="button" onClick={onCreate} disabled={isLoading}>
            <Wand2 size={18} strokeWidth={2.2} />
            <span>{isLoading ? "正在生成课堂" : "生成虚拟课堂"}</span>
          </button>
        </div>
      ) : null}
    </section>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}
