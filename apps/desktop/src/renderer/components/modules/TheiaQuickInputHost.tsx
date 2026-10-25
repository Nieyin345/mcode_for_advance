/** F032: VS Code Quick Pick and Input Box using Mcode's native overlay/focus primitive.
 * Stays mounted at app root so an extension can prompt while Settings is closed.
 */
import {useEffect,useRef,useState} from "react";
import {api} from "@renderer/lib/api.js";
import {useFocusTrap} from "@renderer/hooks/useFocusTrap.js";
import type {TheiaQuickInputRequest} from "@contracts/ipc/modules.js";

export function TheiaQuickInputHost(){
  const [queue,setQueue]=useState<TheiaQuickInputRequest[]>([]);
  const [text,setText]=useState("");
  const [selected,setSelected]=useState<number[]>([]);
  const rootRef=useRef<HTMLDivElement>(null);
  const current=queue[0];
  useFocusTrap(rootRef,Boolean(current));
  useEffect(()=>api.on.theiaQuickInput(msg=>{
    setQueue(old=>old.some(item=>item.requestId===msg.requestId)?old:old.length>=8?old:[...old,msg]);
  }),[]);
  useEffect(()=>{
    setText(current?.kind==="input"?current.value??"":"");
    setSelected([]);
  },[current?.requestId]);
  const done=(choice:string|number[]|null)=>{
    if(!current)return;
    const requestId=current.requestId,sessionId=current.sessionId;
    setQueue(old=>old.filter(q=>q.requestId!==requestId));
    void api.modules.theiaInstalled({op:"quickRespond",sessionId,requestId,choice}).catch(()=>{});
  };
  useEffect(()=>{
    if(!current)return;
    const id=setTimeout(()=>done(null),45000);
    return ()=>clearTimeout(id);
  },[current?.requestId]);
  if(!current)return null;
  const matches=(current.items??[]).map((item,index)=>({...item,index})).filter(item=>
    !text||item.label.toLowerCase().includes(text.toLowerCase())||
    item.description?.toLowerCase().includes(text.toLowerCase()));
  const pick=(index:number)=>{
    if(!current.canPickMany){done([index]);return;}
    setSelected(old=>old.includes(index)?old.filter(x=>x!==index):[...old,index]);
  };
  return <div ref={rootRef} className="fixed inset-0 z-[10001] flex items-start justify-center bg-black/35 pt-[13vh]"
    data-testid="theia-quick-input">
    <div className="w-full max-w-xl rounded border border-edge bg-surface p-4 shadow-[var(--shadow-popover)]"
      role="dialog" aria-modal="true" aria-label={current.title??current.extensionId}
      onKeyDown={e=>{if(e.key==="Escape"){e.stopPropagation();done(null);}
        if(e.key==="Enter"&&current.kind==="input"){e.preventDefault();done(text);}
        else if(e.key==="Enter"&&current.kind==="pick"&&!current.canPickMany&&matches[0]){
          e.preventDefault();done([matches[0].index]);}}}>
      <p className="mb-2 text-body font-semibold">{current.title??current.extensionId}</p>
      <input autoFocus value={text} type={current.kind==="input"&&current.password?"password":"text"}
        placeholder={current.placeholder??""} onChange={e=>setText(e.target.value)}
        maxLength={4096} aria-label={current.placeholder??current.title??"扩展输入"}
        className="w-full rounded border border-edge bg-surface-muted p-2 text-code outline-none focus-visible:ring-2 focus-visible:ring-accent-strong"/>
      {current.kind==="pick"&&<div className="mt-2 max-h-64 overflow-auto" role="listbox"
        aria-multiselectable={current.canPickMany===true}>
        {matches.map(item=><button type="button" key={item.index}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-code hover:bg-surface-muted"
          onClick={()=>pick(item.index)} role="option" aria-selected={selected.includes(item.index)}>
          {current.canPickMany&&<input type="checkbox" readOnly checked={selected.includes(item.index)}/>}
          <span className="min-w-0"><span>{item.label}</span>
            {item.description&&<span className="ml-2 text-content-muted">{item.description}</span>}
            {item.detail&&<span className="block text-content-muted">{item.detail}</span>}
          </span>
        </button>)}
        {matches.length===0&&<p className="p-2 text-code text-content-muted">无匹配选项</p>}
      </div>}
      <div className="mt-3 flex justify-end gap-2 text-code">
        <button type="button" className="rounded border border-edge px-3 py-1.5" onClick={()=>done(null)}>取消</button>
        {current.kind==="input"&&<button type="button" className="rounded border border-edge px-3 py-1.5" onClick={()=>done(text)}>确定</button>}
        {current.kind==="pick"&&current.canPickMany&&<button type="button" className="rounded border border-edge px-3 py-1.5" onClick={()=>done(selected)}>确认选择</button>}
      </div>
    </div>
  </div>;
}
