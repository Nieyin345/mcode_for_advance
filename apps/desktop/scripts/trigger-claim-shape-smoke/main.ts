import { isTriggerClaims, scheduleClaimId, triggerKeyOfClaim, pruneClaims } from "@main/orchestration/triggerClaim.js";

let total = 0;
let failed = 0;
const check = (name: string, condition: boolean, evidence?: unknown): void => {
  total++;
  if (!condition) {
    failed++;
    console.log("  FAIL " + name + (evidence === undefined ? "" : " — " + JSON.stringify(evidence)));
  } else console.log("  ok   " + name);
};
const good = (key: string, minute: number, at: number, status: "CLAIMED" | "SUCCEEDED" = "CLAIMED") =>
  ({ [key]: { status, minute, at } });

check("正常旧账可回读 a@1", isTriggerClaims(good("a@1", 1, 2)));
check("正常业务 key 含冒号可回读", isTriggerClaims(good("wf_a:t1@15", 15, 900_000)));
check("合法 FAILED/UNCERTAIN 不受限制", isTriggerClaims({
  "a@1": { status: "FAILED", minute: 1, at: 2 },
  "b@2": { status: "UNCERTAIN", minute: 2, at: 123_456 },
}));
check("空表首次初始化仍允许", isTriggerClaims({}));
check("没有 @ 的坏 claim key 拒绝", !isTriggerClaims(good("wf_without_minute", 1, 2)));
check("@ 后非十进制的 claim key 拒绝", !isTriggerClaims(good("wf:t@not-minute", 1, 2)));
check("key 的分钟与 value.minute 错配拒绝", !isTriggerClaims(good("wf:t@123", 122, 2)));
check("value.minute 为负数拒绝", !isTriggerClaims(good("wf:t@-1", -1, 2)));
check("value.minute 为小数拒绝", !isTriggerClaims(good("wf:t@1.5", 1.5, 2)));
check("value.at 为负数拒绝", !isTriggerClaims(good("wf:t@1", 1, -2)));
check("value.at 为小数拒绝", !isTriggerClaims(good("wf:t@1", 1, 1.5)));
check("过大不安全整数分钟拒绝", !isTriggerClaims(good("wf:t@9007199254740992", 9_007_199_254_740_992, 1)));
check("伪造无限 timestamp 拒绝", !isTriggerClaims(good("wf:t@1", 1, Infinity)));
check("合法末尾 @ 分隔会被提取", triggerKeyOfClaim(scheduleClaimId("wf:t", 15)) === "wf:t");
check("坏 key 不应被恢复逻辑当有效 trigger", triggerKeyOfClaim("wf:t@oops") === null);
check("负数 key 不应被恢复逻辑当有效 trigger", triggerKeyOfClaim("wf:t@-1") === null);
check("不安全整数 key 不应被恢复逻辑当有效 trigger", triggerKeyOfClaim("wf:t@9007199254740992") === null);
check("有效状态修剪逻辑仍保留未完结", pruneClaims(new Map([
  ["wf:t@1", { status: "CLAIMED", minute: 1, at: 60_000 }],
  ["wf:t@2", { status: "SUCCEEDED", minute: 2, at: 120_000 }],
]), 0).has("wf:t@1"));
console.log("trigger-claim-shape-smoke:" + (total - failed) + "/" + total + " 通过");
if (failed > 0) process.exitCode = 1;
