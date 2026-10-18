import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeFileSync} from 'node:fs';
import {withAuditPage} from './browser.mjs';
const here=dirname(fileURLToPath(import.meta.url)),checks=[];
const check=(name,pass,detail)=>{checks.push({name,pass,detail});console.log(`${pass?'PASS':'FAIL'} ${name}`);};
await withAuditPage(here,async page=>{
 try{
  await page.goto('','window.__ready');
  await page.waitFor('document.body.textContent.includes("Transcript")');
  const actual=await page.eval('!!document.querySelector("[data-markdown-preview=crepe-readonly] .milkdown .ProseMirror")');
  check('PDF context-menu transcript side preview uses real Milkdown/Crepe',actual);
  if(!actual)return;
  // 行内公式必须真的渲染出来。含 `$...$` 的转录是 MinerU 论文的常见形态，
  // 而 Crepe 的 mdast 链里 mdast-util-math 与 mdast-util-to-markdown 版本不匹配时，
  // 一碰行内公式就抛 "state.compilePattern is not a function"，整篇预览变成一行报错。
  check('inline math renders instead of erroring the whole preview',
    await page.eval('!!document.querySelector(".milkdown .ProseMirror [data-type=math_inline],.milkdown .ProseMirror .math-inline,.milkdown .ProseMirror .katex")'),
    await page.eval('document.body.innerText.slice(0,200)'));
  await page.waitFor('Array.from(document.querySelectorAll(".milkdown img")).filter(i=>i.complete&&i.naturalWidth>0).length>=2');
  check('transcript selection wins over original PDF filePath',await page.eval('__previewAudit.fileReads[0].which==="md"'));
  const reads=await page.eval('__previewAudit.imageReads');
  check('relative image reads resolve against actual transcription directory',reads.includes('C:/isolated/paper/images/figure 1.png'));
  check('reference-style image renders via library image proxy',reads.includes('C:/isolated/paper/images/ref.png'));
  check('image src becomes displayable data URL',await page.eval('Array.from(document.querySelectorAll(".milkdown img")).some(i=>i.src.startsWith("data:image/png")&&i.naturalWidth===1)'));
  check('Crepe is read-only',await page.eval('document.querySelector(".milkdown .ProseMirror").getAttribute("contenteditable")==="false"'));
  check('editing toolbar is absent',await page.eval('!document.querySelector("milkdown-top-bar")'));
  check('unreadable images produce visible status',await page.eval('!!document.querySelector("[role=status]")'));
  await page.send('Input.insertText',{text:'SHOULD_NOT_EDIT'});
  await page.sleep(500);
  check('preview does not write or normalize source to disk',await page.eval('__previewAudit.audit.writes.length===0&&!document.querySelector(".milkdown .ProseMirror").textContent.includes("SHOULD_NOT_EDIT")'));
  // 【MC-055】只读预览的表格是 content-first:短列紧凑、长列拿宽度,而不是 50/50。
  // 判据立在**真实布局**上(同一页面、真 Crepe CSS),不是在源码里 grep 一条 CSS。
  await page.eval(`(() => {
    const host = document.createElement("div");
    host.id = "table-fixture";
    host.className = "mcode-markdown-preview";
    host.style.cssText = "width: 860px; padding: 0;";
    host.innerHTML = '<div class="milkdown"><div class="editor"><div class="ProseMirror"><div class="tableWrapper"><table><tbody>'
      + '<tr><th><p>ID</p></th><th><p>' + "这是一段很长很长的说明文字,用来验证长列会按内容获得更多宽度而不是被平均分配".repeat(2) + '</p></th></tr>'
      + '<tr><td><p>1</p></td><td><p>短</p></td></tr>'
      + '</tbody></table></div></div></div></div>';
    document.body.appendChild(host);
  })()`);
  const tableLayout = await page.eval('getComputedStyle(document.querySelector("#table-fixture table")).tableLayout');
  check('★ [MC-055] 只读预览表格不是 fixed 等宽', tableLayout === 'auto', tableLayout);
  const widths = await page.eval('Array.from(document.querySelectorAll("#table-fixture th")).map(th => Math.round(th.getBoundingClientRect().width))');
  check('★ [MC-055] 短列明显小于长列(内容优先)', widths.length === 2 && widths[0] < widths[1] * 0.5, widths);
  const wrapperScrolls = await page.eval('getComputedStyle(document.querySelector("#table-fixture .tableWrapper")).overflowX');
  check('★ [MC-055] 超宽表格在块内横向滚动', wrapperScrolls === 'auto', wrapperScrolls);
  // `width: max-content` 的**行为**判据:自然宽度超过容器时表格真的伸出去,由 wrapper
  // 滚 —— 这与 `width: 100% + auto` 有本质区别(后者会把列压回收缩,永远不溢出不滚动)。
  await page.eval(`(() => {
    const t = document.querySelector("#table-fixture table");
    const cols = Array.from({ length: 8 }, (_, i) => '<th><p>' + '非常长的列标题文字'.repeat(4) + i + '</p></th>').join("");
    t.querySelector("thead") ?? t.insertAdjacentHTML("afterbegin", "<thead><tr>" + cols + "</tr></thead>");
  })()`);
  const overflow = await page.eval('(() => { const w = document.querySelector("#table-fixture .tableWrapper"); const t = document.querySelector("#table-fixture table"); return { table: Math.round(t.getBoundingClientRect().width), wrapper: Math.round(w.getBoundingClientRect().width), scrollable: w.scrollWidth > w.clientWidth }; })()');
  check('★ [MC-055] 宽表按内容伸出并可横向滚动(不是被压回 100%)', overflow.table > overflow.wrapper && overflow.scrollable, overflow);

  // ══════ [MC-055] 复现基线:可编辑侧(无 .mcode-markdown-preview 作用域)仍是
  // Crepe/ProseMirror 的 fixed + 100% —— 两列等宽。这就是台账登记的反例形态:
  // 修复前只读侧也吃这条规则,所以这里量到的就是"修复前"的行为。
  // ⚠️ 这条同时是**反向正控**:它必须**一直**是 fixed,证明只读侧的覆盖没有
  // 泄漏进编辑态(台账硬边界:不得让可编辑表格的手动列宽/光标行为倒退)。
  // 复现基线 A：**没有** colgroup 的两列表格 —— fixed 下两列各 50%。
  await page.eval(`(() => {
    const host = document.createElement("div");
    host.id = "table-fixture-editable";
    host.style.cssText = "width: 860px; padding: 0;";
    host.innerHTML = '<div class="milkdown"><div class="editor"><div class="ProseMirror" contenteditable="true"><div class="tableWrapper">'
      + '<table><tbody>'
      + '<tr><th><p>ID</p></th><th><p>' + "这是一段很长很长的说明文字,用来验证长列会按内容获得更多宽度而不是被平均分配".repeat(2) + '</p></th></tr>'
      + '<tr><td><p>1</p></td><td><p>短</p></td></tr>'
      + '</tbody></table></div></div></div></div>';
    document.body.appendChild(host);
  })()`);
  const editableLayout = await page.eval('getComputedStyle(document.querySelector("#table-fixture-editable table")).tableLayout');
  check('★ [MC-055] 复现基线:可编辑侧(无只读作用域)仍是 table-layout:fixed', editableLayout === 'fixed', editableLayout);
  const editableWidths = await page.eval('Array.from(document.querySelectorAll("#table-fixture-editable th")).map(th => Math.round(th.getBoundingClientRect().width))');
  check('★ [MC-055] 复现基线:fixed 下两列被强制等宽(台账反例形态)',
    editableWidths.length === 2 && Math.abs(editableWidths[0] - editableWidths[1]) <= 2, editableWidths);
  await page.eval('document.querySelector("#table-fixture-editable")?.remove()');

  // 复现基线 B：**带** colgroup 的可编辑表格 —— 手动列宽仍按 col 生效（fixed 语义）。
  await page.eval(`(() => {
    const host = document.createElement("div");
    host.id = "table-fixture-colgroup";
    host.style.cssText = "width: 860px; padding: 0;";
    host.innerHTML = '<div class="milkdown"><div class="editor"><div class="ProseMirror" contenteditable="true"><div class="tableWrapper">'
      + '<table><colgroup><col style="width:120px"><col></colgroup><tbody>'
      + '<tr><th><p>ID</p></th><th><p>' + "长列文本".repeat(20) + '</p></th></tr>'
      + '<tr><td><p>1</p></td><td><p>短</p></td></tr>'
      + '</tbody></table></div></div></div></div>';
    document.body.appendChild(host);
  })()`);
  const editableColgroup = await page.eval('(() => { const t = document.querySelector("#table-fixture-colgroup table"); const col = t.querySelector("colgroup col"); return { cols: t.querySelectorAll("colgroup col").length, firstCol: col ? Math.round(col.getBoundingClientRect().width) : null, firstTh: Math.round(t.querySelector("th").getBoundingClientRect().width) }; })()');
  check('★ [MC-055] 可编辑侧 colgroup 保留且手动列宽生效(fixed 语义未被动)',
    editableColgroup.cols === 2 && Math.abs(editableColgroup.firstCol - 120) <= 2 && Math.abs(editableColgroup.firstTh - 120) <= 2, editableColgroup);
  await page.eval('document.querySelector("#table-fixture-colgroup")?.remove()');

  // ══════ [MC-055] 健康路径:单列表格在只读作用域下不被自动布局弄坏 ——
  // 仍铺满容器(min-width:100%),不横向溢出,列宽≈表宽。
  await page.eval(`(() => {
    const host = document.createElement("div");
    host.id = "table-fixture-single";
    host.className = "mcode-markdown-preview";
    host.style.cssText = "width: 860px; padding: 0;";
    host.innerHTML = '<div class="milkdown"><div class="editor"><div class="ProseMirror"><div class="tableWrapper">'
      + '<table><tbody><tr><th><p>单列</p></th></tr><tr><td><p>只有一列的内容</p></td></tr></tbody></table>'
      + '</div></div></div></div>';
    document.body.appendChild(host);
  })()`);
  const single = await page.eval('(() => { const t = document.querySelector("#table-fixture-single table"); const w = document.querySelector("#table-fixture-single .tableWrapper"); const th = t.querySelector("th"); return { layout: getComputedStyle(t).tableLayout, table: Math.round(t.getBoundingClientRect().width), wrapper: Math.round(w.getBoundingClientRect().width), cell: Math.round(th.getBoundingClientRect().width), scrollable: w.scrollWidth > w.clientWidth }; })()');
  check('★ [MC-055] 健康路径:单列表格仍铺满容器、不横向溢出',
    single.layout === 'auto' && Math.abs(single.table - single.wrapper) <= 1 && !single.scrollable, single);
  check('★ [MC-055] 健康路径:单列单元格撑满表宽', Math.abs(single.cell - single.table) <= 1, single);
  await page.eval('document.querySelector("#table-fixture-single")?.remove()');
  await page.eval('document.querySelector("#table-fixture")?.remove()');
  await page.eval('__switchPreview("second")');
  await page.waitFor('__previewAudit.imageReads.includes("C:/isolated/second/images/ref.png")');
  check('switching document changes image base without stale editor',await page.eval('document.querySelectorAll(".milkdown .ProseMirror").length===1'));
  check('source image references remain unchanged',await page.eval('__previewAudit.doc.includes("images/figure%201.png?rev=1#part")&&__previewAudit.audit.writes.length===0'));
 }finally{writeFileSync(join(here,'result.json'),JSON.stringify({checks},null,2));await page.screenshot('markdown-preview.png');}
});

