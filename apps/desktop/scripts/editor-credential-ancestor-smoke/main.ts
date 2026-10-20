import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readEngineAdminToken, DocumentViewCredentialBroker } from "@main/document/documentViewCredentialBroker.js";

let count = 0;
let failed = 0;
function check(name: string, pass: boolean, detail?: unknown) {
  count++;
  if (!pass) failed++;
  console.log((pass ? "  ok   " : "  FAIL ") + name + (pass ? "" : " " + String(detail)));
}
const temp = mkdtempSync(join(tmpdir(), "mcode-token-ancestor-"));
try {
  const outside = join(temp, "external");
  mkdirSync(outside);
  const privateRoot = join(outside, "user", "node-red");
  mkdirSync(join(outside, "user"));
  mkdirSync(privateRoot);
  const token = "a".repeat(64);
  writeFileSync(join(privateRoot, ".engine-admin-token"), token);

  const linkedParent = join(temp, "linked-parent");
  let linked = false;
  try {
    symlinkSync(outside, linkedParent, process.platform === "win32" ? "junction" : "dir");
    linked = true;
  } catch (error) {
    console.log("SKIP parent junction unsupported: " + String(error));
  }
  if (linked) {
    check("precondition: direct normal root still returns known token", readEngineAdminToken(privateRoot) === token);
    const linkNested = join(linkedParent, "user", "node-red");
    check("★ linked ancestor cannot redirect Node-RED editor token read", readEngineAdminToken(linkNested) === null);
    check("★ original outside managed token remains unmodified", readFileSync(join(privateRoot, ".engine-admin-token"), "utf8") === token);
  }
  const noToken = join(temp, "no-token");
  mkdirSync(noToken);
  check("missing token remains safely unavailable", readEngineAdminToken(noToken) === null);
  const standalone = join(temp, "legitimate");
  mkdirSync(standalone);
  writeFileSync(join(standalone, ".engine-admin-token"), "legacy-token_ABC.99");
  check("legitimate legacy-custom ASCII token remains compatible", readEngineAdminToken(standalone) === "legacy-token_ABC.99");

  // A transport-supplied token is a runtime value: a surprise whitespace
  // or CRLF value must not be promoted into an outgoing privileged header.
  let handler: ((detail: { url: string; webContentsId: number; requestHeaders: Record<string,string> },
                 cb: (output: { requestHeaders: Record<string,string> }) => void) => void) | null = null;
  const broker = new DocumentViewCredentialBroker({
    readToken: () => "bad\r\nInjected: value",
    runningPort: () => 1880,
    getSession: () => ({ webRequest: { onBeforeSendHeaders: (_filter, fn) => {handler = fn;} } }),
  });
  check("★ unsafe runtime-injected token must not pass prepare", !broker.prepare({engineId:"node-red",url:"http://127.0.0.1:1880/"}).ok);
  const result = broker.bind({docId:"test",engineId:"node-red",url:"http://127.0.0.1:1880/",webContentsId:19});
  check("★ unsafe runtime token must not create an editor binding", !result.ok);
  check("unsafe token produces no authorization-bearing listener", handler === null || broker.debugState().length === 0);

  // Mcode RuntimeSupervisor binds its Admin API specifically to 127.0.0.1.
  // localhost can instead resolve to ::1, where another local process may
  // listen on the SAME port. A loopback address/port match alone is not proof
  // that this is the engine which owns our Bearer token.
  const exactHost = new DocumentViewCredentialBroker({
    readToken: () => token,
    runningPort: () => 1880,
    getSession: () => null,
  });
  check("IPv4 Node-RED runtime origin is allowed",
    exactHost.prepare({ engineId: "node-red", url: "http://127.0.0.1:1880/" }).ok);
  check("★ localhost alias cannot receive 127.0.0.1-bound engine token",
    !exactHost.prepare({ engineId: "node-red", url: "http://localhost:1880/" }).ok);
  check("★ IPv6 loopback listener on the same port cannot receive engine token",
    !exactHost.prepare({ engineId: "node-red", url: "http://[::1]:1880/" }).ok);
} finally {
  rmSync(temp, {recursive: true, force: true});
}
console.log("editor-credential-ancestor-smoke:" + (count-failed) + "/" + count);
if (failed) process.exitCode = 1;
