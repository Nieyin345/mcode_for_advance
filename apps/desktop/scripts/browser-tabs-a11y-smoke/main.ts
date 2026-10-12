/**
 * browser-tabs-a11y-smoke — 【UI-013】浏览器标签条必须能**纯键盘**创建/切换/关闭。
 *
 * ## 盯的是什么
 *
 * `BrowserTabs.tsx` 从前把整张标签渲染成 `<div role="tab" onClick=…>` —— 没有 `tabIndex`、
 * 没有 Enter/Space/方向键处理、也不在 `role="tablist"` 里。于是多标签时 Tab 键只能到关闭
 * 按钮,到不了标签主体再切换;而非激活标签的关闭按钮是 `opacity-0 group-hover:opacity-100`,
 * 键盘用户可能聚焦到一个看不见的按钮。浏览器工具栏的前进/后退/刷新替代不了切换标签。
 *
 * ## 判据钉在**真的渲染树**上
 *
 * 用与 ime-enter-smoke 同一套极小 React 运行时(`--alias:react=`)把 `BrowserTabs` 原样跑起来,
 * 再看它产出的元素节点:tablist/tab 角色、roving tabindex、方向键真的切到相邻标签、
 * 关闭按钮在焦点进入时可见。组件源码一个字不改。
 *
 * Run: scripts/browser-tabs-a11y-smoke/run.sh
 */
import "./prelude.js";
import { __mount, __nodes } from "./fakeReact.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";
import { BrowserTabs } from "@renderer/components/browser/BrowserTabs.js";

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

type El = { type: unknown; props: Record<string, unknown> };

function findByRole(role: string): El[] {
  return (__nodes() as El[]).filter((n) => n.props?.role === role);
}

const tabs = [
  { id: "t1", title: "第一页", url: "https://a.test/x", loading: false },
  { id: "t2", title: "第二页", url: "https://b.test/y", loading: false },
  { id: "t3", title: "第三页", url: "https://c.test/z", loading: false },
];

let selected: string[] = [];
let closed: string[] = [];
let newCount = 0;

useSessionStore.setState({ locale: "zh" });
__mount(() =>
  BrowserTabs({
    tabs,
    activeTabId: "t2",
    onSelect: (id) => selected.push(id),
    onClose: (id) => closed.push(id),
    onNew: () => (newCount += 1),
  }),
);

console.log("\n【UI-013】标签条的角色与 roving tabindex");
{
  const tablist = findByRole("tablist");
  check("★ 标签条是一个 role=tablist(有可访问名)", tablist.length === 1 && typeof tablist[0].props["aria-label"] === "string", tablist.map((t) => t.props["aria-label"]));

  const tabsEls = findByRole("tab");
  check("三个标签都是 role=tab", tabsEls.length === 3, tabsEls.length);

  // roving tabindex:只有激活那个 Tab 键可达(0),其余 -1 —— 否则 Tab 键要穿过每个标签。
  const idx = tabsEls.map((t) => t.props.tabIndex);
  check("★ roving tabindex:激活标签=0、其余=-1", idx.filter((v) => v === 0).length === 1 && idx.filter((v) => v === -1).length === 2, idx);
  // 激活那个必须是 aria-selected=true 的那一个。
  const activeEl = tabsEls.find((t) => t.props["aria-selected"] === true);
  check("★ tabIndex=0 的正是激活标签", activeEl?.props.tabIndex === 0, { tabIndex: activeEl?.props.tabIndex });

  // 每个标签要有可访问名(读屏能播报"第 n/total 个:标题")。
  const labels = tabsEls.map((t) => String(t.props["aria-label"] ?? ""));
  check(
    "★ 每个标签有含序号/总数的可访问名(读屏可播报)",
    labels.every((l) => l.includes("/") && l.includes("3")),
    labels,
  );
  check("★ 标签带 onKeyDown(有键盘入口)", tabsEls.every((t) => typeof t.props.onKeyDown === "function"), tabsEls.map((t) => typeof t.props.onKeyDown));
}

