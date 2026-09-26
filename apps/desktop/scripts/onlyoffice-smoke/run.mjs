import {createRequire} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const app=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(join(app,'package.json'));
const esbuild=createRequire(require.resolve('vite'))('esbuild');
const root=mkdtempSync(join(tmpdir(),'mcode-office-smoke-'));
try{
 const out=join(root,'smoke.mjs');
 await esbuild.build({absWorkingDir:app,entryPoints:['scripts/onlyoffice-smoke/main.ts'],outfile:out,bundle:true,platform:'node',format:'esm',tsconfig:'tsconfig.json',logLevel:'error',
  banner:{js:"import {createRequire as __cr} from 'node:module'; const require=__cr(import.meta.url);"},
  alias:{'@main/store/repositories.js':'./scripts/onlyoffice-smoke/stubs/ports.ts','@main/lib/pathGuard.js':'./scripts/onlyoffice-smoke/stubs/ports.ts','@main/lib/logger.js':'./scripts/onlyoffice-smoke/stubs/ports.ts',
   'node:fs/promises':'./scripts/onlyoffice-smoke/stubs/fsPromises.ts','node:http':'./scripts/onlyoffice-smoke/stubs/http.ts'},
 });
 const child=spawnSync(process.execPath,[out],{cwd:app,stdio:'inherit',timeout:30000,env:{...process.env,MCODE_ONLYOFFICE_SMOKE_ROOT:join(root,'data')}});
 if(child.error)throw child.error;
 process.exitCode=child.status??1;
}finally{rmSync(root,{recursive:true,force:true});}
