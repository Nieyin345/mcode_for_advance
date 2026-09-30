/**
 * Headless smoke for **`main/workflows/assets.ts` 的 `MINERU_PY`** —— 内置自动化
 * 「下载完自动转 Markdown」那一步跑的转录脚本。
 *
 * ## 为什么单独一套（与 `library-py-smoke` 同一条理由）
 *
 * 这个脚本**不在 TypeScript 的类型系统里** —— 它是一段反引号里的 Python 字面量。
 * tsc 看不见它里面写没写错，而它要办的事全是**协议交互**：申请上传链接 → PUT 上传 →
 * 轮询到 done → 取 zip → 解出 `full.md` + 配图。错一处不会报错，只会**转不出东西**，
 * 而用户看到的是"A 自动化的转录那一步莫名其妙不работа"。
 *
 * ## 它验的是**真跑**，不是文本
 *
 * 把 `MINERU_PY` 那个字面量落成真的 `.py`，起一个**假 MinerU 服务端**（本地 HTTP，
 * 不联网、不烧额度、秒级），按 code 节点的调用形状喂它（stdin 一行 JSON），断言 stdout
 * 上那行 `@@mcode:result` 里**真有什么**。
 *
 * ⚠️ **不联网是有意的**：真 API 要 token、要等几十秒，而且**造不出失败**（token 错、
 * 解析失败、越界 zip）—— 而那几种恰恰最该验。详见这里那个假服务端。
 *
 * ## 这一套钉住的几件事
 *
 *   - 正常路：申请 → 上传 → **真轮询几次** → 解包 → 产物落在 cwd 下、协议行里带齐字段
 *   - token 没设 / token 错 / 服务端说解析失败 → **非零退出**，而且话里说清楚
 *   - 结果包里有 `../../x` → **拒绝解压**，且一个字节都没写出去
 *   - **合并窗口里攒了多条 → 一条都不许漏**（下载是并发跑的，这是最常见的形状）
 *   - 多条里有一条坏的 → 其余照转，坏的那条如实报出来
 *
 * Run: scripts/mineru-py-smoke/run.sh
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

/**
 * 退出码断言 —— 失败时**把 stderr 带出来**。
 *
 * 光看 `{"actual":1,"expected":0}` 是查不动的:脚本**崩了**与断言**写错了**长得一模一样,
 * 而这两者要做的事完全不同(前者去读那段 Python,后者改这里)。stderr 是唯一能分开它们的
 * 东西,而它本来就在 `RunResult` 里躺着、没人看。
 *
 * 尾巴 800 字符够用:Python 的 traceback 是**最后几行**说事,前面全是帧。
 */
function eqExit(name: string, r: RunResult, expected: number): void {
  check(
    name,
    r.code === expected,
    r.code === expected
      ? undefined
      : { actual: r.code, expected, stderr: r.stderr.slice(-800), stdout: r.stdout.slice(-300) },
  );
}

/**
 * 脚本**不该往 stderr 写东西** —— 它跟主进程说话的唯一通道是 stdout 上那行
 * `@@mcode:result`(code 节点的约定)。往 stderr 写等于把话说给没人听的地方,
 * 而失败时就变成了"退出码非零但话是空的"。
 *
 * 真的断言它,是因为**没断言就等于没这条规矩**:Python 里少写一层 try、或者某个库
 * 往 stderr 打警告,都会悄悄发生而没人发现。
 */
function checkStderrClean(name: string, r: RunResult): void {
  check(name, r.stderr.trim() === "", r.stderr.slice(-800));
}

/* ──────────────── 0. 把 MINERU_PY 落成真的 .py ──────────────── */

/**
 * ⚠️ **走 esbuild 打包再 import，不抠源码。** 抠的话，模板字符串里出现转义时抠出来的
 * 与真实运行的那份不一样 —— 而那正是这一套要防的（`library-py-smoke` 的 run.sh 里
 * 为同一条写过一段）。打包出来的是**真值**。
 *
 * run.sh 已经把 `main.ts` 打成 `smoke.mjs`，并把产物目录当 argv[2] 传进来。
 */
const OUT_DIR = process.argv[2];
if (!OUT_DIR) throw new Error("缺参数：产物目录（见 run.sh）");

