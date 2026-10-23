/**
 * 【T91】`adoptMarkdown.ts` 的两处 `cpSync` 在**非 ASCII 路径**上会不会崩。
 *
 * ## 为什么比 T90 更危险
 *
 * - **T90**（`dataRoot`）要「中文用户名」——`C:\Users\张伟\`；
 * - **T91**（本套）只要「用户导入的文件路径含中文」——**对中文用户是默认情况**。
 *
 * 而 `:313` 的注释写着：
 *
 * > ── ① 先把新的一整包拷进暂存。**这一步失败时老包一个字节都没动。**
 *
 * **设计上依赖「失败会抛异常」。** 现在的实际行为是：
 * - **源含非 ASCII** → 进程直接崩（老包没动，但应用死了）；
 * - **目标含非 ASCII** → **静默不复制、返回成功**（`stageDir` 是空的，流程以为拷好了）。
 *
 * 第二种是数据损坏。
 *
 * ## 结构（同 T90）
 *
 * 父进程（本文件）**自己从不碰非 ASCII 的 `cpSync`**，只 `spawnSync` 起子进程读 `status`。
 * 子进程调**真实的 `adoptMarkdownFile`**，不是复制一份 `cpSync`。
 *
 * ## 五个场景
 *
 * | # | 场景 | 验什么 |
 * |---|---|---|
 * | 1 | 纯 ASCII 的 md + 配图 | **正控**：不崩，且 `ok:true`、配图真的落盘 |
 * | 2 | **源 md 路径含中文** | 负控 |
 * | 3 | **配图路径含中文** | 负控（`:242` 那一处） |
 * | 4 | `café` / `Тест` | 影响面（不是中文特例） |
 * | 5 | **源不存在** | **对照：证明探针真的在调产品代码，不是空转** |
 * | 6 | 目标暂存目录只读 | **「失败时老包一个字节都没动」** —— T91 卡特别要求的第二条 |
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE = join(HERE, "probe.mjs");

let total = 0;
let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
  total++;
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 700)}`}`);
  }
}

const WORK = mkdtempSync(join(tmpdir(), "t91-adopt-"));
process.on("exit", () => { try { rmSync(WORK, { recursive: true, force: true }); } catch { /* 清理失败 */ } });

const DATA = process.env.MCODE_SMOKE_DATA_ROOT!;
const IMPORTED = join(DATA, "library", "markdown", "imported");

const { initDb, flushDb } = await import("@main/store/db.js");
const { LibraryRepo } = await import("@main/store/repositories.js");
// `LibraryRepo.upsert` 要求连接已就绪 —— 现有的 library-* 套件都在这里 `await initDb()`。
await initDb();

/**
 * 建一条文献记录（`adoptMarkdownFile` 要求 item 存在）。
 *
 * ⚠️ **必须 `flushDb()`**：子进程是独立进程，各自开一个 sql.js 实例；不写盘的话
 * 它读到的是一个空库，报「找不到这篇文献」—— 那会看起来像被测代码坏了。
 */
function newItem(title: string): string {
  const id = LibraryRepo.upsert({ title }).id;
  flushDb();
  return id;
}

/** 造一份 md + 它的配图目录；`dirName` 决定路径里有没有非 ASCII。 */
function makeMarkdown(dirName: string, opts: { imageName?: string; body?: (rel: string) => string } = {}): { md: string; image: string } {
  const dir = join(WORK, dirName);
  mkdirSync(join(dir, "images"), { recursive: true });
  const imageName = opts.imageName ?? "a.png";
  const md = join(dir, "doc.md");
  writeFileSync(md, opts.body ? opts.body(`images/${imageName}`) : `# 标题\n\n![图](images/${imageName})\n`, "utf8");
  const image = join(dir, "images", imageName);
  writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), "binary");
  return { md, image };
}

function runProbe(itemId: string, sourcePath: string, mode?: string): { status: number | null; result: string } {
  const args = [PROBE, itemId, sourcePath, ...(mode ? [mode] : [])];
  const r = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 60_000 });
  const result = (r.stdout ?? "").split("\n").find((l) => l.startsWith("PROBE_RESULT:")) ?? "";
  return { status: r.status, result };
}

/** 条目包里现在有什么（相对包根），排过序。 */
function packageContents(itemId: string): string[] {
  const walk = (dir: string, base = ""): string[] => {
    let names: string[];
    try {
      names = readdirSync(dir, { withFileTypes: true }).map((e) => e.name).sort();
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const name of names) {
      const rel = base === "" ? name : `${base}/${name}`;
      const full = join(dir, name);
      out.push(rel);
      try {
        if (readdirSync(full).length >= 0) out.push(...walk(full, rel));
      } catch { /* 不是目录 */ }
    }
    return out;
  };
  return walk(join(IMPORTED, itemId));
}

/* ───────────────────── icacls helper ───────────────────── */

