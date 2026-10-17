/**
 * onlyoffice-sdk-origin-smoke — 【MC-056】切换 Document Server 后不能拿旧 SDK 的全局凑合。
 *
 * ## 判据从哪来
 *
 * `OnlyOfficeEditorPane.tsx` 的 `loadDocsApi(url)` 模块级逻辑被**原样取出来**
 * （源码里 `// #region docsapi-loader` / `// #endregion docsapi-loader` 两行之间），
 * 交给 esbuild 在**打包期**转成 JS（`run.sh` 的 `--loader:.snippet=ts` 虚拟模块），
 * 再在虚构的 `window` / `document` 上跑。这里的 `window.DocsAPI` 是**测试自己的**
 * 对象，代表"某个服务器已注册的全局 SDK"；`document.head.appendChild` 记录插了几次
 * script。断言关心的是**行为**：切服务器时到底复用了旧全局，还是拒绝。
 *
 * ⚠️ 不做"正则手剥类型注解"：`stripTypes` 那种写法会在 `https://` 的冒号上动刀，
 * 坏了只在运行时炸，看起来像产品代码的问题。类型剥离交给真正的编译器。
 *
 * 为什么不挂 React 组件：`loadDocsApi` 是编辑器生命周期之外的一段独立逻辑，组件
 * 只是它的调用方；组件里其余部分（iframe 容器、轮询）与"SDK 属于哪台服务器"无关。
 * 区段标记的保护：主套件另有一条断言（`documentsSdkSectionIsMarked`）确保两行标记
 * 还在，漂了会红 —— 见 `apps/desktop/scripts/onlyoffice-smoke` 的静态段。
 *
 * Run: scripts/onlyoffice-sdk-origin-smoke/run.sh
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

// ── 1. 从真实源码取出 loader 段（不是副本） ───────────────────────────────
const sourcePath = join(process.cwd(), "src/renderer/components/ide/OnlyOfficeEditorPane.tsx");
const src = readFileSync(sourcePath, "utf8");
const begin = src.indexOf("// #region docsapi-loader");
const end = src.indexOf("// #endregion docsapi-loader");
check("源码里有 loader 区段标记（防止取错段落而静默空跑）", begin >= 0 && end > begin, { begin, end });
if (begin < 0 || end <= begin) {
  console.log(`\nonlyoffice-sdk-origin-smoke: ${total - failures}/${total} 通过`);
  process.exit(1);
}
const snippet = src.slice(begin, end);

// 打包期转好的段以虚拟模块 `virtual:docsapi-loader` 注入（见 run.sh 的 plugin）。
// @ts-expect-error 虚拟模块由构建器提供
const { createLoader } = (await import("virtual:docsapi-loader")) as {
  createLoader: () => {
    loadDocsApi: (url: string) => Promise<unknown>;
    reset: () => void;
  };
};
check("取到的 loader 工厂是函数（段落形状没漂）", typeof createLoader === "function");
if (typeof createLoader !== "function") {
  console.log(`\nonlyoffice-sdk-origin-smoke: ${total - failures}/${total} 通过`);
  process.exit(1);
}

// ── 2. 虚构浏览器全局（必须在 loader 段被求值之前就位） ─────────────────────
// run.sh 的 plugin 会把 loader 段包成"延迟到安装全局之后才 eval"的工厂，
// 所以这里先装全局，再调用工厂拿实现。
type FakeScript = { src: string; onload: (() => void) | null; onerror: (() => void) | null; remove(): void };
let inserted: FakeScript[] = [];
const fakeWindow: Record<string, unknown> = {
  location: { href: "file:///app/out/renderer/index.html" },
};
(globalThis as Record<string, unknown>).window = fakeWindow;
(globalThis as Record<string, unknown>).document = {
  createElement: (): FakeScript => ({ src: "", onload: null, onerror: null, remove() {} }),
  head: {
    appendChild: (s: FakeScript) => {
      inserted.push(s);
      // api.js 的行为：注册全局，然后触发 onload。
      fakeWindow.DocsAPI = { DocEditor: class {} };
      queueMicrotask(() => s.onload?.());
    },
  },
};
const { loadDocsApi, reset } = createLoader();

const A = "https://server-a.test/web-apps/apps/api/documents/api.js";
const B = "https://server-b.test/web-apps/apps/api/documents/api.js";

// ── 3. 首次加载 + 同源复用 ────────────────────────────────────────────────
reset();
delete fakeWindow.DocsAPI;
inserted = [];
const first = await loadDocsApi(A);
check("首次加载 A：拿到全局", Boolean(first));
check("首次加载 A：真的插了一次 script", inserted.length === 1, inserted.map((s) => s.src));
const again = await loadDocsApi(A);
check("同源重复打开：不再插 script", inserted.length === 1, inserted.length);
check("同源重复打开：复用的是同一个对象", again === first);

// ── 4. 切到另一台服务器：必须拒绝，不能复用 A 的全局 ──────────────────────
let switchError: string | null = null;
let switchResolved: unknown = null;
try {
  switchResolved = await loadDocsApi(B);
} catch (err) {
  switchError = err instanceof Error ? err.message : String(err);
}
check("★ 切到 B：被拒绝（不复用 A 的全局）", switchError !== null && switchResolved === null, { switchError, switchResolved: Boolean(switchResolved) });
check("★ 拒绝语点名两台服务器（用户知道该重启谁）", Boolean(switchError && switchError.includes("server-a.test") && switchError.includes("server-b.test")), switchError);
check("★ 切到 B：没有偷偷插入 B 的 script", inserted.length === 1, inserted.length);

// ── 5. 页面里已有一个来源未知的全局：**拒绝**（台账复核反例） ─────────────
// 模块状态（docsApiOrigin）活不过 HMR/重新初始化，而厂商全局只注册一次 —— 这时全局
// 在、模块认不出它来自哪台服务器。旧实现按「就是本次请求的那台」接受，复核反例
// 注入 A 的全局、请求 B，拿到的是 A 且没有加载 B。现在必须 fail-closed。
reset();
inserted = [];
fakeWindow.DocsAPI = { DocEditor: class {} };   // 外部注入、无来源标记
let unknownError: string | null = null;
let unknownResolved: unknown = null;
try {
  unknownResolved = await loadDocsApi(A);
} catch (err) {
  unknownError = err instanceof Error ? err.message : String(err);
}
check("★ 来源未知的全局：拒绝复用（不假定它来自本次请求）", unknownError !== null && unknownResolved === null, { unknownError, unknownResolved: Boolean(unknownResolved) });
check("★ 拒绝语点名请求的服务器与「无法核对来源」", Boolean(unknownError && unknownError.includes("server-a.test") && /verify/i.test(unknownError)), unknownError);
check("★ 来源未知时也没有偷偷插入 script", inserted.length === 0, inserted.length);

// ── 5b. 同一全局，但请求的是**它自己记录的来源**：接受（HMR 后重载路径） ──
// 通过真实加载器先装一次 A（全局被标记），再模拟「模块重载」：reset() 清掉模块级
// 状态而**保留**全局上的标记 —— 之后请求 A 必须直接复用，不再重新下载。
reset();
inserted = [];
fakeWindow.DocsAPI = { DocEditor: class {} };
await (async () => {
  // 直接走一次加载让加载器给全局打标记（全局已存在 → 先删掉，让它走脚本路径）。
  delete fakeWindow.DocsAPI;
  await loadDocsApi(A);
})();
check("前提：首次加载后全局带来源标记", (fakeWindow.DocsAPI as Record<string, unknown> | undefined)?.["__mcodeDocsApiOrigin"] === "https://server-a.test", (fakeWindow.DocsAPI as Record<string, unknown> | undefined)?.["__mcodeDocsApiOrigin"]);
const beforeReloadInserts = inserted.length;
reset(); // 模块级状态清空（模拟 HMR / 重新初始化），全局与标记保留
let afterReload: unknown = null;
let reloadReuseError: string | null = null;
try {
  afterReload = await loadDocsApi(A);
} catch (err) {
  reloadReuseError = err instanceof Error ? err.message : String(err);
}
check(
  "★ 模块重载后（全局带标记）请求同源：直接复用",
  Boolean(afterReload) && reloadReuseError === null && inserted.length === beforeReloadInserts,
  { inserts: inserted.length, before: beforeReloadInserts, reloadReuseError },
);
let reloadSwitchError: string | null = null;
try { await loadDocsApi(B); } catch (err) { reloadSwitchError = err instanceof Error ? err.message : String(err); }
check("★ 模块重载后切到 B：仍被拒绝（标记跨重载生效）", reloadSwitchError !== null && reloadSwitchError.includes("server-a.test") && reloadSwitchError.includes("server-b.test"), reloadSwitchError);

// ── 6. 拒绝之后回到原服务器：仍可用（拒绝没有把 A 也锁死） ────────────────
// 注意：第 5 段做过 reset() 并换了一个新的全局对象，所以这里比的是**第 5b 段里被接受
// 的那个对象**，而不是第 3 段的 `first`（那两个属于不同的模块状态）。
const backToA = await loadDocsApi(A);
check("被拒绝一次后，回到 A 仍复用原全局", backToA === afterReload, { same: backToA === afterReload });

void snippet; // 段落只用于"标记存在"的判据；转换在构建期完成。

console.log(`\nonlyoffice-sdk-origin-smoke: ${total - failures}/${total} 通过`);
if (failures > 0) process.exit(1);
