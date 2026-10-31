/** B-02: actual markdownPreview through stubbed library DB/paths; no user files. */
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, renameSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readMarkdownForPreview } from "../../src/main/library/markdownPreview.js";
import { setRoot, putItem } from "./stubs.js";
const work=mkdtempSync(join(tmpdir(),"mcode-md-secure-preview-"));
const root=join(work,"library");
const docs=join(root,"markdown");
const outside=join(work,"outside");
mkdirSync(docs,{recursive:true});
mkdirSync(outside);
const record=(id:string,rel:string)=>putItem(id,{mdPath:rel});
let count=0;
function check(name:string,yes:boolean) {assert.ok(yes,name);console.log("PASS "+name);count++}
try {
 setRoot(root);
 const good=join(docs,"good.md");
 const image=join(docs,"small.png");
 writeFileSync(image,Buffer.from([137,80,78,71,13,10,26,10]));
 writeFileSync(good,"# Good\n![](small.png)\n");
 record("good","markdown/good.md");
 const valid=await readMarkdownForPreview("good");
 check("legitimate Markdown preview is readable",valid.ok&&valid.markdown.includes("# Good"));
 check("legitimate small image inlined",valid.images["small.png"]?.startsWith("data:image/png;base64,")===true);

 const secret=join(outside,"private.png");
 writeFileSync(secret,Buffer.from("SENSITIVE_TEST_ONLY"));
 const mdLink=join(docs,"escape.md");
 writeFileSync(join(outside,"private.md"),"DO_NOT_READ_OUTSIDE");
 try {
   symlinkSync(join(outside,"private.md"),mdLink,"file");
   record("link","markdown/escape.md");
   check("symlinked Markdown target outside library rejected",!(await readMarkdownForPreview("link")).ok);
 } catch(error) {
   if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
   console.log("SKIP Windows account does not permit file symlink creation (Markdown)");
 }
 const links=join(docs,"refs.md");
 writeFileSync(links,"![x](escape.png)\n");
 try {
   symlinkSync(secret,join(docs,"escape.png"),"file");
   record("image-link","markdown/refs.md");
   const imageEsc=await readMarkdownForPreview("image-link");
   check("symlinked image target outside Markdown root refused",imageEsc.ok&&!imageEsc.images["escape.png"]&&imageEsc.skipped.includes("escape.png"));
 } catch(error) {
   if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
   console.log("SKIP Windows account does not permit file symlink creation (image)");
 }

 // Windows junctions normally do not need Developer Mode; use them to
 // exercise ancestor directory aliases when file symlink creation is denied.
 const junction=join(docs,"outside-junction");
 try {
   symlinkSync(outside,junction,"junction");
   record("junction-md","markdown/outside-junction/private.md");
   check("outside-directory junction cannot serve Markdown",!(await readMarkdownForPreview("junction-md")).ok);
   const imageJunction=join(docs,"junction-ref.md");
   writeFileSync(imageJunction,"![](outside-junction/private.png)\n");
   record("junction-img","markdown/junction-ref.md");
   const jr=await readMarkdownForPreview("junction-img");
   check("outside-directory junction image never inlined",jr.ok&&jr.skipped.length===1&&Object.keys(jr.images).length===0);
 } catch(error) {
   if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
   console.log("SKIP OS denies creation of directory junction");
 }
 // Even an in-library junction is rejected in a referenced image's ancestor
 // chain. Lexical and physical containment alone would accept this alias.
 const assets=join(docs,"assets");
 mkdirSync(assets);
 writeFileSync(join(assets,"real.png"),Buffer.from("INTERNAL_ASSET"));
 const alias=join(docs,"assets-alias");
 try {
   symlinkSync(assets,alias,process.platform==="win32"?"junction":"dir");
   const aliasMd=join(docs,"alias-image.md");
   writeFileSync(aliasMd,"![](assets-alias/real.png)\\n");
   record("alias-image","markdown/alias-image.md");
   const aliasResult=await readMarkdownForPreview("alias-image");
   check("nested directory alias is rejected even when its target stays inside the library",
     aliasResult.ok&&!aliasResult.images["assets-alias/real.png"]&&aliasResult.skipped.includes("assets-alias/real.png"));
 } catch(error) {
   if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
   console.log("SKIP OS denies creation of internal directory alias");
 }
 const jumboMd=join(docs,"oversized.md");
 writeFileSync(jumboMd,"X".repeat(20*1024*1024));
 record("huge","markdown/oversized.md");
 check("huge Markdown must not load unbounded text into IPC",!(await readMarkdownForPreview("huge")).ok);
 const jumboImage=join(docs,"huge.png");
 writeFileSync(jumboImage,Buffer.alloc(9*1024*1024));
 const imageDoc=join(docs,"with-large.md");
 writeFileSync(imageDoc,"![](huge.png)\n");
 record("large-img","markdown/with-large.md");
 const oversized=await readMarkdownForPreview("large-img");
 check("image over 8 MiB skipped",oversized.ok&&!oversized.images["huge.png"]&&oversized.skipped.includes("huge.png"));
 // Per-file images may each fit under 8 MiB, but their base64 data URLs
 // must not exceed the aggregate 12 MiB IPC budget.
 const multi=join(docs,"multi.md");
 writeFileSync(join(docs,"first.png"),Buffer.alloc(7*1024*1024));
 writeFileSync(join(docs,"second.png"),Buffer.alloc(7*1024*1024));
 writeFileSync(multi,"![](first.png)\n![](second.png)\n");
 record("multi","markdown/multi.md");
 const capped=await readMarkdownForPreview("multi");
 check("aggregate image payload stays below 12 MiB",capped.ok&&Object.values(capped.images).reduce((n,v)=>n+v.length,0)<=12*1024*1024);
 check("second image exceeding total 12 MiB is explicitly skipped",capped.ok&&capped.skipped.includes("second.png"));
 const escapeMd=join(docs,"dotdot.md");
 writeFileSync(escapeMd,"![](../../outside/private.png)\n");
 record("traverse","markdown/dotdot.md");
 const traverse=await readMarkdownForPreview("traverse");
 check("lexically escaping image skipped",traverse.ok&&traverse.skipped.length===1);
 // Replacing the library root with an outside junction must not make the
 // dynamically-resolved pathWithin(root, target) trust an attacker root.
 // The outside directory contains a valid Markdown leaf to expose the old bug.
 const movedRoot=join(work,"library-original");
 renameSync(root,movedRoot);
 try {
   symlinkSync(outside,root,process.platform==="win32"?"junction":"dir");
   record("swapped-root","private.md");
   const swappedRootPreview=await readMarkdownForPreview("swapped-root");
   check("replaced library root cannot authorize an outside Markdown document",!swappedRootPreview.ok);
 } catch(error) {
   if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
   console.log("SKIP OS denies creation of library root junction");
 }
 console.log("markdown-preview-security-smoke: "+count+"/"+count+" PASS");
}finally{rmSync(work,{recursive:true,force:true})}
