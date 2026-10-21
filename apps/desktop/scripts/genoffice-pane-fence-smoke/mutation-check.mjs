/** T54 mutation proof. Original vendor files are never changed. */
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const dirname = (url)=>resolve(fileURLToPath(url),'..')
const here=dirname(import.meta.url)
const require=createRequire(import.meta.url)
const modules=resolve(here,'../../../../node_modules/.pnpm')
const version=readdirSync(modules).find(item=>item.startsWith('esbuild@'))
if(!version)throw new Error('esbuild is not installed')
const {build}=require(join(modules,version,'node_modules','esbuild'))
const sourcePath=resolve(here,'../../../../genoffice/apps/sheets/src/main/mcode-sheets-scoped.ts')
const smokePath=join(here,'main.ts')
const stubPath=join(here,'stubs','electron.ts')
const original=readFileSync(sourcePath,'utf8')
const digest=(s)=>createHash('sha256').update(s).digest('hex')
const originalHash=digest(original)
const out=mkdtempSync(join(tmpdir(),'mcode-t54-mutants-'))
const variants=[
  { label:'A', from:'for (const path of directPaths(channel, args)) assertAllowedPath(guard, channel, path)', to:'void directPaths(channel, args)', expected:'workbook:save outside rejected' },
  { label:'B', from:"if (group === 'B') {", to:"if (group === 'B' && false) {", expected:'sheets:capture-screen-sources readable rejection' },
]
try {
  for(const variant of variants) {
    if(original.split(variant.from).length!==2)throw new Error('T54 mutation anchor absent or repeated: '+variant.label)
    const mutant=join(out,'mcode-scoped-'+variant.label+'.ts')
    writeFileSync(mutant,original.replace(variant.from,variant.to))
    const filename=join(out,'test-'+variant.label+'.mjs')
    await build({
      entryPoints:[smokePath], bundle:true,platform:'node',format:'esm',
      outfile:filename,logLevel:'error',
      alias:{electron:stubPath},
      plugins:[{name:'mutate-source',setup(b){
        b.onResolve({filter:/mcode-sheets-scoped$/},()=>({path:mutant}))
      }}],
    })
    const run=spawnSync(process.execPath,[filename],{encoding:'utf8'})
    if(run.status===0 || !run.stdout.includes('FAIL') ||
       !run.stdout.includes(variant.expected)) {
      throw new Error('T54 mutant '+variant.label+' did NOT make the required assertion red:\n'+run.stdout+'\n'+run.stderr)
    }
    console.log('MUTATION '+variant.label+': expected red confirmed ('+variant.expected+')')
  }
  if(digest(readFileSync(sourcePath,'utf8'))!==originalHash)throw new Error('original source changed')
  console.log('MUTATION: original source SHA-256 intact '+originalHash)
}finally{
  rmSync(out,{recursive:true,force:true})
}
