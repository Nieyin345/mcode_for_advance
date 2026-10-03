import React from "react";
import { createRoot } from "react-dom/client";
import { useMarketProgress } from "@renderer/components/settings/useMarketProgress.js";
import { emit, subscribed } from "./api-stub.js";
declare global { interface Window { fixture: { result: (value: any) => void }; inlineRan?: boolean; } }
const results: string[]=[];
const check=(message:string,value:unknown)=>{if(!value)throw new Error(message);results.push(message);};
const tick=()=>new Promise(r=>setTimeout(r,30));
let progress: ReturnType<typeof useMarketProgress>;
function Probe(){progress=useMarketProgress();return <>{progress.status}</>;}
async function run(){
  check("main inline script stays blocked",!window.inlineRan);
  const blob=new Blob([new Uint8Array([137,80,78,71,13,10,26,10])]);
  const url=URL.createObjectURL(blob);
  check("Blob fetch allowed",(await (await fetch(url)).arrayBuffer()).byteLength===8);URL.revokeObjectURL(url);
  const canvas=document.createElement('canvas');canvas.width=1;canvas.height=1;
  canvas.getContext('2d')!.fillRect(0,0,1,1);
  const imageBlob=await new Promise<Blob>(r=>canvas.toBlob(b=>r(b!),'image/png'));
  const imageUrl=URL.createObjectURL(imageBlob),img=new Image();
  await new Promise<void>((r,j)=>{img.onload=()=>r();img.onerror=()=>j(new Error('Blob image blocked'));img.src=imageUrl;});
  check("Blob image decoded",img.naturalWidth===1);URL.revokeObjectURL(imageUrl);
  const origin=new URLSearchParams(location.search).get('office')!;
  const iframe=document.createElement('iframe');iframe.src=origin+'/editor.html';
  await new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Foreign editor inline script blocked')),8000);
    const handler=(event:MessageEvent)=>{if(event.origin===origin&&event.source===iframe.contentWindow&&event.data==='editor-ready'){clearTimeout(timer);window.removeEventListener('message',handler);resolve();}};
    window.addEventListener('message',handler);document.body.append(iframe);
  });check("foreign editor retains its own inline-script policy",true);
  const root=createRoot(document.getElementById('market-root')!);root.render(<Probe/>);
  for(let i=0;i<100&&!subscribed();i++)await tick();
  check("renderer subscribes",subscribed());
  let id='',finish!:()=>void;
  const pending=progress!.run(requestId=>{id=requestId;return new Promise<void>(r=>{finish=r;});});await tick();
  emit({requestId:'other-operation',phase:'clone',message:'DO NOT DISPLAY',elapsedMs:1});await tick();
  check("foreign progress ignored",!document.body.textContent!.includes('DO NOT DISPLAY'));
  emit({requestId:id,phase:'clone',message:'Receiving objects: 42%',elapsedMs:1,timeoutMs:900000});await tick();
  check("matching progress rendered",document.body.textContent!.includes('Receiving objects: 42%'));
  check("clone limit visible",document.body.textContent!.includes('15 min'));
  finish();await pending;await tick();check("finished progress cleared",!document.querySelector('[role=status]'));
  emit({requestId:id,phase:'clone',message:'LATE EVENT',elapsedMs:2});await tick();
  check("late progress ignored",!document.body.textContent!.includes('LATE EVENT'));
  root.unmount();await tick();check("renderer unsubscribes on unmount",!subscribed());
  window.fixture.result({ok:true,results});
}
run().catch(error=>window.fixture.result({ok:false,error:String(error),results}));
