/**
 * Office → Mcode chat handoff. This is a composer-only action, NOT an AI
 * invocation: the user's configured Mcode model and approval flow remain the
 * sole execution path. Never read the file or auto-send when clicking Ask Mcode.
 */
import { genofficeAppForPath } from "@contracts/genofficeFileRoute";
import { makeFileTag, type ContentTag } from "@renderer/lib/contentTag.js";
import type { ComposerDraft } from "@renderer/stores/sessionStoreTypes.js";

export function canDockOfficeFile(path: string | null | undefined): boolean {
  return typeof path === "string" && genofficeAppForPath(path) !== undefined;
}

/**
 * Windows workspace paths are case-insensitive and may arrive with either slash
 * style; POSIX paths remain case-sensitive. Use this only for draft-tag identity,
 * never as an authorization or filesystem path check.
 */
function fileReferenceKey(path: string): string {
  const windowsPath = /^[a-z]:[\\/]/i.test(path) || /^\\\\/.test(path);
  const normalized = path.replace(/[\\/]+/g, "/").replace(/\/$/, "");
  return windowsPath ? normalized.toLowerCase() : normalized;
}

/** Keep unsent prompt/HTML and other file/quote chips unchanged. */
export function officeDraftWithFile(path: string, previous: ComposerDraft | undefined): ComposerDraft {
  const tags: ContentTag[] = previous?.tags ?? [];
  const targetKey = fileReferenceKey(path);
  // `filePath` 是可选字段（只有 kind === "file" 才设）：缺它的 tag 无法参与
  // 「同一路径已存在」的判定，如实按"不匹配"处理，而不是拿 undefined 去比。
  if (tags.some((tag) => tag.kind === "file" && typeof tag.filePath === "string" &&
      fileReferenceKey(tag.filePath) === targetKey)) {
    return { text: previous?.text ?? "", html: previous?.html ?? "", tags };
  }
  return {
    text: previous?.text ?? "",
    html: previous?.html ?? "",
    tags: [...tags, makeFileTag(path)],
  };
}

/**
 * Delegate to the existing store's draft delivery & pane actions (rather than
 * using genoffice's own AI providers or starting a second agent). The user
 * decides what to ask and must explicitly press Send.
 */
export function handoffOfficeToMcode(
  path: string,
  sessionId: string | null,
  state: {
    composerDraftBySession: Record<string, ComposerDraft>;
    deliverComposerDraft: (sessionId: string, draft: ComposerDraft) => void;
    setLayoutPaneContent: (pane: "right", content: { kind: "document"; documentId: string }) => void;
    setRightOpen: (open: boolean) => void;
    setCenterTabFocus: (focus: "chat") => void;
  },
): boolean {
  if (!sessionId || !canDockOfficeFile(path)) return false;
  const draft = officeDraftWithFile(path, state.composerDraftBySession[sessionId]);
  state.deliverComposerDraft(sessionId, draft);
  // In tabs mode, make the Mcode chat visible while the native Office editor
  // stays accessible in the right dock. In split mode, this is a no-op for the
  // already visible chat; neither branch sends a model request.
  state.setLayoutPaneContent("right", { kind: "document", documentId: path });
  state.setRightOpen(true);
  state.setCenterTabFocus("chat");
  return true;
}
