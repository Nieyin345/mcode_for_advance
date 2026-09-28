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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
