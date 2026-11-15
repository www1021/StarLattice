import type { HumanField } from "../types.js";

/**
 * 选项卡提交时用的固定字段名。
 * 前端靠它认出「这不是一列表单，而是几个能点的按钮」。
 */
export const CHOICE_FIELD_KEY = "choice";

function textOf(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    // 展示名优先：label / text / name 都像「给人看的」；value 只在没有别的字段时兜底。
    const candidate = record.label ?? record.text ?? record.name ?? record.value;
    return typeof candidate === "string" ? candidate : "";
  }
  return String(value);
}

/**
 * 选项统一收敛成字符串数组：去空白、去重、丢掉空项。
 * 动态来源可能直接是字符串数组，也可能是 [{ label }] 这种对象数组——
 * 后者在业务里很常见（下拉选项同时带 value 与展示名），这里只取展示名。
 */
export function normalizeChoices(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const list: string[] = [];
  for (const item of value) {
    const text = textOf(item).trim();
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    list.push(text);
  }
  return list;
}

/**
 * 把选项折成表单里的一个 select 字段，排在最前面：
 * 它就是用户真正要点的那个东西，其余字段只是附加输入。
 */
export function withChoiceField(fields: HumanField[], choices: string[]): HumanField[] {
  if (choices.length === 0) {
    return fields;
  }
  return [
    {
      key: CHOICE_FIELD_KEY,
      label: "选择",
      type: "select",
      required: true,
      options: choices,
      description: "选中一项后提交，运行会按这项继续。"
    },
    ...fields.filter((field) => field.key !== CHOICE_FIELD_KEY)
  ];
}
