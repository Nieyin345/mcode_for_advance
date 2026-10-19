import { requestTerminalRun, subscribeTerminalRunRequests } from "../../src/renderer/lib/terminalRunBus.js";
let pass=0,fail=0;
function eq(name:string,a:unknown,b:unknown){const ok=JSON.stringify(a)===JSON.stringify(b);console.log((ok?"PASS ":"FAIL ")+name+(ok?"":` got=${JSON.stringify(a)} expected=${JSON.stringify(b)}`));if(ok)pass++;else fail++;}
requestTerminalRun("cmd-A");requestTerminalRun("cmd-B");requestTerminalRun("cmd-C");
let firstSeen:string[]=[];
let caught=false;
try {
 subscribeTerminalRunRequests((command)=>{
   firstSeen.push(command);
   if(command==="cmd-A")throw new Error("fixture terminal panel crashed before next command");
 });
} catch {caught=true;}
eq("subscriber failure is observable to caller",caught,true);
eq("only attempted command reached broken callback",firstSeen,["cmd-A"]);
let recovered:string[]=[];
const off=subscribeTerminalRunRequests(command=>recovered.push(command));
eq("unattempted queued B,C survive broken subscriber",recovered,["cmd-B","cmd-C"]);
requestTerminalRun("cmd-D");
eq("healthy later listener also receives live command",recovered,["cmd-B","cmd-C","cmd-D"]);
off();
requestTerminalRun("cmd-E");
const second:string[]=[];
const offSecond=subscribeTerminalRunRequests(c=>second.push(c));
eq("queue continues to work after unsubscribe/resubscribe",second,["cmd-E"]);
offSecond();
const offBroken=subscribeTerminalRunRequests(()=>{throw new Error("fixture live subscriber failed");});
let liveFailed=false;
try {requestTerminalRun("cmd-F");} catch {liveFailed=true;}
eq("live listener failure is visible",liveFailed,true);
requestTerminalRun("cmd-G");
const final:string[]=[];
const offFinal=subscribeTerminalRunRequests(c=>final.push(c));
eq("after live failure later commands queue rather than go to broken listener",final,["cmd-G"]);
offBroken();offFinal();
console.log(`terminal-bus-recovery-smoke: ${pass}/${pass+fail}`);
if(fail)process.exitCode=1;
