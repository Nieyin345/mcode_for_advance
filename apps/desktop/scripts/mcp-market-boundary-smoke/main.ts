/** Registry metadata must never become unapproved executable flags or inherited JS values.
 * Pure fake metadata: does not fetch, save settings, or launch any process. */
import assert from "node:assert/strict";
import { registryServerToEntry, normalizeRegistryBase, searchMcpMarket, mcpMarketSourcesCorrupt, removeMcpMarketSource, MCP_MARKET_SOURCES_SETTING_KEY } from "@main/lib/mcpMarket.js";
import { SettingRepo } from "@main/store/repositories.js";
import { buildMcpMarketConfig, type McpMarketOption } from "@contracts/ipc/mcp.js";

let checks=0;
function check(name:string,fn:()=>void):void{
  fn();checks++;console.log("  ok   "+name);
}
const fixture=(packages:unknown[])=>registryServerToEntry({server:{name:"fixture/install",
   packages}})!;
const pkg=(registryType:string,identifier:string)=>({
 registryType,identifier,version:"1.2.3",transport:{type:"stdio"}
});
check("npm option parser refuses a leading-flag package name",()=>{
 assert.equal(fixture([pkg("npm","--unapproved-option")]).options.length,0);
});
check("OCI runner does not accept a leading-flag image identifier",()=>{
 assert.equal(fixture([pkg("oci","--unexpected-option")]).options.length,0);
});
check("PyPI and NuGet identifiers also reject command flags",()=>{
 for(const type of ["pypi","nuget"]){
   assert.equal(fixture([pkg(type,"-unsafe")]).options.length,0);
 }
});
check("normal unscoped/scoped npm packages retain their generated commands",()=>{
 const result=fixture([pkg("npm","normal-package"),pkg("npm","@fixture/normal-package")]);
 assert.equal(result.options.length,2);
 for(const option of result.options){
   assert.equal(option.command,"npx");
   assert.ok(option.args?.some(a=>"value" in a&&a.value.includes("normal-package")));
 }
});
check("normal OCI/PyPI/NuGet package identifiers remain usable",()=>{
 const result=fixture([pkg("oci","example.test:5000/team/image"),
    pkg("pypi","normal_py_package"),pkg("nuget","Normal.Library")]);
 assert.equal(result.options.length,3);
 assert.deepEqual(result.options.map(o=>o.command),["docker","uvx","dnx"]);
});
check("remote registry environment names must not include JS prototype keys",()=>{
 const result=fixture([{
  ...pkg("npm","normal-package"),
  environmentVariables:[
    {name:"__proto__",isRequired:true},
    {name:"constructor",isRequired:true},
    {name:"toString",isRequired:true},
    {name:"NORMAL_TOKEN",isRequired:true}
  ]
 }]);
 assert.deepEqual(result.options[0].inputs.map(i=>i.name),["NORMAL_TOKEN"]);
});
check("pure config builder ignores object inherited properties",()=>{
 const option:McpMarketOption={id:"test",kind:"stdio",label:"fixture",command:"npx",
  inputs:[{key:"toString",kind:"arg",name:"",required:true,secret:false}]};
 const result=buildMcpMarketConfig(option,{});
 assert.deepEqual(result.missing,["toString"]);
 assert.equal(result.config,undefined);
});
check("pure config builder rejects invalid value types without TypeError",()=>{
 const option:McpMarketOption={id:"test",kind:"stdio",label:"fixture",command:"npx",
  inputs:[{key:"token",kind:"env",name:"NORMAL_TOKEN",required:true,secret:true}]};
 const result=buildMcpMarketConfig(option, {token:42} as unknown as Record<string,string>);
 assert.deepEqual(result.missing,["token"]);
});
check("pure installer refuses to carry prototype env keys to a different SDK",()=>{
 const option:McpMarketOption={id:"test",kind:"stdio",label:"fixture",command:"npx",
   inputs:[{key:"danger",kind:"env",name:"__proto__",required:false,secret:true}]};
 const result=buildMcpMarketConfig(option,{danger:"value"});
 assert.equal(result.config,undefined);
 assert.deepEqual(result.missing,["danger"]);
});
check("pure installer rejects control characters in remote header names",()=>{
 const option:McpMarketOption={id:"test",kind:"http",label:"fixture",url:"https://example.test/api",
   inputs:[{key:"header",kind:"header",name:"Injected\nHeader",required:true,secret:true}]};
 const result=buildMcpMarketConfig(option,{header:"value"});
 assert.equal(result.config,undefined);
 assert.deepEqual(result.missing,["header"]);
});
check("normal env and remote header names still produce plain config objects",()=>{
 const stdio:McpMarketOption={id:"n",kind:"stdio",label:"normal",command:"npx",
   inputs:[{key:"env:TOKEN",kind:"env",name:"TOKEN",required:true,secret:true}]};
 assert.deepEqual(buildMcpMarketConfig(stdio,{"env:TOKEN":" value "}).config,
   {command:"npx",env:{TOKEN:"value"}});
 const remote:McpMarketOption={id:"h",kind:"http",label:"normal",url:"https://example.test/api",
   inputs:[{key:"header:Accept",kind:"header",name:"Accept",required:true,secret:false}]};
 assert.deepEqual(buildMcpMarketConfig(remote,{"header:Accept":" application/json "}).config,
   {type:"http",url:"https://example.test/api",headers:{Accept:"application/json"}});
});
check("Docker MCP optional env must not inherit host process values implicitly",()=>{
 const result=fixture([{
  ...pkg("oci","example.test/team/image"),
  environmentVariables:[{name:"FIXTURE_OPTIONAL_TOKEN",isRequired:false,isSecret:true}]
 }]);
 const option=result.options[0];
 assert.ok(option,"fixture must expose a Docker install option");
 const config=buildMcpMarketConfig(option,{});
 assert.deepEqual(config.missing,[]);
 assert.ok(config.config&&"args" in config.config);
 const args=(config.config as {args?:string[]}).args??[];
 assert.ok(!args.includes("FIXTURE_OPTIONAL_TOKEN"),
  "Docker -e NAME forwards an inherited host env value even if user provided no value");
});
check("Docker MCP explicitly provided env passes by name, not by argv secret",()=>{
 const result=fixture([{
  ...pkg("oci","example.test/team/image"),
  environmentVariables:[{name:"FIXTURE_OPTIONAL_TOKEN",isRequired:false,isSecret:true}]
 }]);
 const config=buildMcpMarketConfig(result.options[0],{"env:FIXTURE_OPTIONAL_TOKEN":"fixture-consented"});
 assert.ok(config.config&&"env" in config.config);
 const c=config.config as {env?:Record<string,string>;args?:string[]};
 assert.deepEqual(c.env,{FIXTURE_OPTIONAL_TOKEN:"fixture-consented"});
 assert.equal(c.args?.filter(s=>s==="FIXTURE_OPTIONAL_TOKEN").length,1);
 assert.ok(c.args?.includes("-e"));
 assert.ok(!c.args?.includes("fixture-consented"),"secret value must stay out of process argv");
});
check("Registry version cannot contain control characters or flag-like metadata",()=>{
 const malicious=fixture([{
  ...pkg("npm","normal-package"),version:"1.0.0\n--unintended"
 },{...pkg("oci","example.test/image"),version:"--unintended"}]);
 assert.equal(malicious.options.length,0);
});
check("Registry normal npm/OCI pinned version remains compatible",()=>{
 const normal=fixture([pkg("npm","normal-package"),pkg("oci","example.test/image")]);
 assert.equal(normal.options.length,2);
});
check("normal registry sources cannot silently discard URL userinfo",()=>{
 assert.equal(normalizeRegistryBase("https://user:pass@registry.example/v0"),null);
 assert.equal(normalizeRegistryBase("https://registry.example/v0.1/servers"),"https://registry.example");
});
async function checkNetwork(name:string, fake:typeof fetch, assertion:()=>Promise<void>):Promise<void>{
 const original=globalThis.fetch;
 globalThis.fetch=fake;
 try{
   await assertion();
   checks++;
   console.log("  ok   "+name);
 }finally{globalThis.fetch=original;}
}
await checkNetwork("normal official Registry JSON remains searchable",async (_input,init)=>{
 assert.equal(init?.redirect,"manual");
 return new Response(JSON.stringify({servers:[{server:{name:"fixture/normal"}}]}),
   {status:200,headers:{"content-type":"application/json"}});
},async ()=>{
 const result=await searchMcpMarket({source:"official",query:"normal"});
 assert.equal(result.ok,true);
 assert.deepEqual(result.entries.map(e=>e.id),["fixture/normal"]);
});
let crossRequests=0;
await checkNetwork("a Registry redirect to another origin is refused without a second request",
  async ()=>{
   crossRequests++;
   return new Response(null,{status:302,
     headers:{location:"https://different-registry.example/v0.1/servers"}});
  },async ()=>{
   const result=await searchMcpMarket({source:"official"});
   assert.equal(result.ok,false);
   assert.equal(crossRequests,1);
   assert.match(result.error??"",/重定向|来源/);
  });
