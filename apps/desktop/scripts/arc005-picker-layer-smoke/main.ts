/** ARC-005: three picker keyboard-owner and stale-result regressions. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openEscapeLayer, isTopEscapeLayer, resetEscapeLayersForTests } from "../../src/renderer/lib/escapeLayer.js";

let total=0, failed=0;
const check=(name:string, yes:boolean)=>{total++; if(!yes)failed++; console.log("  "+(yes?"PASS ":"FAIL ")+name);};
const root=resolve(process.cwd(),"src/renderer/components/chat");
const source=(name:string)=>readFileSync(resolve(root,name),"utf8");
const file=source("FileMentionPicker.tsx");
const slash=source("SlashCommandPicker.tsx");
const library=source("LibraryPicker.tsx");
resetEscapeLayersForTests();
const closeFile=openEscapeLayer("chat.file-mention-picker");
check("file picker owns keyboard when alone",isTopEscapeLayer("chat.file-mention-picker"));
const closeSlash=openEscapeLayer("chat.slash-command-picker");
check("later opened slash picker wins",isTopEscapeLayer("chat.slash-command-picker") && !isTopEscapeLayer("chat.file-mention-picker"));
const closeLibrary=openEscapeLayer("chat.library-picker");
check("third picker wins even with both beneath",isTopEscapeLayer("chat.library-picker") && !isTopEscapeLayer("chat.slash-command-picker"));
closeLibrary();
check("closing top restores prior picker",isTopEscapeLayer("chat.slash-command-picker"));
closeSlash();closeFile();
check("closing all layers removes keyboard owner",!isTopEscapeLayer("chat.file-mention-picker"));
for(const [name,src,id] of [
 ["file",file,"chat.file-mention-picker"],
 ["slash",slash,"chat.slash-command-picker"],
 ["library",library,"chat.library-picker"]
] as const){
 check(name+" all keyboard paths obey top layer",src.includes('if (!isTopEscapeLayer("'+id+'")) return;'));
 check(name+" ignores modifier combinations",src.includes("e.altKey || e.ctrlKey || e.metaKey || e.shiftKey"));
 check(name+" prevents repeat selection",src.includes('if (e.repeat &&'));
 check(name+" handles IME Process and keyCode229",src.includes('e.key === "Process"') && src.includes("e.keyCode === 229"));
 check(name+" overlay registration is stable across item/query updates",src.includes('const closeEscapeLayer = openEscapeLayer("'+id+'");\n    return () => closeEscapeLayer();\n  }, [open]);'));
}
check("file picker ignores in-flight answers from closed searches",file.includes("++reqIdRef.current;") && file.includes("return () => {") && file.includes("window.clearTimeout(t);") && file.includes("if (reqIdRef.current !== myId) return;"));
check("file picker resets previous query results before new result",file.includes("setFiles([]);\n    setLoading(true);"));
check("file picker stores selected entries independently of visible search result",file.includes("new Map(prev)") && file.includes("next.set(file.path, file)") && file.includes("Array.from(selectedEntries.values())"));
check("file picker resets selected file map on fresh open",file.includes("setSelectedEntries(new Map());") && file.includes("[open, mode, projectPath]"));
check("file external chooser receives native Enter and Space",file.includes("rootRef.current?.contains(e.target)") && file.includes('e.key === "Enter" || e.key === " "'));
check("attach mode Tab can navigate to actual buttons",file.includes('mode === "attach" && e.key === "Tab"'));
check("slash tab buttons receive native keyboard activation",slash.includes("e.target.closest(\"button\")") && slash.includes('e.key === "Enter" || e.key === " "'));
check("library search input accepts Space for multiword queries",library.includes('e.key === " " && e.target === inputRef.current'));
check("library button focused native activation is not overridden",library.includes("rootRef.current?.contains(e.target)") && library.includes("e.target.closest(\"button\")"));
check("three pickers yield to foreign modal dialog input",[file,slash,library].every(s=>s.includes('e.target.closest(\'[role="dialog"], [role="alertdialog"]\')')));
check("empty file options never set active index negative",file.includes("if (files.length === 0) return;") && file.includes("Math.min(files.length - 1"));
check("empty library options never set active index negative",library.includes("if (options.length === 0) return;") && library.includes("Math.min(i + 1, options.length - 1)"));
check("library picker invalidates callbacks after close",library.includes("requestGenerationRef.current++") && library.includes("if (generation !== requestGenerationRef.current) return;"));
check("library picker resets cached item requests on fresh open",library.includes("loadedRef.current.clear()") && library.includes("setItemsOf({})"));
console.log("arc005-picker-layer-smoke: "+(total-failed)+"/"+total+" PASS");
if(failed)process.exitCode=1;
