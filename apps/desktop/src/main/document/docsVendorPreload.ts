/** ARC-007: compile-time fallback for a machine without the gitignored vendor snapshot.
 * electron.vite.config.ts aliases this module to the real GenOffice Docs view
 * preload when apps/docs/src/preload/mcode-view.ts is present.
 * The existing Mcode bridge remains the explicit fail-closed fallback.
 */
export const mcodeDocsViewAvailable = false;
export function installMcodeDocsViewPreload(): void {
  throw new Error("GenOffice Docs native preload source is unavailable");
}
