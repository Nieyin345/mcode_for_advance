/** Reject any request for real application paths. */
export const app = {
  getPath(name: string): string {
    if (name !== "userData" || !process.env.MCODE_M20_USER_DATA) {
      throw new Error(`M20 test refused real Electron path: ${name}`);
    }
    return process.env.MCODE_M20_USER_DATA;
  },
};
