import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const code=readFileSync(resolve("src/renderer/components/ide/OpenTabsBar.tsx"),"utf8");
let total=0,fail=0;
function check(name:string,ok:boolean){total++;if(!ok)fail++;console.log((ok?"PASS ":"FAIL ")+name);}
check("file-only tablist exposes native tab list role",/ref=\{scrollRef\}[\s\S]{0,100}role="tablist"/.test(code));
check("file-only tablist routes keyboard via shared handler",code.includes("onKeyDown={handleTabListKeyDown}")&&code.includes("handleTabListKeyDown, TabBarChevronButton"));
check("plan tab role is keyboard-focusable",/role="tab"\s+aria-selected=\{planTabActive\}\s+tabIndex=\{0\}/.test(code));
check("wheel scrolling consumes event only if horizontal track moved",code.includes("const previous = el.scrollLeft;")&&code.includes("if (el.scrollLeft !== previous) e.preventDefault();"));
check("nested plan close stops event propagation",code.includes("if (activeSessionId) closePlanDrawer(activeSessionId)")&&code.includes("e.stopPropagation();"));
console.log("filetab keyboard "+(total-fail)+"/"+total);
if(fail)process.exitCode=1;
