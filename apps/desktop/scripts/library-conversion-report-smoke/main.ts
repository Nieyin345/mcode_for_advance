/**
 * Headless smoke for `conversionReport` —— 设置页那条「这一篇转录完整吗」的判据。
 *
 * ## 钉的一件事:同一个规则不许有两份实现(硬规矩 2)
 *
 * 「一份 Markdown 引用了哪些本地配图」这条规则只有一处该说准。`adoptMarkdown.assetRefsOf`
 * 在 2026-09-29(commit 92f72b1f)补齐了**三种**写法 —— 行内式 `![](path)`、引用式
 * `![alt][id]` + `[id]: path`、裸 HTML `<img src=…>` —— 因为"用户手上那份 md 不一定出自
 * 哪个工具"(文件头原话)。
 *
 * 而 `conversionReport` 里那份"等价"扫描**只认行内式**,没跟着改。于是:
 *
 *   - 一份**引用式 / HTML 写法**的转录,缺了图也照样报 `assetsOk: true` / `complete: true`
 *     —— 用户拿到的是一份断图的包,设置页却说它完整。这正是"坏东西不报出来"的形状。
 *   - `imageRefs` 也少算了那两种写法。
 *
 * 判据落在用户能看到的那两行上(`assetsOk` / `complete`),不落在机制上。
 *
 * 数据根换成本脚本自己的临时目录(见 run.sh 的 `--alias`),跑完就删 —— 它会真的建库、
 * 真的往"库根"里写文件。
 *
 * Run: scripts/library-conversion-report-smoke/run.sh
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

const DATA = mkdtempSync(join(tmpdir(), "mcode-convreport-"));
process.env.MCODE_SMOKE_DATA_ROOT = DATA;

const { initDb } = await import("@main/store/db.js");
const { LibraryRepo } = await import("@main/store/repositories.js");
const { conversionReport } = await import("@main/library/convert.js");
const { libraryRoot } = await import("@main/library/paths.js");

await initDb();

/** 把一份 Markdown 包落到 `markdown/imported/<id>/full.md`,并把条目指过去。 */
function seedReport(title: string, mdBody: string, images: string[]): string {
  const id = LibraryRepo.upsert({ title }).id;
  const dir = join(libraryRoot(), "markdown", "imported", id);
  mkdirSync(dir, { recursive: true });
  for (const p of images) {
    const abs = join(dir, ...p.split("/"));
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, Buffer.from([1, 2, 3]));
  }
  writeFileSync(join(dir, "full.md"), mdBody, "utf8");
  LibraryRepo.setMarkdown(id, `markdown/imported/${id}/full.md`);
  return id;
}

const rowOf = (id: string) => conversionReport().find((r) => r.id === id)!;

/* ──────────────── 1. 三种写法都要数进去;缺的图必须报出来 ──────────────── */

console.log("\n转录检测 · 三种图片写法都要认");

// 行内式指向存在的图;引用式与裸 HTML 都指向**不存在**的图 —— 老写法完全看不见后两条,
// 于是判成"完整"。
{
  const body = [
    "# t",
    "![inline](images/ok.png)",
    "![alt][f1]",
    '<img src="images/html-missing.png" width="600">',
    "",
    "[f1]: images/ref-missing.png",
    "",
  ].join("\n");
  const id = seedReport("mixed forms", body, ["images/ok.png"]);
  const row = rowOf(id);
  eq("三种写法都数进 imageRefs", row.imageRefs, 3);
  check("缺图(引用式 / HTML)如实判为不齐", row.assetsOk === false, row);
  check("因此不算完整", row.complete === false, row);
}

/* ──────────────── 2. 对照:图都在才算完整(没把上面那条修成恒 false) ──────────────── */

console.log("\n转录检测 · 图都在才叫完整");

{
  const id = seedReport("all present", "![a](images/a.png)\n![b][x]\n\n[x]: images/b.png\n", [
    "images/a.png",
    "images/b.png",
  ]);
  const row = rowOf(id);
  eq("图数 2", row.imageRefs, 2);
  check("图齐 → assetsOk", row.assetsOk === true, row);
  check("图齐 → complete", row.complete === true, row);
}

/* ──────────────── 3. 外链 / 内联数据既不算引用也不该把它判坏 ──────────────── */

console.log("\n转录检测 · 外链与内联数据不算本地图片");

{
  const id = seedReport("remote", "![r](https://example.com/y.png)\n![d](data:image/png;base64,AAAA)\n", []);
  const row = rowOf(id);
  eq("外链与 data: 都不数", row.imageRefs, 0);
  check("也不因此判为不齐", row.assetsOk === true, row);
  check("无图也算完整", row.complete === true, row);
}

/* ──────────────── 4. 带 title 的行内式:路径要取对 ──────────────── */

console.log("\n转录检测 · 行内式带可选 title");

// `![](images/a.png "图注")` —— 路径与 title 之间是空白。老扫描会把整串 `images/a.png "图注"`
// 当路径去查,查不到就误判不齐。共用的那份(`assetRefsOf`)只取空白前那一段。
{
  const id = seedReport("titled", '![a](images/a.png "图注")\n', ["images/a.png"]);
  const row = rowOf(id);
  eq("带 title 的引用也数进去", row.imageRefs, 1);
  check("路径取对了 → 图找得到 → 齐", row.assetsOk === true, row);
}

rmSync(DATA, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
