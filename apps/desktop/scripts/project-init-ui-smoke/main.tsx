import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ProjectInitManager } from "@renderer/components/memory/ProjectInitManager.js";
import { useProjectInitializer, parseProjectInitCommand } from "@renderer/components/chat/useProjectInitializer.js";
import { SlashCommandPicker } from "@renderer/components/chat/SlashCommandPicker.js";
import { audit } from "./stubs.js";
function App(){
 const [manager,setManager]=useState(true);const [text,setText]=useState("");const [busy,setBusy]=useState(false);const [sessionId,setSession]=useState("s1");const [attached,setAttached]=useState(false);const [picker,setPicker]=useState(false);
 const init=useProjectInitializer({sessionId,busy,menuOpen:picker,snapshot:()=>({text,attached}),clear:()=>setText("")});
 Object.assign(window,{__ready:true,__setManager:setManager,__setText:setText,__setBusy:setBusy,__setSession:setSession,__setAttached:setAttached,__setPicker:setPicker,__parse:parseProjectInitCommand,__commands:init.commands,__audit:audit});
 return <><div id="host"><textarea id="chat" value={text} onChange={e=>setText(e.target.value)}/><button id="send" onClick={()=>{if(!init.intercept(text,attached))audit.calls.push({method:"model"});}}>Send</button>
 <button id="pick" onClick={()=>init.start("init-学术")}>Pick initializer</button></div>
 {manager&&<ProjectInitManager/>}{init.dialog}
 <SlashCommandPicker open={picker} query="init-" skills={[]} projectInitCommands={init.commands} engineName="Test engine" engineUnsupported={true} busy={busy} anchorRect={new DOMRect(20,300,500,30)} onPickSkill={()=>{throw Error("Skill route used");}} onPickCommand={c=>{init.start(c.name);setPicker(false);}} onPickEngineCommand={()=>{throw Error("Engine route used");}} onClose={()=>setPicker(false)}/></>;
}
createRoot(document.getElementById("root")!).render(<App/>);
