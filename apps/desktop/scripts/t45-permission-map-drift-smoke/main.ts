/**
 * 【T45】**新 RPC 不许静默进入扩展委托面。**
 *
 * ## 盯的缺陷
 *
 * `policy.ts` 的兜底是**有意**的(文件头:「新加的 RPC 没人来归类时,宁可多问一次」)。
 * 对 agent 侧这是正确的;但 `gen-module-permission-map.mjs` 会把兜底结果**直接翻译成
 * 一张扩展权限** —— 一条新方法兜底判 `write`,`writePerm[domain]` 就发一张域写权限;
 * 判 `read` 就发域读权限。**没有人对"该不该给扩展"做过决定**,而且生成器不会报错。
 *
 * 卡面记录的真实案例:10 条方法(`document.apps` … `framework.reset`)就是这样一次进来的。
 *
 * ## 守卫(本套逐条钉住)
 *
 * 生成器拿**已提交的** `appPermission.ts` 当上一次快照;目录里有、快照里没有的方法
 * = 新方法。新方法必须满足其一才放行:
 *   1. 在 `policy.ts` 四张显式表里;
 *   2. 在生成器的 `overrides` / `nonDelegableOverrides` 里;
 *   3. 在 `REVIEWED_FALLBACKS` 里逐条签字。
 *
 * ## 断言
 *
 * 1. **现状不误报**:对当前仓库跑生成器 → exit 0、`appPermission.ts` 逐字节不变。
 * 2. **正向控制**:老方法(靠兜底的那 200 多条)不触发守卫 —— 证明判据是「新」而不是「兜底」。
 * 3. **变异**:往目录插一条 `policy.ts` 里没有的方法 → exit 1、错误里点名该方法、
 *    并说明它会拿到哪张权限;逐字节还原后复绿。
 * 4. **守卫自检**:`policy.ts` 表形状变化时(读到的键 < 100)明确报错,而不是把
 *    全仓库方法报成「未分类」。
 * 5. **快照来源**:比较的是 `git show HEAD:` 而不是工作区文件 —— 否则本地漂移看不见。
 *
 * 全部只读 + 临时目录;不写仓库任何文件(变异那段用备份/还原,套件自己跑时跳过)。
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(process.cwd(), "../..");
const GEN = join(root, "apps/desktop/scripts/gen-module-permission-map.mjs");
const CATALOG = join(root, "apps/desktop/src/main/appControl/apiCatalog.generated.ts");
const PERMISSIONS = join(root, "packages/contracts/src/appPermission.ts");

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}

function runGenerator(): { status: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", GEN], {
    cwd: root, encoding: "utf8", timeout: 120_000,
  });
  return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/* ── 1. 现状:不误报、不产生 diff ─────────────────────────── */

console.log("\n① 现状不误报");
{
  const before = readFileSync(PERMISSIONS, "utf8");
  const r = runGenerator();
  check("生成器 exit 0(当前仓库没有未归类的新方法)", r.status === 0, { status: r.status, err: r.err.slice(0, 400) });
  check("appPermission.ts 逐字节不变", readFileSync(PERMISSIONS, "utf8") === before);
  check("正常路径不打印拒绝信息", !r.err.includes("没有被显式分档") && !r.err.includes("没有人对"), r.err.slice(0, 200));
}

/* ── 2. 正向控制:老方法靠兜底但不该触发守卫 ──────────────── */

