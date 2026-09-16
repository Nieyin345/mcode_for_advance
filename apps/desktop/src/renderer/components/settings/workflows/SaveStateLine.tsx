/**
 * 保存状态那一行 —— 「有未保存的改动」/「保存中…」/「保存受阻」。
 *
 * ## 为什么单独一个文件
 *
 * 它和 `SaveState` 那个类型是一对,而**持有者与显示者现在是两处**:状态由
 * `WorkflowLibraryView` 算(`saveState` 是几个值算出来的,不另存一份状态机),
 * 显示在编辑区标题行、紧挨着「保存」那颗按钮。
 *
 * 早先它长在 `NodeInspector` 里(右侧面板有两处引它),那时保存是自动的、没按钮,
 * 状态只能挂在表单边上。改成手动保存之后,这两个东西必须和按钮在一起 —— 用户要能
 * 一眼看出"现在点下去会存什么"。放在组件里的话,要显示它就得把整个检查器拖过来。
 */
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconAlertTriangle } from "@renderer/lib/icons.js";

/** 一次编辑的保存状态。由 `WorkflowLibraryView` 持有,这里只显示。 */
export type SaveState =
  /** 草稿和磁盘上那一份一致。 */
  | { kind: "clean" }
  /** 有改动,还没点保存。 */
  | { kind: "pending" }
  | { kind: "saving" }
  /** 存不下去 —— 校验没过或者 IPC 报错。`message` 是可以直接显示的一句话。 */
  | { kind: "error"; message: string };

/** 保存的状态行。**刻意做得很轻**:它常驻在那儿,不该跟"这个工作流是干什么的"
 *  抢注意力,所以只在有事时说一句;出问题时才换成警告色。
 *
 *  ⚠️ **校验没过不算"错误",算"还没到能存的时候"** —— 用户在参数框里全选重打的那
 *  一瞬间必然经过一个空值,那一刻弹一句红字是骚扰。所以这里用的是中性的措辞。 */
export function SaveStateLine({ state }: { state: SaveState }) {
  const { t } = useI18n();
  if (state.kind === "clean") return null;
  if (state.kind === "error") {
    return (
      <span
        className="flex min-w-0 items-center gap-1 text-[0.7143em] text-warning"
        title={state.message}
      >
        <IconAlertTriangle size={11} className="shrink-0" />
        <span className="shrink-0">{t("settings.workflows.saveBlocked")}</span>
        {/*
          **把原因写出来,而不是只塞进 `title`。**

          只说一句「保存受阻」等于什么都没说:用户唯一能知道发生了什么的方式是把鼠标
          停上去等一个 tooltip,而"图里有环,涉及节点:成稿、稿子怎么样"这种话**恰恰是
          他唯一能照着修的东西**。藏在 tooltip 里的话,现象就是"点保存没反应"。

          `title` 留着(长句子会被截断),但句子本身必须在明面上。
        */}
        <span className="min-w-0 truncate opacity-80">· {state.message}</span>
      </span>
    );
  }
  return (
    <span className="shrink-0 text-[0.7143em] text-content-subtle">
      {state.kind === "saving"
        ? t("settings.workflows.saving")
        : t("settings.workflows.savePending")}
    </span>
  );
}
