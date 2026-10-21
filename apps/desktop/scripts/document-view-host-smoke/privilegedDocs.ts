import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, isAbsolute } from 'node:path'
import type { DocsPrivilegedPorts } from '../../../../genoffice/apps/docs/src/main/mcode-privileged'

export async function runPrivilegedBoundarySmoke(
  handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>,
  approved: object,
  forged: object,
  base: string,
  check: (description: string, actual: unknown) => void,
): Promise<void> {
  const root = join(base, 't05b-workspace')
  const outside = join(base, 't05b-outside')
  mkdirSync(root, { recursive: true })
  mkdirSync(outside, { recursive: true })
  const safeImage = join(root, 'safe.png')
  const outsideImage = join(outside, 'secret.png')
  writeFileSync(safeImage, Buffer.from([137,80,78,71,13,10,26,10]))
  writeFileSync(outsideImage, Buffer.from('NOT_VISIBLE'))
  let chooserCount = 0
  let saveCount = 0
  let writes = 0
  let confirmations = 0
  let permission = false
  let savedPath = outsideImage
  let chosenDir = outside
  let chosenFiles = [safeImage]
  const ports: DocsPrivilegedPorts = {
    async pickFiles() { chooserCount++; return chosenFiles },
    async pickImage() { chooserCount++; return { base64: 'AQID', mime: 'image/png', name: 'pick.png' } },
    async pickDirectory() { chooserCount++; return chosenDir },
    async saveTarget() { saveCount++; return savedPath },
    async confirmPrint() { confirmations++; return permission },
    workspaceRoot(_path) {
      // Intentionally coarse *fake* lookup: physical containment must be an
      // independent check even when the caller supplies a dishonest root.
      return root
    },
    async atomicWrite(path, bytes) { writes++; writeFileSync(path, bytes) },
    async removeExportTemp(path) { const { unlinkSync } = await import('node:fs'); unlinkSync(path) },
  }
  const invoke = (name: string, sender: object, ...args: unknown[]) =>
    handlers.get('mcode:docs:privileged-' + name)!({ sender }, ...args)

  // Add an authorized owner's ports via the registerDocsIpc callback under
  // test. No renderer argument may ever manufacture that callback.
  return await (async () => {
    const event = approved as { __ports?: DocsPrivilegedPorts; __print?: (cb: (ok: boolean, message?: string) => void) => void }
    event.__ports = ports
    let prints = 0
    event.__print = (cb) => { prints++; cb(true) }
    const beforeChoosers = chooserCount
    for (const [name, args] of [
      ['pick-image', []],
      ['save-image-as', ['data:image/png;base64,AQID']],
      ['pick-export-images-target', []],
      ['take-export-pdf', [outsideImage]],
      ['printers', []],
      ['print', []],
      ['files-pick', []],
      ['files-add', [[safeImage]]],
      ['files-read-image', [safeImage]],
      ['write-export-image', [outside, 'a.png', 'AQID']],
    ] as Array<[string, unknown[]]>) {
      const result = await invoke(name, forged, ...args)
      check('T05b unauthorized sender denied: ' + name,
        result && typeof result === 'object' && (result as {ok?: unknown}).ok === false)
    }
    check('T05b sender denied before OS dialog/read/write/print', chooserCount === beforeChoosers && writes === 0 && prints === 0)

    const rejectedSave = await invoke('save-image-as', approved, 'data:image/png;base64,AQID') as { ok: boolean; error?: string }
    check('T05b save-image-as outside root denied with reason', rejectedSave.ok === false && !!rejectedSave.error && writes === 0 && saveCount === 1)
    const invalid = await invoke('save-image-as', approved, 'file:///secret.png') as {ok: boolean; error?: string}
    check('T05b remote/filename image source denied before dialog', invalid.ok === false && !!invalid.error && saveCount === 1)
    savedPath = join(root, 'export.png')
    const saved = await invoke('save-image-as', approved, 'data:image/png;base64,AQID') as {ok: boolean}
    check('T05b authorized save uses injected atomic writer', saved.ok === true && writes === 1 && existsSync(savedPath))

    const noDir = await invoke('pick-export-images-target', approved)
    check('T05b export target outside workspace refused', noDir === null)
    chosenDir = root
    const picked = await invoke('pick-export-images-target', approved) as { dir: string; pdfPath: string }
    check('T05b approved directory grants only scoped workspace target', picked?.dir === root && picked.pdfPath.startsWith(root))
    const rejectedImageWrite = await invoke('write-export-image', approved, outside, 'secret.png', 'AQID') as {ok: boolean;error?:string}
    check('T05b export image outside approved directory denied', rejectedImageWrite.ok === false && !!rejectedImageWrite.error && writes === 1)
    const traversal = await invoke('write-export-image', approved, root, '../bad.png', 'AQID') as {ok: boolean}
    check('T05b export image traversal denied', traversal.ok === false && writes === 1)
    const approvedImage = await invoke('write-export-image', approved, root, 'page.png', 'AQID') as {ok: boolean}
    check('T05b approved PNG uses atomic writer', approvedImage.ok === true && writes === 2)
    const wrongPdf = await invoke('take-export-pdf', approved, outsideImage) as {ok: boolean;error?:string}
    check('T05b arbitrary PDF path cannot be read', wrongPdf.ok === false && !!wrongPdf.error)
    writeFileSync(picked.pdfPath, Buffer.from('SYNTHETIC_PDF'))
    // Each pick issues a one-shot token; wrong-path attempts consume it.
    const nextPick = await invoke('pick-export-images-target', approved) as {pdfPath: string}
    writeFileSync(nextPick.pdfPath, Buffer.from('SYNTHETIC_PDF'))
    const read = await invoke('take-export-pdf', approved, nextPick.pdfPath) as {ok: boolean;base64?:string}
    check('T05b only issued PDF temp can be read', read.ok === true && read.base64 === Buffer.from('SYNTHETIC_PDF').toString('base64') && !existsSync(nextPick.pdfPath))

    const unauthorizedAdd = await invoke('files-add', approved, [outsideImage]) as {accepted:unknown[];rejected:string[]}
    check('T05b drag-drop path outside workspace refused', unauthorizedAdd.accepted.length === 0 && unauthorizedAdd.rejected.length === 1)
    const permittedAdd = await invoke('files-add', approved, [safeImage]) as {accepted:unknown[]}
    check('T05b workspace attachment admitted', permittedAdd.accepted.length === 1)
    const refusedRead = await invoke('files-read-image', approved, outsideImage) as {ok:boolean;error?:string}
    check('T05b image read outside workspace refused without bytes', refusedRead.ok === false && !!refusedRead.error && !JSON.stringify(refusedRead).includes('NOT_VISIBLE'))
    const validRead = await invoke('files-read-image', approved, safeImage) as {ok:boolean;base64?:string}
    check('T05b workspace image read accepted', validRead.ok && !!validRead.base64)
    chosenFiles = [outsideImage]
    const chosen = await invoke('files-pick', approved) as {accepted:unknown[]}
    check('T05b existing picker explicitly grants chosen external attachment', chosen.accepted.length === 1 && chooserCount >= 3)
    const addedPicked = await invoke('files-add', approved, [outsideImage]) as {accepted:unknown[]}
    check('T05b user-picked file grant reused on add only', addedPicked.accepted.length === 1)
    const pickedImage = await invoke('pick-image', approved) as {name:string}
    check('T05b image picker delegates Mcode existing picker port', pickedImage.name === 'pick.png')

    const printers = await invoke('printers', approved) as Array<Record<string, unknown>>
    check('T05b printer enumeration contains only UI names and no host inventory',
      printers.length === 1 && printers[0].name === 'fake-queue' && Object.keys(printers[0]).length === 2)
    permission = false
    const deniedPrint = await invoke('print', approved, 1) as {ok:boolean;error?:string}
    check('T05b no print unless user confirms each call', deniedPrint.ok === false && !!deniedPrint.error && prints === 0 && confirmations === 1)
    permission = true
    const okayPrint = await invoke('print', approved, 1) as {ok:boolean}
    check('T05b confirmed print can reach Chromium', okayPrint.ok === true && prints === 1 && confirmations === 2)
    permission = false
    await invoke('print', approved, 1)
    check('T05b prior confirmation never reused', prints === 1 && confirmations === 3)
    check('T05b no unauthorized file bytes read', readFileSync(outsideImage, 'utf8') === 'NOT_VISIBLE')
    delete event.__ports
    delete event.__print
  })()
}
