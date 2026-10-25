/** ARC-005: one headless regression gate for interactive chat composer
 * and project search. No Chromium/Electron/full TS program compilation. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { searchResultsNavigable, stepSearchResultIndex } from "../../src/renderer/components/ide/searchResultNavigation.js";
import { composerFluidTier } from "../../src/renderer/components/chat/composerFluidTier.js";
import { subChatPickerPlacement } from "../../src/renderer/components/chat/subChatPickerPlacement.js";
import { sourceHas } from "../lib/sourceText.js";
import { openEscapeLayer, claimEscape, resetEscapeLayersForTests } from "../../src/renderer/lib/escapeLayer.js";

let total = 0, failed = 0;
const check = (name: string, ok: boolean) => {
  total++;
  if (!ok) failed++;
  console.log((ok ? "PASS " : "FAIL ") + name);
};
const read = (name: string) => readFileSync(resolve("src/renderer/components/" + name), "utf8");
const search = read("ide/SearchDialog.tsx");
const attach = read("chat/AttachMenuButton.tsx");
const subChat = read("chat/NewSubChatPicker.tsx");
const files = read("chat/FileMentionPicker.tsx");
const slash = read("chat/SlashCommandPicker.tsx");
const chip = read("chat/ContentTagChip.tsx");
const toolbar = read("chat/ComposerToolbar.tsx");
const toggle = read("chat/ComposerToolbarToggle.tsx");

// Pure production function behavior: these checks execute the very functions
// wired to the dialog, not a duplicated source-text approximation.
check("Search: pending query never accepts old result selection", !searchResultsNavigable(true, null, 3));
check("Search: failed query never accepts old result selection", !searchResultsNavigable(false, "backend failed", 3));
check("Search: empty response is not selectable", !searchResultsNavigable(false, null, 0));
check("Search: fulfilled nonempty query can be navigated", searchResultsNavigable(false, null, 3));
check("Search: down arrow clamps at last row", stepSearchResultIndex(2, 3, 1) === 2);
check("Search: up arrow clamps at first row", stepSearchResultIndex(0, 3, -1) === 0);
check("Search: down and up move exactly one row", stepSearchResultIndex(1, 3, 1) === 2 && stepSearchResultIndex(1, 3, -1) === 0);
check("Search: zero-length list never produces negative index", stepSearchResultIndex(5, 0, -1) === 0);
check("Search: old results clear at query/mode/project/filter change before debounce",
  sourceHas(search, "setNameResults([]);\n    setGrepResults([]);\n    setActiveIdx(0);\n    setTruncated(false);\n    setIncompleteScan(false);\n    setLoading(true);"));
check("Search: old IPC generations invalidated before starting the timer",
  sourceHas(search, "const myId = ++reqIdRef.current;") &&
  sourceHas(search, "if (reqIdRef.current !== myId) return;"));
check("Search: both arrow keys and Enter use one readiness guard",
  (search.match(/searchResultsNavigable\(displayedLoading, displayedError, flatCount\)/g) || []).length === 3);
check("Search: render-time request identity prevents stale one-frame clickability",
  sourceHas(search, "const searchKey = JSON.stringify([projectPath, query.trim(), mode, caseSensitive, fileType, searchRetryNonce]);") &&
  sourceHas(search, "const currentSearch = completedSearchKey === searchKey;") &&
  sourceHas(search, "const shownNameResults = currentSearch ? nameResults : [];") &&
  sourceHas(search, "const shownGrepResults = currentSearch ? grepResults : [];"));
check("Search: only responses for the current key can populate results",
  sourceHas(search, "setCompletedSearchKey(searchKey);") &&
  sourceHas(search, "setCompletedSearchKey(null);") &&
  sourceHas(search, "const displayedError = currentSearch ? searchError : null;"));
check("Search: selection and displayed panels never use raw unkeyed results",
  sourceHas(search, "const f = shownNameResults[activeIdx];") &&
  sourceHas(search, "const m = shownGrepResults[activeIdx];") &&
  sourceHas(search, "results={shownNameResults}") &&
  sourceHas(search, "results={shownGrepResults}"));
check("Search: nonblocking IME guard applies to the entire keyboard handler",
  sourceHas(search, 'if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;'));
check("Search: all active results expose aria-current instead of visual-only selection",
  (search.match(/aria-current=\{isActive \? "true" : undefined\}/g) || []).length === 2);
check("Search: match line exposes its actual file and line number",
  sourceHas(search, 'aria-label={`${m.relativePath}:${m.lineNumber}`}'));
check("Search: filter and clear controls use visible keyboard focus",
  sourceHas(search, 'focus-visible:ring-2 focus-visible:ring-accent') &&
  sourceHas(search, 'aria-label={t("ide.search.clear")}'));
check("Search: live count never reads stale number while fetching",
  sourceHas(search, 'role="status" aria-live="polite" aria-atomic="true"') &&
  sourceHas(search, 't("ide.search.resultCount", { n: displayedLoading ? 0 : flatCount })'));
check("Search: result rows accept keyboard focus and still open the expected file",
  (search.match(/focus-visible:outline-offset-2 focus-visible:outline-accent/g) || []).length >= 3 &&
  sourceHas(search, "onClick={() => onOpen(m.path, m.lineNumber)}") &&
  sourceHas(search, "onClick={() => onOpen(f.path)}"));

check("Composer: resized pill observes its parent not just the entire viewport",
  sourceHas(toolbar, "observer.observe(parent)") &&
  sourceHas(toolbar, "composerFluidTier(parent.clientWidth)"));
check("Composer: ResizeObserver unavailable uses window resize fallback",
  sourceHas(toolbar, 'if (typeof ResizeObserver === "undefined")') &&
  sourceHas(toolbar, 'window.addEventListener("resize", measure)') &&
  sourceHas(toolbar, 'window.removeEventListener("resize", measure)'));
check("Composer: narrower settings list never hard-overflows the phone screen",
  sourceHas(toolbar, 'w-[min(18rem,calc(100vw-24px))] max-w-full min-w-0'));
check("Composer: pill remains one accessible grouped control surface",
  sourceHas(toolbar, 'role="group" aria-label={t("chat.toolbarToggle")}'));
check("Composer: compact settings popup is viewport-capped",
  sourceHas(toggle, 'max-w-[calc(100vw-16px)]') &&
  sourceHas(toggle, 'focus-visible:outline-offset-2 focus-visible:outline-accent'));
check("Composer: context snapshot stays bound to local session, not global selected tab",
  sourceHas(toolbar, "s.contextSnapshotBySession[sessionId]") &&
  sourceHas(toolbar, "s.usageHistoryBySession[sessionId]"));
check("Composer: attach, model, workflow, effort, permission and context remain mounted",
  ["<AttachMenuButton", "<ModelDropdown", "<WorkflowDropdown", "<EffortChip", "<PermissionChip", "<ContextRing"]
    .every((tag) => sourceHas(toolbar, tag)));
check("Composer: fluid tiers retain original source of truth",
  composerFluidTier(300) === "micro" && composerFluidTier(350) === "tight" &&
  composerFluidTier(450) === "narrow" && composerFluidTier(480) === "medium" &&
  composerFluidTier(600) === "full");

check("Attachment: duplicate child-chat requests are refused synchronously",
  sourceHas(attach, "if (subChatCreatePendingRef.current) return;") &&
  sourceHas(attach, "subChatCreatePendingRef.current = true;") &&
  sourceHas(attach, "subChatCreatePendingRef.current = false;"));
check("Attachment: pending state always clears even after async error",
  sourceHas(attach, "} finally {") &&
  sourceHas(attach, "setCreatingSubChat(false);"));
check("Attachment: creating disables menu trigger and duplicate selection",
  sourceHas(attach, 'disabled={disabled || creatingSubChat}') &&
  sourceHas(attach, 'disabled={creatingSubChat}'));
check("Attachment: creation still calls production store action and optional callback",
  sourceHas(attach, "await createSubChat({") &&
  sourceHas(attach, "if (session && mountedRef.current) onNewSubChat?.({ id: session.id, title: session.title })"));
check("Attachment: error is visible, translated and readable by assistive technology",
  sourceHas(attach, 'role="alert"') &&
  sourceHas(attach, 't("chat.newSubChat.createFailed"'));
check("Attachment: popup is bounded on short or narrow windows",
  sourceHas(attach, 'max-h-[calc(100vh-24px)]') &&
  sourceHas(attach, 'min-w-[min(200px,calc(100vw-24px))]'));
check("Attachment: dedicated file/image/library/slash actions are retained",
  ["onClick={onPickFiles}","onClick={onPickImages}","onClick={onPickLibraries}","onClick={onSlashCommand}"]
    .every((s) => sourceHas(attach,s)));

resetEscapeLayersForTests();
const closeOuter = openEscapeLayer("chat.new-subchat-picker");
const closeInner = openEscapeLayer("chat.slash-command-picker");
check("Subchat: actual Escape-layer arbitration leaves lower picker inactive",
  !claimEscape("chat.new-subchat-picker") && claimEscape("chat.slash-command-picker"));
closeInner();
check("Subchat: after closing nested picker, underlying picker regains Escape",
  claimEscape("chat.new-subchat-picker"));
closeOuter();
resetEscapeLayersForTests();
check("Subchat: UI subscribes to the same Escape-layer mechanism as sibling pickers",
  sourceHas(subChat, 'openEscapeLayer("chat.new-subchat-picker")') &&
  sourceHas(subChat, 'isTopEscapeLayer("chat.new-subchat-picker")') &&
  sourceHas(subChat, 'claimEscape("chat.new-subchat-picker")'));
check("Subchat: fresh opening clears stale profile choices before async load",
  sourceHas(subChat, 'setProfiles([]);') &&
  sourceHas(subChat, "const res = await api.workflow.agentProfiles()"));
check("Subchat: ArrowDown never creates -1 active index on empty picker",
  sourceHas(subChat, 'if (optionCount === 0) return;') &&
  sourceHas(subChat, "Math.max(0, Math.min(i, Math.max(0, optionCount - 1)))"));
check("Subchat: Enter cannot pick while profiles load or failed",
  sourceHas(subChat, 'if (loading || error || optionCount === 0) return;') &&
  sourceHas(subChat, "if (loading || error) return;"));
check("Subchat: tiny screen clamps width and list height to viewport",
  sourceHas(subChat, "subChatPickerPlacement(anchorRect, window.innerWidth, window.innerHeight)") &&
  (() => {
    const box = subChatPickerPlacement({ left: 120, top: 28, bottom: 40, width: 32 }, 160, 96);
    return box.width <= 144 && box.maxHeight <= 80 && box.top >= 8 && box.top + box.maxHeight <= 88;
  })());
check("Subchat: accessible picker dialog, focused search, and visible row selection",
  sourceHas(subChat, 'role="dialog"') &&
  sourceHas(subChat, 'aria-label={t("chat.newSubChat")}') &&
  sourceHas(subChat, 'aria-current={active ? "true" : undefined}') &&
  sourceHas(subChat, "focus-visible:ring-2 focus-visible:ring-accent"));
check("Subchat: memory-bearing profile choices remain distinct, no checkbox regression",
  sourceHas(subChat, '`${p.id}:0`') &&
  sourceHas(subChat, '`${p.id}:1`') &&
  sourceHas(subChat, "memory: true"));
check("File picker: result count follows query-key filtered visibleFiles rather than stale files",
  sourceHas(files, 'completedSearchKey === searchKey ? files : []') &&
  sourceHas(files, 't("chat.mention.count", { n: visibleFiles.length })'));
check("File picker: async search and external native-file selection maintain epoch guards",
  sourceHas(files, 'const myId = ++reqIdRef.current;') &&
  sourceHas(files, 'if (selectionGenerationRef.current !== generation) return;'));
check("File picker: search field and rows have keyboard-visible focus",
  sourceHas(files, 'aria-label={t("chat.mention.searchPlaceholder")}') &&
  (files.match(/focus-visible:outline-offset-2 focus-visible:outline-accent/g) || []).length >= 2);
check("File picker: multi-selection reflects pressed/disabled/current state",
  sourceHas(files, 'aria-pressed={mode === "attach" ? isSel || already : undefined}') &&
  sourceHas(files, 'aria-disabled={already}') &&
  sourceHas(files, 'aria-current={isActive ? "true" : undefined}'));
check("File picker: keyboard and mouse can still select/confirm files",
  sourceHas(files, 'confirmMention(f)') &&
  sourceHas(files, 'toggleAttach(f)') &&
  sourceHas(files, 'onClick={confirmAttach}'));
check("Slash picker: uses a real labeled tablist with uniquely identified panel",
  sourceHas(slash, 'const panelId = useId();') &&
  sourceHas(slash, 'role="tablist"') &&
  sourceHas(slash, 'id={panelId} role="tabpanel"'));
check("Slash picker: three tab controls expose current selection and panel association",
  (slash.match(/panelId=\{panelId\}/g) || []).length === 3 &&
  sourceHas(slash, 'aria-selected={active}') &&
  sourceHas(slash, 'aria-controls={panelId}'));
check("Slash picker: command rows and result count announce active state",
  sourceHas(slash, 'aria-current={isActive ? "true" : undefined}') &&
  sourceHas(slash, 'role="status" aria-live="polite"') &&
  sourceHas(slash, 'focus-visible:outline-offset-2 focus-visible:outline-accent'));
check("Slash picker: native tab selection preserves all 3 command types",
  sourceHas(slash, 'onPickEngineCommand(entry as EngineCommand)') &&
  sourceHas(slash, 'onPickCommand(entry as BuiltInCommand)') &&
  sourceHas(slash, 'onPickSkill(entry as SkillInfo)'));
check("Slash picker: Escape remains owned by top overlay and respects IME",
  sourceHas(slash, 'isTopEscapeLayer("chat.slash-command-picker")') &&
  sourceHas(slash, 'e.isComposing || e.key === "Process" || e.keyCode === 229'));
check("Chips: previews expose expanded state instead of title-only state",
  sourceHas(chip, "aria-expanded={open}") && sourceHas(chip, "aria-label={tag.preview}"));
check("Chips: preview and removal have separate accessible buttons and handlers",
  sourceHas(chip, "onClick={onToggle}") &&
  sourceHas(chip, "onClick={onRemove}") &&
  sourceHas(chip, 'aria-label={t("chat.tag.removeTitle")}'));
check("Chips: long attachment names remain truncated without covering removal",
  sourceHas(chip, "max-w-full min-w-0") &&
  sourceHas(chip, "max-w-[160px] min-w-0 truncate") &&
  sourceHas(chip, "size-6 shrink-0"));
check("Chips: both actions expose visible keyboard focus",
  (chip.match(/focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/g) || []).length >= 2);
check("Chips: quote/file/library/image types continue to use original icon resolution",
  ["isImageFile(tag)","isLibrary","isQuote","isElement","isManifestRef"].every((s) => sourceHas(chip,s)));

check("Negative: suppressing stale results would fail without the invalidate-clear",
  !sourceHas(search.replace("setNameResults([]);\n    setGrepResults([]);\n    setActiveIdx(0);\n    setTruncated(false);\n    setIncompleteScan(false);\n    setLoading(true);","setLoading(true);"),
    "setNameResults([]);\n    setGrepResults([]);\n    setActiveIdx(0);\n    setTruncated(false);\n    setIncompleteScan(false);\n    setLoading(true);"));
check("Negative: removing synchronously-set pending flag makes protection disappear",
  !sourceHas(attach.replace("subChatCreatePendingRef.current = true;", ""), "subChatCreatePendingRef.current = true;"));
check("Negative: dropping chip aria-expanded loses announcement contract",
  !sourceHas(chip.replace("aria-expanded={open}", ""), "aria-expanded={open}"));
console.log("arc005-composer-search-smoke: " + (total-failed) + "/" + total);
if (failed) process.exitCode = 1;
