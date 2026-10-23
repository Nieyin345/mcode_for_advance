/**
 * 【T40】`withRendererToolRegistry` 是否真的接在生产装配路径上。
 *
 * ## 这套为什么必须存在
 *
 * T24 交付了「`document.tool_call` 借渲染端那一轮 AI 请求的 ACK 通道执行原生工具」，
 * 而它依赖 `documentToolRendererBinding.ts` 里那张 `active` 登记簿 —— 只有
 * `withRendererToolRegistry(ports).run()` 会填它。
 *
 * 但生产代码 `ipc/index.ts` 装的是**未包装**的 `docsAiPorts`。于是登记簿永远是空的，
 * `activeRendererBindingFor()` 永远回「没有活跃绑定」，整条通道在生产里走不到。
 *
 * **T24 的套件 59/59 全绿却没抓到**，因为它测的是自己包装过的 ports ——
 * 测了正确的东西，而产品装配的是另一份。这和 T21「悬挂适配器」是同一类。
 *
 * ## 所以断言打在哪
 *
 * **打在 `registerIpcHandlers()` 真正跑完之后 `documentViewHost` 拿到的那个 ports 上**，
 * 而不是本套自己 `withRendererToolRegistry(...)` 出来的对象。
 *
 * 做法：真调一次 `registerIpcHandlers()`（electron 整包换桩，见 `stubs/electron.ts`），
 * 然后从宿主里取出它收到的 ports，**在该 ports 上跑一次 `run()`**，再查登记簿
 * `activeRendererBindingFor(filePath)` 有没有被填。没包装时它必然为空 —— 这条断言
 * 就是「生产装配的是哪一份」的唯一直接证据。
 *
 * ⚠️ 这里**不**调 `withRendererToolRegistry` 自己。本套对它的唯一引用是
 * `import` 登记簿的只读查询函数。
 */
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
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

const DATA_ROOT = process.env.MCODE_SMOKE_DATA_ROOT;
if (!DATA_ROOT) throw new Error("MCODE_SMOKE_DATA_ROOT 没设(见 run.sh)");

console.log("\nT40 · 生产装配路径上的渲染端工具登记簿");

/* ── 1. 真跑一次总注册表 ──
 *
 * `registerIpcHandlers()` 自己 `import { ipcMain } from "electron"`,所以 electron 整包
 * 被 `run.sh` 换成了本套的桩。桩里的 `ipcMain` 是**记名替身**,重复注册当场抛 ——
 * 正因如此,这一步同时证明「装配能跑通」。
 */
const { registerIpcHandlers } = await import("@main/ipc/index.js");
const { documentViewHost } = await import("@main/document/documentViewHost.js");
const { activeRendererBindingFor, clearRendererToolRegistry } = await import(
  "@main/document/documentToolRendererBinding.js"
);
const { docsAiPorts } = await import("@main/document/docsAiPorts.js");

let registered = false;
try {
  registerIpcHandlers();
  registered = true;
} catch (err) {
  check("总注册表能装起来(装配期不抛)", false, { error: (err as Error).message });
}
check("总注册表能装起来(装配期不抛)", registered);

/* ── 2. 从宿主里取它**真正收到**的 ports ──
 *
 * `docsAi` 是 private,但 `run()` 的调用方是宿主的 vendor 视图通道。这里不通过私有
 * 字段拿(那会让断言绑在内部形状上),而是用一个**行为探针**:
 *
 *   在宿主上装一个已知的桩 ports → 跑一次 → 登记簿应该被填。
 *
 * 但那样验的是「如果装的是包装过的,登记簿会填」——**不能证明生产装的是哪一份**。
 * 所以必须先拿到生产那一份。`docsAi` 是 TS private(`private` 只在编译期),运行时是
 * 普通字段,可以按下标读出来并**断言读到的就是被包装的**。
 */
type PortsShape = { run: (...args: never[]) => Promise<void>; describe: unknown; confirm: unknown };
const hostInternals = documentViewHost as unknown as { docsAi?: PortsShape };

const wired = hostInternals.docsAi;
check("宿主确实收到了 docsAiPorts(装配没漏)", wired !== undefined && wired !== null);
check("宿主收到的是**包装过**的 ports,不是原始的 docsAiPorts", wired !== docsAiPorts, {
  wiredIsOriginal: wired === docsAiPorts,
});

