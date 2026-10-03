import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { desktopCsp } from "@main/lib/desktopCsp.js";
import { cloneMarketRepository, promoteMarketCatalog, safeGitMessage, MARKET_CLONE_TIMEOUT_MS } from "@main/lib/marketClone.js";
import { marketProgressFor } from "@main/lib/marketProgress.js";
import { spawnRun, type SpawnRunResult } from "@main/lib/spawnRun.js";

async function main() {
let checks = 0;
function check(label: string, test: unknown) { assert.ok(test, label); checks++; console.log(`PASS ${label}`); }
const own = "file:///C:/Mcode/out/renderer/index.html";
const policy = desktopCsp(own + "?test=1#view", own, "http://127.0.0.1:12345");
check("own page retains CSP", !!policy);
check("PDF blob images allowed", /img-src[^;]*blob:/.test(policy!));
check("PDF blob fetch allowed", /connect-src[^;]*blob:/.test(policy!));
check("main inline scripts remain forbidden", !/script-src[^;]*'unsafe-inline'/.test(policy!));
check("CDN not globally whitelisted", !policy!.includes("jsdelivr"));
check("external editor policy untouched", desktopCsp("http://127.0.0.1:12345/web-apps/editor.html", own) === null);
check("custom panel policy untouched", desktopCsp("mcode-panel://test/index.html", own) === null);
check("unrelated local document policy untouched", desktopCsp("file:///tmp/other.html", own) === null);
check("invalid office origin cannot inject directives", !desktopCsp(own, own, "javascript:alert(1)")!.includes("javascript"));
check("clone limit exceeds old hard stop but remains finite", MARKET_CLONE_TIMEOUT_MS === 900000);
check("Git diagnostics redact credentials/query", safeGitMessage("fatal: https://alice:secret@host.invalid/repo?token=hidden").includes("https://host.invalid/repo") && !safeGitMessage("https://alice:secret@host.invalid/repo?token=hidden").includes("hidden"));
const root = await fs.mkdtemp(path.join(tmpdir(), "mcode-editor-market-"));
const ok = (extra: Partial<SpawnRunResult> = {}): SpawnRunResult => ({ code: 0, signal: null, stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, killedBy: { timeout: false, abort: false }, ...extra });
try {
  const events: string[] = [];
  await cloneMarketRepository("https://example.invalid/repo", path.join(root,"clone"), "main", p => events.push(p.message), {
    idleMs: 80,
    run: async opts => {
      check("clone uses streaming progress, no quiet", opts.args!.includes("--progress") && !opts.args!.includes("--quiet"));
      check("no interactive credential prompt", opts.env?.GIT_TERMINAL_PROMPT === "0");
      check("URL remains one argv, no shell", !opts.shell && opts.args!.includes("https://example.invalid/repo"));
      for (let i = 0; i < 5; i++) { opts.onStderrChunk?.(Buffer.from(`Receiving objects: ${i * 20}%\r`)); await new Promise(r => setTimeout(r, 25)); }
      check("active transfers survive idle threshold", !opts.signal.aborted);
      return ok();
    },
  });
  check("real CR progress reaches sink", events.some(m => m.includes("Receiving objects:")));
  await assert.rejects(cloneMarketRepository("https://example.invalid/repo", path.join(root,"idle"), undefined, undefined, {
    idleMs: 30, run: opts => new Promise(resolve => opts.signal.addEventListener("abort", () => resolve(ok({ code:null, signal:"SIGTERM", killedBy:{ timeout:false,abort:true } })))),
  }), /no progress timeout/); checks++;
  await assert.rejects(cloneMarketRepository("https://example.invalid/repo", path.join(root,"timeout"), undefined, undefined, {
    timeoutMs: 120000, run: async () => ok({ code:null,signal:"SIGTERM",killedBy:{timeout:true,abort:false} }),
  }), /total timeout/); checks++;
  await assert.rejects(cloneMarketRepository("https://example.invalid/repo", path.join(root,"missing"), undefined, undefined, {
    run: async () => ok({ code:null,spawnError:Object.assign(new Error("spawn git ENOENT"),{code:"ENOENT"}) }),
  }), /Git not found/); checks++;
  let calls = 0;
  await cloneMarketRepository("https://example.invalid/repo", path.join(root,"proxy"), undefined, undefined, { run: async opts => {
    if (++calls === 1) return ok({ code:128,stderr:"Failed to connect to 127.0.0.1 port 7897: Connection refused" });
    check("refused proxy retry strips proxy env", !Object.keys(opts.env!).some(k => /^(https?|all|no)_proxy$/i.test(k)));
    check("refused proxy retry overrides Git config", opts.args!.includes("http.proxy=")); return ok();
  } });
  check("one refused-proxy retry", calls === 2);
  calls=0;
  await assert.rejects(cloneMarketRepository("https://example.invalid/repo",path.join(root,"auth"),undefined,undefined,{run:async()=>{calls++;return ok({code:128,stderr:"HTTP 407 Proxy Authentication Required"});}}), /407/);
  check("authentication failure never bypasses proxy", calls===1);
  const destination=path.join(root,"catalog"),staging=path.join(root,"stage");
  await fs.mkdir(destination);await fs.writeFile(path.join(destination,"old"),"keep");
  await assert.rejects(promoteMarketCatalog(staging,destination));
  check("failed promotion restores old catalog", await fs.readFile(path.join(destination,"old"),"utf8")==="keep");
  await fs.mkdir(staging);await fs.writeFile(path.join(staging,"new"),"new");await promoteMarketCatalog(staging,destination);
  check("valid promotion replaces catalog",await fs.readFile(path.join(destination,"new"),"utf8")==="new");
  const messages: any[]=[];
  const sink=marketProgressFor({sender:{isDestroyed:()=>false,send:(...args:any[])=>messages.push(args)}} as any,"owner-id");
  sink?.({phase:"clone",message:"Receiving objects: 20%",elapsedMs:100});
  check("progress only sent to initiating sender with correlation",messages.length===1&&messages[0][1].payload.requestId==="owner-id");
  check("legacy calls need no progress channel",marketProgressFor({} as any)===undefined);
  let received="";
  const real = await spawnRun({command:process.execPath,args:["-e","process.stderr.write('Receiving: 25%\\r');setTimeout(()=>process.stderr.write('Receiving: 100%\\r'),25)"],timeoutMs:3000,signal:new AbortController().signal,limitBytes:4096,onStderrChunk:b=>{received+=b.toString();}});
  check("actual process CR streaming works",real.code===0&&received.includes("25%\r")&&received.includes("100%\r"));
  const bounded=await spawnRun({command:process.execPath,args:["-e","process.stderr.write('x'.repeat(200000)+'\\r')"],timeoutMs:3000,signal:new AbortController().signal,limitBytes:1024,rawOutput:true});
  check("CR-only raw capture remains bounded",bounded.code===0&&bounded.stderrTruncated&&Buffer.byteLength(bounded.stderr)<=1024);
  const config=path.join(root,"empty-gitconfig"),repo=path.join(root,"repo"),cloned=path.join(root,"real-clone");
  await fs.writeFile(config,"");await fs.mkdir(repo);
  const gitEnv: NodeJS.ProcessEnv={...process.env,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:config,GIT_CONFIG_COUNT:"0",GIT_TERMINAL_PROMPT:"0",GCM_INTERACTIVE:"Never"};
  delete gitEnv.GIT_CONFIG_PARAMETERS;
  const git=async(args:string[])=>{const result=await spawnRun({command:"git",args,cwd:repo,env:gitEnv,timeoutMs:10000,signal:new AbortController().signal,limitBytes:4096});assert.equal(result.code,0,result.stderr);};
  await git(["-c","init.templateDir=","init","-b","main"]);
  await fs.writeFile(path.join(repo,"SKILL.md"),"---\nname: fixture\n---\nLocal fixture");
  await git(["add","SKILL.md"]);
  await git(["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","-c","commit.gpgsign=false","commit","-m","fixture"]);
  await cloneMarketRepository(repo,cloned,"main",undefined,{run:opts=>spawnRun({...opts,env:gitEnv})});
  check("actual Git clone works with branch/argv and isolated config",(await fs.readFile(path.join(cloned,"SKILL.md"),"utf8")).includes("Local fixture"));

} finally { await fs.rm(root,{recursive:true,force:true}); }
console.log(`${checks}/${checks} editor/market regression checks passed`);

}
main().catch(error=>{console.error(error);process.exitCode=1;});
