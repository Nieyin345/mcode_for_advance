/** Headless read-only test: the PDF file-bounded helper never needs DB.
 * Explicit throw makes any accidental library lookup a test failure. */
export const LibraryRepo = {
  get(_id: string): never {
    throw new Error("pdf-highlights-integrity-smoke must not read a real user library");
  },
};
