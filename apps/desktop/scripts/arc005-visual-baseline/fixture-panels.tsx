/**
 * T12 isolated presentation fixtures. The real App remains mounted below.
 * Diff and Markdown use production renderers; terminal/editor intentionally
 * avoid spawning PTY/Monaco workers. Every overlay exposes its provenance.
 */
import { useEffect, useMemo, useState } from "react";
import { DiffView } from "@renderer/components/chat/DiffView.js";
import { lineDiff } from "@renderer/lib/lineDiff.js";
import { Markdown } from "@renderer/components/chat/Markdown.js";

type Scene = { id: string; before?: string; after?: string };
declare global {
  interface Window {
    __arcShowFixture?: (id: string, before?: string, after?: string) => void;
  }
}
const markdown = "# 视觉基线预览\n\n此处通过 **Mcode 原生 Markdown 渲染器** 展示虚构文档。\n\n- 标题和段落\n- 强调与列表\n\n\`const fixture = true;\`";

export function Arc005FixturePanels() {
  const [scene, setScene] = useState<Scene>({ id: "" });
  useEffect(() => {
    const show = (id: string, before?: string, after?: string) => {
      setScene({ id, before, after });
    };
    window.__arcShowFixture = show;
    return () => { delete window.__arcShowFixture; };
  }, []);
  const diff = useMemo(() => scene.id === "diff" ? lineDiff(scene.before ?? "", scene.after ?? "") : [], [scene]);
  if (!["diff", "terminal", "editor", "preview"].includes(scene.id)) return null;
  const fixture = ({
    diff: "real-lineDiff-DiffView",
    terminal: "static-terminal",
    editor: "stub-editor",
    preview: "real-markdown-renderer",
  } as Record<string,string>)[scene.id];
  return (
    <section data-testid="arc005-fixture-panel" data-arc-fixture={fixture}
      className="fixed z-20 flex flex-col overflow-hidden rounded-[var(--radius-panel)] border border-edge bg-surface text-content shadow-lg"
      style={{ top: 48, left: "27%", right: "4%", bottom: 38 }}>
      <div className="flex shrink-0 items-center gap-3 border-b border-edge bg-surface-muted px-4 py-3 text-sm font-semibold">
        <span>{scene.id === "terminal" ? "终端" : scene.id === "editor" ? "编辑器 · arc005-fixture.ts" : scene.id === "preview" ? "文件预览 · fixture.md" : "文件差异 · fixture.ts"}</span>
        <span className="ml-auto text-xs font-normal text-content-subtle">ARC-005 / {fixture}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4" data-testid={`arc005-${scene.id}`}>
        {scene.id === "terminal" && (
          <div data-terminal-session="arc005-static" data-testid="arc005-static-terminal"
            className="h-full rounded-md p-3 font-mono text-sm leading-6"
            style={{ backgroundColor: "rgb(var(--terminal-bg))", color: "rgb(var(--terminal-fg))" }}>
            <div>$ pwd</div><div>C:\\arc005-visual-p1</div>
            <div className="mt-2">$ node --version</div><div>v22.x (static fixture)</div>
            <div className="mt-2">$ echo ARC005</div><div>ARC005</div>
          </div>
        )}
        {scene.id === "editor" && (
          <div data-testid="arc005-stub-editor" className="h-full rounded-md border border-edge bg-surface-muted/60 p-4 font-mono text-sm leading-6">
            <div className="mb-3 text-xs text-content-muted">只读虚构文件 · Monaco worker 未启动</div>
            <pre className="overflow-auto"><code>{["01  // ARC-005 T12 read-only fixture", "02  export interface Fixture {", "03    readonly title: string;", "04    readonly enabled: boolean;", "05  }", "06  export const baseline: Fixture = {", "07    title: 'visual-baseline',", "08    enabled: true,", "09  };"].join("\n")}</code></pre>
          </div>
        )}
        {scene.id === "preview" && (
          <article data-testid="arc005-real-markdown" className="prose chat-md max-w-none">
            <Markdown>{markdown}</Markdown>
          </article>
        )}
        {scene.id === "diff" && (
          <div data-testid="arc005-real-diff">
            <p className="mb-3 text-xs text-content-muted">v1.ts → v2.ts · lineDiff（原生 LCS）</p>
            <DiffView diff={diff} scrollClassName="max-h-[70vh]" />
          </div>
        )}
      </div>
    </section>
  );
}
