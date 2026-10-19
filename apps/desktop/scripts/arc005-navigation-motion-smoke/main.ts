import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canNavigateTabKey, tabNavigationTargetIndex } from "../../src/renderer/components/layout/tabNavigationKeys.js";
import { resolveTickerReducedMotion, tickerMotionSnapshot, subscribeTickerMotion } from "../../src/renderer/components/chat/useTickerReducedMotion.js";
let passed = 0, failed = 0;
const src=(p:string)=>readFileSync(resolve("src/renderer/components",p),"utf8");
const check=(name:string,ok:boolean)=>{console.log(`${ok?"PASS":"FAIL"} ${name}`);if(ok)passed++;else failed++;};
const tab=src("layout/TabBarChrome.tsx");
const tick=src("chat/CurrentOpTicker.tsx");
check("tab navigation ignores IME keyCode229 and Shift",tab.includes("canNavigateTabKey(e)") && tab.includes("tabNavigationTargetIndex(e.key"));
check("tab navigation makes focused overflow tab visible",tab.includes('scrollIntoView({ block: "nearest", inline: "nearest" })'));
check("tab keyboard consumes arrow propagation without triggering global shortcuts",tab.includes("e.stopPropagation()"));
check("ticker uses live Mcode override and OS media preference hook",tick.includes("useTickerReducedMotion()") && !tick.includes("useMemo("));
check("ticker handles preference changes during a rolling transition",tick.includes("if (!reducedMotion || !nextOp)") && tick.includes("setRolled(false)"));
check("ticker safely renders non-JSON tool inputs without crashing the chat",
  tick.includes("safeStringify(op.input).slice(0, 2048)") && !tick.includes("JSON.stringify(op.input)"));

const key = (override: Record<string, unknown> = {}) => ({
  key: "ArrowRight", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
  nativeEvent: { isComposing: false, keyCode: 39 }, ...override,
});
check("normal keyboard Arrow remains available",canNavigateTabKey(key()));
check("IME composing and keyCode229 never navigate",
  !canNavigateTabKey(key({nativeEvent:{isComposing:true,keyCode:39}})) &&
  !canNavigateTabKey(key({nativeEvent:{isComposing:false,keyCode:229}})));
check("Shift / Alt / Ctrl / Meta combinations leave tab selection unchanged",
  ["shiftKey","altKey","ctrlKey","metaKey"].every(flag => !canNavigateTabKey(key({[flag]:true}))));
check("Arrow wraps only inside tab list",tabNavigationTargetIndex("ArrowRight",2,3)===0 &&
  tabNavigationTargetIndex("ArrowLeft",0,3)===2);
check("Home and End jump to first and last",tabNavigationTargetIndex("Home",2,4)===0 &&
  tabNavigationTargetIndex("End",0,4)===3);
check("Other keys and invalid indices never navigate",tabNavigationTargetIndex("Delete",1,3)===null &&
  tabNavigationTargetIndex("ArrowRight",-1,3)===null && tabNavigationTargetIndex("ArrowLeft",0,0)===null);
check("Explicit Mcode reduced motion overrides OS BOTH ways",
  resolveTickerReducedMotion("true",false) && !resolveTickerReducedMotion("false",true));
check("System motion applies if preference absent or malformed",
  resolveTickerReducedMotion(null,true) && !resolveTickerReducedMotion(null,false) &&
  resolveTickerReducedMotion("unexpected",true));

const globals = globalThis as unknown as Record<string, unknown>;
const previous = { window: globals.window, document: globals.document, MutationObserver: globals.MutationObserver };
let attribute: string | null = null;
let mediaMatches = false;
let notifications = 0, observerDisconnected = false;
const mediaListeners = new Set<() => void>();
const mutationListener: { callback?: () => void } = {};
try {
  globals.window = {
    matchMedia: () => ({
      get matches() { return mediaMatches; },
      addEventListener: (_type: string, cb: () => void) => mediaListeners.add(cb),
      removeEventListener: (_type: string, cb: () => void) => mediaListeners.delete(cb),
    }),
  };
  globals.document = { documentElement: { getAttribute: () => attribute } };
  globals.MutationObserver = class {
    constructor(cb: () => void) { mutationListener.callback = cb; }
    observe() {}
    disconnect() { observerDisconnected = true; }
  };
  const unsubscribe = subscribeTickerMotion(() => { notifications++; });
  check("Motion listener tracks initial OS preference",tickerMotionSnapshot()===false && mediaListeners.size===1);
  mediaMatches = true;
  for (const callback of mediaListeners) callback();
  check("OS motion change triggers re-read without remount",notifications===1 && tickerMotionSnapshot()===true);
  attribute = "false";
  mutationListener.callback?.();
  check("Mcode override false activates motion even while OS reduces",
    notifications===2 && tickerMotionSnapshot()===false);
  attribute = "true";
  mutationListener.callback?.();
  mediaMatches = false;
  check("Mcode override true persists after OS toggles off",tickerMotionSnapshot()===true);
  unsubscribe();
  check("Unsubscribe removes OS listener and mutation observer",mediaListeners.size===0 && observerDisconnected);
} finally {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete globals[name];
    else globals[name] = value;
  }
}

console.log(`arc005-navigation-motion: ${passed}/${passed+failed}`);
if(failed) process.exitCode=1;
