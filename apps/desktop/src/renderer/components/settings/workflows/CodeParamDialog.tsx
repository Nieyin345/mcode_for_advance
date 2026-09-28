/**
 * 「在编辑器中打开」弹出的那扇窗 —— 一个铺满大半屏的 Monaco。
 *
 * **单独一个文件是为了让它能被 `lazy()` 掉**(见 `CodeParamField`):Monaco 连同它的
 * worker 是渲染进程里最大的一块,设置页不该在打开的时候就把它拖进来。
 *
 * 语言跟着节点上那一格「Language」走。映射写在这里而不是契约里:契约那边是**运行时**
 * 认的名字(`python` / `node` / `shell` / `powershell`,即真的去起哪个解释器),Monaco
 * 认的是**语法**的名字(`javascript`、`shell`)—— 两张表碰巧重合了一半,但它们回答的
 * 不是同一个问题,合成一张迟早会因为"加一个运行时"而互相牵扯。
 */
import { useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import type { editor } from "monaco-editor";
// Monaco 的 worker 配置(本地实例,不走 CDN),必须在任何 <Editor> 挂载前跑过一次。
// 和 FileEditor / PlanViewer 是同一个副作用导入:这扇窗可能在文件编辑器从没挂过的
// 情况下打开(用户直接进设置页配自动化),所以这里也得来一次。
import "@renderer/lib/monacoSetup.js";
import { Dialog } from "@renderer/components/ui/index.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";

/**
 * 当前该用哪套 Monaco 配色 —— `FileEditor` 里那个 `useMonacoTheme` 的**独立副本**。
 *
 * ⚠️ 看着像该复用,但**不能从这里 import `FileEditor`**:它两千多行,还牵着 IDE 的
 * 一整片(LSP provider、model 缓存、各种预览面板)。这扇窗是被 `lazy()` 掉的,可
 * **dev 下 Vite 会顺着模块图把动态 import 的目标也预热** —— 于是"打开设置页"变成
 * "顺带把整个 IDE 转译一遍",页面白屏等上好久。实测就是这么坏的。
 *
 * 所以这里复制这二十行,换掉那条边。两边会不会漂移:会,但漂了最多是弹窗配色跟编辑器
 * 差一档;而合并它们的代价是设置页打不开。
 */
function useEditorTheme(): string {
  const [dark, setDark] = useState(() =>
    typeof document !== "undefined" ? document.documentElement.classList.contains("dark") : true,
  );
  useEffect(() => {
    const el = document.documentElement;
    let timer: number | undefined;
    // 延一下再切:主题切换有一段 180ms 的 CSS 过渡,立刻换会闪一下旧配色(同 FileEditor)。
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

/** 运行时的名字 → Monaco 的语法 id。认不出来的一律按纯文本处理(总比高亮错了强)。 */
const MONACO_LANGUAGE: Record<string, string> = {
  python: "python",
  node: "javascript",
  shell: "shell",
  powershell: "powershell",
};

/** 语法 id → 文件后缀。只用来拼 model 的路径:Monaco 靠它认语言,后缀对了高亮才对。 */
const EXTENSION: Record<string, string> = {
  python: "py",
  javascript: "js",
  shell: "sh",
  powershell: "ps1",
  plaintext: "txt",
};

export function CodeParamDialog({
  label,
  value,
  language,
  modelId,
  onChange,
  onClose,
}: {
  label: string;
  value: string;
  language: string;
  /** 调用方给的唯一串,用来隔开不同节点的 model(见 `CodeParamField`)。 */
  modelId: string;
  onChange: (value: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const theme = useEditorTheme();
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoLanguage = MONACO_LANGUAGE[language] ?? "plaintext";
  const path = `__nodeparam__/${modelId.replace(/[^a-zA-Z0-9]/g, "")}.${EXTENSION[monacoLanguage] ?? "txt"}`;

  // 开窗就把光标放进去 —— 点「在编辑器中打开」的人下一个动作一定是打字。
  useEffect(() => {
    const id = window.setTimeout(() => editorRef.current?.focus(), 60);
    return () => window.clearTimeout(id);
  }, []);

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="flex h-[78vh] w-[min(1080px,88vw)] flex-col p-0">
          <div className="flex items-center justify-between border-b border-edge px-4 py-2.5">
            <Dialog.Title>{label}</Dialog.Title>
            {/* 语言不在这儿选:它是节点上的一格参数,两处都能改的东西必然会对不上。 */}
            <span className="mr-7 text-[0.7143em] text-content-subtle">
              {t("settings.workflows.codeParam.language", { name: language })}
            </span>
            <Dialog.Close />
          </div>
          <div className="min-h-0 flex-1">
            <Editor
              path={path}
              language={monacoLanguage}
              value={value}
              theme={theme}
              onChange={(next) => onChange(next ?? "")}
              onMount={(instance) => {
                editorRef.current = instance;
              }}
              options={{
                // 这是一格**参数**,不是一个文件:没有面包屑、没有缩略图、没有
                // "保存"的概念(值每次击键就写回节点了)。
                minimap: { enabled: false },
                lineNumbers: "on",
                tabSize: 4,
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
              {t("settings.workflows.codeParam.liveHint")}
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
