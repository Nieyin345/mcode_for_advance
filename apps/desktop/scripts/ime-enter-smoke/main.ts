/**
 * ime-enter-smoke — **非 IDE** 组件里文本输入框上的 Enter 缺 IME 守卫。
 *
 * ## 盯的是什么
 *
 * 中文/日文输入法里,按 Enter 是"确认候选词"(上屏),**不是**提交。React 的 keydown
 * 在编排期间也会以 `key === "Enter"` 到达。仓库里绝大多数 Enter 处理器都带那条守卫
 * (`e.nativeEvent.isComposing || e.keyCode === 229`),但这两处漏了:
 *
 *   - `AuthPromptDialog` 的**网站登录用户名/密码框** —— 用户用拼音输一半按 Enter 上屏,
 *     组件会**立刻把凭据发给 b​rowser.authRespond 并关掉对话框**,半截的用户名就发了出去;
 *   - `SelectionQuoteMenu` 的**引用搜索框** —— 搜中文时按 Enter 上屏会**误选错的条目**,
 *     把不对的那条引用塞进输入框。
 *
 * (IDE 侧的同款漏点由 `ide-ime-smoke` 盯着,那条线单独跑。)
 *
 * ## 判据
 *
 * 在输入框上派发一个 `isComposing: true` 的 Enter —— 之后对应的动作**不该**被触发。
 * 再派发一个正常 Enter —— 应该恰好触发一次(正控,证明这套确实能观察到提交动作)。
 *
 * ## 它怎么跑
 *
 * esbuild `--alias:react=` 换成 `ide-ime-smoke` 那套极小 hooks 运行时(组件源码原样跑);
 * `@renderer/components/ui/{index,input,button}.js` 换成桩(`Input` 渲染成真实的 input
 * 节点);`react-dom` 的 `createPortal` 直通;`@renderer/lib/api.js` 换成记事桩。
 * 不起浏览器、不写盘。
 *
 * Run: scripts/ime-enter-smoke/run.sh
 */
import "./prelude.js";
import { calls, callsOf, resetCalls } from "./api-stub.js";
import { __mount, __flush, __nodes } from "./fakeReact.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { AuthPromptDialog } from "@renderer/components/browser/AuthPromptDialog.js";
import { SelectionQuoteMenu } from "@renderer/components/chat/SelectionQuoteMenu.js";
import type { BrowserAuthRequest } from "@contracts/ipc";

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  checks++;
  if (cond) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures++;
  console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

type El = { type: unknown; props: Record<string, unknown> };

/**
 * 树里的**输入框**。
 *
 * 两种形态都要认:
 *   - 原生 `<input>` —— 节 type 就是 `"input"`(SelectionQuoteMenu 的搜索框);
 *   - `Input` 组件的桩 —— 假运行时**不会**调用子组件,所以它停在 `{type: <Input 函数>,
 *     props}` 这一层,不会物化成 `type: "input"`。按 props 形状认(有 `value` +
 *     `onChange`,且是文本框/密码框)。AuthPromptDialog 用的是这一种。
 */
function inputs(): El[] {
  return __nodes().filter((n) => {
    if (n.type === "input") return true;
    const p = n.props;
    return "value" in p && "onChange" in p && ("placeholder" in p || p.type === "password");
  }) as El[];
}

/** 造一个键盘事件对象(React 的合成事件在假的运行时里就是普通对象)。 */
function keyEvent(key: string, opts: { isComposing?: boolean; keyCode?: number } = {}): unknown {
  const native = { isComposing: opts.isComposing ?? false, keyCode: opts.keyCode ?? 0 };
  return {
    key,
    nativeEvent: native,
    isComposing: opts.isComposing ?? false,
    keyCode: opts.keyCode ?? 0,
    preventDefault: () => {},
    stopPropagation: () => {},
  };
}

/**
 * AuthPromptDialog 的用户名/密码框。
 *
 * 用户名框有 `placeholder = t("browser.username")`,密码框 `type="password"` —— 都靠
 * 这两个特征认(AuthPromptDialog 里只此两框)。**判据挂在密码框**上:它是按键处理器
 * 所在的那一只(用户名框没有 onKeyDown),且它要求 username 非空才提交 —— 所以用例
 * 里先把用户名填上。
 */
