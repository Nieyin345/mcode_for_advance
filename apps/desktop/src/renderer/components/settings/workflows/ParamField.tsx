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
import { useEffect, useRef, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { cn } from "@renderer/lib/cn.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button, Input, Select, Switch } from "@renderer/components/ui/index.js";
import { api } from "@renderer/lib/api.js";
import type { NodeParamSpec } from "@contracts/nodeType";
import { IconBraces, IconCheck, IconChevronDown, IconPlus, IconX } from "@renderer/lib/icons.js";
import {
  insertSnippet,
  type InsertableGroup,
} from "./insertVariable.js";
import { useRefOptions, type RefOption } from "./useRefOptions.js";

/** 一个带标题的表单行。档案编辑器和节点检查器共用,所以标题的字号只有一份。 */
export function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="mb-2 block w-full">
      <span className="mb-0.5 block text-[0.7857em] font-medium text-content-muted">
        {label}
        {required && <span className="ml-0.5 text-warning">*</span>}
      </span>
      {children}
    </label>
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
}: {
  spec: NodeParamSpec;
  value: unknown;
  onChange: (value: unknown) => void;
  /** 这个参数的文本框里能插哪些变量。**给了才渲染「插入变量」** —— 什么时候给由
   *  检查器决定(它才知道图长什么样),控件自己不认识工作流。 */
  insertables?: InsertableGroup[];
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

  return (
    <Field label={spec.label} required={spec.required}>
      {spec.kind === "boolean" ? (
        <Switch
          checked={value === true}
          onCheckedChange={onChange}
          label={spec.label}
          className="my-0.5"
        />
      ) : spec.kind === "longtext" ? (
        <textarea
          ref={areaRef}
          value={text}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          className="min-h-[90px] w-full resize-y rounded border border-edge bg-surface px-2 py-1 text-[0.7857em] leading-relaxed text-content placeholder:text-content-subtle focus:border-accent focus:outline-none"
        />
      ) : spec.kind === "variables" ? (
        <VariableTable value={value} onChange={onChange} />
      ) : spec.kind === "options" ? (
        <OptionsTable value={value} onChange={onChange} insertables={insertables} />
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
        <RefControl spec={spec} value={value} onChange={onChange} />
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
      {/* 「插入变量」跟着 longtext 的框走(上面那个 areaRef)。options 的表**每行内容
          各有自己的框**,菜单在 OptionsTable 行内 —— 走这里会把变量插错地方。selects
          的候选值是给下拉框用的**字面量**(选中哪个原样注入),没有插变量的份。 */}
      {insertables && spec.kind !== "options" && spec.kind !== "selects" && (
        <InsertVarMenu groups={insertables} onPick={insertAt} />
      )}
      {spec.help && (
        <p className="mt-0.5 text-[0.7143em] leading-relaxed text-content-subtle">{spec.help}</p>
      )}
    </Field>
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
              groups.map((group, gi) => (
                <div key={`${group.title}-${gi}`}>
                  {gi > 0 && <div className="my-1 border-t border-edge" />}
                  <div className="truncate px-3 py-1 text-[0.7143em] font-medium text-content-subtle">
                    {group.title}
                  </div>
                  {group.items.map((item, i) => (
                    <Menu.Item key={i} onClick={() => onPick(item.insert)} className={rowCls}>
                      {item.kind === "whole" ? (
                        <span className="flex min-w-0 flex-col">
                          <span>{t("settings.workflows.insertVarWholeOutput")}</span>
                          <span className="text-[0.7143em] leading-snug text-content-subtle">
                            {t("settings.workflows.insertVarWholeOutputHint")}
                          </span>
                        </span>
                      ) : (
                        <span className="truncate">{item.name}</span>
                      )}
                    </Menu.Item>
                  ))}
                </div>
              ))
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
 * 「名字 + 内容 + 解释」的表 —— `kind: "options"` 的控件。
 *
 * 它是主对话入口节点的**输入选项**:每一行会变成聊天输入框上方那个下拉框里的一项。
 * 分工照着它在聊天那头的用途写 —— **名字**是菜单上显示的字;**内容**是选中后插进
 * 输入框光标处的那段,所以带「插入变量」(和「指令」同一套 `insertSnippet`,插到光标处;
 * 入口节点没有上游,菜单是空态提示,机制不分家);**解释**是随这次运行进提示词的那一句。
 *
 * 编辑态的读法与 `varRows` 同一条:**一行不丢** —— 刚点「加一样」出来的空行必须留得住。
 */
function OptionsTable({
  value,
  onChange,
  insertables,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
  insertables?: InsertableGroup[];
}) {
  const { t } = useI18n();
  const rows = optionRows(value);
  const write = (next: OptionRow[]): void => onChange(next);
  const patch = (at: number, key: keyof OptionRow, text: string): void =>
    write(rows.map((row, i) => (i === at ? { ...row, [key]: text } : row)));

  // 每行内容框的 ref —— 「插入变量」要插到**那一行**的光标处。按行号存,行删了
  // React 会用 null 把旧条目冲掉,不会留下悬空的框。
  const contentRefs = useRef(new Map<number, HTMLTextAreaElement>());
  const setContentRef = (at: number) => (el: HTMLTextAreaElement | null) => {
    if (el) contentRefs.current.set(at, el);
    else contentRefs.current.delete(at);
  };

  const insertAt = (at: number, snippet: string): void => {
    const el = contentRefs.current.get(at);
    const text = rows[at]?.content ?? "";
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? start;
    const next = insertSnippet(text, start, end, snippet);
    patch(at, "content", next.value);
    // 光标落在插进来的那段后面 —— 等 React 把新值写回 DOM 再设(同 ParamField 的做法)。
    requestAnimationFrame(() => {
      const node = contentRefs.current.get(at);
      if (!node) return;
      node.focus();
      node.setSelectionRange(next.caret, next.caret);
    });
  };

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
              placeholder={t("settings.workflows.optName")}
              onChange={(e) => patch(i, "name", e.target.value)}
            />
            <button
              type="button"
              title={t("settings.workflows.optRemove")}
              aria-label={t("settings.workflows.optRemove")}
              onClick={() => write(rows.filter((_, j) => j !== i))}
              className="shrink-0 rounded p-1 text-content-subtle transition-colors hover:bg-surface-hover/60 hover:text-content"
            >
              <IconX size={12} />
            </button>
          </div>
          <GrowingTextarea
            value={row.content}
            placeholder={t("settings.workflows.optContent")}
            inputRef={setContentRef(i)}
            onChange={(text) => patch(i, "content", text)}
          />
          <GrowingTextarea
            value={row.note}
            placeholder={t("settings.workflows.optNote")}
            onChange={(text) => patch(i, "note", text)}
          />
          {insertables && (
            <InsertVarMenu groups={insertables} onPick={(snippet) => insertAt(i, snippet)} />
          )}
        </div>
      ))}
      {rows.length === 0 && (
        <p className="text-[0.7143em] leading-relaxed text-content-subtle">
          {t("settings.workflows.optEmpty")}
        </p>
      )}
      <Button
        variant="secondary"
        size="sm"
        onClick={() => write([...rows, { name: "", content: "", note: "" }])}
        className="gap-1"
      >
        <IconPlus size={12} />
        {t("settings.workflows.optAdd")}
      </Button>
    </div>
  );
}

