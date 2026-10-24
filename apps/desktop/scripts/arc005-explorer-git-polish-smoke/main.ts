/** ARC-005: Git / file workspace coherence & keyboard navigation.
 * Pure production helper behavior plus source wiring; no Electron or Git writes. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GitScanGeneration } from "../../src/renderer/components/ide/gitScanGeneration.js";
import { gitScanMatchesProject, nextGitTabIndex } from "../../src/renderer/components/ide/gitPanelUiRules.js";
import { sourceHas } from "../lib/sourceText.js";
import { isPathWithin } from "../../src/renderer/lib/path.js";

const read = (s: string) => readFileSync(resolve("src/renderer/components/ide/"+s), "utf8");
const git = read("GitPanel.tsx");
const files = read("FilesPanel.tsx");
const tree = read("FileTree.tsx");
let total = 0, failed = 0;
function ck(label: string, ok: boolean) {
  total++;
  if (!ok) failed++;
  console.log((ok ? "PASS " : "FAIL ") + label);
}

ck("Git: path-scoped scan hides repositories belonging to other project", !gitScanMatchesProject("C:/repoA", "C:/repoB"));
ck("Git: exact project scan may render only for matching root", gitScanMatchesProject("C:/repoA", "C:/repoA"));
ck("Git: missing project/scan does not render stale repos", !gitScanMatchesProject(null,"C:/repoA") && !gitScanMatchesProject("C:/repoA",null));
ck("Git: tab navigation wraps right", nextGitTabIndex("ArrowRight",2,3)===0);
ck("Git: tab navigation wraps left", nextGitTabIndex("ArrowLeft",0,3)===2);
ck("Git: home/end jump to boundary", nextGitTabIndex("Home",1,3)===0 && nextGitTabIndex("End",1,3)===2);
ck("Git: nonnavigation keyboard shortcuts stay untouched", nextGitTabIndex("Enter",1,3)===null && nextGitTabIndex("Escape",1,3)===null);
ck("Git: empty/invalid list does not generate invalid index", nextGitTabIndex("ArrowRight",0,0)===null && nextGitTabIndex("ArrowLeft",-1,3)===null);
const epoch = new GitScanGeneration();
const old = epoch.next(); const now = epoch.next();
ck("Git: earlier request cannot overwrite later result", !epoch.isCurrent(old) && epoch.isCurrent(now));
epoch.invalidate();
ck("Git: close/unmount invalidation blocks all outstanding results", !epoch.isCurrent(now));

ck("Git: render guard checks latest scanned path before showing repo UI",
  sourceHas(git, "gitScanMatchesProject(scannedPath, projectPath)") &&
  sourceHas(git, "const [scannedPath, setScannedPath]"));
ck("Git: render old results never starts just because loading from previous repo is false",
  sourceHas(git, "if (loading || !gitScanMatchesProject(scannedPath, projectPath))"));
ck("Git: stale search response is gated by scanGeneration",
  (git.match(/scanGeneration\.current\.isCurrent\(seq\)/g)||[]).length >= 3);
ck("Git: no project invalidates outstanding scan and clears the old view",
  sourceHas(git, "scanGeneration.current.invalidate()") &&
  sourceHas(git, "setRepos([]);") &&
  sourceHas(git, "setScannedPath(null);"));
ck("Git: scan errors present a dedicated accessible error, not fake empty repository",
  sourceHas(git, 'setScanError(err instanceof Error ? err.message : String(err))') &&
  sourceHas(git, 'if (scanError)') &&
  sourceHas(git, 'role="alert"') &&
  sourceHas(git, 't("common.error")'));
ck("Git: error offers real retry using current project path",
  sourceHas(git, 'onClick={() => void scan(projectPath)}') &&
  sourceHas(git, 't("ide.git.rescan")'));
ck("Git: three tab roles and selected state are available for keyboard/screenreader",
  sourceHas(git, 'role="tablist"') &&
  sourceHas(git, 'role="tab"') &&
  sourceHas(git, 'aria-controls={panelId}') &&
  sourceHas(git, 'id={tabPanelId} role="tabpanel"') &&
  sourceHas(git, 'aria-selected={active}') &&
  (git.match(/<SubTabButton/g)||[]).length === 3);
ck("Git: tab arrow handler controls exactly these 3 tab buttons",
  sourceHas(git, 'button[data-git-subtab]') &&
  sourceHas(git, "nextGitTabIndex(e.key, buttons.indexOf(current), buttons.length)") &&
  sourceHas(git, "buttons[next]?.focus();") && sourceHas(git, "buttons[next]?.click();"));
ck("Git: tab and refresh buttons reveal keyboard focus",
  (git.match(/focus-visible:outline-offset-2 focus-visible:outline-accent/g)||[]).length >= 3);
ck("Git: view changes do not alter repo status/commit/history callbacks",
  sourceHas(git, "<GitRepoCard key={repo.path} repo={repo} />") &&
  sourceHas(git, "<GitHistoryView repos={repos} />") &&
  sourceHas(git, "<WorktreeManagerPanel repos={repos} />"));

ck("Explorer: follows worktree actual path and displays its own folder name",
  sourceHas(files, "const projectPath = envPath ?? activeProject?.path ?? null;") &&
  sourceHas(files, "envPath && envPath !== activeProject?.path") &&
  sourceHas(files, "basename(envPath)"));
ck("Explorer: project sibling /proj/app-old never counts as /proj/app",
  !isPathWithin("/proj/app","/proj/app-old/src/file.ts"));
ck("Explorer: Windows roots compare separators and drive-letter case consistently",
  isPathWithin(String.raw`D:\Projects\App`,"d:/projects/app/src/file.ts") &&
  !isPathWithin("D:/projects/app","d:/projects/app2/file.ts"));
ck("Explorer: ancestor reveal only traverses current project path segments",
  sourceHas(tree,"while (dir && isPathWithin(projectPath, dir) && !isPathWithin(dir, projectPath))"));
ck("Explorer: both active-file follow and explicit reveal reject other roots",
  sourceHas(tree,"!activeFile || !isPathWithin(projectPath, activeFile)") &&
  sourceHas(tree,"!treeReveal || !isPathWithin(projectPath, treeReveal.filePath)"));
ck("Explorer: compact folder active-file indicator also checks path segments",
  sourceHas(tree, "isPathWithin(endPath, activeFile)") &&
  !sourceHas(tree, 'activeFile.startsWith(endPath + "/")'));
ck("Explorer: tree refresh does not reset expansion store or change opener",
  sourceHas(files, "setRefreshNonce((n) => n + 1)") &&
  sourceHas(files, "ideExpandedDirsByProject")===false &&
  sourceHas(files, 'key={`${projectPath}:${refreshNonce}`}'));
ck("Explorer: file and folder controls provide minimum hit area and focus ring",
  (tree.match(/min-h-7 w-full items-center/g)||[]).length >= 2 &&
  (tree.match(/focus-visible:outline-offset-\[-2px\] focus-visible:outline-accent/g)||[]).length >= 2);
ck("Explorer: folder disclosure tells screenreader its actual open state",
  sourceHas(tree, "aria-expanded={isOpen}") && sourceHas(tree, "aria-label={label}"));
ck("Explorer: opened file is marked current and retains file drag MIME",
  sourceHas(tree, 'aria-current={active ? "true" : undefined}') &&
  sourceHas(tree, "e.dataTransfer.setData(FILE_DRAG_MIME, path)"));
ck("Explorer: refresh and search icons have accessible names and visible focus",
  sourceHas(files, 'aria-label={t("ide.files.refreshDir")}') &&
  sourceHas(files, 'aria-label={t("ide.files.searchFiles")}') &&
  (files.match(/focus-visible:outline-offset-2 focus-visible:outline-accent/g)||[]).length >= 2);
ck("Explorer: header and tree use actual session environment without remounting other UI",
  sourceHas(files, '<ModuleSurface key={projectPath} projectPath={projectPath}>') &&
  sourceHas(files, '<FileTree key={`${projectPath}:${refreshNonce}`} projectPath={projectPath} />'));

ck("Negative: removing repo scope check would not satisfy Git render contract",
  !sourceHas(git.replace("gitScanMatchesProject(scannedPath, projectPath)", "true"),
    "gitScanMatchesProject(scannedPath, projectPath)"));
ck("Negative: removing file disclosure aria makes the explorer contract fail",
  !sourceHas(tree.replace("aria-expanded={isOpen}",""),"aria-expanded={isOpen}"));
console.log("arc005-explorer-git-polish-smoke: "+(total-failed)+"/"+total);
if(failed) process.exitCode=1;
