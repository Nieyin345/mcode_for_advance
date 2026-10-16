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
import {
  CapabilityAwareRefControl,
  CheckboxList,
  ConditionTable,
  InsertVarMenu,
  SelectsTable,
  stringListOf,
  toggleIn,
  VariableTable,
} from "./ParamFieldParts.js";

export { GrowingTextarea } from "./ParamFieldParts.js";

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
