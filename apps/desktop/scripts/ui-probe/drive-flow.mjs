/**
 * 用 ui-probe 量「工作流小流程图」。
 *
 * 用户说「画布实时进度效果很差」，当初只改了根因、**从没起 dev 实看过**。这里把它
 * 渲染在真 Chrome 里，把"看着对不对"变成能进断言的数：
 *  - 每一格都画出来了吗（墨量）
 *  - 状态分得开吗（跑/成/败/等你 的底色 RGB 各不同）
 *  - 字读得清吗（对比度）
 *  - 跑动的那一格亮边**沿边框走**、不压到邻格吗（这是当初"效果差"的正主）
 *  - 回边绕行画出来了吗
 *
 * 用法：node drive-flow.mjs
 * 退出码：0 全过 · 1 有断言红 · 2 崩溃。
 */
import { launch, runDriver } from "./probe.mjs";

const near = (a, b, tol = 10) => a !== null && b !== null && Math.abs(a - b) <= tol;
const rgbNear = (p, [r, g, b], tol = 14) =>
  p && near(p.r, r, tol) && near(p.g, g, tol) && near(p.b, b, tol);
/** 两色是否**不同**(区分状态用)。 */
const rgbDiff = (a, b, tol = 10) =>
  a && b && (Math.abs(a.r - b.r) > tol || Math.abs(a.g - b.g) > tol || Math.abs(a.b - b.b) > tol);

/** 量一组元素:中心像素 + 几何。 */
async function boxes(probe, sel) {
  return probe.J(`JSON.stringify([...document.querySelectorAll(${JSON.stringify(sel)})].map((el) => {
    const r = el.getBoundingClientRect();
    return { id: el.getAttribute("data-node-id"), x: Math.round(r.x), y: Math.round(r.y),
             w: Math.round(r.width), h: Math.round(r.height) };
  }))`);
}

