import { browserUuid } from "../../src/renderer/lib/uuid.js";
let ok=0,bad=0;
function check(name:string,condition:boolean,detail=""){console.log((condition?"PASS ":"FAIL ")+name+(condition?"":" "+detail));if(condition)ok++;else bad++;}
const oldRandom=Math.random,oldNow=Date.now;
const oldCrypto=Object.getOwnPropertyDescriptor(globalThis,"crypto");
try {
 Object.defineProperty(globalThis,"crypto",{configurable:true,value:undefined});
 Math.random=()=>0;
 Date.now=()=>1234567890;
 const ids=Array.from({length:4},()=>browserUuid());
 check("LAN HTTP fallback IDs stay unique even under low-resolution clock and repeated random",new Set(ids).size===ids.length,ids.join(","));
 check("LAN HTTP fallback IDs are nonempty printable strings",ids.every(x=>x.length>4&&/^[\x21-\x7e]+$/.test(x)));
 const clock=Date.now();
 Object.defineProperty(globalThis,"crypto",{configurable:true,value:{randomUUID:()=> "fixture-native-uuid"}});
 check("secure native UUID takes precedence",browserUuid()==="fixture-native-uuid");
} finally {
 Math.random=oldRandom;Date.now=oldNow;
 if(oldCrypto)Object.defineProperty(globalThis,"crypto",oldCrypto);
 else delete (globalThis as {crypto?:unknown}).crypto;
}
console.log(`browser-uuid-entropy-smoke: ${ok}/${ok+bad}`);if(bad)process.exitCode=1;
