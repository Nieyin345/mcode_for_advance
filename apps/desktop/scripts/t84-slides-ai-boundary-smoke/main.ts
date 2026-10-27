import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MCODE_SLIDES_AI_UNAVAILABLE,
  SLIDES_ONLY_AI_CHANNELS,
  SLIDES_LOCAL_ONLY_CHANNELS,
  registerSlidesAiBoundary,
} from "../../../../genoffice/apps/slides/src/main/slides-ai-boundary.js";

type IpcPort = Parameters<typeof registerSlidesAiBoundary>[0];
type Handler = (...args: unknown[]) => unknown;

/* 【2026-10-27 更正】**两组，不是一组。**
 *
 * 从前这里是 8 条一个数组，断言 `SLIDES_ONLY_AI_CHANNELS` 必须等于它 —— 而那
 * 个常量在 `slides-ai-boundary.ts` 里被**刻意拆成了两组**：
 *
 *   - `SLIDES_ONLY_AI_CHANNELS`（4 条）：**要 AI 凭据或把内容送出网**，
 *     宿主里 fail-closed；
 *   - `SLIDES_LOCAL_ONLY_CHANNELS`（4 条）：**纯本地文件读写**（样式模板、
 *     讲稿侧车），宿主里正常放行 —— 它们住在 `ai-ipc.ts` 里纯属历史巧合，
 *     和 AI 无关。拒绝它们只会让「共用同一份编辑器内核」变成「功能少一块」。
 *
 * 套件没跟上这次拆分，于是三条断言一直红。红的原因不是功能坏了，是**判据
 * 还在按旧的单组结构比对**。 */
const EXPECTED_GATED = [
  "ai:generate-image",
  "ai:analyze-media",
  "ai:insert-image-url",
  "ai:replace-picture-url",
] as const;

const EXPECTED_LOCAL = [
  "ai:save-sidecar",
  "ai:save-style-template",
  "ai:list-style-templates",
  "ai:load-style-template",
] as const;

/** standalone 模式注册的**全部** 8 条（两组之和）。 */
const EXPECTED_CHANNELS = [...EXPECTED_GATED, ...EXPECTED_LOCAL] as const;

const SHARED_STANDALONE_CHANNELS = [
  "ai:get-settings",
  "ai:gsk-status",
  "ai:gsk-login",
  "ai:set-settings",
  "ai:log-run-failure",
  "ai:stream",
  "ai:stream-cancel",
  "ai:web-search",
  "ai:image-search",
] as const;

let failures = 0;
let total = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
  total++;
  if (condition) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), { actual, expected });
}

function finish(): void {
  console.log(`t84-slides-ai-boundary:${total - failures}/${total} 通过`);
  if (failures) process.exitCode = 1;
}

function fakeIpc(): { ipc: IpcPort; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const ipc = {
    handle(channel: string, listener: Handler) {
      handlers.set(channel, listener);
    },
  } as unknown as IpcPort;
  return { ipc, handlers };
}

