/**
 * 自定义 UI 的**根级宿主**:自定义项「打开视图」弹的那个浮窗 + 批量运行前的确认框。
 *
 * 挂在 `App` 根上一份(同 `AskChoiceDialog` 的理由):菜单点完就关了,弹出来的东西不能
 * 跟着菜单一起卸载;而同一个视图从左栏资料库、右栏 Files 都能弹,挂在任何一个面板里
 * 另一边就看不见。顺带在这里读一次配置 —— 应用一起来菜单就按用户摆好的样子画。
 */
import { useEffect } from "react";
import { Markdown } from "@renderer/components/chat/Markdown.js";
import { ConfirmDialog } from "@renderer/components/ui/index.js";
import { Dialog } from "@renderer/components/ui/dialog.js";
import { useSuppressBrowserView } from "@renderer/hooks/useSuppressBrowserView.js";
import { useCustomUiStore } from "@renderer/stores/customUiStore.js";

export function CustomUiHost() {
  const view = useCustomUiStore((s) => s.view);
  const closeView = useCustomUiStore((s) => s.closeView);
  const confirm = useCustomUiStore((s) => s.confirm);
  const closeConfirm = useCustomUiStore((s) => s.closeConfirm);
  const load = useCustomUiStore((s) => s.load);

  useEffect(() => {
    void load();
  }, [load]);

  useSuppressBrowserView(view !== null || confirm !== null);

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
    </>
  );
}
