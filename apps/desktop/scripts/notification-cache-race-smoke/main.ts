import {inAppToastAllowed,setCachedNotificationPrefs} from "../../src/renderer/lib/notifPrefsCache.js";
import {pending,resolves} from "./stubApi.js";
let good=0,bad=0;
function eq(name:string,a:unknown,b:unknown){const yes=Object.is(a,b);console.log((yes?"PASS ":"FAIL ")+name+" got="+String(a));yes?good++:bad++;}
eq("initial default allows toast while prefs load",inAppToastAllowed(undefined),true);
eq("initial IPC preference read started",pending.length,1);
setCachedNotificationPrefs({inAppToasts:false,mutedProjectIds:[]} as never);
eq("user's saved setting blocks toasts immediately",inAppToastAllowed(undefined),false);
resolves[0]({prefs:{inAppToasts:true,mutedProjectIds:[]}});
await new Promise<void>(r=>setImmediate(r));
eq("older in-flight IPC result may not overwrite newer user setting",inAppToastAllowed(undefined),false);
setCachedNotificationPrefs({inAppToasts:true,mutedProjectIds:["proj-x"]} as never);
eq("muted project still blocked",inAppToastAllowed("proj-x"),false);
eq("unmuted project permitted",inAppToastAllowed("proj-y"),true);
console.log(`notification-cache-race-smoke: ${good}/${good+bad}`);if(bad)process.exitCode=1;
