import {classifyMarketRegistry,recheckMarketRegistryBeforeWrite} from "../../src/main/lib/marketRegistry.js";
let pass=0,fail=0;
function check(name:string,condition:boolean,detail?:unknown){console.log((condition?"PASS ":"FAIL ")+name+(condition?"":" "+JSON.stringify(detail)));condition?pass++:fail++;}
const parse=(v:unknown):string[]|null=>Array.isArray(v)?v.filter(x=>typeof x==="string") as string[]:null;
for(const [label,input] of [["null prototype",Object.create(null)],["wrong numeric SQLite storage",23],["wrong array storage",["prior"]],["undefined unexpected registry",undefined]] as const) {
  let result:unknown=null,threw=false;
  try {result=classifyMarketRegistry(input as never,parse,"MCP");}catch{threw=true;}
  check(label+" cannot escape shared corruption classifier",!threw,{threw,result});
  check(label+" must deny writes instead of pretending empty market",(result as {kind?:string}|null)?.kind==="corrupt"&&!recheckMarketRegistryBeforeWrite(result as never,"MCP").ok,result);
}
check("genuine missing registry still absent",classifyMarketRegistry(null,parse,"MCP").kind==="absent");
check("empty legacy setting still absent",classifyMarketRegistry("  ",parse,"MCP").kind==="absent");
const good=classifyMarketRegistry('["one",12,"two"]',parse,"MCP");
check("valid JSON rows retained with invalid record isolated",good.kind==="ok"&&JSON.stringify(good.records)==='["one","two"]',good);
const broken=classifyMarketRegistry('{"a":1}',parse,"MCP");
check("wrong JSON shape stays visibly corrupt",broken.kind==="corrupt",broken);
console.log(`market-registry-unknown-smoke: ${pass}/${pass+fail}`);if(fail)process.exitCode=1;
