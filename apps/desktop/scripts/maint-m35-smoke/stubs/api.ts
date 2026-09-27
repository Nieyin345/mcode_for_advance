/** Only the two read APIs and the create response that libraryStore consumes. */
import type { LibraryCollection, LibraryItem } from "@contracts/library";

export interface Deferred<T> {
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
}
export const listCalls: Array<Deferred<{ items: LibraryItem[] }> & { opts: { collectionId?: string; limit: number } }> = [];
export const collectionCalls: Array<Deferred<{ collections: LibraryCollection[] }>> = [];
let creationResult: LibraryCollection[] = [];
export function setCreationResult(value: LibraryCollection[]): void { creationResult = value; }

export const api = {
  library: {
    list: (opts: { collectionId?: string; limit: number }): Promise<{ items: LibraryItem[] }> =>
      new Promise((resolve, reject) => { listCalls.push({ opts, resolve, reject }); }),
    listCollections: (): Promise<{ collections: LibraryCollection[] }> =>
      new Promise((resolve, reject) => { collectionCalls.push({ resolve, reject }); }),
    createCollection: async (_opts: { name: string; groupId: string; parentId: string | null }) =>
      ({ collections: creationResult }),
  },
};
