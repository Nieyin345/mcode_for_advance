/** MC-057 defense-in-depth: a child frame in the same WebContents must not answer/trigger a privileged node install. */
import { registerWorkflowEngineHandlers } from "@main/ipc/workflowEngine.js";
import { IPC } from "@contracts/ipc";

let total = 0;
let failures = 0;
function check(name: string, passed: boolean, detail?: unknown): void {
  total++;
  if (!passed) { failures++; console.log("  FAIL " + name + " " + JSON.stringify(detail)); }
  else console.log("  ok   " + name);
}
const callbacks = new Map<string, (evt: unknown, raw?: unknown) => unknown>();
const ipc = { handle(ch: string, fn: (evt: unknown, raw?: unknown) => unknown) { callbacks.set(ch, fn); } };
const calls = { installs: 0, responses: 0 };
registerWorkflowEngineHandlers(ipc as never, {
  registry: { get: () => null, ids: () => [] },
  launchSpec: () => null,
  nodes: {
    list: async () => ({corrupt:null,nodes:[]}),
    install: async (_input, senderId) => {
      calls.installs++;
      return { ok: false as const, code: "approval_denied" as const, reason: String(senderId) };
    },
    respond: (_input, senderId) => {
      calls.responses++;
      return senderId === 17;
    },
  },
});
const mainFrame = { url: "file:///trusted/index.html" };
const sender = { id: 17, mainFrame };
const top = { sender, senderFrame: mainFrame };
const sub = { sender, senderFrame: { url: "file:///untrusted/frame.html" } };
const noFrame = { sender };
const install = { sourceDir: "C:/fixture/node", meta: { name:"fixture",version:"1.0.0",source:"local",sha256:"a".repeat(64),license:"MIT",capabilities:[] } };
const approval = { requestId: "fake-request-id", approved: true };
async function invoke(channel:string, event:unknown, raw:unknown): Promise<{ok:boolean;code?:string}> {
  return await callbacks.get(channel)!(event,raw) as {ok:boolean;code?:string};
}
check("子 frame 不得代主窗口申请安装", !(await invoke(IPC.WORKFLOW_ENGINE_NODE_INSTALL,sub,install)).ok && calls.installs===0, calls);
check("子 frame 即使有合法 requestId 也不能代答批准", !(await invoke(IPC.WORKFLOW_ENGINE_NODE_INSTALL_RESPOND,sub,approval)).ok && calls.responses===0, calls);
check("缺 senderFrame 时 fail-closed", !(await invoke(IPC.WORKFLOW_ENGINE_NODE_INSTALL_RESPOND,noFrame,approval)).ok && calls.responses===0, calls);
check("主 frame 仍可发起安装请求", (await invoke(IPC.WORKFLOW_ENGINE_NODE_INSTALL,top,install)).code==="approval_denied" && calls.installs===1, calls);
check("主 frame 仍可回答审批", (await invoke(IPC.WORKFLOW_ENGINE_NODE_INSTALL_RESPOND,top,approval)).ok && calls.responses===1, calls);
console.log("mc057-frame-origin-smoke:"+(total-failures)+"/"+total);
if (failures) process.exitCode=1;
