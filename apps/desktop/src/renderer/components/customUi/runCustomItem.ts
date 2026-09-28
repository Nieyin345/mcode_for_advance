/**
 * 执行一条**自定义项**的动作(内置项的动作由挂载它的菜单自己带,不走这里)。
 *
 * 动作见 `@contracts/customUi` 的 `CustomUiActionSchema`。全部是渲染端能做完的事,
 * 只有「运行自动化」要过一次 IPC:右键菜单走 `customUi.runAutomation`(展开分类/大类成
 * 条目清单、过滤回收站、校验文件在项目里,都在主进程);工具栏没有目标,走的是自动化页
 * 那颗「立刻跑一次」(`automation.run`)。
 *
 * 右栏页签上的项不经过这里 —— 页签是常驻显示区,由 `CustomTabView` 画。
 */
import {
  customUiLabel,
  renderTemplate,
  resolveWorkspacePath,
  templateVarsOf,
  type CustomUiItem,
  type CustomUiRunTarget,
  type CustomUiTarget,
} from "@contracts/customUi";
import { api } from "@renderer/lib/api.js";
import { attachToCurrentChat } from "@renderer/lib/attachToChat.js";
import { translate, type MessageId } from "@renderer/lib/i18n/core.js";
import { openRightPanelTab, useCustomUiStore } from "@renderer/stores/customUiStore.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { useToastStore, type ToastKind } from "@renderer/stores/toastStore.js";

function tr(key: MessageId, params?: Record<string, string | number>): string {
  return translate(useSessionStore.getState().locale, key, params);
}

function toast(kind: ToastKind, key: MessageId, body?: string, params?: Record<string, string | number>): void {
  useToastStore.getState().push({ kind, title: tr(key, params), body });
}

/** 资料库目标在「挂进对话」那条通道上的键(与各级右键的「加入当前对话」同一套)。 */
export function attachKeyOf(target: CustomUiTarget): string | null {
  switch (target.kind) {
    case "item":
      return `i:${target.item.id}`;
    case "collection":
      return `c:${target.collection.id}`;
    case "group":
      return `g:${target.group.id}`;
    case "file":
    case "workspace":
      return null;
  }
}

/** 右键目标 → 主进程的运行目标;工具栏(`workspace`)没有目标 → `null`。 */
export function runTargetOf(target: CustomUiTarget): CustomUiRunTarget | null {
  switch (target.kind) {
    case "item":
      return { kind: "item", itemId: target.item.id };
    case "collection":
      return { kind: "collection", collectionId: target.collection.id };
    case "group":
      return { kind: "group", groupId: target.group.id };
    case "file":
      return { kind: "file", path: target.path };
    case "workspace":
      return null;
  }
}

async function runAutomation(
  item: CustomUiItem,
  action: Extract<CustomUiItem["action"], { type: "automation" }>,
  target: CustomUiTarget,
): Promise<void> {
  const name = customUiLabel(item.label, useSessionStore.getState().locale);
  const runTarget = runTargetOf(target);
  // 运行前输入(P2):先弹表单收值,值以 input 附进请求(载荷侧拍平成
  // {{trigger.input.<key>}})。v1 只支持有目标的挂载位 —— 工具栏的 automation
  // 走 runNow(没有 input 通道),带 inputs 的项在这里如实提示而不是静默丢输入。
  if ((action.inputs?.length ?? 0) > 0) {
    if (runTarget === null) {
      toast("warning", "customUi.run.inputsNeedTarget");
      return;
    }
    useCustomUiStore.getState().openForm({
      title: name,
      inputs: action.inputs ?? [],
      onSubmit: (values) => void runAutomationWithTarget(item, action, target, runTarget, values),
    });
    return;
  }
  if (runTarget === null) {
    // 工具栏:同自动化页的「立刻跑一次」(manual 那条路,用户关掉的触发器也能跑)
    try {
      const res = await api.automation.run({ workflowId: action.workflowId, triggerNodeId: action.triggerNodeId });
      if (res.ok) toast("info", "customUi.run.startedToolbar", undefined, { name });
      else toast("error", "customUi.run.failed", res.error);
    } catch (err) {
      toast("error", "customUi.run.failed", err instanceof Error ? err.message : String(err));
    }
    return;
  }
  await runAutomationWithTarget(item, action, target, runTarget);
}

