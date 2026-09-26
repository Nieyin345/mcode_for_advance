import type { IpcMain } from "electron";
import { MEMORY_ASSISTANT_CHANNEL, MemoryAssistantSchema } from "@contracts/memoryAssistant";
import { memoryAssistant } from "@main/memory/assistant.js";
export function registerMemoryAssistantHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(MEMORY_ASSISTANT_CHANNEL, (_event, raw) => memoryAssistant(MemoryAssistantSchema.parse(raw)));
}
