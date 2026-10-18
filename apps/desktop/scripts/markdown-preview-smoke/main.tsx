import { useState } from "react";
import { createRoot } from "react-dom/client";
import { FilePreview } from "@renderer/components/library/FilePreview.js";
import { Markdown } from "@renderer/components/chat/Markdown.js";
import type { LibraryItem } from "@contracts/library";
import { audit, imageReads, fileReads, doc } from "./stubs.js";
function App(){
 const [id,setId]=useState('paper');
 Object.assign(window,{__previewAudit:{audit,imageReads,fileReads,doc},__switchPreview:setId});
 const item={id,title:'Paper',filePath:'paper.pdf',pdfPath:'paper.pdf',mdPath:'notes/full.md'} as LibraryItem;
 return (
  <>
   <div className="quote-fixture"><FilePreview item={item} which="md"/></div>
   {/* 【MC-055】聊天/工作区只读预览走的是**真** `chat/Markdown`（react-markdown +
      Tailwind 类），与资料库的 Crepe 只读是两条渲染管线。同一份 Markdown 表格在
      两处必须同语义（content-first）—— 本 fixture 让套件能在同一页面里量两边的
      真实计算宽度，而不是 grep 源码。挂载与否由 `?chat=` 控制，默认不挂以免影响
      既有断言。 */}
   {new URLSearchParams(location.search).get("chat") === "1" && (
    <div id="chat-fixture" className="chat-md" style={{ width: 860, margin: 20 }}>
     <Markdown>{`
| ID | 说明 |
| --- | --- |
| 1 | ${"这是一段很长很长的说明文字,用来验证长列会按内容获得更多宽度而不是被平均分配".repeat(2)} |

| 单列 |
| --- |
| 只有一列的内容 |
`}</Markdown>
    </div>
   )}
  </>
 );
}
createRoot(document.getElementById('root')!).render(<App/>);
Object.assign(window,{__ready:true});
