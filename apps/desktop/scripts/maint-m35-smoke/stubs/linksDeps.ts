/** Only ItemLinks' IPC is active. Other imports are inert JSX children. */
import type { LibraryLinkView } from "@contracts/library";
export const linkCalls: Array<{ itemId: string; resolve: (response: { links: LibraryLinkView[] }) => void }> = [];
export const api = { library: {
  linksOf: ({ itemId }: { itemId: string }) =>
    new Promise<{ links: LibraryLinkView[] }>((resolve) => { linkCalls.push({ itemId, resolve }); }),
  deletePreview: async (_opts: unknown) => ({ entries: [] }),
} };
export const useSessionStore = (_selector: unknown) => ({ openUrlInBrowser: () => {} });
/** revealFile 失败会走 toast;这里只提供那个形状,不让它真弹。 */
export const useToastStore = { getState: () => ({ push: (_opts: unknown) => {} }) };
export const Dialog = {};
export const LibraryPicker = () => null;
export const PdfBadge = () => null;
export const fileStateOf = () => "none";
export const ItemNotes = () => null;
