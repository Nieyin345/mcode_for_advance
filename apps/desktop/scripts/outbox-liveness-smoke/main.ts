/**
 * ARC-006: event delivery must not disappear when target discovery fails,
 * or be marked DELIVERED when a previously failed target unsubscribes.
 * Pure in-process test of the real RetryableOutbox, no Electron/user data.
 */
import { RetryableOutbox, type OutboxFailure } from "@main/store/outbox.js";
let n=0, failed=0;
function check(label:string,good:boolean,details?:unknown){
 n++;if(good)console.log("  ok   "+label);
 else {failed++;console.log("  FAIL "+label+" "+JSON.stringify(details));}
}
const identify=(event:string)=>({eventId:event,triggerKey:"smoke",kind:"smoke"});
const now=()=>1;

// Target discovery itself can throw. The event was already shifted out of
// the pending queue before calling targets(). Never silently lose it.
{
 let resolutions=0, thrown:unknown=null;
 const box=new RetryableOutbox<string>({
  capacity:4,retryBudget:2,identify,now,
  targets:()=>{resolutions++;throw new Error("TARGET_DISCOVERY_DOWN");}
 });
 try{box.enqueue("target-discovery-broken")}catch(e){thrown=e}
 check("★★ target provider exception does not escape and lose queued event",thrown===null,String(thrown));
 check("★★ resolver is retried only up to configured budget",resolutions===2,{resolutions});
 check("★★ unavailable target resolver becomes a counted failed delivery",box.stats().failed===1,box.stats());
 const letters=box.deadLetters();
 check("★★ resolver failure recorded with actionable reason",letters.length===1&&letters[0]!.lastError.includes("TARGET_DISCOVERY_DOWN"),letters);
 const exposed=letters as OutboxFailure[];
 try {exposed.splice(0,exposed.length);}catch{/* immutable copies may be frozen */}
 check("★★ external mutation of diagnostic snapshot cannot erase actual dead letters",box.deadLetters().length===1);
}

// A subscriber can disappear between retries (a renderer unsubscribes).
// A previous failure must not be reclassified as a success just because the
// subscriber was not in the next targets() snapshot.
{
 let rounds=0,tries=0;
 const box=new RetryableOutbox<string>({
  capacity:4,retryBudget:2,identify,now,
  targets:()=>rounds++===0 ? [{id:"disappeared-ui",deliver:()=>{tries++;throw new Error("RENDERER_UNAVAILABLE");}}]:[]
 });
 box.enqueue("failed-then-unsubscribed");
 check("★★ original failure actually attempted once",tries===1,{tries});
 check("★★ vanished failed target remains terminal FAILED after retry budget",box.stats().failed===1&&box.stats().delivered===0,box.stats());
 check("★★ deadLetter identifies vanished subscriber (not false DELIVERED)",box.deadLetters().some(x=>x.targetId==="disappeared-ui"),box.deadLetters());
}

// If targets() fails transiently, a retry may still deliver. A successful
// target must never be double-invoked after it was delivered.
{
 let discovery=0,deliveries=0;
 const box=new RetryableOutbox<string>({
  capacity:4,retryBudget:3,identify,now,
  targets:()=>{ if(++discovery===1)throw new Error("TRANSIENT_DISCOVERY");
    return [{id:"back-online",deliver:()=>{deliveries++;}}];
  }
 });
 box.enqueue("temporary-target-loss");
 check("transient targets() failure retries then actually delivers once",deliveries===1&&discovery===2,{deliveries,discovery});
 check("recovered delivery no dead letter",box.deadLetters().length===0&&box.stats().failed===0,box.stats());
}

// The API explicitly describes pending as including actively delivering.
// A subscriber can inspect stats while its own callback runs and trigger a
// nested event. Observing pending=0 on the active event is inaccurate.
{
 let observed=-1, delivered:string[]=[];
 let box:RetryableOutbox<string>;
 box=new RetryableOutbox<string>({
  capacity:4,retryBudget:2,identify,now,
  targets:()=>[{id:"sink",deliver:(event)=>{
    delivered.push(event);
    if(event==="first"){
      observed=box.stats().pending;
      box.enqueue("second");
    }
  }}]
 });
 box.enqueue("first");
 check("★★ stats.pending includes event currently inside subscriber callback",observed===1,{observed});
 check("nested event drains later, exactly once each",JSON.stringify(delivered)===JSON.stringify(["first","second"]),delivered);
 check("outbox fully drains to pending=0",box.stats().pending===0,box.stats());
}

// A previously failing subscriber that briefly disappears can re-register
// before the final retry. Deliver once then; don't dead-letter a recovery.
{
 let rounds=0,attempts=0;
 const box=new RetryableOutbox<string>({capacity:3,retryBudget:3,identify,now,
   targets:()=>{
     rounds++;
     if(rounds===2)return [];
     return [{id:"reconnecting",deliver:()=>{
       attempts++;
       if(attempts===1)throw new Error("temporarily-offline");
     }}];
   }
 });
 box.enqueue("reconnecting-subscriber");
 check("failed subscriber can recover after a temporary unsubscribe",rounds===3&&attempts===2,{rounds,attempts});
 check("recovered subscriber becomes delivered, not a dead letter",
   box.stats().delivered===1&&box.stats().failed===0&&box.deadLetters().length===0,box.stats());
}

// Always successful subscribers retain existing semantics.
{
 let delivered=0;
 const box=new RetryableOutbox<string>({capacity:2,retryBudget:2,identify,now,
  targets:()=>[{id:"ok",deliver:()=>{delivered++;}}]});
 box.enqueue("happy");
 check("normal one-shot delivery still succeeds",delivered===1&&box.stats().delivered===1&&box.stats().failed===0,box.stats());
}
console.log("outbox-liveness-smoke:"+(n-failed)+"/"+n+" PASS");
if(failed)process.exitCode=1;
