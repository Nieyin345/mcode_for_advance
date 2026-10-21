import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, isAbsolute } from 'node:path'
import { PDFDocument } from '../../../../genoffice/node_modules/pdf-lib'
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
  const exportTempRoot = join(base, 't22-mcode-data', 'docs', 'export-tmp')
  mkdirSync(exportTempRoot, { recursive: true })
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
  let pdfPrints = 0
  let networkApprovals = 0
  let approveNetwork = false
  const samplePdf = await PDFDocument.create()
  samplePdf.addPage([595, 842])
  const pdfBytes = Buffer.from(await samplePdf.save())
  const safeText = join(root, 'attachment.txt')
  const outsideText = join(outside, 'secrets.txt')
  const oversizeText = join(root, 'too-big.txt')
  writeFileSync(safeText, Buffer.from('Alpha 中华\nBeta', 'utf8'))
  writeFileSync(outsideText, 'PRIVATE_CONTENT')
  writeFileSync(oversizeText, Buffer.alloc(20 * 1024 * 1024 + 1, 65))
  const ports: DocsPrivilegedPorts = {
    async pickFiles() { chooserCount++; return chosenFiles },
    async pickImage() { chooserCount++; return { base64: 'AQID', mime: 'image/png', name: 'pick.png' } },
    async pickDirectory() { chooserCount++; return chosenDir },
    async saveTarget() { saveCount++; return savedPath },
    async savePdfTarget() { return savedPath },
    exportTempRoot() { return exportTempRoot },
    async fetchApprovedImage() {
      networkApprovals++
      if (!approveNetwork) throw Error('Network image denied without user approval')
      return { mime: 'image/png', base64: Buffer.from([137,80,78,71,13,10,26,10]).toString('base64') }
    },
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
    const event = approved as { __ports?: DocsPrivilegedPorts; __print?: (cb: (ok: boolean, message?: string) => void) => void; printToPDF?: (arg: unknown) => Promise<Buffer> }
    event.__ports = ports
    let prints = 0
    event.__print = (cb) => { prints++; cb(true) }
    event.printToPDF = async () => { pdfPrints++; return pdfBytes }
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
      ['export-pdf', ['test.docx', 12240, 15840, outsideImage]],
      ['print-pdf-buffer', [12240, 15840]],
      ['save-merged-pdf', ['test.docx', [pdfBytes.toString('base64')], outsideImage]],
      ['files-read', [safeText, 0, 16]],
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
    savedPath = join(root, 'local-copy.png')
    const localCopy = await invoke('save-image-as', approved, safeImage) as {ok:boolean}
    check('T22 local image source fenced and accepted', localCopy.ok === true && existsSync(savedPath))
    const embedCopy = await invoke('save-image-as', approved, 'data:image/png;base64,AQID') as {ok:boolean}
    check('T22 data image source accepted', embedCopy.ok === true)
    const remoteNo = await invoke('save-image-as', approved, 'https://public.example/photo.png') as {ok:boolean;error?:string}
    check('T22 http(s) defaults to readable denial', remoteNo.ok === false && /denied/i.test(remoteNo.error ?? '') && networkApprovals === 1)
    approveNetwork = true
    const remoteYes = await invoke('save-image-as', approved, 'https://public.example/photo.png') as {ok:boolean}
    check('T22 explicit Mcode network approval can save image', remoteYes.ok === true && networkApprovals === 2)
    approveNetwork = false
    const beforePdfPrint = pdfPrints
    savedPath = join(outside, 'picker-outside.pdf')
    const pickerOutside = await invoke('export-pdf', approved, 'a.docx', 12240, 15840) as {ok:boolean;error?:string}
    check('T22 exportPdf disallows picker-selected path outside workspace before printing', pickerOutside.ok === false && !!pickerOutside.error && pdfPrints === beforePdfPrint)
    const noPdf = await invoke('export-pdf', approved, 'a.docx', 12240, 15840, join(outside, 'escape.pdf')) as {ok:boolean;error?:string}
    check('T22 exportPdf rejects unapproved outPath before Chromium', noPdf.ok === false && !!noPdf.error && pdfPrints === beforePdfPrint)
    savedPath = join(root, 'approved.pdf')
    const exported = await invoke('export-pdf', approved, 'a.docx', 12240, 15840) as {ok:boolean;path?:string}
    check('T22 exportPdf uses Chromium PDF bytes and Mcode picker/writer', exported.ok === true && exported.path === savedPath && readFileSync(savedPath).subarray(0, 5).toString() === '%PDF-')
    const pdfPart = await invoke('print-pdf-buffer', approved, 12240, 15840) as {ok:boolean;base64?:string}
    check('T22 printPdfBuffer returns original Chromium PDF bytes', pdfPart.ok === true && pdfPart.base64 === pdfBytes.toString('base64'))
    const merged = await invoke('save-merged-pdf', approved, 'a.docx', [pdfBytes.toString('base64')], savedPath) as {ok:boolean}
    check('T22 saveMergedPdf accepts only previously approved target', merged.ok === true && readFileSync(savedPath).subarray(0, 5).toString() === '%PDF-')

    const noDir = await invoke('pick-export-images-target', approved)
    check('T05b export target outside workspace refused', noDir === null)
    chosenDir = root
    const picked = await invoke('pick-export-images-target', approved) as { dir: string; pdfPath: string }
    check('T22 PDF export temporary file is inside Mcode data root', picked?.dir === root && picked.pdfPath.startsWith(exportTempRoot))
    const tempResult = await invoke('export-pdf', approved, 'x.docx', 12240, 15840, picked.pdfPath) as {ok:boolean}
    check('T22 image export uses authorized temp PDF in Mcode data root', tempResult.ok === true && readFileSync(picked.pdfPath).subarray(0,5).toString() === '%PDF-')
    const priorImageWrites = writes
    const rejectedImageWrite = await invoke('write-export-image', approved, outside, 'secret.png', 'AQID') as {ok: boolean;error?:string}
    check('T05b export image outside approved directory denied', rejectedImageWrite.ok === false && !!rejectedImageWrite.error && writes === priorImageWrites)
    const traversal = await invoke('write-export-image', approved, root, '../bad.png', 'AQID') as {ok: boolean}
    check('T05b export image traversal denied', traversal.ok === false && writes === priorImageWrites)
    const approvedImage = await invoke('write-export-image', approved, root, 'page.png', 'AQID') as {ok: boolean}
    check('T05b approved PNG uses atomic writer', approvedImage.ok === true && writes === priorImageWrites + 1)
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
    const textResult = await invoke('files-read', approved, safeText, 2, 4) as {ok:boolean;name?:string;offset?:number;totalChars?:number;text?:string}
    check('T22 files:read stable paged UTF-8 result', textResult.ok === true && textResult.name === 'attachment.txt' && textResult.offset === 2 && textResult.text === 'pha ' && (textResult.totalChars ?? 0) > 8)
    const textDenied = await invoke('files-read', approved, outsideText, 0, 50) as {ok:boolean;error?:string}
    check('T22 files:read rejects outside root without content leak', textDenied.ok === false && !!textDenied.error && !JSON.stringify(textDenied).includes('PRIVATE_CONTENT'))
    const oversized = await invoke('files-read', approved, oversizeText, 0, 10) as {ok:boolean;error?:string}
    check('T22 files:read rejects >20 MiB attachment before read', oversized.ok === false && /20 MiB/.test(oversized.error ?? ''))
    check('T05b no unauthorized file bytes read', readFileSync(outsideImage, 'utf8') === 'NOT_VISIBLE')
    delete event.printToPDF
    delete event.__ports
    delete event.__print
  })()
}
