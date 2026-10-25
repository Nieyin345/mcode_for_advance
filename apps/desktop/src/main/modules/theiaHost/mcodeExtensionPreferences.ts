/** F032: extension-specific VS Code configuration stored under Mcode's data root.
 * No overwrite of general Mcode settings. Exact settings survive host restarts.
 */
import {readFile,writeFile,mkdir,rename,rm,stat} from "node:fs/promises";
import * as path from "node:path";
import {randomUUID} from "node:crypto";
const KEY=/^[a-zA-Z0-9_.-]{1,150}$/;
type Values=Record<string,unknown>;
export class McodeExtensionPreferences {
  private constructor(private readonly file:string,private readonly values:Values){}
  static async open(storageRoot:string):Promise<McodeExtensionPreferences>{
    const file=path.join(storageRoot,"preferences.json");
    let entries:Values={};
    try {
      if((await stat(file)).size>256*1024)throw Error("扩展配置超出 256 KiB");
      const parsed:unknown=JSON.parse(await readFile(file,"utf8"));
      if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw Error("扩展配置无效");
      entries=Object.fromEntries(Object.entries(parsed).filter(([key])=>KEY.test(key)));
    }catch(e){
      if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;
    }
    return new McodeExtensionPreferences(file,entries);
  }
  get user():Values{return {...this.values};}
  async update(key:string,value:unknown):Promise<void>{
    if(!KEY.test(key)||key.includes("__proto__")||key.includes("constructor")||key.includes("prototype"))
      throw Error("扩展配置键无效");
    const after={...this.values};
    if(value===undefined)delete after[key];
    else{
      // JSON-only: prototype-free wire representation, at most 256 KiB.
      const encoded=JSON.stringify(value);
      if(encoded===undefined||encoded.length>32768)throw Error("扩展配置值无效或过大");
      after[key]=JSON.parse(encoded);
    }
    const serialized=JSON.stringify(after);
    if(serialized.length>256*1024)throw Error("扩展配置超过限制");
    await mkdir(path.dirname(this.file),{recursive:true});
    const tmp=this.file+"-"+randomUUID()+".tmp";
    try{await writeFile(tmp,serialized,{flag:"wx"});await rename(tmp,this.file);}
    finally{await rm(tmp,{force:true});}
    Object.keys(this.values).forEach(k=>delete this.values[k]);
    Object.assign(this.values,after);
  }
}
