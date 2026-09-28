// Regenerates src/renderer/lib/fileIconCollection.json — the subset of the
// `@iconify-json/material-icon-theme` collection that fileIcon.tsx actually
// references (EXT_ICON / NAME_ICON values + DEFAULT_ICON). The full collection
// ships ~1175 icons (folders, variants) of which the file-type maps use a
// fraction; bundling only those keeps the renderer lighter.
//
//   node scripts/file-icon-subset/gen.mjs          # rewrite the subset
//   node scripts/file-icon-subset/gen.mjs --check  # exit 1 if stale / missing
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const desktop=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const src=join(desktop,'src/renderer/lib/fileIcon.tsx');
const outFile=join(desktop,'src/renderer/lib/fileIconCollection.json');
const pnpm=resolve(desktop,'../../node_modules/.pnpm');
const dir=readdirSync(pnpm).filter(n=>n.startsWith('@iconify-json+material-icon-theme@')).sort().at(-1);
if(!dir)throw Error('Missing @iconify-json/material-icon-theme (no network install)');
const full=JSON.parse(readFileSync(join(pnpm,dir,'node_modules/@iconify-json/material-icon-theme/icons.json'),'utf8'));
export function referencedIcons(code){
  const names=new Set();
  for(const block of ['EXT_ICON','NAME_ICON']){
    const start=code.indexOf(`const ${block}`);if(start<0)throw Error(`${block} not found in fileIcon.tsx`);
    const body=code.slice(code.indexOf('{',start)+1,code.indexOf('\n};',start));
    for(const m of body.matchAll(/:\s*"([^"]+)"/g))names.add(m[1]);
  }
  const def=code.match(/const DEFAULT_ICON\s*=\s*"([^"]+)"/);if(!def)throw Error('DEFAULT_ICON not found');names.add(def[1]);
  return names;
}
export function buildSubset(collection,names){
  const icons={},aliases={},missing=[];
  const need=(n)=>{
    if(collection.icons[n]){icons[n]=collection.icons[n];return;}
    const a=collection.aliases?.[n];
    if(a){aliases[n]=a;need(a.parent);return;}
    missing.push(n);
  };
  for(const n of [...names].sort())need(n);
  const out={prefix:collection.prefix,icons};
  if(Object.keys(aliases).length)out.aliases=aliases;
  for(const k of ['width','height','left','top'])if(collection[k]!==undefined)out[k]=collection[k];
  return {out,missing};
}
const {out,missing}=buildSubset(full,referencedIcons(readFileSync(src,'utf8')));
if(missing.length)throw Error('Icons referenced by fileIcon.tsx but absent from the collection: '+missing.join(', '));
const text=JSON.stringify(out)+'\n';
if(process.argv.includes('--check')){
  let cur='';try{cur=readFileSync(outFile,'utf8');}catch{}
  if(cur!==text){console.error('fileIconCollection.json is stale — run: node scripts/file-icon-subset/gen.mjs');process.exit(1);}
  console.log(`fileIconCollection.json up to date (${Object.keys(out.icons).length} icons, ${(text.length/1024).toFixed(0)}KB)`);
}else{
  writeFileSync(outFile,text);
  console.log(`wrote ${outFile}: ${Object.keys(out.icons).length} icons + ${Object.keys(out.aliases??{}).length} aliases, ${(text.length/1024).toFixed(0)}KB (full: ${Object.keys(full.icons).length} icons, ${(JSON.stringify(full).length/1024).toFixed(0)}KB)`);
}
