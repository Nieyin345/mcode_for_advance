/** Real titleGen path with in-memory settings, safe fake SDK, fake webContents. */
import {generateSessionTitle} from "@main/ipc/titleGen.js";
import {parseModel} from "@main/lib/visionRelayCore.js";
import {SettingRepo,SessionRepo} from "@main/store/repositories.js";
const notifications = ((globalThis as unknown as {__titleNotifications?:unknown[]}).__titleNotifications ??= []);
import {UI_TITLE_GEN_ENABLED_SETTING_KEY, UI_TITLE_GEN_MODEL_SETTING_KEY} from "@contracts/ipc";
import type {Session} from "@contracts/session";
let pass=0,fail=0;
const check=(name:string,ok:boolean,actual?:unknown)=>{
 if(ok)pass++;else fail++;
 console.log(`${ok?"  ok  ":"  FAIL"} ${name}${ok?"":" "+JSON.stringify(actual)}`);
};
const session={id:"s_title_test",kind:"chat",title:"Untitled"} as Session;
(SessionRepo as unknown as {__setSession:(s:Session)=>void}).__setSession(session);
SettingRepo.set(UI_TITLE_GEN_ENABLED_SETTING_KEY,"on");
SettingRepo.set(UI_TITLE_GEN_MODEL_SETTING_KEY,"@claude:bogus");
const g=globalThis as unknown as {__visionDelivery?:{calls:number}};
if(g.__visionDelivery)g.__visionDelivery.calls=0;
let rejected=false;let out:string|null=null;
try{out=await generateSessionTitle(session,"hello title");}catch{rejected=true;}
check("不支持的 @claude alias 不能退到本机默认 Claude 去花钱",!rejected&&out===null&&(g.__visionDelivery?.calls??0)===0,{out,rejected,calls:g.__visionDelivery?.calls});
check("公共 parser 对未知 @claude 别名 fail-closed",parseModel("@claude:bogus")===null);
check("公共 parser 拒空 configId",parseModel(":model")===null);
check("公共 parser 拒空 role",parseModel("cfg-id:")===null);
check("合法 Claude 选择仍可解析",parseModel("@claude:haiku")?.builtin===true);
SettingRepo.set(UI_TITLE_GEN_MODEL_SETTING_KEY,"cfg-1:vision");
process.env.MCODE_SMOKE_RELEASE_THROW="1";
let cleanupReject=false;let title:string|null=null;
try{title=await generateSessionTitle(session,"valid prompt");}catch{cleanupReject=true;}
delete process.env.MCODE_SMOKE_RELEASE_THROW;
check("网关 bridge 关闭失败不会将已完成的标题转成 rejected promise",!cleanupReject&&title!==null,{cleanupReject,title});
check("标题确实保存到 session row",!!title&&session.title===title,{title,stored:session.title});
check("真 titleGen 发过不带工具的 SDK 请求", (g.__visionDelivery?.calls??0)>0 && notifications.length>0);
process.env.MCODE_SMOKE_TITLE_SETTINGS_THROW="1";
let settingsReject=false;let result:string|null=null;
try{result=await generateSessionTitle(session,"settings failure");}catch{settingsReject=true;}
delete process.env.MCODE_SMOKE_TITLE_SETTINGS_THROW;
check("标题设置读盘失败不应让 fire-and-forget 任务抛 reject",!settingsReject&&result===null,{settingsReject,result});

// SDK may stream an assistant error text BEFORE a final failed result.
// A failed generation must not persist the error string as a user's title.
const beforeTitle=session.title;
process.env.MCODE_SMOKE_VISION_MESSAGES=JSON.stringify([{type:"assistant",message:{content:[{type:"text",text:"API Error: 401 Unauthorized"}]}},{type:"result",is_error:true,subtype:"error_during_execution",result:"SDK failed authentication"}]);
let failedAsTitle=false;let failedTitleReturn:string|null=null;
try{failedTitleReturn=await generateSessionTitle(session,"test broken SDK");}
catch{failedAsTitle=true;}
delete process.env.MCODE_SMOKE_VISION_MESSAGES;
check("SDK result.is_error=true 必须阻止把错误 assistant 字段存为会话标题",
  !failedAsTitle&&failedTitleReturn===null&&session.title===beforeTitle,
  {failedAsTitle,failedTitleReturn,stored:session.title,beforeTitle});


// 长度是用户设置的硬上限（契约明确 10..100 字符），模型无视提示时宿主也得截断；
// 含非 BMP emoji 的标题不得按 UTF-16 半个代理项截断成损坏字符。
SettingRepo.set("ui.titleGenMaxLen","10");
process.env.MCODE_SMOKE_VISION_MESSAGES=JSON.stringify([
  {type:"assistant",message:{content:[{type:"text",text:"🙂".repeat(20)}]}},
  {type:"result",is_error:false,subtype:"success",result:"done"},
]);
let longTitle:string|null=null;
try{longTitle=await generateSessionTitle(session,"long title");}
finally{delete process.env.MCODE_SMOKE_VISION_MESSAGES;}
check("用户设置最长10字符时模型给20个 emoji 也只能存10个",
  longTitle!==null&&Array.from(longTitle).length===10,{longTitle,count:longTitle?Array.from(longTitle).length:null});
check("标题截断不得切断 Unicode surrogate pair，产生乱码",
  longTitle!==null&&!longTitle.includes("�")&&!/[\uD800-\uDFFF]/u.test(Array.from(longTitle).filter(ch=>ch.length===1).join("")),longTitle);


// A truncated/aborted SDK iterator may emit assistant text without ever
// reporting a terminal "result". Do not mistake the partial text for success.
const beforePartial=session.title;
process.env.MCODE_SMOKE_VISION_MESSAGES=JSON.stringify([
  {type:"assistant",message:{content:[{type:"text",text:"incomplete partial title"}]}},
]);
let partialTitle:string|null=null;
try{partialTitle=await generateSessionTitle(session,"missing SDK result");}
finally{delete process.env.MCODE_SMOKE_VISION_MESSAGES;}
check("SDK 只流了 assistant 没有终态 result 时不得写标题",
  partialTitle===null&&session.title===beforePartial,{partialTitle,stored:session.title,beforePartial});

console.log(`title-gen-integrity-smoke: ${pass}/${pass+fail}`);
if(fail)process.exitCode=1;
