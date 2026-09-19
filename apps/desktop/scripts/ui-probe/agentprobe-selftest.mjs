/**
 * 自检 probe.mjs 自己。**已知颜色的方块读出来必须是那个颜色** —— 否则解码器
 * 解错了也看不出来，后面所有像素断言都建在沙子上。
 *
 * 同时钉住几件跟"用户看到什么"有关的事:
 *   - 真鼠标点击真的触发 onClick（而不是只派了个事件)
 *   - 视口真的够高（点视口外会静默变成"什么都没点"）
 *   - 右键真的走 contextmenu（CDP 不派，得自己补)
 *   - 对比度算得对（浅灰字必须被判成不够清楚)
 *   - 行内元素的盒子如实上报（这个仓库踩过的坑，留一条哨兵)
 *   - 每个坐标上到底是谁 —— 判据要"说得出点什么"
 */
import { launch, runDriver } from "./probe.mjs";

const near = (a, b, tol = 6) => Math.abs(a - b) <= tol;
const nearColor = (p, [r, g, b], tol = 6) =>
  p && near(p.r, r, tol) && near(p.g, g, tol) && near(p.b, b, tol);

await runDriver(async () => {
  const probe = await launch({ page: "selftest.html", port: 9455, size: "700,400" });

  /* ── 0. 视口 ── */
  probe.eq("视口宽度钉在 700", probe.viewport.w, 700);
  probe.eq("视口高度钉在 400（不是窗口高度）", probe.viewport.h, 400);
  const hit = await probe.hitTest(80, 185);
  probe.check("(80,185) 命中的是那个按钮", hit.found && hit.id === "btn", hit);
  const hitEmpty = await probe.hitTest(660, 60);
  probe.check("空白处命中的是根元素（而不是报「没找到」）",
    hitEmpty.found && (hitEmpty.tag === "html" || hitEmpty.tag === "body"), hitEmpty);

  /* ── 1. 像素：已知颜色必须读得出来 ── */
  const red = await probe.pixelOf("#red");
  probe.check("红方块读出来是纯红", nearColor(red, [255, 0, 0]), red);
  const blue = await probe.pixelOf("#blue");
  probe.check("蓝方块读出来是纯蓝", nearColor(blue, [0, 0, 255]), blue);
  const half = await probe.pixelOf("#half");
  probe.check("50% 灰读出来是 128 上下", nearColor(half, [128, 128, 128], 4), half);
  const margin = await probe.pixel(660, 380);
  probe.check("空白处读出来是白", nearColor(margin, [255, 255, 255]), margin);

  /* ── 2. 真鼠标点击 ── */
  await probe.clickEl("#btn");
  probe.eq("真鼠标点一下，onClick 计数是 1", await probe.raw("window.__clicks"), 1);
  await probe.clickEl("#btn");
  probe.eq("再点一下是 2（不是一次都没生效）", await probe.raw("window.__clicks"), 2);

  /* ── 3. 点错地方/点视口外必须当场报错，不能静默空过 ── */
  let threw = "";
  try {
    await probe.click(30, 9000);
  } catch (e) {
    threw = e.message;
  }
  probe.check("点视口外当场抛错（而不是静默空过）", threw.includes("视口"), threw);
  threw = "";
  try {
    await probe.clickEl("#btn", { expect: "取消" });
  } catch (e) {
    threw = e.message;
  }
  probe.check("点错了元素当场抛错（而不是当成点过了）", threw.includes("命中的是"), threw);

  /* ── 4. 右键：先右键那个锚点，再右键已经出现的菜单 ── */
  const before = await probe.el("#menu");
  probe.check("右键之前菜单是隐藏的（零高）", before.zeroBox, before.box);
  const rc = await probe.rightClick(60, 185); // ← 落在按钮上，和真实用法一样
  probe.eq("右键恰好触发一次 contextmenu（真派了就不补，补了会变两发）", rc.count, 1);
  const after = await probe.el("#menu");
  probe.check("右键之后菜单真的出现了", after.box.h > 0, after.box);

  /* ── 5. 对比度：浅灰字必须被判成不够清楚 ── */
  const good = await probe.regionContrast("#txt");
  probe.check("黑字白底对比度 > 10", good > 10, good);
  const bad = await probe.regionContrast("#lowc");
  probe.check("浅灰字对比度 < 2.5（这就是「不够清楚」）", bad < 2.5, bad);

  /* ── 6. 裁剪 ── */
  const clip = await probe.el("#cl");
  probe.check("溢出被裁的元素报 clippedX", clip.clippedX, clip);

  /* ── 7. 行内元素的盒子：如实上报 ──
     2026-09-20 实测修正：行内元素的 `getComputedStyle().width` 恒为 `auto`
     （只有 getBoundingClientRect 能信）；而 `rect` 在**有文字**的行内元素上是
     真实的（52x16），**零宽只发生在空的**行内元素上。这条哨兵钉的正是这两点。 */
  const ispan = await probe.el("#ispan");
  probe.check("有文字的行内元素有真实盒子", ispan.box.w > 0 && ispan.box.h > 0, ispan.box);
  probe.check("但它的 computed width 是 auto（只有 rect 能信）",
    (await probe.raw(`getComputedStyle(document.getElementById("ispan")).width`)) === "auto",
    await probe.raw(`getComputedStyle(document.getElementById("ispan")).width`));
  const espan = await probe.el("#espan");
  probe.check("空的行内元素才是零宽", espan.zeroBox, espan.box);
  probe.check("零宽的那个宽度是 0，但高度还是行高（不是整个盒子都没了）",
    espan.box.w === 0 && espan.box.h > 0, espan.box);

  /* ── 8. inkRatio：画出来没有 ── */
  const inkMenu = await probe.inkRatio("#menu", { r: 238, g: 238, b: 238 });
  probe.check("菜单里确实有非底色的墨", inkMenu > 0.01, inkMenu);
  const inkBlank = await probe.inkRatio("#red", { r: 255, g: 0, b: 0 });
  probe.eq("纯色块相对它自己的底色墨量是 0", inkBlank, 0);

  /* ── 9. 中文文字读得回来 ── */
  probe.eq("中文文字原样读回", (await probe.el("#txt")).text, "黑色的正文，够清楚");

  /* ── 10. 键盘 ── */
  await probe.raw(`document.body.insertAdjacentHTML("beforeend",
    '<input id="inp" style="position:absolute;left:20px;top:320px">');
    document.getElementById("inp").focus();`);
  await probe.type("汉字abc");
  probe.eq("insertText 打进输入框", await probe.raw("document.getElementById('inp').value"), "汉字abc");
  await probe.raw(`document.getElementById("inp").value = ""`);
  await probe.raw(`document.getElementById("inp").focus()`);
  await probe.type("x");
  await probe.press("Enter");
  probe.eq("press 一个键，输入框收到的是 x（Enter 没被吞）", await probe.raw("document.getElementById('inp').value"), "x");

  await probe.shot("selftest.png");
  return probe;
});
