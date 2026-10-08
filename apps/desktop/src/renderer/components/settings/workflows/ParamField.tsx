/**
 * 一个**节点参数**的控件 —— 清单里的 `kind` 渲染成什么。
 *
 * ## 为什么单独一个文件
 *
 * 两处要用它:节点的检查器(`NodeInspector`)、以及代理档案的编辑器
 * (`AgentProfilesView`)。两份实现是**一定要漂移**的那种重复:今天加一种 `kind`,
 * 改了一处、忘了另一处,现象是"档案里能选的东西节点上没有" —— 而两边看代码都找不出
 * 问题。
 *
 * 更根本的是:档案和节点用的是**同一份参数规范**(那个节点类型的清单),所以"怎么把
 * 规范变成控件"本来就只该有一个答案。
 *
 * ## 引用型的候选取自哪里
 *
 * 从 `useRefOptions(spec.from)` —— 所以这里**不认识"模型"也不认识"技能"**:加一种新的
 * 来源改的是那个 hook,不是这里(见 `NODE_PARAM_REF_SOURCES`)。
 */
import { useContext, useId, useEffect, useRef, useState } from "react";
import { FieldLabelContext } from "@renderer/components/ui/field-label-context.js";
import { Menu } from "@base-ui/react/menu";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import type { MessageId } from "@renderer/lib/i18n/core.js";
import { Button, Input, Select, Switch, Tooltip } from "@renderer/components/ui/index.js";
import { api } from "@renderer/lib/api.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { NODE_PARAM_REF_SOURCES, type NodeParamSpec } from "@contracts/nodeType";
import {
  IconBraces,
  IconCheck,
  IconChevronDown,
  IconInfoCircle,
  IconPlus,
  IconX,
} from "@renderer/lib/icons.js";
import {
  insertSnippet,
  type InsertableGroup,
} from "./insertVariable.js";
import { CodeParamField } from "./CodeParamField.js";
import { useRefOptions, type RefOption } from "./useRefOptions.js";

/** 一个带标题的表单行。档案编辑器和节点检查器共用,所以标题的字号只有一份。
 *
 * ⚠️ **这里是 `<label>`,所以里面不能放"自己会变宽的块级元素"。**
 *
 * 原先它整行包在 `<label>` 里 —— 对「标题」那种一个 `<input>` 的行是对的(点标题也能
 * 聚焦),但这一格装的并不总是输入框:`kind: "boolean"` 渲染的是 `Switch`,而
 * `Switch` 的根是一个 `<span class="h-4 w-7">`。`<label>` 是**行内**元素,里面有块级
 * 兄弟时它的匿名行盒会塌成零宽,于是那个 28×16 的开关**量出来是 0×0** —— 点不到、
 * 看不见(实测:同一个元素挪出 label 立刻是 28×16)。用户报的「读取流程记录设置按钮,
 * 没有显示」就是它。
 *
 * 改成 `<div>`:标题是普通文本,点标题不再聚焦输入框 —— 这是这一处换来的代价,而它
 * 比"有个控件根本点不到"小得多。 */
export function Field({
  label,
  required,
  help,
  children,
}: {
  label: string;
  required?: boolean;
  /** 这一格的解释。**印在标题右侧的一个小图标上,鼠标停住一秒才浮出来** —— 不占版面,
   *  扫过去的时候也不抢注意力(见 {@link HelpHint})。 */
  help?: string;
  children: React.ReactNode;
}) {
  const labelId = useId();
  return (
    <div className="mb-2 block w-full">
      <span className="mb-0.5 flex items-center text-[0.7857em] font-medium text-content-muted">
        <span id={labelId}>{label}</span>
        {required && <span aria-hidden className="ml-0.5 text-warning">*</span>}
        {help !== undefined && help !== "" && <HelpHint text={help} />}
      </span>
      <FieldLabelContext.Provider value={labelId}>{children}</FieldLabelContext.Provider>
    </div>
  );
}

/**
 * 一个**解释**的悬停浮窗 —— 默认什么都不显示,鼠标停住**一秒**才浮出来。
 *
 * 为什么是一秒:这些解释动辄两三句,一列参数摆十几条的话,它们抢走的注意力比控件本身
 * 还多(用户的原话:「设计页面的解释隐藏起来」)。而"停一会儿才出"这个门槛正好把
 * "扫过"和"我要弄明白这一格"分开 —— `Tooltip.Trigger` 默认的 280ms 是给图标那种
 * 一眼提示用的,对这种成段的说明太急。
 *
 * ⚠️ **枢纽是一个 `<span>`,不是一个按钮。** 解释不是可点的东西,摆一个按钮样子的
 * 东西在那儿,用户会去点它。代价是它不进 Tab 序(键盘够不着)—— 内容本身不是操作,
 * 够不着不影响任何事能做成。
 */
