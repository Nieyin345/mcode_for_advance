/**
 * MAINT-2026-09 / M15 smoke — mobile HTTP server edges not covered by
 * mobile-pairing-smoke.
 *
 *  A. Static root containment. `serveMobileAsset` used
 *     `filePath.startsWith(normalize(root))`, so a raw `/../<root>-x/…` request
 *     reached any sibling directory whose name merely starts with the root's
 *     basename — unauthenticated, over the LAN (or the relay).
 *  B. Body cap on `POST /api/pair/verify`. The only unauthenticated POST shared
 *     the 32 MB RPC cap, so any client could make the desktop buffer and parse
 *     tens of MB per request before a credential was checked.
 *
 * Requests are sent with raw `node:http` (fetch would normalise `/../`).
 */
import { createServer, request, type Server } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  checks += 1;
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

const BOX = process.env.MAINT_M15_BOX;
if (!BOX || !process.env.MCODE_SMOKE_DATA_ROOT) throw new Error("run via run.sh (MAINT_M15_BOX / MCODE_SMOKE_DATA_ROOT unset)");

// Web root `<box>/dist` plus siblings sharing its name as a prefix.
const WEB = join(BOX, "dist");
const INDEX_SENTINEL = "M15_INDEX_SENTINEL";
const SECRET = "M15_SIBLING_SECRET_DO_NOT_SERVE";
mkdirSync(WEB, { recursive: true });
writeFileSync(join(WEB, "index.html"), `<!doctype html><body>${INDEX_SENTINEL}</body>`);
writeFileSync(join(WEB, "pair.html"), "<!doctype html><body>pair</body>");
writeFileSync(join(WEB, "app.js"), "console.log('in-root asset')");
mkdirSync(join(BOX, "dist-secret"), { recursive: true });
writeFileSync(join(BOX, "dist-secret", "secret.txt"), SECRET);
writeFileSync(join(BOX, "dist-secret", "secret.js"), `/*${SECRET}*/`);
mkdirSync(join(BOX, "distx"), { recursive: true });
writeFileSync(join(BOX, "distx", "index.html"), `<!doctype html><body>${SECRET}</body>`);
writeFileSync(join(BOX, "outside.txt"), SECRET);
process.env.MCODE_WEB_DIST = WEB;

const { initDb, closeDb } = await import("@main/store/db.js");
await initDb();
process.once("exit", () => { try { closeDb(); } catch { /* ignore */ } });

const { pairingManager } = await import("@main/mobile/PairingManager.js");
const { createMobileRequestHandler } = await import("@main/mobile/MobileHttpServer.js");

// Count how often the pairing verifier is actually reached.
let verifyCalls = 0;
const realVerify = pairingManager.verify.bind(pairingManager);
(pairingManager as unknown as { verify: typeof realVerify }).verify = (...args: Parameters<typeof realVerify>) => {
  verifyCalls += 1;
  return realVerify(...args);
};

const server: Server = createServer(createMobileRequestHandler("http://127.0.0.1:0"));
await new Promise<void>((resolve, reject) => {
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => resolve());
});
const addr = server.address();
if (!addr || typeof addr === "string") throw new Error("no port");
const PORT = addr.port;

interface Res { status: number; text: string; transportError?: string }

/** Raw request: the path is sent byte-for-byte (no URL normalisation). */
function raw(method: string, path: string, body?: string): Promise<Res> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: Res): void => { if (!done) { done = true; resolve(r); } };
    const r = request(
      {
        host: "127.0.0.1", port: PORT, method, path,
        headers: body === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: 3000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => finish({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", (e) => finish({ status: res.statusCode ?? 0, text: "", transportError: e.message }));
      },
    );
    r.on("timeout", () => { r.destroy(new Error("timeout")); });
    r.on("error", (e) => finish({ status: 0, text: "", transportError: e.message }));
    if (body !== undefined) r.write(body);
    r.end();
  });
}

console.log("\nA. static root containment");
{
  const idx = await raw("GET", "/");
  check("control: / serves the in-root index", idx.status === 200 && idx.text.includes(INDEX_SENTINEL), idx.status);
  const js = await raw("GET", "/app.js");
  check("control: in-root asset served", js.status === 200 && js.text.includes("in-root asset"), js.status);
  const inner = await raw("GET", "/../dist/app.js");
  check("control: /../dist/app.js resolves back inside root and is served", inner.status === 200, inner.status);

  const probes: Array<[string, string]> = [
    ["/../dist-secret/secret.txt", "sibling dir with root-name prefix (txt)"],
    ["/../dist-secret/secret.js", "sibling dir with root-name prefix (asset ext)"],
    ["/../distx/", "sibling dir index via directory request"],
    ["/../distx/index.html", "sibling dir index.html"],
    ["/../outside.txt", "parent dir file (was already 403)"],
  ];
  for (const [p, why] of probes) {
    const r = await raw("GET", p);
    check(`★ ${p} not served — ${why}`, r.status !== 200 && !r.text.includes(SECRET), { status: r.status, leaked: r.text.includes(SECRET) });
  }
}

console.log("\nB. body cap on unauthenticated /api/pair/verify");
{
  const small = JSON.stringify({ nonce: "not-a-real-nonce", code: "123456", deviceName: "m15" });
  verifyCalls = 0;
  const ctl = await raw("POST", "/api/pair/verify", small);
  check("control: normal-size bogus pairing → 401", ctl.status === 401, ctl);
  check("control: verifier reached for a normal-size request", verifyCalls === 1, verifyCalls);

  // Schema-valid request padded to ~256 KB (zod strips the unknown key).
  const big = JSON.stringify({ nonce: "not-a-real-nonce", code: "123456", deviceName: "m15", pad: "x".repeat(256 * 1024) });
  verifyCalls = 0;
  const r = await raw("POST", "/api/pair/verify", big);
  check("★ 256 KB unauthenticated body is refused (not parsed into a 401/200)", r.status !== 401 && r.status !== 200, { status: r.status, transportError: r.transportError });
  check("★ verifier never reached for the oversized body", verifyCalls === 0, verifyCalls);

  const health = await raw("GET", "/api/health");
  check("server still healthy afterwards", health.status === 200, health.status);
  verifyCalls = 0;
  const again = await raw("POST", "/api/pair/verify", small);
  check("normal pairing path still works after an oversized request", again.status === 401 && verifyCalls === 1, { status: again.status, verifyCalls });
}

server.close();
server.closeAllConnections?.();
console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures === 0 ? 0 : 1);
