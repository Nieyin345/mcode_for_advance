/** Fail-visible renderer policy for FileMentionPicker, no real user file access. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const src = readFileSync(resolve(process.cwd(),"src/renderer/components/chat/FileMentionPicker.tsx"),"utf8");
let checks=0, fail=0;
function check(name:string,good:boolean){ checks++;if(!good)fail++;console.log("  "+(good?"PASS ":"FAIL ")+name); }
check("file search errors are separate from empty search results",src.includes("searchError") && src.includes("setSearchError(true)") && src.includes("t(\"common.retry\")"));
check("retrying file search uses the same host API",src.includes("searchRetry") && src.includes("setSearchRetry((v) => v + 1)") && src.includes(".search({"));
check("old file-search failures cannot overwrite a later query",src.includes("if (reqIdRef.current !== myId) return;") && src.includes("setSearchError(true)"));
check("opening a native picker records the current open episode",src.includes("selectionGenerationRef.current") && src.includes("const generation = selectionGenerationRef.current;"));
check("native OS dialog failures are visibly reported",src.includes("setPickError(true)") && src.includes("pickError") && src.includes("t(\"common.error\")"));
check("native dialog cancel is harmless",src.includes("if (paths.length === 0) return"));
check("native dialog late result cannot attach to a closed picker",src.includes("if (selectionGenerationRef.current !== generation) return;"));
check("native dialog retry remains explicitly actionable",src.includes("handlePickExternal") && src.includes("t(\"common.retry\")"));
check("requestAnimationFrame focus callback is cancelled on close",src.includes("cancelAnimationFrame(raf)"));
check("existing selected paths cannot silently fall back to another file",src.includes("if (selectedEntries.size > 0) {") && src.includes("return;"));
check("new open episode clears past errors",src.includes("setPickError(false)") && src.includes("setSearchError(false)"));
console.log("arc005-file-picker-error-smoke: "+(checks-fail)+"/"+checks+" PASS");
if(fail)process.exitCode=1;
