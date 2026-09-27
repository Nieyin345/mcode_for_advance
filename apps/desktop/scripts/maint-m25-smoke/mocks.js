// In-page mock RPC only: no IPC, no network, no disk. Anything not listed
// resolves through a permissive proxy; `api.on.*` subscriptions return a real
// unsubscribe function (a Promise there would blow up React effect cleanup).
window.labCalls=[];
window.labUnhandled=[];
window.addEventListener('unhandledrejection',function(e){window.labUnhandled.push(String(e.reason&&e.reason.message?e.reason.message:e.reason));e.preventDefault();});
window.labMode={install:'ok',remove:'ok',installLocal:'ok',moveDataRoot:'ok',pickFolder:'ok'};
window.labPickPath='D:/picked-target';
window.confirm=function(){return true;};
const act=(name)=>{
  const m=window.labMode[name];
  if(m==='reject')return Promise.reject(new Error('mock-'+name+'-rejected'));
  if(m==='fail')return Promise.resolve({ok:false,error:'mock-'+name+'-failed'});
  return Promise.resolve({ok:true});
};
const subs={};
const labAny=(path)=>new Proxy(function(){},{
  get(_t,k){if(k==='then'||typeof k==='symbol')return undefined;return labAny(path+'.'+k);},
  apply(_t,_this,args){
    window.labCalls.push([path,args&&args[0]]);
    if(path.startsWith('api.on.'))return ()=>{};
    return Promise.resolve(undefined);
  },
});
const labExplicit={
  setting:{
    get:async(i)=>{window.labCalls.push(['setting.get',i]);return {value:null};},
    getMany:async(i)=>{window.labCalls.push(['setting.getMany',i]);return {values:{}};},
    set:async(i)=>{window.labCalls.push(['setting.set',i]);return undefined;},
  },
  runtimes:{
    list:async()=>({runtimes:window.labStore?window.labStore.getState().runtimes:[]}),
    install:async(i)=>{window.labCalls.push(['runtimes.install',i]);return act('install');},
    remove:async(i)=>{window.labCalls.push(['runtimes.remove',i]);return act('remove');},
    installLocal:async(i)=>{window.labCalls.push(['runtimes.installLocal',i]);return act('installLocal');},
  },
  toolchain:{
    check:async()=>({tools:[]}),
    install:async()=>({ok:true}),
    remove:async()=>({ok:true}),
  },
  app:{
    getDataRoot:async()=>({root:'D:/mcode-data',dbPath:'D:/mcode-data/mcode.db',libraryPath:'D:/mcode-data/library'}),
    moveDataRoot:async(i)=>{window.labCalls.push(['app.moveDataRoot',i]);return act('moveDataRoot');},
  },
  pickFolder:async()=>{
    window.labCalls.push(['pickFolder']);
    if(window.labMode.pickFolder==='reject')throw new Error('mock-pickFolder-rejected');
    return {path:window.labPickPath};
  },
  shell:{showItemInFolder:async()=>undefined},
  on:{
    runtimesEvent:(cb)=>{subs.runtimes=cb;return ()=>{if(subs.runtimes===cb)delete subs.runtimes;};},
    toolchainEvent:(cb)=>{subs.toolchain=cb;return ()=>{if(subs.toolchain===cb)delete subs.toolchain;};},
  },
};
window.labEmitRuntimes=(payload)=>{if(subs.runtimes)subs.runtimes({channel:'runtimes:event',payload});};
const labWrap=(obj,path)=>new Proxy(obj,{get(t,k){if(k==='then'||typeof k==='symbol')return undefined;if(k in t){const v=t[k];return (v&&typeof v==='object'&&!Array.isArray(v))?labWrap(v,path+'.'+k):v;}return labAny(path+'.'+k);}});
window.labApi=labWrap(labExplicit,'api');

