import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MCODE_SLIDES_AI_UNAVAILABLE,
  SLIDES_ONLY_AI_CHANNELS,
  registerSlidesAiBoundary,
} from "../../../../genoffice/apps/slides/src/main/slides-ai-boundary.js";

type IpcPort = Parameters<typeof registerSlidesAiBoundary>[0];
type Handler = (...args: unknown[]) => unknown;

const EXPECTED_CHANNELS = [
  "ai:generate-image",
  "ai:analyze-media",
  "ai:insert-image-url",
  "ai:replace-picture-url",
  "ai:save-sidecar",
  "ai:save-style-template",
  "ai:list-style-templates",
  "ai:load-style-template",
] as const;

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
    "Slides 专有 ai:* handler 清单完整且与独立验收清单一致",
    JSON.stringify(SLIDES_ONLY_AI_CHANNELS) === JSON.stringify(EXPECTED_CHANNELS),
    { actual: SLIDES_ONLY_AI_CHANNELS, expected: EXPECTED_CHANNELS },
  );
  eq(
    "Slides 专有 AI/media 通道清单无重复项",
    new Set(SLIDES_ONLY_AI_CHANNELS).size,
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
  check(
    "生产 ai-ipc wrapper 在原厂 handler 注册前执行 Hosted guard",
    wrapperBody.includes("registerSlidesAiBoundary(ipcMain, isMcodeHosted, registerOriginalSlidesOnlyAiIpc)"),
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
  const hostedState = registerSlidesAiBoundary(hosted.ipc, true, () => {
    hostedOriginalRegistrations++;
    for (const channel of EXPECTED_CHANNELS) {
      hosted.ipc.handle(channel, () => {
        mockCloudToolCalls++;
        return { url: "fixture://should-never-run.png" };
      });
    }
  });

  eq("Mcode-hosted 选择 fail-closed 分支", hostedState, "blocked");
  eq("Mcode-hosted 不注册原厂 handler", hostedOriginalRegistrations, 0);
  check(
    "Mcode-hosted 为全部 8 个专有通道注册明确拒绝 handler",
    EXPECTED_CHANNELS.every((channel) => hosted.handlers.has(channel)),
    { registered: [...hosted.handlers.keys()], expected: EXPECTED_CHANNELS },
  );

  for (const channel of EXPECTED_CHANNELS) {
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
