import {claudeToolSelectionOptions,applyToolBudget,type EngineToolSelection} from "../../src/main/orchestration/toolSelection.js";
let pass=0,fail=0;function ok(s:string,p:boolean,x?:unknown){console.log((p?"PASS ":"FAIL ")+s+(p?"":" "+JSON.stringify(x)));p?pass++:fail++;}
const selection={engine:"claude",profileName:"research",inventory:{tools:[{name:"mcp__team_ops__app_api_list",estimatedTokens:11},{name:"mcp__team_ops__getStatus",estimatedTokens:18}]},selected:["mcp__team_ops__app_api_list","mcp__team_ops__getStatus"],budgetNarrowed:false} as unknown as EngineToolSelection;
const picked=claudeToolSelectionOptions(selection,{allBuiltin:[],allServers:["team_ops","other-server"]});
ok("underscore MCP server with selected tools retained",picked.mcpServers.join(",")==="team_ops",picked.mcpServers);
ok("unselected MCP server still filtered",!picked.mcpServers.includes("other-server"),picked.mcpServers);
const floor=applyToolBudget(selection,{maxTools:0,maxTokens:0});
ok("underscore MCP app_api_list stays essential floor even with zero budget",floor.includes("mcp__team_ops__app_api_list"),floor);
const hyphen={...selection,selected:["mcp__team-ops__getStatus"]};
const hyphenPicked=claudeToolSelectionOptions(hyphen as never,{allBuiltin:[],allServers:["team-ops"]});
ok("previous hyphenated MCP server still retained",hyphenPicked.mcpServers.join(",")==="team-ops",hyphenPicked.mcpServers);
const full: EngineToolSelection={...selection,profileName:"full",budgetNarrowed:false};
const fullPicked=claudeToolSelectionOptions(full,{allBuiltin:[],allServers:["team_ops","other-server"]});
ok("full profile still retains all servers",fullPicked.mcpServers.length===2,fullPicked.mcpServers);
const refuses=(f:()=>unknown)=>{try{f();return false;}catch{return true;}};
for(const [label,budget] of [
 ["NaN tools limit",{maxTools:NaN}], ["fractional tools limit",{maxTools:1.5}],
 ["infinite token budget",{maxTokens:Infinity}], ["NaN token budget",{maxTokens:NaN}],
 ["negative token budget",{maxTokens:-1}]
] as const) {
 ok(label+" cannot turn a constrained profile into unbounded permissions",refuses(()=>applyToolBudget(selection,budget)),budget);
}
console.log(`claude-underscore-mcp-smoke: ${pass}/${pass+fail}`);if(fail)process.exitCode=1;
