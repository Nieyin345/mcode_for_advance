/**
 * Headless permission-policy regression for Pi's inline extension.
 * No Pi session, model, user DB, or application process is started.
 */
import { shouldAutoApproveForPi } from "@main/providers/pi-sdk/piToolApproval.js";

let checks = 0;
let failures = 0;

function check(name: string, actual: boolean, expected: boolean): void {
  checks += 1;
  if (actual === expected) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name} — expected ${expected}, got ${actual}`);
}

check(
  "plan mode requires approval despite a stale acceptEdits permission value",
  shouldAutoApproveForPi("acceptEdits", "write", true, false),
  false,
);
check(
  "plan mode overrides a saved always-allow decision for mutations",
  shouldAutoApproveForPi("default", "bash", true, true),
  false,
);
check(
  "plan mode overrides bypassPermissions for mutations",
  shouldAutoApproveForPi("bypassPermissions", "write", true, false),
  false,
);
check(
  "outside plan mode, acceptEdits still auto-approves file edits",
  shouldAutoApproveForPi("acceptEdits", "edit", false, false),
  true,
);
check(
  "outside plan mode, bypassPermissions still skips approval",
  shouldAutoApproveForPi("bypassPermissions", "write", false, false),
  true,
);
check(
  "outside plan mode, the user's always-allow decision still applies",
  shouldAutoApproveForPi("default", "bash", false, true),
  true,
);
check(
  "read-only Pi tools remain auto-approved in plan mode",
  shouldAutoApproveForPi("acceptEdits", "read", true, false),
  true,
);

console.log(`${checks - failures}/${checks} M04 checks passed`);
if (failures > 0) process.exit(1);
