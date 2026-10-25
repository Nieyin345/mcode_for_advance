/** F034: VS Code terminal requests reuse the Mcode native PTY manager.
 * One terminal belongs to one installed extension session. This is NOT a
 * second workbench, an independent shell implementation, or an OS sandbox.
 */
import * as path from "node:path";
import type {TheiaNativeTerminalDriver} from "./host.js";
export interface McodeNativePtyOps {
  create(args:{projectPath:string;cwd:string;origin:{kind:"session";sessionId:string;title:string}}):Promise<
    {ok:true;terminalId:string;pid?:number}|{ok:false;error:string}
  >;
  write(id:string,data:string):boolean;
  kill(id:string):boolean;
}
export class McodeTheiaTerminalDriver implements TheiaNativeTerminalDriver {
  private readonly terminals=new Map<string,{id:string;pid?:number}>();
  private destroyed=false;
  constructor(private readonly sessionId:string,private readonly projectRoot:string,private readonly native:McodeNativePtyOps|undefined){}
  async create(id:string,opts:{name?:string;cwd?:string;shellPath?:string;shellArgs?:unknown;isPseudo?:boolean}):Promise<string>{
    if(this.destroyed)throw Error("扩展终端会话已关闭");
    if(opts.isPseudo)throw Error("暂不支持 VS Code Pseudoterminal，请使用 Mcode 原生 PTY");
    if(this.terminals.has(id)||this.terminals.size>=3)throw Error("扩展终端上限为三个");
    if(opts.shellPath||opts.shellArgs)throw Error("扩展不能直接覆盖 Mcode 用户终端所选 shell");
    let cwd=this.projectRoot;
    if(typeof opts.cwd==="string"&&opts.cwd){
      let candidate=opts.cwd;
      if(candidate.startsWith("file:")){
        const u=new URL(candidate);
        if(u.protocol!=="file:"||u.host&&u.host!=="localhost")throw Error("终端路径必须为本机目录");
        candidate=decodeURIComponent(u.pathname).replace(/^\/([A-Z]:)/i,"$1");
      }
      cwd=path.resolve(this.projectRoot,candidate);
      const rel=path.relative(this.projectRoot,cwd);
      if(rel===".."||rel.startsWith(".."+path.sep)||path.isAbsolute(rel))throw Error("扩展终端 cwd 不属于工作区");
    }
    const {realpath}=await import("node:fs/promises");
    const root=await realpath(this.projectRoot);
    const physical=await realpath(cwd);
    const realRel=path.relative(root,physical);
    if(realRel===".."||realRel.startsWith(".."+path.sep)||path.isAbsolute(realRel))
      throw Error("扩展终端 cwd 符号链接越过项目范围");
    if(!this.native)throw Error("Mcode 原生终端尚未初始化");
    const result=await this.native.create({projectPath:root,cwd:physical,
      origin:{kind:"session",sessionId:this.sessionId,title:"VS Code 扩展终端：Mcode"}});
    if(!result.ok)throw Error(result.error);
    if(this.destroyed){this.native.kill(result.terminalId);throw Error("扩展终端会话已关闭");}
    this.terminals.set(id,{id:result.terminalId,pid:result.pid});
    return id;
  }
  async sendText(id:string,text:string,execute=false):Promise<void>{
    const terminalId=this.terminals.get(id)?.id;
    if(!terminalId||this.destroyed)throw Error("扩展终端不存在");
    if(typeof text!=="string"||text.length>16384)throw Error("扩展终端输入超出限额");
    if(!this.native?.write(terminalId,text.replace(/\r?\n/g,"\r")+(execute&&!text.endsWith("\r")?"\r":"")))
      throw Error("Mcode 终端已退出");
  }
  async dispose(id:string):Promise<void>{
    const terminalId=this.terminals.get(id)?.id;
    if(!terminalId)return;
    this.terminals.delete(id);
    this.native?.kill(terminalId);
  }
  getProcessId(id:string):number|undefined{return this.terminals.get(id)?.pid;}
  async disposeAll():Promise<void>{
    this.destroyed=true;
    await Promise.allSettled([...this.terminals.keys()].map(id=>this.dispose(id)));
  }
}