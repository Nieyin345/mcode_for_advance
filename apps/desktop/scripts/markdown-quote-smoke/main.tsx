import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MarkdownEditorPane } from "@renderer/components/ide/MarkdownEditorPane.js";
import { audit, useSessionStore } from "./stubs.js";
function App() {
 const [path,setPath]=useState("/workspace/a.md");
 Object.assign(window,{__quoteAudit:audit,__openMarkdown:setPath,__sessionStore:useSessionStore});
 return <><div id="outside">Outside editor selection must not be quoted</div><div className="quote-fixture"><MarkdownEditorPane key={path} filePath={path} projectPath="/workspace"/></div></>;
}
createRoot(document.getElementById("root")!).render(<App/>);
Object.assign(window,{__ready:true});