/** 有目标的 automation 运行(dryRun 确认 / skipWhen / 可选的运行前输入值)。 */
async function runAutomationWithTarget(
  item: CustomUiItem,
  action: Extract<CustomUiItem["action"], { type: "automation" }>,
  target: CustomUiTarget,
  runTarget: CustomUiRunTarget,
  inputValues?: Readonly<Record<string, string | string[]>>,
): Promise<void> {
  const name = customUiLabel(item.label, useSessionStore.getState().locale);
  // 「目标只是落点」那一种(文献导入):不展开条目、不数条数,所以下面那套
  // dryRun + 确认框整段跳过 —— 那套问的是"要对多少条现有条目办事",而这里的答案恒为零。
  const context = action.targetMode === "context";
  const input = {
    workflowId: action.workflowId,
    triggerNodeId: action.triggerNodeId,
    target: runTarget,
    ...(context ? { targetMode: "context" as const } : {}),
    ...(action.skipWhen ? { skipWhen: action.skipWhen } : {}),
    ...(inputValues && Object.keys(inputValues).length > 0 ? { input: inputValues } : {}),
  };
  const go = async (expectCount?: number): Promise<void> => {
    try {
      const res = await api.customUi.runAutomation(
        expectCount === undefined ? input : { ...input, expectCount },
      );
      if (res.ok) toast("info", "customUi.run.started", undefined, { name, n: res.count ?? 1 });
      else toast("error", "customUi.run.failed", res.error);
    } catch (err) {
      toast("error", "customUi.run.failed", err instanceof Error ? err.message : String(err));
    }
  };
  // 分类 / 大类是**一批**:先数清楚会带多少条、让用户点一次确认,再真跑 ——
  // 右键误点一下就让一条自动化对两百篇论文开工,代价太大。
  if (!context && (target.kind === "collection" || target.kind === "group")) {
    try {
      const dry = await api.customUi.runAutomation({ ...input, dryRun: true });
      if (!dry.ok) {
        // 全部被 skipWhen 跳过是"没活可干",不是失败(典型:这个分类都转录过了)。
        if ((dry.skipped ?? 0) > 0 && (dry.count ?? 0) === 0) toast("info", "customUi.run.allSkipped", dry.error, { name });
        else toast("error", "customUi.run.failed", dry.error);
        return;
      }
      useCustomUiStore.getState().openConfirm({
        title: tr("customUi.run.confirmTitle", { name }),
        description:
          (dry.skipped ?? 0) > 0
            ? tr("customUi.run.confirmBodySkip", { n: dry.count ?? 0, m: dry.skipped ?? 0 })
            : tr("customUi.run.confirmBody", { n: dry.count ?? 0 }),
        confirmText: tr("customUi.run.confirm"),
        // 把用户点头的那个数字一起带过去:两次展开之间库变了就整次拒绝(见契约的 expectCount)。
        onConfirm: () => void go(dry.count ?? 0),
      });
    } catch (err) {
      toast("error", "customUi.run.failed", err instanceof Error ? err.message : String(err));
    }
    return;
  }
  // 单条目:被 skipWhen 跳过时如实说(已有转录 → 不重复转录),别报成失败。
  try {
    const res = await api.customUi.runAutomation(input);
    // context 那一种带的条目数恒为零,报「已开始运行」就够了 —— 说「带 0 条」会让人
    // 以为什么都没带,而表单里的东西明明带过去了。
    if (res.ok && context) toast("info", "customUi.run.startedContext", undefined, { name });
    else if (res.ok) toast("info", "customUi.run.started", undefined, { name, n: res.count ?? 1 });
    else if ((res.skipped ?? 0) > 0 && (res.count ?? 0) === 0) toast("info", "customUi.run.allSkipped", res.error, { name });
    else toast("error", "customUi.run.failed", res.error);
  } catch (err) {
    toast("error", "customUi.run.failed", err instanceof Error ? err.message : String(err));
  }
}

