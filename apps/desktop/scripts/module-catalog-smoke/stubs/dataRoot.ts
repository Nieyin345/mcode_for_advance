let calls = 0;
export function dataRoot(): string {
  calls++;
  const root = process.env.MODULE_CATALOG_TEST_DATA_ROOT;
  if (!root) throw Error("Isolated module catalog data root is required");
  return root;
}
export function dataRootCalls(): number { return calls; }
