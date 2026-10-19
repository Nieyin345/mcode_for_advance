import { worktreeRepoSegment, worktreeSessionSegment } from '../../src/main/lib/worktreePathSegment.js';
import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
let pass=0, fail=0;
function check(name:string, ok:boolean) {console.log(`${ok?'PASS':'FAIL'} ${name}`); if(ok)pass++;else fail++;}
function rejects(fn:()=>unknown) {try{fn();return false;}catch{return true;}}
check('ordinary UUID tail preserves legacy dir',worktreeSessionSegment('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')==='eeeeeeeeeeee');
check('session path separator cannot escape managed root', rejects(()=>worktreeSessionSegment('../../escape')));
check('Windows backslash traversal rejected even on non Windows',rejects(()=>worktreeSessionSegment('a\\..\\..\\evil')));
check('dot and dot-dot session names rejected', rejects(()=>worktreeSessionSegment('.'))&&rejects(()=>worktreeSessionSegment('..')));
check('normal repository basename stable',worktreeRepoSegment('my-repo')==='my-repo');
check('repository dot segments never traverse',worktreeRepoSegment('..')==='repo'&&worktreeRepoSegment('.')==='repo');
const root=resolve('fake-test-root');
const dest=join(root,worktreeRepoSegment('repo'),worktreeSessionSegment('session-safe123'));
check('safe session path is within repo root',dest.startsWith(join(root,'repo')+sep));
const original=join(root,'repo','../../escape');
check('old raw session suffix really escaped repository root',!original.startsWith(join(root,'repo')+sep));
const source=readFileSync('src/main/lib/worktreeOps.ts','utf8');
check('production fallback worktreeDirFor uses guarded session segment',source.includes('worktreeSessionSegment(sessionId)'));
check('production both worktree paths use guarded repository segments',(source.match(/worktreeRepoSegment\(basename\(repoPath\)\)/g)||[]).length===2);
// On Windows, trailing dots and DOS device basenames are filesystem aliases.
// Validate on all platforms: a backup created on Linux may later be opened on Windows.
for(const name of ['CON','NUL','aux.txt','COM1','lpt9.log','abc.','...']) {
  const seg=worktreeRepoSegment(name);
  check(`repo ${name} maps to non-alias directory`,seg.length>0 && !seg.endsWith('.') && !/^\.+$/.test(seg) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(seg));
  check(`session ${name} cannot become Windows alias`, rejects(()=>worktreeSessionSegment(name)));
}
check('two unsafe repo names do not alias after sanitization',worktreeRepoSegment('foo.')!==worktreeRepoSegment('foo..'));
console.log(`worktree-path-guard-smoke: ${pass}/${pass+fail}`);
if(fail)process.exitCode=1;
