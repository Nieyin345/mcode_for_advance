import {safeGitMessage} from "../../src/main/lib/marketClone.js";
let pass=0,fail=0;
function test(label:string,condition:boolean,detail:string){console.log((condition?"PASS ":"FAIL ")+label+(condition?"":" "+detail));condition?pass++:fail++;}
for(const [label,secretUri,expected] of [
 ["ssh userinfo", "ssh://alice:reallySecret@host.invalid/repo", "ssh://host.invalid/repo"],
 ["git+https userinfo","git+https://alice:reallySecret@host.invalid/repo?key=leak","git+https://host.invalid/repo"],
 ["ftp legacy userinfo","ftp://alice:reallySecret@host.invalid/a","ftp://host.invalid/a"],
 ["regular https userinfo","https://alice:reallySecret@host.invalid/repo?auth=leak","https://host.invalid/repo"]
] as const){
 const text=safeGitMessage("fatal: "+secretUri);
 test(label+" strips every embedded credential and query",!text.includes("reallySecret")&&!text.includes("alice")&&!text.includes("leak")&&text.includes(expected),text);
}
const authorization=safeGitMessage("authorization: Bearer ABCDEF12345678\napi_key=MY_PRIVATE_TOKEN");
test("authorization and standalone API keys still redacted",!authorization.includes("ABCDEF")&&!authorization.includes("MY_PRIVATE_TOKEN"),authorization);
const plain=safeGitMessage("fetching 7 objects, done");
test("normal progress message preserved",plain==="fetching 7 objects, done",plain);
console.log(`market-clone-redaction-smoke: ${pass}/${pass+fail}`);if(fail)process.exitCode=1;
