import assert from 'node:assert/strict';
import type { SubagentSnapshot, RuntimeEvent } from '@contracts/runtime';
import { DEFAULT_NOTIFICATION_PREFS } from '@contracts/ipc';
import { notificationManager } from '../../src/main/notifications/NotificationManager.js';
import { emit, shown, windowState, Notification, windowCalls, pushed, listenerCount } from './stubs/environment.js';
import { MonitoringCollector, startMonitoringCollector } from '../../src/main/monitoring/collector.js';
import { readRunSummaries } from '../../src/main/monitoring/store.js';
import { mobileEventBus } from '../../src/main/mobile/MobileEventBus.js';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
const root=process.env.MAINT_M19_DIR;
assert.ok(root,'Isolated fixture directory required');
const results:Array<{name:string;status:string;error?:string}>=[];
function test(name:string,fn:()=>void){
 shown.length=0;Object.assign(windowState,{focused:false,minimized:false,destroyed:false,exists:true});
 notificationManager.setPrefs({...DEFAULT_NOTIFICATION_PREFS,osEnabled:true,backgroundTasks:true});
 try{fn();results.push({name,status:'PASS'});console.log('PASS '+name);}catch(e){results.push({name,status:'FAIL',error:String(e)});console.error('FAIL '+name+' '+String(e));}
}
const roster=(sessionId:string, agents:Array<[string,SubagentSnapshot['status']]>):void=>emit({type:'subagent.update',sessionId,agents:agents.map(([taskId,status])=>({taskId,status,description:taskId,isBackgrounded:true}))});
notificationManager.start();
test('start is idempotent and uses one real manager subscription',()=>{notificationManager.start();assert.equal(listenerCount(),1);});
test('duplicate batch completion produces one notification, not one per replay',()=>{
 roster('batch',[['a','running'],['b','running']]);
 roster('batch',[['a','completed'],['b','failed']]);assert.equal(shown.length,1);
 roster('batch',[['a','completed'],['b','failed']]);assert.equal(shown.length,1);
});
test('trailing new running task is recorded after an earlier completion',()=>{
 roster('trailing',[['a','running']]);roster('trailing',[['a','completed'],['b','running']]);assert.equal(shown.length,1);
 roster('trailing',[['a','completed'],['b','completed']]);assert.equal(shown.length,2);
});
test('running in foreground then completion in background notifies',()=>{
 windowState.focused=true;roster('focus-start',[['a','running']]);assert.equal(shown.length,0);
 windowState.focused=false;roster('focus-start',[['a','completed']]);assert.equal(shown.length,1);
});
test('completion already observed in foreground is not replayed on blur',()=>{
 roster('focus-end',[['a','running']]);windowState.focused=true;roster('focus-end',[['a','completed']]);assert.equal(shown.length,0);
 windowState.focused=false;roster('focus-end',[['a','completed']]);assert.equal(shown.length,0);
});
test('full empty roster clears stale running state',()=>{
 roster('cleared',[['a','running']]);roster('cleared',[]);roster('cleared',[['a','completed']]);assert.equal(shown.length,0);
});
test('full replacement roster does not retain absent tasks',()=>{
 roster('replaced',[['old','running']]);roster('replaced',[['new','running']]);roster('replaced',[['old','completed'],['new','running']]);assert.equal(shown.length,0);
});
test('disabled preference tracks complete roster without replay after reenable',()=>{
 roster('prefs',[['a','running'],['b','running']]);notificationManager.setPrefs({...notificationManager.getPrefs(),backgroundTasks:false});
 roster('prefs',[['a','completed'],['b','completed']]);assert.equal(shown.length,0);
 notificationManager.setPrefs({...notificationManager.getPrefs(),backgroundTasks:true});roster('prefs',[['a','completed'],['b','completed']]);assert.equal(shown.length,0);
});
test('session rosters are isolated and initial terminal snapshot does not notify',()=>{
 roster('isolate-a',[['same','running']]);roster('isolate-b',[['same','completed']]);assert.equal(shown.length,0);
 roster('isolate-a',[['same','failed']]);assert.equal(shown.length,1);
});
test('killed tasks and hidden node sessions do not generate completion notifications',()=>{
 roster('kill',[['a','running']]);roster('kill',[['a','killed']]);
 roster('node-hidden',[['b','running']]);roster('node-hidden',[['b','completed']]);assert.equal(shown.length,0);
});
test('master disable suppresses notifications without losing transitions',()=>{
 roster('master',[['a','running']]);notificationManager.setPrefs({...notificationManager.getPrefs(),osEnabled:false});
 roster('master',[['a','completed']]);assert.equal(shown.length,0);
 notificationManager.setPrefs({...notificationManager.getPrefs(),osEnabled:true});roster('master',[['a','completed']]);assert.equal(shown.length,0);
});
test('minimized window notification click restores then focuses correct session',()=>{
 windowState.minimized=true;windowCalls.length=0;pushed.length=0;
 roster('click',[['a','running']]);roster('click',[['a','completed']]);assert.equal(shown.length,1);
 Notification.lastClick!();assert.deepEqual(windowCalls,['restore','show','focus']);assert.equal((pushed[0] as {sessionId:string}).sessionId,'click');
});
test('no live window never displays an OS notification',()=>{
 windowState.exists=false;roster('none',[['a','running']]);roster('none',[['a','completed']]);assert.equal(shown.length,0);
});
const event=(e:object)=>e as RuntimeEvent;
test('monitoring duplicate done is idempotent and resume can reuse the same run ID',()=>{
 const c=new MonitoringCollector({root:()=>join(root,'collector')});
 const result=event({type:'workflow.node.result',sessionId:'s',runId:'r',nodeId:'n',nodeType:'agent',status:'success',summary:'ok'});
 const done=event({type:'turn.done',sessionId:'s',reason:'end_turn',endedAt:Date.now()});
 c.handle(result);c.handle(done);c.handle(done);assert.equal(readRunSummaries(join(root,'collector')).length,1);
 c.handle(event({...result,status:'failed',error:'resume failure'}));c.handle(done);
 const rows=readRunSummaries(join(root,'collector'));assert.equal(rows.length,1);assert.equal(rows[0].status,'failed');
});
test('monitoring unsubscribe and resubscribe do not duplicate subscriptions',()=>{
 const before=mobileEventBus.size;const stop=startMonitoringCollector({root:()=>join(root,'bus')});assert.equal(mobileEventBus.size,before+1);
 stop();stop();assert.equal(mobileEventBus.size,before);
 const again=startMonitoringCollector({root:()=>join(root,'bus')});assert.equal(mobileEventBus.size,before+1);again();assert.equal(mobileEventBus.size,before);
});
writeFileSync(join(root,'checks.json'),JSON.stringify(results,null,2));
console.log(`${results.filter(r=>r.status==='PASS').length} passed; ${results.filter(r=>r.status==='FAIL').length} failed`);
process.exitCode=results.some(r=>r.status==='FAIL')?1:0;
