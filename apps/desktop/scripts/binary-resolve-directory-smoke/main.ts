import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { which, whichAny } from '../../src/main/lib/binaryResolve.js';
let good=0,bad=0;
function check(label:string,value:boolean){console.log(`${value?'PASS':'FAIL'} ${label}`);if(value)good++;else bad++;}
const root=mkdtempSync(join(tmpdir(),'mcode-binary-resolve-'));
try{
 const folder=join(root,'folder-tool');mkdirSync(folder);
 const file=join(root,'valid-tool');writeFileSync(file,'#!/bin/sh\nexit 0\n');
 if(process.platform!=='win32')chmodSync(file,0o755);
 check('plain regular executable path is found',which(file)===file);
 check('existing directory is not an executable path',which(folder)===null);
 check('whichAny skips existing directory and finds next executable',whichAny([folder,file])===file);
 check('missing path is not found',which(join(root,'absent'))===null);
 if(process.platform!=='win32'){
  const noExec=join(root,'not-executable');writeFileSync(noExec,'not executable');chmodSync(noExec,0o600);
  check('POSIX file without execute permission is not runnable',which(noExec)===null);
 }
}finally{rmSync(root,{recursive:true,force:true});}
console.log(`binary-resolve-directory-smoke: ${good}/${good+bad}`);if(bad)process.exitCode=1;
