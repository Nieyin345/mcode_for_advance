/**
 * 自定义 UI 的**根级宿主**:自定义项「打开视图」弹的那个浮窗 + 批量运行前的确认框。
 *
 * 挂在 `App` 根上一份(同 `AskChoiceDialog` 的理由):菜单点完就关了,弹出来的东西不能
 * 跟着菜单一起卸载;而同一个视图从左栏资料库、右栏 Files 都能弹,挂在任何一个面板里
 * 另一边就看不见。顺带在这里读一次配置 —— 应用一起来菜单就按用户摆好的样子画。
 */
import { useEffect, useState } from "react";
import { customUiLabel, type CustomUiInput } from "@contracts/customUi";
import { Markdown } from "@renderer/components/chat/Markdown.js";
import { Button, ConfirmDialog } from "@renderer/components/ui/index.js";
import { Dialog } from "@renderer/components/ui/dialog.js";
import { api } from "@renderer/lib/api.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";
import { useCustomUiStore, type CustomUiForm } from "@renderer/stores/customUiStore.js";

export function CustomUiHost() {
  const view = useCustomUiStore((s) => s.view);
  const closeView = useCustomUiStore((s) => s.closeView);
  const confirm = useCustomUiStore((s) => s.confirm);
  const closeConfirm = useCustomUiStore((s) => s.closeConfirm);
  const form = useCustomUiStore((s) => s.form);
  const closeForm = useCustomUiStore((s) => s.closeForm);
  const load = useCustomUiStore((s) => s.load);

  useEffect(() => {
    void load();
  }, [load]);

  useSuppressBrowserView(view !== null || confirm !== null || form !== null);

  return (
    <>
      <Dialog.Root
        open={view !== null}
        onOpenChange={(open) => {
          if (!open) closeView();
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop />
          {/* `transform-none` + 四边归零居中 —— 同 `ItemInfoDialog`(transform 居中会成为
              后代 `fixed` 的包含块)。 */}
          <Dialog.Popup className="bottom-0 left-0 right-0 top-0 m-auto h-fit w-[560px] max-w-[92vw] transform-none p-4">
            <Dialog.Title className="truncate">{view?.title ?? ""}</Dialog.Title>
            <div className="mt-3 max-h-[65vh] overflow-y-auto text-sm" data-testid="custom-ui-view">
              {view && <Markdown>{view.body}</Markdown>}
            </div>
            <Dialog.Close />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.title ?? ""}
        description={confirm?.description ?? ""}
        confirmText={confirm?.confirmText}
        onOpenChange={(open) => {
          if (!open) closeConfirm();
        }}
        onConfirm={() => {
          const c = confirm;
          closeConfirm();
          c?.onConfirm();
        }}
      />
      {/* `key` 按这一次打开的表单算:换一个自定义项时,上一份填过的值不会留在框里。 */}
      {form !== null && <InputFormDialog key={form.id} form={form} onClose={closeForm} />}
    </>
  );
}

/**
 * automation 动作「运行前输入」的原生小表单(`@contracts/customUi` 的 inputs)。
 * 没有脚本、没有自定义校验 —— text 是文本框,files 走系统文件选择器
 * (`api.pickFiles`,主进程原生对话框,返回绝对路径)。required 项没值不许提交。
 */
function InputFormDialog({ form, onClose }: { form: CustomUiForm; onClose: () => void }) {
  const { t, locale } = useI18n();
  const [values, setValues] = useState<Record<string, string | string[]>>({});

  const labelOf = (i: CustomUiInput): string => (i.label ? customUiLabel(i.label, locale) : i.key);
  const missing = form.inputs.some((i) => {
    if (i.required !== true) return false;
    const v = values[i.key];
    return v === undefined || (typeof v === "string" ? v.trim() === "" : v.length === 0);
  });
  const pick = async (key: string) => {
    const picked = await api.pickFiles({});
    if (picked.paths.length > 0) setValues((prev) => ({ ...prev, [key]: picked.paths }));
  };
  const submit = () => {
    // 空值不进载荷:自动化端「哪个有值办哪个」,不必为空串写分支。
    const out: Record<string, string | string[]> = {};
    for (const i of form.inputs) {
      const v = values[i.key];
      if (v === undefined) continue;
      if (typeof v === "string" ? v.trim() !== "" : v.length > 0) out[i.key] = typeof v === "string" ? v.trim() : v;
    }
    onClose();
    form.onSubmit(out);
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="bottom-0 left-0 right-0 top-0 m-auto h-fit w-[440px] max-w-[92vw] transform-none space-y-3 p-4">
          <Dialog.Title className="truncate">{form.title}</Dialog.Title>
          {form.inputs.map((i) => (
            <label key={i.key} className="block space-y-1 text-[0.8571em] text-content-muted">
              <span>
                {labelOf(i)}
                {i.required === true && <span className="text-danger"> *</span>}
              </span>
              {i.kind === "text" ? (
                <input
                  className="w-full rounded-md border border-edge bg-surface px-2.5 py-1.5 text-xs text-content outline-none focus:border-accent"
                  value={typeof values[i.key] === "string" ? (values[i.key] as string) : ""}
                  onChange={(e) => setValues((prev) => ({ ...prev, [i.key]: e.target.value }))}
                />
              ) : (
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="ghost" onClick={() => void pick(i.key)}>
                    {t("customUi.form.pickFiles")}
                  </Button>
                  <span className="min-w-0 flex-1 truncate text-[0.8571em] text-content-subtle">
                    {Array.isArray(values[i.key]) && (values[i.key] as string[]).length > 0
                      ? t("customUi.form.filesCount", { n: (values[i.key] as string[]).length })
                      : t("customUi.form.noFiles")}
                  </span>
                </div>
              )}
            </label>
          ))}
          <div className="flex justify-end gap-2">
            <Button size="md" variant="ghost" onClick={onClose}>
              {t("customUi.form.cancel")}
            </Button>
            <Button size="md" variant="primary" disabled={missing} onClick={submit} data-testid="custom-ui-form-run">
              {t("customUi.form.run")}
            </Button>
          </div>
          <Dialog.Close />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
