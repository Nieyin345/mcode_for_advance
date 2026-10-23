import { defineU1Journey, step } from "../../electron-u1/driver/index.js";
import { editorSetup } from "../editor-flow.js";

export const slidesJourney = defineU1Journey({
  name: "slides-open-edit-save-reopen",
  launch: { window: false, size: { width: 1280, height: 900 }, defaultTimeoutMs: 30_000, setup: editorSetup("slides") as never },
  steps: [step.sleep(1, "stub")],
});
