import { useState } from "react";
import { createRoot } from "react-dom/client";
import { FileLink } from "@renderer/components/chat/FileLink.js";
import { audit, setFiles, setDesktop } from "./stubs.js";
function App() {
 const [fixture,setFixture]=useState({token:"a.ts",asLink:false,id:0});
 Object.assign(window,{__audit:audit,__setFiles:setFiles,__setDesktop:setDesktop,__fixture:(token:string,asLink=false)=>setFixture(f=>({token,asLink,id:f.id+1}))});
 return <div id="fixture"><FileLink key={fixture.id} token={fixture.token} projectPath="/workspace" asLink={fixture.asLink}/></div>;
}
createRoot(document.getElementById("root")!).render(<App/>);
Object.assign(window,{__ready:true});
