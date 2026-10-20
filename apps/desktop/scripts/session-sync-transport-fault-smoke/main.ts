import {broadcastSessionDeleted,broadcastProjectsChanged,broadcastSettingChanged,broadcastSettingChangedToAll} from "../../src/main/lib/sessionSync.js";
import {setDesktopFailure,desktopEvents} from "./stubWindow.js";
import {setMobileFailure,mobileEvents} from "./stubMobile.js";
let yes=0,no=0;const test=(label:string,p:boolean,info?:unknown)=>{console.log((p?"PASS ":"FAIL ")+label+(p?"":" got="+JSON.stringify(info)));p?yes++:no++;};
setDesktopFailure(true);let raised=false;
try{broadcastSessionDeleted("s-mobile-needs");}catch{raised=true;}
test("destroyed desktop transport cannot crash committed session deletion",!raised);
test("mobile still receives session deletion when desktop IPC send throws",mobileEvents.some((e:any)=>e.sessionId==="s-mobile-needs"&&e.type==="session.deleted"));
const d0=desktopEvents.length;
setDesktopFailure(false);setMobileFailure(true);raised=false;
try{broadcastProjectsChanged();}catch{raised=true;}
test("broken SSE fanout cannot bubble into desktop IPC mutation",!raised);
test("desktop receives project change despite mobile SSE failure",desktopEvents.length===d0+1);
setMobileFailure(false);broadcastSessionDeleted("s-recovered");
test("following healthy broadcasts reach both transports",desktopEvents.some((e:any)=>e.payload?.event?.sessionId==="s-recovered")&&mobileEvents.some((e:any)=>e.sessionId==="s-recovered"));
const beforeDesktop=desktopEvents.length;setDesktopFailure(true);raised=false;
try{broadcastSettingChangedToAll("ui.theme","light");}catch{raised=true;}
test("import settings still reaches mobile with broken desktop",!raised&&mobileEvents.some((e:any)=>e.type==="setting.changed"&&e.key==="ui.theme"));
setDesktopFailure(false);broadcastSettingChanged("ui.theme","dark");
test("desktop-origin setting retains no local echo",desktopEvents.length===beforeDesktop);
setMobileFailure(true);let settingsEscaped=false;
try{broadcastSettingChanged("ui.theme","dark");}catch{settingsEscaped=true;}
test("mobile-only setting broadcast failure does not report committed setting as failed",!settingsEscaped);
setMobileFailure(false);
console.log(`session-sync-transport-fault-smoke: ${yes}/${yes+no}`);if(no)process.exitCode=1;