async function authPromptScenario(): Promise<void> {
  resetCalls();
  useSessionStore.setState({ locale: "zh" });
  const request: BrowserAuthRequest = {
    requestId: "r1",
    origin: "https://example.com",
    host: "example.com",
  };
  const onClose = (): void => {
    calls.push({ method: "test.onClose", input: undefined });
  };
  __mount(() => AuthPromptDialog({ request, onClose }));
  await __flush();

  const passwordBox = (): El => {
    const el = inputs().find((n) => n.props.type === "password");
    if (!el) throw new Error("找不到登录密码框");
    return el;
  };
  const usernameBox = (): El => {
    const el = inputs().find((n) => n.props.type !== "password");
    if (!el) throw new Error("找不到登录用户名框");
    return el;
  };
  const type = async (value: string): Promise<void> => {
    (usernameBox().props.onChange as (e: unknown) => void)({ target: { value } });
    await __flush();
  };
  const pressEnter = async (opts: { isComposing?: boolean; keyCode?: number } = {}): Promise<void> => {
    (passwordBox().props.onKeyDown as (e: unknown) => void)(keyEvent("Enter", opts));
    await __flush();
  };

  // ① IME 组词中的 Enter —— 绝不该把凭据发出去。
  await type("zhangsan");
  resetCalls();
  await pressEnter({ isComposing: true });
  check("★ 登录框:IME 组词中的 Enter 不发凭据", callsOf("browser.authRespond").length === 0, calls);

  // ② 老式 IME 只给 keyCode 229 的 Enter —— 同样不该发。
  await type("zhangsan");
  resetCalls();
  await pressEnter({ keyCode: 229 });
  check("★ 登录框:keyCode 229 的 Enter 不发凭据", callsOf("browser.authRespond").length === 0, calls);

  // ③ 正常 Enter(正控)—— 应该恰好发一次,并带上填好的用户名。
  await type("zhangsan");
  resetCalls();
  await pressEnter();
  const sent = callsOf("browser.authRespond");
  check("登录框:正常 Enter 发一次凭据(正控)",
    sent.length === 1 && (sent[0] as { username?: string })?.username === "zhangsan", sent);
}

/**
 * SelectionQuoteMenu 的引用搜索框(placeholder = t("chatStream.quote.searchPlaceholder"))。
 *
 * 该面板的搜索框带 onKeyDown;按 Enter 会 `pick(shown[active])` → `onPick`。判据挂在
 * **onPick 有没有被调用**上。目标列表里给一个会话,先输入过滤词把 active 落在一条上,
 * 再按 Enter。
 *
 * ⚠️ 每个用例用**不同的搜索词**:过滤词改变会重置 index,而 pick 传的是 `shown[active]`
 * —— 不同的词能保证每次都有一条可选,不会因上一次已经 pick 过(闭包/去重)假绿。
 */
async function quoteMenuScenario(): Promise<void> {
  resetCalls();
  useSessionStore.setState({
    locale: "zh",
    activeSessionId: "s-main",
    activeSideChatId: null,
    streamSessions: [],
    sideChatsByParent: {},
  });
  const picked: string[] = [];
  const state = {
    text: "选中的一段话",
    rect: { left: 100, top: 100, right: 300, bottom: 120, width: 200, height: 20 },
  };
  __mount(() =>
    SelectionQuoteMenu({
      state: state as never,
      sessionId: "s-main",
      currentTitle: "主对话",
      onPick: (t) => picked.push(t.id),
      onClose: () => {},
    }),
  );
  await __flush();

  const searchBox = (): El => {
    const el = inputs().find(
      (n) => typeof n.props.placeholder === "string" && (n.props.placeholder as string).length > 0,
    );
    if (!el) throw new Error("找不到引用搜索框");
    return el;
  };
  const type = async (value: string): Promise<void> => {
    (searchBox().props.onChange as (e: unknown) => void)({ target: { value } });
    await __flush();
  };
  const pressEnter = async (opts: { isComposing?: boolean; keyCode?: number } = {}): Promise<void> => {
    (searchBox().props.onKeyDown as (e: unknown) => void)(keyEvent("Enter", opts));
    await __flush();
  };

  // ① IME 组词中的 Enter —— 不该选中任何条目。
  await type("主");
  picked.length = 0;
  await pressEnter({ isComposing: true });
  check("★ 引用框:IME 组词中的 Enter 不选中条目", picked.length === 0, picked);

  // ② keyCode 229 —— 同上。
  await type("主");
  picked.length = 0;
  await pressEnter({ keyCode: 229 });
  check("★ 引用框:keyCode 229 的 Enter 不选中条目", picked.length === 0, picked);

  // ③ 正常 Enter(正控)—— 应该恰好选中一条。
  await type("主");
  picked.length = 0;
  await pressEnter();
  check("引用框:正常 Enter 选中一条(正控)", picked.length === 1, picked);
}

await authPromptScenario();
await quoteMenuScenario();

/* ─────────────────── ComposerEditor(ProseMirror):Enter 也要 229 守卫 ─────────────────── */

// 主输入框是 ProseMirror 的 `handleKeyDown`(不是 DOM input),这套假 react 驱动不了它,
// 所以判据立在**源码层**:三处拦截 Enter / 方向键的判据都必须同时含 `isComposing` 与
// `keyCode !== 229`。Safari/macOS 上 CJK 输入法"确认候选"的那次 Enter 是
// `isComposing === false` 但 `keyCode === 229` —— 只查 isComposing 会**在组词中途把消息发出去**。
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const src = fs.readFileSync(path.join(process.cwd(), "src/renderer/components/chat/ComposerEditor.tsx"), "utf8");
  const guardCount = (src.match(/keyCode !== 229/g) ?? []).length;
  check("★ ComposerEditor 的 Enter/方向键判据带 keyCode !== 229(Safari CJK 上屏)", guardCount >= 3, { guardCount });
}

console.log(`\nime-enter-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) process.exitCode = 1;
