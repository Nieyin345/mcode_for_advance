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

// ── 模型配置页(CustomModelsPanel)夹具 ──
// 一家 Claude 端点 + 一家 Pi + 一家 Codex,好让三种表单(各有 Base URL / API Key /
// Token / API Key 三个标签)都能被开出来。只需三张表单的静态标签,不需要真连通。
window.labModels = {
  claude: [{
    id:'a', name:'Claude 端点', baseUrl:'https://api.deepseek.com/anthropic', authMode:'auth_token', protocol:'anthropic',
    authTokenMasked:'sk-***ab12', models:[{id:'m1'}], disableNonEssentialTraffic:true, createdAt:1,
  }],
  pi: { deepseek: { name:'deepseek', baseUrl:'https://api.deepseek.com', api:'openai-completions', hasApiKey:true, models:[{id:'m1'}] } },
  codex: [{ id:'cx', name:'Codex 端点', baseUrl:'https://api.deepseek.com/v1', hasApiKey:true, models:[{id:'m1'}] }],
};
window.labApi.publicMcp = { status: async () => ({ enabled:false, port:0, secret:'', sessionId:null, tunnelUrl:null, tunnelPhase:'stopped', tunnelError:null, sandboxRoot:null, sandboxProjectId:null, availableProjects:[], tunnelMode:'quick', tunnelHostname:'', mobileHostname:'', tokenHint:'', fixedPort:0, mobilePort:0, agentDelegate:false, projectLinks:[] }) };
window.labApi.piModels = { list: async () => ({ providers: window.labModels.pi }), getApiKey: async () => ({ apiKey:'' }), save: async () => ({ providers: window.labModels.pi }), delete: async () => ({ providers: {} }) };
window.labApi.codexModels = { list: async () => ({ providers: window.labModels.codex }), getApiKey: async () => ({ apiKey:'' }), save: async () => ({ providers: window.labModels.codex }), delete: async () => ({ providers: [] }) };
window.labApi.customModel = { getToken: async () => ({ token:'' }), save: async () => ({ models: window.labModels.claude }), delete: async () => ({ models: [] }), test: async () => ({ ok:true }) };
window.labState.customModels = window.labModels.claude;
// 哨兵覆盖:`?sentinel=models` 时,把模型配置表单那三个标签键换成**醒目的替换文案** ——
// 只要源码走的是 `t(...)`,界面就会显示替换值;硬编码则显示原文。因为 zh/en 两份值都是
// 同样的专有名词("Base URL"),光切语言分辨不出"走了 key"还是"写死了字面量"。
window.labI18nOverride = new URLSearchParams(location.search).get('sentinel')==='models' ? {
  'settings.customModels.baseUrlLabel':'OVR::baseUrl',
  'settings.customModels.apiKeyLabel':'OVR::apiKey',
  'settings.customModels.authTokenLabel':'OVR::authToken',
} : null;

// ── 引擎工具页(EngineToolsPanel)夹具 ──
// 三引擎快照 + 记录 set 调用,用来验证「自定义工具名」输入框的 Enter 是否过 IME 守卫。
window.labEngineToolsEvents=[];
const engineState=(exclude,supported,known)=>({exclude,supported,known});
window.labEngineTools={engines:{claude:engineState([],true,['Bash','Read','Edit']),pi:engineState([],true,['read','edit']),codex:engineState([],false,[])}};
window.labApi.engineTools={
  get:async()=>structuredClone(window.labEngineTools),
  set:async(input)=>{window.labEngineToolsEvents.push(input);window.labEngineTools.engines[input.engine]={...window.labEngineTools.engines[input.engine],exclude:input.exclude};return {ok:true,snapshot:structuredClone(window.labEngineTools)};},
};

// ── 插件页(PluginsPanel)夹具 ──
window.labPluginEvents=[];
window.labPlugins=[];  // 空列表:已安装 pane 直接显示空态,安装表单仍可打开
window.labMarketplaces=[];
window.labApi.plugins={
  list:async()=>({plugins:window.labPlugins}),
  marketplaceList:async()=>({marketplaces:window.labMarketplaces}),
  installGit:async(input)=>{window.labPluginEvents.push({m:'installGit',input});return {ok:true};},
  marketplaceAdd:async(input)=>{window.labPluginEvents.push({m:'marketplaceAdd',input});return {ok:true};},
  marketplaceRefresh:async(input)=>{window.labPluginEvents.push({m:'marketplaceRefresh',input});return {ok:true};},
  marketplaceRemove:async(input)=>({ok:true}),
  installMarketplace:async(input)=>({ok:true}),
  installLocal:async(input)=>({ok:true}),
  setEnabled:async()=>({ok:true}),
  enginesSet:async()=>({ok:true}),
  remove:async()=>({ok:true}),
};
window.labApi.pickFolder=async()=>({path:null});


