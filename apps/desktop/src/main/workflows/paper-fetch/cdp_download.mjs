#!/usr/bin/env node
// -*- coding: utf-8 -*-
// cdp_download.mjs — 通过 Chrome DevTools Protocol（CDP）复用用户已登录的
// Edge/Chrome 会话下载 PDF（零第三方依赖，Node 22+ 内置 WebSocket/fetch）。
//
// 适用场景：机构认证下载（IEEE WAF / 付费墙）。用户先在带调试端口的浏览器里
// 完成机构登录（含 MFA），此后本脚本直接复用该登录态，无需每次重新登录。
// 启动方式见 scripts/edge_cdp.ps1；或手动：
//   msedge.exe --remote-debugging-port=9222 --user-data-dir=<专用profile>
//
// 用法：
//   node scripts/cdp_download.mjs --url <pdf-url> --out <file.pdf> [--port 9222] [--timeout 180]
// 输出：JSON（stdout）；退出码 0=成功 1=失败
import fs from "node:fs";
import path from "node:path";

function usage() {
  console.log(`Usage:
  node cdp_download.mjs --url <pdf-url> --out <file.pdf> [--port 9222] [--timeout 180]
Reuses an already-authenticated Edge/Chrome session (launched with
--remote-debugging-port) to download a PDF via page-context fetch with
credentials included. Does not bypass logins, CAPTCHA, or paywalls.`);
}

function parseArgs(argv) {
  const args = { port: 9222, timeout: 180 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--url") args.url = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--port") args.port = Number(argv[++i]);
    else if (a === "--timeout") args.timeout = Number(argv[++i]);
    else throw new Error("Unknown argument: " + a);
  }
  return args;
}

async function httpJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error("WebSocket 连接失败"));
    });
    this.ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || "CDP error"));
        else resolve(msg.result);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("CDP 超时: " + method));
        }
      }, 120000);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

// 单次尝试：新建标签页 → 同源 fetch → 校验 %PDF。成功返回 {ok:true,...}；
// 确定性失败（200 HTML 等）返回 {ok:false,...}；可重试失败抛异常。
async function attemptDownload(args, attempt) {
  const port = args.port;
  const version = await httpJson(`http://127.0.0.1:${port}/json/version`, 5000);
  const browser = new CdpClient(version.webSocketDebuggerUrl);
  await browser.open();

  let targetId = null;
  let pageClient = null;
  try {
    const target = await browser.send("Target.createTarget", { url: args.url });
    targetId = target.targetId;
    const pageInfo = await httpJson(`http://127.0.0.1:${port}/json/list`, 5000);
    const page = pageInfo.find((t) => t.id === targetId);
    if (!page || !page.webSocketDebuggerUrl) {
      throw new Error("cdp_page_ws_missing");
    }
    pageClient = new CdpClient(page.webSocketDebuggerUrl);
    await pageClient.open();

    // 等待页面加载（PDF viewer 或 HTML 页均可，避免 context 未就绪）
    for (let i = 0; i < 30; i++) {
      try {
        const st = await pageClient.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
        if ((st.result && st.result.value) === "complete") break;
      } catch {}
      await new Promise((r) => setTimeout(r, 1000));
    }

    // 页面上下文 fetch（携带已登录 cookie，同源无 CORS）
    const urlJson = JSON.stringify(args.url);
    const expression = `(async () => {
      try {
        const r = await fetch(${urlJson}, { credentials: "include", redirect: "follow" });
        const ct = r.headers.get("content-type") || "";
        const ab = await r.arrayBuffer();
        const bytes = new Uint8Array(ab);
        let bin = "";
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        return { status: r.status, ct, b64: btoa(bin), size: bytes.length, finalUrl: r.url };
      } catch (e) {
        return { error: String(e && e.message || e), status: -1 };
      }
    })()`;
    let res = null;
    try {
      const out = await pageClient.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      res = out.result && out.result.value;
      if (!res && out.exceptionDetails) {
        throw new Error("eval_exception: " + String(out.exceptionDetails.exception?.description || out.exceptionDetails.text).slice(0, 300));
      }
    } catch (e) {
      throw new Error("cdp_fetch_error: " + e.message);
    }
    if (!res || typeof res !== "object") {
      throw new Error("eval_no_value");
    }
    if (res.error) {
      throw new Error("page_fetch_error: " + res.error);
    }
    if (res.status !== 200) {
      // 非 200：可能是会话过期/反爬，交给上层重试一次
      throw new Error("http_" + res.status + " (attempt " + attempt + ")");
    }
    const buf = Buffer.from(res.b64 || "", "base64");
    if (buf.subarray(0, 4).toString("latin1") !== "%PDF") {
      // 200 但 HTML：登录页/无权限页，确定性失败，不重试
      return { ok: false, error: "http_200_not_pdf", ct: res.ct, size: res.size, hint: "返回 HTML = 登录页/无权限页（机构可能无该刊订阅）" };
    }
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, buf);
    return { ok: true, file: path.resolve(args.out), size: buf.length, finalUrl: res.finalUrl, via: "cdp", attempt };
  } finally {
    if (targetId) {
      try { await browser.send("Target.closeTarget", { targetId }); } catch {}
    }
    if (pageClient) pageClient.close();
    browser.close();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { usage(); process.exit(0); }
  if (!args.url || !args.out) throw new Error("--url 与 --out 必填");

  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await attemptDownload(args, attempt);
      if (result.ok || result.error === "http_200_not_pdf") {
        console.log(JSON.stringify(result));
        process.exit(result.ok ? 0 : 1);
      }
      console.log(JSON.stringify(result));
      process.exit(1);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  console.log(JSON.stringify({
    ok: false,
    error: "cdp_retry_exhausted",
    detail: String(lastErr && lastErr.message || lastErr).slice(0, 500),
    hint: "确认已运行 scripts/edge_cdp.ps1 且浏览器已登录机构（CDP 仅复用会话，不绕过权限）",
  }));
  process.exit(1);
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: "cdp_unreachable", detail: String(e && e.stack || e).slice(0, 500) }));
  process.exit(1);
});