let sameRequests=0;
await checkNetwork("a bounded same-origin redirect remains compatible with registries",
  async ()=>{
   sameRequests++;
   if(sameRequests===1){
     return new Response(null,{status:302,
       headers:{location:"/v0.1/servers?redirected=1"}});
   }
   return new Response(JSON.stringify({servers:[]}),{status:200});
  },async ()=>{
   const result=await searchMcpMarket({source:"official"});
   assert.equal(result.ok,true);
   assert.equal(sameRequests,2);
  });
await checkNetwork("registry rejects a dishonest oversized Content-Length",
  async ()=>new Response(JSON.stringify({servers:[]}),{status:200,
    headers:{"content-length":String(3*1024*1024)}}),
  async ()=>{
   const result=await searchMcpMarket({source:"official"});
   assert.equal(result.ok,false);
   assert.match(result.error??"",/响应过大|预算/);
  });
await checkNetwork("registry rejects oversized actual stream even without Content-Length",
  async ()=>new Response(JSON.stringify({servers:[],padding:"x".repeat(2*1024*1024+10)}),
     {status:200}),
  async ()=>{
   const result=await searchMcpMarket({source:"official"});
   assert.equal(result.ok,false);
   assert.match(result.error??"",/响应过大|预算/);
  });
check("MCP source list with a malformed record cannot be rewritten as a smaller list",()=>{
 const before=JSON.stringify([
  {id:"custom-valid",url:"https://valid.example.com",label:"Valid"},
  {id:"custom-incomplete",label:"Preserve unparsed record"}
 ]);
 SettingRepo.set(MCP_MARKET_SOURCES_SETTING_KEY,before);
 const diagnosis=mcpMarketSourcesCorrupt();
 assert.ok(diagnosis,"partial corruption must be visible rather than silently dropped");
 const removed=removeMcpMarketSource("custom-valid");
 assert.equal(removed.ok,false);
 assert.equal(SettingRepo.get(MCP_MARKET_SOURCES_SETTING_KEY),before);
});
check("malformed Registry runner names never inherit JS object builtins",()=>{
 const items=fixture([
   pkg("__proto__","normal-package"),
   pkg("constructor","normal-package"),
   pkg("npm","normal-package")
 ]);
 assert.equal(items.options.length,1,"only registered npm/pypi/oci/nuget runtimes are installable");
 assert.equal(items.options[0].command,"npx");
});
check("MCP saved sources reject duplicate ids without touching original settings",()=>{
 const original=JSON.stringify([
  {id:"custom-repeated",label:"A",url:"https://a.example.test"},
  {id:"custom-repeated",label:"B",url:"https://b.example.test"}
 ]);
 SettingRepo.set(MCP_MARKET_SOURCES_SETTING_KEY,original);
 assert.ok(mcpMarketSourcesCorrupt(),"duplicate source identity should be a visible diagnostic");
 const removed=removeMcpMarketSource("custom-repeated");
 assert.equal(removed.ok,false);
 assert.equal(SettingRepo.get(MCP_MARKET_SOURCES_SETTING_KEY),original);
});
check("MCP saved sources reject duplicate URLs and built-in id collisions",()=>{
 for(const saved of [
  [
    {id:"custom-a",label:"A",url:"https://a.example.test"},
    {id:"custom-b",label:"B",url:"https://A.Example.Test/"}
  ],
  [{id:"official",label:"Shadow",url:"https://shadow.example.test"}]
 ]){
  const original=JSON.stringify(saved);
  SettingRepo.set(MCP_MARKET_SOURCES_SETTING_KEY,original);
  assert.ok(mcpMarketSourcesCorrupt());
  assert.equal(SettingRepo.get(MCP_MARKET_SOURCES_SETTING_KEY),original);
 }
});
check("MCP saved source list still accepts distinct clean sources",()=>{
 SettingRepo.set(MCP_MARKET_SOURCES_SETTING_KEY,JSON.stringify([
  {id:"custom-a",label:"A",url:"https://a.example.test"},
  {id:"custom-b",label:"B",url:"https://b.example.test"}
 ]));
 assert.equal(mcpMarketSourcesCorrupt(),null);
 const removed=removeMcpMarketSource("custom-a");
 assert.equal(removed.ok,true);
 assert.equal(JSON.parse(SettingRepo.get(MCP_MARKET_SOURCES_SETTING_KEY)!).length,1);
});
check("header value cannot carry embedded control characters into an MCP SDK",()=>{
 const opt:McpMarketOption={id:"remote",kind:"http",label:"Remote",url:"https://service.example/api",
   inputs:[{key:"header:Authorization",kind:"header",name:"Authorization",required:true,secret:true}]};
 const output=buildMcpMarketConfig(opt,{"header:Authorization":"prefix\r\nInjected: value"});
 assert.equal(output.config,undefined);
 assert.deepEqual(output.missing,["header:Authorization"]);
});
check("stale remote install options cannot retain URL userinfo or a non-network scheme",()=>{
 for (const address of ["https://user:secret@service.example/api","file:///etc/config","https://service.example/api#section"]){
  const option:McpMarketOption={id:"remote",kind:"http",label:"Remote",url:address,inputs:[]};
  const result=buildMcpMarketConfig(option,{});
  assert.equal(result.config,undefined,"invalid remote endpoint must not be persisted");
 }
 const good:McpMarketOption={id:"remote",kind:"http",label:"Remote",url:"https://service.example/api?key=value",inputs:[]};
 assert.deepEqual(buildMcpMarketConfig(good,{}).config,{type:"http",url:"https://service.example/api?key=value"});
});
console.log("mcp-market-boundary-smoke:"+checks+"/"+checks);