/** `navigator.clipboard` 不可用时的兜底。成功返回 true。 */
function copyViaTextarea(text: string): boolean {
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

export async function runCustomItem(item: CustomUiItem, target: CustomUiTarget): Promise<void> {
  const vars = templateVarsOf(target);
  const action = item.action;
  switch (action.type) {
    case "view": {
      const locale = useSessionStore.getState().locale;
      const title = action.title ? renderTemplate(action.title, vars) : "";
      useCustomUiStore.getState().openView({
        title: title.trim() || customUiLabel(item.label, locale),
        body: renderTemplate(action.body, vars),
      });
      return;
    }
    case "copy": {
      const text = renderTemplate(action.template, vars);
      try {
        await navigator.clipboard.writeText(text);
        toast("info", "customUi.run.copied");
      } catch (err) {
        // `navigator.clipboard` 不是永远都在(非安全上下文、权限被拒)。退回那条老办法:
        // 一个看不见的 textarea + `execCommand("copy")` —— 成了就当成了,别让一条
        // 「复制」在某些窗口里**永远**失败而用户无路可走。
        if (!copyViaTextarea(text)) {
          toast("error", "customUi.run.copyFailed", err instanceof Error ? err.message : String(err));
          return;
        }
        toast("info", "customUi.run.copied");
      }
      return;
    }
    case "prompt": {
      const store = useSessionStore.getState();
      const sessionId = store.activeSessionId;
      if (!sessionId) {
        toast("warning", "customUi.run.noSession");
        return;
      }
      const key = attachKeyOf(target);
      if (action.attach === true && key !== null) await attachToCurrentChat(key);
      const text = renderTemplate(action.template, vars).trim();
      if (text.length > 0) {
        // 放进输入框,不替用户发送(同「跟主对话说」);已有的草稿保留,新内容接在后面。
        //
        // ⚠️ **`html` 不能写死成空串。** 输入框里那份草稿可能是富文本(贴进来的表格、
        // 带格式的引文),`html` 一清用户就只剩纯文本 —— 而他并没有要求删掉什么。
        // 有 html 就在它后面接一段;没有就维持空串(纯文本草稿的原样)。
        const prev = useSessionStore.getState().composerDraftBySession[sessionId];
        const prevText = prev?.text.trim() ?? "";
        const prevHtml = prev?.html ?? "";
        const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        useSessionStore.getState().deliverComposerDraft(sessionId, {
          text: prevText.length > 0 ? `${prevText}\n\n${text}` : text,
          html: prevHtml.trim().length > 0 ? `${prevHtml}<p></p><p>${escaped.replace(/\n/g, "<br>")}</p>` : "",
          tags: prev?.tags ?? [],
        });
        toast("info", "customUi.run.promptDelivered");
      }
      return;
    }
    case "automation":
      await runAutomation(item, action, target);
      return;
    case "file": {
      const projectPath =
        target.kind === "workspace" ? target.project?.path : target.kind === "file" ? target.projectPath : undefined;
      const abs = resolveWorkspacePath(renderTemplate(action.path, vars), projectPath);
      if (abs === null) {
        toast("warning", "customUi.run.noProject");
        return;
      }
      useSessionStore.getState().openFileInIde(abs);
      return;
    }
    case "openTab":
      if (!openRightPanelTab(action.tab, { toggle: true })) toast("warning", "customUi.run.tabMissing");
      return;
  }
}
