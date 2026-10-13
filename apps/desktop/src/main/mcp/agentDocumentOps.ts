import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { ConsoleTextDecoder } from "@main/lib/outBuf.js";
import { resolvePythonExe } from "@main/lib/pythonResolve.js";
import { withOsFileLease } from "@main/lib/osFileLease.js";
import { textFileHash, withDocFileLock } from "./agentTextFiles.js";

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

/** 挑一个 python 解释器 —— **与工具链检测、代码节点共用一份**。
 *
 *  从前这里是"取 PATH 上第一个能跑的 python"。而 `env/agentEnv.ts` 为了技能里敲得到
 *  `soffice`,把 LibreOffice 的 `program/` 目录注入了子进程 PATH 最前面 —— 那里同时
 *  躺着 LibreOffice 自带的 `python.exe`,于是"第一个"永远选到它,文档转换会落到用户
 *  终端里那个 `python` **之外**的解释器上(报告附录 M 的"Python 解释器陷阱"三处重复)。
 *  `resolvePythonExe()` 会跳过捆绑型解释器,与工具链 / 代码节点一致。 */
async function findPythonExecutable(): Promise<string | null> {
  if (!pythonExecutablePromise) {
    pythonExecutablePromise = (async () => {
      const exe = await resolvePythonExe();
      if (!exe) return null;
      try {
        const out = await runCaptured(exe, ["-c", "import sys;print(sys.executable)"], 5_000);
        return out.code === 0 && out.stdout.trim() ? exe : null;
      } catch {
        return null;
      }
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

/**
 * 【MC-069】**原子 no-clobber 提交**一个最终输出名。
 *
 * 这里**不再**"先用 `open('wx')` 抢一个空占位、渲染完再 `fs.rename` 覆盖"。两次独立复审
 * 都证明那条路不安全:占位只证明"回到那一瞬没别人",异步渲染期间第三方(另一个 Mcode
 * 进程、外部编辑器、另一个 Agent)完全可以把内容写进同名的 out;随后的裸 `fs.rename`
 * (Windows 上对已存在普通文件是**覆盖**)会把它静默销毁,失败分支里的 `fs.rm(out)` 更是
 * 无条件删掉不属于本次调用的文件。
 *
 * 改用 **硬链接 `fs.link(staging, out)`** 作为提交原语,它天然满足我们需要的两点:
 *   1. **原子**:内核保证 `out` 要么还不存在,要么是完整文件,绝不会出现半截;
 *   2. **不覆盖**:`out` 已存在(哪怕是第三方刚写的新文件、悬空符号链接)一律 `EEXIST`,
 *      绝不触碰它 —— 这正是"no-clobber"该有的语义,且**跨进程**有效(不依赖进程内锁)。
 *
 * `staging` 与 `out` 必须同卷(两者同目录即可),否则 `fs.link` 抛 `EXDEV`。
 */
async function commitNewFile(staging: string, out: string): Promise<void> {
  try {
    await fs.link(staging, out);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new Error(`输出文件已存在:${out}；为避免误覆盖，请使用新的文件名`);
    }
    if (code === "EXDEV") {
      throw new Error(`输出路径与暂存文件不在同一卷,无法原子提交:${out}`);
    }
    throw err;
  }
}

/**
 * 【MC-069】乐观版本校验 —— 写之前重读磁盘,比对「本轮开局读到的字节」。
 *
 * 若不匹配,说明在本次读-改-写之间文件被别的调用/实例/外部编辑器改过,提交会**静默吞掉**
 * 那次修改。此时**拒绝**并给 `FILE_VERSION_CONFLICT`,让调用方重新读取,而不是覆盖。
 */
async function assertUnchangedOrThrow(abs: string, original: Buffer, label: string): Promise<void> {
  const current = await fs.readFile(abs).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") throw new Error(`${label}在本次编辑期间被删除:${abs}；未写回`);
    throw err;
  });
  if (textFileHash(current) !== textFileHash(original)) {
    throw new Error(
      `FILE_VERSION_CONFLICT:${label}在本次编辑期间被其他操作修改,拒绝覆盖:${abs}；请重新读取后再试`,
    );
  }
}

/**
 * 文档读-改-写的**统一跨进程事务入口**:先把互斥抬到宿主级(磁盘文件租约),再叠加本进程的
 * 串行 `withDocFileLock`,锁内才是调用方的读-改-写。两级都要:磁盘租约挡**别的进程**,
 * 进程内 Map 挡**同进程内的并发 async**(避免同一进程自己和自己抢磁盘锁、白等)。
 *
 * 【MC-069 → MC-097 收口】这段原先在此**私有**实现(`tryAcquireOsLease` /
 * `acquireOsFileLease` / `LEASE_*` 常量都在本文件里)。`ipc/files.ts` 的 `FILE_WRITE`
 * (Markdown/源码保存)同样需要按路径的宿主级互斥,**不能**另起第二套锁,于是把它抽到
 * `lib/osFileLease.ts`,与本文件共用同一份(`withOsFileLease`)。此处只保留「文件租约 +
 * 进程内锁」两级叠加这一处调用点差异。
 */
export async function withDocumentFileLease<T>(file: string, action: (real: string) => Promise<T>): Promise<T> {
  return withOsFileLease(file, (real) => withDocFileLock(real, action));
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
  if (input.sourcePath && path.resolve(input.sourcePath) === out) {
    throw new Error("输出文件不能覆盖原文件；请换一个 output_path");
  }
  await fs.mkdir(path.dirname(out), { recursive: true });

  // 【MC-069】整段「渲染 → 提交」在同一条物理文件的串行锁内,但**提交致胜靠原子 `fs.link`
  // 而非进程内锁**。从前 `assertNewOutput` 先 `access` 预检再异步渲染,是 TOCTOU;上一版改用
  // `open('wx')` 空占位 + 事后 `rename`,又栽在"占位不等于提交时的所有权"——异步渲染期间
  // 第三方能改写 out,随后的裸 `rename`(Windows 上对已存在普通文件是覆盖)把它静默销毁,
  // 失败分支的 `fs.rm(out)` 更是无条件删除不属于本次调用的文件。现在 staging 与 out 同目录,
  // 渲染完整可读后用 `commitNewFile`(硬链接,`EEXIST` 即冲突)原子发布,out 已存在一律不碰。
  return withDocFileLock(out, async () => {
    // staging 放 out 的**同目录同卷**:`fs.link` 要求两者同卷,放 os tmpdir 在跨盘(如
    // 系统盘与数据盘不同)时会 `EXDEV`,这个环境在本机真实存在。
    const staging = `${out}.mcode-${randomUUID()}.tmp.pdf`;
    const tempPdfs: string[] = [];
    try {
      if (typeof input.markdown === "string") {
        if (input.sourcePath || input.operations) throw new Error("创建 PDF 时只传 markdown + output_path");
        await renderMarkdownPdf(input.markdown, staging);
      } else {
        if (!input.sourcePath || !input.operations) throw new Error("修改 PDF 需要 source_path + operations + output_path");
        const source = path.resolve(input.sourcePath);
        const sourceStat = await fs.stat(source).catch(() => null);
        if (!sourceStat?.isFile()) throw new Error(`源 PDF 不存在:${source}`);

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
            // 写进**独立 staging**(`'xb'` 保证全新建、与 out 同目录),而不是直接写最终名 ——
            // 最终名由本函数在完整写出后用 `commitNewFile`(硬链接)原子发布,避免半截文件对外可读。
            "with open(dst,'xb') as f: w.write(f)",
            "print(len(pages))",
          ].join("\n");
          const res = await runCaptured(py, ["-c", script, source, staging, opsPath], 120_000, PYTHON_DOCUMENT_ENV);
          if (res.code !== 0) throw new Error(`修改 PDF 失败:${res.stderr.trim() || res.stdout.trim()}`);
        } finally {
          await fs.rm(opsPath, { force: true }).catch(() => undefined);
        }
      }

      const pageCount = await pdfPageCount(staging);
      // 原子 no-clobber 提交:staging 完整可读后,硬链接到最终名。out 已存在(含第三方刚
      // 写入的新文件、悬空符号链接)一律 EEXIST 冲突并**原样保留**,绝不被覆盖销毁。
      await commitNewFile(staging, out);
      return { outputPath: out, pageCount };
    } finally {
      // 只清理**本次调用自己**建的 staging 与临时插入页 —— 绝不触碰 out:提交成功时 out 已是
      // 指向同一 inode 的硬链接(unlink staging 不移除内容),失败时 out 从未被本函数创建。
      await fs.rm(staging, { force: true }).catch(() => undefined);
      await Promise.all(tempPdfs.map((p) => fs.rm(p, { force: true }).catch(() => undefined)));
    }
  });
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
  /** 【MC-069】可选:调用方上次读到的文件 sha256。不匹配即拒绝(FILE_VERSION_CONFLICT)。 */
  expectedSha256?: string;
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
    // 【MC-069】同一条物理文件的读-改-写既走**跨进程文件租约**(withDocumentFileLease —— 两个
    // 独立 Mcode 进程也串行),又在提交前做乐观版本校验:两个「读旧版→各自写全新文件」的并发里,
    // 后者必被挡下,而不是两边都报成功、其中一个的修改被静默吞掉。
    return await withDocumentFileLease(abs, async (real) => {
      const original = await fs.readFile(real); // 锁内读取的版本 = 提交时要校验的版本
      // 【MC-069】显式版本契约:调用方带上来就按它校验(比"锁内读的那版"更强 —— 覆盖
      // 「读文件→隔了一会儿→再编辑」之间的外部变更)。
      if (typeof input.expectedSha256 === "string" && input.expectedSha256 && textFileHash(original) !== input.expectedSha256) {
        throw new Error(`FILE_VERSION_CONFLICT:Excel 文件自上次读取后已被修改,拒绝覆盖:${real}；请重新读取后再试`);
      }
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
      const res = await runCaptured(py, ["-c", script, real, input.range, payload, tmp], 120_000, PYTHON_DOCUMENT_ENV);
      if (res.code !== 0) throw new Error(`Excel range 写入失败:${res.stderr.trim() || res.stdout.trim()}`);
      await assertUnchangedOrThrow(real, original, "Excel 文件");
      await fs.rename(tmp, real);
      const meta = JSON.parse(res.stdout.trim()) as { sheet: string; range: string; cells: number };
      return { path: real, ...meta };
    });
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
    // 【MC-069】与 Excel 同款:跨进程文件租约 + 提交前乐观版本校验,避免「两份完整快照
    // 互相覆盖、后到者静默吞掉先到者的修改」。
    return await withDocumentFileLease(abs, async (real) => {
      const original = await fs.readFile(real);
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
      const res = await runCaptured(py, ["-c", script, real, payload, tmp, part, String(expected)], 120_000, PYTHON_DOCUMENT_ENV);
      if (res.code !== 0) throw new Error(`DOCX XML 修改失败:${res.stderr.trim() || res.stdout.trim()}`);
      await assertUnchangedOrThrow(real, original, "DOCX 文件");
      await fs.rename(tmp, real);
      const meta = JSON.parse(res.stdout.trim()) as { replacements: number; parts: string[] };
      return { path: real, ...meta };
    });
  } finally {
    await fs.rm(payload, { force: true }).catch(() => undefined);
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}
