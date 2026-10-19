import { parse, join, resolve, sep } from 'node:path';
import { projectKey, matchProjectKey, sameProjectKey } from '../../src/main/lib/projectScope.js';
let pass=0,fail=0;
function check(s:string,ok:boolean){console.log(`${ok?'PASS':'FAIL'} ${s}`);if(ok)pass++;else fail++;}
const root=parse(process.cwd()).root;
const canonical=process.platform==='win32'?root.toLowerCase():root;
check('filesystem root keeps its absolute separator',projectKey(root)===canonical);
check('root project matches its own directory',matchProjectKey(root,[root])===root);
check('filesystem root project contains a nested cwd',matchProjectKey(join(root,'demo','sub'),[root])===root);
const nested=join(root,'demo');
check('most specific nested project still wins',matchProjectKey(join(nested,'sub'),[root,nested])===nested);
check('sibling directory is not a nested project',matchProjectKey(join(root,'demo2'),[nested])===undefined);
check('same project returns saved spelling',sameProjectKey(nested,[root,nested])===nested);
check('ordinary relative path remains absolute',projectKey('.')===projectKey(resolve('.')));
console.log(`project-scope-root-smoke: ${pass}/${pass+fail}`);
if(fail)process.exitCode=1;
