import {createInMemoryExecutorOwnership} from "../../src/main/workflowEngines/executorOwnership.js";
let success=0,failed=0;const check=(s:string,p:boolean,x?:unknown)=>{console.log((p?"PASS ":"FAIL ")+s+(p?"":" "+JSON.stringify(x)));p?success++:failed++;};
const registry=createInMemoryExecutorOwnership();
const before=registry.list().length;
for(const [name,badId] of [["null prototype",Object.create(null)],["embedded NUL","foo"+String.fromCharCode(0)+"bar"],["CRLF injection","foo"+String.fromCharCode(13,10)+"bar"],["huge identifier","a".repeat(2_000)] ] as const){
 let res:unknown=null;let threw=false;
 try{res=registry.claim(badId as never,"mcode");}catch{threw=true;}
 check(name+" cannot crash/claim authoritative owner",!threw&&(res as {ok?:boolean}|null)?.ok===false,{threw,result:typeof res==="object"&&res!==null?{ok:(res as {ok?:boolean}).ok}:res});
}
check("invalid ID attempts never alter owner ledger",registry.list().length===before,registry.list());
const granted=registry.claim("flow_valid-1","node-red");
check("normal Node-RED claim works",granted.ok&&registry.executorOwnerOf("flow_valid-1")==="node-red",granted);
const duplicate=registry.claim("flow_valid-1","mcode");
check("second executor cannot claim native-owned flow",duplicate.ok===false,duplicate);
const denied=registry.release("flow_valid-1","mcode");
check("non-owner cannot release flow",denied.ok===false&&registry.executorOwnerOf("flow_valid-1")==="node-red",denied);
const revoked=registry.release("flow_valid-1","node-red");
check("actual owner can release after deployment teardown",revoked.ok&&registry.executorOwnerOf("flow_valid-1")===null,revoked);
console.log(`executor-owner-identity-smoke: ${success}/${success+failed}`);if(failed)process.exitCode=1;