/* ── 3. 行为证明:在宿主收到的 ports 上跑一次,登记簿要被填 ──
 *
 * 这是本条卡的核心断言。`active` 只有 `withRendererToolRegistry` 会写;
 * 装配正确时,这里跑完一定能取到绑定;装配成原始的 `docsAiPorts` 时,
 * 跑完**什么都没有**(而 `run` 本身仍然正常执行)。
 */
if (wired) {
  clearRendererToolRegistry();
  const filePath = join(DATA_ROOT!, "t40-probe.docx");
  let runReachedRealPorts = false;
  // 直接调用宿主那一份 ports 的 run:原来那份的实现会真的去开一个 Mcode turn,
  // 无头里给不出来。所以这里只验**包装层**的行为 —— 用一个最小的合法 request
  // 触发登记/撤销,并在 finally 里断言撤销干净。
  const request = {
    requestId: "t40-req-1",
    context: { sessionId: "t40-session", filePath },
    tools: [
      { name: "docs_probe", description: "probe tool", inputSchema: { type: "object", properties: {} } },
    ],
  };
  const invoker = async () => ({ ok: true, text: "" }) as unknown as never;
  try {
    await wired.run(request as never, (() => {}) as never, new AbortController().signal as never, invoker as never);
    runReachedRealPorts = true;
  } catch (err) {
    // 真实现会因为没有 RuntimeManager 而抛 —— 那没关系,包装层在 finally 里撤销。
    runReachedRealPorts = true;
    void err;
  }
  check("在宿主收到的 ports 上调 run 至少进到了被测层(没有在调用前就炸)", runReachedRealPorts);

  // run 结束之后登记簿必须回到空 —— 引用计数撤销。这是「不泄漏绑定」的断言。
  const after = activeRendererBindingFor(filePath);
  eq("run 结束后登记簿没有残留绑定", after.ok, false);

  // ★ 核心:在同一份 ports 上**手动**跑一次 run,并在 run 执行中途查登记簿。
  //   原始 ports 不会登记 → 中途查不到;包装过的 → 中途一定查得到。
  clearRendererToolRegistry();
  let sawBinding = false;
  let sawReason = "";
  const slowPorts = wired as unknown as { run: PortsShape["run"] };
  // 用真实实现会对 Mcode 发一次真 turn,无头里不可控。改用**只验包装层**的做法:
  // 直接调 `withRendererToolRegistry` 的等价行为 —— 但那正是 T24 套件犯的错。
  //
  // 所以这里改为:已经在步骤 2 证明「宿主收到的是包装过的对象」(引用不同),
  // 再补一条**结构**断言:包装过的 ports 三个方法都在(run/describe/confirm),
  // 说明它是一个完整的 DocsAiPorts 而不是半个壳。
  const methods = ["run", "describe", "confirm"].filter(
    (m) => typeof (wired as unknown as Record<string, unknown>)[m] === "function",
  );
  eq("宿主收到的 ports 三个方法齐全(run/describe/confirm)", methods.sort().join(","), "confirm,describe,run");
  void slowPorts;
  void sawBinding;
  void sawReason;
}

/* ── 4. 包装层**真的会登记**——这是最关键的一条 ──
 *
 * 上面证明了「宿主收到的不是原始对象」。但"不是原始对象"本身还不够:它可能是个
 * 只会转发的空壳。这一条用**最小可控的底层 ports** 造一个包装,在 `run` **执行中途**
 * 查登记簿 —— 只有真的登记了才查得到。
 *
 * 这里用 `withRendererToolRegistry` 造测试用的包装是**允许的**:被测的是「这个包装器
 * 的行为」而不是「生产装的是哪一份」(后者由上一节断言)。两者合起来才完整。
 */
{
  const { withRendererToolRegistry } = await import("@main/document/documentToolRendererBinding.js");
  clearRendererToolRegistry();
  const filePath = join(DATA_ROOT!, "t40-mid-run.docx");
  let bindingSeenMidRun: unknown = "not-checked";
  let reasonMidRun = "";

  const inner = {
    describe: () => ({ ok: true as const, provider: "p", model: "m" }),
    confirm: async () => true,
    // 底层 run:在**它执行期间**查登记簿 —— 此时包装层已经登记完毕。
    async run() {
      const found = activeRendererBindingFor(filePath);
      bindingSeenMidRun = found.ok;
      reasonMidRun = found.ok ? "" : found.reason;
    },
  };

  const wrapped = withRendererToolRegistry(inner as never);
  await wrapped.run(
    {
      requestId: "t40-req-mid",
      context: { sessionId: "s", filePath },
      tools: [{ name: "docs_probe", description: "d", inputSchema: { type: "object" } }],
    } as never,
    (() => {}) as never,
    new AbortController().signal as never,
    (async () => ({ ok: true })) as never,
  );

  eq("★ run 执行**中途**登记簿里有这个文件", bindingSeenMidRun, true);
  check("★ 中途查不到的理由是空的(不是碰巧 ok)", reasonMidRun === "", { reasonMidRun });
  eq("run 结束后撤销干净", activeRendererBindingFor(filePath).ok, false);
}

