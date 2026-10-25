/**
 * Non-visual mirror of T7's real XLSX open/edit/save/relaunch journey.
 *
 * We reuse every original interaction and every durable disk assertion.
 * Only literal screenshot steps are omitted because capturePage may be
 * unavailable on a headless/locked remote Windows display. This is NOT
 * equivalent to visual verification and must not be reported as T7 PASS.
 */
import { defineU1Journey } from "../../electron-u1/driver/index.js";
import { sheetsJourney } from "../../t7-genoffice-u1/journeys/sheets-open-edit-save-reopen.js";

export const sheetsNonvisualJourney = defineU1Journey({
  ...sheetsJourney,
  name: "sheets-nonvisual-edit-save-reopen",
  launch: {
    ...sheetsJourney.launch,
    assertions: {
      ...sheetsJourney.launch?.assertions,
      visual: false,
    },
  },
  steps: sheetsJourney.steps.filter((step) => step.op !== "screenshot" && step.op !== "assertScreenshotChanged"),
});
