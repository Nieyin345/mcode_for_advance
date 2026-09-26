/** 只代替 Electron preload，将渲染端的请求转发给测试注册的真 IPC handler。 */
import type { LibraryCollection } from "@contracts/library";
import type { CollectionCreateInput } from "@contracts/ipc/library";

type Backend = {
  createCollection(input: CollectionCreateInput): Promise<{ collections: LibraryCollection[] }>;
  listCollections(): Promise<{ collections: LibraryCollection[] }>;
};
let backend: Backend | null = null;
export function useBackend(next: Backend): void { backend = next; }
function ready(): Backend {
  if (!backend) throw new Error("library-create-smoke: backend not installed");
  return backend;
}
export const api = {
  library: {
    createCollection: (input: CollectionCreateInput) => ready().createCollection(input),
    listCollections: () => ready().listCollections(),
  },
};
