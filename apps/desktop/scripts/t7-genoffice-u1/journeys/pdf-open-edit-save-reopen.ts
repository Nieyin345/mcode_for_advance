import { defineU1Journey, step } from "../../electron-u1/driver/index.js";
import { editorSetup } from "../editor-flow.js";

export const pdfJourney = defineU1Journey({
  name: "pdf-open-edit-save-reopen",
  launch: { window: false, size: { width: 1280, height: 900 }, defaultTimeoutMs: 30_000, setup: editorSetup("pdf") as never },
  steps: [step.sleep(1, "stub")],
});
