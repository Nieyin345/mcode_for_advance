import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { ConsoleTextDecoder } from "@main/lib/outBuf.js";

export type AgentPdfOperation =
  | { type: "delete"; pageIndexes: number[] }
  | { type: "insert"; pageIndex: number; markdown?: string; sourcePdfPath?: string };

interface Captured {
  stdout: string;
  stderr: string;
  code: number | null;
}

let pythonExecutablePromise: Promise<string | null> | null = null;

function runCaptured(exe: string, args: string[], timeoutMs = 120_000, env?: NodeJS.ProcessEnv): Promise<Captured> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...(env ? { env: { ...process.env, ...env } } : {}) });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const cap = 4 * 1024 * 1024;
    // 每条流**各一份**流式解码器 —— `data` 给的是字节块,边界能落在多字节字符中间,
    // 逐块 `toString("utf8")` 会把那个字符切成两半、各自变 U+FFFD(整份输出从此损坏)。
    // 别在数据里存半个字符,与 `agentTools.ts` / `agentProcessSessions.ts` 的孪生同款:
    // 用共享的 ConsoleTextDecoder(顺带也扛中文 Windows 上 cmd 的 GBK 输出)。
    const outDec = new ConsoleTextDecoder();
    const errDec = new ConsoleTextDecoder();
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      reject(new Error(`${exe} 超过 ${timeoutMs}ms 没结束`));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => { if (stdout.length < cap) stdout += outDec.write(d); });
    child.stderr.on("data", (d: Buffer) => { if (stderr.length < cap) stderr += errDec.write(d); });
    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 进程结束时解码器里可能还压着最后半个字符 —— 吐出来。
      if (stdout.length < cap) stdout += outDec.end();
      if (stderr.length < cap) stderr += errDec.end();
      resolve({ stdout, stderr, code });
    });
  });
}

async function findPythonExecutable(): Promise<string | null> {
  if (!pythonExecutablePromise) {
    pythonExecutablePromise = (async () => {
      const candidates = process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"];
      for (const exe of candidates) {
        try {
          const out = await runCaptured(exe, ["-c", "import sys;print(sys.executable)"], 5_000);
          if (out.code === 0 && out.stdout.trim()) return exe;
        } catch {
          // try next candidate
        }
      }
      return null;
    })();
  }
  return pythonExecutablePromise;
}

async function requirePython(): Promise<string> {
  const py = await findPythonExecutable();
  if (!py) throw new Error("这个文档操作需要 Python；当前 PATH 里没有可用的 python/python3/py");
  return py;
}

/**
 * 交给 Python 子进程的环境变量 —— **强制它按 UTF-8 输出**。
 *
 * 这里是 `agentTools.ts`(`PYTHON_DOCUMENT_ENV`)那份的孪生。`runCaptured` 只把
 * `stdout`/`stderr` 当 **UTF-8** 解码(`d.toString("utf8")`),可 Python 默认按**系统
 * 代码页**写重定向流 —— 中文 Windows 上是 **GBK**。于是同一份文档工具,`agentTools`
 * 那条(早已强制 UTF-8)读得对,DOCX XML / Excel 这条(DOCX 正文、sheet 名、错误消息)
 * 却是一串 U+FFFD:`DOCX part 里带中文 → 拿回去是乱码`,带 emoji 时更直接
 * `UnicodeEncodeError` 让整个操作失败。(2026-10-10 审查发现,与 866815e5 漏改的这一处同型。)
 *
 * `errors.replace` 只是兜底,真正的修法是让 Python **别用 GBK 写**。只改我们自己起的
 * 子进程环境,**绝不**动 `process.env`、也不改任意 shell 命令的编码。
 */
const PYTHON_DOCUMENT_ENV = { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };

function tempPath(ext: string): string {
  return path.join(tmpdir(), `mcode-agent-${randomUUID()}${ext}`);
}

