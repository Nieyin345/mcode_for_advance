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

/** Keep unsent prompt/HTML and other file/quote chips unchanged. */
export function officeDraftWithFile(path: string, previous: ComposerDraft | undefined): ComposerDraft {
  const tags: ContentTag[] = previous?.tags ?? [];
  if (tags.some((tag) => tag.kind === "file" && tag.filePath === path)) {
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
