// In-page mock RPC only: no IPC, no network, no disk. Anything not listed
// resolves to undefined through a permissive proxy (ChatPane touches many
// optional bridges on mount that are irrelevant here).
window.labCalls=[];
window.labRespondMode={};
const labAny=(path)=>new Proxy(function(){},{
  get(_t,k){if(k==='then'||typeof k==='symbol')return undefined;return labAny(path+'.'+k);},
  apply(){return Promise.resolve(undefined);},
});
const labExplicit={
  claude:{respondQuestion:(input)=>{labCalls.push(input);const m=labRespondMode[input.requestId];
    if(m==='fail-once'){delete labRespondMode[input.requestId];return Promise.reject(new Error('mock IPC failure'));}
    return new Promise(r=>setTimeout(()=>r(undefined),m==='slow'?400:20));}},
  file:{search:async()=>({files:[{name:'a.ts',path:'/proj/a.ts',relativePath:'a.ts'},{name:'b.ts',path:'/proj/b.ts',relativePath:'b.ts'}]})},
  library:{listCollections:async()=>({collections:[{id:'c1',name:'Alpha',parentId:null,groupId:null,itemCount:0,createdAt:0,updatedAt:0}]}),list:async()=>({items:[]})},
};
const labWrap=(obj,path)=>new Proxy(obj,{get(t,k){if(k==='then'||typeof k==='symbol')return undefined;if(k in t){const v=t[k];return (v&&typeof v==='object')?labWrap(v,path+'.'+k):v;}return labAny(path+'.'+k);}});
window.labApi=labWrap(labExplicit,'api');
