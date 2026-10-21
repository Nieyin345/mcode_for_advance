const fs=require('fs'), path=require('path'),ts=require('typescript');
const base=__dirname,renderer=path.resolve(base,'..'),ui=path.join(renderer,'ui');
// The progress hook is non-visual; all other .tsx files in this directory
// render UI or are reusable settings view components.
const files=fs.readdirSync(base).filter(x=>x.endsWith('.tsx')&&x!=='useMarketProgress.tsx');
const cache=new Map();
function pathFor(from,s){let target;
if(s.startsWith('./')||s.startsWith('../'))target=path.resolve(path.dirname(from),s);
else if(s.startsWith('@renderer/components/ui/'))target=path.resolve(ui,s.slice('@renderer/components/ui/'.length));
else if(s==='@renderer/components/ui/index.js')target=path.join(ui,'index.js');
else if(s.startsWith('@renderer/components/settings/'))target=path.resolve(base,s.slice('@renderer/components/settings/'.length));
else return null;
return [target.replace(/\.(js|jsx)$/i,'.tsx'),target.replace(/\.(js|jsx)$/i,'.ts'),target].find(fs.existsSync)||null;
}
function scan(file,stack=new Set()){
 if(stack.has(file))return [];
 if(cache.has(file))return cache.get(file);
 const src=fs.readFileSync(file,'utf8'),ast=ts.createSourceFile(file,src,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 if(/--(?:radius|chat-fs|shadow)-[\w-]+/.test(src)){cache.set(file,[file]);return [file];}
 const next=new Set(stack);next.add(file);let found=[];
 for(const s of ast.statements){
   const expr=(ts.isImportDeclaration(s)||ts.isExportDeclaration(s))?s.moduleSpecifier:null;
   if(!expr||!ts.isStringLiteral(expr))continue;
   const target=pathFor(file,expr.text);if(!target)continue;
   const sub=scan(target,next);if(sub.length){found=sub;break;}
 }
 cache.set(file,found);return found;
}
let passed=0;const misses=[];
for(const name of files){let hits=scan(path.join(base,name));if(hits.length)passed++;else misses.push(name);}
console.log(JSON.stringify({passed,total:files.length,uncovered:misses},null,2));
if(misses.length||passed!==files.length)process.exitCode=1;
