/** No vendor checkout: AI never registers under untrusted global channels. */
import type { IpcMain } from "electron";
import type { DocsAiPorts } from "./docsAiPorts.js";
export function registerGenofficeViewAiIpc(_ipc: Pick<IpcMain, "handle" | "removeHandler">,
  _scoped: (sender: unknown) => { context: { sessionId: string; filePath: string }; ports: DocsAiPorts } | null): () => void {
  throw new Error("GenOffice view AI bridge unavailable without vendor snapshot");
}
