/**
 * 「导入 / 导出」那一段 —— 检查器里「工作流本体」那一块的最后一节。
 *
 * ## 两个动作是**文档级**的,所以住在文档级的那一块
 *
 * 导出导的是**磁盘上那一份**(不是画布上那份草稿),导入整份替换 / 新增一行 —— 两者
 * 都不是"某个节点"的事,所以它们跟名称、流程文字、删除按钮住在一起,而不是跑到节点
 * 检查器里去。
 *
 * ## 文件对话框全在主进程
 *
 * 渲染端读不了任意路径(`file.readFile` 被项目根闸门挡着,而用户挑的文件多半在项目
 * 外),也没有保存框那一层 API。所以这里只发 id / 收文本,挑路径读写都是主进程的事
 * (见 `main/ipc/orchestration.ts`)。这条也决定了**手机端点不了**:`webApi.ts` 里这
 * 三条是 `webUnsupported`,在那里没有文件对话框可用 —— 点下去只会得来一句报错。
 *
 * ## 覆盖 = **整份替换掉库里那一行**
 *
 * 「覆盖当前工作流」是真的覆盖:图、参数、流程文字全按文件里那份来,库里原来那份没了。
 * 所以它要过一道确认框(和删除同一个形状),而**这一步不能省** —— 导入按钮就摆在
 * 「删除」上面一格,误点一下就是一次不可撤销的替换。
 *
 * ## 草稿会先收起来,再报一句
 *
 * 导入成功之后画布上那份未保存的改动就无从谈起了(它属于旧的那一份)。这里**不替用户
 * 保存**,只让父组件把那半份收进草稿袋并切到新的 id 上 —— 同「新建」那条路。
 */
import { useState } from "react";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { Button, ConfirmDialog } from "@renderer/components/ui/index.js";
import { IconAlertTriangle, IconDownload, IconUpload } from "@renderer/lib/icons.js";
import { workflowDisplayName } from "@renderer/lib/workflowLabels.js";
import type { WorkflowDoc } from "@contracts/workflow";
import { Field } from "./ParamField.js";

/** 失败时把原因摆出来 —— 可能是好几条(校验报告里每一条都说清了哪里不对)。 */
function describeErrors(errors: readonly string[], fallback: string): string {
  if (errors.length === 0) return fallback;
  return errors.slice(0, 3).join("; ");
}

export function TransferSection({
  doc,
  onImported,
}: {
  doc: WorkflowDoc;
  /** 导入成功之后叫一声(落库后的 id)。父组件据此收草稿 + 切过去。 */
  onImported: (id: string) => void;
}) {
  const { t, locale } = useI18n();
  const [busy, setBusy] = useState(false);
  const [pendingOverwrite, setPendingOverwrite] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 上一次导出的落点。摆出来,不然"到底导到哪去了"只能靠回忆那个系统弹框。 */
  const [savedTo, setSavedTo] = useState<string | null>(null);

  const name = workflowDisplayName(doc, locale);

  const doExport = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      // 文件名按**当前界面语言**给 —— 主进程不知道用户此刻用的哪种语言(同
      // `dialog.pickFiles` 的 title 由调用方给)。它只当建议用,自己还会洗一遍。
      const res = await api.workflow.export({
        id: doc.id,
        suggestedName: `${name}${t("settings.workflows.exportFileSuffix")}`,
      });
      if (!res.ok) {
        if (!res.canceled) setError(res.error ?? t("settings.workflows.unknownError"));
        return;
      }
      setSavedTo(res.path ?? null);
    } catch (err) {
      setError(t("settings.workflows.actionFailed", { error: (err as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  /**
   * 从文件导入。`overwrite` 为真时覆盖**当前打开的这一份**(同 id),否则新存一份。
   *
   * 两条路都走主进程那同一个 handler —— 差别只有"要不要带上 id",解析/校验/落库一份
   * 都不重复。
   */
  const doImport = async (overwrite: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    setSavedTo(null);
    try {
      const res = await api.workflow.importFromFile(overwrite ? { id: doc.id } : {});
      if (!res.ok) {
        if (!res.canceled) {
          setError(
            describeErrors(res.errors ?? [], res.error ?? t("settings.workflows.unknownError")),
          );
        }
        return;
      }
      setPendingOverwrite(false);
      onImported(res.id!);
    } catch (err) {
      setError(t("settings.workflows.actionFailed", { error: (err as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 border-t border-edge pt-3">
      <Field label={t("settings.workflows.transferTitle")}>
        {/* 两个按钮**并排**,而不是一个下拉。用户要的是"把这个拿出去"和"把那个拿进来"
            这两件事,而它们各自只有一条路 —— 藏进菜单只会多一次点击。 */}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            className="gap-1"
            disabled={busy}
            onClick={() => void doExport()}
          >
            <IconDownload size={12} />
            {t("settings.workflows.export")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="gap-1"
            disabled={busy}
            onClick={() => void doImport(false)}
          >
            <IconUpload size={12} />
            {t("settings.workflows.importNew")}
          </Button>
          {/* 「覆盖」只在**自建的**工作流上出现。内置那一份覆盖掉就回不去了(它的默认
              版确实还在代码里,但「恢复默认」在这个流程里没被提到,用户不会想到),
              而"把别人分享的图覆盖成内置的那一条"本来也不是他想要的。 */}
          {!doc.builtin && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setPendingOverwrite(true)}
            >
              {t("settings.workflows.importOverwrite")}
            </Button>
          )}
        </div>
      </Field>

      <p className="-mt-1 text-[0.7143em] leading-relaxed text-content-subtle">
        {t("settings.workflows.transferHint")}
      </p>
      {savedTo !== null && (
        <p className="mt-1 break-all text-[0.7143em] leading-relaxed text-content-muted">
          {t("settings.workflows.exportedTo", { path: savedTo })}
        </p>
      )}
      {error !== null && (
        <p className="mt-1 flex items-start gap-1.5 text-[0.7143em] leading-relaxed text-danger">
          <IconAlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </p>
      )}

      <ConfirmDialog
        open={pendingOverwrite}
        danger
        title={t("settings.workflows.importOverwriteTitle")}
        description={t("settings.workflows.importOverwriteDesc", { name })}
        confirmText={t("settings.workflows.importOverwrite")}
        onOpenChange={(open) => {
          if (!open) setPendingOverwrite(false);
        }}
        onConfirm={() => void doImport(true)}
      />
    </div>
  );
}
