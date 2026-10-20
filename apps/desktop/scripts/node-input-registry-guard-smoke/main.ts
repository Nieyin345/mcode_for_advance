import {NodeInputBuilderRegistry} from "../../src/main/orchestration/nodeInputBuilders.js";
let pass=0,fail=0;function ok(s:string,p:boolean){console.log((p?"PASS ":"FAIL ")+s);p?pass++:fail++;}
const registry=new NodeInputBuilderRegistry();
const fake=(kind:string)=>({kind,build:({base}:any)=>base});
const refuses=(f:()=>unknown)=>{try{f();return false;}catch{return true;}};
for(const [label,kind] of [["empty",""],["blank","   "],["padded"," code "],["control","code"+String.fromCharCode(10)+"run"],["huge","x".repeat(2048)]] as const)ok(label+" kind rejected",refuses(()=>registry.register(fake(kind))));
ok("undefined kind rejected",refuses(()=>registry.register({build:()=>null} as never)));
ok("missing callable build rejected",refuses(()=>registry.register({kind:"bad"} as never)));
ok("missing builder object rejected",refuses(()=>registry.register(null as never)));
ok("rejected entries never become registered",registry.get("bad")===undefined&&registry.get("")===undefined);
const valid=fake("typed");registry.register(valid);
ok("valid dedicated builder dispatches",registry.get("typed")===valid);
ok("duplicate builder cannot replace registered one",refuses(()=>registry.register(fake("typed"))));
ok("valid builder remains authoritative after duplicate",registry.get("typed")===valid);
console.log(`node-input-registry-guard-smoke: ${pass}/${pass+fail}`);if(fail)process.exitCode=1;
