import {safeErrorMessage} from "../../src/main/lib/ipcError.js";
let good=0,bad=0;
function check(name:string,pass:boolean,detail?:unknown){console.log((pass?"PASS ":"FAIL ")+name+(pass?"":" "+String(detail)));pass?good++:bad++;}
check("ordinary Error message stays readable",safeErrorMessage(new Error("displayable detail"))==="displayable detail");
check("null-prototype thrown value never crashes",safeErrorMessage(Object.create(null))==="未知错误");
const huge="X".repeat(2_000_000);
let result="";
try{result=safeErrorMessage(huge);}catch{}
check("untrusted thrown text is bounded to at most 1024 chars",result.length>0&&result.length<=1024,result.length);
const untrusted=new Error("a".repeat(2_000_000));
check("untrusted Error.message is bounded to at most 1024 chars",safeErrorMessage(untrusted).length<=1024);
const poison={toString(){throw Error("poisoned toString");}};
check("throwing coercion never crashes",safeErrorMessage(poison)==="未知错误");
console.log(`safe-error-bounded-smoke: ${good}/${good+bad}`);if(bad)process.exitCode=1;