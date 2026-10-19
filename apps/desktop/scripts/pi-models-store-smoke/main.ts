/**
 * `lib/piModelsStore.ts` —— `~/.pi/agent/models.json` 的读写。
 *
 * 这个文件是**用户手改的**(Pi 的文档就这么教)。钉住三件事:
 *  1. UTF-8 BOM(记事本 / PowerShell 5.1 写的)照常读,不算写坏;
 *  2. 读不出来的文件,列表侧退化成空,但**保存/删除拒绝**,盘上内容一个字节不动
 *     —— 从前会把它当空文件,拿 Mcode 这一条盖掉整份,手配的其它 provider 全没了;
 *  3. 正常保存保留手写的其它 provider 与未知字段,写完不留临时文件。
 *
 * HOME / USERPROFILE 由 run.sh 指到临时目录,绝不碰真的 ~/.pi。
 */
import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { acquireOsFileLease } from "@main/lib/osFileLease.js";
import { join } from "node:path";
import { PiModelsStore } from "@main/lib/piModelsStore.js";

let checks = 0;
let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  checks++;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

const home = homedir();
if (!process.env.MCODE_SMOKE_HOME || home !== process.env.MCODE_SMOKE_HOME) {
  throw new Error(`homedir() 没有指到临时目录(${home}),拒绝运行`);
}
const dir = join(home, ".pi", "agent");
const file = join(dir, "models.json");
mkdirSync(dir, { recursive: true });

