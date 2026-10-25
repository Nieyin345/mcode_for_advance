import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { visibleSideChat } from "../../src/renderer/components/chat/visibleSideChat.js";
import { sourceHas } from "../lib/sourceText.js";

const src = readFileSync(resolve("src/renderer/components/chat/SideChatPanel.tsx"), "utf8");
type Chat = { id:string; title:string };
const mainA: Chat = {id:"a",title:"Main A"};
const childA: Chat = {id:"side-a",title:"Side A"};
const nodeA = {parentId:"a",targetId:"node-a",row:{id:"node-a",title:"A node"}};
const nodeB = {parentId:"b",targetId:"node-b",row:{id:"node-b",title:"B node"}};
let count=0, fails=0;
function ck(label: string, valid: boolean, detail?: unknown) {
  count++;
  if (!valid) fails++;
  console.log((valid?"PASS ":"FAIL ")+label+(valid?"":": "+JSON.stringify(detail)));
}
ck("Active parent main row is visible under its own id",
  visibleSideChat("a","a",[childA],nodeA,mainA) === mainA);
ck("Main row cannot be impersonated by cached node or foreign parent",
  visibleSideChat("a","a",[childA],nodeA,{id:"b",title:"Wrong"}) === undefined);
ck("Parent side chat is visible when selected",
  visibleSideChat("a","side-a",[childA],nodeA,mainA) === childA);
ck("Valid node is visible after its own lookup resolves",
  visibleSideChat("a","node-a",[childA],nodeA,mainA) === nodeA.row);
ck("Switch parent before effect runs: old node cannot appear for new parent",
  visibleSideChat("b","node-a",undefined,nodeA,undefined) === undefined);
ck("Switch selected node before effect runs: prior node remains hidden",
  visibleSideChat("a","node-b",undefined,nodeA,mainA) === undefined);
ck("Correct lookup later displays the newly selected node",
  visibleSideChat("b","node-b",undefined,nodeB,undefined) === nodeB.row);
ck("Wrong-id cached row cannot masquerade as selected target",
  visibleSideChat("a","node-a",undefined,{parentId:"a",targetId:"node-a",row:childA},mainA) === undefined);
ck("No parent or selection never uses cached chats",
  visibleSideChat(null,"node-a",[childA],nodeA,mainA) === undefined &&
  visibleSideChat("a",null,[childA],nodeA,mainA) === undefined);
ck("Node-id collision cannot override current main session",
  visibleSideChat("a","a",undefined,{parentId:"a",targetId:"a",row:{id:"a",title:"Old node"}},mainA) === mainA);
ck("Selected side chat still renders before delayed node lookup",
  visibleSideChat("a","side-a",[childA],nodeB,mainA) === childA);

ck("Side panel wires typed scoped node state into pure parent-owned resolver",
  sourceHas(src, "useState<ScopedSideNode<Session> | null>(null)") &&
  sourceHas(src, "visibleSideChat(activeSessionId, activeSideChatId,"));
ck("Side panel does not query nodes for the active parent row",
  sourceHas(src, "activeSideChatId === activeSessionId || fromSideList") &&
  sourceHas(src, "if (cancelled) return;"));
ck("Delayed node RPC records both lookup parent and target identity",
  sourceHas(src, "parentId: activeSessionId, targetId: activeSideChatId, row"));
ck("Right-side create uses synchronous one-request fence",
  sourceHas(src, "if (creatingRef.current || !activeSessionId) return;") &&
  sourceHas(src, "creatingRef.current = true;") &&
  sourceHas(src, "creatingRef.current = false;"));
ck("Right-side create cannot select an old parent's child after switching",
  sourceHas(src, "const parentAtStart = activeSessionId;") &&
  sourceHas(src, "activeParentRef.current === parentAtStart"));
ck("Right-side create failure informs user, no unhandled detached promise",
  sourceHas(src, 'useToastStore.getState().push({') &&
  sourceHas(src, 'kind: "error"') &&
  sourceHas(src, 't("chat.newSubChat.createFailed"'));
ck("Side panel keeps all three choices with native store API",
  sourceHas(src, "profile: choice.profile ?? null") &&
  sourceHas(src, "memory: choice.memory") &&
  sourceHas(src, "await createSubChat({"));
ck("Selecting a row and navigating back reuse original store routing",
  sourceHas(src, "onOpen={(id) => void selectSideChat(id)}") &&
  sourceHas(src, "onClick={closeSideChatView}"));
ck("Main row never offers destructive delete button",
  sourceHas(src, "{!isMain && (") &&
  sourceHas(src, "disabled={running}"));
ck("Delete remains behind explicit confirmation before store delete",
  sourceHas(src, "<ConfirmDialog") &&
  sourceHas(src, 'danger') &&
  sourceHas(src, "void deleteSession(session.id)"));
ck("Main plus cannot open picker without a parent session",
  sourceHas(src, "disabled={!hasMainSession}") &&
  sourceHas(src, "aria-label={t(\"sideChat.newChat\")}"));
ck("Side chat list retains keyboard-visible separate open/delete actions",
  sourceHas(src, "focus-within:bg-surface-hover/60") &&
  sourceHas(src, "size-8 shrink-0 items-center justify-center") &&
  sourceHas(src, "focus-visible:outline-offset-2 focus-visible:outline-accent"));
ck("Chat view retains real session-keyed, collapsed composer",
  sourceHas(src, '<ChatPane sessionId={session.id} isActive chipsMode="collapsed" />'));
ck("Negative: dropping scoped resolver would allow stale node to leak",
  visibleSideChat("b","node-a",[],nodeA,undefined) !== nodeA.row);
ck("Negative: deleting request fence fails its own contract",
  !sourceHas(src.replace("if (creatingRef.current || !activeSessionId) return;","unsafeCreate();"),
    "if (creatingRef.current || !activeSessionId) return;"));
console.log("arc005-side-chat-ui-smoke: "+(count-fails)+"/"+count);
if(fails) process.exitCode=1;
