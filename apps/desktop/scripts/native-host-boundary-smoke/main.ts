/**
 * FULL-1 L2 adapters only: test the real Node-RED editor authorization broker
 * and the GenOffice Docs native one-time byte handoff, without Electron,
 * host data roots, network, upstream credentials, or a second editor core.
 */
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DocumentViewCredentialBroker, readEngineAdminToken } from "../../src/main/document/documentViewCredentialBroker.js";
import {
  issueDocumentHandoff, takeDocumentHandoff, pendingDocumentHandoffCount, handoffResponseBodyView,
} from "../../src/main/document/documentViewHandoff.js";
let pass = 0, fail = 0;
function check(name: string, ok: boolean, details?: unknown) {
  if(ok) pass++; else fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : " " + JSON.stringify(details)}`);
}
let port: number | null = 1880, token: string | null = "first-live-host-token", clock=1_000;
let hookInstalled=false;
const broker = new DocumentViewCredentialBroker({
  runningPort:()=>port,
  readToken:()=>token,
  getSession:()=>({webRequest:{onBeforeSendHeaders:(_filter,_listener)=>{hookInstalled=true;}}}),
  now:()=>clock,
},{ttlMs:30_000});
const origin="http://127.0.0.1:1880";
const bind=()=>broker.bind({docId:"g-engine",engineId:"node-red-local",url:origin,webContentsId:100});
const request=()=>broker.headersForRequest({url:origin+"/flows",webContentsId:100,resourceType:"xhr",requestHeaders:{Accept:"application/json"}});
check("有效引擎与令牌可以先预检后绑定",broker.prepare({engineId:"node-red-local",url:origin}).ok && bind().ok && hookInstalled);
check("原厂 Node-RED 编辑器请求注入正在生效的 host token",request().Authorization==="Bearer first-live-host-token");
clock+=50;
request();
check("正常用量请求续租",broker.debugState()[0]?.expiresAt===clock+30_000);
port=null;
check("★ 引擎已停机时不能给同端口重用的进程注入旧令牌",request().Authorization===undefined);
check("★ 引擎已停机必须清理宿主旧身份绑定",broker.debugState().length===0);
port=1880;
check("恢复引擎运行后可由宿主显式重新绑定",bind().ok && request().Authorization==="Bearer first-live-host-token");
port=1881;
check("★ 引擎更换监听端口后旧 WebContents 不能用原绑定",request().Authorization===undefined);
check("端口变化时旧绑定应撤销",broker.debugState().length===0);
port=1880;
check("新的一次正式打开能重新授权",bind().ok);
token="rotated-token";
check("★ 管理凭据轮换后旧令牌不能再继续注入",request().Authorization===undefined);
check("★ 凭据轮换立即撤销旧绑定",broker.debugState().length===0);
check("宿主完成令牌重新绑定后正常注入新身份",bind().ok && request().Authorization==="Bearer rotated-token");
check("未授权 WebContents 不注入",broker.headersForRequest({url:origin+"/flows",webContentsId:101,requestHeaders:{}}).Authorization===undefined);
broker.release("g-engine");
check("宿主关闭编辑器后旧身份彻底摘除",request().Authorization===undefined);

// GenOffice vendor apps/docs/src/main/byte-handoff.ts at pinned checkout:
// MAX_PENDING_HANDOFF_BYTES = 1 GiB, MAX_PENDING_HANDOFFS = 8,
// Buffer handed off by reference (no extra 256 MiB copy during open).
const meta={docId:"doc-a",filePath:"C:/isolated/not-real.docx",sha256:"00"};
const a=Buffer.alloc(40*1024*1024);
const b=Buffer.alloc(40*1024*1024);
a[0]=0xa1;b[0]=0xb2;
const u1=issueDocumentHandoff(a,meta);
const u2=issueDocumentHandoff(b,meta);
check("★ 原厂允许两个 40MiB 未取响应并存而不是按 Mcode 64MiB 窄阈值提前淘汰",pendingDocumentHandoffCount()===2,pendingDocumentHandoffCount());
const first=takeDocumentHandoff(u1);
const second=takeDocumentHandoff(u2);
check("★ 前一个 40MiB 文档没有被新打开的文档静默挤失",first?.[0]===0xa1);
check("★ 后一个 40MiB 文档也能正常交付",second?.[0]===0xb2);
check("★ Buffer 输入应按原厂语义传同一份内存，不能在 Host 再拷贝整份 DOCX",first===a && second===b);
const nativeResponseView=handoffResponseBodyView(a);
check("GenOffice protocol response must share DOCX backing memory, not allocate another large copy",
  nativeResponseView.buffer===a.buffer && nativeResponseView.byteOffset===a.byteOffset && nativeResponseView.byteLength===a.byteLength);
a[1]=0xc3;
check("protocol response view sees original buffered DOCX bytes without extra buffer duplication",
  nativeResponseView[1]===0xc3);
const handoffSource = readFileSync("src/main/document/documentViewHandoff.ts", "utf8");
check("actual Electron media protocol response uses shared view, not a copied Uint8Array",
  handoffSource.includes("new Response(handoffResponseBodyView(handed)") && !handoffSource.includes("new Uint8Array(handed)"));
check("一次性 URL 第二次取应失败",takeDocumentHandoff(u1)===null && takeDocumentHandoff(u2)===null);
check("二份交付后内存计数归零",pendingDocumentHandoffCount()===0);
const urls:string[]=[];
for(let i=0;i<9;i++) urls.push(issueDocumentHandoff(Buffer.from([i]),meta));
check("★ 原厂限制最多8个待取响应，9次打开应淘汰最旧的",pendingDocumentHandoffCount()===8,pendingDocumentHandoffCount());
check("原厂 oldest-first 淘汰应让第一个 token 失效",takeDocumentHandoff(urls[0]!)===null);
check("其余8个原生 URL 都能一次性读取",urls.slice(1).every((u,i)=>takeDocumentHandoff(u)?.[0]===i+1));
check("全部取走后零个未消费响应",pendingDocumentHandoffCount()===0);
// Real NTFS files, isolated tmpdir. The same token used for the running
// engine should not be readable via a hardlink/symlink masquerading as the
// Host-owned .engine-admin-token, nor from an invalid oversized token file.
const tempRoot = mkdtempSync(join(tmpdir(), "mcode-editor-token-"));
try {
  const owned = join(tempRoot, "owned");
  const outside = join(tempRoot, "outside");
  mkdirSync(owned);
  mkdirSync(outside);
  const tokenPath = join(owned, ".engine-admin-token");
  const originalToken = "a".repeat(64);
  writeFileSync(tokenPath, originalToken);
  check("legitimate runtime-issued 64hex token loads",readEngineAdminToken(owned)===originalToken);
  writeFileSync(tokenPath, "legacy-admin-token.with_custom_format");
  check("runtime supervisor legacy custom token remains usable",
    readEngineAdminToken(owned)==="legacy-admin-token.with_custom_format");
  rmSync(tokenPath);
  const secretOutside = join(outside, "sensitive.txt");
  writeFileSync(secretOutside, "b".repeat(64));
  linkSync(secretOutside,tokenPath);
  check("★ hardlinked external token cannot grant Node-RED admin credentials",readEngineAdminToken(owned)===null);
  check("external secret bytes remain unchanged",readFileSync(secretOutside,"utf8")==="b".repeat(64));
  rmSync(tokenPath);
  try {
    symlinkSync(secretOutside,tokenPath,"file");
    check("★ symlinked external token cannot grant Node-RED admin credentials",readEngineAdminToken(owned)===null);
    rmSync(tokenPath);
  } catch (err) { console.log("SKIP token symlink (OS privilege):",String(err)); }
  writeFileSync(tokenPath, originalToken+"\r\nEVIL\r\nheader");
  check("★ embedded newline invalid token never reaches Authorization header",readEngineAdminToken(owned)===null);
  writeFileSync(tokenPath,"x".repeat(1024*1024));
  check("★ oversized admin-token file is rejected before loading megabytes",readEngineAdminToken(owned)===null);
  const linkedRoot = join(tempRoot,"linked-root");
  try {
    symlinkSync(owned,linkedRoot,process.platform==="win32"?"junction":"dir");
    check("★ junction root cannot redirect token read to another directory",readEngineAdminToken(linkedRoot)===null);
  } catch (err) {console.log("SKIP token-root junction (OS privilege):",String(err));}
} finally {rmSync(tempRoot,{recursive:true,force:true});}
const userinfoBroker = new DocumentViewCredentialBroker({
 runningPort:()=>1880,readToken:()=> "live-token",
 getSession:()=>({webRequest:{onBeforeSendHeaders(){}}}),
});
check("★ editor URL must not contain HTTP Basic-Auth userinfo even on loopback",
  !userinfoBroker.prepare({engineId:"node-red-local",url:"http://foreign:password@127.0.0.1:1880/"}).ok);
console.log(`native-host-boundary-smoke: ${pass}/${pass+fail}`);
if(fail) process.exitCode=1;
