import { z } from "zod";
import { errText } from "../../src/main/lib/ipcError.js";
let good = 0, bad = 0;
function check(name: string, ok: boolean, actual?: unknown) {
  if (ok) { good++; console.log("PASS " + name); }
  else { bad++; console.log("FAIL " + name + " " + String(actual)); }
}
const nullProto = Object.create(null) as object;
let a: string | undefined;
try { a = errText(nullProto); } catch (e) { a = "THREW"; }
check("★ null-prototype thrown value never crashes IPC catch handler", !!a && a !== "THREW", a);
const throwingString = { toString(): never { throw new Error("FAKE_UNSAFE_TOSTRING"); } };
let b: string | undefined;
try { b = errText(throwingString); } catch { b = "THREW"; }
check("★ malicious toString value never breaks IPC catch", !!b && b !== "THREW", b);
const brokenError = new Error("error");
Object.defineProperty(brokenError, "message", { get() { throw new Error("FAKE_BAD_MESSAGE_GETTER"); } });
let c: string | undefined;
try { c = errText(brokenError); } catch { c = "THREW"; }
check("★ Exception getter cannot throw out of standardized error handler", !!c && c !== "THREW", c);
check("normal Error messages retained", errText(new Error("普通原因")) === "普通原因");
check("normal string reasons retained", errText("text") === "text");
const failed = z.object({ value: z.string() }).safeParse({ value: 123 });
if (failed.success) throw new Error("test broken");
check("zod diagnostics remain localized", errText(failed.error).includes("入参不合法") && errText(failed.error).includes("value"));
console.log(`ipc-error-resilience-smoke: ${good}/${good+bad}`);
if (bad) process.exitCode=1;