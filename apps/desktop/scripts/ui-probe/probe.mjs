/**
 * 前端核对台 —— 真浏览器 + 真鼠标键盘 + **能算的像素**。
 *
 * ## 为什么需要它
 *
 * 驱动这个仓库的模型**看不见图片**:`Read` 对 PNG 返回空,连手写的 74 字节纯色
 * PNG 也一样(所以跟图的来源、大小、路径都无关)。但"看不见"不等于"验不了":
 *
 *   视觉上的每一句话几乎都能变成一次**测量** ——
 *   「它是红的」→ 取那个坐标的像素,比 RGB;
 *   「这里画出来了吗」→ 数那块区域里非背景色的像素有多少;
 *   「这句字够不够清楚」→ 算前景/背景的对比度;
 *   「它没被裁掉」→ 比 scrollWidth 与 clientWidth;
 *   「点得到吗」→ hitTest 先问"这个坐标上是谁"。
 *
 * 数字能进断言、能进报告、能变异验证。截图仍然是副产品(给人看的),但**判据
 * 不依赖我能不能看图**。
 *
 * ## 用法
 *
 * ```js
 * import { launch, runDriver } from "./probe.mjs";
 * await runDriver(async () => {
 *   const probe = await launch({ page: "pdf.html", port: 9434 });
 *   const badge = await probe.el("#badge");
 *   probe.eq("徽章印的是「找不到来源」", badge.text, "找不到来源");
 *   const px = await probe.pixelOf("#badge");       // → {r,g,b,a}
 *   probe.check("它是暖色不是红的", px.r > 150 && px.g > 100, px);
 *   const rc = await probe.rightClick(200, 120);
 *   probe.eq("右键恰好一次", rc.count, 1);
 *   await probe.clickEl("#ok");                     // 真鼠标,点元素正中央
 *   await probe.shot("out.png");
 *   return probe;                                   // runDriver 会收尾并设退出码
 * });
 * ```
 *
 * 退出码:`0` 全过 · `1` 有断言红了 · `2` 核对脚本自己崩了。
 *
 * ## 凭什么信它
 *
 * `agentprobe-selftest.mjs` + `selftest.html` 是它的自检:已知颜色的方块读出来
 * 必须是那个颜色,真鼠标点击真的触发 onClick,浅灰字必须被判成"不够清楚"。
 * `mut_probe.py` 再把 probe 自己弄坏 7 次,7/7 都必须红。
 * 这两样跑绿之前,别信任何一份用它的结论。
 *
 * ## 它替你踩住的坑(2026-09-20 实测)
 *
 *  1. **`--window-size` 管的是窗口不是视口。** headless 下视口比它小一截(给 800
 *     高只拿到 165),而 CDP 鼠标事件按**视口坐标**命中测试。点在视口外会静默变成
 *     "什么都没点":事件照样派到 document,只是没有元素收到 —— 和"onClick 没接对"
 *     长得一模一样。现在用 `Emulation` 钉死视口并在 boot 校验,`click()` 点视口外
 *     直接抛错。
 *  2. **右键有时真派 `contextmenu`、有时不派**。无条件补一发会在"真派了"的那次
 *     变成两发,toggle 类菜单开了又关。现在先派真的、数一下,没到才补。
 *  3. **行内元素的 `getComputedStyle().width` 恒为 `auto`**,只有
 *     `getBoundingClientRect` 能信。"零宽"只发生在**空**的行内元素上,有文字的行内
 *     span 有真实盒子(实测 52×16)。
 *  4. **`Object.is` 比数组恒假** —— 用 `eqList`。
 *  5. **`window.api` 的桩要写在 HTML 的 `<script>` 里**,不能写在 `.tsx` 里 ——
 *     `lib/api.ts` 在**模块求值那一刻**决定走 preload 还是 web shim,而 ES 的
 *     import 先于模块体执行。
 *  6. **`.click()` 绕过 base-ui 的指针事件门**,会让"接错线"和"菜单根本没开"同形。
 *     一律走 `clickEl()`。
 */
