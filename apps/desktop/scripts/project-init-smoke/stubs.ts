/** The real service and memory store operate only on the test's temp filesystem. */
export const settings = new Map<string, string>();
export const projects = new Map<string, {id:string;name:string;path:string}>();
export const sessions = new Map<string, {id:string;projectId:string;worktreePath?:string}>();
export const events: string[] = [];
let root = "";
export function setRoot(value:string) { root=value; settings.clear();projects.clear();sessions.clear();events.length=0; }
export function dataRoot(): string { if (!root) throw Error("Test root not set"); return root; }
export const SettingRepo = {
 get:(key:string)=>settings.get(key)??null,
 set:(key:string,value:string)=>{settings.set(key,value);},
 delete:(key:string)=>{settings.delete(key);},
 keysWithPrefix:(prefix:string)=>[...settings.keys()].filter(key=>key.startsWith(prefix)),
};
export const ProjectRepo={get:(id:string)=>projects.get(id)};
export const SessionRepo={get:(id:string)=>sessions.get(id)};
export function notifyMemoryChanged(reason:string) { events.push(reason); }