await runDriver(async () => {
  // page 是相对 **probe.mjs 所在目录** 解析的（见 launch），所以给一条回到 apps/desktop 的路径。
  const probe = await launch({ page: "../../.tmp/flow-preview/index.html", size: "900,760" });

  /* 等 React 渲染并让布局稳定（ResizeObserver 量完宽度会重排一次）。 */
  await new Promise((r) => setTimeout(r, 600));

  const svg = await probe.el("svg");
  probe.check("SVG 画出来了", svg.found && svg.box.w > 0 && svg.box.h > 0, svg);
  if (!svg.found) return probe;

  /* ── 1. 每一格都画出来了 ── */
  const nodeBoxes = await boxes(probe, "g[data-node-id]");
  probe.eq("六格都在", nodeBoxes.length, 6);
  const ids = nodeBoxes.map((b) => b.id).sort();
  probe.eqList("格子的 id 就是图上那六步", ids, ["n1", "n2", "n3", "n4", "n5", "n6"]);

  /* ── 2. 格子之间**不重叠**（当初"转框"那版就压到邻格）── */
  let overlap = 0;
  for (let i = 0; i < nodeBoxes.length; i++) {
    for (let j = i + 1; j < nodeBoxes.length; j++) {
      const a = nodeBoxes[i], b = nodeBoxes[j];
      const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
      const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      if (ox > 2 && oy > 2) overlap += ox * oy;
    }
  }
  probe.eq("★ 格子互不重叠（重叠面积 0）", overlap, 0);

  /* ── 3. 每一格都有名字（用户："不要只是一个名字"→ 现在有名字+状态两行）── */
  const labels = await probe.texts("[data-node-label]");
  probe.eq("每一格都写了名字", labels.filter((s) => s.length > 0).length, 6);
  probe.check("长标题被截断但写了省略号", labels.some((s) => s.includes("…")), labels);

  /* ── 4. 状态分色：跑 / 成 / 败 / 等你 的底色各不相同 ── */
  const rectOf = (id) =>
    probe.J(`(() => {
      const g = document.querySelector('g[data-node-id="${id}"]');
      const rect = g.querySelector("rect");
      const r = rect.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2, fill: rect.getAttribute("fill") });
    })()`);
  const rRunning = await rectOf("n3");
  const rSuccess = await rectOf("n2");
  const rFailed = await rectOf("n6");
  const rAwait = await rectOf("n4");
  const pxRunning = await probe.pixel(rRunning.x, rRunning.y);
  const pxSuccess = await probe.pixel(rSuccess.x, rSuccess.y);
  const pxFailed = await probe.pixel(rFailed.x, rFailed.y);
  const pxAwait = await probe.pixel(rAwait.x, rAwait.y);
  probe.check("★ 执行中 vs 已完成 底色不同", rgbDiff(pxRunning, pxSuccess), { running: pxRunning, success: pxSuccess });
  probe.check("★ 失败格是红系（r 明显大于 g、b）", pxFailed && pxFailed.r > pxFailed.g + 20, pxFailed);
  probe.check("★ 等你的那格是暖色系（r > b）", pxAwait && pxAwait.r > pxAwait.b, pxAwait);
  probe.check("执行中的底色**很浅**（不是实心绿，否则和已完成分不开）",
    pxRunning && (pxRunning.r + pxRunning.g + pxRunning.b) / 3 > 200, pxRunning);

  /* ── 5. 字读得清（WCAG 对比度）── */
  const contrast = await probe.regionContrast("svg");
  probe.check("整张图有足够对比度（≥3）", contrast !== null && contrast >= 3, { contrast });

  /* ── 6. ★ 执行中那格有走动的亮边，且**贴着它自己的边框**（不压邻格）── */
  const spinner = await probe.el("rect[data-spinner]");
  probe.check("执行中的那一格有亮边", spinner.found, spinner);
  if (spinner.found) {
    const owner = await probe.J(`(() => {
      const sp = document.querySelector("rect[data-spinner]");
      const g = sp.closest("g");
      const box = g.querySelector("rect").getBoundingClientRect();
      const spb = sp.getBoundingClientRect();
      // 亮边是否**套在**它自己那格的方框外面一点点（±5px），而不是跑远
      return JSON.stringify({
        ox: Math.round(Math.abs(spb.x - box.x)),
        oy: Math.round(Math.abs(spb.y - box.y)),
        dw: Math.round(Math.abs(spb.width - box.width)),
      });
    })()`);
    probe.check("★ 亮边贴着它自己那格（位移 ≤5px，没跑到邻格上）",
      owner.ox <= 5 && owner.oy <= 5 && owner.dw <= 10, owner);
    const anim = await probe.J(`(() => {
      const sp = document.querySelector("rect[data-spinner]");
      const cs = getComputedStyle(sp);
      return JSON.stringify({ name: cs.animationName, dur: cs.animationDuration });
    })()`);
    probe.eq("★ 亮边在动（有 march 动画）", anim.name, "wf-mini-march");
    probe.check("动画时长 1.6s", anim.dur === "1.6s", anim);
  }

  /* ── 7. 上游成功的边**才**点亮（carr未非空）── */
  const carried = await probe.texts("path[data-carried]");
  probe.check("有一些边被标成「送过去了」", carried.length > 0, { count: carried.length });

  await probe.shot("flow-mixed.png");

  /* ── 8. 回边场景：#back ── */
  await probe.raw(`(() => { location.hash = "back"; })()`);
  await new Promise((r) => setTimeout(r, 500));
  const backEdges = await probe.J(`(() => {
    const paths = [...document.querySelectorAll("path[data-edge-id]")];
    return JSON.stringify(paths.map((p) => ({
      id: p.getAttribute("data-edge-id"),
      dash: p.getAttribute("stroke-dasharray"),
      d: p.getAttribute("d").slice(0, 30),
    })));
  })()`);
  const backEdge = backEdges.find((e) => e.id === "e3");
  probe.check("★ 回边（c→b）画出来了", !!backEdge, backEdges);
  probe.check("★ 回边是虚线（和顺行的实线分得开）", backEdge && backEdge.dash !== null, backEdge);

  await probe.shot("flow-back.png");

  /* ── 9. 只有一格在跑的场景 ── */
  await probe.raw(`(() => { location.hash = "running"; })()`);
  await new Promise((r) => setTimeout(r, 500));
  const runningSub = await probe.texts("[data-node-sub]");
  probe.check("★ 跑动那格的小字带耗时（「执行中 · Ns」）",
    runningSub.some((s) => s.includes("·")), runningSub);

  await probe.shot("flow-running.png");
  return probe;
});
