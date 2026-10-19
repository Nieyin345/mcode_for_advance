import { triggerSpecKeyOf } from "@main/orchestration/automationStatus.js";
import type { TriggerSpec } from "@contracts/nodeType";

let total = 0;
let failed = 0;
const check = (name: string, predicate: boolean, details?: unknown) => {
  total++;
  if (predicate) console.log("  ok   " + name);
  else {
    failed++;
    console.log("  FAIL " + name + (details === undefined ? "" : " — " + JSON.stringify(details)));
  }
};
const spec = (policy?: "SAFE_DEFAULT" | "EXPLICIT_OVERRIDE"): Extract<TriggerSpec, { kind: "file" }> => ({
  kind: "file", globs: ["dist/**/*.js"], excludeGlobs: [], debounceMs: 200,
  ...(policy === undefined ? {} : { defaultIgnorePolicy: policy }),
});
const safe = triggerSpecKeyOf(spec("SAFE_DEFAULT"));
const override = triggerSpecKeyOf(spec("EXPLICIT_OVERRIDE"));
const missing = triggerSpecKeyOf(spec());
check("默认策略和显式 SAFE_DEFAULT 是同一条件", missing === safe, { missing, safe });
check("由 EXPLICIT_OVERRIDE 收紧到 SAFE_DEFAULT 必须改变签名", override !== safe, { override, safe });
check("由 SAFE_DEFAULT 放宽到 EXPLICIT_OVERRIDE 必须改变签名", safe !== override, { safe, override });
check("同一覆盖策略多次签名稳定", triggerSpecKeyOf(spec("EXPLICIT_OVERRIDE")) === override);
check("默认目录忽略以外的 glob 改动仍改变签名",
  triggerSpecKeyOf({ ...spec(), globs: ["src/*.ts"] }) !== safe);
check("exclude 改动仍改变签名",
  triggerSpecKeyOf({ ...spec(), excludeGlobs: ["**/tmp/**"] }) !== safe);
check("debounce 改动仍改变签名",
  triggerSpecKeyOf({ ...spec(), debounceMs: 100 }) !== safe);
check("文件和手动触发仍有独立签名",
  triggerSpecKeyOf({ kind: "manual" }) !== safe);
console.log("trigger-policy-signature-smoke:" + (total - failed) + "/" + total + " 通过");
if (failed > 0) process.exitCode = 1;