const { MINERU_PY } = (await import("@main/workflows/assets.js")) as { MINERU_PY: string };
check("从 assets.ts 取到了 MINERU_PY", typeof MINERU_PY === "string" && MINERU_PY.length > 1000, MINERU_PY?.length);

const SCRIPT = join(OUT_DIR, "mineru_transcribe.py");
writeFileSync(SCRIPT, MINERU_PY, "utf8");

/* ──────────────── 1. 假 MinerU 服务端 ──────────────── */

/** 前几次轮询回 running，逼客户端真的走一遍轮询。 */
const POLLS_BEFORE_DONE = 2;
const FULL_MD = "# 转出来的正文\n\n第一段。\n\n![图](images/figure.png)\n\n第二段。\n";

interface BatchState {
  polls: number;
  bytes: number;
  name: string;
  fail: boolean;
}
const batches = new Map<string, BatchState>();
/** batch 序号 —— 每次申请一个新 id，多条时互不干扰。 */
let batchSeq = 0;

function zipBytes(): Buffer {
  // 手搓一个最小 zip：`full.md` + `images/figure.png` + 一个无关的 json。
  // **不引 zip 库** —— 这里要的就是"结果包里正好这几样"，而 zip 的存储格式
  // （无压缩）简单到可以直接写。
  const entries: Array<[string, Buffer]> = [
    ["full.md", Buffer.from(FULL_MD, "utf8")],
    ["images/figure.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ["layout.json", Buffer.from("{}", "utf8")],
  ];
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    // CRC32 用 0 —— Python 的 zipfile 在**解压**时校验它，而这份包是给 safe_extract
    // 用的（只 extractall），真校验会失败。所以算一个真的。
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10); // 时间
    local.writeUInt16LE(0, 12); // 日期
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    parts.push(local, data);

    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    nameBuf.copy(cd, 46);
    central.push(cd);
    offset += local.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, end]);
}

/** 标准 CRC32（zip 要求）。表算一次就够。 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 一个**越界**的 zip：里面是 `../../escaped.txt`。用来验 `safe_extract` 会拒它。 */
function evilZipBytes(): Buffer {
  const name = Buffer.from("../../escaped.txt", "utf8");
  const data = Buffer.from("我出去了", "utf8");
  const crc = crc32(data);
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);

  const cd = Buffer.alloc(46 + name.length);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(data.length, 20);
  cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(name.length, 28);
  name.copy(cd, 46);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(local.length + data.length, 16);
  return Buffer.concat([local, data, cd, end]);
}

function startFakeMineru(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const send = (code: number, obj: unknown): void => {
      const body = Buffer.from(JSON.stringify(obj), "utf8");
      res.writeHead(code, { "Content-Type": "application/json", "Content-Length": body.length });
      res.end(body);
    };
    const authOk = (): boolean => req.headers.authorization === "Bearer test-token-xyz";
    const url = req.url ?? "";
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      // ① 申请上传链接
      if (req.method === "POST" && url === "/api/v4/file-urls/batch") {
        if (!authOk()) return send(200, { code: "A0202", msg: "Token 错误" });
        let body: { files?: Array<{ name?: string; data_id?: string }> } = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof body;
        } catch {
          return send(200, { code: -10002, msg: "坏 JSON" });
        }
        const first = body.files?.[0];
        if (!first) return send(200, { code: -10002, msg: "files 为空" });
        batchSeq += 1;
        const batchId = `batch_${batchSeq}`;
        batches.set(batchId, {
          polls: 0,
          bytes: 0,
          name: first.name ?? "x.pdf",
          // **失败模式**：data_id 以 FAIL_ 开头时最终回 failed。靠它才能验"服务端说
          // 失败时客户端把原因带出来" —— 那一条最容易写成"跑一遍成功路再断言没报错"。
          fail: (first.data_id ?? "").startsWith("FAIL_"),
        });
        return send(200, {
          code: 0,
          msg: "ok",
          data: { batch_id: batchId, file_urls: [`${base}/upload/${batchId}`] },
        });
      }
      // ② PUT 上传
      if (req.method === "PUT" && url.startsWith("/upload/")) {
        const id = url.slice("/upload/".length);
        const st = batches.get(id);
        if (st) st.bytes = Buffer.concat(chunks).length;
        res.writeHead(200);
        return res.end();
      }
      // ③ 轮询
      if (req.method === "GET" && url.startsWith("/api/v4/extract-results/batch/")) {
        if (!authOk()) return send(200, { code: "A0202", msg: "Token 错误" });
        const id = url.slice("/api/v4/extract-results/batch/".length);
        const st = batches.get(id);
        if (!st) return send(200, { code: -60012, msg: "找不到任务" });
        st.polls += 1;
        if (st.fail) {
          return send(200, {
            code: 0,
            msg: "ok",
            data: {
              batch_id: id,
              extract_result: [
                { file_name: st.name, state: "failed", err_msg: "文件页数超过限制（假服务端造的）" },
              ],
            },
          });
        }
        if (st.polls <= POLLS_BEFORE_DONE) {
          return send(200, {
            code: 0,
            msg: "ok",
            data: {
              batch_id: id,
              extract_result: [
                { file_name: st.name, state: "running", extract_progress: { extracted_pages: 1, total_pages: 2 } },
              ],
            },
          });
        }
        return send(200, {
          code: 0,
          msg: "ok",
          data: {
            batch_id: id,
            extract_result: [
              {
                file_name: st.name,
                state: "done",
                err_msg: "",
                full_zip_url: `${base}/result/${id}.zip`,
              },
            ],
          },
        });
      }
      // ④ 结果包
      if (req.method === "GET" && url.startsWith("/result/") && url.endsWith(".zip")) {
        const body = zipBytes();
        res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": body.length });
        return res.end(body);
      }
      res.writeHead(404);
      res.end();
    });
  });
  let base = "";
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      base = `http://127.0.0.1:${port}`;
      resolve({ server, base });
    });
  });
}

