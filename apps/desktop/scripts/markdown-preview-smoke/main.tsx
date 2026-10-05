import { useState } from "react";
import { createRoot } from "react-dom/client";
import { FilePreview } from "@renderer/components/library/FilePreview.js";
import type { LibraryItem } from "@contracts/library";
import { audit, imageReads, fileReads, doc } from "./stubs.js";
function App(){
 const [id,setId]=useState('paper');
 Object.assign(window,{__previewAudit:{audit,imageReads,fileReads,doc},__switchPreview:setId});
 const item={id,title:'Paper',filePath:'paper.pdf',pdfPath:'paper.pdf',mdPath:'notes/full.md'} as LibraryItem;
 return <div className="quote-fixture"><FilePreview item={item} which="md"/></div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
Object.assign(window,{__ready:true});
