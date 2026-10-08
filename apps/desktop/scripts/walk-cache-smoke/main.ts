/**
 * `main/lib/walkCache.ts` 的独占套件 —— 这个文件在本套之前**一套覆盖都没有**,
 * 而它恰好是"没有 ripgrep 的机器上每次 `file:search` 都整棵重走"这个性能坑的正主。
 *
 * ## 它盯的是什么
 *
 * `cachedTreeFiles` 给搜索结果缓存一份"这棵树下所有文件"的扁平表,靠 `fs.watch` 在
 * 任何变更时把 `entry.dirty` 置真来失效。置真之后**必须有人把它改回 false**,否则
 * 缓存从此**永久作废** —— 后果不是"结果错",是"每次搜索都重走整棵树",而这条 walk
 * 存在的全部理由就是别这么做。所以本套的核心断言是**失效之后缓存要能重新立起来**。
 *
 * 判据立在**数组引用**上:`cachedTreeFiles` 命中缓存时返回的是内部 `entry.files`
 * 本身,重建时返回的是一支新数组。于是"连着两次调用拿到同一支数组" = 缓存生效;
 * "拿到两支不同的数组" = 又重走了一遍。这是无头下唯一不需要读日志就能量出
 * "到底重走没重走"的判据。
 *
 * ## 平台
 *
 * 递归 `fs.watch` 只在 win32 / darwin 上可用(见源码里那句 `watchOk`)。
 * 别的平台上 watcher **不会被装上**,`dirty` 也就永远不会被置真 —— 那条断言在那里
 * 量不到东西,所以**显式跳过并打印**(不静默略过,也不伪称通过)。与平台无关的几条
 * (基本枚举 / 忽略表 / 预算)在所有平台都跑。
 *
 * 不起 Electron、不联网、不碰真项目:整棵树是 `mkdtemp` 出来的,用完即删。
 *
 * Run: scripts/walk-cache-smoke/run.sh
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedTreeFiles, sortDirents, SEARCH_MAX_DEPTH, SEARCH_MAX_VISIT } from "@main/lib/walkCache.js";

let failures = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  total++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}
function section(title: string): void {
  console.log(`\n${title}`);
}

const NO_IGNORE: ReadonlySet<string> = new Set();

const ROOT = mkdtempSync(join(tmpdir(), "mcode-walk-cache-"));
const relsOf = (files: Array<{ relPath: string }>): string[] => files.map((f) => f.relPath).sort();

/* ──────────────── §1 基本枚举 ──────────────── */

section("§1 基本:枚举出整棵树的文件,relPath 用正斜杠");

{
  mkdirSync(join(ROOT, "src", "deep"), { recursive: true });
  writeFileSync(join(ROOT, "a.txt"), "a", "utf8");
  writeFileSync(join(ROOT, "src", "b.ts"), "b", "utf8");
  writeFileSync(join(ROOT, "src", "deep", "c.ts"), "c", "utf8");

  const { files, incompleteScan } = await cachedTreeFiles(ROOT, NO_IGNORE);
  eq("三层的文件都收了", files.length, 3);
  check(
    "relPath 是项目相对的、用正斜杠(src/deep/c.ts)",
    relsOf(files).includes("src/deep/c.ts"),
    relsOf(files),
  );
  check("没有目录混进文件表里", files.every((f) => !f.relPath.endsWith("/")), relsOf(files));
  eq("没有越界就报 incompleteScan=false", incompleteScan, false);
}

/* ──────────────── §2 忽略表 ──────────────── */

section("§2 忽略表:按目录名整段跳过");

{
  const root = join(ROOT, "ignored");
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(root, "keep.txt"), "k", "utf8");
  writeFileSync(join(root, "node_modules", "pkg", "skip.js"), "s", "utf8");

  const { files } = await cachedTreeFiles(root, new Set(["node_modules"]));
  check("保留的文件在", relsOf(files).includes("keep.txt"), relsOf(files));
  check(
    "node_modules 底下的一个都没进来",
    files.every((f) => !f.relPath.startsWith("node_modules")),
    relsOf(files),
  );
}

/* ──────────────── §3 预算:太深要显式报,不静默截断 ──────────────── */

section("§3 深度预算:超深要报 incompleteScan,不静默截断");

{
  const root = join(ROOT, "deep");
  // 建到比预算深两级:最后那两级里各放一个文件,它们注定收不到。
  let cur = root;
  for (let i = 0; i < SEARCH_MAX_DEPTH + 2; i++) {
    cur = join(cur, "d");
    mkdirSync(cur, { recursive: true });
  }
  writeFileSync(join(cur, "too-deep.txt"), "x", "utf8");
  writeFileSync(join(root, "top.txt"), "x", "utf8");

  const { files, incompleteScan } = await cachedTreeFiles(root, NO_IGNORE);
  check("顶层的文件收得到", relsOf(files).includes("top.txt"), relsOf(files));
  eq("★ 超深时 incompleteScan=true(不许拿一份截断的当完整)", incompleteScan, true);
  check(
    "…而且超深那个文件确实没进来(证明预算真的生效了,不是空的断言)",
    !relsOf(files).some((r) => r.endsWith("too-deep.txt")),
    relsOf(files),
  );
}