console.log("\n【UI-013】方向键 / Home / End 在标签间移动并切换");
{
  const tabsEls = findByRole("tab");
  // 给每个 tab 节点补上 `focus` / `click`(真实 DOM 元素有;fakeReact 的节点是普通对象)。
  // `click()` 模拟"点到这张标签"→ 触发它的 onClick。`parentElement.querySelectorAll` 必须
  // 返回**同一批对象**(identity 一致),否则 onTabKeyDown 里的 `indexOf` 会算成 -1。
  const domish = tabsEls.map((t) => {
    const node = t as unknown as { parentElement?: unknown; focus?: () => void; click?: () => void };
    node.focus = () => undefined;
    node.click = () => (t.props.onClick as (() => void) | undefined)?.();
    return node;
  });
  for (const n of domish) {
    (n as { parentElement: unknown }).parentElement = { querySelectorAll: () => domish };
  }
  // 激活标签是 t2(树里第二个)。
  const activeEl = domish[1] as unknown as El & { props: { onKeyDown: (e: unknown) => void } };

  const press = (key: string) => {
    selected = [];
    activeEl.props.onKeyDown({ key, currentTarget: activeEl, preventDefault: () => undefined });
  };

  press("ArrowRight");
  check("★ ArrowRight 切到下一个标签(t3)", selected.length === 1 && selected[0] === "t3", selected);

  press("ArrowLeft");
  check("★ ArrowLeft 切到上一个标签(t1)", selected.length === 1 && selected[0] === "t1", selected);

  press("Home");
  check("★ Home 切到第一个标签(t1)", selected.length === 1 && selected[0] === "t1", selected);

  press("End");
  check("★ End 切到最后一个标签(t3)", selected.length === 1 && selected[0] === "t3", selected);

  // Enter/Space 选中当前标签(键盘用户落在标签上回车)。
  press("Enter");
  check("★ Enter 选中当前标签", selected.length === 1, selected);
  press(" ");
  check("★ Space 选中当前标签", selected.length === 1, selected);
}

console.log("\n【UI-013】关闭按钮在焦点进入标签时可见(不靠 hover)");
{
  // 关闭按钮是树里的 button 节点(role=tab 的子树)。fakeReact 深度优先收集所有节点。
  const buttons = (__nodes() as El[]).filter((n) => n.type === "button");
  const closeButtons = buttons.filter((b) => typeof b.props["aria-label"] === "string" && String(b.props["aria-label"]).length > 0);
  check("标签条里有按钮(关闭 ×3 + 新建 ×1)", closeButtons.length >= 4, closeButtons.length);
  // 关闭按钮的 className 必须含 focus-within 可见规则 —— 不能只有 group-hover。
  // 激活标签的关闭键本就 opacity-100;其余两个靠 group-focus-within 在焦点进入时显现,
  // 所以判据是"非激活的那些"必须带这条规则。
  const withFocusWithin = closeButtons.filter((b) => String(b.props.className ?? "").includes("group-focus-within:opacity-100"));
  const alwaysVisible = closeButtons.filter((b) => String(b.props.className ?? "").includes("group-focus-within:opacity-100") || /(^|\s)opacity-100(\s|$)/.test(String(b.props.className ?? "")));
  check("★ 非激活标签的关闭按钮焦点进入时可见(group-focus-within:opacity-100)", withFocusWithin.length === 2, withFocusWithin.length);
  check("★ 三个关闭按钮都可见(激活的常显 + 另两个 focus-within)", alwaysVisible.length === 3, alwaysVisible.length);
  const focusVisible = closeButtons.filter((b) => String(b.props.className ?? "").includes("focus-visible:ring"));
  check("★ 关闭按钮有 focus-visible 焦点环", focusVisible.length >= 3, focusVisible.length);
}

console.log(`\nbrowser-tabs-a11y-smoke:${checks - failures}/${checks} 通过`);
if (failures > 0) process.exit(1);
