import { resolveMarkdownImageRoute as route } from "../../src/renderer/lib/markdownImageRoute.js";
const lib={id:"fixture-entry",rootAbs:"D:/library/entry"};
let pass=0,fail=0;
function check(name:string, actual:unknown,expected:unknown){const ok=actual===expected;console.log((ok?"PASS ":"FAIL ")+name+(ok?"":` got=${String(actual)} want=${String(expected)}`));if(ok)pass++;else fail++;}
check("normal nested image routes via library",route("D:/library/entry/docs/pic.png",lib).kind,"library");
check("legitimate dotdot-prefixed filename can be opened",route("D:/library/entry/..draft.png",lib).kind,"library");
check("dotdot-prefixed filename keeps correct library relative path",(route("D:/library/entry/..draft.png",lib) as {relPath?:string}).relPath,"..draft.png");
check("dotdot-prefixed directory name is a valid directory",route("D:/library/entry/..draft/pic.png",lib).kind,"library");
check("parent traversal is still denied",route("D:/library/entry/../private.png",lib).kind,"denied");
check("nested parent traversal escaping library is denied",route("D:/library/entry/a/../../private.png",lib).kind,"denied");
check("nested internal parent traversal is normalized",(route("D:/library/entry/a/../b.png",lib) as {relPath?:string}).relPath,"b.png");
check("absolute foreign file stays denied",route("D:/other/secret.png",lib).kind,"denied");
check("without library context uses project read",route("D:/other/secret.png",null).kind,"project");
console.log(`markdown-image-path-smoke: ${pass}/${pass+fail}`);
if(fail)process.exitCode=1;
