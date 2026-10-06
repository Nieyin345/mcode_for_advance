/**
 * Headless permission-policy regression for Pi's inline extension.
 * No Pi session, model, user DB, or application process is started.
 */
import { shouldAutoApproveForPi, PI_PERMISSION_MODES } from "@main/providers/pi-sdk/piToolApproval.js";

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
// dontAsk 是"不问、没预批准就拒",不是放行档 —— 从前它和 bypassPermissions 并列,
// 写工具会在用户以为选了更保守的模式下悄悄跑起来。
check(
  "★ dontAsk does NOT auto-approve mutations",
  shouldAutoApproveForPi("dontAsk", "write", false, false),
  false,
);
check(
  "★ dontAsk does NOT auto-approve bash",
  shouldAutoApproveForPi("dontAsk", "bash", false, false),
  false,
);
check(
  "dontAsk still auto-approves read-only tools",
  shouldAutoApproveForPi("dontAsk", "read", false, false),
  true,
);
check(
  "dontAsk still honours the user's always-allow decision",
  shouldAutoApproveForPi("dontAsk", "write", false, true),
  true,
);

// 模式列表本身:暴露的必须是真做到的。dontAsk 有实现所以上架;auto 没有 —— Pi 没有
// 模型分类器那套,报了就是"看得见、做不到"的假菜单项。
const modeValues = PI_PERMISSION_MODES.map((m) => m.value);
check("dontAsk is offered in Pi's mode list", modeValues.includes("dontAsk"), true);
check("auto is NOT offered in Pi's mode list (no classifier to back it)", modeValues.includes("auto"), false);
check(
  "every offered Pi mode has a label and a hint",
  PI_PERMISSION_MODES.every((m) => m.label.length > 0 && (m.hint ?? "").length > 0),
  true,
);
check(
  "every offered Pi mode resolves to a known icon in the renderer's map",
  PI_PERMISSION_MODES.every((m) => ["shield", "shieldCheck", "shieldHalf", "shieldLock"].includes(m.icon ?? "")),
  true,
);

console.log(`${checks - failures}/${checks} M04 checks passed`);
if (failures > 0) process.exit(1);
