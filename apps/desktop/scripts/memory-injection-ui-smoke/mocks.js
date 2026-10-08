const query = new URLSearchParams(location.search), subscribers = new Set();
window.labSubscribe = fn => { subscribers.add(fn); return () => subscribers.delete(fn); };
window.labState = { locale: query.get('lang') || 'zh', sessionId: 'chat-A', activeProjectId: 'A', activeSessionId: 'chat-A',
  skills: [], providers: [], providerId: null, projects: [], customModels: [], customModelId: null,
  piAvailableModels: [], codexAvailableModels: [],
  sessionsByProject: { A: [{id:'chat-A',projectId:'A',kind:'chat',title:'Main A',archived:false}], B:[{id:'chat-B',projectId:'B',kind:'chat',title:'Main B',archived:false}] },
  openTab: async id => labPatchState({sessionId:id,activeSessionId:id}) };
window.labPatchState = patch => { window.labState = {...window.labState,...patch}; for(const fn of subscribers)fn(); };
window.labToasts=[];window.labCalls=[];window.labFailRead=query.has('fail');window.labHold=new Set();window.labHolds=[];window.labPicks=[];
const snapshot = text => '## 长期记忆\n范围：本项目 + 显式全局；选中 1/3 条；正文受长度预算限制。\n- 【Reference】 (projects/A/experiences/reference.md; revision='+'a'.repeat(64)+')\n'+text;
window.labReceipts = {
 'chat-A': [
  {id:'a-main',sessionId:'chat-A',projectId:'A',kind:'chat',title:'Main A',turnNumber:4,at:1790559600000,phase:'submitted',sections:[{source:'chat',state:'included',text:snapshot('CAPTURED_ORIGINAL_A <img src=x onerror=alert(1)>')}]},
  {id:'a-node',sessionId:'node-audit',projectId:'A',kind:'node',title:'Reference auditor',nodeId:'audit',nodeTitle:'Reference auditor',runId:'run-A',turnNumber:2,at:1790559599000,phase:'submitted',sections:[{source:'workflow',state:'off',text:''}]},
  {id:'a-failed',sessionId:'chat-A',projectId:'A',kind:'chat',title:'Failed attempt',turnNumber:3,at:1790559598000,phase:'start-failed',sections:[{source:'chat',state:'included',text:snapshot('NOT_CONFIRMED_SENT')}]},
 ],
 'chat-B': [{id:'b-main',sessionId:'chat-B',projectId:'B',kind:'chat',title:'Main B',turnNumber:1,at:1790559605000,phase:'submitted',sections:[{source:'chat',state:'empty',text:''}]}]
};
window.labFiles=[{path:'projects/A/experiences/reference.md',category:'experiences',scope:'project',projectId:'A',title:'Reference',updatedAt:1790559600000},{path:'global/preferences/default.md',category:'preferences',scope:'global',title:'Shared preference',updatedAt:1790559600000}];
window.labDisk={'projects/A/experiences/reference.md':'LATEST_DISK_CONTENT_DIFFERENT_FROM_CAPTURE','global/preferences/default.md':'User preference'};
window.labApi={
 memory:{
  assistant:async input=>{
   labCalls.push({method:'assistant',input:{...input}});
   if(input.op!=='list')return {jobs:[],injections:labReceipts[input.sessionId]||[]};
   const value=JSON.parse(JSON.stringify({jobs:[],injections:labReceipts[input.sessionId]||[]}));
   if(labHold.has(input.sessionId))await new Promise(resolve=>labHolds.push(resolve));
   if(labFailRead)throw Error('fixture memory inspection unavailable');return value;
  },
  manage:async()=>({ok:true,projects:[{id:'A',name:'Project A'},{id:'B',name:'Project B'}],sources:[],history:[]}),
  categories:async()=>['rules','project','preferences','experiences','failures','decisions'],
  list:async()=>({files:labFiles}),
  read:async({path})=>{labCalls.push({method:'memory-read',path});return {content:labDisk[path],revision:'a'.repeat(64)};},
  save:async input=>{labCalls.push({method:'memory-save',input});labDisk[input.path]=input.content;return {ok:true,revision:'b'.repeat(64)};},
 },
 context:{get:async()=>({content:'Global instructions'}),save:async()=>({ok:true,warnings:[]})},
 workflow:{agentProfiles:async()=>({profiles:[{id:'auditor',name:'Auditor',description:'Checks references',type:'mcode.agent',params:{instruction:'Audit references'}}],problems:[]})},
 on:{libraryChanged:()=>()=>{}},
};window.api=labApi;
