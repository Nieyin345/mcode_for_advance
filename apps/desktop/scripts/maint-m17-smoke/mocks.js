// In-page mock RPC only: no IPC, no network, no disk.
window.labDeleted=[];
window.labMemory={'global/facts/a.md':{content:'saved A',revision:'a-1'},'global/facts/b.md':{content:'saved B',revision:'b-1'}};
const labEntry=(path)=>({path,title:path.endsWith('a.md')?'Memory A':'Memory B',preview:'same fact',updatedAt:1700000000000,digest:'d-'+path});
window.labApi={
  context:{get:async()=>({content:''}),save:async()=>({ok:true})},
  memory:{
    manage:async()=>({projects:[]}),
    categories:async()=>['facts'],
    list:async()=>({files:Object.keys(labMemory).map(path=>({path,category:'facts',title:path.endsWith('a.md')?'Memory A':'Memory B',pinned:false}))}),
    read:async({path})=>labMemory[path],
    save:async({path,content,expectedRevision})=>{if(labMemory[path]?.revision!==expectedRevision)return {ok:false,code:'conflict'};const revision=String(Date.now());labMemory[path]={content,revision};return {ok:true,revision};},
    delete:async({path})=>{delete labMemory[path];return {ok:true};},
    review:async()=>{const paths=Object.keys(labMemory);return {totalFiles:paths.length,stale:[],staleTotal:0,staleTruncated:false,
      duplicates:paths.length>=2?[{a:labEntry(paths[0]),b:labEntry(paths[1])}]:[],duplicatePairTotal:paths.length>=2?1:0,
      scannedForDuplicates:paths.length,duplicateTruncated:false,pairTruncated:false,tooLong:[],unreadable:[]};},
    reviewDelete:async({path})=>{labDeleted.push(path);delete labMemory[path];return {ok:true};},
  },
};
