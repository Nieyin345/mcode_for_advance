/** Lightweight same-process terminal binding.
 * TerminalManager remains the only PTY owner, initialized by its existing IPC.
 * The Theia adapter never imports node-pty/Electron or starts another PTY host.
 */
import type {McodeNativePtyOps} from "./mcodeTerminalDriver.js";
let operations:McodeNativePtyOps|undefined;
export function registerTheiaNativePtyOps(native:McodeNativePtyOps):()=>void{
  operations=native;
  return ()=>{if(operations===native)operations=undefined;};
}
export function currentTheiaNativePtyOps():McodeNativePtyOps|undefined{return operations;}
