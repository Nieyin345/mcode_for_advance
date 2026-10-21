/**
 * T64 — the editable *wording* of the workflow framework.
 *
 * Dynamic graph facts, model-decision protocols, permission policy and memory
 * injection are NOT editable. Defaults below are the original schedulerPrompt
 * literals: untouched installations keep byte-for-byte prompt output.
 */
export const FRAMEWORK_SECTIONS = [
  {
    id: "flow",
    title: "整条流程",
    default: "本流程共 {{total}} 步,每一步由一名独立的助手完成,彼此之间不共享上下文。你负责其中一步:",
    editable: true,
    description: "调整流程位置的引导话术。{{total}} 会替换为实际步骤数；步骤列表和权限规则由系统生成。",
  },
  {
    id: "output",
    title: "产出的样子",
    default: "## 这一步要产出什么",
    editable: true,
    description: "调整产出要求这一节的开头；变量名及格式约束仍由系统生成。",
  },
  {
    id: "memory",
    title: "记忆快照",
    default: "",
    editable: false,
    description: "系统按当前任务动态检索并注入记忆，修改会破坏上下文边界，因此不可编辑。",
  },
  {
    id: "protocol",
    title: "权限与工具协议",
    default: "",
    editable: false,
    description: "权限、固定条件、工具/决策协议是执行约束，不能用提示词设置覆盖。",
  },
] as const;

export type FrameworkSectionId = (typeof FRAMEWORK_SECTIONS)[number]["id"];
export type EditableFrameworkSectionId = "flow" | "output";
export type FrameworkOverrides = Partial<Record<EditableFrameworkSectionId, string>>;

/** A user file containing whitespace means default, never an empty prompt. */
export function frameworkText(
  id: EditableFrameworkSectionId,
  overrides: FrameworkOverrides | undefined,
): string {
  const section = FRAMEWORK_SECTIONS.find((candidate) => candidate.id === id);
  if (!section || !section.editable) throw new Error(`不可编辑的框架段落: ${id}`);
  const text = overrides?.[id];
  return text && text.trim().length > 0 ? text : section.default;
}
