/** Only ItemLinks' IPC is active. Other imports are inert JSX children. */
import type { LibraryLinkView } from "@contracts/library";
export const linkCalls: Array<{ itemId: string; resolve: (response: { links: LibraryLinkView[] }) => void }> = [];
export const api = { library: {
  linksOf: ({ itemId }: { itemId: string }) =>
    new Promise<{ links: LibraryLinkView[] }>((resolve) => { linkCalls.push({ itemId, resolve }); }),
  deletePreview: async (_opts: unknown) => ({ entries: [] }),
} };
export const useSessionStore = (_selector: unknown) => ({ openUrlInBrowser: () => {} });
export const Dialog = {};
export const LibraryPicker = () => null;
export const PdfBadge = () => null;
export const fileStateOf = () => "none";
export const ItemNotes = () => null;