function icacls(args: string[]): boolean {
  const r = spawnSync("icacls", args, { stdio: "pipe" });
  return r.status === 0;
}
function denyWriteIn(dir: string): boolean {
  mkdirSync(dir, { recursive: true });
  return icacls([dir, "/deny", "*S-1-1-0:(OI)(CI)(WD,AD)"]);
}
function allowAll(p: string): boolean {
  const ok = icacls([p, "/remove:d", "*S-1-1-0"]);
  return ok || !existsSync(p);
}

/* ───────────────────── 1. 正控：纯 ASCII ───────────────────── */

console.log("\n1. 正控：纯 ASCII 的 md + 配图");
{
  const item = newItem("ascii-control");
  const { md } = makeMarkdown("ascii-doc");
  const r = runProbe(item, md);
  check("status === 0（没有崩）", r.status === 0, r);
  let parsed: { ok?: boolean; imageCount?: number } = {};
  try { parsed = JSON.parse(r.result.replace("PROBE_RESULT:", "")); } catch { /* 保持空 */ }
  check("adopt 返回 ok:true", parsed.ok === true, r);
  check("配图真的落进包里", packageContents(item).some((p) => p.includes("a.png")), packageContents(item));
}

/* ───────────────────── 2. 负控：源 md 路径含中文 ───────────────────── */

console.log("\n2. ★ 负控：源 md 路径含中文 —— 中文用户的默认情况");
{
  const item = newItem("cn-source");
  const { md } = makeMarkdown("我的论文");
  const r = runProbe(item, md);
  check("★ 子进程没有崩（status === 0）", r.status === 0, r);
  let parsed: { ok?: boolean } = {};
  try { parsed = JSON.parse(r.result.replace("PROBE_RESULT:", "")); } catch { /* 保持空 */ }
  check("★ adopt 返回 ok:true", parsed.ok === true, r);
  check("★ md 真的落进包里", packageContents(item).some((p) => p.endsWith(".md")), packageContents(item));
}

/* ───────────────────── 3. 负控：配图路径含中文 ───────────────────── */

console.log("\n3. ★ 负控：配图文件名含中文（`:242` 那一处）");
{
  const item = newItem("cn-image");
  const { md } = makeMarkdown("cn-image-doc", { imageName: "图1.png" });
  const r = runProbe(item, md);
  check("★ 子进程没有崩（status === 0）", r.status === 0, r);
  check("★ 配图真的落进包里", packageContents(item).some((p) => p.includes("图1.png")), packageContents(item));
}

/* ───────────────────── 3b. 负控：配图在中文子目录里 ───────────────────── */

