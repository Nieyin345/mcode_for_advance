/** Isolated E1 race only in mkdtemp fixture; no global Node fs patch. */
import { promises as real, writeFileSync, unlinkSync, linkSync } from "node:fs";
let armed: {path:string; kind:"overwrite"|"hardlink"; text?:string; outside?:string}|null = null;
let triggers=0;
export function armOverwrite(path:string,text:string){armed={path,kind:"overwrite",text};triggers=0;}
export function armHardlink(path:string,outside:string){armed={path,kind:"hardlink",outside};triggers=0;}
export function clear(){armed=null;}
export function hits(){return triggers;}
export async function readFile(...args: Parameters<typeof real.readFile>): ReturnType<typeof real.readFile> {
  const data=await real.readFile(...args);
  if(armed && String(args[0])===armed.path){
    const action=armed;armed=null;triggers++;
    if(action.kind==="overwrite")writeFileSync(action.path,action.text!,"utf8");
    else {unlinkSync(action.path);linkSync(action.outside!,action.path);}
  }
  return data;
}
export const writeFile = real.writeFile.bind(real);
export const unlink = real.unlink.bind(real);
export const mkdir = real.mkdir.bind(real);
export const lstat = real.lstat.bind(real);
