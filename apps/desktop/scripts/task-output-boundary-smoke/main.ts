import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isAllowedTaskOutputPath, readTaskOutputFile, TASK_OUTPUT_TAIL_BYTES } from '../../src/main/lib/taskOutput.js';
let good=0,bad=0;
function check(label:string,pass:boolean){console.log(`${pass?'PASS':'FAIL'} ${label}`);if(pass)good++;else bad++;}
function rejected(p:string){try {readTaskOutputFile(p);return false;} catch {return true;}}
const root=mkdtempSync(join(tmpdir(),'mcode-task-output-boundary-'));
try {
 const safe=join(root,'safe','tasks');mkdirSync(safe,{recursive:true});
 const out=join(safe,'ok.output');writeFileSync(out,'BUILD OK');
 check('normal CLI output stays readable',readTaskOutputFile(out).text==='BUILD OK');
 check('normal lexical path remains allowed',isAllowedTaskOutputPath(out));
 const nested=join(safe,'nested','forged.output');mkdirSync(join(safe,'nested'));writeFileSync(nested,'FAKE OUTPUT');
 check('only direct tasks/id.output is allowed, not nested arbitrary files',!isAllowedTaskOutputPath(nested));
 check('a nested forged output path cannot be read',rejected(nested));
 const long=join(safe,'long.output');writeFileSync(long,'X'.repeat(TASK_OUTPUT_TAIL_BYTES+8)+'TAIL');
 check('normal long output is truncated',readTaskOutputFile(long).truncated);
 const outside=join(root,'outside');mkdirSync(outside);
 const secret=join(outside,'hidden.output');writeFileSync(secret,'FAKE-SECRET-DATA-NOT-REAL');
 const victim=join(root,'fake-notification','tasks');mkdirSync(join(root,'fake-notification'));
 symlinkSync(outside,victim,process.platform==='win32'?'junction':'dir');
 check('fixture directory junction is real',existsSync(join(victim,'hidden.output')));
 check('directory junction pointing outside task root must be refused',rejected(join(victim,'hidden.output')));
 let leafCreated=false;
 const leaf=join(safe,'leaf.output');
 try {symlinkSync(secret,leaf,'file');leafCreated=true;} catch(e) {console.log('SKIP leaf symlink not permitted by OS');}
 if(leafCreated)check('direct output symlink to outside must be refused',rejected(leaf));
 check('outside fixture remains unchanged',readFileSync(secret,'utf8')==='FAKE-SECRET-DATA-NOT-REAL');
}finally{rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
console.log(`task-output-boundary-smoke: ${good}/${good+bad}`);
if(bad)process.exitCode=1;
