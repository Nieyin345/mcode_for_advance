/** T54: no real Electron dialogs/files/screens. Exercise the vendor IPC boundary. */
import { resolve, join } from 'node:path'
import type { Dialog, IpcMain } from 'electron'
import { createMcodePaneIpc, type McodePaneGuard } from '../../../../genoffice/apps/sheets/src/main/mcode-sheets-scoped'

let checks=0, failures=0
function check(name:string, okay:boolean, info?:unknown):void {
  checks++
  if(okay) console.log('  ok '+name)
  else { failures++; console.log('  FAIL '+name+' '+JSON.stringify(info)) }
}
const owner = { id: 19 }
const stranger = { id: 29 }
const root=resolve('T54-fixture-workspace')
const inside=join(root,'fixture.pptx')
const outside=resolve('T54-fixture-unauthorized','leak.pptx')
let picked=inside
const calls: string[]=[]
const events: string[]=[]
const handlers=new Map<string,(event:any,...args:any[])=>unknown>()
const bareIpc={
  handle(ch:string, fn:(event:any,...args:any[])=>unknown) { handlers.set(ch,fn) },
  removeHandler(ch:string) { handlers.delete(ch) },
  on(_ch:string,_fn:unknown) {},
} as unknown as IpcMain
const bareDialog={
  async showOpenDialog(){ return {canceled:false,filePaths:[picked]} },
  async showSaveDialog(){ return {canceled:false,filePath:picked} },
} as unknown as Dialog
const pathInside=(path:string)=>path===inside || path===root ||
  path.startsWith(root + (process.platform==='win32'?'\\':'/'))
