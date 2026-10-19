import * as binary from '../../src/main/lib/binPath.js';
import { readFileSync } from 'node:fs';
let good=0,bad=0;
function check(name:string,value:boolean){console.log((value?'PASS ':'FAIL ')+name);if(value)good++;else bad++;}
const candidate=(binary as unknown as {lookupSpec?: (name:string, platform:string)=>{command:string,args:string[]}}).lookupSpec;
check('shared command builder exists',typeof candidate==='function');
if(candidate){
 const windows=candidate('python','win32');
 const linux=candidate('python','linux');
 const mac=candidate('python','darwin');
 check('Windows uses where',windows.command==='where.exe'&&windows.args.join(' ')==='python');
 check('Linux which lists all matches',linux.command==='which'&&linux.args.join(' ')==='-a python');
 check('macOS which lists all matches',mac.command==='which'&&mac.args.join(' ')==='-a python');
}
const src=readFileSync('src/main/lib/binPath.ts','utf8');
check('production lookup uses shared command builder',src.includes('lookupSpec(name, process.platform)'));
console.log(`bin-path-multipath-smoke: ${good}/${good+bad}`);
if(bad)process.exitCode=1;
