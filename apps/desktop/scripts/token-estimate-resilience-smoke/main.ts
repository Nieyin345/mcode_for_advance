import { readFileSync } from 'node:fs';
import * as tokenEstimator from '../../src/main/lib/tokenEstimate.js';
const estimateToolTokens = tokenEstimator.estimateToolTokens;
const estimateToolTokensSafely = (tokenEstimator as typeof tokenEstimator & {estimateToolTokensSafely?: (tool: tokenEstimator.EstimableTool)=>number|null}).estimateToolTokensSafely;
let good=0,bad=0;
function check(label:string,value:boolean){console.log(`${value?'PASS':'FAIL'} ${label}`);if(value)good++;else bad++;}
const basic={name:'plain',description:'simple'};
check('normal schema still has positive token count',estimateToolTokens(basic)>0);
check('safe estimate agrees with exact count for healthy schema',estimateToolTokensSafely?.(basic)===estimateToolTokens(basic));
const cyclic:Record<string,unknown>={type:'object'};cyclic.self=cyclic;
check('cyclic schema is unknown instead of crashing the tool usage panel',estimateToolTokensSafely?.({name:'cycle',inputSchema:cyclic})===null);
check('BigInt schema is unknown instead of crashing the tool usage panel',estimateToolTokensSafely?.({name:'bigint',inputSchema:{minimum:10n}})===null);
const throws={toJSON(){throw new Error('fixture schema serializer unavailable');}};
check('throwing custom serializer is reported as unknown',estimateToolTokensSafely?.({name:'bad',inputSchema:throws})===null);
const ipc=readFileSync('src/main/ipc/context.ts','utf8');
check('production context uses safe token estimate',ipc.includes('estimateToolTokensSafely('));
check('production inprocess estimator preserves failed item as null',ipc.includes('estTokens: null'));
console.log(`token-estimate-resilience-smoke: ${good}/${good+bad}`);if(bad)process.exitCode=1;
