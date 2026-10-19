import { renderTemplate, readConditionRef } from "@contracts/nodeTemplate";
const original = {
  nodes: [{ id:"A", title:"A", params: { nested:{key:"value"}, direct:"present" },
    outcome:{status:"success" as const,summary:"ok"} }],
  upstream:new Set(["A"]), user:"", trigger:undefined,
} as Parameters<typeof renderTemplate>[1];
let checks=0, errors=0;
function check(name:string,pass:boolean,detail:unknown) {
  checks++; if(!pass){errors++;console.log("  FAIL "+name,detail);}else console.log("  ok   "+name);
}
const nested=renderTemplate("{{A.params.nested.key}}",original);
check("★ template supports nested params identically to conditions",
  nested.ok && nested.text==="value",nested);
const nestedCondition=readConditionRef("{{A.params.nested.key}}",original);
check("nested condition reference remains supported",
  nestedCondition.ok && nestedCondition.found && nestedCondition.value==="value",nestedCondition);
const inheritedParams=Object.create({ inherited:"SECRET_FROM_PROTOTYPE" }) as Record<string,unknown>;
inheritedParams["direct"]="present";
const inheritedScope={...original,nodes:[{...original.nodes[0]!,params:inheritedParams}]};
const inherited=renderTemplate("{{A.params.inherited}}",inheritedScope);
check("★ inherited param never resolves into template text",
  !inherited.ok || !inherited.text.includes("SECRET_FROM_PROTOTYPE"),inherited);
const inheritedCondition=readConditionRef("{{A.params.inherited}}",inheritedScope);
check("condition own-property lookup remains fail-closed",
 inheritedCondition.ok && !inheritedCondition.found,inheritedCondition);
const missing=renderTemplate("x={{A.params.no_such_key}}",original);
check("★ missing explicit param rejects rather than silently injecting empty string",!missing.ok,missing);
const direct=renderTemplate("{{A.params.direct}}",original);
check("own direct param still renders correctly",direct.ok && direct.text==="present",direct);
const ownProto=JSON.parse('{"__proto__":"SAFE_LITERAL"}') as Record<string,unknown>;
const protoScope={...original,nodes:[{...original.nodes[0]!,params:ownProto}]};
const own=renderTemplate("{{A.params.__proto__}}",protoScope);
check("explicitly owned prototype-shaped JSON key remains plain data",
 own.ok && own.text==="SAFE_LITERAL",own);
const invalidPaths = ["nested[]","nested..key","nested.","nested[abc]","[0]extra"];
for (const path of invalidPaths) {
  const templ=renderTemplate(`{{A.params.${path}}}`,original);
  check("★ malformed param path is never silently normalized to another field",
    !templ.ok, {path,templ});
  const conditional=readConditionRef(`{{A.params.${path}}}`,original);
  check("★ malformed condition path cannot resolve a different field",
    !conditional.ok,{path,conditional});
}
// Invalid output and artifact paths must not be interpreted as ordinary
// "not found": condition routing could otherwise silently take a false branch.
const richScope={...original,nodes:[{...original.nodes[0]!,
  artifacts:[{kind:"file" as const,uri:"file:///fixture.txt"}],
  outcome:{status:"success" as const,summary:"ok",outputs:{nested:{value:"OK"}}}}]};
for(const ref of ["{{A.artifacts[]}}","{{A.outputs.nested..value}}","{{A.nested[]}}"]) {
  const bad=readConditionRef(ref,richScope);
  check("★ malformed output/artifact condition ref rejects rather than taking false branch",
    !bad.ok,{ref,bad});
}
const arrScope={...original,nodes:[{...original.nodes[0]!,params:{array:[{value:"INDEX_OK"}]}}]};
const arr=renderTemplate("{{A.params.array[0].value}}",arrScope);
check("valid indexed nested param path stays supported",arr.ok && arr.text==="INDEX_OK",arr);
console.log(`node-template-boundary-smoke: ${checks-errors}/${checks} 通过`);
if(errors)process.exitCode=1;