/* ──────────────── 2. 按 code 节点的形状调它 ──────────────── */

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** `@@mcode:result` 那行解析出来的对象；没有就是 undefined。 */
  result?: Record<string, unknown>;
  /** 同上但只在**失败**时（exit != 0）取，避免把成功那条当成失败证据。 */
  summary: string;
}

function runScript(
  payload: unknown,
  env: Record<string, string>,
  cwd: string,
): Promise<RunResult> {
  // 与 codeRunner 同一形状：python -u <file>，stdin 一行 JSON。
  const child: ChildProcess = spawn("python", ["-u", SCRIPT], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
  child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
  child.stdin?.end(`${JSON.stringify(payload)}\n`);
  return new Promise((resolve) => {
    child.on("close", (code) => {
      let result: Record<string, unknown> | undefined;
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.startsWith("@@mcode:result ")) continue;
        try {
          result = JSON.parse(line.slice("@@mcode:result ".length)) as Record<string, unknown>;
        } catch {
          /* 坏协议行当没有 */
        }
      }
      resolve({
        code,
        stdout,
        stderr,
        result,
        summary: typeof result?.summary === "string" ? result.summary : "",
      });
    });
  });
}

/* ──────────────── 3. 开跑 ──────────────── */

const { server, base } = await startFakeMineru();
const ROOT = mkdtempSync(join(tmpdir(), "mcode-mineru-smoke-"));
const CWD = join(ROOT, "run");
mkdirSync(CWD, { recursive: true });

/** 造一份"库内 PDF"。`pdfPath` 是**库内相对路径** —— 脚本按数据根拼绝对路径。 */
function seedPdf(rel: string, bytes: string): void {
  const abs = join(ROOT, "library", rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, bytes, "utf8");
}

seedPdf(join("papers", "ab", "cd", "sha.pdf"), "%PDF-1.4 first");
seedPdf(join("papers", "ee", "ff", "sha2.pdf"), "%PDF-1.4 second");

const GOOD = { MINERU_TOKEN: "test-token-xyz", MINERU_BASE_URL: base, MCODE_DATA_ROOT: ROOT };

