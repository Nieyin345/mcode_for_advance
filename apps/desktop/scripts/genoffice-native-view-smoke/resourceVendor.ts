/** Test-only upstream seam: availability true so the XLSX resource guard is exercised. */
export const vendorAvailable = true;
export function configureNativeRuntimes(_config:unknown):void {}
export function createNativeView():never {
  throw new Error("T53 native resource-only test must never instantiate a view");
}
