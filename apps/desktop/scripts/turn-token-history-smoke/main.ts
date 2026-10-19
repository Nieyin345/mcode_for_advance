import { turnTokenUsage } from "../../src/renderer/lib/turnTokens.js";
let good=0,bad=0;
function eq(name:string,a:unknown,b:unknown){let yes=Object.is(a,b);console.log((yes?"PASS ":"FAIL ")+name+" got="+a+" wanted="+b);yes?good++:bad++;}
eq("ordinary cumulative delta",turnTokenUsage([{endedAt:100,totalProcessedTokens:20},{endedAt:200,totalProcessedTokens:60}],200,true),40);
eq("first cumulative count equals first turn",turnTokenUsage([{endedAt:100,totalProcessedTokens:20}],100,true),20);
eq("missing previous cumulative counter is unknown not the full session count",turnTokenUsage([{endedAt:100,totalProcessedTokens:20},{endedAt:200,totalProcessedTokens:NaN},{endedAt:300,totalProcessedTokens:100}],300,true),null);
eq("duplicate completion time takes last valid record",turnTokenUsage([{endedAt:100,totalProcessedTokens:20},{endedAt:200,totalProcessedTokens:NaN},{endedAt:200,totalProcessedTokens:55}],200,true),35);
eq("non cumulative turn unchanged",turnTokenUsage([{endedAt:100,totalProcessedTokens:18}],100,false),18);
eq("missing target remains unknown",turnTokenUsage([{endedAt:100,totalProcessedTokens:18}],200,false),null);
eq("cumulative counter never negative",turnTokenUsage([{endedAt:100,totalProcessedTokens:99},{endedAt:200,totalProcessedTokens:20}],200,true),0);
console.log(`turn-token-history-smoke: ${good}/${good+bad}`);if(bad)process.exitCode=1;
