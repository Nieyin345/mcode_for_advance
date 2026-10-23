import { defineU1Journey, step } from "../../electron-u1/driver/index.js";
import { editorSetup } from "../editor-flow.js";

export const htmlJourney = defineU1Journey({
  name: "html-open-edit-save-reopen",
  launch: { window: false, size: { width: 1280, height: 900 }, defaultTimeoutMs: 30_000, setup: editorSetup("html") as never },
  steps: [step.sleep(1, "stub")],
});