console.log("\n② 正向控制 —— 判据是「新」不是「兜底」");
{
  // 直接算一遍:当前目录里有多少条方法不在 policy.ts 的四张显式表里。
  // 这些是**靠兜底的老方法**,守卫必须放行它们 —— 否则它就不是「新方法守卫」,
  // 而是「重写 policy.ts 的设计」。
  const policySrc = readFileSync(join(root, "apps/desktop/src/main/appControl/policy.ts"), "utf8");
  function keysOf(name: string): Set<string> {
    const start = policySrc.indexOf(`const ${name}`);
    assert.ok(start >= 0, `policy.ts 里找不到 ${name}`);
    const nextConst = policySrc.indexOf("\nconst ", start + 1);
    const slice = nextConst < 0 ? policySrc.slice(start) : policySrc.slice(start, nextConst);
    const keys = new Set<string>();
    for (const m of slice.matchAll(/^\s{2}"([A-Za-z0-9_.]+)":/gm)) keys.add(m[1]!);
    for (const m of slice.matchAll(/^\s{2}\["([A-Za-z0-9_.]+)",/gm)) keys.add(m[1]!);
    return keys;
  }
  const explicit = new Set([
    ...keysOf("BLOCKED"), ...keysOf("CREDENTIAL_BEARING"), ...keysOf("DANGER"), ...keysOf("EXPLICIT"),
  ]);
  const catalogSrc = readFileSync(CATALOG, "utf8");
  const methods = [...catalogSrc.matchAll(/"method": "([^"]+)"/g)].map((m) => m[1]!);
  const fallbackOnly = methods.filter((m) => !explicit.has(m));
  check(
    "★ 靠兜底的老方法是多数(证明确实不能要求「全部显式分档」)",
    fallbackOnly.length > 100,
    { fallbackOnly: fallbackOnly.length, total: methods.length },
  );
  check(
    "★ 守卫放行了这些老方法(生成器 exit 0 —— 见 ①)",
    fallbackOnly.length > 100 && runGenerator().status === 0,
  );
  check(
    "四张显式表合计 >100 条(表没读空)",
    explicit.size > 100,
    { explicit: explicit.size },
  );
}

/* ── 3. 变异:插一条新方法 → 必须 exit 1 并点名 ───────────── */

console.log("\n③ 变异 —— 新方法必须被拦");
{
  const backup = join(mkdtempSync(join(tmpdir(), "t45-catalog-")), "catalog.bak");
  copyFileSync(CATALOG, backup);
  const permissionsBeforeMutation = readFileSync(PERMISSIONS, "utf8");
  try {
    const src = readFileSync(CATALOG, "utf8");
    const anchor = '  "method": "document.toolsList",';
    assert.equal(src.split(anchor).length - 1, 1, "目录锚点应唯一");
    const injected =
      '  "method": "document.brandNewRead",\n' +
      '  "channel": "document:brandNewRead",\n' +
      '  "doc": "[T45 smoke] synthetic new method",\n' +
      '  "input": "{}",\n' +
      '  "inputFull": "{}",\n' +
      '  "output": "{}"\n' +
      ' },\n {\n';
    writeFileSync(CATALOG, src.replace(anchor, injected + anchor), "utf8");

    const r = runGenerator();
    check("★ 新方法 → 生成器 exit 1", r.status === 1, { status: r.status });
    check("★ 错误里点名了那条新方法", r.err.includes("document.brandNewRead"), r.err.slice(0, 300));
    check(
      "★ 错误说明了它会拿到哪张权限（不只是「未分类」）",
      r.err.includes("document.edit"),
      r.err.slice(0, 400),
    );
    check("★ 错误给了两条出路(显式分档 / REVIEWED_FALLBACKS)", r.err.includes("REVIEWED_FALLBACKS") && r.err.includes("policy.ts"));
    // 真断言:生成器在 `writeFileSync` 之前就 `process.exit(1)`,所以失败那次**不该**
    // 碰过 appPermission.ts。用「变异期间文件字节 == 变异前快照」来证明,而不是恒 true。
    check(
      "★ 失败时不写 appPermission.ts",
      readFileSync(PERMISSIONS, "utf8") === permissionsBeforeMutation,
      { changed: readFileSync(PERMISSIONS, "utf8") !== permissionsBeforeMutation },
    );
  } finally {
    copyFileSync(backup, CATALOG);
    rmSync(backup, { force: true });
  }

  check("目录已逐字节还原", (() => {
    const r = spawnSync("git", ["status", "--porcelain", "apps/desktop/src/main/appControl/apiCatalog.generated.ts"], {
      cwd: root, encoding: "utf8",
    });
    return (r.stdout ?? "").trim() === "";
  })());

  const after = runGenerator();
  check("还原后复跑 exit 0", after.status === 0, { status: after.status });
}

/* ── 4. 守卫自检:表形状变了要明确报错 ────────────────────── */

console.log("\n④ 守卫自检");
{
  const genSrc = readFileSync(GEN, "utf8");
  check(
    "★ 有「读到的表条目 < 100 就报错」的自检",
    /explicitlyClassified\.size\s*<\s*100/.test(genSrc),
  );
  check(
    "★ 自检的报错说明「表形状变了,先修 keysOfTable」",
    genSrc.includes("keysOfTable"),
    genSrc.slice(0, 100),
  );
  check(
    "★ 快照来自 `git show HEAD:` 而不是工作区文件",
    genSrc.includes('"show"') && genSrc.includes("HEAD:"),
  );
  check(
    "★ 快照取不到时明确退化(并说明会怎样),不静默",
    genSrc.includes("status === 0"),
  );
  // 【T45 补强,总控 2026-10-23 建议】只查总量不够:一张表改了写法、合并、换成函数,
  // 合并后的总数可能仍 >100,自检放过,而那张表里的方法全部被误判成"新方法" ——
  // 假红混进真信号。所以四张表必须**逐张**断言非空。
  check(
    "★ 四张表逐张断言(不是只查合并后的总数)",
    /for \(const name of EXPLICIT_TABLES\)/.test(genSrc) &&
      /tableKeys\[name\]\.size === 0/.test(genSrc),
  );
  check(
    "★ 缺表时的报错点名是哪张表（不是笼统的「表形状变了」）",
    /T45 守卫从 policy\.ts 的 \$\{name\} 里一条键都没读到/.test(genSrc),
  );
  check(
    "★ 总量自检的报错里带每张表的条数(方便定位是哪张退化)",
    /EXPLICIT_TABLES\.map\(\(n\) => `\$\{n\}=\$\{tableKeys\[n\]\.size\}`\)/.test(genSrc),
  );
  // 四张表在当前 policy.ts 上都必须真的读到东西。
  {
    const policySrc = readFileSync(join(root, "apps/desktop/src/main/appControl/policy.ts"), "utf8");
    const counts: Record<string, number> = {};
    for (const name of ["BLOCKED", "CREDENTIAL_BEARING", "DANGER", "EXPLICIT"]) {
      const start = policySrc.indexOf(`const ${name}`);
      assert.ok(start >= 0, `policy.ts 里找不到 ${name}`);
      const nextConst = policySrc.indexOf("\nconst ", start + 1);
      const slice = nextConst < 0 ? policySrc.slice(start) : policySrc.slice(start, nextConst);
      let n = 0;
      for (const _ of slice.matchAll(/^\s{2}"([A-Za-z0-9_.]+)":/gm)) n++;
      for (const _ of slice.matchAll(/^\s{2}\["([A-Za-z0-9_.]+)",/gm)) n++;
      counts[name] = n;
    }
    check(
      "★ 现在四张表都解析到了(不是 0)",
      Object.values(counts).every((n) => n > 0),
      counts,
    );
    check(
      "四张表的条数与该表在 policy.ts 里的规模相称(各 >5)",
      Object.values(counts).every((n) => n > 5),
      counts,
    );

    // 【T45 补强 ③,总控 2026-10-23】**条数不得减少**。
    //
    // 为什么不是「钉成具体数字」:加档位是**正常开发**(新 RPC 显式分类),钉死会让
    // 每一次正常开发都触发红 —— 那种红会教人「顺手改一下断言」,套件就逐渐失去意义。
    //
    // 为什么是「不得减少」:删档位是**危险信号** —— 意味着有人把一个方法从审批表里
    // 拿掉了。那正是这个守卫要抓的东西,而且语义明确:不是「数字变了」,是「有东西被删了」。
    //
    // 基线需要**下调**时(合法的删除),必须改这一行 —— 那是一个显式的决定,
    // 而不是让断言自然通过。
    const EXPECTED_MIN: Record<string, number> = {
      BLOCKED: 57,
      /* 【2026-10-28 下调，逐条核过】基线是「不得减少」的下限，下调是一个显式决定。
       *
       * 下面三个数都降了，**每条减少都能追到「那个方法本身已不存在」**，
       * 不是有人把还在用的方法从审批表里拿掉了（那才是这套要抓的）：
       *
       * | 少了 | 原因 |
       * |---|---|
       * | `automation.watchTemplates` / `watchStatus` | 长任务守望 2026-10-27 移除，RPC 已删 |
       * | `automation.watchTemplatesSave` | 同上 |
       * | `onlyoffice.sessionState` | OnlyOffice 2026-10-24 整体移除 |
       * | `modules.install` / `modules.remove` | ModuleHost 2026-10-27 下线 |
       *
       * 另外**两条不是减少、是搬家**，数了才知道：
       *   - `workflowEngine.nodeInstall`：DANGER → **BLOCKED**（更严，Agent 通道压根拿不到）；
       *   - `claude.saveSubagents`：曾被 `7e83e40f7` 连同上面那批**误删**（它没有随
       *     ModuleHost 消失，RPC 与 `subagentStore.saveSubagents()` 都在），
       *     已在本轮补回 DANGER —— 这条正是「条数不得减少」抓到的，判据有效。
       *
       * 所以：CREDENTIAL 17→14、DANGER 94→93、EXPLICIT 81→79 都是真实的合法删除。
       * ⚠️ 下次再看到这里红，**先按上表那样逐条查方法还在不在**，别直接改数字。 */
      CREDENTIAL_BEARING: 14,
      DANGER: 93,
      EXPLICIT: 79,
    };
    for (const [name, min] of Object.entries(EXPECTED_MIN)) {
      check(
        `★ policy.ts 的 ${name} 条数不得减少（${min} → ${counts[name]}）`,
        counts[name]! >= min,
        { table: name, baseline: min, actual: counts[name] },
      );
    }
  }
}

/* ── 5. 守卫不会绕过已签字的例外 ─────────────────────────── */

console.log("\n⑤ 例外通道是显式的");
{
  const genSrc = readFileSync(GEN, "utf8");
  check("存在 REVIEWED_FALLBACKS 这个签字表", genSrc.includes("REVIEWED_FALLBACKS"));
  check(
    "★ 签字表要求逐条写理由(注释里说明了格式)",
    genSrc.includes("为什么这个方法的兜底档位对扩展委托面是安全的"),
  );
  check(
    "守卫同时认 overrides / nonDelegableOverrides(不必重复签字)",
    genSrc.includes("(m in overrides)") && genSrc.includes("nonDelegableOverrides.has(m)"),
  );
}

console.log(`\nt45-permission-map-drift-smoke: ${passed}/${passed + failed} 通过`);
if (failed > 0) process.exitCode = 1;
