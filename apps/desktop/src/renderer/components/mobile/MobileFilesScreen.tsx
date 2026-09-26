/**
 * MobileFilesScreen — read-only project file browser for the web (phone)
 * shell.
 *
 * The desktop IDE (FileTree + Monaco + LSP) is Electron-bound; the phone gets
 * a focused read-only view instead: browse directories with a breadcrumb,
 * view text files through the shared Markdown renderer (shiki highlighting
 * via a fenced code block — zero new syntax-highlighting deps), and images
 * through the shared binary-read path. All reads go through the same guarded
 * `file:*` RPC the desktop uses, so the project-root security boundary is
 * identical.
 */
import { useEffect, useMemo, useState } from "react";
import { useRpc } from "@renderer/hooks/useRpc.js";
import { Button, ErrorNote } from "@renderer/components/ui/index.js";
import { api } from "@renderer/lib/api.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { cn } from "@renderer/lib/cn.js";
import type { FileTreeEntry } from "@contracts/ipc";
import { FileViewerOverlay } from "./MobileFileViewer.js";
import { useI18n } from "@renderer/lib/i18n/index.js";
import { IconFolder, IconFolderOpen, IconFile, IconChevronRight, IconArrowUp, IconLoader2 } from "@renderer/lib/icons.js";

/** Full-screen read-only file viewer: images render inline; text files render
 *  through the shared Markdown fenced-code path (shiki highlighting). */

export function MobileFilesScreen() {
  const { t } = useI18n();
  const activeProjectId = useSessionStore((s) => s.activeProjectId);
  const projects = useSessionStore((s) => s.projects);
  const project = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );

  // Keep the navigation identity with its stack. In the render that switches
  // projects, never combine the new root with the previous project's path.
  const [navigation, setNavigation] = useState<{ projectId: string | null; stack: Array<{ name: string; path: string }> }>({ projectId: null, stack: [] });
  const rootStack = useMemo(() => project ? [{ name: project.name, path: project.path }] : [], [project?.id, project?.name, project?.path]);
  const stack = navigation.projectId === project?.id ? navigation.stack : rootStack;
  const setStack = (update: (prev: typeof stack) => typeof stack) => {
    setNavigation({ projectId: project?.id ?? null, stack: update(stack) });
  };
  const [fileSelection, setFileSelection] = useState<{ projectId: string; file: { name: string; path: string } } | null>(null);
  const openFile = fileSelection?.projectId === project?.id ? fileSelection?.file : null;
  const setOpenFile = (file: { name: string; path: string } | null) => {
    setFileSelection(file && project ? { projectId: project.id, file } : null);
  };
  useEffect(() => { setFileSelection(null); }, [project?.id]);
  const current = stack[stack.length - 1];
  const requestKey = JSON.stringify([project?.id, project?.path, current?.path]);
  const query = useRpc(async () => {
    if (!project || !current) throw new Error("No project directory selected");
    const dirPath = current.path.slice(project.path.length).replace(/^[\\/]/, "");
    const res = await api.file.listDir({ projectPath: project.path, dirPath });
    return { key: requestKey, entries: res.entries };
  }, [requestKey], { enabled: !!project && !!current, toastOnError: false });
  const entries = query.data?.key === requestKey && !query.loading ? query.data.entries : null;

  const descend = (e: FileTreeEntry) => {
    if (e.isDir) {
      setStack((prev) => [...prev, { name: e.name, path: e.path }]);
      setOpenFile(null);
    } else {
      setOpenFile({ name: e.name, path: e.path });
    }
  };

  const up = () => {
    setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
    setOpenFile(null);
  };

  if (!project) {
    return (
      <ScreenShell title={t("layout.nav.files")}>
        <div className="p-6 text-center text-xs text-content-subtle">
          {t("browser.selectProjectFirst")}
        </div>
      </ScreenShell>
    );
  }

  return (
    <ScreenShell title={t("layout.nav.files")}>
      {/* Breadcrumb */}
      <div className="flex min-h-0 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-edge px-2 py-1.5 text-xs [scrollbar-width:none]">
        {stack.length > 1 && (
          <button
            type="button"
            onClick={up}
            className="flex h-6 shrink-0 items-center gap-0.5 rounded px-1 text-content-muted hover:bg-surface-muted"
            title={t("mobile.files.up")}
          >
            <IconArrowUp size={13} />
          </button>
        )}
        {stack.map((seg, i) => (
          <span key={seg.path} className="flex shrink-0 items-center gap-0.5">
            {i > 0 && <IconChevronRight size={12} className="text-content-subtle" />}
            <button
              type="button"
              onClick={() => {
                setStack((prev) => prev.slice(0, i + 1));
                setOpenFile(null);
              }}
              className={cn(
                "max-w-[9rem] truncate rounded px-1 py-0.5",
                i === stack.length - 1
                  ? "font-medium text-content"
                  : "text-content-muted hover:bg-surface-muted",
              )}
            >
              {seg.name}
            </button>
          </span>
        ))}
      </div>

      {/* Entries */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {query.error && !query.loading ? (
          <ErrorNote className="m-3" action={<Button onClick={() => void query.refetch()}>{t("common.retry")}</Button>}>
            {query.error.message}
          </ErrorNote>
        ) : entries === null ? (
          <div className="flex h-full items-center justify-center text-content-subtle">
            <IconLoader2 size={16} className="animate-spin" />
          </div>
        ) : entries.length === 0 ? (
          <div className="p-6 text-center text-xs text-content-subtle">
            {t("ide.files.emptyDir")}
          </div>
        ) : (
          entries.map((e) => (
            <button
              key={e.path}
              type="button"
              onClick={() => descend(e)}
              className="flex w-full items-center gap-2 border-b border-edge/60 px-3 py-2.5 text-left hover:bg-surface-muted"
            >
              {e.isDir ? (
                <IconFolder size={16} className="shrink-0 text-content-muted" />
              ) : (
                <IconFile size={16} className="shrink-0 text-content-subtle" />
              )}
              <span className="min-w-0 truncate text-xs text-content">{e.name}</span>
            </button>
          ))
        )}
      </div>

      {openFile && (
        <FileViewerOverlay name={openFile.name} path={openFile.path} onClose={() => setOpenFile(null)} />
      )}
    </ScreenShell>
  );
}

/** Shared header for the full-screen mobile utility pages (files / git). */
function ScreenShell({ title, children }: { title: string; children: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="flex h-full min-w-0 min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-edge px-3">
        <span className="text-sm font-medium text-content">{title}</span>
        <span className="flex-1" />
        <span className="flex items-center gap-1 text-[10px] text-content-subtle">
          <IconFolderOpen size={12} />
          {t("mobile.files.readOnly")}
        </span>
      </div>
      {children}
    </div>
  );
}