// ══════ [MC-055] 第二条只读管线:聊天/工作区预览走**真** `chat/Markdown`
// （react-markdown，Tailwind 任意值类）。与资料库 Crepe 只读必须同语义
// （content-first）—— 同页重新导航带 `?chat=1`，量真实计算宽度。
await withAuditPage(here,async page=>{
 try{
  await page.goto('chat=1','window.__ready && document.querySelector("#chat-fixture table")');
  const chatLayout = await page.eval('getComputedStyle(document.querySelector("#chat-fixture table")).tableLayout');
  check('★ [MC-055] 聊天只读预览表格不是 fixed 等宽(与资料库同语义)', chatLayout === 'auto', chatLayout);
  const chatWidths = await page.eval('Array.from(document.querySelectorAll("#chat-fixture thead th, #chat-fixture tbody tr:first-child th")).slice(0,2).map(th => Math.round(th.getBoundingClientRect().width))');
  check('★ [MC-055] 聊天只读:短列明显小于长列(内容优先)', chatWidths.length === 2 && chatWidths[0] < chatWidths[1] * 0.5, chatWidths);
  const chatSingle = await page.eval('(() => { const tables = document.querySelectorAll("#chat-fixture table"); const t = tables[tables.length - 1]; const th = t.querySelector("th"); return { layout: getComputedStyle(t).tableLayout, table: Math.round(t.getBoundingClientRect().width), cell: Math.round(th.getBoundingClientRect().width) }; })()');
  check('★ [MC-055] 聊天只读健康路径:单列表格铺满且单元格撑满', chatSingle.layout === 'auto' && Math.abs(chatSingle.cell - chatSingle.table) <= 2, chatSingle);
  const chatOverflow = await page.eval('(() => { const wrap = document.querySelector("#chat-fixture table").parentElement; return getComputedStyle(wrap).overflowX; })()');
  check('★ [MC-055] 聊天只读:超宽表格由 overflow-x-auto 包装层承接', chatOverflow === 'auto', chatOverflow);
 }finally{writeFileSync(join(here,'result-chat.json'),JSON.stringify({checks:checks.slice()},null,2));await page.screenshot('markdown-preview-chat.png');}
});
if(checks.length<12||checks.some(c=>!c.pass))process.exitCode=1;
