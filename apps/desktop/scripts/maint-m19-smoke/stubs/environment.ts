import type { RuntimeEvent } from '@contracts/runtime';
export const shown: Array<{title:string;body:string}> = [];
export const windowCalls: string[] = [];
export const pushed: unknown[] = [];
export const warnings: string[] = [];
export const windowState = { focused:false, minimized:false, destroyed:false, exists:true };
const win = {isFocused:()=>windowState.focused,isMinimized:()=>windowState.minimized,isDestroyed:()=>windowState.destroyed,
 restore:()=>windowCalls.push('restore'),show:()=>windowCalls.push('show'),focus:()=>windowCalls.push('focus')};
export function getMainWindow(){return windowState.exists?win:null;}
export function sendToRenderer(_channel:string, payload:unknown){pushed.push(payload);}
export class Notification {
 static supported=true;
 static lastClick:(()=>void)|undefined;
 static isSupported(){return Notification.supported;}
 constructor(private readonly options:{title:string;body:string;icon?:string;silent?:boolean}){}
 on(event:string,cb:()=>void){if(event==='click')Notification.lastClick=cb;return this;}
 show(){shown.push({title:this.options.title,body:this.options.body});}
}
const listeners=new Set<(e:RuntimeEvent)=>void>();
export const runtimeManager={subscribe:(fn:(e:RuntimeEvent)=>void)=>{listeners.add(fn);return ()=>listeners.delete(fn);},isTurnEndHeld:(_sessionId:string)=>false};
export function emit(e:RuntimeEvent){for(const fn of listeners)fn(e);}
export function listenerCount(){return listeners.size;}
export const SettingRepo={get:(_key:string):string|null=>null};
export const SessionRepo={get:(id:string)=>({title:id,kind:id.startsWith('node-')?'node':'chat'})};
export const log={info:(_m:string)=>{},error:(m:string)=>warnings.push(m),warn:(m:string)=>warnings.push(m)};
