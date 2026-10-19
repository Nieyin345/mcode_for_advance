import { lineDiff, diffSummary, countLines } from "../../src/renderer/lib/lineDiff.js";
let pass=0,fail=0;
function eq(name:string,a:unknown,b:unknown){const ok=JSON.stringify(a)===JSON.stringify(b);console.log((ok?"PASS ":"FAIL ")+name+(ok?"":` got=${JSON.stringify(a)} expected=${JSON.stringify(b)}`));if(ok)pass++;else fail++;}
eq("LF and CRLF variants have no artificial edits",lineDiff("alpha\r\nbeta\r\n","alpha\nbeta\n"),[{op:"equal",text:"alpha"},{op:"equal",text:"beta"}]);
eq("CRLF to LF change preserves real changed line",lineDiff("alpha\r\nbeta\r\n","alpha\nBETA\n"),[{op:"equal",text:"alpha"},{op:"insert",text:"BETA"},{op:"delete",text:"beta"}]);
eq("CRLF single blank line equals LF blank line",lineDiff("\r\n","\n"),[{op:"equal",text:""}]);
eq("CRLF nonterminated line correctly counted",countLines("alpha\r\nbeta"),2);
eq("identical LF files remain unchanged",diffSummary(lineDiff("x\ny","x\ny")),{adds:0,dels:0});
console.log(`line-diff-eol-smoke: ${pass}/${pass+fail}`);
if(fail)process.exitCode=1;
