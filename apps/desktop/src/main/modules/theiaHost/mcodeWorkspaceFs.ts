/** F032: native VS Code file: URI operations on the selected Mcode project.
 * This is a bounded project adapter, not a security sandbox: Node extensions
 * still have direct process filesystem access unless OS sandboxing is added.
 */
import * as path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import * as fs from "node:fs/promises";

export interface FileResource {scheme:string;path:string;authority?:string}
function fail(reason:string):never {throw Error("THEIA_WORKSPACE_FS: "+reason);}
export function fileResource(value:string):FileResource {
  const url=pathToFileURL(value);
  return {scheme:"file",path:decodeURIComponent(url.pathname),authority:""};
}
export class McodeWorkspaceFs {
  private constructor(readonly root:string){}
  static async open(root:string):Promise<McodeWorkspaceFs>{
    if(!path.isAbsolute(root))fail("未选择有效的 Mcode 工作区");
    const full=await fs.realpath(root);
    if(!(await fs.stat(full)).isDirectory())fail("工作区不是目录");
    return new McodeWorkspaceFs(full);
  }
  private within(file:string):boolean {
    const relative=path.relative(this.root,file);
    return relative===""||(!relative.startsWith(".."+path.sep)&&relative!==".."&&!path.isAbsolute(relative));
  }
  /** Check EVERY existing component, rather than only the final file.
   * This rejects symlink escapes; final writes still are not a sandbox/TOCTOU proof.
   */
  async resolve(uri:FileResource,create=false):Promise<string>{
    if(!uri||uri.scheme!=="file"||typeof uri.path!=="string"||
      (uri.authority&&uri.authority!=="localhost"))fail("仅支持本机 file URI");
    const u="file://"+(uri.authority??"")+encodeURI(uri.path);
    let absolute:string;
    try{absolute=path.resolve(fileURLToPath(new URL(u)));}
    catch{fail("非法文件 URI");}
    if(!this.within(absolute))fail("文件不属于当前 Mcode 工作区");
    const rel=path.relative(this.root,absolute);
    let cursor=this.root;
    for(const component of rel.split(path.sep).filter(Boolean)){
      cursor=path.join(cursor,component);
      try{
        const st=await fs.lstat(cursor);
        if(st.isSymbolicLink())fail("不允许访问符号链接路径");
      }catch(error){
        if(create&&(error as NodeJS.ErrnoException).code==="ENOENT")continue;
        throw error;
      }
    }
    return absolute;
  }
  async stat(uri:FileResource){
    const st=await fs.stat(await this.resolve(uri));
    return {type:st.isDirectory()?2:st.isFile()?1:0,ctime:st.birthtimeMs,mtime:st.mtimeMs,size:st.size};
  }
  async readdir(uri:FileResource):Promise<Array<[string,number]>>{
    const dir=await this.resolve(uri);
    const items=await fs.readdir(dir,{withFileTypes:true});
    if(items.length>5000)fail("目录文件数超过安全上限");
    return items.map(v=>[v.name,v.isDirectory()?2:v.isFile()?1:0]);
  }
  async readFile(uri:FileResource):Promise<Uint8Array>{
    const filename=await this.resolve(uri),stat=await fs.stat(filename);
    if(!stat.isFile()||stat.size>8*1024*1024)fail("只支持读取 8 MiB 以内的文件");
    return new Uint8Array(await fs.readFile(filename));
  }
  async writeFile(uri:FileResource,content:Uint8Array):Promise<void>{
    if(!(content instanceof Uint8Array)||content.length>8*1024*1024)fail("文件写入超过 8 MiB");
    const filename=await this.resolve(uri,true);
    await fs.writeFile(filename,content,{flag:"w"});
  }
  async mkdir(uri:FileResource):Promise<void>{await fs.mkdir(await this.resolve(uri,true),{recursive:true});}
  async rename(from:FileResource,to:FileResource,overwrite=false):Promise<void>{
    const src=await this.resolve(from),dst=await this.resolve(to,true);
    if(src===this.root||dst===this.root)fail("不可修改工作区根");
    if(!overwrite){
      try{await fs.lstat(dst);fail("目标已存在");}
      catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    }
    await fs.rename(src,dst);
  }
  async copy(from:FileResource,to:FileResource,overwrite=false):Promise<void>{
    const src=await this.resolve(from),dst=await this.resolve(to,true);
    if(src===this.root||dst===this.root)fail("不可复制覆盖工作区根");
    if((await fs.stat(src)).size>8*1024*1024)fail("复制文件超过 8 MiB");
    await fs.copyFile(src,dst,overwrite?0:1);
  }
  /** Bounded async workspace file search for VS Code workspace.findFiles.
   * Supports normal VS Code glob wildcards (*, ?, **); ignores heavy metadata dirs
   * and caps both traversed entries and returned matches to avoid UI stalls.
   */
  async findFiles(include:string,exclude?:string,maxResults=200,folder?:FileResource):Promise<FileResource[]>{
    if(!include||include.length>300||exclude&&exclude.length>300)fail("搜索规则无效");
    const toPattern=(glob:string):RegExp=>{
      const normal=glob.replace(/\\\\/g,"/");
      let out="^";
      for(let i=0;i<normal.length;i++){
        const c=normal[i];
        if(c==="*"&&normal[i+1]==="*"){
          i++;
          if(normal[i+1]==="/"){i++;out+="(?:.*/)?";}
          else out+=".*";
        }else if(c==="*")out+="[^/]*";
        else if(c==="?")out+="[^/]";
        else out+=c.replace(/[.*+?^$${}()|[\]\\]/g,"\\$&");
      }
      return new RegExp(out+"$","i");
    };
    const accepted=toPattern(include),rejected=exclude?toPattern(exclude):null;
    const limit=Math.min(500,Math.max(1,Math.floor(maxResults)));
    const results:FileResource[]=[];
    const queue=[folder?await this.resolve(folder):this.root];let visited=0;
    while(queue.length&&results.length<limit){
      const dir=queue.shift()!;
      const entries=await fs.readdir(dir,{withFileTypes:true});
      for(const item of entries){
        if(++visited>10000)fail("工作区搜索超过安全遍历上限");
        if(item.isSymbolicLink())continue;
        const absolute=path.join(dir,item.name);
        const relative=path.relative(this.root,absolute).split(path.sep).join("/");
        if(item.isDirectory()){
          if(![".git","node_modules",".tmp",".cache"].includes(item.name))queue.push(absolute);
          continue;
        }
        if(item.isFile()&&accepted.test(relative)&&!rejected?.test(relative)){
          results.push(fileResource(absolute));
          if(results.length>=limit)break;
        }
      }
    }
    return results;
  }
  async delete(uri:FileResource,recursive=false):Promise<void>{
    const file=await this.resolve(uri);
    if(file===this.root)fail("不可删除工作区根");
    if(recursive)fail("扩展递归删除暂不支持，请使用 Mcode 原生文件管理器");
    const stat=await fs.lstat(file);
    if(stat.isDirectory())await fs.rmdir(file);
    else await fs.unlink(file);
  }
}
