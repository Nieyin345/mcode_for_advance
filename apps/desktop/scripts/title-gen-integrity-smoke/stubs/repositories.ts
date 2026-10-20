const values=new Map<string,string>();
let session: {id:string;kind:string;title:string}|null=null;
export const SettingRepo={
 get(key:string):string|null{
   if(process.env["MCODE_SMOKE_TITLE_SETTINGS_THROW"]==="1") throw new Error("fixture: title settings unreadable");
   return values.get(key)??null;
 },
 set(key:string,value:string){values.set(key,value);},
 __clear(){values.clear();},
};
export const SessionRepo={
 get(_id:string){return session;},
 updateTitle(_id:string,title:string){if(session)session.title=title;},
 __setSession(s:{id:string;kind:string;title:string}){session=s;},
};