async function invoke(handlers: Map<string, Handler>, channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered: ${channel}`);
  return await handler(...args);
}

async function legacyRedProbe(): Promise<void> {
  // Reproduce the pre-fix registration shape with a local mock only: the old
  // handler entered the media tool without consulting Host approval.
  const handlers = new Map<string, Handler>();
  let mockCloudToolCalls = 0;
  handlers.set("ai:generate-image", (_event: unknown, _request: unknown) => {
    mockCloudToolCalls++;
    return { url: "fixture://generated-image.png" };
  });

  await invoke(handlers, "ai:generate-image", {
    sender: { id: 84, isDestroyed: () => false },
    mcodeApproval: false,
  }, { prompt: "local fixture only" });

  check(
    "旧版未经 Host 审批不得进入原厂媒体工具（此旧红例应失败）",
    mockCloudToolCalls === 0,
    { actualMockToolCalls: mockCloudToolCalls, expectedMockToolCalls: 0 },
  );
  finish();
}

async function run(): Promise<void> {
  if (process.argv.includes("--legacy-red")) {
    await legacyRedProbe();
    return;
  }

  check(
    "Slides 云端 AI/media 通道（宿主里 fail-closed 的那 4 条）与验收清单一致",
    JSON.stringify(SLIDES_ONLY_AI_CHANNELS) === JSON.stringify(EXPECTED_GATED),
    { actual: SLIDES_ONLY_AI_CHANNELS, expected: EXPECTED_GATED },
  );
  /* ⚠️ 本地那 4 条**必须单独立一条**：它们不在 `SLIDES_ONLY_AI_CHANNELS` 里，
   * 如果只比上面那条，`SLIDES_LOCAL_ONLY_CHANNELS` 整组被删空也不会红。 */
  check(
    "Slides 本地文件通道（宿主里照常放行的那 4 条）与验收清单一致",
    JSON.stringify(SLIDES_LOCAL_ONLY_CHANNELS) === JSON.stringify(EXPECTED_LOCAL),
    { actual: SLIDES_LOCAL_ONLY_CHANNELS, expected: EXPECTED_LOCAL },
  );
  /* 两组**必须不重叠**：同一条通道既 fail-closed 又放行的话，最后注册的那个赢，
   * 而"谁赢"取决于注册顺序 —— 那是隐式的、不该存在的行为。 */
  check(
    "云端组与本地组不重叠（同一通道不能被两种策略同时认领）",
    SLIDES_ONLY_AI_CHANNELS.every((c) => !(SLIDES_LOCAL_ONLY_CHANNELS as readonly string[]).includes(c)),
    { gated: SLIDES_ONLY_AI_CHANNELS, local: SLIDES_LOCAL_ONLY_CHANNELS },
  );
  eq(
    "两组相加恰好 8 条，且没有重复",
    new Set([...SLIDES_ONLY_AI_CHANNELS, ...SLIDES_LOCAL_ONLY_CHANNELS]).size,
    EXPECTED_CHANNELS.length,
  );
  check(
    "共享原厂 AI 通道与 Slides 专有媒体通道分开归属",
    SHARED_STANDALONE_CHANNELS.every((channel) => !(SLIDES_ONLY_AI_CHANNELS as readonly string[]).includes(channel)),
    { shared: SHARED_STANDALONE_CHANNELS, gated: SLIDES_ONLY_AI_CHANNELS },
  );

  const aiIpcSource = readFileSync(resolve(process.cwd(), "../../genoffice/apps/slides/src/main/ai-ipc.ts"), "utf8");
  const slidesMainSource = readFileSync(resolve(process.cwd(), "../../genoffice/apps/slides/src/main/slides-main.ts"), "utf8");
  const wrapperStart = aiIpcSource.indexOf("export function registerSlidesOnlyAiIpc(isMcodeHosted = false): void {");
  const originalStart = aiIpcSource.indexOf("function registerOriginalSlidesOnlyAiIpc(): void {");
  const wrapperBody = wrapperStart >= 0 && originalStart > wrapperStart
    ? aiIpcSource.slice(wrapperStart, originalStart)
    : "";
  /* 这条查"wrapper 真的调了边界函数、且把原厂注册当回调传进去"。
   *
   * ⚠️ **不能按一整行匹配**：实际代码是多行调用，还多传了第 4 个参数
   * `registerSlidesLocalOnlyAiIpc`（本地四条）。写死一整行的字符串会在
   * 「加了个参数」这种正常演进上变红 —— 而它想守的是"边界被调用了"，
   * 不是"参数恰好三个"。 */
  const wrapperCallsBoundary = /registerSlidesAiBoundary\s*\(/.test(wrapperBody)
    && wrapperBody.includes("ipcMain")
    && wrapperBody.includes("isMcodeHosted")
    && wrapperBody.includes("registerOriginalSlidesOnlyAiIpc");
  check(
    "生产 ai-ipc wrapper 在原厂 handler 注册前执行 Hosted guard",
    wrapperCallsBoundary,
    { wrapperBody: wrapperBody.slice(0, 400) },
  );
  /* 本地四条也必须在 wrapper 里被传进去 —— 少了它，宿主里样式模板/讲稿侧车
   * 就永久不可用，而上面那条（只看云端）照样绿。 */
  check(
    "wrapper 也传入了本地四条的注册回调（否则宿主里样式模板永远不可用）",
    wrapperBody.includes("registerSlidesLocalOnlyAiIpc"),
    { wrapperBody: wrapperBody.slice(0, 400) },
  );
  check(
    "Slides 主装配把 mcodePane.isMcodeHosted 状态传给 AI 边界",
    slidesMainSource.includes("registerSlidesOnlyAiIpc(mcodePane.isMcodeHosted())"),
  );
  check(
    "Standalone 原厂 callback 仍保留全部 8 个原始 handler",
    EXPECTED_CHANNELS.every((channel) => aiIpcSource.includes(`'${channel}'`)),
  );

  let hostedOriginalRegistrations = 0;
  let mockCloudToolCalls = 0;
  const hosted = fakeIpc();
  /* 第 4 个参数是本地四条的注册回调 —— 测试夹具**必须传**。
   * 不传的话「本地 4 条在宿主里可用」这件事根本没被验到，
   * 而 `registerLocalOnly?.()` 是可选的，漏了也不报错（静默变成"功能少一块"）。 */
  let hostedLocalRegistrations = 0;
  const hostedState = registerSlidesAiBoundary(
    hosted.ipc,
    true,
    () => {
      hostedOriginalRegistrations++;
      for (const channel of EXPECTED_CHANNELS) {
        hosted.ipc.handle(channel, () => {
          mockCloudToolCalls++;
          return { url: "fixture://should-never-run.png" };
        });
      }
    },
    () => {
      hostedLocalRegistrations++;
      for (const channel of EXPECTED_LOCAL) {
        hosted.ipc.handle(channel, () => ({ ok: true, fixture: "local" }));
      }
    },
  );

  /* 【2026-10-27 更正】宿主里不是 `blocked` 而是 `mixed`：
   * 云端 4 条拒绝、本地 4 条放行（见 `slides-ai-boundary.ts` 的两组注释）。 */
  eq("Mcode-hosted 选择 mixed 分支（云端拒 + 本地放行）", hostedState, "mixed");
  eq("Mcode-hosted 不注册原厂 handler", hostedOriginalRegistrations, 0);
  check(
    "Mcode-hosted 为云端 4 条注册明确拒绝 handler",
    EXPECTED_GATED.every((channel) => hosted.handlers.has(channel)),
    { registered: [...hosted.handlers.keys()], expected: EXPECTED_GATED },
  );
  /* 本地 4 条**不该**被 reject 包装接管：它们由 `registerLocalOnly` 注册，
   * 走各自的真实实现（案例里是 mock）。断言"注册了"而不是"被拒了"。 */
  check(
    "Mcode-hosted 调用了本地四条的注册回调（不是空转）",
    hostedLocalRegistrations === 1,
    { hostedLocalRegistrations },
  );
  check(
    "Mcode-hosted 让本地 4 条走真实实现（不被 fail-closed 覆盖）",
    EXPECTED_LOCAL.every((channel) => hosted.handlers.has(channel)),
    { registered: [...hosted.handlers.keys()] },
  );

  for (const channel of EXPECTED_GATED) {
    let rejected = false;
    let readable = false;
    try {
      await invoke(hosted.handlers, channel, {
        sender: { id: 84, isDestroyed: () => false },
        mcodeApproval: false,
        openedFile: "fixture-a.pptx",
        sessionId: "fixture-session-a",
      }, {
        prompt: "local fixture only",
        mediaUrls: ["fixture://local-media.png"],
        url: "file:///../../outside/secret.png",
        sourceId: "another-document-picture",
        cancelled: true,
      });
    } catch (error) {
      rejected = true;
      const message = error instanceof Error ? error.message : String(error);
      readable = message.includes("Mcode") && message.includes("尚未授权") && message.includes("已审批");
    }
    check(`${channel} 在 Hosted 模式拒绝并返回可读授权原因`, rejected && readable);
  }

  const negativeControls: Array<{ name: string; channel: string; event: unknown; payload: unknown }> = [
    {
      name: "伪 renderer sender",
      channel: "ai:generate-image",
      event: { sender: { id: -1, isDestroyed: () => false }, mcodeApproval: false },
      payload: { prompt: "fixture" },
    },
    {
      name: "错误 sender",
      channel: "ai:analyze-media",
      event: { sender: null, mcodeApproval: false },
      payload: { mediaUrls: ["fixture://media.png"], requirements: "fixture" },
    },
    {
      name: "WebContentsView 已关闭",
      channel: "ai:generate-image",
      event: { sender: { id: 2, isDestroyed: () => true }, mcodeApproval: true },
      payload: { prompt: "late fixture" },
    },
    {
      name: "session 切换后迟到请求",
      channel: "ai:analyze-media",
      event: { sender: { id: 3 }, mcodeApproval: true, sessionId: "new-session" },
      payload: { sessionId: "old-session", mediaUrls: ["fixture://media.png"] },
    },
    {
      name: "图像路径越界",
      channel: "ai:insert-image-url",
      event: { sender: { id: 4 }, mcodeApproval: true },
      payload: { url: "file:///../../outside/secret.png", slideIndex: 0 },
    },
    {
      name: "取消后迟到生成请求",
      channel: "ai:generate-image",
      event: { sender: { id: 5 }, mcodeApproval: true, cancelled: true },
      payload: { prompt: "cancelled fixture" },
    },
    {
      name: "跨文档图片引用",
      channel: "ai:replace-picture-url",
      event: { sender: { id: 6 }, mcodeApproval: true, openedFile: "fixture-a.pptx" },
      payload: { sourceId: "fixture-b-picture", filePath: "fixture-b.pptx" },
    },
  ];

  for (const control of negativeControls) {
    let rejected = false;
    try {
      await invoke(hosted.handlers, control.channel, control.event, control.payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rejected = message === MCODE_SLIDES_AI_UNAVAILABLE;
    }
    check(`${control.name} 不能触达原厂 AI/media handler`, rejected);
  }
  eq("所有 Hosted 负控均未调用 mock 云工具", mockCloudToolCalls, 0);

  let standaloneOriginalRegistrations = 0;
  let standaloneMockToolCalls = 0;
  const standalone = fakeIpc();
  const standaloneState = registerSlidesAiBoundary(standalone.ipc, false, () => {
    standaloneOriginalRegistrations++;
    standalone.ipc.handle("ai:generate-image", () => {
      standaloneMockToolCalls++;
      return { url: "fixture://standalone-image.png" };
    });
  });

  eq("Standalone 仍走原厂注册分支", standaloneState, "standalone");
  eq("Standalone 原厂注册回调恰好执行一次", standaloneOriginalRegistrations, 1);
  const standaloneResult = await invoke(standalone.handlers, "ai:generate-image", {
    sender: { id: 7, isDestroyed: () => false },
  }, { prompt: "standalone fixture" }) as { url?: string };
  eq("Standalone 合法图片生成 mock 正例保持可用", standaloneResult.url, "fixture://standalone-image.png");
  eq("Standalone 正例只触发 mock 工具一次", standaloneMockToolCalls, 1);

  finish();
}

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
