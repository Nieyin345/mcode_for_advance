/** F033: one bounded native workspace watcher per active Theia host.
 * Theia already filters glob patterns on the EXT side. One root watcher is
 * cheaper than a watcher per extension pattern and is disposed with the host.
 */
import {watch,type FSWatcher} from "node:fs";
import {lstat} from "node:fs/promises";
import * as path from "node:path";
import {fileResource,type FileResource} from "./mcodeWorkspaceFs.js";
export type WorkspaceChanges={created:FileResource[];changed:FileResource[];deleted:FileResource[]};
export class McodeWorkspaceWatcher {
  private watcher:FSWatcher|undefined;
  private pending=new Map<string,"created"|"changed"|"deleted">();
  private timer:NodeJS.Timeout|undefined;
  constructor(private readonly root:string,private readonly emit:(events:WorkspaceChanges)=>void){}
  start():void{
    if(this.watcher)return;
    try {
      this.watcher=watch(this.root,{recursive:true,persistent:false},(event,name)=>{
        if(!name||this.pending.size>=128)return;
        const rel=String(name);
        if(path.isAbsolute(rel)||rel.split(/[\\/]/).some(c=>c===".."||[".git","node_modules",".tmp",".cache"].includes(c)))return;
        const full=path.resolve(this.root,rel);
        const relative=path.relative(this.root,full);
        if(relative.startsWith(".."+path.sep)||relative===".."||path.isAbsolute(relative))return;
        void lstat(full).then(st=>{
          if(st.isSymbolicLink()||st.isDirectory())return;
          this.enqueue(full,event==="rename"?"created":"changed");
        }).catch(err=>{if((err as NodeJS.ErrnoException).code==="ENOENT")this.enqueue(full,"deleted");});
      });
      this.watcher.on("error",()=>this.dispose());
    }catch{
      // No platform watcher support: be explicit about unsupported capability,
      // but do not block extension startup or fabricate a working watcher.
      this.dispose();
    }
  }
  private enqueue(full:string,kind:"created"|"changed"|"deleted"):void{
    if(!this.watcher)return;
    this.pending.set(full,kind);
    if(!this.timer){
      this.timer=setTimeout(()=>this.flush(),65);
      this.timer.unref?.();
    }
  }
  private flush():void{
    this.timer=undefined;
    if(!this.watcher)return;
    const result:WorkspaceChanges={created:[],changed:[],deleted:[]};
    for(const [file,kind] of this.pending)result[kind].push(fileResource(file));
    this.pending.clear();
    if(result.created.length||result.changed.length||result.deleted.length)
      this.emit(result);
  }
  dispose():void{
    if(this.timer)clearTimeout(this.timer);
    this.timer=undefined;this.pending.clear();
    this.watcher?.close();this.watcher=undefined;
  }
  get active():boolean{return Boolean(this.watcher);}
}
