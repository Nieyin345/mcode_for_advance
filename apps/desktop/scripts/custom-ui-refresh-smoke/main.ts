import assert from 'node:assert/strict';
import { validateCustomUiWrite } from '@main/customUi/configValidation.js';
import { invokeAppTool } from '@main/appControl/tools.js';
import { clearRpcHandlers, recordRpcHandler } from '@main/appControl/registry.js';
import { useCustomUiStore as store } from '@renderer/stores/customUiStore.js';
import { CUSTOM_UI_SETTING_KEY as KEY, CustomUiConfigSchema } from '@contracts/customUi';
import { isMobileAccessibleSettingKey } from '@contracts/ipc/settingsSync';
import { state } from './stubs/api.js';
import { setSink } from './stubs/window.js';
import type { ProviderContext } from '@contracts/provider';
const config=(html:string)=>CustomUiConfigSchema.parse({version:1,items:[{id:'panel',slot:'rightPanel.tab',label:{zh:'测试',en:'test'},action:{type:'panel',html}}],layout:{}});
const before=config('<p>before</p>'),after=config('<p>after</p>');
const ctx=(allow:boolean)=>({requestApproval:async()=>({allow})}) as unknown as ProviderContext;
let events=0; const refreshes:Promise<void>[]=[];
setSink((_channel, payload:any)=>{events++;assert.equal(payload.event.key,KEY);assert.equal(payload.event.value,'');refreshes.push(store.getState().refresh());});
clearRpcHandlers();recordRpcHandler('setting:set',(_e,raw:any)=>{state.value=raw.value;});
const list = await invokeAppTool('app_api_list',{query:KEY},'test',ctx(false));
assert.ok(JSON.stringify(list).includes('setting.set'),'legacy UI config must be discoverable');
const describe = await invokeAppTool('app_api_describe',{method:'setting.set',setting_key:KEY},'test',ctx(false));
assert.ok(JSON.stringify(describe).includes('rightPanel.tab'),'describe includes actual UI JSON schema');
assert.throws(()=>validateCustomUiWrite('bad JSON'));
// 重复 id 与非法动作组合这两条理由**原样进 toast**(`customUiStore.save` 把 err.message 当 body),
// 所以判据钉在中文的那句话上 —— 从前这里钉的是英文单词 /Duplicate/、/not allowed/,改成中文
// 后它们就没用了,而且那正说明这些句子会漂到用户眼前。
assert.throws(()=>validateCustomUiWrite(JSON.stringify({...before,items:[before.items[0],before.items[0]]})),/id 相同/);
assert.throws(()=>validateCustomUiWrite(JSON.stringify({...before,items:[{...before.items[0],action:{type:'shell',command:'echo ok'}}]})),/不能挂在/);
assert.deepEqual(validateCustomUiWrite(JSON.stringify(before)),before);
assert.throws(()=>validateCustomUiWrite(JSON.stringify({...before,items:[{...before.items[0],slot:'toolbar',action:{type:'shell',command:'echo {{file.path}}'}}]})),/JSON stdin/);
state.value=JSON.stringify(before);await store.getState().load();
assert.deepEqual(store.getState().config,before);
store.setState({activeTab:'panel',panel:{id:'p-existing',item:before.items[0]!,target:{kind:'workspace',today:'2026-10-04'}}});
const write=()=>({method:'setting.set',input:{key:KEY,value:JSON.stringify(after)}});
const denied=await invokeAppTool('app_api_call',write(),'test',ctx(false));
assert.equal(denied.isError,true);assert.equal(events,0);assert.equal(state.value,JSON.stringify(before));
const result=await invokeAppTool('app_api_call',write(),'test',ctx(true));
assert.equal(result.isError,undefined);assert.equal(events,1,'approved external save must invalidate the desktop cache');
await Promise.all(refreshes);assert.deepEqual(store.getState().config,after);
assert.equal(store.getState().panel?.item.action.type,'panel');assert.notEqual(store.getState().panel?.id,'p-existing');assert.equal(store.getState().activeTab,'panel');
const alias = await invokeAppTool('app_api_call',{...write(),method:'setting:set'},'test',ctx(true));
assert.equal(alias.isError,undefined);assert.equal(events,2,'channel aliases must also invalidate');await Promise.all(refreshes);
assert.equal(isMobileAccessibleSettingKey(KEY),false,'desktop notification must not grant mobile access');
const panelId=store.getState().panel?.id;await store.getState().refresh();assert.equal(store.getState().panel?.id,panelId,'unchanged panels do not remount');
state.value='invalid json';await assert.rejects(store.getState().refresh());assert.deepEqual(store.getState().config,after,'malformed writes must not clear the live UI');
state.value=JSON.stringify({version:1,items:[],layout:{}});await store.getState().refresh();assert.equal(store.getState().activeTab,null);assert.equal(store.getState().panel,null);
let resolveRead!:(v:{value:string})=>void;
state.read=()=>new Promise(resolve=>{resolveRead=resolve;});const pending=store.getState().refresh();
await until(()=>typeof resolveRead==='function');
await store.getState().save(after);resolveRead({value:JSON.stringify(before)});await pending;assert.deepEqual(store.getState().config,after,'late refresh cannot overwrite local save');
state.read=null;
recordRpcHandler('setting:set',()=>{throw Error('persist failed');});const count=events;
const failed=await invokeAppTool('app_api_call',write(),'test',ctx(true));assert.equal(failed.isError,true);assert.equal(events,count,'failed writes do not notify');
let regressionFailures=0;
async function regression(name:string,run:()=>Promise<void>){try{await run();console.log('PASS '+name);}catch(error){regressionFailures++;console.error('FAIL '+name+': '+String(error));}}
async function until(fn:()=>boolean){const end=Date.now()+3000;while(!fn()&&Date.now()<end)await new Promise(r=>setTimeout(r,1));assert.ok(fn(),'fixture operation did not arrive');}
await regression('two failed overlapping saves restore persisted config, never a failed optimistic intermediate',async()=>{
  state.value=JSON.stringify(before);await store.getState().refresh();
  const rejects:Array<(error:Error)=>void>=[];
  state.write=()=>new Promise<void>((_resolve,reject)=>rejects.push(reject));
  const first=store.getState().save(after),second=store.getState().save(config('<p>last</p>'));
  await until(()=>rejects.length>=1);rejects[0]!(new Error('first failed'));
  await until(()=>rejects.length>=2);rejects[1]!(new Error('second failed'));
  assert.deepEqual(await Promise.all([first,second]),[false,false]);state.write=null;
  await new Promise(r=>setTimeout(r,10));assert.deepEqual(store.getState().config,before);
});
state.write=null;
await regression('successful local save updates the already open modal panel',async()=>{
  state.value=JSON.stringify(before);await store.getState().refresh();
  store.setState({panel:{id:'local-old',item:before.items[0]!,target:{kind:'workspace',today:'2026-10-05'}},activeTab:'panel'});
  assert.equal(await store.getState().save(after),true);
  assert.deepEqual(store.getState().panel?.item,after.items[0]);assert.notEqual(store.getState().panel?.id,'local-old');
});
await regression('local deletion closes the removed modal and active tab',async()=>{
  assert.equal(await store.getState().save(config('<p>again</p>')),true);
  assert.equal(await store.getState().save({version:1,items:[],layout:{}}),true);
  assert.equal(store.getState().panel,null);assert.equal(store.getState().activeTab,null);
});
await regression('repeated save of the same object: first failure cannot hide the later success',async()=>{
  state.value=JSON.stringify(before);await store.getState().refresh();
  const writes:Array<{ok:()=>void;bad:()=>void}>=[];
  state.write=(value)=>new Promise<void>((resolve,reject)=>writes.push({ok:()=>{state.value=value;resolve();},bad:()=>reject(new Error('first failed'))}));
  const first=store.getState().save(after),second=store.getState().save(after);
  await until(()=>writes.length===1);writes[0]!.bad();
  await until(()=>writes.length===2);writes[1]!.ok();
  assert.deepEqual(await Promise.all([first,second]),[false,true]);state.write=null;
  assert.equal(state.value,JSON.stringify(after));assert.deepEqual(store.getState().config,after);
});
state.write=null;
if(regressionFailures)process.exitCode=1;
clearRpcHandlers();setSink(null);if(!regressionFailures)console.log('Custom UI refresh: approval, live panel, invalid data, removal, read/write race, persistence failure and mobile boundary PASS');
