/**
 * 【ARC-005】真 Electron 端到端 —— 渲染端入口。
 *
 * 挂两样**生产源码**：
 *   1. `HtmlPreviewButton`（从 `FileEditor.tsx` 导出，与编辑器工具栏是同一个实现）；
 *   2. `BrowserPanel`（生产右栏同款，`mode="sidebar"`）。
 *
 * 探针（probe.ts）控制两件事：
 *   - `__hpeSetFile(path)`：把当前"打开的文件"换成给定路径，决定按钮是否渲染；
 *   - `__hpeSetProject(path)`：注入活动项目（真实 store 字段，不用假 store）。
 *
 * 浏览器视图由**真** BrowserManager 创建；URL 只从主进程的
 * `webContents.getURL()` 读（经 preload 桥 `__hpeBrowserUrl`），不读渲染端的
 * 自报状态 —— 否则"真的加载了 file://"就成了自己证明自己。
 */
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { HtmlPreviewButton } from "@renderer/components/ide/FileEditor.js";
import { canPreviewHtml } from "@renderer/components/ide/fileEditorKinds.js";
import { BrowserPanel } from "@renderer/components/browser/BrowserPanel.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";

interface ProbeWindow extends Window {
  __hpeReady?: boolean;
  __hpeSetFile?: (p: string) => void;
  __hpeSetProject?: (p: string) => void;
  __hpeBrowserTabCount?: () => number;
  __hpeBrowserIds?: () => string[];
  __hpeBrowserUrlsAsync?: () => Promise<string[]>;
  __hpeBrowserTitleAsync?: (url: string) => Promise<string | null>;
  __hpeBrowserUrl?: (browserId: string) => Promise<string>;
  __hpeBrowserTitle?: (url: string) => Promise<string | null>;
  __probeError?: string | null;
}
const pw = window as ProbeWindow;
pw.__probeError = null;
pw.__hpeReady = false;

/** 探针往这里推"当前文件"。 */
let setFile: ((p: string) => void) | null = null;
pw.__hpeSetFile = (p) => setFile?.(p);

useSessionStore.setState({ locale: "zh" });

function Harness() {
  const [filePath, setFilePath] = useState<string>("");
  useEffect(() => {
    setFile = setFilePath;
    pw.__hpeReady = true;
    return () => { setFile = null; };
  }, []);

  const projectPath = useSessionStore((s) =>
    s.activeProjectId ? (s.projects.find((p) => p.id === s.activeProjectId)?.path ?? "") : "",
  );

  return (
    <div className="flex h-screen flex-col bg-surface text-content">
      <div id="hpe-toolbar" className="flex h-9 items-center gap-2 border-b border-edge px-2">
        {/* 与生产工具栏同一判据（FileEditor.tsx 的 `{canPreviewHtml && …}`）。 */}
        {filePath && canPreviewHtml(filePath, projectPath) ? (
          <HtmlPreviewButton filePath={filePath} projectPath={projectPath} />
        ) : null}
      </div>
      <div className="relative min-h-0 flex-1">
        <BrowserPanel mode="sidebar" />
      </div>
    </div>
  );
}

pw.__hpeSetProject = (projectPath: string) => {
  const id = "hpe-project";
  useSessionStore.setState({
    activeProjectId: id,
    projects: [{ id, name: "hpe", path: projectPath, archived: false } as never],
  });
};
pw.__hpeBrowserTabCount = () => useSessionStore.getState().browserTabs.length;
pw.__hpeBrowserIds = () => useSessionStore.getState().browserTabs.map((t) => t.browserId);
pw.__hpeBrowserUrlsAsync = async () => {
  const tabs = useSessionStore.getState().browserTabs;
  const bridge = pw.__hpeBrowserUrl;
  if (!bridge) return [];
  const urls: string[] = [];
  for (const t of tabs) urls.push(await bridge(t.browserId));
  return urls;
};
pw.__hpeBrowserTitleAsync = async (url: string) => {
  const bridge = pw.__hpeBrowserTitle;
  return bridge ? await bridge(url) : null;
};

const root = createRoot(document.getElementById("root")!, {
  onUncaughtError: (error) => {
    pw.__probeError = error instanceof Error ? (error.stack ?? error.message) : String(error);
  },
});
root.render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
