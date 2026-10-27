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
const schemes = fake.registrations[0]?.map(x=>x.scheme).sort() ?? [];
// 只断言这两件事：**一次注册**、且**这几个 scheme 都在里面**。
// 不写成"恰好等于这个数组"：Electron 只允许一次 registerSchemesAsPrivileged，
// 每加一个特权 scheme（例如 Theia webview 资源协议）都要并进这一次调用 ——
// 那是合法的扩展，不该让这条断言假红，而"漏注册"仍然会被抓到。
const required = ["genoffice-app","genoffice-docx-media","mcode-panel"];
check("privileged Electron schemes registered together once", fake.registrations.length === 1 &&
  required.every((s) => schemes.includes(s)));
console.log("genoffice-native-stub-smoke:"+(6-fail)+"/6 通过");
if(fail)process.exitCode=1;
