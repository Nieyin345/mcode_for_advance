import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EXAMPLE_MODULE, MODULE_CONTRIBUTION_ICONS, ModuleManifestSchema, moduleContributionView } from "@contracts/modules";
import { ExtensionStoreGetSchema, ExtensionStoreSetSchema } from "@contracts/extensionStore";
import { ModuleHost } from "../../src/main/modules/ModuleHost.js";
import { fileCapabilities, resolveModuleResource } from "../../src/main/modules/fileCapabilities.js";

let passes=0;
function check(name:string, fn:()=>void|Promise<void>) {return Promise.resolve().then(fn).then(()=>{console.log("PASS "+name);passes++;});}
const title={zh:"扩展",en:"Extension"};
const field={key:"bytes",title};
const command={id:"hello",slot:"command",title,capability:"core.file.info",command:"acme.hello",icon:"sparkles"};
const view={id:"stats",slot:"view",title,capability:"core.file.info",location:"right",icon:"chart",view:{kind:"fields",fields:[field]}};
const settings={id:"config",slot:"settings",title,capability:"core.file.info",properties:[
  {key:"apiEndpoint",title,type:"string",default:""},
  {key:"threshold",title,type:"number",default:2},
  {key:"enabled",title,type:"boolean",default:true},
  {key:"choice",title,type:"enum",enum:["a","b"],default:"a"},
]};
const manifest={...EXAMPLE_MODULE,id:"user.t50.fixture",contributions:[command,view,settings]};
const valid=ModuleManifestSchema.parse(manifest);

await check("commands, view and settings pass the discriminated contribution contract",()=>{
  assert.equal(valid.contributions.length,3);
  assert.equal(valid.contributions[0].slot,"command");
  assert.equal(valid.contributions[1].slot,"view");
  assert.equal(valid.contributions[2].slot,"settings");
});
await check("bad slot fails closed",()=>assert.equal(ModuleManifestSchema.safeParse({...manifest,contributions:[{...command,slot:"unknown"}]}).success,false));
await check("bad command identifier is rejected",()=>assert.equal(ModuleManifestSchema.safeParse({...manifest,contributions:[{...command,command:"bad"}]}).success,false));
await check("unknown / injected icon is rejected",()=>{
  assert.equal(ModuleManifestSchema.safeParse({...manifest,contributions:[{...command,icon:"https://attacker/svg"}]}).success,false);
  assert.equal(ModuleManifestSchema.safeParse({...manifest,contributions:[{...view,icon:"<svg>"}]}).success,false);
  assert.equal(MODULE_CONTRIBUTION_ICONS.includes("chart"),true);
});
await check("unknown slot-specific properties are rejected",()=>{
  assert.equal(ModuleManifestSchema.safeParse({...manifest,contributions:[{...command,properties:settings.properties}]}).success,false);
  assert.equal(ModuleManifestSchema.safeParse({...manifest,contributions:[{...settings,view:view.view}]}).success,false);
});
await check("invalid enum default is refused",()=>assert.equal(ModuleManifestSchema.safeParse({...manifest,contributions:[{...settings,properties:[{key:"choice",title,type:"enum",enum:["a"],default:"b"}]}]}).success,false));

const desktop=resolve("apps/desktop");
const temp=join(desktop,".tmp");mkdirSync(temp,{recursive:true});
const root=mkdtempSync(join(temp,"t50-fixture-"));
const path=join(root,"report.txt");
try {
  writeFileSync(path,"fixture for T50\n");
  const host=new ModuleHost({authorize:async r=>{await resolveModuleResource(r,p=>p===root);},persist:async()=>{}});
  for(const c of fileCapabilities(p=>p===root))host.register(c);
  host.restore(valid);
  const input={moduleId:valid.id,resource:{projectPath:root,path},requestId:"t50-1"};
  await check("command dispatches its contribution ID through the real ModuleHost.invoke",async()=>{
    const response=await host.invoke({...input,contributionId:"hello"});
    assert.equal(response.type,"result");
    if(response.type==="result"){ assert.equal(typeof response.value.bytes,"number");assert.equal(response.view.title.zh,title.zh);}
  });
  await check("view contribution displays declared fields from host result at right/left/bottom",async()=>{
    for(const location of ["right","left","bottom"]){
      const parsed=ModuleManifestSchema.parse({...manifest,contributions:[command,{...view,location},settings]});
      const contribution=parsed.contributions[1];
      assert.equal(contribution.slot,"view");
      if(contribution.slot!=="view")throw Error("wrong slot");
      assert.equal(contribution.location,location);
      assert.deepEqual(moduleContributionView(contribution).fields,[field]);
    }
    const response=await host.invoke({...input,contributionId:"stats",requestId:"t50-2"});
    assert.equal(response.type,"result");
    if(response.type==="result"){assert.equal(response.view.fields[0].key,"bytes");assert.equal(typeof response.value.bytes,"number");}
  });
} finally {rmSync(root,{recursive:true,force:true});}
await check("settings property transport remains in extensionStore, not Mcode settings",()=>{
  const get=ExtensionStoreGetSchema.parse({extensionId:manifest.id,key:"apiEndpoint"});
  const set=ExtensionStoreSetSchema.parse({...get,value:"https://example.invalid"});
  assert.equal(set.key,"apiEndpoint");
  assert.equal(set.extensionId,manifest.id);
  const source=readFileSync(join(desktop,"src/renderer/components/modules/ModuleContributions.tsx"),"utf8");
  assert.match(source,/api\.extensionStore\.get/);
  assert.match(source,/api\.extensionStore\.set/);
  assert.doesNotMatch(source,/api\.setting\.set/);
});
await check("command / dock / extension-settings are wired into real UI components",()=>{
  const read=(p:string)=>readFileSync(join(desktop,p),"utf8");
  assert.match(read("src/renderer/components/layout/CommandPalette.tsx"),/contributionsOf\(moduleCatalog\.data,"command"\)/);
  assert.match(read("src/renderer/components/layout/RightPanel.tsx"),/ModuleViewDock location="right"/);
  assert.match(read("src/renderer/components/shell/ClassicShell.tsx"),/ModuleViewDock location="left"/);
  assert.match(read("src/renderer/components/layout/ThreePaneLayout.tsx"),/ModuleViewDock location="bottom"/);
  assert.match(read("src/renderer/components/settings/SettingsPage.tsx"),/active === "extension-settings" && <ModuleSettingsPanel/);
});
console.log("module-contributions-smoke: "+passes+" passed");
