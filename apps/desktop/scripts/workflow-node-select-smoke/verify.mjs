/**
 * `workflow-node-select-smoke` 的断言 —— **全部从点击开始**。
 *
 * ## 为什么起点必须是点击
 *
 * 原 `workflow-view-smoke` 对 `NodeInspector` 的断言是**直接构造组件并传
 * `selectedNodeId: "B"`**（`main.ts:552`）。它验的是"给了选中 id 之后渲染对不对"，
 * 而"用户怎么让它变成 B"那条路一次都没走过 —— T45 删画布时把它删掉了，763 条全绿
 * 也没发现（W0 §G2）。所以这里的每一条都从**真实鼠标事件**（CDP `dispatchMouseEvent`）
 * 出发：先确认页面默认在「工作流本体」，再点一行，再看右侧变了什么。
 *
 * ## 三条主判据（卡上的三条 + 两条保护）
 *
 * 1. 点击前，检查器显示工作流本体（不是某个节点）；
 * 2. 点 B 之后，显示 B 的参数（标题框的值 = "检索文献"）；
 * 3. 再点 C 之后，切到 C（**不是叠加**：B 的标题不再出现在输入框里）；
 * 4. 「返回工作流本体」把检查器切回文档级（没有它用户回不去，那是这套交互的另一半）；
 * 5. ★ 负控：点**工作流本体**里的东西不会把节点选中（点列表行的名字不切换文档）。
 *
 * 第 5 条防的是"任何点击都当选中"这种假修法 —— 它会让第 1–3 条都绿，但交互是坏的。
 */
import { withAuditPage } from "./browser.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const results = [];

