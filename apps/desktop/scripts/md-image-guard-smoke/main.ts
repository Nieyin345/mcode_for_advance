/**
 * `file:readBinary` 能不能读**数据根下**的图片 —— md 预览里图片那一环的围栏测试。
 *
 * ## 为什么单独测这一条
 *
 * `FileViewer` 预览 md 时，图片走的是 `Markdown` → `MarkdownLocalImage` →
 * `api.file.readBinary`。而**那条 IPC 有项目根围栏**（`pathGuard`）——
 * 于是资料库里那些 md 的相对图片能不能显示，完全取决于围栏认不认**数据根**下的路径。
 *
 * 这一条以前没人测过：`FileViewer` 里原本压根没传 `baseDir`（见 3.8⑧），
 * 所以那条路从来没被走到过。现在修了，就得把围栏这一环钉住 ——
 * 不然"图还是裂的"会以另一种原因重现，而且同样不报错。
 *
 * ## 判据
 *
 *  1. 数据根下 `<数据根>/library/.../images/1.png` → **放行**
 *  2. 数据根下 `<数据根>/templates/...` → **放行**
 *  3. **数据根本身**（`<数据根>/mcode.db`）→ **挡住**（那是刻意收窄的，见 pathGuard 注释）
 *  4. 项目根下 → 放行（本来就有）
 *  5. 完全在外面的路径 → 挡住
 *
 * Run: scripts/md-image-guard-smoke/run.sh
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "mcode-mdimg-"));
const DATA = join(TMP, "data");
const PROJECT = join(TMP, "proj");
mkdirSync(join(DATA, "library", "notes", "images"), { recursive: true });
mkdirSync(join(DATA, "templates", "deck"), { recursive: true });
mkdirSync(PROJECT, { recursive: true });
mkdirSync(join(TMP, "outside"), { recursive: true });

// 造几个真的文件
writeFileSync(join(DATA, "library", "notes", "images", "1.png"), "fakepng");
writeFileSync(join(DATA, "templates", "deck", "a.txt"), "x");
writeFileSync(join(PROJECT, "a.jpg"), "jpg");
writeFileSync(join(TMP, "outside", "b.png"), "png");

/**
 * ⚠️ **别在 `DATA/mcode.db` 那个位置写东西。**
 *
 * 第一版往那儿写了个 `"db"` 当"数据根下的敏感文件"的样例，结果 `initDb()` 打开的是
 * **同一个路径**（数据根就是 DATA）—— sqlite 撞上一坨不是数据库的字节，报
 * `file is not a database`，整个套件在第一步就崩了。
 *
 * 这一条要测的只是"**围栏认不认那个路径**"，跟文件内容无关，所以拿一个不存在的
 * 路径去问就够了。
 */
const DB_LIKE_PATH = join(DATA, "mcode.db");

process.env.MCODE_SMOKE_DATA_ROOT = DATA;

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

const { findContainingWorkspaceRoot } = await import("@main/lib/pathGuard.js");
const { initDb } = await import("@main/store/db.js");
const { ProjectRepo } = await import("@main/store/repositories.js");

/**
 * ⚠️ **必须先 initDb。**
 *
 * `findContainingWorkspaceRoot` 的第一跳是 `findContainingProject`，而那个要查
 * 项目表 —— 数据库没起来时它直接抛 `getDb() called before initDb() resolved`。
 * （顺带说明了一件事：**数据根那两条判据排在项目查询之后**，所以"项目根之外"
 * 这个判断天然含了"数据根不是项目根"。）
 */
await initDb();

/** 造一个项目根 —— 这样 `findContainingProject` 才认得它。 */
ProjectRepo.create({
  id: "p1",
  name: "proj",
  path: PROJECT,
  archived: false,
  createdAt: Date.now(),
  updatedAt: Date.now(),
} as never);

/* ── 1. 数据库根下那两块：放行（md 的图片在这一层） ── */

console.log("\n1. 数据根下（md 图片就在这儿）");

check(
  "★ library 下的图片放行",
  findContainingWorkspaceRoot(join(DATA, "library", "notes", "images", "1.png")) !== null,
);
check(
  "★ templates 下的文件放行",
  findContainingWorkspaceRoot(join(DATA, "templates", "deck", "a.txt")) !== null,
);

/* ── 2. 数据根本身：挡住（刻意收窄） ── */

console.log("\n2. 数据根本身（刻意不放）");

check(
  "★ 数据根下的 mcode.db 挡住",
  findContainingWorkspaceRoot(DB_LIKE_PATH) === null,
  findContainingWorkspaceRoot(DB_LIKE_PATH),
);

/* ── 3. 项目根：本来就有 ── */

console.log("\n3. 项目根");

check(
  "★ 项目根下的文件放行",
  findContainingWorkspaceRoot(join(PROJECT, "a.jpg")) !== null,
  findContainingWorkspaceRoot(join(PROJECT, "a.jpg")),
);

/* ── 4. 完全在外面 ── */

console.log("\n4. 外面");

check(
  "★ 数据根外的路径挡住",
  findContainingWorkspaceRoot(join(TMP, "outside", "b.png")) === null,
  findContainingWorkspaceRoot(join(TMP, "outside", "b.png")),
);

/* ── 5. 前缀陷阱：长得像但不在里面 ── */

console.log("\n5. 前缀陷阱（`libraryX` 不该被当成 `library`）");

{
  mkdirSync(join(DATA, "libraryX"), { recursive: true });
  writeFileSync(join(DATA, "libraryX", "evil.png"), "x");
  check(
    "★ `libraryX/` 不算在 `library/` 里（不是简单 startsWith）",
    findContainingWorkspaceRoot(join(DATA, "libraryX", "evil.png")) === null,
    findContainingWorkspaceRoot(join(DATA, "libraryX", "evil.png")),
  );
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\nmd-image-guard-smoke: ${checks - failures}/${checks} 通过`);
if (failures > 0) process.exit(1);
