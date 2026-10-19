import { buildNodeInput } from "@main/orchestration/nodeInputBuilders.js";
import { bindingsOf } from "@main/orchestration/commandExecutor.js";
import { NODE_CODE_INPUT_KEY, NODE_CODE_LANGUAGE_KEY, NODE_CODE_PARAM_KEY, NODE_CODE_TIMEOUT_KEY } from "@contracts/nodeType";
import type { NodeTypeManifest } from "@contracts/nodeType";

let count=0, fail=0;
const check=(name:string,ok:boolean,details?:unknown)=>{count++;console.log((ok?"  ok ":"  FAIL ")+name+(ok?"":": "+JSON.stringify(details)));if(!ok)fail++};
const commandManifest = {id:"fixture.command",runner:{kind:"command",entry:"fake"},params:[
  {key:"options",bind:{kind:"stdin"}},
  {key:"__proto__",bind:{kind:"stdin"}},
  {key:"inherited",bind:{kind:"stdin"}},
]} as unknown as NodeTypeManifest;
const codeManifest = {id:"fixture.code",runner:{kind:"code"},params:[]} as unknown as NodeTypeManifest;
const scope={
  userPrompt:"",upstream:"",upstreamOutputs:{},upstreamArtifacts:[],nodeId:"fixture",
  plan:{steps:[]},root:false,terminal:true,contextLines:()=>[],
};
const signal=new AbortController().signal;
const inherited=Object.create({inherited:"not from workflow JSON"}) as Record<string,unknown>;
const inheritedBuilt=buildNodeInput(inherited,commandManifest,scope as never,signal);
check("★ inherited Object.prototype parameter cannot enter command binding",
  !Object.hasOwn(inheritedBuilt.command?.boundParams??{},"inherited"),inheritedBuilt.command?.boundParams);

const params=JSON.parse('{"options":{"nested":{"allowed":"before"}},"__proto__":{"role":"forged"}}') as {
  options:{nested:{allowed:string}}; "__proto__": {role:string}
};
const built=buildNodeInput(params as never,commandManifest,scope as never,signal);
params.options.nested.allowed="after";
check("★ bound script parameter is a detached snapshot from caller mutations",
  (built.command?.boundParams?.options as {nested:{allowed:string}}).nested.allowed==="before",
  built.command?.boundParams);
check("★ adversarial __proto__ parameter does not change boundParams prototype",
  !("role" in (built.command?.boundParams??{})) &&
  Object.getPrototypeOf(built.command?.boundParams??{})!==params["__proto__"],
  Object.getPrototypeOf(built.command?.boundParams??{}));
const forgedInput={...built,command:{...built.command,boundParams:Object.create({inherited:"forged"})}} as never;
const fromExecutor=bindingsOf(commandManifest,(forgedInput as {command:{boundParams:Record<string,unknown>}}).command.boundParams);
check("★ command executor independently refuses prototype-inherited binding values",
  !fromExecutor.some((b)=>b.value==="forged"),fromExecutor);

const inheritedData={nested:{payload:"before"}};
const codeParams:Record<string,unknown>={ [NODE_CODE_PARAM_KEY]:"print('test')", [NODE_CODE_INPUT_KEY]:"" };
const code=buildNodeInput(codeParams,codeManifest,{...scope,upstreamOutputs:{source:inheritedData}} as never,signal);
inheritedData.nested.payload="after";
check("★ inherited upstream data is snapshotted before asynchronous interpreter dispatch",
  ((code.code?.input as {upstreamOutputs:{source:{nested:{payload:string}}}}).upstreamOutputs.source.nested.payload)==="before",code.code?.input);

const trigger={event:"fake",nested:{payload:"before"}};
const triggered=buildNodeInput({[NODE_CODE_PARAM_KEY]:"print('test')"},codeManifest,{...scope,trigger} as never,signal);
trigger.nested.payload="after";
check("★ trigger facts are snapshotted before asynchronous node dispatch",
  ((triggered.data as unknown as {trigger:{nested:{payload:string}}}).trigger.nested.payload)==="before",
  (triggered.data as {trigger:unknown}).trigger);

// Timeout in the workflow JSON is untrusted. Infinity/NaN and numbers above
// Node's timer range can bypass the intended watchdog or fire immediately.
for (const timeout of [NaN, Infinity, -1, 1.25, 2_147_483_648]) {
  let denied=false;
  try {
    buildNodeInput({[NODE_CODE_PARAM_KEY]:"print('x')",[NODE_CODE_TIMEOUT_KEY]:timeout},
      codeManifest,scope as never,signal);
  } catch (err) { denied=err instanceof Error && /timeout|超时|毫秒/.test(err.message); }
  check("★ code timeout refuses unsafe or unsupported runtime value",denied,timeout);
}
for (const unset of [null,""]) {
  const codeUnset=buildNodeInput({[NODE_CODE_PARAM_KEY]:"print('x')",[NODE_CODE_TIMEOUT_KEY]:unset},
    codeManifest,scope as never,signal);
  check("★ blank optional code timeout retains unlimited default",codeUnset.code?.timeoutMs===0,unset);
}
const zeroCode=buildNodeInput({[NODE_CODE_PARAM_KEY]:"print('x')",[NODE_CODE_TIMEOUT_KEY]:0},
  codeManifest,scope as never,signal);
check("★ code timeout zero retains documented unlimited semantics",zeroCode.code?.timeoutMs===0,zeroCode.code);

// A broken extension or IPC input must not silently switch an explicitly
// requested interpreter to Python, nor silently discard a non-text stdin.
for (const language of ["ruby", "node ", 99, false]) {
  let denied=false;
  try { buildNodeInput({[NODE_CODE_PARAM_KEY]:"print('x')",[NODE_CODE_LANGUAGE_KEY]:language},
      codeManifest,scope as never,signal); }
  catch (err) { denied=err instanceof Error && /language|语言|解释器/.test(err.message); }
  check("★ unsupported explicit code language never silently falls back to Python",denied,language);
}
for (const rawInput of [{answer:42}, ["forged"], 1, true]) {
  let denied=false;
  try { buildNodeInput({[NODE_CODE_PARAM_KEY]:"print('x')",[NODE_CODE_INPUT_KEY]:rawInput},
      codeManifest,scope as never,signal); }
  catch (err) { denied=err instanceof Error && /input|输入|JSON/.test(err.message); }
  check("★ malformed non-text code input is rejected instead of silently replaced",denied,rawInput);
}
const defaultCode=buildNodeInput({[NODE_CODE_PARAM_KEY]:"print('x')"},
  codeManifest,scope as never,signal);
check("★ omitted code language still defaults to Python",defaultCode.code?.language==="python");
console.log(`node-input-boundary-smoke:${count-fail}/${count} 通过`);
if(fail)process.exitCode=1;
