/** 真生产 panelAsk + 隔离 SettingRepo/fake SDK: DB 错误不泄漏并发额度。 */
import { panelAsk } from "@main/customUi/panelAsk.js";
import { SettingRepo } from "@main/store/repositories.js";
let pass=0, fail=0;
function check(name: string, ok: boolean, actual?: unknown): void {
  if (ok) pass++; else fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : " — " + JSON.stringify(actual)}`);
}
const repo = SettingRepo as typeof SettingRepo & { get: (key: string) => string | null };
const originalGet = repo.get;
repo.get = () => {throw new Error("fixture: settings database unavailable");};
let thrown = 0, validShape = 0;
try {
  for(let i=0;i<4;i++){
    try {
      const result=await panelAsk({prompt:"hello"});
      if(!result.ok && /settings database unavailable/.test(result.error ?? "")) validShape++;
    }catch {thrown++;}
  }
} finally {
  repo.get = originalGet;
}
check("DB 读失败都按 panelAsk 的 ok:false 合同返回", validShape===4, {validShape,thrown});
check("DB 读失败不向 IPC 抛出未处理异常", thrown===0, thrown);
const after=await panelAsk({prompt:"hello",model:"@claude"});
check("连续四次设置读取失败后仍可调用模型（没有泄漏并发槽位）", after.ok, after);
check("正常调用返回 SDK 桩产生的真实文本", after.ok && (after.text?.includes("猫") ?? false), after);
const missing=await panelAsk({prompt:"hello",model:"notfound"});
check("不可用模型继续返回 ok:false 而非占满队列", !missing.ok, missing);
const afterBad=await panelAsk({prompt:"hello",model:"@claude:haiku"});
check("模型解析失败后后续正常请求可执行", afterBad.ok, afterBad);

// 网关模型已有正常文字结果，但 releaseBridge() 收尾可能因端口/文件竞争抛错。
// 这不能覆盖成功结果，更不能阻止 inFlight--，否则三次后面板永久拒绝请求。
process.env["MCODE_SMOKE_RELEASE_THROW"] = "1";
const cleanupResults: Array<Awaited<ReturnType<typeof panelAsk>> | null> = [];
let cleanupThrows = 0;
try {
  for (let i=0;i<4;i++) {
    try {cleanupResults.push(await panelAsk({prompt:"hi",model:"cfg-1:vision"}));}
    catch {cleanupThrows++;cleanupResults.push(null);}
  }
} finally {
  delete process.env["MCODE_SMOKE_RELEASE_THROW"];
}
check("网关 releaseBridge 抛错不应覆盖四个已有回答",
  cleanupThrows===0 && cleanupResults.every(r=>r?.ok===true),{cleanupThrows,results:cleanupResults});
check("清理失败后并发槽位仍应全部归还",
  (await panelAsk({prompt:"hi",model:"@claude"})).ok===true);

// 有效的设置存在，也不能把用户本轮明确挑选的未知 Claude 别名
// 默默替换成设置里的默认或当前账号的默认模型。
if (globalThis && typeof globalThis === "object") {
  const d = globalThis as unknown as {__visionDelivery?:{calls:number}};
  const before = d.__visionDelivery?.calls ?? 0;
  const bad = await panelAsk({prompt:"explicit invalid model",model:"@claude:invalid-alias"});
  check("显式无效的 @claude 别名必须返回错误，不能悄悄请求默认模型",
    bad.ok === false && /模型|别名|无效/.test(bad.error ?? ""),bad);
  check("无效模型选择不应启动 Claude SDK 查询",
    (d.__visionDelivery?.calls ?? 0) === before,d.__visionDelivery);
}


process.env.MCODE_SMOKE_VISION_MESSAGES=JSON.stringify([{type:"assistant",message:{content:[{type:"text",text:"API Error: 401 Unauthorized"}]}},{type:"result",is_error:true,subtype:"error_during_execution",result:"SDK failed authentication"}]);
let resultError:Awaited<ReturnType<typeof panelAsk>>|null=null;
try{resultError=await panelAsk({prompt:"fail in SDK",model:"@claude"});}
finally{delete process.env.MCODE_SMOKE_VISION_MESSAGES;}
check("SDK 尾随 result.is_error 即使前面有 text 也不能返回 ok:true",
  resultError?.ok===false,resultError);


process.env.MCODE_SMOKE_VISION_MESSAGES=JSON.stringify([
  {type:"assistant",message:{content:[{type:"text",text:"interrupted partial answer"}]}},
]);
let partialAnswer:Awaited<ReturnType<typeof panelAsk>>|null=null;
try{partialAnswer=await panelAsk({prompt:"missing result",model:"@claude"});}
finally{delete process.env.MCODE_SMOKE_VISION_MESSAGES;}
check("SDK 流提前结束没有终态 result 时 panelAsk 不可假报成功",
  partialAnswer?.ok===false,partialAnswer);

// Reviewer E1: external providers/plugins can reject with null-prototype
// objects; String(err) throws again and must not replace the expected result.
repo.get = () => {throw Object.create(null);};
let exoticDbThrown=0;
const exoticDbResults: Array<Awaited<ReturnType<typeof panelAsk>>|null>=[];
try {
  for(let i=0;i<4;i++){
    try {exoticDbResults.push(await panelAsk({prompt:"bad settings"}));}
    catch {exoticDbThrown++;exoticDbResults.push(null);}
  }
} finally {repo.get=originalGet;}
check("★ 4 次 null-prototype settings 异常均明确返回 ok:false",
  exoticDbThrown===0 && exoticDbResults.every(r=>r?.ok===false),{exoticDbThrown,exoticDbResults});
check("★ 恶意设置异常不永久占满 panelAsk 并发额度",
  (await panelAsk({prompt:"healthy",model:"@claude"})).ok===true);

process.env["MCODE_SMOKE_THROW_EXOTIC"]="1";
const sdkExoticResults: Array<Awaited<ReturnType<typeof panelAsk>>|null>=[];
let sdkExoticThrown=0;
try {
  for(let i=0;i<4;i++){
    try {sdkExoticResults.push(await panelAsk({prompt:"bad sdk",model:"@claude"}));}
    catch {sdkExoticThrown++;sdkExoticResults.push(null);}
  }
} finally {delete process.env["MCODE_SMOKE_THROW_EXOTIC"];}
check("★ SDK 恶意抛值四次均返回失败，而不是未处理 rejection",
  sdkExoticThrown===0 && sdkExoticResults.every(r=>r?.ok===false),{sdkExoticThrown,sdkExoticResults});
check("★ SDK 恶意异常后仍可再次使用 panelAsk",
  (await panelAsk({prompt:"healthy",model:"@claude"})).ok===true);

process.env["MCODE_SMOKE_RELEASE_EXOTIC"]="1";
const releaseExoticResults: Array<Awaited<ReturnType<typeof panelAsk>>|null>=[];
let releaseExoticThrown=0;
try {
  for(let i=0;i<4;i++){
    try {releaseExoticResults.push(await panelAsk({prompt:"healthy",model:"cfg-1:vision"}));}
    catch {releaseExoticThrown++;releaseExoticResults.push(null);}
  }
} finally {delete process.env["MCODE_SMOKE_RELEASE_EXOTIC"];}
check("★ bridge 恶意清理抛值不盖掉四次正常 panelAsk 回答",
  releaseExoticThrown===0 && releaseExoticResults.every(r=>r?.ok===true),
  {releaseExoticThrown,releaseExoticResults});
check("★ bridge 恶意清理抛值后仍可正常调用",
  (await panelAsk({prompt:"healthy",model:"@claude"})).ok===true);

console.log(`panel-ask-resilience-smoke: ${pass}/${pass+fail}`);
if(fail)process.exitCode=1;