console.log("\n3b. ★ 负控：配图放在中文子目录（`:242` 的 `dest` 也含非 ASCII）");
{
  const item = newItem("cn-image-dir");
  const dir = join(WORK, "cn-subdir-doc");
  mkdirSync(join(dir, "图表"), { recursive: true });
  const md = join(dir, "doc.md");
  writeFileSync(md, "# 标题\n\n![图](图表/b.png)\n", "utf8");
  writeFileSync(join(dir, "图表", "b.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 9]), "binary");
  const r = runProbe(item, md);
  check("★ 子进程没有崩（status === 0）", r.status === 0, r);
  check("★ 中文子目录里的配图真的落进包里",
    packageContents(item).some((p) => p.includes("图表") && p.includes("b.png")), packageContents(item));
}

/* ───────────────────── 3c. ★ 真正的崩溃点：引用一个中文目录 ───────────────────── */

console.log("\n3c. ★ 崩溃点：md 引用**一个目录**（不是文件）且路径含非 ASCII");
{
  // ⚠️ **这是 `:242` 唯一会崩的形态。** 实测（2026-10-24）：
  //   - 复制**单文件**（带不带 `recursive` 都一样）在中文路径下 → **不崩**；
  //   - 复制**目录** + `recursive: true` 在中文路径下 → **`0xC0000409` 崩**。
  //
  // 所以「源 md 路径含中文」和「配图文件路径含中文」都不触发这个 bug ——
  // 只有「md 引用了**目录**」才触发（`cpSync(abs, dest, { recursive: true })` 里
  // `abs` 是目录）。前两节覆盖的是 `:313` 与 `:242` 的文件形态，它们本来就正常。
  const item = newItem("cn-dir-ref");
  const dir = join(WORK, "目录引用");
  mkdirSync(join(dir, "图表"), { recursive: true });
  writeFileSync(join(dir, "图表", "x.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 7]), "binary");
  const md = join(dir, "doc.md");
  // 引用目录本身（少数工具这样写）
  writeFileSync(md, "# 标题\n\n![图](图表/)\n", "utf8");
  const r = runProbe(item, md);
  check("★ 子进程没有崩（status === 0）", r.status === 0, r);
  check("★ 目录里的图片真的落进包里",
    packageContents(item).some((p) => p.includes("x.png")), packageContents(item));
}

/* ───────────────────── 4. 影响面：不止中文 ───────────────────── */

console.log("\n4. ★ 影响面：café / Тест —— 不是中文特例");
{
  for (const name of ["café-doc", "Тест-док"]) {
    const item = newItem(`script-${name}`);
    const { md } = makeMarkdown(name);
    const r = runProbe(item, md);
    check(`★ "${name}"：子进程没有崩`, r.status === 0, r);
  }
}

/* ───────────────────── 5. 对照：探针真的在调产品代码 ───────────────────── */

console.log("\n5. ★ 对照：源不存在时返回 ok:false（不是崩溃，也不是成功）");
{
  const item = newItem("missing-src");
  const r = runProbe(item, join(WORK, "根本不存在", "doc.md"));
  check("★ status === 0 且结果是 ok:false",
    r.status === 0 && r.result.includes('"ok":false'), r);
}

/* ───────────────────── 6. 「失败时老包一个字节都没动」 ───────────────────── */

console.log("\n6. ★ `:313` 的承诺：新的一份拷不进去时，老包必须原样");
{
  // 先正常挂上第一版，记下它的逐字节内容。
  const item = newItem("old-package-protected");
  const v1 = makeMarkdown("v1-doc", { body: () => "# 第一版\n\n原始内容不可变\n" });
  const first = runProbe(item, v1.md);
  check("第一版挂上了", first.result.includes('"ok":true'), first);

  const pkgDir = join(IMPORTED, item);
  const mdPath = join(pkgDir, "doc.md");
  const before = existsSync(mdPath) ? readFileSync(mdPath) : null;
  check("老包确实存在且可读", before !== null && before.length > 0, { mdPath });

  // 第二版：源文件本身没问题，但**让暂存目录不可写**，逼 `:313` 的 cpSync 失败。
  // ⚠️ 这一步在 Windows 上要靠 icacls；chmod 对目录基本无效（探针里会如实报告）。
  const v2 = makeMarkdown("v2-doc", { body: () => "# 第二版\n\n不应该被挂上\n" });
  const denied = denyWriteIn(IMPORTED);
  const second = runProbe(item, v2.md);
  allowAll(IMPORTED);

  check("第二版没有返回 ok:true（复制确实失败了）",
    !second.result.includes('"ok":true'), { second, denied });
  const after = existsSync(mdPath) ? readFileSync(mdPath) : null;
  check("★ 老包逐字节未变",
    before !== null && after !== null && before.equals(after),
    { beforeBytes: before?.length, afterBytes: after?.length, same: before !== null && after !== null && before.equals(after) });
}


/* ───────────────────── 3d. ★ 同一目录被引用两次 ───────────────────── */

console.log("\n3d. ★ 同一份 md 两处引用**同一目录** —— 第二次复制时目标已存在");
{
  // 【T107】这是 `filter` 救不了的第 3 格：**非 ASCII 源 + 目标已有同名文件**。
  // `cpSync` 会抛 `errno=0`（信息写着 "The operation completed successfully"），
  // **且实际没拷**。这里的目标是 `stageDir` —— 同一次运行里第一次复制建的。
  //
  // 修前实测：`ok:true`、`imageCount:1`、`missing` 里一条「图表/a.png(, The operation
  // completed successfully. …)」。**用户看到「成功，缺 1 个图」**，而那张图在源里
  // 好好的 —— 它是被算了两次、第二次失败。
  const item = newItem("dup-dir-ref");
  const dir = join(WORK, "重复引用");
  mkdirSync(join(dir, "图表"), { recursive: true });
  writeFileSync(join(dir, "图表", "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 3]), "binary");
  const md = join(dir, "doc.md");
  // 先引用整个目录，再引用同一目录里的文件 —— 两次都会走到 `:242`
  writeFileSync(md, "# t\n\n![整目录](图表/)\n\n![单文件](图表/a.png)\n", "utf8");
  const r = runProbe(item, md);
  let parsed: { ok?: boolean; imageCount?: number; missing?: unknown } = {};
  try { parsed = JSON.parse(r.result.replace("PROBE_RESULT:", "")); } catch { /* 保持空 */ }
  check("★ 子进程没有崩（status === 0）", r.status === 0, r);
  check("★ adopt 返回 ok:true", parsed.ok === true, r);
  check("★ 图还在（两次引用都算成功）", packageContents(item).some((p) => p.includes("a.png")), packageContents(item));
  // **关键**：修前 `missing` 里会有那条骗人的错误，而图其实在。
  // 断言它为空 —— 因为「图存在」和「报了缺图」同时为真是自相矛盾的。
  check("★ missing 为空（不许把「复制成功」报成「缺文件」）",
    Array.isArray(parsed.missing) && parsed.missing.length === 0, r);
}

console.log(`\nt91-adopt-markdown-cp-smoke:${total - failures}/${total} 通过`);
process.exit(failures === 0 ? 0 : 1);