try {
  console.log("\n① 正常路：申请 → 上传 → 轮询 → 解包");
  {
    const r = await runScript(
      { itemId: "li_one", pdfPath: join("papers", "ab", "cd", "sha.pdf") },
      GOOD,
      CWD,
    );
    eqExit("退出码 0", r, 0);
    checkStderrClean("① 没往 stderr 写东西", r);
    check("打了协议行", r.result !== undefined, r.stdout.slice(-300));
    const items = (r.result?.outputs as { items?: Array<Record<string, unknown>> } | undefined)?.items ?? [];
    eq("outputs.items 有一条", items.length, 1);
    const one = items[0] ?? {};
    eq("带 itemId", one["itemId"], "li_one");
    eq("图数报的是 1", one["imageCount"], 1);
    const md = String(one["mdPath"] ?? "");
    check("full.md 真的落盘了", existsSync(md), md);
    eq("落点在 cwd 下的 mineru/<itemId>/", dirname(md), join(CWD, "mineru", "li_one"));
    if (existsSync(md)) {
      check("正文里那处配图引用还在", readFileSync(md, "utf8").includes("images/figure.png"));
    }
    check("图也解出来了", existsSync(join(CWD, "mineru", "li_one", "images", "figure.png")));
    check("结果包本身没留在落点里", !existsSync(join(CWD, "mineru", "li_one", "result.zip")));
    // ★ **真轮询过** —— 一条"申请完就直接当成 done"的实现会在这里红。
    const anyBatch = [...batches.values()][0];
    check("★ 真的轮询过（不是一次就 done）", (anyBatch?.polls ?? 0) > POLLS_BEFORE_DONE, anyBatch?.polls);
    check("★ 上传的字节数对得上", anyBatch?.bytes === readFileSync(join(ROOT, "library", "papers", "ab", "cd", "sha.pdf")).length, anyBatch?.bytes);
  }

  console.log("\n② 手动点的、没设 token → 明确报错，不静默降级");
  {
    // 宿主手动起跑时往触发器事实里加 `manual: true`(见 `automationRunner.fire`)。
    const r = await runScript(
      { itemId: "li_notoken", pdfPath: join("papers", "ab", "cd", "sha.pdf"), manual: true },
      { MINERU_BASE_URL: base, MCODE_DATA_ROOT: ROOT },
      CWD,
    );
    check("非零退出", r.code !== 0, { actual: r.code, stderr: r.stderr.slice(-800) });
    check("话里让它去设 MINERU_TOKEN", r.summary.includes("MINERU_TOKEN"), r.summary);
  }

  console.log("\n②b 事件自动叫起来的、没设 token → 跳过，不算失败(2026-09-30)");
  {
    // 没配 token 的人每导入一篇就亮一盏红灯 —— 那是噪音,不是提醒。载荷裹在 trigger 里,
    // 与真实运行时 code 节点收到的 data 上下文同形。
    const r = await runScript(
      { trigger: { kind: "event", event: "library.item.imported",
        items: [{ itemId: "li_auto_notoken", pdfPath: join("papers", "ab", "cd", "sha.pdf") }] } },
      { MINERU_BASE_URL: base, MCODE_DATA_ROOT: ROOT },
      CWD,
    );
    eqExit("退出码 0", r, 0);
    check("打了协议行", r.result !== undefined, r.stdout.slice(-300));
    // 成功那条的话在协议行里(`r.summary` 只在失败时取)。
    const said = String((r.result as { summary?: unknown } | undefined)?.summary ?? "");
    check("话里说了跳过", said.includes("跳过"), said);
    check("话里告诉他去哪填 token", said.includes("TOKEN_INLINE") && said.includes("MINERU_TOKEN"), said);
    const out = (r.result?.outputs ?? {}) as { items?: unknown[]; noToken?: unknown };
    eq("没有转出任何条目", (out.items ?? []).length, 0);
    eq("outputs.noToken 标了出来", out.noToken, true);
    check("没往落点里建目录", !existsSync(join(CWD, "mineru", "li_auto_notoken")));
  }

  console.log("\n②c trigger 里带 manual、没设 token → 仍然报错(裹一层也认得出)");
  {
    const r = await runScript(
      { trigger: { kind: "event", event: "library.item.imported", manual: true,
        items: [{ itemId: "li_manual_wrapped", pdfPath: join("papers", "ab", "cd", "sha.pdf") }] } },
      { MINERU_BASE_URL: base, MCODE_DATA_ROOT: ROOT },
      CWD,
    );
    check("非零退出", r.code !== 0, { actual: r.code, stderr: r.stderr.slice(-800) });
  }

  console.log("\n③ token 错（服务端回 A0202）");
  {
    const r = await runScript(
      { itemId: "li_badtoken", pdfPath: join("papers", "ab", "cd", "sha.pdf") },
      { ...GOOD, MINERU_TOKEN: "wrong" },
      CWD,
    );
    check("非零退出", r.code !== 0, { actual: r.code, stderr: r.stderr.slice(-800) });
    check("summary 说了是提交被拒", r.summary.includes("拒"), r.summary);
  }

  console.log("\n④ 服务端说解析失败 → 把它给的原因带出来");
  {
    const r = await runScript(
      { itemId: "FAIL_li_fail", pdfPath: join("papers", "ab", "cd", "sha.pdf") },
      GOOD,
      CWD,
    );
    check("非零退出", r.code !== 0, { actual: r.code, stderr: r.stderr.slice(-800) });
    check("★ 把服务端给的失败原因带出来了", r.summary.includes("页数超过限制"), r.summary);
    check("说了是解析失败", r.summary.includes("解析失败"), r.summary);
    // 对照组：不带那个前缀 → 照常成功。没有它，上面两条可能只因"脚本对什么都报错"而绿。
    const ok = await runScript(
      { itemId: "li_fail_control", pdfPath: join("papers", "ab", "cd", "sha.pdf") },
      GOOD,
      CWD,
    );
    eqExit("（对照组）不触发失败时它照常成功", ok, 0);
  }

  console.log("\n⑤ 载荷缺字段 → 明说，不瞎猜");
  {
    const r = await runScript({ title: "只有标题" }, GOOD, CWD);
    check("非零退出", r.code !== 0, { actual: r.code, stderr: r.stderr.slice(-800) });
    check("说是载荷缺 itemId", r.summary.includes("itemId"), r.summary);
  }

  console.log("\n⑥ PDF 不在 → 说清路径");
  {
    const r = await runScript(
      { itemId: "li_ghost", pdfPath: join("papers", "zz", "zz", "nope.pdf") },
      GOOD,
      CWD,
    );
    check("非零退出", r.code !== 0, { actual: r.code, stderr: r.stderr.slice(-800) });
    check("话里带着那个路径", r.summary.includes("nope.pdf"), r.summary);
  }

  console.log("\n⑦ ★ 合并窗口里攒了多条 → 一条都不许漏");
  {
    // 这是**新补的结构**（见 `automationPayload.ts` 的 `TriggerPayloadFacts.items`）：
    // 从前只拍平第一条，于是"两篇同时下完"时只转第一篇、另一篇静默漏掉。触发器有
    // 合并窗口（默认 2 秒），下载又是并发跑的 —— 这是最常见的形状。
    const r = await runScript(
      {
        items: [
          { itemId: "li_m1", pdfPath: join("papers", "ab", "cd", "sha.pdf") },
          { itemId: "li_m2", pdfPath: join("papers", "ee", "ff", "sha2.pdf") },
        ],
      },
      GOOD,
      CWD,
    );
    eqExit("退出码 0", r, 0);
    const items = (r.result?.outputs as { items?: Array<Record<string, unknown>> } | undefined)?.items ?? [];
    eq("★ 两条都转了（不是只转第一条）", items.length, 2);
    eq("★ 两条各自都在", new Set(items.map((i) => i["itemId"])).size, 2);
    check("★ summary 说了两份", r.summary.includes("2 份"), r.summary);
    const artifacts = (r.result?.artifacts as unknown[] | undefined) ?? [];
    eq("★ artifacts 也给了两份 md", artifacts.length, 2);
  }

  console.log("\n⑧ 多条里有一条坏的 → 其余照转，坏的那条如实报出来");
  {
    // **一条坏不该拖垮其余** —— 这正是"两篇一起下来、其中一篇路径没了"的形状。
    const r = await runScript(
      {
        items: [
          { itemId: "li_good", pdfPath: join("papers", "ab", "cd", "sha.pdf") },
          { itemId: "li_bad", pdfPath: join("papers", "zz", "zz", "nope.pdf") },
        ],
      },
      GOOD,
      CWD,
    );
    eqExit("好那条转成了就走成功路", r, 0);
    const out = (r.result?.outputs ?? {}) as { items?: unknown[]; failed?: string[] };
    eq("转成了 1 份", (out.items ?? []).length, 1);
    eq("那是好那条", ((out.items ?? [])[0] as Record<string, unknown> | undefined)?.["itemId"], "li_good");
    check(
      "★ 坏那条被如实报出来",
      (out.failed ?? []).some((f) => f.includes("nope.pdf")),
      out.failed,
    );
  }

  console.log("\n⑨ 结果包里有越界条目 → 拒绝解压，且没写出去");
  {
    // 真服务端很难造出这种包，而它是最该防的一档：一个 `../../x` 的条目会把文件写到
    // 工作目录之外，而那种写坏是**静默**的。所以直接调 safe_extract 单测它。
    const evil = join(ROOT, "evil.zip");
    writeFileSync(evil, evilZipBytes());
    const outDir = join(ROOT, "safe_out");
    // ⚠️ **先清掉可能残留的那个文件**。它落在 `ROOT` **外面**(那是这一条要验的事),
    // 所以 `run.sh` 的 `rm -rf $OUT` 清不到它 —— 上一次"检查被撤掉"的实验留下的那份
    // 会让这一次的"没写出去"**假红**(或者反过来,让哪次真的没防住看起来没事)。
    const escaped = join(dirname(ROOT), "escaped.txt");
    rmSync(escaped, { force: true });
    const probe = `
import sys, json
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(OUT_DIR)})
import mineru_transcribe as m
try:
    m.safe_extract(Path(${JSON.stringify(evil)}), Path(${JSON.stringify(outDir)}))
    print("NO_THROW")
except Exception as e:
    print("THREW:" + type(e).__name__ + ":" + str(e))
import zipfile
sibling_zip = Path(${JSON.stringify(evil)}).with_name("sibling.zip")
with zipfile.ZipFile(sibling_zip, "w") as z:
    z.writestr("../safe_out-evil/escaped.txt", "do not extract")
try:
    m.safe_extract(sibling_zip, Path(${JSON.stringify(outDir)}))
    print("SIBLING_ACCEPTED")
except RuntimeError:
    print("SIBLING_REJECTED")
valid_zip = sibling_zip.with_name("valid.zip")
with zipfile.ZipFile(valid_zip, "w") as z:
    z.writestr("nested/full.md", "valid transcript")
m.safe_extract(valid_zip, Path(${JSON.stringify(outDir)}))
print("VALID_EXTRACTED" if (Path(${JSON.stringify(outDir)}) / "nested/full.md").read_text() == "valid transcript" else "VALID_FAILED")
`;
    const probeFile = join(OUT_DIR, "probe.py");
    writeFileSync(probeFile, probe, "utf8");
    const res = await new Promise<string>((resolve) => {
      const child = spawn("python", [probeFile], { cwd: CWD });
      let out = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
      child.on("close", () => resolve(out.trim()));
    });
    check("同名前缀的兄弟目录越界也被拒绝", res.includes("SIBLING_REJECTED"), res);
    check("合法嵌套目录仍可解压", res.includes("VALID_EXTRACTED"), res);
    // **要求是 RuntimeError**,不只是"抛了点什么":探针第一版传了字符串,于是它抛
    // 的是 `TypeError: 'str' object has no attribute 'mkdir'` —— 断言照样绿,而那条
    // 路**根本没走到越界检查**。这正是仓规里"因为错的理由绿"那一课。
    check("越界包被拒（且是那条检查拒的）", res.startsWith("THREW:RuntimeError:") && res.includes("越界"), res);
    // ⚠️ **"文件没写到外面"这条断言测不了这个检查。** 实验过:把上面那个 if 整段删掉,
    // 这一套里**没有任何一条会红**。原因是 Python 的 `zipfile.extractall` 自己就会把
    // `..` 洗净、改写进落点内 —— 于是 `<ROOT>/safe_out/../escaped.txt` 实际落在
    // `safe_out/escaped.txt`。删掉检查只是从"**大声拒绝**"退化成"**静默挪位**",两者都
    // 不会把文件写到工作目录之外。
    //
    // 所以这里如实断**落点内也没被写进去**:那才是"拒绝"与"改写"的分界,也是这套要钉的
    // 东西(静默挪位正是本文件顶上说的那种"产物莫名其妙出现在别处").
    check("也没有写进落点（是真拒绝，不是被 extractall 静默挪位）", !existsSync(join(outDir, "escaped.txt")));
    check("更没写到工作目录之外", !existsSync(join(dirname(ROOT), "escaped.txt")));
  }
} finally {
  server.close();
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
