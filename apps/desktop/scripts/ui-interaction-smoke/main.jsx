import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryExplorerPanel} from '@renderer/components/memory/MemoryExplorerPanel.js';
import {PlanApprovalPrompt} from '@renderer/components/chat/PlanApprovalPrompt.js';
import {ApprovalPrompt} from '@renderer/components/chat/ApprovalPrompt.js';
import {QuestionPrompt} from '@renderer/components/chat/QuestionPrompt.js';
import {CommandPalette} from '@renderer/components/layout/CommandPalette.js';
import {TurnBudgetPanel,FallbackModelsPanel} from '@renderer/components/settings/RuntimePolicyPanel.js';
import {MobileFilesScreen} from '@renderer/components/mobile/MobileFilesScreen.js';
import {Button} from '@renderer/components/ui/button.js';
import {Dialog} from '@renderer/components/ui/dialog.js';
import {Divider} from '@renderer/components/layout/Divider.js';
import {CustomModelsPanel} from '@renderer/components/settings/CustomModelsPanel.js';
const mode=new URLSearchParams(location.search).get('case')||'approval';
const theme=new URLSearchParams(location.search).get('theme')||'light';
document.documentElement.className=theme==='light'?'':theme;
const w=window;
// Stubs are initialized in a prior script by the test runner (no real IPC/network).
function App(){
 const [shown,setShown]=useState(true);
 const [ev,setEv]=useState([]);
 const emit=(s)=>{w.labEvents.push(s);setEv(v=>[...v,s]);};
 w.labUnmount=()=>setShown(false); w.labMount=()=>setShown(true);
 const questions=[{question:'请选择下一步操作',header:'操作',multiSelect:false,options:[{label:'继续',description:'继续执行当前任务'},{label:'暂停',description:'暂不执行'}]}];
 return <div className="h-screen overflow-auto bg-surface text-content">
  <header className="h-10 border-b border-edge px-4 flex items-center text-xs text-content-muted">MCode UI 审查 · 隔离组件 / Mock RPC · {mode}</header>
  {mode==='approval'&&<main className="p-6 mx-auto max-w-3xl">
   <h1 className="text-lg mb-3">当前会话 B</h1><input aria-label="B 会话输入" className="border p-2" placeholder="在当前会话按 Esc" />
   <div style={{display:'none'}}><ApprovalPrompt providerName="Agent A" toolName="Bash" input={{command:'echo audit'}} queuePosition={1} queueTotal={1} onDecide={(ok)=>emit(`hidden-A: ${ok?'allow':'deny'}`)}/></div>
   <p className="mt-4 text-xs">后台 A 保持挂载，等待审批。以下仅记录 mock 回调，不会执行命令。</p><pre className="mt-4 p-4 bg-surface-muted">{ev.join('\n')||'尚无审批操作'}</pre>
  </main>}
  {mode==='question'&&<main className="p-6 mx-auto max-w-3xl"><QuestionPrompt providerName="Agent" questions={questions} onSubmit={a=>emit('submit: '+JSON.stringify(a))} onDismiss={()=>emit('dismiss')}/><input aria-label="另一个界面的输入框" placeholder="与提问卡无关的输入框" className="border p-2"/><pre>{ev.join('\n')}</pre></main>}
  {mode==='memory'&&<main className="p-6 h-full">{shown&&<MemoryExplorerPanel/>}<button aria-label="离开设置" onClick={()=>setShown(false)}>Unmount test panel</button></main>}
  {mode==='plan'&&<main className="p-6"><PlanApprovalPrompt sessionId="A" plan="A plan" onViewPlan={()=>{}} onApprove={()=>emit('approved')} onReject={()=>emit('rejected')} onHandoff={()=>emit('handoff')}/></main>}
  {mode==='palette' &&<CommandPalette/>}
  {mode==='budget'&&<main className="p-6 mx-auto max-w-3xl space-y-4"><h1 className="text-lg">运行策略设置</h1>{shown&&<><TurnBudgetPanel/><FallbackModelsPanel/></>}<button onClick={()=>setShown(false)} className="border p-2" aria-label="离开设置">模拟立即切换设置页</button></main>}
  {mode.startsWith('mobile')&&<div style={{height:'calc(100vh - 40px)'}}><MobileFilesScreen/></div>}
  {mode==='primitives'&&<main className="p-6"><h1>共享组件</h1><Button variant="primary">保存</Button><Button variant="secondary">取消</Button><div className="flex h-40 mt-6"><div className="w-40">左侧</div>{shown&&<Divider orientation="vertical" onResize={d=>emit('resize: '+d)}/>}<div className="px-4">右侧</div></div><pre>{ev.join('\n')}</pre></main>}
  {mode==='dialog'&&<Dialog.Root open><Dialog.Portal><Dialog.Backdrop/><Dialog.Popup className="w-[360px] p-4"><Dialog.Title>设置示例</Dialog.Title><Dialog.Description>检查共享关闭按钮的可访问名称。</Dialog.Description><Dialog.Close/></Dialog.Popup></Dialog.Portal></Dialog.Root>}
  {mode==='models'&&<div className="h-screen overflow-auto bg-surface text-content"><CustomModelsPanel/></div>}
 </div>
}
createRoot(document.getElementById('root')).render(<App/>);