function HelpHint({ text }: { text: string }) {
  const { t } = useI18n();
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        delay={1000}
        closeDelay={60}
        render={<button type="button" />}
        aria-label={t("settings.workflows.paramHelp")}
        className="ml-1 inline-flex cursor-help align-middle text-content-subtle hover:text-content-muted"
      >
        <IconInfoCircle size={11} />
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner side="left" align="start" sideOffset={6}>
          <Tooltip.Popup className="max-w-[280px] leading-relaxed">{text}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/** 清单里的控件种类 → 具体控件。**这是 `NODE_PARAM_KINDS` 在渲染端唯一的一处映射**
 *  —— 集合是封闭的,所以这里的 `default` 分支兜的是两种情况:清单比界面新(老版本
 *  读到新清单),以及引用型遇到"一个候选都没有"(没有候选的下拉比输入框更糟)。
 *  两种都退化成单行文本,比崩掉强。 */
export function ParamField({
  spec,
  value,
  onChange,
  insertables,
  resolvedFrom,
}: {
  spec: NodeParamSpec;
  value: unknown;
  onChange: (value: unknown) => void;
  /** 这个参数的文本框里能插哪些变量。**给了才渲染「插入变量」** —— 什么时候给由
   *  检查器决定(它才知道图长什么样),控件自己不认识工作流。 */
  insertables?: InsertableGroup[];
  /** 清单写了 `fromParam` 时,那个参数**此刻的值** —— 候选要跟着它收窄(「模型」跟着
   *  「引擎」走,见 `NodeParamSpecSchema.fromParam`)。 */
  resolvedFrom?: string;
}) {
  const { t } = useI18n();
  const [picking, setPicking] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const text = typeof value === "string" ? value : "";

  /** 把一段 `{{...}}` 插到光标处(替换选中的那一段)。 */
  const insertAt = (snippet: string): void => {
    const el = areaRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? start;
    const next = insertSnippet(text, start, end, snippet);
    onChange(next.value);
    // 光标要落在插进来的那段**后面**。得等 React 把新值写回 DOM 之后再设 —— 所以排到
    // 下一帧,而不是紧接着 setState。
    requestAnimationFrame(() => {
      const node = areaRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(next.caret, next.caret);
    });
  };

  const pick = async (kind: "file" | "dir") => {
    setPicking(true);
    try {
      if (kind === "dir") {
        const res = await api.pickFolder();
        if (res.path) onChange(res.path);
      } else {
        const res = await api.pickFiles({});
        if (res.paths[0]) onChange(res.paths[0]);
      }
    } catch {
      // 选不了就选不了(比如路径来自别的机器)—— 留着手填那条路,不弹错。
    } finally {
      setPicking(false);
    }
  };

  const isMemory = spec.key === "memory";
  const label = isMemory ? t("memory.nodeParam.label") : spec.label;
  const help = isMemory ? t("memory.nodeParam.help") : spec.help;
  const boolChecked = value === true || value === "on" || value === "true";

  return (
    <Field label={label} required={spec.required} help={help}>
      {spec.kind === "boolean" ? (
        <Switch
          checked={boolChecked}
          onCheckedChange={(checked) => onChange(checked)}
          label={label}
          className="my-0.5"
        />
      ) : spec.kind === "longtext" ? (
        <textarea
          aria-label={spec.label}
          ref={areaRef}
          value={text}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          className="min-h-[90px] w-full resize-y rounded border border-edge bg-surface px-2 py-1 text-[0.7857em] leading-relaxed text-content placeholder:text-content-subtle focus:border-accent focus:outline-none"
        />
      ) : spec.kind === "code" ? (
        // 代码正文走**模态窗里的 Monaco**(见 `CodeParamField`):这一栏太窄,而代码
        // 要的是宽和高。语言从 `fromParam` 指的那一格现读,没写就按 python ——
        // `mcode.code` 的运行时默认值就是它。
        <CodeParamField
          label={label}
          value={text}
          language={resolvedFrom ?? "python"}
          onChange={(next) => onChange(next)}
        />
      ) : spec.kind === "conditions" ? (
        <ConditionTable value={value} onChange={onChange} insertables={insertables} />
      ) : spec.kind === "variables" ? (
        <VariableTable value={value} onChange={onChange} />
      ) : spec.kind === "selects" ? (
        <SelectsTable value={value} onChange={onChange} />
      ) : spec.kind === "select" && spec.multiple ? (
        // 多选的下拉是**一个也选不中**的控件(`<select multiple>` 在触摸屏上尤其难用),
        // 所以走勾选列表 —— 和引用型多选是同一个(`CheckboxList`)。
        <CheckboxList
          options={(spec.options ?? []).map((o) => ({ id: o.value, label: o.label }))}
          selected={stringListOf(value)}
          onToggle={(id, on) => onChange(toggleIn(stringListOf(value), id, on))}
        />
      ) : spec.kind === "select" ? (
        <Select.Root value={text} onValueChange={(v) => onChange(v as string)}>
          <Select.Trigger className="w-full">
            {/* **要自己把值翻成标签,不能交给 placeholder。** 有一种下拉把"不限"当成
                一个正常的选项,而它的值就是**空串**(`outputFormat` 就是:单值下拉没有
                别的方式退回未选)—— 交给 placeholder 的话,用户点了「不限」之后那一格
                会变回「请选择」,"我选了不限"和"我还没选"就分不出来了。 */}
            <Select.Value>
              {(value: string) =>
                (spec.options ?? []).find((o) => o.value === value)?.label ??
                t("settings.workflows.paramPick")
              }
            </Select.Value>
          </Select.Trigger>
          <Select.Portal>
            <Select.Positioner className="z-50">
              <Select.Popup>
                <Select.List>
                  {(spec.options ?? []).map((option) => (
                    <Select.Item key={option.value} value={option.value}>
                      <Select.ItemText>{option.label}</Select.ItemText>
                    </Select.Item>
                  ))}
                </Select.List>
              </Select.Popup>
            </Select.Positioner>
          </Select.Portal>
        </Select.Root>
      ) : spec.kind === "ref" ? (
        // 引用型:候选是**这台机器上有什么**(见 `@contracts/nodeType` 的
        // `NODE_PARAM_REF_SOURCES`)。候选一个都没有时退回手填 —— 一份别人分享来的
        // 工作流引用了本机没装的技能/模型,值仍然要看得见、改得动。
        <CapabilityAwareRefControl
          spec={spec}
          value={value}
          onChange={onChange}
          resolvedFrom={resolvedFrom}
        />
      ) : spec.kind === "number" ? (
        <Input
          type="number"
          value={typeof value === "number" ? String(value) : ""}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        />
      ) : spec.kind === "file" || spec.kind === "dir" ? (
        <div className="flex items-center gap-1">
          <Input
            type="text"
            value={text}
            spellCheck={false}
            onChange={(e) => onChange(e.target.value)}
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={picking}
            onClick={() => void pick(spec.kind === "dir" ? "dir" : "file")}
            className="shrink-0"
          >
            {t("settings.workflows.paramBrowse")}
          </Button>
        </div>
      ) : (
        <Input
          type="text"
          value={text}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {/* 「插入变量」跟着 longtext 的框走(上面那个 areaRef)。selects 的候选值是给
          下拉框用的**字面量**(选中哪个原样注入),没有插变量的份。 */}
      {insertables && spec.kind !== "selects" && spec.kind !== "conditions" && (
        <InsertVarMenu groups={insertables} onPick={insertAt} />
      )}
    </Field>
  );
}

/** Capability-aware wrapper around the generic ref control. Empty candidates
 * normally fall back to free text for portable workflows; an explicitly
 * unsupported capability is different and must not become an escape hatch. */
function CapabilityAwareRefControl({
  spec, value, onChange, resolvedFrom,
}: {
  spec: NodeParamSpec;
  value: unknown;
  onChange: (value: unknown) => void;
  resolvedFrom?: string;
}) {
  const { t } = useI18n();
  const providers = useSessionStore((s) => s.providers);
  const currentProviderId = useSessionStore((s) => s.providerId);
  const wanted = resolvedFrom !== undefined && resolvedFrom.trim().length > 0
    ? resolvedFrom : currentProviderId;
  const provider = providers.find((candidate) => candidate.id === wanted);
  const unsupportedMcp = spec.from === "mcp" && provider?.capabilities.supportsMcp === false;
  if (!unsupportedMcp) {
    return <RefControl spec={spec} value={value} onChange={onChange} resolvedFrom={resolvedFrom} />;
  }

  const saved = stringListOf(value);
  return (
    <div
      role="status"
      className="space-y-1.5 rounded border border-warning/40 bg-warning/5 px-2 py-1.5 text-[0.7857em]"
    >
      <p className="leading-relaxed text-warning">
        {t("settings.workflows.mcpUnsupportedProvider", {
          provider: provider?.displayName || wanted,
        })}
      </p>
      {saved.length > 0 && (
        <>
          <div className="flex flex-wrap gap-1">
            {saved.map((id) => (
              <code key={id} className="rounded bg-surface-muted px-1 py-0.5 text-content-muted">
                {id}
              </code>
            ))}
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onChange(spec.multiple ? [] : undefined)}
          >
            <IconX size={12} />
            {t("settings.workflows.clearUnsupportedValues")}
          </Button>
        </>
      )}
    </div>
  );
}

/** 条件参数是结构化 JSON,右侧比较文本绝不经过模板展开。引用菜单只改 ref。 */
function ConditionTable({
  value, onChange, insertables,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
  insertables?: InsertableGroup[];
}) {
  const { t } = useI18n();
  type Rule = { ref: string; op: "exists" | "equal" | "contains"; value?: string };
  const raw = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  const logic = raw.logic === "or" ? "or" : "and";
  const rules: Rule[] = (Array.isArray(raw.rules) ? raw.rules : []).map((item) => {
    const r = typeof item === "object" && item !== null ? item as Record<string, unknown> : {};
    const op = r.op === "equal" || r.op === "contains" ? r.op : "exists";
    return { ref: typeof r.ref === "string" ? r.ref : "", op,
      ...(op !== "exists" ? { value: typeof r.value === "string" ? r.value : "" } : {}) };
  });
  const update = (next: Rule[]): void => onChange({ logic, rules: next });
  const change = (index: number, patch: Partial<Rule>): void =>
    update(rules.map((r, i) => i === index ? { ...r, ...patch } : r));
  const ops = ["exists", "equal", "contains"] as const;
  const opLabel = (op: Rule["op"]): string => t(`settings.workflows.condition.${op}`);

  return (
    <div className="space-y-2 rounded border border-edge bg-surface p-2 text-[0.7857em]">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-content-muted">{t("settings.workflows.condition.logic")}</span>
        <Select.Root value={logic} onValueChange={(v) => onChange({ logic: v, rules })}>
          <Select.Trigger className="min-w-[110px] flex-1">
            <Select.Value>{logic === "and" ? t("settings.workflows.condition.and") : t("settings.workflows.condition.or")}</Select.Value>
          </Select.Trigger>
          <Select.Portal><Select.Positioner className="z-50"><Select.Popup><Select.List>
            <Select.Item value="and"><Select.ItemText>{t("settings.workflows.condition.and")}</Select.ItemText></Select.Item>
            <Select.Item value="or"><Select.ItemText>{t("settings.workflows.condition.or")}</Select.ItemText></Select.Item>
          </Select.List></Select.Popup></Select.Positioner></Select.Portal>
        </Select.Root>
      </div>
      {rules.map((rule, index) => (
        <div key={index} className="space-y-1 rounded border border-edge bg-surface-muted p-1.5">
          <div className="flex items-center gap-1">
            <Input
              value={rule.ref}
              spellCheck={false}
              aria-label={t("settings.workflows.condition.ref")}
              placeholder={t("settings.workflows.condition.ref")}
              onChange={(e) => change(index, { ref: e.target.value })}
            />
            {insertables && <InsertVarMenu groups={insertables} onPick={(ref) => change(index, { ref })} />}
            <Button
              variant="secondary" size="sm"
              title={t("settings.workflows.condition.remove")}
              onClick={() => update(rules.filter((_, i) => i !== index))}
            ><IconX size={12} /></Button>
          </div>
          <Select.Root value={rule.op} onValueChange={(v) => {
            const op = v as Rule["op"];
            update(rules.map((r, i) => i === index ?
              (op === "exists" ? { ref: r.ref, op } : { ref: r.ref, op, value: r.value ?? "" }) : r));
          }}>
            <Select.Trigger className="w-full">
              <Select.Value>{opLabel(rule.op)}</Select.Value>
            </Select.Trigger>
            <Select.Portal><Select.Positioner className="z-50"><Select.Popup><Select.List>
              {ops.map((op) => (
                <Select.Item key={op} value={op}><Select.ItemText>{opLabel(op)}</Select.ItemText></Select.Item>
              ))}
            </Select.List></Select.Popup></Select.Positioner></Select.Portal>
          </Select.Root>
          {rule.op !== "exists" && (
            <Input
              value={rule.value ?? ""}
              spellCheck={false}
              aria-label={t("settings.workflows.condition.value")}
              placeholder={t("settings.workflows.condition.value")}
              onChange={(e) => change(index, { value: e.target.value })}
            />
          )}
        </div>
      ))}
      <Button variant="secondary" size="sm" disabled={rules.length >= 32}
        onClick={() => update([...rules, { ref: "", op: "exists" }])}>
        <IconPlus size={12} />{t("settings.workflows.condition.add")}
      </Button>
    </div>
  );
}

/**
 * 「插入变量」—— 上游那几步定过什么变量,这里就列什么,点一下插到光标处。
 *
 * **界面上不提供"自己打 `{{...}}`"这条路**(手写仍然通,只是没有界面):变量名是用户
 * 自己起的,记不住,记错一个字的后果是那一步跑不起来。候选从哪来见
 * `insertVariable.ts`。
 *
 * 用 `Menu` 而不是 `Select`:这东西**没有选中态** —— 点一下就是"插一次",插完菜单就该
 * 关掉,而 `Select` 会把最后点的那个显示成"当前值",那是在说一件不存在的事。
 * (同 `NodeInspector` 的「套用档案」。)
 */
/**
 * 触发器事实字段 → 词典里的显示名(`settings.workflows.triggerField.*`)。触发器字段
 * 不是用户起的变量名,是**固定字段**,所以值得翻译;认不出的字段(清单比界面新)退回原文。
 */
const TRIGGER_FIELD_LABELS: Partial<Record<string, MessageId>> = {
  kind: "settings.workflows.triggerField.kind",
  at: "settings.workflows.triggerField.at",
  files: "settings.workflows.triggerField.files",
  event: "settings.workflows.triggerField.event",
  toolName: "settings.workflows.triggerField.toolName",
  subjects: "settings.workflows.triggerField.subjects",
};

function InsertVarMenu({
  groups,
  onPick,
}: {
  groups: InsertableGroup[];
  onPick: (snippet: string) => void;
}) {
  const { t } = useI18n();
  const rowCls = cn(
    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[0.7857em] outline-none select-none",
    "text-content-muted data-[highlighted]:bg-surface-muted data-[highlighted]:text-content",
  );
  return (
    <Menu.Root>
      <Menu.Trigger
        className={cn(
          "mt-1 inline-flex items-center gap-1 rounded border border-edge px-1.5 py-0.5 text-[0.7143em]",
          "text-content-muted transition-colors hover:border-accent hover:text-accent",
        )}
      >
        <IconBraces size={12} />
        {t("settings.workflows.insertVar")}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="start">
          <Menu.Popup className="z-50 max-h-[280px] min-w-[200px] max-w-[320px] overflow-y-auto rounded-lg border border-edge bg-surface py-1.5 shadow-2xl">
            {groups.length === 0 ? (
              // **空的时候也要能点开** —— 那句话本身就在教这个功能怎么才有东西可选。
              <p className="px-3 py-1.5 text-[0.7143em] leading-relaxed text-content-subtle">
                {t("settings.workflows.insertVarEmpty")}
              </p>
            ) : (
              groups.map((group, gi) => {
                // 组名:上游节点组用节点标题;内置组(触发器)的标题是词典 key
                // (`titleKey`),由这里翻译。「用户输入」那组两者都没有 —— 名字写在
                // 条目自己身上(和「整段结果」同一种画法),组名就不渲染。
                const groupTitle =
                  group.title !== ""
                    ? group.title
                    : group.titleKey !== undefined
                      ? t(group.titleKey)
                      : null;
                return (
                  <div key={`${group.title}-${gi}`}>
                    {groupTitle !== null && (
                      <div className="truncate px-3 py-1 text-[0.7143em] font-medium text-content-subtle">
                        {groupTitle}
                      </div>
                    )}
                    {gi > 0 && <div className="my-1 border-t border-edge" />}
                    {group.items.map((item, i) => {
                      // 触发器字段是固定字段不是用户起的变量名,所以走词典;
                      // 认不出的字段名(清单比界面新)退回原文。
                      const triggerLabel =
                        item.kind === "trigger" && item.name !== undefined
                          ? TRIGGER_FIELD_LABELS[item.name]
                          : undefined;
                      return (
                        <Menu.Item key={i} onClick={() => onPick(item.insert)} className={rowCls}>
                          {item.kind === "whole" ? (
                            <span className="flex min-w-0 flex-col">
                              <span>{t("settings.workflows.insertVarWholeOutput")}</span>
                              <span className="text-[0.7143em] leading-snug text-content-subtle">
                                {t("settings.workflows.insertVarWholeOutputHint")}
                              </span>
                            </span>
                          ) : item.kind === "user" ? (
                            <span className="flex min-w-0 flex-col">
                              <span>{t("settings.workflows.insertVarUser")}</span>
                              <span className="text-[0.7143em] leading-snug text-content-subtle">
                                {t("settings.workflows.insertVarUserHint")}
                              </span>
                            </span>
                          ) : item.kind === "trigger" ? (
                            <span className="truncate">
                              {triggerLabel !== undefined ? t(triggerLabel) : item.name}
                            </span>
                          ) : (
                            <span className="truncate">{item.name}</span>
                          )}
                        </Menu.Item>
                      );
                    })}
                  </div>
                );
              })
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** 变量表在编辑态的一行。 */
interface VarRow {
  name: string;
  example: string;
}

/**
 * 读出变量表的每一行。
 *
 * ⚠️ **和 `@contracts/outputConstraint` 的 `normalizeVars` 不是一回事,别合并**:
 * 那个是"拿去用"的读法,会把名字空的、重复的**丢掉**;这里是"拿来编辑"的读法,必须
 * **一行不丢地**端上来 —— 用户刚点「加一样」加出来的就是一行空名字,丢掉它的话那一行
 * 会在点下去的瞬间消失。
 */
function varRows(value: unknown): VarRow[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const row = (typeof item === "object" && item !== null ? item : {}) as {
      name?: unknown;
      example?: unknown;
    };
    return {
      name: typeof row.name === "string" ? row.name : "",
      example: typeof row.example === "string" ? row.example : "",
    };
  });
}

/**
 * 会随内容长高的多行框。
 *
 * **示例那一栏必须是多行、而且能写很多** —— 它就是要给模型看的样板,写得越具体,
 * 模型交出来的东西越对。早先这里是个单行 `Input`,右侧面板只有 300px 宽、两栏并排,
 * 一格一百来像素连一句话都显示不全(用户的原话:「就是 一个 txt 编辑框,可以输入
 * 很多东西才行」)。
 *
 * 高度**跟着内容走**而不是给个固定 `rows`:示例常常是一整段,固定高度要么浪费地方,
 * 要么让用户在一个小窗口里滚。`resize-y` 留着手动拉的余地。
 *
 * **导出**是给检查器里那两处用的:分支节点的选项说明,和节点参数的例子是同一类东西
 * ("要写一整段、还得能看见自己写了多少"),各写一个只会有一边先长出毛病。
 */
export function GrowingTextarea({
  value,
  placeholder,
  onChange,
  inputRef,
}: {
  value: string;
  placeholder: string;
  onChange: (text: string) => void;
  /** 外部要拿这个框的光标(「插入变量」插到光标处)时给一个回调 ref。可选 ——
   *  不给就是原来的行为,已有调用方(AgentProfilesView 等)不受影响。 */
  inputRef?: (el: HTMLTextAreaElement | null) => void;
}) {
  const fieldLabel = useContext(FieldLabelContext);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const fit = (): void => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  useEffect(fit, [value]);
  return (
    <textarea
      aria-labelledby={fieldLabel}
      ref={(el) => {
        ref.current = el;
        inputRef?.(el);
      }}
      value={value}
      rows={1}
      spellCheck={false}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onInput={fit}
      className="w-full resize-y rounded border border-edge bg-surface px-2 py-1 text-[0.7857em] leading-relaxed text-content placeholder:text-content-subtle focus:border-accent focus:outline-none"
    />
  );
}

/**
 * 「名字 + 示例」的表 —— `kind: "variables"` 的控件。
 *
 * 界面上**刻意没有"JSON"这个词**,也没有花括号:底下确实是 JSON,但那是软件的事。
 * 用户要回答的只有一句"这一步要交出来哪几样东西",那样东西长什么样用一个例子说。
 * (见 `@contracts/outputConstraint` 的文件头。)
 *
 * ## 一行竖着排,不是并排
 *
 * 名字在上、示例在下。并排的两个单行框在这个宽度下每个只有一百来像素,而示例本来就是
 * 要写一整段的 —— 所以名字独占一行的**单行**框(**变量名是个标识符**,下游要写
 * `{{某步.名字}}` 引用它,换行只会让那个引用写不出来),示例占一行多行框。
 */
function VariableTable({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const { t } = useI18n();
  const rows = varRows(value);
  const write = (next: VarRow[]): void => onChange(next);
  const patch = (at: number, key: keyof VarRow, text: string): void =>
    write(rows.map((row, i) => (i === at ? { ...row, [key]: text } : row)));

  return (
    <div className="space-y-2">
      {rows.map((row, i) => (
        <div key={i} className="space-y-1 rounded border border-edge/60 p-1.5">
          <div className="flex items-center gap-1">
            <Input
              className="min-w-0 flex-1"
              value={row.name}
              maxLength={60}
              spellCheck={false}
              placeholder={t("settings.workflows.varName")}
              onChange={(e) => patch(i, "name", e.target.value)}
            />
            <button
              type="button"
              title={t("settings.workflows.varRemove")}
              aria-label={t("settings.workflows.varRemove")}
              onClick={() => write(rows.filter((_, j) => j !== i))}
              className="shrink-0 rounded p-1 text-content-subtle transition-colors hover:bg-surface-hover/60 hover:text-content"
            >
              <IconX size={12} />
            </button>
          </div>
          <GrowingTextarea
            value={row.example}
            placeholder={t("settings.workflows.varExample")}
            onChange={(text) => patch(i, "example", text)}
          />
        </div>
      ))}
      {rows.length === 0 && (
        <p className="text-[0.7143em] leading-relaxed text-content-subtle">
          {t("settings.workflows.varEmpty")}
        </p>
      )}
      <Button
        variant="secondary"
        size="sm"
        onClick={() => write([...rows, { name: "", example: "" }])}
        className="gap-1"
      >
        <IconPlus size={12} />
        {t("settings.workflows.varAdd")}
      </Button>
    </div>
  );
}

/**
 * 「条件名 + 候选值 + 解释」的表 —— `kind: "selects"` 的控件。
 *
 * 它是主对话入口节点的**固定条件**:每一行会变成聊天输入框上方**一个**下拉框,选中的
 * 值随**那次对话第一轮**的提示词注入一次。**候选值一行一个**(多行框):条件名是标识符
 * 级别的短词,而候选值可能很长(「只要 T1(Q1 或中科院 1 区,或 Top)」),单行框装不下。
 * **解释**是给模型的一句说明(比如「T1 = Q1 或中科院 1 区或 Top 期刊」),可空。
 *
 * 候选值是**字面量** —— 选中哪个,注入的就是哪个,所以这里**没有**「插入变量」:
 * `{{...}}` 在下拉里不是个能选的值。与 `varRows` 同一条读法:**一行不丢**。
 *
 * ⚠️ **写回去的必须是 `string[]`,不是那个多行框里的字符串。**
 *
 * 这一格和另外那张表不一样:它们一行的值本来就是字符串(`{name, example}`),而这里的
 * `choices` 在**契约里是数组**(`validateNodeParams` 明写 `Array.isArray(row.choices)`,
 * 运行时的注入也按数组一条一条读)。编辑态为了方便摆成"一行一个"的多行框,所以
 * **读写之间必须切一次行**。少了切开这一步,每一次按键都会:写进一个字符串 → 再读回来
 * 时 `Array.isArray` 为假 → 得到空 —— 用户看到的正是「候选值输入不进去」(实测:打进
 * 一个 `Q1`,params 里是 `"Q1"`,框里已经空了)。
 */
function SelectsTable({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const { t } = useI18n();
  const rows = critRows(value);
  const write = (next: CritRow[]): void => onChange(toCriteria(next));
  // `key` 泛到 `CritRow` 的键 —— `source` 不是字符串(是枚举),所以值类型跟着那一格走。
  const patch = <K extends keyof CritRow>(at: number, key: K, text: CritRow[K]): void =>
    write(rows.map((row, i) => (i === at ? { ...row, [key]: text } : row)));

  return (
    <div className="space-y-2">
      {rows.map((row, i) => (
        <div key={i} className="space-y-1 rounded border border-edge/60 p-1.5">
          <div className="flex items-center gap-1">
            <Input
              className="min-w-0 flex-1"
              value={row.name}
              maxLength={60}
              spellCheck={false}
              placeholder={t("settings.workflows.critName")}
              onChange={(e) => patch(i, "name", e.target.value)}
            />
            <button
              type="button"
              title={t("settings.workflows.critRemove")}
              aria-label={t("settings.workflows.critRemove")}
              onClick={() => write(rows.filter((_, j) => j !== i))}
              className="shrink-0 rounded p-1 text-content-subtle transition-colors hover:bg-surface-hover/60 hover:text-content"
            >
              <IconX size={12} />
            </button>
          </div>
          <div className="flex items-center gap-2">
            <label className="shrink-0 text-[0.7143em] text-content-subtle">
              {t("settings.workflows.critSource")}
            </label>
            {/* 原生 `<select>`:`select.tsx` 那套 base-ui 复合件要 `Select.Root/Trigger/Value`
                三件套,而这里只有"一个枚举、选一个"这么简单的事 —— 同 `SearchFilterBar`
                里那个下拉的取舍。 */}
            <select
              value={row.source}
              onChange={(e) => patch(i, "source", e.target.value)}
              className="min-w-0 flex-1 rounded border border-edge bg-surface/40 px-1.5 py-1 text-[0.7857em] text-content-muted outline-none hover:text-content focus:border-accent"
            >
              <option value="">{t("settings.workflows.critSourceNone")}</option>
              {NODE_PARAM_REF_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          {/* **选了来源就不写候选** —— 两种读法是互斥的(见契约里那段)。这里把候选框
              收起来而不是留着禁用:留着的话用户会以为"我还能改候选",改了却不生效。 */}
          {row.source === "" ? (
            <GrowingTextarea
              value={row.choices}
              placeholder={t("settings.workflows.critChoices")}
              onChange={(text) => patch(i, "choices", text)}
            />
          ) : (
            <p className="text-[0.7143em] leading-relaxed text-content-subtle">
              {t("settings.workflows.critSourceHint")}
            </p>
          )}
          <GrowingTextarea
            value={row.note}
            placeholder={t("settings.workflows.critNote")}
            onChange={(text) => patch(i, "note", text)}
          />
        </div>
      ))}
      {rows.length === 0 && (
        <p className="text-[0.7143em] leading-relaxed text-content-subtle">
          {t("settings.workflows.critEmpty")}
        </p>
      )}
      <Button
        variant="secondary"
        size="sm"
        onClick={() => write([...rows, { name: "", choices: "", note: "", source: "" }])}
        className="gap-1"
      >
        <IconPlus size={12} />
        {t("settings.workflows.critAdd")}
      </Button>
    </div>
  );
}

/** 固定条件表在编辑态的一行。候选值按行存(编辑器里一行一个),写回时切行;note 是
 *  给模型的一句解释,本来就是字符串,原样读写。 */
interface CritRow {
  name: string;
  choices: string;
  note: string;
  /** 候选**现读**的来源(空串 = 手写候选)。见 `@contracts/nodeType` 的 `source`。 */
  source: string;
}

/** 读出条件表的每一行。**一行不丢地端上来** —— 刚点「加一条」出来的空行必须留得住;
 *  多行框里的空行也是(用户按下的那个回车),所以切行之后**不过滤空串**。
 *
 *  它和 {@link toCriteria} 是一对**互逆**的读写:中间任何一个方向少东西,编辑框里的
 *  光标就会跳、回车就会失灵。
 *
 *  这里**已经容忍了字符串形状的 `choices`**:那种值是被上面那个 bug 写进去的,而它
 *  确实存在(用户存过盘的工作流里就有)。按行拆开读出来,用户一编辑就会被改写成正确的
 *  `string[]` —— 不必额外跑一次迁移。 */
function critRows(value: unknown): CritRow[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const row = (typeof item === "object" && item !== null ? item : {}) as {
      name?: unknown;
      choices?: unknown;
      note?: unknown;
      source?: unknown;
    };
    return {
      name: typeof row.name === "string" ? row.name : "",
      choices: Array.isArray(row.choices)
        ? row.choices.filter((c): c is string => typeof c === "string").join("\n")
        : typeof row.choices === "string"
          ? row.choices
          : "",
      note: typeof row.note === "string" ? row.note : "",
      // 认不出来的来源当**手写**读回来(空串)—— 契约会拒掉不认识的来源,能走到这里的
      // 要么合法、要么是别处写坏的存档;显示成手写至少能让用户看见并改回去。
      source: typeof row.source === "string" && (NODE_PARAM_REF_SOURCES as readonly string[]).includes(row.source)
        ? row.source
        : "",
    };
  });
}

/** 把编辑态那张表写成契约要的形状:多行框切行。
 *
 *  ⚠️ **这一对读写必须可逆**(`critRows` 是它的逆),所以这里**不 trim、不丢空行**。
 *
 *  原先这里是 `trim` + 滤掉空串,理由是"用户打个回车就留一个空串,留着会让下拉里多一个
 *  看不见的空选项" —— **那个理由不成立**(渲染下拉的 `SearchFilterBar` 自己就把空候选
 *  滤掉了,注入的那一段根本不看候选值),而它换来的是**按回车没反应**:编辑态多行框里的
 *  空行是"正在写的那一条",切行时被丢掉、数组塌成一条、React 再把 props 写回框里 ——
 *  光标那一行就没了,后面打的字全接到上一行尾巴上(实测:打「不限」回车再打「近三年」,
 *  框里是 `不限近三年`)。
 *
 *  所以空的候选值**留在盘上**(它是编辑中的空位),显示与注入两处各自忽略它。 */
function toCriteria(
  rows: readonly CritRow[],
): Array<{ name: string; choices: string[]; note?: string; source?: string }> {
  return rows.map((row) => ({
    name: row.name,
    // **有来源时候选必须是空的** —— 契约里那一对是互斥的(见 `NODE_CRITERIA_PARAM_KEY`
    // 那段),留着旧候选整份参数就会被校验拒掉。用户在界面上切到"来源"那一刻,盘上
    // 那份手写候选就此作废,这是有意的。
    choices: row.source === "" ? row.choices.split("\n") : [],
    ...(row.note.trim() !== "" ? { note: row.note } : {}),
    ...(row.source !== "" ? { source: row.source } : {}),
  }));
}

/**
 * 一列勾选框。**引用型多选和下拉多选共用** —— 两者的差别只在候选从哪来,选中之后
 * 长得一模一样,分成两份就会有一份慢慢长歪。
 */
function CheckboxList({
  options,
  selected,
  onToggle,
}: {
  options: ReadonlyArray<{ id: string; label: string; hint?: string }>;
  selected: readonly string[];
  onToggle: (id: string, on: boolean) => void;
}) {
  return (
    <div className="max-h-[180px] space-y-0.5 overflow-y-auto rounded border border-edge bg-surface p-1">
      {options.map((option) => {
        const on = selected.includes(option.id);
        return (
          <button
            key={option.id}
            type="button"
            title={option.hint}
            onClick={() => onToggle(option.id, !on)}
            className={cn(
              "flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[0.7857em] transition-colors",
              on ? "text-content" : "text-content-muted",
              "hover:bg-surface-hover/60 hover:text-content",
            )}
          >
            <span
              className={cn(
                "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border",
                on ? "border-accent bg-accent/15 text-accent" : "border-edge",
              )}
            >
              {on && <IconCheck size={10} />}
            </span>
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** 参数值里那一串名字。**不是数组就是空** —— 参数是自由数据,存成字符串、存成数字
 *  都可能,而一个脏值不该让整个表单崩掉。 */
function stringListOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** 勾上/取消一个。**保持原先的顺序**(新勾的追加在后面,而不是重排)—— 用户按顺序挑
 *  的东西,顺序是他挑的顺序。 */
function toggleIn(selected: readonly string[], id: string, on: boolean): string[] {
  return on ? [...selected, id] : selected.filter((n) => n !== id);
}

/**
 * `kind: "ref"` 的控件 —— 单选一个下拉,多选一个**可收起**的勾选列表。
 *
 * 两个刻意的行为:
 *  - **候选为空就退回手填/原样列出**。一份分享来的工作流引用了本机没装的技能时,
 *    那个值仍然要看得见、改得动 —— 和 `@contracts/workflow` 里"类型缺失不算错误"
 *    是同一条:换台机器打不开的图不叫工作流,叫锁。
 *  - **空值不是"没选"**。单选的空值有自己的说法(见 `paramRefUnset`)—— 它常常意味着
 *    "跟着对话走",所以走函数子节点而不是 `placeholder`。
 *
 * 多选那一路拆在 `MultiRefValue` 里,因为它自己有一摊状态(收起 / 筛选 / 手填)—— 见那边。
 */
function RefControl({
  spec,
  value,
  onChange,
  resolvedFrom,
}: {
  spec: NodeParamSpec;
  value: unknown;
  onChange: (value: unknown) => void;
  /** 级联的上游值(见 `NodeParamSpecSchema.fromParam`)。只有「模型」用它。 */
  resolvedFrom?: string;
}) {
  const { t } = useI18n();
  // `from` 缺了是**不该发生**的(清单校验会拒掉没写 `from` 的引用型参数)。真缺了就
  // 当成"没有候选"往下走 —— 宁可显示"这台机器上还没有可选的项",也不要随手挑一份
  // 别的来源的列表填上去(那会让一个坏清单看起来是好的)。
  const result = useRefOptions(spec.from ?? "models", spec.fromParam !== undefined ? resolvedFrom : undefined);
  const candidates = spec.from ? result.options : [];
  const text = typeof value === "string" ? value : "";
  const selected = stringListOf(value);

  if (spec.from && (result.loading || result.failed)) {
    const saved = spec.multiple ? selected : (text ? [text] : []);
    return (
      <div
        role={result.failed ? "alert" : "status"}
        className={cn(
          "space-y-1.5 rounded border px-2 py-1.5 text-[0.7857em]",
          result.failed ? "border-danger/40 bg-danger/5" : "border-edge bg-surface-muted/40",
        )}
      >
        <p className={result.failed ? "text-danger" : "text-content-muted"}>
          {t(result.failed ? "settings.workflows.paramRefLoadFailed" : "settings.workflows.paramRefLoading")}
        </p>
        {saved.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {saved.map((id) => <code key={id} className="rounded bg-surface px-1 py-0.5">{id}</code>)}
          </div>
        )}
        {result.failed && (
          <Button variant="secondary" size="sm" onClick={result.retry}>
            {t("common.retry")}
          </Button>
        )}
      </div>
    );
  }

  if (spec.multiple) {
    return <MultiRefValue candidates={candidates} selected={selected} onChange={onChange} />;
  }

  // 值还在、但它不在这个引擎的候选里 —— **仍然要显示出来**(一份分享来的工作流引用了
  // 这里没装的东西,那个值要看得见、改得动),只在下面说一句它不属于当前这一档。
  const orphan = text !== "" && !candidates.some((option) => option.id === text);

  if (candidates.length === 0) {
    return (
      <>
        <Input
          type="text"
          value={text}
          maxLength={120}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />
        <p className="mt-1 text-[0.7143em] leading-relaxed text-content-subtle">
          {t("settings.workflows.paramRefEmpty")}
        </p>
      </>
    );
  }

  return (
    <>
      <Select.Root value={text} onValueChange={(v) => onChange(v as string)}>
        <Select.Trigger className="w-full">
          <Select.Value>
            {(value: string) =>
              value === ""
                ? t("settings.workflows.paramRefUnset")
                : (candidates.find((option) => option.id === value)?.label ?? value)
            }
          </Select.Value>
        </Select.Trigger>
        <Select.Portal>
          <Select.Positioner className="z-50">
            <Select.Popup>
              <Select.List>
                <Select.Item value="">
                  <Select.ItemText>{t("settings.workflows.paramRefUnset")}</Select.ItemText>
                </Select.Item>
                {/* 认不出的那个值单列在最上面:它在候选里没有,所以下面的列表里选不中
                    它,这一项是它唯一看得见的地方。 */}
                {orphan && (
                  <Select.Item value={text}>
                    <Select.ItemText>{text}</Select.ItemText>
                  </Select.Item>
                )}
                {candidates.map((option) => (
                  <Select.Item key={option.id} value={option.id}>
                    <Select.ItemText>{option.label}</Select.ItemText>
                  </Select.Item>
                ))}
              </Select.List>
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </Select.Root>
      {orphan && (
        <p className="mt-1 text-[0.7143em] leading-relaxed text-warning">
          {t("settings.workflows.paramRefForeign")}
        </p>
      )}
    </>
  );
}

/**
 * 候选多到值得给一个筛选框 —— 正好是勾选列表那个盒子装不下的时候。
 *
 * 那个盒子是 `max-h-[180px]`(见 {@link CheckboxList}),一行约 26px,所以六行以内它
 * 不滚动、眼睛一扫就看全了 —— 那种时候上面再压一个筛选框纯是噪声。第七个开始才需要。
 */
const FILTER_FROM = 7;

/**
 * 多选的引用型参数(技能 / MCP 服务器 / 插件)—— **收起的一行 + 按需展开的列表**。
 *
 * ## 为什么默认收起
 *
 * 这三格里**九成的答案是留空**(留空 = 不限制),而现在每一格都铺一个 180px 的盒子:
 * 一个节点检查器里十来个参数,三格就是大半屏,而它们多半一个字都不用填。
 *
 * 收起**不等于藏起来**:那一行仍然写着「不限制 · 可选 42 个」—— 有多少东西可挑是
 * 看得见的,只是不占地方。这跟「插入变量」那个菜单"空的时候也要能点开"是同一条:
 * 藏起来的入口等于没有入口。
 *
 * ## 展开与否是本地状态
 *
 * 初值看这一步**是不是已经选了东西**:选过的多半是来改的(直接摊开),没选过的多半
 * 只是路过(收起)。跟着 `selected` 每次渲染重算是不行的 —— 那样勾一个就会跳一下。
 *
 * ## 本机没有的那几个单独列
 *
 * 一份分享来的工作流引用了本机没装的技能时,那个名字**不在候选里**,所以勾选列表
 * 里没有它、也就没法取消它。这几个名字做成带 × 的标签单独排在列表上面 —— 那是摘掉
 * 它们的唯一入口。
 *
 * ## 一个候选都没有时:手填
 *
 * 插件一个都没装、或者那几个 `list` RPC 还没就绪时,候选是空的。那种情况下要能直接
 * 打一个名字进去(提示语里那句「直接填名字也行」说的就是这个)—— 多选不能像单选那样
 * 退回一个输入框了事(它要的是一组名字),所以是**输入框 + 回车加一个**。
 */
function MultiRefValue({
  candidates,
  selected,
  onChange,
}: {
  candidates: readonly RefOption[];
  selected: readonly string[];
  onChange: (value: unknown) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(selected.length > 0);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");

  const known = new Set(candidates.map((option) => option.id));
  /** 存着、但本机没有的名字 —— 见文件头最后一段。 */
  const missing = selected.filter((name) => !known.has(name));
  const needle = query.trim().toLowerCase();
  const shown =
    needle.length === 0
      ? candidates
      : candidates.filter((option) =>
          `${option.id} ${option.label} ${option.hint ?? ""}`.toLowerCase().includes(needle),
        );

  const toggle = (id: string, on: boolean): void => onChange(toggleIn(selected, id, on));
  const drop = (name: string): void => onChange(selected.filter((n) => n !== name));
  const add = (name: string): void => {
    const key = name.trim();
    if (key.length === 0 || selected.includes(key)) return;
    onChange([...selected, key]);
  };

  return (
    <>
      {/* 整行都是按钮:标签是"现在选了什么",右边那句是"还有多少可挑" —— 收起之后
          这两件事仍然要看得见。 */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={t(open ? "settings.workflows.paramRefCollapse" : "settings.workflows.paramRefExpand")}
        className={cn(
          "flex w-full items-center gap-1.5 rounded border border-edge bg-surface px-2 py-1 text-left text-[0.7857em] transition-colors",
          missing.length > 0 ? "border-warning/60 hover:border-warning" : "hover:border-accent/60",
        )}
      >
        <span className={cn("min-w-0 flex-1 truncate", selected.length === 0 && "text-content-muted")}>
          {selected.length === 0
            ? t("settings.workflows.paramRefUnlimited")
            : selected.join(t("settings.workflows.listSeparator"))}
        </span>
        <span className={cn("shrink-0 text-[0.7143em]", missing.length > 0 ? "text-warning" : "text-content-subtle")}>
          {missing.length > 0
            ? t("settings.workflows.paramRefMissingCount", { n: missing.length })
            : selected.length === 0
            ? t("settings.workflows.paramRefOptionCount", { n: candidates.length })
            : t("settings.workflows.paramRefSelectedCount", { n: selected.length })}
        </span>
        <IconChevronDown
          size={12}
          className={cn("shrink-0 text-content-subtle transition-transform", open && "rotate-180")}
        />
      </button>

      {open && (
        <div className="mt-1 space-y-1">
          {missing.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {missing.map((name) => (
                <button
                  key={name}
                  type="button"
                  title={t("settings.workflows.paramRefMissingHint")}
                  onClick={() => drop(name)}
                  className={cn(
                    "inline-flex items-center gap-1 rounded bg-surface-muted px-1.5 py-0.5 text-[0.7143em]",
                    "text-content-muted transition-colors hover:text-content",
                  )}
                >
                  {name}
                  <IconX size={10} />
                </button>
              ))}
            </div>
          )}

          {candidates.length === 0 ? (
            <>
              <Input
                type="text"
                value={draft}
                maxLength={120}
                spellCheck={false}
                placeholder={t("settings.workflows.paramRefAddPlaceholder")}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  // 表单里回车多半会提交/冒泡出去,先按住它。
                  e.preventDefault();
                  add(draft);
                  setDraft("");
                }}
                onBlur={() => {
                  add(draft);
                  setDraft("");
                }}
              />
              <p className="text-[0.7143em] leading-relaxed text-content-subtle">
                {t("settings.workflows.paramRefEmpty")}
              </p>
            </>
          ) : (
            <>
              {candidates.length >= FILTER_FROM && (
                <Input
                  type="text"
                  value={query}
                  spellCheck={false}
                  placeholder={t("settings.workflows.paramRefFilter")}
                  onChange={(e) => setQuery(e.target.value)}
                  className="font-sans"
                />
              )}
              <CheckboxList
                options={shown.map((option) => ({
                  id: option.id,
                  label: option.label,
                  hint: option.hint,
                }))}
                selected={selected}
                onToggle={toggle}
              />
              {shown.length === 0 && (
                <p className="text-[0.7143em] leading-relaxed text-content-subtle">
                  {t("settings.workflows.paramRefNoMatch")}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}
