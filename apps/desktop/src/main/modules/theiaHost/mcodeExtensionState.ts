/** F033: persistent VS Code extension Mementos in Mcode-managed extension storage.
 * Global state survives project changes; workspace state uses the canonical
 * project path as a key. No secrets, credentials or system settings are stored.
 */
import * as path from "node:path";
import {createHash,randomUUID} from "node:crypto";
import {mkdir,readFile,rename,rm,stat,writeFile} from "node:fs/promises";
const LIMIT=256*1024;
type PluginState=Record<string,Record<string,unknown>>;
async function load(file:string):Promise<PluginState>{
  try{
    if((await stat(file)).size>LIMIT)throw Error("扩展状态超过 256 KiB 限制");
    const data:unknown=JSON.parse(await readFile(file,"utf8"));
    if(!data||typeof data!=="object"||Array.isArray(data))throw Error("扩展状态文件无效");
    const safe:PluginState=Object.create(null) as PluginState;
    for(const [id,value] of Object.entries(data)){
      if(!/^[a-z0-9._-]{1,225}$/i.test(id)||!value||typeof value!=="object"||Array.isArray(value))continue;
      safe[id]=Object.fromEntries(Object.entries(value).filter(([key])=>
        key.length<=256&&key!=="__proto__"&&key!=="constructor"&&key!=="prototype"));
    }
    return safe;
  }catch(err){if((err as NodeJS.ErrnoException).code==="ENOENT")return {};
    throw err;}
}
export class McodeExtensionState {
  private writing=Promise.resolve();
  private constructor(private readonly storage:string,private readonly globalFile:string,
    private readonly workspaceFile:string,private readonly globalData:PluginState,
    private readonly workspaceData:PluginState){}
  static async open(storage:string,workspace?:string):Promise<McodeExtensionState>{
    const globalFile=path.join(storage,"global-state.json");
    const workspaceKey=createHash("sha256").update(workspace??"(no-workspace)").digest("hex").slice(0,24);
    const workspaceFile=path.join(storage,`workspace-state-${workspaceKey}.json`);
    const [globalData,workspaceData]=await Promise.all([load(globalFile),load(workspaceFile)]);
    return new McodeExtensionState(storage,globalFile,workspaceFile,globalData,workspaceData);
  }
  snapshot():{globalState:PluginState;workspaceState:PluginState}{
    return {globalState:structuredClone(this.globalData),workspaceState:structuredClone(this.workspaceData)};
  }
  get(key:string,global:boolean):Record<string,unknown>|undefined{
    return structuredClone((global?this.globalData:this.workspaceData)[key]);
  }
  getAll(global:boolean):PluginState{
    return structuredClone(global?this.globalData:this.workspaceData);
  }
  async set(key:string,value:unknown,global:boolean):Promise<boolean>{
    if(!/^[a-z0-9._-]{1,225}$/i.test(key)||key==="__proto__")throw Error("非法扩展状态 key");
    if(!value||typeof value!=="object"||Array.isArray(value))throw Error("扩展状态不是对象");
    const serialized=JSON.stringify(value);
    if(!serialized||serialized.length>LIMIT)throw Error("扩展状态写入超过限制");
    const decoded=JSON.parse(serialized) as Record<string,unknown>;
    const target=global?this.globalData:this.workspaceData;
    const file=global?this.globalFile:this.workspaceFile;
    const work=async()=>{
      // Construct after earlier queued writes finish: concurrent extensions
      // must not persist an older snapshot over a newer state update.
      const next={...target,[key]:decoded};
      const json=JSON.stringify(next);
      if(json.length>LIMIT)throw Error("扩展状态文件超过总容量限制");
      await mkdir(this.storage,{recursive:true});
      const temp=file+"-"+randomUUID()+".tmp";
      try{await writeFile(temp,json,{flag:"wx"});await rename(temp,file);}
      finally{await rm(temp,{force:true});}
      target[key]=decoded;
    };
    this.writing=this.writing.then(work,work);
    await this.writing;
    return true;
  }
}