await withAuditPage(here, async (page) => {
  const check = (name, ok, detail) => {
    results.push({ name, ok: !!ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : " " + JSON.stringify(detail)}`);
  };
  const sleep = (ms) => page.sleep(ms);

  /** 按可见文本找节点列表行（列表行的可见文本 = 标题 + 类型 id 两行）。 */
  const nodeRow = (title) => `[...document.querySelectorAll("[data-workflow-node-list] button")].find((b) => b.textContent.includes(${JSON.stringify(title)}))`;
  /** 检查器那一栏 —— 页面里**第二个** `<aside>`（左栏库/节点列表是第一个，
   *  `NodeInspector` 的 `<aside>` 在 DOM 里排在它后面）。**不按类名选**：那串 Tailwind
   *  任意值是 `w-[300px]`，正则要转义两层方括号，改一次宽度就断。 */
  const INSPECTOR = `(() => {
    const all = [...document.querySelectorAll("aside")];
    return all.length >= 2 ? all[all.length - 1] : null;
  })()`;
  /**
   * 按字段标题（`ParamField.tsx` 里那个 `Field` 的可见文本）找 input 的值。
   *
   * ⚠️ **两个 `Field` 不是同一个。** `ui/field.tsx` 的 label 是 `<label for>`；工作流
   * 这一侧用的是 `ParamField.tsx` 自己的 `Field` —— 标题是个 `<span id>`，控件经
   * `FieldLabelContext` 拿那个 id 做 `aria-labelledby`（见那边文件头：`<label>`
   * 是行内元素、量不到尺寸）。所以别按 `<label>` 找，**按 id 关系找**：
   *   标题 span 的 textContent === 要找的文案 → 它的 id → `[aria-labelledby=id]`（或
   *   `input[id=id]` 的变体）。
   *
   * 找不到就返回 null，让断言红 —— 而不是换一个"看起来更像"的兜底选择器（那会把
   * 判据变成"随便找个 input 读一个值"，等于什么都没验）。
   */
  const fieldValue = (labelText) => {
    // ⚠️ `labelText` 在 **JS 侧**先序列化。写成模板字符串里的 `${JSON.stringify(...)}`
    // 会在外层 JS 就求值——这没问题；但若把内层字符串整个嵌进另一层模板，`${...}` 会
    // 原样进入浏览器 eval 变成语法错误（本套件踩过一次）。这里用拼接，层次一眼可数。
    const literal = JSON.stringify(labelText);
    return page.eval(`(() => {
      const aside = ${INSPECTOR};
      if (!aside) return null;
      const spans = [...aside.querySelectorAll("span[id]")];
      const title = spans.find((s) => (s.textContent || "").trim() === ${literal});
      if (!title) return null;
      const id = title.id;
      const direct = aside.querySelector("#" + CSS.escape(id));
      if (direct && "value" in direct) return direct.value;
      const byLabelled = aside.querySelector('[aria-labelledby~="' + CSS.escape(id) + '"]');
      if (byLabelled && "value" in byLabelled) return byLabelled.value;
      // FieldLabelContext 的消费方不一定把 aria-labelledby 放在原生 input 上
      // （Base UI 的 Select 触发器是 button），所以最后一跳是"在同一格容器里找 input"。
      const holder = title.closest("div");
      const input = holder?.querySelector("input, textarea");
      return input ? input.value : null;
    })()`);
  };
  /** 检查器里标题输入框的值 —— 它是"右侧现在编辑的是谁"最直接的证据。 */
  const inspectorTitleValue = () => fieldValue("标题");
  /** 检查器是否在文档级（工作流本体）—— 判据是「名称」那一格在不在，且它的值等于
   *  文档名（本套夹具里是「我的流程」）。**不看「返回工作流本体」按钮**：那是节点态
   *  独有的，而把它当负判据会让"按钮忘了画"这种真 bug 表现成"回到了本体"（红错地方）。 */
  const inspectorShowsWorkflowBody = async () =>
    (await fieldValue("名称")) === "我的流程";
  /** 检查器里有没有「返回工作流本体」（节点态独有）。 */
  const inspectorHasBack = () =>
    page.eval(`(() => {
      const aside = ${INSPECTOR};
      return aside ? [...aside.querySelectorAll("button")].some((b) => (b.textContent || "").includes("返回工作流本体")) : false;
    })()`);

  /** 真点击一个元素（先滚到视口中央再发鼠标事件，与 ui-interaction 同一做法）。
   *  **目标不存在时返回 false**，由调用方落成一条 FAIL —— 不抛异常：一抛就整段中断，
   *  变异时后面的断言一条都看不到（"少的那些"和"绿的"在输出里长得一样，见 CLAUDE.md
   *  的变异第 7 形态）。 */
  const clickExpr = async (expr) => {
    let rect;
    try {
      rect = await page.eval(`(() => {
        const e = ${expr};
        if (!e) return null;
        e.scrollIntoView({ block: "center" });
        const r = e.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
    } catch {
      rect = null;
    }
    if (!rect) return false;
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...rect });
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...rect });
    await sleep(120);
    return true;
  };

  await page.goto("", "window.labReady === true && document.querySelector('aside nav button')");

  // ───────────────────────────────────────────────────────────────────────
  // §0 前置：页面真的把库读出来了，并**打开**那一份文档
  // ───────────────────────────────────────────────────────────────────────
  // 节点列表只在打开一份文档之后才出现（`working !== null`，见 WorkflowLibraryView），
  // 所以先点库行 —— 这也是生产里用户的真实动作：先选文档，再点节点。
  const docName = await page.eval(`document.querySelector("aside")?.textContent?.includes("我的流程") === true`);
  check("★ 前置：库列表里那一份文档可见", docName, { docName });
  await clickExpr(`[...document.querySelectorAll("aside nav button")].find((b) => b.textContent.includes("我的流程"))`);
  await page.waitFor(`document.querySelector("[data-workflow-node-list]")`, 8000);
  await sleep(200);
  const rowCount = await page.eval(`document.querySelectorAll("[data-workflow-node-list] button").length`);
  check("★ 前置：节点列表渲染出了 3 行（否则下面的断言全在空页面上跑）", rowCount === 3, { rowCount });

  // ───────────────────────────────────────────────────────────────────────
  // §1 点击前：检查器显示工作流本体
  // ───────────────────────────────────────────────────────────────────────
  check("★ 1. 点击前，检查器显示工作流本体（名称那一格在、没有返回按钮）", await inspectorShowsWorkflowBody(), {
    body: await inspectorShowsWorkflowBody(),
  });

  // ───────────────────────────────────────────────────────────────────────
  // §2 点 B（子 agent）→ 显示 B 的参数
  // ───────────────────────────────────────────────────────────────────────
  const clickedB = await clickExpr(nodeRow("检索文献"));
  check("★ 2-前置：节点 B 那一行点得到（点不到时下面两条会红，原因在这里）", clickedB);
  await sleep(150);
  const afterB = await inspectorTitleValue();
  check("★ 2. 点「检索文献」后，检查器的标题框是 B 的标题", afterB === "检索文献", { afterB });
  check("★ 2b. 此时检查器不再是工作流本体（返回按钮出现）",
    await inspectorHasBack(),
    { body: await inspectorShowsWorkflowBody() });

  // ───────────────────────────────────────────────────────────────────────
  // §3 点 C（命令）→ 切到 C，不是叠加
  // ───────────────────────────────────────────────────────────────────────
  const clickedC = await clickExpr(nodeRow("跑脚本"));
  check("★ 3-前置：节点 C 那一行点得到", clickedC);
  await sleep(150);
  const afterC = await inspectorTitleValue();
  check("★ 3. 点「跑脚本」后，检查器的标题框变成 C", afterC === "跑脚本", { afterC });
  // 「不是叠加」的正面证据：C 是命令类型，参数区里应当有命令那一格的标签（`命令`），
  // 而 B 的「指令」那一格应当**消失**（两种类型参数不同 —— 见 metadata 只取三种清单）。
  const cHasCommand = await page.eval(`(() => {
    const aside = ${INSPECTOR};
    const text = aside?.textContent || "";
    return { command: text.includes("命令"), instruction: text.includes("指令") };
  })()`);
  check("★ 3b. C 的参数表单是 C 的（命令格在、B 的指令格不在了）", cHasCommand.command && !cHasCommand.instruction, cHasCommand);

  // ───────────────────────────────────────────────────────────────────────
  // §4 返回工作流本体
  // ───────────────────────────────────────────────────────────────────────
  // ⚠️ **第 4 条必须建立在「刚才确实处在节点态」上。** 否则「点节点」整条路断了的时候，
  // 检查器一直停在工作流本体 —— 第 4 条会因为"本来就在本体"而绿。那是假绿（红错地方
  // 的反面：绿错原因），变异验证时专门盯它。所以这一条在**点返回之前**读。
  const wasOnC = await inspectorTitleValue();
  check("★ 4-前置二：点返回之前确实处在节点 C 的参数页", wasOnC === "跑脚本", { wasOnC });
  const clickedBack = await clickExpr(`[...(${INSPECTOR}).querySelectorAll("button")].find((b) => (b.textContent || "").includes("返回工作流本体"))`);
  check("★ 4-前置：节点态有「返回工作流本体」这颗按钮", clickedBack);
  await sleep(150);
  check("★ 4. 点「返回工作流本体」后回到文档级表单", await inspectorShowsWorkflowBody(), {
    body: await inspectorShowsWorkflowBody(),
  });

  // ───────────────────────────────────────────────────────────────────────
  // §5 负控：点库列表里的文档行不会顺带选中节点
  // ───────────────────────────────────────────────────────────────────────
  // 防的是"任何点击都选中第一个节点"这种假修法 —— 它会让 §1–§3 都绿，但交互是坏的。
  // 这里**不重挂**：重挂会把 `working` 归 null（文档没打开），那验的是"重新打开"而不是
  // "点文档行"。当前状态是 §4 之后的「工作流本体 + 文档已打开」。
  await clickExpr(`[...document.querySelectorAll("aside nav button")].find((b) => b.textContent.includes("我的流程"))`);
  await sleep(200);
  check("★ 5. 只点文档行、不点节点时检查器仍是工作流本体（没有「任何点击都选中节点」）",
    await inspectorShowsWorkflowBody(), { body: await inspectorShowsWorkflowBody() });

  writeFileSync(join(here, "results.json"), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`workflow-node-select-smoke: ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) throw Error(`${failed.length} assertions failed; artifacts: ${here}`);
});
