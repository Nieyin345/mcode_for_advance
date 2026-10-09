/** Real ImportBar handlers use these isolated failing IPC fixtures. */
/** 调用计数 —— 用来断"连点两次只提交一次"(重入守卫)。 */
export const calls = { pickFiles: 0, importFiles: 0, createNote: 0, pickFolder: 0 };
export function resetCalls(): void {
  calls.pickFiles = 0;
  calls.importFiles = 0;
  calls.createNote = 0;
  calls.pickFolder = 0;
}
export const api = {
  pickFiles: async (_options: unknown) => { calls.pickFiles += 1; return { paths: ["fixture.pdf"] }; },
  pickFolder: async () => { calls.pickFolder += 1; return { path: "fixture-dir" }; },
  library: {
    importFiles: async (_options: unknown) => { calls.importFiles += 1; throw Error("fixture IPC unavailable"); },
    // 挂起的 createNote:让两次连按落在同一个 in-flight 窗口里,验重入守卫。
    createNote: async (_options: unknown) => {
      calls.createNote += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return { item: { id: "new-note" } };
    },
  },
};
export const useLibraryStore = { getState: () => ({ setActiveItem: () => {}, setDetailTab: () => {} }) };
export const Input = () => null;
// R40 起 ImportPanel 的说明收进 ⓘ(ui/info-hint)。
export const InfoHint = () => null;
export const HintLabel = ({ children }: { children?: unknown }) => children ?? null;
