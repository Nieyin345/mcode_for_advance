import { toSessionListEntry, broadcastSessionChanged } from "../../src/main/lib/sessionSync.js";
import { eventsOfType, resetSent } from "../projects-ipc-smoke/stubs/window.js";
import { mobileEvents, resetMobileEvents } from "../projects-ipc-smoke/stubs/mobileEventBus.js";
import type { Session } from "@contracts/session";

let pass = 0, fail = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) { pass++; console.log("PASS " + name); }
  else { fail++; console.log("FAIL " + name + " " + JSON.stringify(detail)); }
}
const session = {
  id: "fictional-s", projectId: "fictional-project", providerId: "claude-sdk",
  claudeSessionId: null, kind: "chat", parentSessionId: null, nodeId: null,
  agentProfile: null, title: "safe-title", status: "idle", model: "default",
  effort: "default", permissionMode: "default", workflowId: "default",
  customModelId: null, archived: false, pinnedAt: null,
  createdAt: 12, updatedAt: 14, contextSnapshot: { secret: "heavy" },
  todos: [{ secret: "heavy" }], subagents: [{ secret: "heavy" }],
  planDraft: { secret: "heavy" }, usageHistory: [{ secret: "heavy" }],
  turnFiles: [{ before: "SECRET_FILE_CONTENT" }], bookmarks: [{ secret: "heavy" }],
  subagentTranscripts: { t: [{ secret: "heavy" }] },
  injectedAuthToken: "SHOULD_NOT_BROADCAST",
  futureSessionPayload: { hiddenFile: "SECRET_NEW_FIELD" },
} as unknown as Session;
const entry = toSessionListEntry(session);
check("list-visible fields retained", entry.id === session.id && entry.title === session.title);
for (const field of ["contextSnapshot","todos","subagents","planDraft","usageHistory","turnFiles","bookmarks","subagentTranscripts","injectedAuthToken","futureSessionPayload"]) {
  check("not transmitted: " + field, !Object.hasOwn(entry, field), Object.keys(entry));
}
resetSent(); resetMobileEvents();
broadcastSessionChanged(session);
const desktop = eventsOfType("session.changed")[0];
const phone = mobileEvents.find((x) => x.type === "session.changed");
check("desktop receives event", !!desktop);
check("phone receives event", !!phone);
const frame = JSON.stringify([desktop, phone]);
check("no secret file contents or unexpected properties leave host", !frame.includes("SECRET_") && !frame.includes("SHOULD_NOT_BROADCAST") && !frame.includes("futureSessionPayload"), frame.slice(0, 300));
console.log(`session-list-redaction-smoke: ${pass}/${pass+fail}`);
if (fail) process.exitCode = 1;
