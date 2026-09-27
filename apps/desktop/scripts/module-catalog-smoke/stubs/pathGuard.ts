export function isKnownWorkspaceRoot(path: string): boolean {
  const root = process.env.MODULE_CATALOG_TEST_WORKSPACE;
  return !!root && path === root;
}