const handWritten = {
  providers: {
    mine: { baseUrl: "http://localhost:1234/v1", api: "openai-completions", models: [{ id: "m1", cost: { input: 1 } }] },
  },
  somethingElse: true,
};
const cfg = { baseUrl: "https://example.invalid/v1", api: "openai-completions", models: [{ id: "x1" }] };
// 真 OS lock 文件仅位于本 smoke 的隔离 HOME 内。
async function rejects(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

console.log("BOM");
writeFileSync(file, "\uFEFF" + JSON.stringify(handWritten), "utf-8");
const listed = await PiModelsStore.listPublic();
check("带 BOM 的文件照常列出手写的 provider", Object.keys(listed).join(",") === "mine", listed);
await PiModelsStore.saveProvider("mcode", cfg as never, "sk-test");
const afterSave = JSON.parse(readFileSync(file, "utf-8")) as typeof handWritten & { providers: Record<string, unknown> };
check("保存后手写的 provider 还在", "mine" in afterSave.providers, afterSave);
check("保存后新 provider 在", "mcode" in afterSave.providers, afterSave);
check("未知顶层字段保留", afterSave.somethingElse === true, afterSave);
check("apiKey 不落进 models.json", !JSON.stringify(afterSave).includes("sk-test"));
check("写完不留临时文件", readdirSync(dir).filter((n) => n.endsWith(".tmp")).length === 0, readdirSync(dir));

console.log("\n同进程不同 IPC 并发保存");
const parallel = await Promise.allSettled([
  PiModelsStore.saveProvider("parallel-a", cfg as never, "sk-alpha"),
  PiModelsStore.saveProvider("parallel-b", cfg as never, "sk-beta"),
]);
check("★ 同时保存两个 provider 均完成，不得共享固定 PID 暂存文件",
  parallel.every((result) => result.status === "fulfilled"),
  parallel.map((x) => x.status === "rejected" ? String(x.reason) : "fulfilled"));
const finalParallel = JSON.parse(readFileSync(file, "utf-8")) as { providers: Record<string, unknown> };
check("★ 并发 RMW 后两个新 provider 必须都存在",
  "parallel-a" in finalParallel.providers && "parallel-b" in finalParallel.providers,
  Object.keys(finalParallel.providers));
check("★ 并发保存不得覆盖原手写和先前保存条目",
  "mine" in finalParallel.providers && "mcode" in finalParallel.providers,
  Object.keys(finalParallel.providers));
check("★ 并发写入后不残留同 PID 暂存文件",
  readdirSync(dir).every((name) => !name.endsWith(".tmp")), readdirSync(dir));

console.log("\nPi 文件租约并发保护");
const releaseLease = await acquireOsFileLease(file + ".mcode-lock", 1500);
let leaseSaveFinished = false;
const leaseSave = PiModelsStore.saveProvider("lease-protected", cfg as never, "test-key")
  .then(() => { leaseSaveFinished = true; });
await new Promise<void>((resolve) => setTimeout(resolve, 150));
check("★ 已持有文件租约时 Pi 保存不能立即成功", !leaseSaveFinished);
await releaseLease();
await leaseSave;
check("★ 解除磁盘租约后保存仍正常完成",
  Object.hasOwn(JSON.parse(readFileSync(file, "utf8")).providers, "lease-protected"));
check("★ 租约完成后没有遗留锁文件", !readdirSync(dir).some((name) => name.endsWith(".mcode-lock")));
console.log("\n同一 models.json 的两个真实 NTFS 硬链接入口");
const linkedOriginal = join(dir, "user-linked-original.json");
const beforeLink = readFileSync(file, "utf8");
writeFileSync(linkedOriginal, beforeLink);
rmSync(file);
linkSync(linkedOriginal, file);
check("★ models.json 真链接的两个入口具有相同 inode", lstatSync(linkedOriginal).nlink >= 2 && lstatSync(file).nlink >= 2);
const linkedError = await rejects(PiModelsStore.saveProvider("linked-attempt", cfg as never, "sk-link"));
check("★ models.json 为多链接文件时保存必须 fail-closed", linkedError !== null, linkedError);
check("★ 拒写后两条链接仍然相同且原件字节不变",
  lstatSync(file).nlink >= 2 && readFileSync(linkedOriginal, "utf8") === beforeLink
  && readFileSync(file, "utf8") === beforeLink);
check("★ 拒绝写硬链接时不得留下敏感暂存文件", readdirSync(dir).every(name => !name.endsWith(".tmp") && !name.endsWith(".mcode-tmp")));
rmSync(file);
writeFileSync(file, beforeLink);

console.log("\n拒绝 JS 原型保留的 provider 身份");
for (const reserved of ["__proto__", "constructor", "toString"]) {
  const before = readFileSync(file, "utf8");
  const saveDenied = await rejects(PiModelsStore.saveProvider(reserved, cfg as never, "sk-proto"));
  check("★ 不能将 " + reserved + " 当 Pi Provider 保存成功", saveDenied !== null, saveDenied);
  check("★ 被拒绝的保留名不能更改配置原字节：" + reserved, readFileSync(file, "utf8") === before);
  const deleteDenied = await rejects(PiModelsStore.deleteProvider(reserved));
  check("★ 删除保留名 " + reserved + " 也须拒绝", deleteDenied !== null, deleteDenied);
}

console.log("\n坏 JSON");
const broken = '{ "providers": { "mine": { "baseUrl": "http://x" }, }'; // 手滑多了个逗号
writeFileSync(file, broken, "utf-8");
const listedBroken = await PiModelsStore.listPublic();
check("列表侧退化成空,不抛", Object.keys(listedBroken).length === 0, listedBroken);
const saveErr = await rejects(PiModelsStore.saveProvider("mcode", cfg as never, "sk-test"));
check("保存被拒绝,并说明原因", saveErr !== null && saveErr.includes("models.json"), saveErr);
check("保存被拒后盘上内容一个字节不动", readFileSync(file, "utf-8") === broken);
const delErr = await rejects(PiModelsStore.deleteProvider("mine"));
check("删除同样被拒绝", delErr !== null, delErr);
check("删除被拒后盘上内容一个字节不动", readFileSync(file, "utf-8") === broken);

console.log("\n文件不存在");
writeFileSync(file, JSON.stringify({ providers: {} }), "utf-8");
await PiModelsStore.deleteProvider("nope");
check("空文件上删不存在的 provider 不报错", existsSync(file));

{
  const { SettingRepo } = await import("@main/store/repositories.js");
  const previous = SettingRepo.get("piProviderKeys");
  const badValue = "not-valid-json";
  SettingRepo.set("piProviderKeys", badValue);
  const before = readFileSync(file, "utf8");
  const failedSave = await rejects(PiModelsStore.saveProvider("bad-map", cfg as never, "test-only"));
  check("坏凭据设置时 Pi 保存拒绝", failedSave !== null, failedSave);
  check("坏凭据设置时 Pi 保存不覆盖原始数据",
    SettingRepo.get("piProviderKeys") === badValue && readFileSync(file, "utf8") === before);
  const failedDelete = await rejects(PiModelsStore.deleteProvider("nope"));
  check("坏凭据设置时 Pi 删除拒绝", failedDelete !== null, failedDelete);
  check("坏凭据设置时 Pi 删除不覆盖原始数据",
    SettingRepo.get("piProviderKeys") === badValue && readFileSync(file, "utf8") === before);
  SettingRepo.set("piProviderKeys", previous ?? "{}");
}


// 此前测试故意标记凭据坏档；先仅在测试中清除该模块持久事故标记。
const { __resetSecretMapCorruptionForTest } = await import("@main/lib/secretMapStore.js");
__resetSecretMapCorruptionForTest();
console.log("\n合法 JSON 内层 provider 值损坏时拒绝覆盖旧配置");
{
  const brokenProviders = [
    '{"providers":{"bad":null}}',
    '{"providers":{"bad":"unexpected-string"}}',
    '{"providers":{"bad":{"models":"invalid"}}}',
    '{"providers":{"bad":{"models":[null]}}}',
    '{"providers":{"bad":{"models":[{"id":123}]}}}',
    '{"providers":{"constructor":{"api":"openai-completions","models":[]}}}',
  ];
  for (const malformed of brokenProviders) {
    writeFileSync(file, malformed, "utf8");
    const failedSave = await rejects(PiModelsStore.saveProvider("new-good", cfg as never, "test-key"));
    check("★ Pi 内层 provider 值损坏时保存须 fail-closed", failedSave !== null, failedSave);
    check("★ Pi 内层坏档保存不能覆盖原始字节", readFileSync(file, "utf8") === malformed);
    const failedDelete = await rejects(PiModelsStore.deleteProvider("absent"));
    check("★ Pi 内层 provider 值损坏时删除须 fail-closed", failedDelete !== null, failedDelete);
    check("★ Pi 内层坏档删除不能覆盖原始字节", readFileSync(file, "utf8") === malformed);
  }
  writeFileSync(file, JSON.stringify({providers:{}}), "utf8");
}

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
// Credential-corruption tests above the final summary ensure write-side fail-closed.
