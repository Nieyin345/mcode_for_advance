import { expandTriggerVars } from '../../src/main/orchestration/triggerVars.js';
let passed=0, failed=0;
function check(label: string, ok: boolean) { console.log(`${ok?'PASS':'FAIL'} ${label}`); if(ok) passed++; else failed++; }
function rejects(value: unknown): boolean {
  try { expandTriggerVars({message:'payload={{trigger.event}}'}, {event:value}); return false; }
  catch(e) { return String(e).includes('trigger') || String(e).includes('触发'); }
}
check('string scalar expands', expandTriggerVars({message:'{{trigger.event}}'},{event:'ok'}).message==='ok');
check('string array remains joined', expandTriggerVars({message:'{{trigger.event}}'},{event:['x','y']}).message==='x、y');
check('null is an explicit blank', expandTriggerVars({message:'X{{trigger.event}}Y'},{event:null}).message==='XY');
check('missing event throws', (()=>{try{expandTriggerVars({message:'{{trigger.event}}'},{});return false;}catch{return true;}})());
const cyclic: Record<string,unknown>={kind:'evt'}; cyclic.self=cyclic;
check('cyclic event fails explicitly instead of silently deleting reference',rejects(cyclic));
check('bigint event fails explicitly instead of silently deleting reference', rejects(BigInt(12)));
check('symbol event fails explicitly instead of silently deleting reference', rejects(Symbol('bad')));
check('function event fails explicitly instead of silently deleting reference', rejects(()=>1));
console.log(`trigger-var-integrity-smoke: ${passed}/${passed+failed}`);
if(failed)process.exitCode=1;
