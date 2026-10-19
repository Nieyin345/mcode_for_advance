import {isValidSnapshot,fmtCacheHitRate,fmtTokens} from "../../src/renderer/lib/contextWindow.js";
let good=0,bad=0;function eq(name:string,a:unknown,b:unknown){const yes=Object.is(a,b);console.log((yes?"PASS ":"FAIL ")+name+" got="+a+" expected="+b);yes?good++:bad++;}
const snap={usedTokens:100,maxTokens:1000,pct:10,warning:"ok",warnings:[]};
eq("valid context snapshot remains usable",isValidSnapshot(snap),true);
eq("NaN context usedTokens must not enter status ring",isValidSnapshot({...snap,usedTokens:NaN}),false);
eq("infinite maximum context size rejected",isValidSnapshot({...snap,maxTokens:Infinity}),false);
eq("NaN percentage rejected",isValidSnapshot({...snap,pct:NaN}),false);
eq("negative usedTokens rejected",isValidSnapshot({...snap,usedTokens:-1}),false);
eq("negative percentage rejected",isValidSnapshot({...snap,pct:-5}),false);
eq("percentage over 100 rejects malformed snapshot",isValidSnapshot({...snap,pct:110}),false);
eq("healthy cache fraction",fmtCacheHitRate(80,100),"80%");
eq("missing denominator",fmtCacheHitRate(5,0),"—");
eq("cache read greater than all prompt cannot render over 100 percent",fmtCacheHitRate(110,100),"—");
eq("nonfinite cache read does not show NaN%",fmtCacheHitRate(NaN,100),"—");
eq("nonfinite denominator does not show NaN%",fmtCacheHitRate(10,Infinity),"—");
eq("negative cache read does not show negative hit percentage",fmtCacheHitRate(-10,100),"—");
eq("nonfinite token count isn't rendered as InfinityM",fmtTokens(Infinity),"—");
console.log(`context-window-finite-smoke: ${good}/${good+bad}`);if(bad)process.exitCode=1;
