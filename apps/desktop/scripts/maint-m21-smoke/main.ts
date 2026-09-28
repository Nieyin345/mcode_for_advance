/**
 * MAINT-2026-09 / M21 · 本机 Office 安装与预览冒烟
 *
 * 被测:`@main/onlyoffice/localInstall.ts`(检测 / 配置 / 提权脚本的形态)。
 *
 * 关注点 —— **提权的那一步喂给 Windows 的到底是什么**。`runElevated` 会把一段
 * PowerShell 写成 `%TEMP%\mcode-onlyoffice\install.ps1`,再用
 * `Start-Process -Verb RunAs -File <那个路径>` 提权执行它。`%TEMP%` 是**当前用户
 * 可写**的:任何以该用户身份运行的进程(在 Mcode 里,这包括 Agent 自己跑的代码)
 * 都能在用户点下"本机安装"与 UAC 弹窗之间把那个文件换掉,拿到管理员权限。
 *
 * 一个进程都不起:`node:child_process` 被 childStub 顶替。
 */
import { mkdir, writeFile, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { serviceQueries, spawnCalls, spawnHooks } from "./childStub.js";
import { detectLocal, startLocalConfigure } from "@main/onlyoffice/localInstall.js";
import { getInstallProgress } from "@main/onlyoffice/localInstall.js";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const exists = (p: string): Promise<boolean> => stat(p).then(() => true).catch(() => false);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const TEMP = process.env.MCODE_M21_TEMP as string;
const FAKE_PF = process.env.MCODE_M21_PROGRAMFILES as string;

/** 假装 DS 已装在 ProgramFiles 下,并且 healthcheck 在 8080 上是通的。 */
async function seedFakeInstall(): Promise<string> {
  const dir = join(FAKE_PF, "ONLYOFFICE", "DocumentServer");
  await mkdir(join(dir, "web-apps", "apps", "api", "documents"), { recursive: true });
  await writeFile(join(dir, "web-apps", "apps", "api", "documents", "api.js"), "//", "utf8");
  await mkdir(join(dir, "config"), { recursive: true });
  await writeFile(join(dir, "config", "local.json"), JSON.stringify({
    services: { CoAuthoring: { secret: { inbox: { string: "fake-secret" } },
      token: { enable: { request: { inbox: true } } } } },
  }), "utf8");
  await mkdir(join(dir, "server"), { recursive: true });
  await writeFile(join(dir, "server", "package.json"), JSON.stringify({ version: "8.9.9" }), "utf8");
  return dir;
}

async function main(): Promise<void> {
  process.env.ProgramFiles = FAKE_PF;
  delete process.env["ProgramFiles(x86)"];
  delete process.env.ProgramW6432;
  const installDir = await seedFakeInstall();

  // healthcheck / 任何 fetch 都不出网
  (globalThis as { fetch: unknown }).fetch = async (input: unknown): Promise<Response> => {
    const url = String(input);
    if (url.includes("127.0.0.1:8080/healthcheck")) {
      return new Response("true", { status: 200 });
    }
    return new Response("nope", { status: 404 });
  };

  /* ── 1) 检测:读得出目录/版本/密钥/端口 ───────────────────────────── */
  {
    serviceQueries.length = 0;
    const d = await detectLocal();
    check("检测:认出已安装的 DS", d.installed === true && d.installDir === installDir, JSON.stringify(d));
    check("检测:查询官方 Windows DocService 名称", serviceQueries.includes("DsDocServiceSvc"), serviceQueries.join(","));
    check("检测:服务状态是 running", d.serviceState === "running", String(d.serviceState));
    check("检测:读出版本", d.version === "8.9.9", String(d.version));
    check("检测:读出 JWT 密钥与 token 开关", d.jwtSecret === "fake-secret" && d.tokenEnabled === true);
    check("检测:探到端口并给出建议地址", d.port === 8080 && d.suggestedServerUrl === "http://127.0.0.1:8080");
    check("检测:local.json 没写 allowPrivateIPAddress 时按 DS 8.x 默认判为 false",
      d.privateIpAllowed === false, String(d.privateIpAllowed));
  }

  /* ── 2) 提权那一步喂进去的是什么 ─────────────────────────────────── */
  {
    spawnCalls.length = 0;
    spawnHooks.markerToCreate = join(TEMP, "mcode-onlyoffice", "install.ok");
    startLocalConfigure();
    for (let i = 0; i < 100 && getInstallProgress().phase !== "done"; i++) await sleep(50);
    check("配置流程:走到 done", getInstallProgress().phase === "done",
      JSON.stringify(getInstallProgress()));
    check("配置流程:确实发起了一次提权调用", spawnCalls.length === 1, JSON.stringify(spawnCalls));

    const call = spawnCalls[0];
    const joined = (call?.args ?? []).join(" ");
    check("提权:确实是 RunAs 提权", /-Verb\s+RunAs/i.test(joined), joined.slice(0, 200));

    // —— 核心断言 ——
    const scriptPath = join(TEMP, "mcode-onlyoffice", "install.ps1");
    check("提权:不把脚本落在用户可写目录里", !(await exists(scriptPath)),
      `${scriptPath} 存在 —— 用户态进程可在 UAC 确认前替换它`);
    check("提权:命令行不按路径去加载用户可写的脚本文件",
      !joined.includes("'-File'") && !/\.ps1/i.test(joined),
      `提权命令行引用了脚本文件:${joined.slice(0, 240)}`);

    // 脚本内容本身要还在(内联传递),否则说明改坏了
    const enc = /-EncodedCommand['",\s]+([A-Za-z0-9+/=]+)/.exec(joined);
    const inline = enc?.[1] ? Buffer.from(enc[1], "base64").toString("utf16le") : "";
    check("提权:脚本以内联方式传递且内容完整",
      inline.includes("allowPrivateIPAddress") && inline.includes("DsDocServiceSvc") && inline.includes("DsConverterSvc"),
      inline.slice(0, 200));
    check("提权:安装目录路径仍被正确转义进脚本", inline.includes(installDir), inline.slice(0, 300));
  }

  /* ── 3) 安装器在提权执行前必须验签 ───────────────────────────────── */
  {
    const mod = await import("@main/onlyoffice/localInstall.js") as {
      buildElevationCommand?: (o: { installerPath: string | null; port: number | null; installDir: string }) => string;
    };
    if (typeof mod.buildElevationCommand !== "function") {
      check("安装器:提权执行前校验 Authenticode 签名", false, "buildElevationCommand 未导出");
    } else {
      const script = mod.buildElevationCommand({
        installerPath: "C:\\Users\\u\\AppData\\Local\\Temp\\mcode-onlyoffice\\onlyoffice-documentserver.exe",
        port: 8080,
        installDir,
      });
      const sigAt = script.indexOf("Get-AuthenticodeSignature");
      const runAt = script.indexOf("Start-Process -FilePath");
      check("安装器:提权执行前校验 Authenticode 签名", sigAt >= 0 && runAt >= 0 && sigAt < runAt,
        `sigAt=${sigAt} runAt=${runAt}`);
      check("安装器:只认 ONLYOFFICE/Ascensio 的签名主体", /Ascensio|ONLYOFFICE/i.test(script));
      check("安装器:端口按数字拼接,单引号被转义",
        script.includes("/DS_PORT=8080") && !script.includes("''''"));
    }
  }

  console.log(`\nmaint-m21-smoke: ${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("maint-m21-smoke crashed:", err);
  process.exitCode = 1;
});
