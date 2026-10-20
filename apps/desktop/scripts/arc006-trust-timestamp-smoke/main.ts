import { parseFlowTrust, flowExecutableUnderTrust } from '../../src/main/workflowEngines/flowTrustGate.js';
const rev='a'.repeat(64);
let ok=0,fail=0;
function check(s:string,v:boolean){console.log(`${v?'PASS':'FAIL'} ${s}`);if(v)ok++;else fail++;}
function trust(reviewedAt?: unknown){return JSON.stringify({origin:'ai',approvedRevision:rev,...(reviewedAt===undefined?{}:{reviewedAt})});}
check('legacy valid approval without reviewedAt stays compatible', flowExecutableUnderTrust(rev,trust()).ok);
check('valid reviewedAt keeps approval', flowExecutableUnderTrust(rev,trust(1760000000000)).ok);
for(const [label,value] of [['string timestamp','yesterday'],['null timestamp',null],['negative timestamp',-1],['fractional timestamp',5.25],['object timestamp',{}]] as [string,unknown][]) {
 const result=flowExecutableUnderTrust(rev,trust(value));
 check(`${label} fails closed as trust-corrupt`, !result.ok&&result.reason==='trust-corrupt');
}
check('pending null revision is untrusted', !flowExecutableUnderTrust(rev,JSON.stringify({origin:'ai',approvedRevision:null})).ok);
check('direct trust parser rejects a string timestamp', !parseFlowTrust(trust('yesterday')).ok);
// A trust ledger is just a tiny revision+origin object. Arbitrarily large raw
// JSON is not a user document; accepting it grants an unbounded parse budget.
const oversized = JSON.stringify({origin:'ai',approvedRevision:rev,padding:'x'.repeat(128*1024)});
const oversizedParse = parseFlowTrust(oversized);
check('oversized approval record is explicitly corrupt before JSON parsing',
  !oversizedParse.ok && oversizedParse.reason === 'trust-corrupt');
const oversizedGate = flowExecutableUnderTrust(rev, oversized);
check('oversized but valid-json approval cannot authorize flow execution',
  !oversizedGate.ok && oversizedGate.reason === 'trust-corrupt');
check('short valid historical approval remains authorized', flowExecutableUnderTrust(rev,trust()).ok);
console.log(`arc006-trust-timestamp-smoke: ${ok}/${ok+fail}`);
if(fail)process.exitCode=1;
