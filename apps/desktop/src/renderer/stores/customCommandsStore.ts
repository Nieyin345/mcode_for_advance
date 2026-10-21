/** Project terminal quick commands, independent of session message state. */
import { create } from "zustand";
import { api } from "@renderer/lib/api.js";
import { UI_CUSTOM_COMMANDS_BY_PROJECT_SETTING_KEY, type CustomCommand } from "@contracts/ipc";
import type { SessionState } from "./sessionStoreTypes.js";

type CommandKeys = "customCommandsByProject" | "setCustomCommandsByProject"
  | "addCustomCommand" | "updateCustomCommand" | "removeCustomCommand";
export type CustomCommandsState = Pick<SessionState, CommandKeys>;

export const useCustomCommandsStore = create<CustomCommandsState>((set, get) => ({
  customCommandsByProject: {},
  setCustomCommandsByProject: (projectId, commands) => {
    set((s) => ({
      customCommandsByProject: { ...s.customCommandsByProject, [projectId]: commands },
    }));
    void api.setting
      .set({ key: UI_CUSTOM_COMMANDS_BY_PROJECT_SETTING_KEY, value: JSON.stringify(get().customCommandsByProject) })
      .catch((err) => console.error("setting.set(customCommandsByProject) failed:", err));
  },
  addCustomCommand: (projectId, cmd) => {
    const prev = get().customCommandsByProject[projectId] ?? [];
    const next: CustomCommand = { ...cmd, id: `cmd-${Date.now().toString(36)}` };
    get().setCustomCommandsByProject(projectId, [...prev, next]);
  },
  updateCustomCommand: (projectId, cmd) => {
    const prev = get().customCommandsByProject[projectId] ?? [];
    get().setCustomCommandsByProject(projectId, prev.map((c) => (c.id === cmd.id ? cmd : c)));
  },
  removeCustomCommand: (projectId, id) => {
    const prev = get().customCommandsByProject[projectId] ?? [];
    get().setCustomCommandsByProject(projectId, prev.filter((c) => c.id !== id));
  },
}));
