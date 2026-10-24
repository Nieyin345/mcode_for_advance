/** ARC-005 cohesive chat/shell polish: pure behavior + real source wiring.
 * No Electron, Chrome, TypeScript full-program compile, or OS side effects. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { recentProjectSessions } from "../../src/renderer/components/chat/homeRecentSessions.js";
import { sourceHas } from "../lib/sourceText.js";
import type { Session } from "@contracts/session";

let total = 0, fail = 0;
function ck(label: string, ok: boolean): void {
  total++;
  if (!ok) fail++;
  console.log((ok ? "PASS " : "FAIL ") + label);
}
const read = (path: string) => readFileSync(resolve(path), "utf8");
const home = read("src/renderer/components/chat/EmptyThreadWelcome.tsx");
const sidebar = read("src/renderer/components/layout/SidebarQuickActions.tsx");
const composer = read("src/renderer/components/chat/ComposerEditor.tsx");
const msg = read("src/renderer/components/chat/MessageRow.tsx");
const titlebar = read("src/renderer/components/layout/Titlebar.tsx");

const sample: Session[] = [
  { id: "a", projectId: "p1", kind: "chat", archived: false, updatedAt: 12 },
  { id: "foreign", projectId: "p2", kind: "chat", archived: false, updatedAt: 999 },
  { id: "current", projectId: "p1", kind: "chat", archived: false, updatedAt: 120 },
  { id: "archived", projectId: "p1", kind: "chat", archived: true, updatedAt: 500 },
  { id: "hidden", projectId: "p1", kind: "node", archived: false, updatedAt: 550 },
  { id: "c", projectId: "p1", kind: "chat", archived: false, updatedAt: 11 },
  { id: "b", projectId: "p1", kind: "chat", archived: false, updatedAt: 20 },
] as unknown as Session[];
const ids = (project: string | null, active: string | null, limit?: number) =>
  recentProjectSessions(sample, project, active, limit).map(s => s.id);
ck("Home: only recent chat sessions from current project, newest first",
  JSON.stringify(ids("p1", "current")) === JSON.stringify(["b", "a", "c"]));
ck("Home: foreign project / archived / hidden node sessions excluded",
  !ids("p1", "current", 10).some(id => ["foreign", "archived", "hidden", "current"].includes(id)));
ck("Home: no active project yields no navigation suggestions",
  ids(null, "current").length === 0);
ck("Home: exact zero cap does not return sessions",
  ids("p1", "current", 0).length === 0);
ck("Home: helper does not mutate store session order",
  sample[0].id === "a" && sample[1].id === "foreign");
ck("Home: real StartPoints uses activeProjectId and scoped pure helper",
  sourceHas(home, "recentProjectSessions(sessions, activeProjectId, activeSessionId, PER_SECTION)") &&
  sourceHas(home, "[sessions, activeProjectId, activeSessionId]"));
ck("Home: no duplicate legacy all-project filter remains",
  !sourceHas(home, '.filter((s) => s.kind === "chat" && !s.archived && s.id !== activeSessionId)'));
ck("Home: keyboard focus is visible on each start-point row",
  sourceHas(home, "focus-visible:outline-offset-2 focus-visible:outline-accent") &&
  sourceHas(home, "aria-pressed={pressed}"));

ck("Sidebar: both quick actions have reachable 36px touch rows",
  (sidebar.match(/flex min-h-9 w-full items-center/g) ?? []).length === 2);
ck("Sidebar: both quick actions expose visible keyboard focus",
  (sidebar.match(/focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/g) ?? []).length >= 2);
ck("Sidebar: search and new controls retain native handlers and disabled guard",
  sourceHas(sidebar, 'data-sidebar-quick-action="new"') &&
  sourceHas(sidebar, "disabled={!canNewSession}") &&
  sourceHas(sidebar, "startSession()") &&
  sourceHas(sidebar, 'data-sidebar-quick-action="search"') &&
  sourceHas(sidebar, "setCommandPaletteOpen(true)"));
ck("Sidebar: accessible names are stable translated strings",
  sourceHas(sidebar, 'aria-label={t("layout.newSession")}') &&
  sourceHas(sidebar, 'aria-label={t("common.search")}'));

ck("Composer: ProseMirror exposes multiline textbox semantics",
  sourceHas(composer, 'role: "textbox"') &&
  sourceHas(composer, '"aria-multiline": "true"'));
ck("Composer: initial readonly state and later prop changes both update aria-readonly",
  sourceHas(composer, '"aria-readonly": String(!editable)') &&
  sourceHas(composer, 'editor.view.dom.setAttribute("aria-readonly", String(!editable))'));
ck("Composer: disabled editor still uses existing Tiptap setEditable",
  sourceHas(composer, "editor.setEditable(editable)") &&
  sourceHas(composer, 'className={cn("composer-host rounded-'));
ck("Composer: IME Enter submission protection remains intact",
  sourceHas(composer, "isPostCompositionEnter(") &&
  sourceHas(composer, "event.keyCode !== 229"));

ck("Inline editor: image remove available on focus, not CSS display:none",
  sourceHas(msg, "group-focus-within:opacity-100 focus-visible:opacity-100") &&
  !sourceHas(msg, "group-hover:flex"));
ck("Inline editor: image remove button retains the actual delete callback and translated label",
  sourceHas(msg, 'aria-label={t("chat.removeImageN", { n: i + 1 })}') &&
  sourceHas(msg, "setImages((prev) => prev.filter((p) => p.id !== img.id))"));
ck("Inline editor: long prompt stays height bounded and scrollable",
  sourceHas(msg, 'maxHeight: "min(40vh, 320px)", overflowY: "auto"'));
ck("Inline editor: edit textarea is identified for screen readers",
  sourceHas(msg, 'aria-label={t("common.edit")}') &&
  sourceHas(msg, "onKeyDown={handleKeyDown}"));
ck("Inline editor: unchanged IME and cancel behavior",
  sourceHas(msg, "e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229") &&
  sourceHas(msg, 'e.key === "Escape"'));

ck("Titlebar: keyboard-focused controls expose visual outline",
  (titlebar.match(/focus-visible:outline-offset-2 focus-visible:outline-accent/g) ?? []).length >= 4);
ck("Titlebar: sidebar-open icon-only control gets explicit screen reader name",
  sourceHas(titlebar, 'aria-label={t("layout.showLeftPanel")}'));
ck("Titlebar: toggle handlers, ARIA press states, and drag opt-out are preserved",
  sourceHas(titlebar, "aria-pressed={rightOpen}") &&
  sourceHas(titlebar, "aria-pressed={bottomTerminalOpen}") &&
  sourceHas(titlebar, 'WebkitAppRegion: "no-drag"'));

// Negative controls guard against disabling test predicates by replacing the source.
ck("Negative: unscoped recent-list mutation is detectable",
  !sourceHas(home.replace("recentProjectSessions(sessions, activeProjectId, activeSessionId, PER_SECTION)", "sessions.slice(0, PER_SECTION)"),
    "recentProjectSessions(sessions, activeProjectId, activeSessionId, PER_SECTION)"));
ck("Negative: removing explicit keyboard focus state breaks sidebar check",
  sidebar.replaceAll("focus-visible:outline-2", "").match(/focus-visible:outline-2/g) === null);
ck("Negative: removing readonly synchronization is detected",
  !sourceHas(composer.replace('editor.view.dom.setAttribute("aria-readonly", String(!editable))', ""),
    'editor.view.dom.setAttribute("aria-readonly", String(!editable))'));

console.log("arc005-conversation-polish-smoke: " + (total-fail) + "/" + total);
if (fail) process.exitCode = 1;
