/** Real ImportBar handlers use these isolated failing IPC fixtures. */
export const api = {
  pickFiles: async (_options: unknown) => ({ paths: ["fixture.pdf"] }),
  library: {
    importFiles: async (_options: unknown) => { throw Error("fixture IPC unavailable"); },
  },
};
export const useLibraryStore = { getState: () => ({ setActiveItem: () => {}, setDetailTab: () => {} }) };
export const Input = () => null;
