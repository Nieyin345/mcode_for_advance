window.labEvents=[]; window.labCalls=[]; window.labPending=[];
window.labSettings={'runtime.turnBudget':JSON.stringify({enabled:true,maxTurns:10,maxUsd:5}),'runtime.fallbackModels':'["model-a"]'};
const listeners=new Set();
window.labSubscribe=fn=>{listeners.add(fn);return ()=>listeners.delete(fn)};
window.labPatch=patch=>{window.labState={...window.labState,...patch};listeners.forEach(fn=>fn());};
window.labState={activeProjectId:'A',projects:[{id:'A',name:'项目 A',path:'/A'},{id:'B',name:'项目 B',path:'/B'}],commandPaletteOpen:true,setCommandPaletteOpen:open=>window.labPatch({commandPaletteOpen:open}),shortcutOverrides:{}};
const blank=async()=>({sessions:[],entries:[],matches:[],items:[],results:[]});
window.labApi={setting:{get:async({key})=>{const result={value:window.labSettings[key]??null};if(window.labDelayGet===key)await new Promise(resolve=>window.labReleaseGet=resolve);return result;},set:async(args)=>{window.labCalls.push(args);if(window.labDelaySave)await new Promise(resolve=>window.labReleaseSave=resolve);if(window.labRejectSave)throw new Error('mock: 磁盘写入失败');window.labSettings[args.key]=args.value;}},file:{listDir:args=>{window.labCalls.push(args);if(window.labRejectFile)return Promise.reject(new Error('mock: 无权访问'));if(window.labDeferFile)return new Promise((resolve,reject)=>window.labPending.push({args,resolve,reject}));return Promise.resolve({entries:[{name:'src',path:args.projectPath+'/src',isDir:true}]});},search:blank,grep:blank},session:{search:blank,searchBookmarks:blank},bookmark:{search:blank},library:{list:blank,search:blank,fullTextSearch:blank,query:blank}};
window.addEventListener('unhandledrejection',e=>{window.labEvents.push('unhandled: '+e.reason);});

const mode=new URLSearchParams(location.search).get('case');window.labDeferFile=mode==='mobile-defer';window.labRejectFile=mode==='mobile-error';

window.labMemory={'global/facts/a.md':{content:'saved A',revision:'a-1'},'global/facts/b.md':{content:'saved B',revision:'b-1'}};
window.labApi.context={get:async()=>({content:''}),memoriesList:async()=>({dirs:[]})};
window.labApi.memory={manage:async()=>({projects:[]}),categories:async()=>['facts'],list:async()=>({files:Object.keys(labMemory).map(path=>({path,category:'facts',title:path.endsWith('a.md')?'Memory A':'Memory B',pinned:false}))}),read:async({path})=>labMemory[path],save:async({path,content,expectedRevision})=>{if(labDelayMemorySave)await new Promise(resolve=>window.labReleaseMemorySave=resolve);if(labMemory[path]?.revision!==expectedRevision)return {ok:false,code:'conflict'};const revision=String(Date.now());labMemory[path]={content,revision};return {ok:true,revision};}};
window.labDelayMemorySave=false;

Object.assign(window.labState,{planApprovalDraftBySession:{},providers:[],customModels:[],piAvailableModels:[],providerId:'mock',model:'mock',customModelId:null});
