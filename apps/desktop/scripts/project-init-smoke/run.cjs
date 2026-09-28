const {createRequire}=require('node:module');
const {mkdtempSync,rmSync,readFileSync}=require('node:fs');
const {join,resolve}=require('node:path');
const {tmpdir}=require('node:os');
const {spawnSync}=require('node:child_process');
const app=resolve(__dirname,'../..');
const req=createRequire(join(app,'package.json'));
const esbuild=createRequire(req.resolve('vite'))('esbuild');
const out=mkdtempSync(join(tmpdir(),'mcode-init-bundle-'));
const mutate=process.argv[2]==='--empty-files';
(async()=>{try{
 const result=await esbuild.build({absWorkingDir:app,entryPoints:['scripts/project-init-smoke/main.ts'],outfile:join(out,'main.mjs'),bundle:true,platform:'node',format:'esm',tsconfig:'tsconfig.json',metafile:true,logLevel:'error',alias:{
 '@main/store/repositories.js':'./scripts/project-init-smoke/stubs.ts',
 '@main/lib/dataRoot.js':'./scripts/project-init-smoke/stubs.ts',
 '@main/memory/broadcast.js':'./scripts/project-init-smoke/stubs.ts',
 },plugins:mutate?[{name:'inverse-regression',setup(build){build.onLoad({filter:/projectInit[\\/]service\.ts$/},args=>{
  const text=readFileSync(args.path,'utf8');const needle='await handle.writeFile(content, "utf8");';
  if(!text.includes(needle))throw Error('Mutation boundary missing');
  return {contents:text.replace(needle,'await handle.writeFile("", "utf8");'),loader:'ts'};
 });}}]:[]});
 for(const suffix of ['src/main/projectInit/service.ts','src/main/ipc/projectInit.ts','src/main/memory/store.ts','contracts/src/ipc/projectInit.ts'])if(!Object.keys(result.metafile.inputs).some(p=>p.replaceAll('\\','/').endsWith(suffix)))throw Error('Production coverage missing: '+suffix);
 const child=spawnSync(process.execPath,[join(out,'main.mjs')],{stdio:'inherit',timeout:60000});if(child.error)throw child.error;process.exitCode=child.status??1;
 if(!process.exitCode){const routes=spawnSync(process.execPath,[join(__dirname,'routes.cjs')],{stdio:'inherit',timeout:30000});if(routes.error)throw routes.error;process.exitCode=routes.status??1;}
}finally{rmSync(out,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
