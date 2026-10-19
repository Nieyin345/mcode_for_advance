type Pending={prefs:{inAppToasts:boolean;mutedProjectIds:string[]}};
export const pending:Array<Promise<Pending>>=[];
export const resolves:Array<(value:Pending)=>void>=[];
export const api={notification:{getPrefs(){const p=new Promise<Pending>(r=>resolves.push(r));pending.push(p);return p;}}};