import { spawn } from "node:child_process";
import { inflateSync } from "node:zlib";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// ⚠️ 这是 .mjs,`require` 不存在 —— 早先这里写了 `require("node:fs").existsSync(p)`
// 并用 try/catch 兜住,于是**两个候选都静默判否**,一路走到"找不到 Chrome"。
// 兜底把"没装 Chrome"和"我自己写错了"变成同一个报错。
const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  process.env.CHROME_PATH ?? "",
].find((p) => p && existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* "量一个像素"用的中间截图不再落盘 —— 走 api.capture() 拿内存里的 PNG。
   从前它写进系统临时目录里一个固定文件名,并发跑两个 probe 会互相覆盖。 */

/* ─────────────────────────── PNG 解码(纯 Node,无依赖) ───────────────────────────
   只有 zlib 来自 node。用来把截图变成可以算的像素 —— 这样"颜色对不对""这块
   画出来没有"都能进断言,而不是靠人眼。 */

/** 解一张 8-bit 的 PNG(色型 0/2/4/6)。返回 { width, height, px(x,y) => [r,g,b,a] }。 */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("不是 PNG");
  let off = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const tag = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (tag === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (tag === "IDAT") {
      idat.push(data);
    } else if (tag === "IEND") {
      break;
    }
    off += 12 + len;
  }
  if (depth !== 8) throw new Error(`只支持 8-bit,拿到 ${depth}`);
  if (interlace !== 0) throw new Error("不支持隔行 PNG");
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`不支持的色型 ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  // 去滤波:每一行前面有一个 filter 字节。四种滤波器都要实现 —— Chrome 的截图
  // 里 2(Up)/4(Paeth)很常见,只做 None 的话解出来是花的。
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const dst = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? dst[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      const x = src[i];
      dst[i] =
        f === 0 ? x
        : f === 1 ? (x + a) & 0xff
        : f === 2 ? (x + b) & 0xff
        : f === 3 ? (x + ((a + b) >> 1)) & 0xff
        : (x + paeth(a, b, c)) & 0xff;
    }
  }

  const px = (x, y) => {
    const i = (Math.round(y) * width + Math.round(x)) * channels;
    if (x < 0 || y < 0 || x >= width || y >= height) return null;
    if (channels === 1) return { r: out[i], g: out[i], b: out[i], a: 255 };
    if (channels === 2) return { r: out[i], g: out[i], b: out[i], a: out[i + 1] };
    if (channels === 3) return { r: out[i], g: out[i + 1], b: out[i + 2], a: 255 };
    return { r: out[i], g: out[i + 1], b: out[i + 2], a: out[i + 3] };
  };
  return { width, height, channels, data: out, px };
}

/** 相对亮度(WCAG)。对比度差要看的是这个,不是"看着挺清楚"。 */
function luminance({ r, g, b }) {
  const f = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG 对比度:1 到 21。正文至少 4.5,大字 3。 */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/* ─────────────────────────────── 启动 ─────────────────────────────── */

/** 探一个空闲端口。并发的两个 probe 各自挑,撞车概率约 1/500 —— 真撞上会由下面的
 *  target 找不到而报错,不会像从前那样**静默连到别人的 Chrome**。要彻底消除,可以让
 *  Chrome 用 `--remote-debugging-port=0` 自动分配、再从 profile 里的 DevToolsActivePort
 *  读回来;眼下这点碰撞概率不值得那份复杂度。 */
async function pickFreePort() {
  for (let i = 0; i < 50; i++) {
    const candidate = 9500 + Math.floor(Math.random() * 500);
    const busy = await fetch(`http://127.0.0.1:${candidate}/json/version`).then(
      () => true,
      () => false,
    );
    if (!busy) return candidate;
  }
  throw new Error("找不到空闲的调试端口");
}

