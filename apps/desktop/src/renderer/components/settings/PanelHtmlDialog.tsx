/**
 * 面板 HTML 的**大编辑器**(报告 E8)—— 设置页那格「面板 HTML」旁边的「在编辑器中打开」。
 *
 * ## 为什么单独一个文件
 *
 * 和 `workflows/CodeParamDialog` 同一条理由:Monaco 是渲染进程里最大的一块 JS,它必须
 * 被 `lazy()` 掉 —— 打开设置页不该为"可能要写面板 HTML"付这笔钱。单独成文件,动态 import
 * 才切得出独立 chunk(`settings-lazy-smoke` 盯着设置外壳的静态图里不许出现 Monaco)。
 *
 * ## 值什么时候写回
 *
 * **每一次击键都写回草稿**(同 `CodeParamField`)。设置页本来就有一层显式的「保存」,
 * 用户心里的"还没存"指的是那一个;这扇窗再来一套"确定才生效"只会让人搞不清。
 *
 * ## 与那格 textarea 的关系
 *
 * 不是取代,是**放大**:窄栏里那格 textarea 依然能直接敲(短片段够用),要写一段带
 * 样式的完整 HTML 时点开这扇窗,借 Monaco 的 HTML 语法高亮 + 大空间。
 */
import { useEffect, useId, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import type { editor } from "monaco-editor";
// Monaco 的 worker 配置(本地实例,不走 CDN),必须在任何 <Editor> 挂载前跑过一次。
// 同 FileEditor / PlanViewer / CodeParamDialog —— 它可能在文件编辑器从没挂过的情况下打开。
import "@renderer/lib/monacoSetup.js";
import { Dialog } from "@renderer/components/ui/index.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";

/**
 * 当前该用哪套 Monaco 配色 —— 与 `CodeParamDialog` 里那份同样的**独立副本**,理由见它
 * 文件头(从 `FileEditor` import 会把整个 IDE 拖进设置页的模块图,dev 下尤其致命)。
 */
function useEditorTheme(): string {
  const [dark, setDark] = useState(() =>
    typeof document !== "undefined" ? document.documentElement.classList.contains("dark") : true,
  );
  useEffect(() => {
    const el = document.documentElement;
    let timer: number | undefined;
    const observer = new MutationObserver(() => {
      const isDark = el.classList.contains("dark");
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setDark(isDark), 150);
    });
    observer.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, []);
  const darkScheme = useSessionStore((s) => s.editorTheme.dark);
  const lightScheme = useSessionStore((s) => s.editorTheme.light);
  return dark ? darkScheme : lightScheme;
}

export function PanelHtmlDialog({
  value,
  onChange,
  onClose,
}: {
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const theme = useEditorTheme();
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  // 每个实例一个稳定 model 路径 —— 换成跟着内容变的值会每次击键重建 model、丢撤销栈。
  const modelId = useId();

  // 开窗就把光标放进去 —— 点「在编辑器中打开」的人下一个动作一定是打字。
  useEffect(() => {
    const id = window.setTimeout(() => editorRef.current?.focus(), 60);
    return () => window.clearTimeout(id);
  }, []);

  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="flex h-[82vh] w-[min(1120px,90vw)] flex-col p-0">
          <div className="flex items-center justify-between border-b border-edge px-4 py-2.5">
            <Dialog.Title>{t("customUi.editor.panelHtml")}</Dialog.Title>
            <Dialog.Close />
          </div>
          <div className="min-h-0 flex-1">
            <Editor
              path={`__panel_html__/${modelId.replace(/[^a-zA-Z0-9]/g, "")}.html`}
              language="html"
              value={value}
              theme={theme}
              onChange={(next) => onChange(next ?? "")}
              onMount={(instance) => {
                editorRef.current = instance;
              }}
              options={{
                minimap: { enabled: false },
                lineNumbers: "on",
                tabSize: 2,
                insertSpaces: true,
                scrollBeyondLastLine: false,
                automaticLayout: true,
                fontSize: 13,
                wordWrap: "on",
                renderWhitespace: "selection",
                padding: { top: 10, bottom: 10 },
              }}
            />
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-edge px-4 py-2">
            <span className="mr-auto text-[0.7143em] text-content-subtle">
              {t("customUi.editor.panelHtmlLiveHint")}
            </span>
            <Dialog.Close className="static rounded border border-edge px-3 py-1 text-xs text-content hover:bg-surface-muted">
              {t("common.close")}
            </Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