const guard: McodePaneGuard={
  ownsSender(s) {return s===owner},
  containsPath(path){return pathInside(path)},
  documentPath(s){return s===owner?inside:null},
  audit(ch,group,outcome){events.push([group,ch,outcome].join(' '))},
}
const instances = ['sheets','slides'] as const
for(const kind of instances){
  const pane=createMcodePaneIpc(bareIpc,bareDialog,kind)
  pane.configure(guard)
  const invoke=async(channel:string,...args:unknown[])=>{
    const fn=handlers.get(channel)
    if(!fn)throw new Error('no handler '+channel)
    return fn({sender:owner},...args)
  }
  const rejected=async (channel:string,args:unknown[],reason:string)=>{
    try {await invoke(channel,...args);return false}
    catch(e){return String(e).includes(reason)}
  }
  const direct: Array<[string,(p:string)=>unknown[]]> = kind==='sheets'? [
    ['workbook:reopen',p=>[p]],
    ['workbook:open-for-merge',p=>[[p]]],
    ['shell:read-local-image',p=>[{path:p}]],
    ['sheets:files-add',p=>[[p]]],
    ['sheets:files-read-image',p=>[p]],
    ['workbook:save',p=>[{targetPath:p}]],
    ['workbook:export-csv',p=>[{targetPath:p}]],
    ['workbook:export-pdf',p=>[{outPath:p}]],
  ]: [
    ['slides:open-path',p=>[p,800]],
    ['slides:export-images',p=>[{dir:p,baseName:'slide',pngsBase64:[]}]],
    ['slides:export-pdf',p=>[{filePath:p}]],
    ['slides:add-media-bytes',p=>[{path:p}]],
  ]
  for(const [channel,argsFor] of direct){
    let count=0
    pane.ipcMain.handle(channel,()=>{count++;return 'allowed'})
    check(kind+' '+channel+' in root',await invoke(channel,...argsFor(inside))==='allowed')
    check(kind+' '+channel+' outside rejected',await rejected(channel,argsFor(outside),'工作区围栏'))
    check(kind+' '+channel+' rejected BEFORE original handler',count===1,{count})
  }
  const dialogs:string[]=kind==='sheets'?[
    'workbook:select','workbook:select-for-merge','sheets:files-pick',
  ]:[
    'slides:open','slides:save-as','slides:pick-export-dir',
    'slides:pick-export-pdf-path','slides:save-picture',
    'slides:edit-background','slides:edit-image-fill','slides:pick-picture-file',
    'slides:insert-image','slides:insert-media','slides:insert-model3d'
  ]
  for(const channel of dialogs){
    let finished=0
    pane.ipcMain.handle(channel,async()=>{
      await pane.dialog.showSaveDialog({})
      finished++
      return 'chosen'
    })
    picked=inside
    check(kind+' '+channel+' dialog inside',await invoke(channel)==='chosen')
    picked=outside
    check(kind+' '+channel+' dialog outside rejected',await rejected(channel,[],'工作区围栏'))
    check(kind+' '+channel+' no post-dialog side effect',finished===1,{finished})
  }
  if (kind==='slides') {
    const attack={dir:root,baseName:'../../T54-escape',pngsBase64:['fake']}
    check('A slides image export basename traversal rejected',
      await rejected('slides:export-images',[attack],'工作区围栏'))
    let saveCount=0
    pane.ipcMain.handle('slides:save',()=>{saveCount++;return 'saved'})
    check('A slides implicit save ties to host original path',await invoke('slides:save')==='saved')
    const previous=guard.documentPath
    guard.documentPath=()=>outside
    check('A slides implicit save refuses unauthorized original path',await rejected('slides:save',[],'工作区围栏'))
    guard.documentPath=previous
    check('A slides implicit outside path did not touch original',saveCount===1)
  }
  // The chosen file may be valid but the sender must still be owned.
  pane.ipcMain.handle('slides:open-path',()=>{calls.push('spoofed')})
  try {
    await handlers.get('slides:open-path')!({sender:stranger},inside)
    check(kind+' spoofed sender denied',false)
  } catch(e) {check(kind+' spoofed sender denied',String(e).includes('未授权'))}
  check(kind+' spoofing did not invoke original',!calls.includes('spoofed'))
  const blocked=kind==='sheets'?
    ['sheets:capture-screen-sources','sheets:capture-screen-source']:
    ['slides:font-install-local','slides:font-download','slides:save-recording','slides:microphone-access']
  for(const channel of blocked){
    let called=0
    pane.ipcMain.handle(channel,()=>{called++})
    check(kind+' '+channel+' readable rejection',await rejected(channel,[],'屏幕采集'))
    check(kind+' '+channel+' no hardware access',called===0)
  }
  if(kind==='sheets'){
    check('A sheets generated target derives from owner document',pane.defaultDocumentDirectory(owner)===inside)
    check('A sheets generated target refuses unowned pane',pane.defaultDocumentDirectory(stranger)===null)
    pane.ipcMain.handle('shell:open-external',()=> 'https-opened')
    check('C https external allowed',await invoke('shell:open-external','https://example.com')==='https-opened')
    check('C local file external denied',await rejected('shell:open-external',['file:///etc/passwd'],'HTTP/HTTPS'))
    pane.ipcMain.handle('workbook:print',()=>true)
    check('C print allowed',await invoke('workbook:print')===true)
  }else{
    pane.ipcMain.handle('slides:print',()=>true)
    pane.ipcMain.handle('slides:show-fullscreen',()=>true)
    check('C slides print allowed',await invoke('slides:print')===true)
    check('C slides fullscreen allowed',await invoke('slides:show-fullscreen',true)===true)
    check('A generated file source identity from owning pane',
      pane.defaultDocumentDirectory(owner)===inside&&pane.defaultDocumentDirectory(stranger)===null)
  }
}
// Validation must fail if the policy is removed by a mutation.
check('A violation was audited',events.some(e=>e.includes('A') && e.includes('denied')))
check('B rejection was audited',events.some(e=>e.includes('B') && e.includes('denied')))
check('C allowed was audited',events.some(e=>e.includes('C') && e.includes('allowed')))
console.log('genoffice-pane-fence-smoke: '+(checks-failures)+'/'+checks+' passed')
if(failures)process.exitCode=1
