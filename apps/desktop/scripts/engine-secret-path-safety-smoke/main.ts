/** MC-058: engine identity file cannot silently alias another file via hard/symbolic links.
 * All bytes under mkdtemp: never launch Node-RED or read actual credentials.
 */
import fs, { existsSync, lstatSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngineLaunchSpec, NODE_RED_MIN_NODE } from "@main/workflowEngines/runtimeSupervisor.js";

let checks = 0, fails = 0, skipped = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  checks++;
  if (!ok) fails++;
  console.log((ok ? "  ok   " : "  FAIL ") + label + (ok ? "" : " " + String(detail)));
}
const root = mkdtempSync(join(tmpdir(), "mcode-secret-link-safety-"));
const environment = { execPath: process.execPath, nodeVersion: "24.0.0", isElectron: false, getAppPath: () => null };
function fixture(name: string) {
  const dir = join(root, name);
  mkdirSync(join(dir, "node_modules", "node-red"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "node-red", "package.json"), '{"name":"node-red","version":"5.0.8"}');
  writeFileSync(join(dir, "bootstrap.cjs"), "// virtual fixture never executed");
  return {
    dir,
    make: () => createEngineLaunchSpec({
      engineId: "node-red", dataDir: dir, entryFile: join(dir, "bootstrap.cjs"),
      installPackage: "node-red", minNodeVersion: NODE_RED_MIN_NODE,
      secretFile: dir, adminTokenFile: join(dir, ".engine-admin-token"), environment,
    }),
  };
}
function poison(kind: "secret" | "token", link: "hard" | "symbolic"): void {
  const suffix = kind === "secret" ? ".engine-secret" : ".engine-admin-token";
  const foreign = join(root, "foreign-" + kind + "-" + link);
  const foreignBytes = (kind === "secret" ? "a" : "b").repeat(64);
  writeFileSync(foreign, foreignBytes);
  const f = fixture("poison-" + kind + "-" + link);
  const identity = join(f.dir, suffix);
  if (link === "hard") {
    linkSync(foreign, identity); // Windows unprivileged NTFS hard link
  } else {
    try {
      symlinkSync(foreign, identity, "file");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
        skipped++;
        console.log("  SKIP Windows privilege does not allow symbolic link fixture: " + suffix);
        return;
      }
      throw error;
    }
  }
  let error = "";
  try { f.make(); } catch (err) { error = String(err); }
  check("★ MC-058 " + kind + " 的" + link + "link 不得作为可信引擎身份", !!error, error);
  check("★ 外部文件字节不变、链接仍未被删除(" + kind + "/" + link + ")",
    readFileSync(foreign, "utf8") === foreignBytes &&
    existsSync(identity) &&
    (link === "hard" ? lstatSync(identity).nlink >= 2 : lstatSync(identity).isSymbolicLink()),
  );
}
try {
  const normal = fixture("healthy");
  const first = normal.make();
  const second = normal.make();
  check("正常首次创建与重启身份一致，允许普通唯一文件",
    !!first.env?.NODE_RED_CREDENTIAL_SECRET &&
    first.env.NODE_RED_CREDENTIAL_SECRET === second.env?.NODE_RED_CREDENTIAL_SECRET &&
    first.probeIdentity?.adminToken === second.probeIdentity?.adminToken);
  // 已有身份成功 lstat 后，open 发生短暂 ENOENT。旧实现会误当首次安装，
  // 创建临时密钥并悄悄继续。隔离的虚构文件未删除、未触碰真实用户身份。
  const raced = fixture("raced-open-after-lstat");
  raced.make();
  const identityPath = join(raced.dir, ".engine-secret");
  const firstBytes = readFileSync(identityPath, "utf8");
  const originalOpen = fs.openSync;
  let racedOpen = false;
  fs.openSync = ((file: string, flags: string | number, mode?: number) => {
    if (String(file) === identityPath && !racedOpen) {
      racedOpen = true;
      const err = new Error("MC058_TEST_TRANSIENT_ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    return originalOpen(file, flags as number, mode);
  }) as typeof fs.openSync;
  syncBuiltinESMExports();
  let rejected = false;
  try { raced.make(); } catch { rejected = true; }
  finally {
    fs.openSync = originalOpen;
    syncBuiltinESMExports();
  }
  check("★ 旧文件 lstat 成功后 open ENOENT 必拒绝，不能误当首次安装",
    racedOpen && rejected);
  check("★ 读取竞态不会改变已有真实虚构身份字节",
    readFileSync(identityPath, "utf8") === firstBytes);
  poison("secret", "hard");
  poison("token", "hard");
  poison("secret", "symbolic");
  poison("token", "symbolic");
} finally { rmSync(root, { recursive: true, force: true }); }
console.log("engine-secret-path-safety-smoke: " + (checks - fails) + "/" + checks +
  " PASS; symlink unsupported/skipped=" + skipped);
if (fails) process.exitCode = 1;
