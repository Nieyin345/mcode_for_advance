/** @smoke-covers src/main/document/documentViewHost.ts
 * T28: run against real host state machine with fake upstream factories.
 * All files live in an isolated temp worktree, never a user workspace.
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DocumentViewHost, type DocumentViewLike } from "@main/document/documentViewHost.js";

let total = 0, failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  total++;
  if (ok) console.log("  ok  " + name);
  else { failures++; console.error("  FAIL " + name, detail); }
}
const root = mkdtempSync(join(tmpdir(), "mcode-t28-native-"));
const outside = mkdtempSync(join(tmpdir(), "mcode-t28-outside-"));
const kinds = ["pdf", "markdown", "html", "sheets", "slides"] as const;
const bodies = ["%PDF-1.7\nT28 unchanged\n", "# T28 Markdown\n", "<p>T28 HTML</p>\n", "fixture XLSX bytes", "fixture PPTX bytes"];
try {
  for (const [idx, kind] of kinds.entries()) {
    const path = join(root, "sample." + ({ pdf:"pdf",markdown:"md",html:"html",sheets:"xlsx",slides:"pptx" } as const)[kind]);
    const outsidePath = join(outside, "outside." + kind);
    writeFileSync(path, bodies[idx]!);
    writeFileSync(outsidePath, "secret");
    let factoryCalls = 0, loadCalls = 0, closeCalls = 0, boundsCalls = 0, removes = 0, adds = 0;
    let sender: unknown;
    const factory = (p: string | null, k: typeof kind): DocumentViewLike => {
      factoryCalls++;
      check(kind + ": vendor gets exactly authorized initial file",p === path && k === kind);
      const wc = { id: 100 + idx, loadURL: (_: string) => { loadCalls++; }, focus() {}, close() { closeCalls++; },
        setWindowOpenHandler() {}, once() {}, on() {} };
      sender = wc;
      return { webContents: wc, setBounds() { boundsCalls++; } };
    };
    const child: unknown[] = [];
    const win = { contentView: { addChildView(v:unknown) { adds++;if (!child.includes(v)) child.push(v); }, removeChildView(v:unknown) {removes++;child.splice(child.indexOf(v), 1); } } };
    const host = new DocumentViewHost({getMainWindow:()=>win,createView:{vendor:factory},
      withinWorkspace: p => p.startsWith(root + (process.platform === "win32" ? "\\" : "/")) });
    const open = (docId:string,filePath:string) => host.open({
      docId,url:`genoffice-app://${kind}/index.html`,editor:kind,filePath,
      bounds:{x:1,y:2,width:300,height:200},visible:true,mcodeSessionId:"test-session",
    });
    check(kind + ": block path outside the workspace before factory",open("escape",outsidePath).ok === false && factoryCalls === 0);
    check(kind + ": open authorized native file",open("owner",path).ok === true && factoryCalls === 1);
    check(kind + ": no redundant host loadURL",loadCalls === 0);
    const bound = host.vendorAiContextForSender(sender);
    check(kind + ": AI context bound to host sender/file",bound?.filePath === path && bound?.sessionId === "test-session");
    check(kind + ": stranger cannot bind AI context",host.vendorAiContextForSender({id:99}) === null);
    check(kind + ": wrong file openPath denied",host.openPath("owner",outsidePath,()=>false).ok === false);
    const before = Buffer.from(readFileSync(path));
    host.hide("owner");host.show("owner");host.setBounds("owner",{x:42,y:30,width:450,height:230});
    check(kind + ": resize/hide/show preserves vendor view",factoryCalls === 1 && loadCalls === 0 && boundsCalls >= 3);
    host.close("owner");
    check(kind + ": native view released once",closeCalls === 1 && child.length === 0,{closeCalls,children:child.length,removes,adds});
    check(kind + ": open-unchanged-close is byte identical",before.equals(readFileSync(path)));
    host.dispose();
  }
} finally {
  rmSync(root,{recursive:true,force:true});
  rmSync(outside,{recursive:true,force:true});
}
console.log("genoffice-native-view-smoke:" + (total-failures) + "/" + total + " 通过");
if (failures) process.exitCode = 1;
