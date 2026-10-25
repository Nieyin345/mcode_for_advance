import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
export const calls:Array<{folder:string;limit:number;maxPerFile:number;extensions:string[];files:string[]|undefined}>=[];

export async function rgGrep(root:string,query:string,opts:{
 caseSensitive:boolean;limit:number;maxPerFile:number;includeExts?:string[],
 files?:string[],
},_ignored:unknown){
 calls.push({folder:root,limit:opts.limit,maxPerFile:opts.maxPerFile,extensions:opts.includeExts??[],files:opts.files});
 if (query === "fallback") return null; // Simulate ripgrep missing or spawn failure.
 const rows:Array<{path:string;relativePath:string;lineNumber:number;lineText:string;matches:Array<{start:number;end:number}>}> = [];
 const walk=(dir:string)=>{
   for(const d of readdirSync(dir,{withFileTypes:true})){
     const path=join(dir,d.name);
     if(d.isDirectory())walk(path);
     else if(d.isFile() && (opts.includeExts??[]).includes(extname(path).slice(1))){
       let hits=0;
       for(const [n,line] of readFileSync(path,"utf8").split(/\r?\n/).entries()){
         const pos=line.toLowerCase().indexOf(query.toLowerCase());
         if(pos<0)continue;
         rows.push({path,relativePath:relative(root,path).replace(/\\/g,"/"),lineNumber:n+1,lineText:line,matches:[{start:pos,end:pos+query.length}]});
         hits++;
         if(hits>=opts.maxPerFile || rows.length>=opts.limit)return;
       }
     }
     if(rows.length>=opts.limit)return;
   }
 };
 if(opts.files) {
   for(const rel of opts.files) {
     const full=join(root,rel);
     const fileName=rel.split("/").at(-1)!;
     if((opts.includeExts??[]).includes(extname(fileName).slice(1))) {
       const contents=readFileSync(full,"utf8");
       let hits=0;
       for(const [n,line] of contents.split(/\r?\n/).entries()) {
         const pos=line.toLowerCase().indexOf(query.toLowerCase());
         if(pos<0)continue;
         rows.push({path:full,relativePath:rel,lineNumber:n+1,lineText:line,matches:[{start:pos,end:pos+query.length}]});
         if(++hits>=opts.maxPerFile || rows.length>=opts.limit) break;
       }
     }
     if(rows.length>=opts.limit) break;
   }
 } else walk(root);
 return {matches:rows,truncated:rows.length>=opts.limit};
}