async function assertNewOutput(abs: string, source?: string): Promise<void> {
  if (source && path.resolve(abs) === path.resolve(source)) {
    throw new Error("输出文件不能覆盖原文件；请换一个 output_path");
  }
  try {
    await fs.access(abs);
    throw new Error(`输出文件已存在:${abs}；为避免误覆盖，请使用新的文件名`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

async function renderMarkdownPdf(markdown: string, outputPath: string): Promise<void> {
  const mdPath = tempPath(".md");
  try {
    await fs.writeFile(mdPath, markdown, "utf8");
    const first = await runCaptured(
      "pandoc",
      [mdPath, "-o", outputPath, "--pdf-engine=xelatex", "-V", "geometry:margin=22mm"],
      120_000,
    ).catch((err) => ({ stdout: "", stderr: err instanceof Error ? err.message : String(err), code: -1 }));
    if (first.code === 0) return;

    const py = await findPythonExecutable();
    if (!py) {
      throw new Error(`pandoc 生成 PDF 失败，且没有 Python/Pillow 兜底:${first.stderr.trim()}`);
    }
    const fallback = [
      "import sys,re,textwrap",
      "from pathlib import Path",
      "try:",
      " from PIL import Image,ImageDraw,ImageFont",
      "except Exception as e:",
      " print('缺少 Pillow:'+str(e),file=sys.stderr);sys.exit(2)",
      "src,out=sys.argv[1],sys.argv[2]",
      "text=Path(src).read_text(encoding='utf-8')",
      "text=re.sub(r'<[^>]+>',' ',text)",
      "text=re.sub(r'^[#>*+-]+\\s*','',text,flags=re.M)",
      "text=re.sub(r'`{1,3}','',text)",
      "font=None",
      "candidates=[r'C:\\Windows\\Fonts\\msyh.ttc',r'C:\\Windows\\Fonts\\simhei.ttf','/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']",
      "for f in candidates:",
      " try:",
      "  if Path(f).exists(): font=ImageFont.truetype(f,28);break",
      " except Exception: pass",
      "font=font or ImageFont.load_default()",
      "pages=[]; lines=[]",
      "for raw in text.splitlines():",
      " if not raw: lines.append(''); continue",
      " lines.extend(textwrap.wrap(raw,width=55,replace_whitespace=False,drop_whitespace=False) or [''])",
      "per=42",
      "for i in range(0,max(1,len(lines)),per):",
      " im=Image.new('RGB',(1240,1754),'white'); d=ImageDraw.Draw(im); y=90",
      " for line in lines[i:i+per]: d.text((90,y),line,fill='black',font=font); y+=38",
      " pages.append(im)",
      "pages[0].save(out,save_all=True,append_images=pages[1:],resolution=150.0)",
    ].join("\n");
    const second = await runCaptured(py, ["-c", fallback, mdPath, outputPath], 120_000, PYTHON_DOCUMENT_ENV);
    if (second.code !== 0) {
      throw new Error(`PDF 生成失败。pandoc:${first.stderr.trim()}；Pillow:${second.stderr.trim()}`);
    }
  } finally {
    await fs.rm(mdPath, { force: true }).catch(() => undefined);
  }
}

export async function writePdf(input: {
  sourcePath?: string;
  outputPath: string;
  markdown?: string;
  operations?: AgentPdfOperation[];
}): Promise<{ outputPath: string; pageCount: number }> {
  const out = path.resolve(input.outputPath);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await assertNewOutput(out, input.sourcePath);

  if (typeof input.markdown === "string") {
    if (input.sourcePath || input.operations) throw new Error("创建 PDF 时只传 markdown + output_path");
    await renderMarkdownPdf(input.markdown, out);
    return { outputPath: out, pageCount: await pdfPageCount(out) };
  }

  if (!input.sourcePath || !input.operations) {
    throw new Error("修改 PDF 需要 source_path + operations + output_path");
  }
  const source = path.resolve(input.sourcePath);
  const sourceStat = await fs.stat(source).catch(() => null);
  if (!sourceStat?.isFile()) throw new Error(`源 PDF 不存在:${source}`);

  const tempPdfs: string[] = [];
  try {
    const normalized: Array<{ type: string; pageIndexes?: number[]; pageIndex?: number; sourcePdfPath?: string }> = [];
    for (const op of input.operations) {
      if (op.type === "delete") {
        normalized.push({ type: "delete", pageIndexes: op.pageIndexes });
        continue;
      }
      const hasMarkdown = typeof op.markdown === "string";
      const hasSource = typeof op.sourcePdfPath === "string" && op.sourcePdfPath.trim().length > 0;
      if (hasMarkdown === hasSource) throw new Error("PDF insert 必须且只能提供 markdown 或 sourcePdfPath 之一");
      if (hasMarkdown) {
        const temp = tempPath(".pdf");
        tempPdfs.push(temp);
        await renderMarkdownPdf(op.markdown ?? "", temp);
        normalized.push({ type: "insert", pageIndex: op.pageIndex, sourcePdfPath: temp });
      } else {
        normalized.push({ type: "insert", pageIndex: op.pageIndex, sourcePdfPath: path.resolve(op.sourcePdfPath!) });
      }
    }

    const py = await requirePython();
    const opsPath = tempPath(".json");
    try {
      await fs.writeFile(opsPath, JSON.stringify(normalized), "utf8");
      const script = [
        "import sys,json",
        "try:",
        " from pypdf import PdfReader,PdfWriter",
        "except Exception as e:",
        " print('缺少 pypdf:'+str(e),file=sys.stderr);sys.exit(2)",
        "src,dst,opsf=sys.argv[1:4]",
        "ops=json.load(open(opsf,encoding='utf-8'))",
        "keepers=[]",
        "main=PdfReader(src); keepers.append(main); pages=list(main.pages)",
        "for op in ops:",
        " if op['type']=='delete':",
        "  idx=sorted(set(int(i) for i in op.get('pageIndexes',[])),reverse=True)",
        "  for i in idx:",
        "   if i<0 or i>=len(pages): raise ValueError(f'delete page index {i} out of range 0..{len(pages)-1}')",
        "   del pages[i]",
        " elif op['type']=='insert':",
        "  at=int(op['pageIndex'])",
        "  if at<0 or at>len(pages): raise ValueError(f'insert page index {at} out of range 0..{len(pages)}')",
        "  r=PdfReader(op['sourcePdfPath']); keepers.append(r); pages[at:at]=list(r.pages)",
        " else: raise ValueError('unknown PDF operation: '+str(op.get('type')))",
        "w=PdfWriter()",
        "for p in pages: w.add_page(p)",
        "with open(dst,'xb') as f: w.write(f)",
        "print(len(pages))",
      ].join("\n");
      const res = await runCaptured(py, ["-c", script, source, out, opsPath], 120_000, PYTHON_DOCUMENT_ENV);
      if (res.code !== 0) {
        await fs.rm(out, { force: true }).catch(() => undefined);
        throw new Error(`修改 PDF 失败:${res.stderr.trim() || res.stdout.trim()}`);
      }
      return { outputPath: out, pageCount: Number.parseInt(res.stdout.trim(), 10) || await pdfPageCount(out) };
    } finally {
      await fs.rm(opsPath, { force: true }).catch(() => undefined);
    }
  } finally {
    await Promise.all(tempPdfs.map((p) => fs.rm(p, { force: true }).catch(() => undefined)));
  }
}

async function pdfPageCount(abs: string): Promise<number> {
  const py = await requirePython();
  const res = await runCaptured(py, ["-c", "from pypdf import PdfReader;import sys;print(len(PdfReader(sys.argv[1]).pages))", abs], 30_000, PYTHON_DOCUMENT_ENV);
  if (res.code !== 0) throw new Error(`读取 PDF 页数失败:${res.stderr.trim()}`);
  return Number.parseInt(res.stdout.trim(), 10) || 0;
}

export async function editExcelRange(input: {
  path: string;
  range: string;
  content: unknown[][];
}): Promise<{ path: string; sheet: string; range: string; cells: number }> {
  if (!Array.isArray(input.content) || input.content.length === 0 || !input.content.every(Array.isArray)) {
    throw new Error("content 必须是非空二维数组");
  }
  const width = input.content[0]!.length;
  if (width === 0 || input.content.some((row) => row.length !== width)) throw new Error("content 必须是规则矩形二维数组");
  if (input.content.length > 1000 || width > 200) throw new Error("单次 Excel 写入最多 1000 行 × 200 列");
  const py = await requirePython();
  const payload = tempPath(".json");
  const abs = path.resolve(input.path);
  const tmp = `${abs}.mcode-${randomUUID()}.tmp${path.extname(abs)}`;
  try {
    await fs.writeFile(payload, JSON.stringify(input.content), "utf8");
    const script = [
      "import sys,json,os",
      "try:",
      " from openpyxl import load_workbook",
      " from openpyxl.utils.cell import range_boundaries",
      "except Exception as e:",
      " print('缺少 openpyxl:'+str(e),file=sys.stderr);sys.exit(2)",
      "p,rg,payload,tmp=sys.argv[1:5]",
      "if '!' not in rg: raise ValueError('range 必须是 Sheet!A1:C10')",
      "sheet,coords=rg.rsplit('!',1); sheet=sheet.strip()",
      "if len(sheet)>=2 and sheet[0]==\"'\" and sheet[-1]==\"'\": sheet=sheet[1:-1].replace(\"''\",\"'\")",
      "rows=json.load(open(payload,encoding='utf-8'))",
      "keep=os.path.splitext(p)[1].lower()=='.xlsm'",
      "wb=load_workbook(p,keep_vba=keep)",
      "if sheet not in wb.sheetnames: raise ValueError('没有工作表:'+sheet)",
      "ws=wb[sheet]; minc,minr,maxc,maxr=range_boundaries(coords)",
      "height=maxr-minr+1; width=maxc-minc+1",
      "if len(rows)!=height or any(len(r)!=width for r in rows): raise ValueError(f'content 尺寸 {len(rows)}x{len(rows[0]) if rows else 0} 与 range {height}x{width} 不一致')",
      "for ri,row in enumerate(rows):",
      " for ci,val in enumerate(row): ws.cell(minr+ri,minc+ci).value=val",
      "wb.save(tmp)",
      "print(json.dumps({'sheet':sheet,'range':coords,'cells':height*width},ensure_ascii=False))",
    ].join("\n");
    const res = await runCaptured(py, ["-c", script, abs, input.range, payload, tmp], 120_000, PYTHON_DOCUMENT_ENV);
    if (res.code !== 0) throw new Error(`Excel range 写入失败:${res.stderr.trim() || res.stdout.trim()}`);
    await fs.rename(tmp, abs);
    const meta = JSON.parse(res.stdout.trim()) as { sheet: string; range: string; cells: number };
    return { path: abs, ...meta };
  } finally {
    await fs.rm(payload, { force: true }).catch(() => undefined);
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

function normalizeDocxPart(part?: string): string {
  const value = (part ?? "word/document.xml").trim().replace(/\\/g, "/");
  if (value === "document") return "word/document.xml";
  if (/^header\d+$/i.test(value)) return `word/${value}.xml`;
  if (/^footer\d+$/i.test(value)) return `word/${value}.xml`;
  if (!/^word\/(?:document|header\d+|footer\d+)\.xml$/i.test(value)) {
    throw new Error("part 只支持 word/document.xml、word/headerN.xml、word/footerN.xml");
  }
  return value;
}

export async function readDocxXml(input: {
  path: string;
  part?: string;
  offset?: number;
  limit?: number;
}): Promise<string> {
  const py = await requirePython();
  const abs = path.resolve(input.path);
  const part = normalizeDocxPart(input.part);
  const offset = Math.max(1, input.offset ?? 1);
  const limit = Math.max(1, Math.min(input.limit ?? 400, 5000));
  const script = [
    "import sys,zipfile,xml.dom.minidom as MD",
    "p,part=sys.argv[1],sys.argv[2]",
    "with zipfile.ZipFile(p) as z:",
    " if part not in z.namelist(): raise ValueError('DOCX 里没有 part:'+part)",
    " raw=z.read(part)",
    " pretty=MD.parseString(raw).toprettyxml(indent='  ')",
    " print(pretty,end='')",
  ].join("\n");
  const res = await runCaptured(py, ["-c", script, abs, part], 60_000, PYTHON_DOCUMENT_ENV);
  if (res.code !== 0) throw new Error(`读取 DOCX XML 失败:${res.stderr.trim() || res.stdout.trim()}`);
  const lines = res.stdout.split(/\r?\n/);
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const body = slice.map((line, i) => `${offset + i}\t${line}`).join("\n");
  const tail = offset - 1 + slice.length < lines.length
    ? `\n…(还有 ${lines.length - (offset - 1 + slice.length)} 行，用 offset=${offset + slice.length} 继续)`
    : "";
  return `[${abs} :: ${part} 共 ${lines.length} 行]\n${body}${tail}`;
}

export async function editDocxXml(input: {
  path: string;
  oldString: string;
  newString: string;
  expectedReplacements?: number;
  part?: string;
}): Promise<{ path: string; replacements: number; parts: string[] }> {
  if (!input.oldString) throw new Error("old_string 不能为空");
  const expected = input.expectedReplacements ?? 1;
  if (!Number.isInteger(expected) || expected < 1 || expected > 1000) throw new Error("expected_replacements 必须是 1..1000 的整数");
  const py = await requirePython();
  const abs = path.resolve(input.path);
  const payload = tempPath(".json");
  const tmp = `${abs}.mcode-${randomUUID()}.tmp.docx`;
  try {
    await fs.writeFile(payload, JSON.stringify({ old: input.oldString, new: input.newString }), "utf8");
    const script = [
      "import sys,json,zipfile,xml.dom.minidom as MD,re",
      "p,payload,tmp,part,expected=sys.argv[1],sys.argv[2],sys.argv[3],sys.argv[4],int(sys.argv[5])",
      "data=json.load(open(payload,encoding='utf-8')); old,new=data['old'],data['new']",
      "with zipfile.ZipFile(p,'r') as zin:",
      " names=zin.namelist()",
      " candidates=[part] if part else [n for n in names if re.match(r'word/(document|header\\d+|footer\\d+)\\.xml$',n,re.I)]",
      " pretty={}",
      " total=0; touched=[]",
      " for n in candidates:",
      "  if n not in names: continue",
      "  s=MD.parseString(zin.read(n)).toprettyxml(indent='  ')",
      "  c=s.count(old); total+=c; pretty[n]=s",
      "  if c: touched.append(n)",
      " if total!=expected: raise ValueError(f'old_string 实际匹配 {total} 次，期望 {expected} 次；未写回')",
      " with zipfile.ZipFile(tmp,'w') as zout:",
      "  for info in zin.infolist():",
      "   body=zin.read(info.filename)",
      "   if info.filename in pretty and old in pretty[info.filename]: body=pretty[info.filename].replace(old,new).encode('utf-8')",
      "   zout.writestr(info,body)",
      " print(json.dumps({'replacements':total,'parts':touched},ensure_ascii=False))",
    ].join("\n");
    const part = input.part ? normalizeDocxPart(input.part) : "";
    const res = await runCaptured(py, ["-c", script, abs, payload, tmp, part, String(expected)], 120_000, PYTHON_DOCUMENT_ENV);
    if (res.code !== 0) throw new Error(`DOCX XML 修改失败:${res.stderr.trim() || res.stdout.trim()}`);
    await fs.rename(tmp, abs);
    const meta = JSON.parse(res.stdout.trim()) as { replacements: number; parts: string[] };
    return { path: abs, ...meta };
  } finally {
    await fs.rm(payload, { force: true }).catch(() => undefined);
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}
