/** ARC-006 Gate B: 损坏的引擎身份/凭据文件不能静默生成新密钥。
 * 所有数据仅在虚构临时目录；不会加载 Electron、用户库或真实 Node-RED。
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { spawn } from "node:child_process";
import { createEngineLaunchSpec, NODE_RED_MIN_NODE } from "@main/workflowEngines/runtimeSupervisor.js";
// 真双 OS 进程竞争首次创建：子进程重用本套 bundle，但不运行父进程断言。
if (process.argv[2] === "--mc058-race-child") {
  const dataDir = process.argv[3];
  if (!dataDir) throw new Error("race data dir missing");
  const spec = createEngineLaunchSpec({
    engineId: "node-red", dataDir, entryFile: join(dataDir, "bootstrap.cjs"),
    installPackage: "node-red", minNodeVersion: NODE_RED_MIN_NODE,
    secretFile: dataDir, adminTokenFile: join(dataDir, ".engine-admin-token"),
    environment: { execPath: process.execPath, nodeVersion: "24.0.0", isElectron: false, getAppPath: () => null },
  });
  process.stdout.write(JSON.stringify({
    secret: spec.env?.NODE_RED_CREDENTIAL_SECRET,
    token: spec.probeIdentity?.adminToken,
  }));
  process.exit(0);
}
let checks = 0;
let failures = 0;
function check(message: string, condition: boolean, details?: unknown): void {
  checks++;
  if (condition) console.log("  ok   " + message);
  else { failures++; console.log("  FAIL " + message + (details === undefined ? "" : " — " + JSON.stringify(details))); }
}
const root = mkdtempSync(join(tmpdir(), "mcode-engine-secret-integrity-"));
try {
  mkdirSync(join(root, "node_modules", "node-red"), { recursive: true });
  writeFileSync(join(root, "node_modules", "node-red", "package.json"), '{"name":"node-red","version":"5.0.8"}');
  const entry = join(root, "bootstrap.cjs");
  writeFileSync(entry, "// virtual bootstrap, never executed");
  const env = { execPath: process.execPath, nodeVersion: "24.0.0", isElectron: false, getAppPath: () => null };
  const make = (adminTokenFile?: string): ReturnType<typeof createEngineLaunchSpec> => createEngineLaunchSpec({
    engineId: "node-red", dataDir: root, entryFile: entry, installPackage: "node-red",
    minNodeVersion: NODE_RED_MIN_NODE, secretFile: root, environment: env,
    ...(adminTokenFile ? { adminTokenFile } : {}),
  });
  const secretPath = join(root, ".engine-secret");
  const tokenPath = join(root, ".engine-admin-token");
  // MC-058: audit the *actual* publish implementation; old wx on final path
  // exposes a zero-length identity between directory entry creation and write.
  // Real four-process contention below checks the final observable bytes.
  const runtimeSource = readFileSync("src/main/workflowEngines/runtimeSupervisor.ts", "utf8");
  check("★ 新密钥应在私有文件写完后才以原子不覆盖方式发布到最终路径",
    runtimeSource.includes("linkSync(stagingPath, path)") &&
    runtimeSource.includes("fsyncSync(stagingFd)") &&
    !runtimeSource.includes('writeFileSync(path, value, { encoding: "utf8", mode: 0o600, flag: "wx" })'));
  const fresh = make(tokenPath);
  check("首次安装在隔离数据根生成非空凭据", /^[0-9a-f]{64}$/.test(fresh.env?.NODE_RED_CREDENTIAL_SECRET ?? ""));
  check("首次安装在隔离数据根生成非空令牌", /^[0-9a-f]{64}$/.test(fresh.probeIdentity?.adminToken ?? ""));
  check("★ 新密钥发布后无暂存秘钥遗留，最终普通文件链接数为一",
    !readdirSync(root).some((name) => name.includes(".engine-secret.stage-") || name.includes(".engine-admin-token.stage-"))
    && lstatSync(secretPath).nlink === 1
    && lstatSync(tokenPath).nlink === 1);
  const oldSecret = readFileSync(secretPath, "utf8");
  const oldToken = readFileSync(tokenPath, "utf8");
  const reused = make(tokenPath);
  check("重启仍用原有凭据和身份", reused.env?.NODE_RED_CREDENTIAL_SECRET === oldSecret && reused.probeIdentity?.adminToken === oldToken);

  // 已存在但内容为空 = 损坏，不是首次安装。不能让新 secret 替换旧身份、失去解密能力。
  writeFileSync(secretPath, "");
  let secretError = "";
  try { make(tokenPath); } catch (err) { secretError = err instanceof Error ? err.message : String(err); }
  check("已存在的空凭据文件必须阻止启动", secretError.length > 0, { threw: !!secretError });
  check("拒绝启动不得篡改空凭据文件", existsSync(secretPath) && readFileSync(secretPath, "utf8") === "");

  // 保持凭据有效，只破坏单独的控制面令牌。
  writeFileSync(secretPath, oldSecret);
  writeFileSync(tokenPath, " \n");
  let tokenError = "";
  try { make(tokenPath); } catch (err) { tokenError = err instanceof Error ? err.message : String(err); }
  check("已存在的空白控制面令牌必须阻止启动", tokenError.length > 0, { threw: !!tokenError });
  check("拒绝启动不得覆写空白控制面令牌", readFileSync(tokenPath, "utf8") === " \n");
  check("异常令牌不得改变健康凭据", readFileSync(secretPath, "utf8") === oldSecret);

  // 真实双进程 E1/U1：四个独立 Node OS 进程同时首次创建同一份凭据。
  // `wx` 的 EEXIST 赢家只读重用，任何一方不得覆盖或看到不同的 token。
  const raceDir = join(root, "race");
  mkdirSync(join(raceDir, "node_modules", "node-red"), { recursive: true });
  writeFileSync(join(raceDir, "node_modules", "node-red", "package.json"), '{"name":"node-red","version":"5.0.8"}');
  writeFileSync(join(raceDir, "bootstrap.cjs"), "// isolated race fixture");
  const raceChild = (): Promise<{ code: number | null; stdout: string; stderr: string }> => new Promise((resolve) => {
    const child = spawn(process.execPath, [process.argv[1]!, "--mc058-race-child", raceDir], {
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: String(error) }));
  });
  const races = await Promise.all(Array.from({ length: 4 }, raceChild));
  check("★ 四个真实 OS 进程同时首次初始化均成功", races.every((p) => p.code === 0), races);
  const valid = races.filter((p) => p.code === 0).map((p) => {
    try { return JSON.parse(p.stdout) as { secret: string; token: string }; } catch { return null; }
  });
  check("★ 跨进程 secret/token 都唯一一致，没有覆盖另一进程的新值",
    valid.length === 4 && valid.every((v) => v !== null && v.secret === valid[0]?.secret && v.token === valid[0]?.token),
    valid);
  check("★ 四进程启动结束后凭据暂存文件无遗留、最终路径是独立普通文件",
    !readdirSync(raceDir).some((name) => name.includes(".engine-secret.stage-") || name.includes(".engine-admin-token.stage-"))
    && lstatSync(join(raceDir, ".engine-secret")).nlink === 1
    && lstatSync(join(raceDir, ".engine-admin-token")).nlink === 1);
  check("★ 磁盘凭据等于所有进程实际使用的身份",
    valid.length === 4 && valid[0] !== null &&
      readFileSync(join(raceDir, ".engine-secret"), "utf8") === valid[0]?.secret &&
      readFileSync(join(raceDir, ".engine-admin-token"), "utf8") === valid[0]?.token);

  // EISDIR 等非 ENOENT 读取故障：不能被归类为首次安装、绝不改动异常对象。
  const dirRoot = join(root, "read-error");
  mkdirSync(join(dirRoot, "node_modules", "node-red"), { recursive: true });
  writeFileSync(join(dirRoot, "node_modules", "node-red", "package.json"), '{"name":"node-red","version":"5.0.8"}');
  writeFileSync(join(dirRoot, "bootstrap.cjs"), "// isolated fixture");
  mkdirSync(join(dirRoot, ".engine-secret"));
  let errText = "";
  try {
    createEngineLaunchSpec({
      engineId: "node-red", dataDir: dirRoot, entryFile: join(dirRoot, "bootstrap.cjs"),
      installPackage: "node-red", minNodeVersion: NODE_RED_MIN_NODE, secretFile: dirRoot,
      environment: env,
    });
  } catch (err) { errText = String(err); }
  check("★ 凭据路径是目录（非 ENOENT）时拒启，不重新造密钥",
    errText.length > 0 && !existsSync(join(dirRoot, ".engine-admin-token")), errText);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`engine-secret-integrity-smoke: ${checks - failures}/${checks} 通过`);
if (failures > 0) process.exitCode = 1;
