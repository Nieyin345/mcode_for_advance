/** `./panelReadback.js` 替身 —— PanelFrame 挂载即登记 probe,卸载注销;本套不验读回。 */
export interface PanelProbeHandle {
  itemId: string;
  label: string;
  mode: "float" | "preview" | "tab";
  probe: () => Promise<unknown>;
  rect: () => { x: number; y: number; width: number; height: number } | null;
}
export function registerPanelProbe(_handle: PanelProbeHandle): () => void {
  return () => {};
}