/* ──────────────── §4 排序助手 ──────────────── */

section("§4 排序:目录在前、其余按名字大小写不敏感");

{
  const dirents = [
    { name: "b.txt", isDirectory: () => false, isFile: () => true },
    { name: "A.txt", isDirectory: () => false, isFile: () => true },
    { name: "zdir", isDirectory: () => true, isFile: () => false },
  ] as never[];
  sortDirents(dirents as never);
  eq("目录排到了最前", (dirents[0] as { name: string }).name, "zdir");
  eq("剩下的按大小写不敏感排(A 在 b 前)", (dirents[1] as { name: string }).name, "A.txt");
  eq("最后是 b.txt", (dirents[2] as { name: string }).name, "b.txt");
}

/* ──────────────── §5 缓存失效后必须能重新立起来(核心回归) ──────────────── */

section("§5 ★ 缓存失效之后要能重新生效(否则每次搜索都整棵重走)");

{
  const recursiveWatch = process.platform === "win32" || process.platform === "darwin";
  if (!recursiveWatch) {
    console.log(
      `     跳过:递归 fs.watch 只在 win32/darwin 上可用(当前 ${process.platform}),` +
        "这一档量不到东西 —— 不伪称通过。",
    );
  } else {
    const root = join(ROOT, "cache");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "one.txt"), "1", "utf8");

    // ① 首次建缓存。
    const first = await cachedTreeFiles(root, NO_IGNORE);
    check("第一次就看到了 one.txt", relsOf(first.files).includes("one.txt"), relsOf(first.files));

    // ② 落一个新文件 → watcher 异步把缓存置脏 → 反复调直到 two.txt 出现。
    writeFileSync(join(root, "two.txt"), "2", "utf8");
    let afterChange: Awaited<ReturnType<typeof cachedTreeFiles>> | null = null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && afterChange === null) {
      const r = await cachedTreeFiles(root, NO_IGNORE);
      if (r.files.some((f) => f.relPath === "two.txt")) afterChange = r;
      else await new Promise((res) => setTimeout(res, 50));
    }
    check(
      "★ 新文件落地之后缓存被失效、重建后看得到 two.txt",
      afterChange !== null,
      afterChange && relsOf(afterChange.files),
    );

    // ③ **核心判据**:紧接着再调一次(此间没有新变更)—— 应当是缓存命中,
    //    拿到的是**同一支数组**。带着 `dirty` 不复位的 bug 时,② 那次重建会把
    //    `entry.files` 留成 null,这一次于是又整棵重走、给出一支新数组。
    if (afterChange) {
      const again = await cachedTreeFiles(root, NO_IGNORE);
      check(
        "★ 失效重建之后缓存重新立了起来(连着两次拿到同一支数组 = 没有再次重走整棵树)",
        again.files === afterChange.files,
        {
          sameRef: again.files === afterChange.files,
          note: "false = 每次搜索都在整棵重走,walkCache 的存在意义被抹掉",
        },
      );
      check(
        "…而且重建后的内容仍然是对的(two.txt 还在)",
        relsOf(again.files).includes("two.txt"),
        relsOf(again.files),
      );
    }
  }
}

/* ──────────────── §6 常量 ──────────────── */

section("§6 预算常量");

{
  check("深度预算是个正整数", Number.isInteger(SEARCH_MAX_DEPTH) && SEARCH_MAX_DEPTH > 0, SEARCH_MAX_DEPTH);
  check("访问预算是个正整数", Number.isInteger(SEARCH_MAX_VISIT) && SEARCH_MAX_VISIT > 0, SEARCH_MAX_VISIT);
  check(
    "访问预算足够大(老值是 8000,深一点的仓库会静默截断)",
    SEARCH_MAX_VISIT >= 20000,
    SEARCH_MAX_VISIT,
  );
}

rmSync(ROOT, { recursive: true, force: true });

// ★ 源码不变量:`collectTreeFilesUncached` 里不许再出现 `startsWith(root + sep)` 那种**恒真**
//   越界守卫。`abs` 始终在 `root` 子树内、`d.name` 来自 readdir 永不含分隔符,所以那句永远
//   为真 —— 看着在拦越界、其实拦不住任何东西,给人"这里已经查过"的错觉。真需要越界判断时
//   得用 `pathWithin`(见 `ipc/files.ts`)。
{
  const src = readFileSync(join(process.cwd(), "src/main/lib/walkCache.ts"), "utf8");
  // 去注释再判 —— 说明那句"别写 startsWith(root + sep)"的注释本身会提到这个写法。
  const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  check(
    "★ walkCache 里没有恒真的 startsWith(root+sep) 假越界守卫",
    !/startsWith\(root \+ /.test(code),
    /startsWith\(root \+ [^)]*\)/.exec(code)?.[0] ?? "",
  );
}

console.log(`\nwalk-cache-smoke:${total - failures}/${total} 通过`);
// ⚠️ **显式退。** `cachedTreeFiles` 会挂一个**递归 `fs.watch`**(见 §5),watcher 活着
// 就吊着 Node 的事件循环 —— 不写这一行,脚本跑完所有断言之后不会退出,套件会挂到超时。
process.exit(failures === 0 ? 0 : 1);
