import type { FileSearchEntry } from "@contracts/ipc";

const files: FileSearchEntry[] = [
  { path: "C:/project/alpha.ts", name: "alpha.ts", relativePath: "alpha.ts" },
  { path: "C:/project/beta.ts", name: "beta.ts", relativePath: "beta.ts" },
  { path: "C:/project/gamma.ts", name: "gamma.ts", relativePath: "gamma.ts" },
];
export const api = {
  file: {
    search: async ({ query }: { query?: string }) => ({
      files: files.filter((f) => !query || f.name.includes(query)),
    }),
  },
  pickFiles: async () => ({ paths: [] }),
};