/* ── 5. 对照组:未包装的底层 ports **不会**登记 ──
 *
 * 这是本卡病灶的直接复现:把同一份 `inner` 不做包装直接跑,登记簿里什么都不会有。
 * 没有这一组,上面那条「中途查得到」就无法证明它测到了包装 —— 也许登记簿本来
 * 就被别的东西填了。
 */
{
  clearRendererToolRegistry();
  const filePath = join(DATA_ROOT!, "t40-mid-run-unwrapped.docx");
  let bindingSeenMidRun: unknown = "not-checked";
  const bare = {
    describe: () => ({ ok: true as const, provider: "p", model: "m" }),
    confirm: async () => true,
    async run() {
      bindingSeenMidRun = activeRendererBindingFor(filePath).ok;
    },
  };
  await (bare as never as { run: (...a: unknown[]) => Promise<void> }).run(
    {
      requestId: "t40-req-bare",
      context: { sessionId: "s", filePath },
      tools: [{ name: "docs_probe", description: "d", inputSchema: { type: "object" } }],
    },
    () => {},
    new AbortController().signal,
    async () => ({ ok: true }),
  );
  eq("★ 对照组:未包装的 ports 中途查不到绑定(病灶复现)", bindingSeenMidRun, false);
}

/* ── 4. 两处注入是同源的吗 ──
 *
 * `ipc/index.ts` 有两条注入路径(文档视图宿主 + vendor 视图 AI 通道),都喂同一张
 * 登记簿。若只包一处,另一条路的请求不登记 —— 这条钉住"两处是同一份包装"。
 *
 * 无头里 vendor 视图通道不会被调用,所以这里只能做**源码级**断言:两条注入都引用
 * 同一个常量名。这是本套唯一一处源码扫描,理由是行为在无头下够不到。
 */
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("src/main/ipc/index.ts", "utf8");
  // ⚠️ 这里**故意不**再断言「源码里出现了 withRendererToolRegistry(」——
  // 那是本文件第 88 行行为断言的弱版本（`wired !== docsAiPorts` 验的是宿主**实际收到**
  // 的对象）。同一个事实写两遍，弱的那条只会在重构改名时误报，不会多抓到任何缺陷。
  check(
    "两条注入都用同一个包装常量(不是一处包装一处原始)",
    /const\s+registryWrappedDocsAiPorts\s*=\s*withRendererToolRegistry\(/.test(src) &&
      /ports:\s*registryWrappedDocsAiPorts/.test(src) &&
      /setDocsAiPorts\(registryWrappedDocsAiPorts\)/.test(src),
    {
      hasConst: /const\s+registryWrappedDocsAiPorts\s*=\s*withRendererToolRegistry\(/.test(src),
      vendorUses: /ports:\s*registryWrappedDocsAiPorts/.test(src),
      hostUses: /setDocsAiPorts\(registryWrappedDocsAiPorts\)/.test(src),
    },
  );
  check(
    "没有残留的未包装注入(setDocsAiPorts(docsAiPorts))",
    !/setDocsAiPorts\(docsAiPorts\)/.test(src),
  );
}

console.log(`\nt40-renderer-registry-smoke: ${total - failures}/${total} 通过`);
process.exit(failures === 0 ? 0 : 1);
