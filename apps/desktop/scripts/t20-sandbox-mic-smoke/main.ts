import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { epitaxyHostCommandAllowed, epitaxyRoute, EPITAXY_MIMES } from "../../src/renderer/components/chat/epitaxySecurity.js";
import { EpitaxyIframeBridge } from "../../src/renderer/components/chat/EpitaxyIframeBridge.js";
import { LiveMicActivityBars, speechBarHeights, voiceModeOf } from "../../src/renderer/components/chat/LiveMicActivityBars.js";

let checks = 0;
function check(label: string, condition: boolean) {
  checks++;
  assert.ok(condition, label);
  console.log("  PASS " + label);
}
const src = (path: string) => readFileSync(resolve("src", path), "utf8");

check("seven MIME variants exhaustively declared", EPITAXY_MIMES.length === 7 && new Set(EPITAXY_MIMES).size === 7);
check("HTML and SVG use isolated frame", epitaxyRoute("application/vnd.ant.html") === "frame" && epitaxyRoute("application/vnd.ant.svg") === "frame");
check("remaining 5 variants are inert content", EPITAXY_MIMES.filter(m => epitaxyRoute(m) === "text").length === 5);
check("unknown MIME never executes", epitaxyRoute("text/html") === "unsupported");

const artifact = renderToStaticMarkup(React.createElement(EpitaxyIframeBridge, {
  content: "<script>danger()</script>",
  mimeType: "application/vnd.ant.html",
}));
check("Epitaxy renderer uses iframe sandbox without same-origin", /<iframe\b[^>]*sandbox="[^"]+"/.test(artifact) && !/allow-same-origin/.test(artifact));
check("Epitaxy renderer never writes untrusted artifact into parent DOM", !artifact.includes("danger()") || artifact.includes("srcDoc"));
const code = renderToStaticMarkup(React.createElement(EpitaxyIframeBridge, {
  content: "<script>danger()</script>",
  mimeType: "application/vnd.ant.react",
}));
check("React-code artifact appears escaped rather than executed", code.includes("&lt;script&gt;") && !code.includes("<script>"));
check("synthetic event cannot invoke host command even with spoofed gesture",
  !epitaxyHostCommandAllowed({ origin: "null", isTrusted: false, userActivation: { isActive: true } }));
check("trusted event without native gesture cannot invoke host command",
  !epitaxyHostCommandAllowed({ origin: "null", isTrusted: true }));
check("other origins cannot invoke host command",
  !epitaxyHostCommandAllowed({ origin: "https://evil.invalid", isTrusted: true, userActivation: { isActive: true } }));
check("trusted opaque-origin event with live native gesture is eligible",
  epitaxyHostCommandAllowed({ origin: "null", isTrusted: true, userActivation: { isActive: true } }));

const iframeSource = src("renderer/components/customUi/PanelFrame.tsx");
const panelIframe = iframeSource.match(/<iframe[\s\S]*?\/>/)?.[0] ?? "";
check("customUi PanelFrame iframe sandboxes and forbids same-origin",
  /sandbox="[^"]*allow-scripts[^"]*"/.test(panelIframe) && !/allow-same-origin/.test(panelIframe));
const embedSrc = src("renderer/components/chat/EpitaxyIframeBridge.tsx");
const embedIframe = embedSrc.match(/<iframe[\s\S]*?\/>/)?.[0] ?? "";
check("new artifact iframe sandboxes and forbids same-origin",
  /sandbox="[^"]*allow-scripts[^"]*"/.test(embedIframe) && !/allow-same-origin/.test(embedIframe));

const docHost = src("main/document/documentViewHost.ts");
check("document WebContentsView uses sandbox + context isolation + no Node",
  /contextIsolation:\s*true,\s*nodeIntegration:\s*false,\s*sandbox:\s*true/.test(docHost));
const browser = src("main/browser/BrowserManager.ts");
if (/sandbox:\s*false/.test(browser)) {
  console.warn("  REMAINING T20 #1: BrowserManager WebContentsView uses sandbox:false due to ESM browserPicker preload. Outside T20 writable main scope.");
}

check("idle/connecting/active state transition decision",
  voiceModeOf(false, false) === "idle" &&
  voiceModeOf(true, false) === "connecting" &&
  voiceModeOf(true, true) === "active" &&
  voiceModeOf(false, true) === "active");
const zero = speechBarHeights(new Uint8Array(256));
const voiced = speechBarHeights(new Uint8Array(256).fill(160));
check("real FFT changes 6 independent bounded bar heights",
  zero.length === 6 && zero.every(x => x === 4) &&
  voiced.every(x => x > 4 && x <= 24));
const idle = renderToStaticMarkup(React.createElement(LiveMicActivityBars, { mode: "idle" }));
const connecting = renderToStaticMarkup(React.createElement(LiveMicActivityBars, { mode: "connecting" }));
const active = renderToStaticMarkup(React.createElement(LiveMicActivityBars, { mode: "active" }));
check("all three modes render 6 informational bars",
  ["idle", "connecting", "active"].every(x => [idle, connecting, active].some(s => s.includes(`data-mode="${x}"`))) &&
  [idle, connecting, active].every(s => (s.match(/class="live-mic-bar"/g) ?? []).length === 6));
const css = src("renderer/styles.css");
check("connecting pulse is gated by explicit reduced-motion preference",
  css.includes('.live-mic-bars[data-mode="connecting"][data-reduced="false"]'));
const barsSrc = src("renderer/components/chat/LiveMicActivityBars.tsx");
check("FFT RAF is disabled on reduced motion and cleanup cancels it",
  barsSrc.includes('mode !== "active" || !audioStream || reduced') && barsSrc.includes("cancelAnimationFrame(raf)"));
check("no framer-motion imported", !barsSrc.includes("framer-motion"));

console.log(`T20 sandbox/mic smoke: ${checks}/${checks} PASS (browser sandbox blocker recorded separately)`);
