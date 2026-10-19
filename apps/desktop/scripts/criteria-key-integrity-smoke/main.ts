import { state } from './stubRepositories.js';
import { readCriteriaValues, nodeCriteriaPrompt } from '../../src/main/lib/searchPrefs.js';
let pass=0, fail=0;
function check(label:string, ok:boolean){ console.log(`${ok?'PASS':'FAIL'} ${label}`);if(ok)pass++;else fail++; }
function prompt(name:string): string | null { try { return nodeCriteriaPrompt('wf-fake',[{name,choices:['all']}]); } catch { return null; } }
state.raw = '{}';
for(const name of ['constructor','toString','valueOf','__proto__']){
 check(`unselected inherited ${name} cannot crash workflow`,prompt(name)==='');
}
state.raw = JSON.stringify({constructor:'selected'});
check('legitimate own constructor key remains selectable',(prompt('constructor')??'').includes('constructor:selected'));
state.raw = JSON.stringify(['from-invalid-array']);
check('array preferences are not accepted as a condition map',Object.keys(readCriteriaValues('wf-fake')).length===0);
check('array index 0 cannot be injected as condition',(prompt('0')??'')==='');
state.raw = JSON.stringify({range:'last year'});
check('normal conditions still work',(prompt('range')??'').includes('range:last year'));
console.log(`criteria-key-integrity-smoke: ${pass}/${pass+fail}`);if(fail)process.exitCode=1;
