/** Pure path-guard regression: no real database, filesystem reads or Electron. */
import { join, parse, resolve } from "node:path";
import { pathWithin, findContainingProject, findContainingWorkspaceRoot } from "@main/lib/pathGuard.js";
import { projectPaths, worktreeRoots } from "./stubs.js";

let checks = 0;
let failures = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  checks++;
  if (Object.is(actual, expected)) console.log(`ok ${name}`);
  else { failures++; console.error(`FAIL ${name}: ${JSON.stringify({ actual, expected })}`); }
}
const root = parse(resolve(".")).root;
const project = join(root, "mcode-guard-project");
const child = join(project, "src", "index.ts");
check("filesystem root contains child", pathWithin(root, child), true);
check("filesystem root equals itself", pathWithin(root, root), true);
check("ordinary project contains child", pathWithin(project, child), true);
check("ordinary project equals itself", pathWithin(project, project), true);
check("trailing separator", pathWithin(join(project, "/"), child), true);
check("similar prefix sibling rejected", pathWithin(project, project + "-other/file.ts"), false);
check("parent traversal rejected", pathWithin(project, join(project, "..", "outside.ts")), false);
check("normalized in-root traversal allowed", pathWithin(project, join(project, "src", "..", "index.ts")), true);
if (process.platform === "win32") {
  check("drive root child", pathWithin("D:\\", "D:\\work\\file.ts"), true);
  check("different drive rejected", pathWithin("D:\\", "E:\\work\\file.ts"), false);
  check("drive case normalized", pathWithin("D:\\", "d:\\work\\file.ts"), true);
  check("UNC share child", pathWithin("\\\\server\\share\\", "\\\\server\\share\\dir\\file.ts"), true);
  check("UNC sibling share rejected", pathWithin("\\\\server\\share\\", "\\\\server\\share-other\\file.ts"), false);
} else {
  check("POSIX root child", pathWithin("/", "/tmp/mcode/file.ts"), true);
}
projectPaths.push(root);
check("registered filesystem-root project found", findContainingProject(child), root);
projectPaths.length = 0;
check("unregistered root not implicitly allowed", findContainingProject(child), null);
worktreeRoots.push(root);
check("registered filesystem-root workspace found", findContainingWorkspaceRoot(child), root);
worktreeRoots.length = 0;
check("unregistered workspace rejected", findContainingWorkspaceRoot(child), null);
console.log(`${checks - failures}/${checks} passed`);
if (failures) process.exitCode = 1;