export async function launch({ page, port, size = "1000,800", waitMs = 300 }) {
  if (!CHROME) throw new Error("找不到 Chrome,设 CHROME_PATH 或改 probe.mjs 里那个路径");
  if (port === undefined) port = await pickFreePort();
  const [vw, vh] = size.split(",").map(Number);
  const url = `file:///${resolve(HERE, page).replace(/\\/g, "/")}`;

  // 独立的 user-data-dir:共用默认 profile 时,第二个 Chrome 会因为 profile 被锁而
  // **静默退出**,而我们仍然从**别人的**浏览器上取到 target —— 两个驱动操作同一个
  // 页面,输入叠加、事件翻倍,报出来的错跟真正的原因毫无关系(实测:并发时
  // insertText 打出"汉字abc汉字abc"、contextmenu 触发两次)。
  const profileDir = mkdtempSync(join(tmpdir(), "mcode-ui-probe-profile-"));
  const chrome = spawn(CHROME, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    `--user-data-dir=${profileDir}`,
    `--window-size=${vw},${vh}`,
    `--remote-debugging-port=${port}`,
    url,
  ]);
  chrome.stderr.on("data", () => {});

  // 关 Chrome 时顺手带走它那份 profile —— 每跑一次攒一个临时目录,不清会长草。
  const killChrome = () => {
    chrome.kill();
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      // Windows 上 Chrome 可能还没放开文件句柄;留着也无妨(是系统临时目录)。
    }
  };

  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
        (t) => t.type === "page" && t.webSocketDebuggerUrl,
      );
    } catch {
      /* 还没起来 */
    }
    if (!target) await sleep(250);
  }
  if (!target) {
    killChrome();
    throw new Error(`Chrome 没起来(端口 ${port})`);
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
    if (m.method === "Runtime.consoleAPICalled")
      logs.push(m.params.args.map((a) => a.value ?? "").join(" "));
    if (m.method === "Runtime.exceptionThrown") logs.push("EXC " + m.params.exceptionDetails.text);
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const n = ++id;
      pending.set(n, res);
      ws.send(JSON.stringify({ id: n, method, params }));
    });

  await send("Runtime.enable");
  await send("Page.enable");
  // ⚠️ `--window-size` 管的是**窗口**不是视口,headless 下视口会比它小一截(实测给
  //   800 高只拿到 165),而 CDP 的鼠标事件按**视口坐标**命中测试。于是"点在视口外"
  //   会静默变成"什么都没点":事件照样派到 document,只是没有元素收到 —— 和
  //   "onClick 没接对"长得一模一样。用 Emulation 把视口钉死,不让窗口装饰掺和。
  await send("Emulation.setDeviceMetricsOverride", {
    width: vw,
    height: vh,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(waitMs);
  const vp = JSON.parse(
    (
      await send("Runtime.evaluate", {
        expression: "JSON.stringify([innerWidth, innerHeight])",
        returnByValue: true,
      })
    ).result.result.value,
  );
  if (Math.abs(vp[0] - vw) > 2 || Math.abs(vp[1] - vh) > 2) {
    killChrome();
    throw new Error(`视口钉不住:要 ${vw}x${vh},拿到 ${vp[0]}x${vp[1]}`);
  }
  if (vh < 400) {
    killChrome();
    throw new Error(`视口只有 ${vh} 高,鼠标点不到下半屏 —— 至少给 400`);
  }

  const raw = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
    if (r.result.exceptionDetails)
      return "EXC " + (r.result.exceptionDetails.exception?.description ?? "").split("\n")[0];
    return r.result.result.value;
  };
  const J = async (expr) => {
    const v = await raw(expr);
    try {
      return JSON.parse(v);
    } catch {
      return { __raw: v };
    }
  };

  const checks = [];
  let failures = 0;
  const shots = [];

  const api = {
    send,
    raw,
    J,
    logs,
    viewport: { w: vp[0], h: vp[1] },

    check(name, cond, detail) {
      checks.push({ name, cond: !!cond, detail });
      if (!cond) failures++;
      return !!cond;
    },
    eq(name, actual, expected) {
      return api.check(name, Object.is(actual, expected), { actual, expected });
    },
    /** 数组按内容比 —— `Object.is` 比数组恒假,用它会让每条都"红",而那种红读起来
     *  像"判据真不一致",实际只是断言写错了。 */
    eqList(name, actual, expected) {
      const a = [...actual].sort();
      const b = [...expected].sort();
      return api.check(name, JSON.stringify(a) === JSON.stringify(b), { actual: a, expected: b });
    },

    /* ── 输入:一律走 CDP 的真事件 ── */

    /** 某个坐标上**实际能被点到的**是谁。点之前先问一句,比点完猜坐标强。 */
    hitTest(x, y) {
      return J(`(() => {
        const el = document.elementFromPoint(${x}, ${y});
        if (!el) return JSON.stringify({ found: false, why: "这个坐标上没有任何元素" });
        return JSON.stringify({
          found: true,
          tag: el.tagName.toLowerCase(),
          id: el.id || null,
          cls: typeof el.className === "string" ? el.className.slice(0, 80) : null,
          text: (el.innerText ?? el.textContent ?? "").trim().slice(0, 40),
          // 视口外的坐标,elementFromPoint 会返回 null
          inViewport: ${x} >= 0 && ${y} >= 0 && ${x} < innerWidth && ${y} < innerHeight,
        });
      })()`);
    },

    async move(x, y) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
      await sleep(60);
    },
    /** 点一个坐标。**视口外直接报错** —— 那种情况下事件照样派到 document,只是没有
     *  元素收到,于是"点空了"和"回调没接对"完全同形。 */
    async click(x, y, { button = "left", clickCount = 1, expect } = {}) {
      if (x < 0 || y < 0 || x >= vp[0] || y >= vp[1]) {
        throw new Error(`点 (${x},${y}) 落在视口 ${vp[0]}x${vp[1]} 外 —— 这条一定是空过`);
      }
      if (expect) {
        const hit = await api.hitTest(x, y);
        const ok = (hit.id ?? "") === expect || (hit.cls ?? "").includes(expect) ||
          (hit.text ?? "").includes(expect);
        if (!ok) throw new Error(`点 (${x},${y}) 命中的是 ${JSON.stringify(hit)},不是「${expect}」`);
      }
      await api.move(x, y);
      const buttons = button === "right" ? 2 : 1;
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed", x, y, button, buttons, clickCount,
      });
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased", x, y, button, buttons: 0, clickCount,
      });
      await sleep(300);
    },
    /** 右键。⚠️ 这里有个反直觉的实测结论(2026-09-20):
     *  CDP 的 `dispatchMouseEvent` 带 `button:"right"` **有时**会派 `contextmenu`、
     *  有时不会(headless 下没有 OS 层的右键语义,行为不稳)。硬补一发的话,在
     *  "真的派了"的那次会变成**两发** —— 对 toggle 类菜单就是开了又关。
     *  所以:先派真的,数一下有没有到;没到才补。
     *  返回 `{ synthesized, count }` —— 补没补要能看见。 */
    async rightClick(x, y) {
      if (x < 0 || y < 0 || x >= vp[0] || y >= vp[1]) {
        throw new Error(`右键 (${x},${y}) 落在视口 ${vp[0]}x${vp[1]} 外`);
      }
      await raw(`(() => {
        window.__ctxCount = 0;
        if (!window.__ctxProbe) {
          window.__ctxProbe = true;
          document.addEventListener("contextmenu", () => { window.__ctxCount++; }, true);
        }
      })()`);
      await api.move(x, y);
      await send("Input.dispatchMouseEvent", {
        type: "mousePressed", x, y, button: "right", buttons: 2, clickCount: 1,
      });
      await send("Input.dispatchMouseEvent", {
        type: "mouseReleased", x, y, button: "right", buttons: 0, clickCount: 1,
      });
      await sleep(150);

      let synthesized = false;
      if (!(await raw("window.__ctxCount"))) {
        const r = await raw(`(() => {
          const el = document.elementFromPoint(${x}, ${y});
          if (!el) return "NO-ELEMENT-AT-POINT";
          el.dispatchEvent(new MouseEvent("contextmenu", {
            bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y},
          }));
          return "ok";
        })()`);
        if (r !== "ok") throw new Error(`右键 (${x},${y}) 补发失败:${r}`);
        synthesized = true;
      }
      await sleep(300);
      return { synthesized, count: await raw("window.__ctxCount") };
    },
    /** 点一个元素(读它真实的框,点正中)。**首选这个** —— 手写坐标是这个核对台里
     *  最容易悄悄错的地方,而错了之后症状是"什么都没发生"。 */
    async clickEl(sel, opts) {
      const el = await api.el(sel);
      if (!el.found) throw new Error(`点不到 ${sel}:页面上没有这个元素`);
      if (el.zeroBox) throw new Error(`点不到 ${sel}:它是零宽的(${JSON.stringify(el.box)})`);
      return api.click(el.box.x + el.box.w / 2, el.box.y + el.box.h / 2, opts);
    },

    /** 敲一个键。`Enter` / `Escape` / `Tab` / 方向键都走这里,`vk` 是 Windows 虚拟键码。 */
    async type(text) {
      await send("Input.insertText", { text });
      await sleep(120);
    },
    async key(k, { code = k, vk = 0 } = {}) {
      for (const type of ["keyDown", "keyUp"]) {
        await send("Input.dispatchKeyEvent", {
          type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
          text: type === "keyDown" && k.length === 1 ? k : undefined,
        });
      }
      await sleep(200);
    },
    /** 常用键的 vk 码,省得每次现查。`Enter` 是 13,`Escape` 是 27。 */
    async press(name) {
      const VK = {
        Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46,
        ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, " ": 32,
      };
      return api.key(name, { code: name === " " ? "Space" : name, vk: VK[name] ?? 0 });
    },

    /* ── 读 DOM:判据立在**用户看到的那行字**上 ── */

    /** 某个元素的可见文字 + 几何 + 是否被裁。
     *  ⚠️ 尺寸**只报 getBoundingClientRect**。`getComputedStyle().width` 在行内元素上
     *  恒为 `auto`(实测),拿它当尺寸会得到 NaN 或 0,而那些数字看起来很像真的。 */
    el(sel) {
      return J(`(() => {
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return JSON.stringify({ found: false });
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return JSON.stringify({
          found: true,
          text: (el.innerText ?? el.textContent ?? "").trim(),
          box: {
            x: Math.round(r.x), y: Math.round(r.y),
            w: Math.round(r.width), h: Math.round(r.height),
          },
          edges: {
            top: Math.round(r.top), left: Math.round(r.left),
            right: Math.round(r.right), bottom: Math.round(r.bottom),
          },
          display: cs.display,
          color: cs.color, background: cs.backgroundColor,
          fontSize: cs.fontSize,
          // 被裁掉没有:行盒塌了或内容溢出了,都是"用户看不到全部"
          clippedX: el.scrollWidth > el.clientWidth + 1,
          clippedY: el.scrollHeight > el.clientHeight + 1,
          zeroBox: r.width === 0 || r.height === 0,
        });
      })()`);
    },

    /** 一组元素的文字(按 DOM 顺序)。 */
    texts(sel) {
      return J(`JSON.stringify([...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => (e.innerText || e.textContent || "").trim()))`);
    },

    /* ── 截图与像素 ── */

    /** 裸截图:只回内存里的 PNG,不落盘、不记账。像素/对比度这类中间量走它 ——
        从前的写法是拍一张写进一个**固定的**临时文件再读回来,两个 probe 并发时
        会互相覆盖,断言就会读到别人的像素(而且那圈盘根本不需要)。 */
    async capture() {
      const r = await send("Page.captureScreenshot", { format: "png" });
      return Buffer.from(r.result.data, "base64");
    },

    /** 存进本目录的截图 —— 是给人看的产物,会记进 shots 清单。 */
    async shot(name) {
      const buf = await api.capture();
      writeFileSync(resolve(HERE, name), buf);
      shots.push(name);
      return buf;
    },

    /** 取一个点的像素。传元素选择器也行(取它的中心)。 */
    async pixel(x, y) {
      const buf = await api.capture();
      return decodePng(buf).px(x, y);
    },
    async pixelOf(sel) {
      const el = await api.el(sel);
      if (!el.found) return null;
      return api.pixel(el.box.x + el.box.w / 2, el.box.y + el.box.h / 2);
    },
    /** 一块区域里**跟底色不同**的像素占比 —— "这里到底画出来没有"。 */
    async inkRatio(sel, bg = { r: 255, g: 255, b: 255 }, tol = 12) {
      const el = await api.el(sel);
      if (!el.found || el.zeroBox) return 0;
      const buf = await api.capture();
      const img = decodePng(buf);
      let ink = 0;
      let all = 0;
      for (let y = el.box.y; y < el.box.y + el.box.h; y++) {
        for (let x = el.box.x; x < el.box.x + el.box.w; x++) {
          const p = img.px(x, y);
          if (!p) continue;
          all++;
          if (Math.abs(p.r - bg.r) > tol || Math.abs(p.g - bg.g) > tol || Math.abs(p.b - bg.b) > tol) ink++;
        }
      }
      return all === 0 ? 0 : ink / all;
    },

    /** 同一块区域的 WCAG 对比度(取最暗和最亮的像素)。 */
    async regionContrast(sel) {
      const el = await api.el(sel);
      if (!el.found || el.zeroBox) return null;
      const buf = await api.capture();
      const img = decodePng(buf);
      let dark = { r: 255, g: 255, b: 255 };
      let light = { r: 0, g: 0, b: 0 };
      for (let y = el.box.y; y < el.box.y + el.box.h; y++) {
        for (let x = el.box.x; x < el.box.x + el.box.w; x++) {
          const p = img.px(x, y);
          if (!p) continue;
          if (luminance(p) < luminance(dark)) dark = p;
          if (luminance(p) > luminance(light)) light = p;
        }
      }
      return contrast(dark, light);
    },

    async finish({ quiet = false } = {}) {
      const exc = logs.filter((l) => l.startsWith("EXC"));
      api.check("控制台没有异常", exc.length === 0, exc);
      if (!quiet) {
        console.log("");
        for (const c of checks)
          console.log(`${c.cond ? "  ok  " : "  FAIL"} ${c.name}${c.cond ? "" : ` — ${JSON.stringify(c.detail)}`}`);
      }
      console.log(`\n${checks.length - failures}/${checks.length} 通过${shots.length ? ` · 截图 ${shots.length} 张` : ""}`);
      ws.close();
      killChrome();
      return failures;
    },
    get failures() {
      return failures;
    },
  };
  return api;
}

/**
 * 独立核对脚本的收尾。**driver 里的异常不能吞掉** —— 否则"脚本自己崩了"和
 * "断言全过"都是退出码 0,而在 CI 输出里它们长得一样。
 */
export async function runDriver(fn) {
  let probe = null;
  try {
    probe = await fn();
  } catch (err) {
    console.log(`\n核对脚本自己崩了:${err?.message ?? err}`);
    if (probe) await probe.finish({ quiet: true }).catch(() => {});
    process.exit(2);
  }
  process.exit((await probe.finish()) === 0 ? 0 : 1);
}
