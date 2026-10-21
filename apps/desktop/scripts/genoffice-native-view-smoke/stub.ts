/** No-vendor path: build must resolve only the stub, never a vendor import. */
import { configureGenofficeNativeViews, nativeHostStatus, nativeViewsRoot, makeGenofficeNativeView, registerGenofficeNativeScheme } from "@main/document/genofficeViewFactories.js";
import { protocol } from "electron";
import { resolve } from "node:path";
let fail=0;
const check=(name:string,ok:boolean)=>{console.log((ok?"  ok ":"  FAIL ")+name);if(!ok)fail++;};
const dev=resolve("C:/mcode/genoffice/packages/cli/dist/genoffice.cjs");
const release=resolve("C:/apps/resources/genoffice/cli/genoffice.cjs");
check("dev vendor path resolves to genoffice/apps",nativeViewsRoot(dev)?.replace(/\\/g,"/").endsWith("/genoffice/apps")===true);
check("release vendor path resolves to staged genoffice/apps",nativeViewsRoot(release)?.replace(/\\/g,"/").endsWith("/genoffice/apps")===true);
check("reject third arbitrary CLI layout",nativeViewsRoot("C:/wrong/cli.cjs")===null);
const caps=configureGenofficeNativeViews(dev);
check("no snapshot stub reports all hosts unavailable",Object.values(caps).every(v=>v===false));
check("native view cannot open without snapshot",(()=>{try{makeGenofficeNativeView(null,"pdf");return false}catch{return true}})());
registerGenofficeNativeScheme();
const fake = protocol as unknown as { registrations: Array<Array<{scheme:string}>> };
const schemes = fake.registrations[0]?.map(x=>x.scheme).sort();
check("privileged Electron schemes registered together once",fake.registrations.length===1 &&
  JSON.stringify(schemes)===JSON.stringify(["genoffice-app","genoffice-docx-media","mcode-panel"]));
console.log("genoffice-native-stub-smoke:"+(6-fail)+"/6 通过");
if(fail)process.exitCode=1;
