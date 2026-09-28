import { create } from "zustand";
import type { ContentTag } from "@renderer/lib/contentTag.js";
export const audit = {
  nodeListReads: 0,
  reads: [] as string[], writes: [] as { filePath: string; content: string }[],
  quotes: [] as { sessionId: string; tag: ContentTag }[], toasts: [] as unknown[],
  contents: {
    "/workspace/a.md": "# Document A\n\nAlpha beta selected passage.\n\nSecond paragraph from file A.\n",
    "/workspace/b.md": "# Document B\n\nBravo text from second file.\n",
  } as Record<string,string>,
};
export const api = {
  file: {
    async readFile({filePath}:{filePath:string}) { audit.reads.push(filePath); return { content: audit.contents[filePath] ?? "" }; },
    async writeFile(input:{filePath:string;content:string}) { audit.writes.push(input);audit.contents[input.filePath]=input.content;return {ok:true}; },
  },
  session: { async listNodes() { audit.nodeListReads++; return {sessions:[{id:"node-1",title:"Node conversation",kind:"node"}]}; } },
};
export const useSessionStore = create(() => ({
  activeSessionId:"main-1" as string | null, activeSideChatId:"side-1" as string | null, locale:"zh" as const,
  streamSessions:[{id:"main-1",title:"Main conversation"}],
  sideChatsByParent:{"main-1":[{id:"side-1",title:"Side conversation"}]},
  quoteIntoComposer(sessionId:string,tag:ContentTag) { audit.quotes.push({sessionId,tag}); },
}));
export const useToastStore = { getState: () => ({ push: (toast:unknown) => audit.toasts.push(toast) }) };
const messages:Record<string,string>={
 "chatStream.quote.action":"引用到对话", "chatStream.quote.untitled":"Untitled",
 "chatStream.quote.current":"Current", "chatStream.quote.doneToast":"Quoted to {name}",
 "common.loading":"Loading", "ide.editor.mdPlaceholder":"Type here",
 "ide.editor.quoteToCurrent":"引用到当前对话",
 "ide.editor.quoteNoOpenChat":"请先打开一个对话，再引用所选内容。",
 "ide.editor.quoteAdded":"已引用到当前对话的输入框",
};
const t = (key:string, args?:Record<string,string|number>) => {
 let value=messages[key]??key;
 for(const [name,part] of Object.entries(args??{}))value=value.replace(`{${name}}`,String(part));
 return value;
};
export const useI18n=()=>({t,locale:"zh" as const});
