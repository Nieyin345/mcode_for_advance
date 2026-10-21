/**
 * Sandboxed, context-isolated preload for arbitrary browser pages.
 * Electron sandbox preload has a restricted require('electron') polyfill,
 * so the build must emit a standalone CommonJS browserPicker.cjs.
 *
 * The main-world picker script can call mcodeBridge.pickElement, but a page
 * cannot manufacture an IPC result: this isolated world first observes a
 * genuine click and then verifies that the requested selector points to the
 * exact element clicked. The DOM-derived fields are read here, not trusted
 * from the page's request. No Node APIs / raw IPC are exposed.
 */
import { contextBridge, ipcRenderer } from "electron";

const HTML_CAP = 2000;
let clicked: Element | null = null;
let gesturePending = false;

// Installed by the preload before the page can inject its own picker listeners.
// An untrusted dispatchEvent() always has isTrusted=false.
document.addEventListener("click", (event: MouseEvent) => {
  if (!event.isTrusted || !(event.target instanceof Element)) return;
  clicked = event.target;
  gesturePending = true;
  // The injected capture-phase picker calls the bridge synchronously during
  // this same event. Never retain a reusable gesture token across tasks.
  setTimeout(() => {
    clicked = null;
    gesturePending = false;
  }, 0);
}, true);

contextBridge.exposeInMainWorld("mcodeBridge", {
  pickElement: (data: unknown): void => {
    if (!gesturePending || !clicked || !data || typeof data !== "object") return;
    const selector = (data as { selector?: unknown }).selector;
    if (typeof selector !== "string" || !selector || selector.length > 1000) return;
    let matched: Element | null = null;
    try {
      matched = document.querySelector(selector);
    } catch {
      return;
    }
    // A page script can call the bridge, but cannot choose a different DOM
    // node or replay an earlier click. Do not trust outerHTML/url/preview.
    if (matched !== clicked) return;
    const el = clicked;
    gesturePending = false;
    clicked = null;
    const html = el.outerHTML || "";
    const id = el.id ? "#" + el.id : "";
    const classes = !id && typeof el.className === "string" && el.className.trim()
      ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
      : "";
    ipcRenderer.send("__mcode_pick_result__", {
      selector,
      outerHTML: html.length > HTML_CAP ? html.slice(0, HTML_CAP) + "\u2026" : html,
      url: location.href,
      preview: (selector || el.tagName.toLowerCase() + id + classes).slice(0, 40),
    });
  },
});