/** 选项表在编辑态的一行。 */
interface OptionRow {
  name: string;
  content: string;
  note: string;
}

/** 读出选项表的每一行。**一行不丢地端上来** —— 理由见 {@link OptionsTable}。 */
function optionRows(value: unknown): OptionRow[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const row = (typeof item === "object" && item !== null ? item : {}) as {
      name?: unknown;
      content?: unknown;
      note?: unknown;
    };
    return {
      name: typeof row.name === "string" ? row.name : "",
      content: typeof row.content === "string" ? row.content : "",
      note: typeof row.note === "string" ? row.note : "",
    };
  });
}

/**
 * 「条件名 + 候选值」的表 —— `kind: "selects"` 的控件。
 *
 * 它是主对话入口节点的**固定条件**:每一行会变成聊天输入框上方**一个**下拉框,选中
 * 的值每轮随提示词注入。**候选值一行一个**(多行框):条件名是标识符级别的短词,而
 * 候选值可能很长(「只要 T1(Q1 或中科院 1 区,或 Top)」),单行框装不下。
 *
 * 候选值是**字面量** —— 选中哪个,注入的就是哪个,所以这里**没有**「插入变量」:
 * `{{...}}` 在下拉里不是个能选的值。与 `varRows`/`optionRows` 同一条读法:**一行不丢**。
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
  const write = (next: CritRow[]): void => onChange(next);
  const patch = (at: number, key: keyof CritRow, text: string): void =>
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
          <GrowingTextarea
            value={row.choices}
            placeholder={t("settings.workflows.critChoices")}
            onChange={(text) => patch(i, "choices", text)}
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
        onClick={() => write([...rows, { name: "", choices: "" }])}
        className="gap-1"
      >
        <IconPlus size={12} />
        {t("settings.workflows.critAdd")}
      </Button>
    </div>
  );
}

/** 固定条件表在编辑态的一行。候选值按行存(编辑器里一行一个),写回时切行。 */
interface CritRow {
  name: string;
  choices: string;
}

/** 读出条件表的每一行。**一行不丢地端上来** —— 理由同 {@link OptionsTable}。 */
function critRows(value: unknown): CritRow[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const row = (typeof item === "object" && item !== null ? item : {}) as {
      name?: unknown;
      choices?: unknown;
    };
    return {
      name: typeof row.name === "string" ? row.name : "",
      choices: Array.isArray(row.choices)
        ? row.choices.filter((c): c is string => typeof c === "string").join("\n")
        : "",
    };
  });
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
}: {
  spec: NodeParamSpec;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const { t } = useI18n();
  // `from` 缺了是**不该发生**的(清单校验会拒掉没写 `from` 的引用型参数)。真缺了就
  // 当成"没有候选"往下走 —— 宁可显示"这台机器上还没有可选的项",也不要随手挑一份
  // 别的来源的列表填上去(那会让一个坏清单看起来是好的)。
  const options = useRefOptions(spec.from ?? "models");
  const candidates = spec.from ? options : [];
  const text = typeof value === "string" ? value : "";
  const selected = stringListOf(value);

  if (spec.multiple) {
    return <MultiRefValue candidates={candidates} selected={selected} onChange={onChange} />;
  }

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
        onClick={() => setOpen((v) => !v)}
        title={t(open ? "settings.workflows.paramRefCollapse" : "settings.workflows.paramRefExpand")}
        className={cn(
          "flex w-full items-center gap-1.5 rounded border border-edge bg-surface px-2 py-1 text-left text-[0.7857em] transition-colors",
          "hover:border-accent/60",
        )}
      >
        <span className={cn("min-w-0 flex-1 truncate", selected.length === 0 && "text-content-muted")}>
          {selected.length === 0
            ? t("settings.workflows.paramRefUnlimited")
            : selected.join("、")}
        </span>
        <span className="shrink-0 text-[0.7143em] text-content-subtle">
          {selected.length === 0
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
