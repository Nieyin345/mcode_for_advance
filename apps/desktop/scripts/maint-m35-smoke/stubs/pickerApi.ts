/** 供 pickers.ts 三个场景共用的 api 桩：全部可观测/可挂起。 */
import type { LibraryItem, LibraryNote } from "@contracts/library";
import type { LibraryDeletePreviewEntry } from "@contracts/ipc";

export interface ListCall { opts: unknown; resolve: (v: { items: LibraryItem[] }) => void }
export const listCalls: ListCall[] = [];
export const deleteItemsCalls: unknown[] = [];
export const deletePreviewCalls: unknown[] = [];

let notesFixture: LibraryNote[] = [];
export function setNotesFixture(next: LibraryNote[]): void { notesFixture = next; }

let previewFixture: LibraryDeletePreviewEntry[] = [];
export function setPreviewFixture(next: LibraryDeletePreviewEntry[]): void { previewFixture = next; }

export const api = {
  library: {
    list: (opts: unknown): Promise<{ items: LibraryItem[] }> =>
      new Promise((resolve) => { listCalls.push({ opts, resolve }); }),
    listNotes: async (_o: unknown) => ({ notes: notesFixture }),
    saveNote: async (_o: unknown) => ({ notes: notesFixture }),
    deleteNote: async (_o: unknown) => ({ notes: notesFixture }),
    deletePreview: async (o: unknown) => { deletePreviewCalls.push(o); return { entries: previewFixture }; },
    // 挂起一拍：给"连点两次"制造 in-flight 窗口。
    deleteItems: async (o: unknown) => {
      deleteItemsCalls.push(o);
      await new Promise((r) => setImmediate(r));
      return { items: [], failed: [] };
    },
  },
};
