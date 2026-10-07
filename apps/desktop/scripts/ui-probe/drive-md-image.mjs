/**
 * 用 ui-probe 量「md 预览里的图片」。
 *
 * 规划 3.8⑧：「预览里 md 图片是裂的」改过 baseDir，但**没在真浏览器看过图**。
 * 这里把它变成能进断言的数：
 *  - 有 baseDir 时，正文里出现**真的 `<img>`**，src 是 data: URL（不是裂图 chip）
 *  - 无 baseDir 时，退化成**文件名 chip**（用户看到的"图全裂"）
 *  - 网络图（https）两条路都保持原样
 *
 * 用法：node drive-md-image.mjs
 * 退出码：0 全过 · 1 有断言红 · 2 崩溃。
 */
import { launch, runDriver } from "./probe.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await runDriver(async () => {
  // 有 baseDir —— 图应当被放出来。
  const probe = await launch({ page: "../../.tmp/md-preview/index.html?base=1", size: "700,600" });
  await wait(800); // 等 api.file.readBinary 的 promise 落地 + 重渲染

  const imgs = await probe.J(`JSON.stringify([...document.querySelectorAll("img")].map((i) => ({
    src: i.getAttribute("src") || "",
    alt: i.getAttribute("alt") || "",
    w: Math.round(i.getBoundingClientRect().width),
    h: Math.round(i.getBoundingClientRect().height),
  })))`);
  probe.check("★ 有 baseDir：至少渲染出 2 张图（本地图 + 网络图）", imgs.length >= 2, imgs);
  const localImg = imgs.find((i) => (i.alt || "").includes("图一"));
  probe.check("★ 本地图渲染成真 <img>（不是裂图 chip）", !!localImg, imgs);
  probe.check("★ 本地图的 src 是 data: URL（说明真的把盘上的字节读回来内联了）",
    !!localImg && localImg.src.startsWith("data:image/"), localImg);
  probe.check("★ 本地图有真实尺寸（画出来了，不是 0×0）",
    !!localImg && localImg.w > 0 && localImg.h > 0, localImg);
  const netImg = imgs.find((i) => (i.alt || "").includes("网络图"));
  probe.check("网络图保持 https 原样（没被本地化）",
    !!netImg && netImg.src.startsWith("https://"), netImg);

  // 转圈那块（FileLink 的 chip 有 data-* 吗）—— 数一下"没有图"的痕迹：不该有 FileLink chip。
  const chips = await probe.J(`(() => {
    const t = document.body.innerText || "";
    return JSON.stringify({ hasFigChip: t.includes("fig1.png"), text: t.slice(0, 200) });
  })()`);
  probe.check("★ 正文里没有退化成文件名 chip（fig1.png 不该作为文字出现）",
    !chips.hasFigChip, chips);

  await probe.shot("md-image-with-base.png");

  // 无 baseDir —— 应当退化成 chip（这就是"图全裂"的样子）。
  await probe.raw(`(() => { location.search = "?base=0"; })()`);
  await wait(900);
  const imgsNoBase = await probe.J(`JSON.stringify([...document.querySelectorAll("img")].map((i) => ({
    src: i.getAttribute("src") || "", alt: i.getAttribute("alt") || "",
  })))`);
  const localNoBase = imgsNoBase.find((i) => (i.alt || "").includes("图一"));
  probe.check("★ 无 baseDir：本地图**不**渲染成 <img>（退化成 chip —— 这正是用户报的现象）",
    !localNoBase, imgsNoBase);
  // chip 显示的是 **alt**(「图一」),不是路径（见 `Markdown` 的 img 分支:
  // `display={alt ? …alt… : undefined}`）。判据取 alt 而不是文件名 —— 那才是用户看到的字。
  const noBaseText = await probe.raw("document.body.innerText || ''");
  probe.check("无 baseDir 时那个位置退化成 alt 文字（不再是图）",
    typeof noBaseText === "string" && noBaseText.includes("图一"), noBaseText.slice(0, 200));
  const netNoBase = imgsNoBase.find((i) => (i.alt || "").includes("网络图"));
  probe.check("无 baseDir 时网络图照样是 <img>（只有本地图受影响）",
    !!netNoBase, imgsNoBase);

  await probe.shot("md-image-no-base.png");
  return probe;
});
