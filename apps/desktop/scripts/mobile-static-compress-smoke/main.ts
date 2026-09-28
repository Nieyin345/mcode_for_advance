/**
 * Perf backlog #5 smoke — on-demand compression in serveMobileStatic.
 *
 * The renderer build used to write a `.gz` and `.br` copy of every text asset
 * (~26MB per installer) purely for the phone. Now the mobile server
 * compresses from the file on disk on first request and caches the result.
 * This suite checks that the phone still gets exactly the same bytes, with
 * the same encodings, caching headers and fallbacks as before.
 */
import { createServer, request, type Server } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { brotliCompressSync, brotliDecompressSync, gunzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";

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

const BOX = process.env.MOBILE_STATIC_BOX;
if (!BOX) throw new Error("run via run.sh (MOBILE_STATIC_BOX unset)");
const WEB = join(BOX, "dist");
mkdirSync(join(WEB, "assets"), { recursive: true });

/** ~300KB of JS-ish text: compressible but not trivially so. */
function fakeJs(seed: string): string {
  const parts: string[] = [];
  for (let i = 0; i < 6000; i++) parts.push(`export const v${i}_${seed}=${JSON.stringify(randomBytes(6).toString("hex"))};`);
  return parts.join("\n");
}
const APP = fakeJs("a");
writeFileSync(join(WEB, "index.html"), `<!doctype html><body>${"INDEX ".repeat(200)}</body>`);
writeFileSync(join(WEB, "pair.html"), "<!doctype html><body>pair</body>");
writeFileSync(join(WEB, "assets", "app-abc123.js"), APP);
writeFileSync(join(WEB, "assets", "style-abc123.css"), `.a{color:red}\n`.repeat(4000));
writeFileSync(join(WEB, "assets", "tiny-abc123.js"), "export{}");
writeFileSync(join(WEB, "assets", "logo.png"), randomBytes(4096));
// A bundle that still carries a precompressed sibling (old MCODE_WEB_DIST):
// the sibling must win, byte-for-byte.
const LEGACY = fakeJs("legacy");
const LEGACY_BR = brotliCompressSync(Buffer.from(LEGACY));
writeFileSync(join(WEB, "assets", "legacy-abc123.js"), LEGACY);
writeFileSync(join(WEB, "assets", "legacy-abc123.js.br"), LEGACY_BR);
process.env.MCODE_WEB_DIST = WEB;

const { serveMobileAsset, mobileCompressedCacheStats } = await import("@main/mobile/serveMobileStatic.js");

const server: Server = createServer((req, res) => serveMobileAsset(req, res));
await new Promise<void>((ok, bad) => {
  server.on("error", bad);
  server.listen(0, "127.0.0.1", () => ok());
});
const addr = server.address();
if (!addr || typeof addr === "string") throw new Error("no port");
const PORT = addr.port;

interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }
function get(path: string, acceptEncoding?: string): Promise<Res> {
  return new Promise((ok, bad) => {
    const r = request(
      { host: "127.0.0.1", port: PORT, path, method: "GET", headers: acceptEncoding ? { "accept-encoding": acceptEncoding } : {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => ok({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    r.on("error", bad);
    r.end();
  });
}
function decode(r: Res): string {
  const enc = r.headers["content-encoding"];
  if (enc === "br") return brotliDecompressSync(r.body).toString();
  if (enc === "gzip") return gunzipSync(r.body).toString();
  return r.body.toString();
}

const BROWSER = "gzip, deflate, br, zstd";

console.log("A. encodings");
{
  const r = await get("/assets/app-abc123.js", BROWSER);
  check("br-capable client gets br", r.status === 200 && r.headers["content-encoding"] === "br", r.headers);
  check("br body decodes to the exact file", decode(r) === APP);
  check("br body is actually smaller", r.body.length < APP.length / 2, r.body.length);
  check("Content-Length matches compressed body", Number(r.headers["content-length"]) === r.body.length);
  check("immutable caching kept", String(r.headers["cache-control"]).includes("immutable"));
  check("Vary: Accept-Encoding", r.headers["vary"] === "Accept-Encoding");

  const g = await get("/assets/app-abc123.js", "gzip, deflate");
  check("gzip-only client gets gzip", g.headers["content-encoding"] === "gzip", g.headers);
  check("gzip body decodes to the exact file", decode(g) === APP);

  const n = await get("/assets/app-abc123.js");
  check("no Accept-Encoding → raw", n.headers["content-encoding"] === undefined && n.body.toString() === APP);
  const star = await get("/assets/app-abc123.js", "*");
  check("Accept-Encoding: * → raw (unchanged policy)", star.headers["content-encoding"] === undefined && star.body.toString() === APP);

  const css = await get("/assets/style-abc123.css", BROWSER);
  check("css compressed too", css.headers["content-encoding"] === "br" && decode(css) === readFileSync(join(WEB, "assets", "style-abc123.css"), "utf8"));
}

console.log("B. things that must stay raw");
{
  const h = await get("/", BROWSER);
  check("index.html never compressed / cached", h.headers["content-encoding"] === undefined && h.headers["cache-control"] === "no-cache" && h.body.toString().includes("INDEX"));
  const spa = await get("/some/route", BROWSER);
  check("SPA fallback still index.html, raw", spa.status === 200 && spa.headers["content-encoding"] === undefined && spa.body.toString().includes("INDEX"));
  const p = await get("/pair?nonce=x", BROWSER);
  check("pairing page raw", p.headers["content-encoding"] === undefined && p.body.toString().includes("pair"));
  const t = await get("/assets/tiny-abc123.js", BROWSER);
  check("tiny asset served raw", t.headers["content-encoding"] === undefined && t.body.toString() === "export{}");
  const png = await get("/assets/logo.png", BROWSER);
  check("binary image not compressed", png.headers["content-encoding"] === undefined && png.body.length === 4096);
  const miss = await get("/assets/missing.js", BROWSER);
  check("missing asset still 404", miss.status === 404);
}

console.log("C. cache");
{
  const before = mobileCompressedCacheStats();
  check("cache holds the compressed variants (app br+gzip, css br)", before.entries === 3, before);
  const again = await get("/assets/app-abc123.js", BROWSER);
  check("repeat request served from cache (no new entry)", mobileCompressedCacheStats().entries === before.entries && decode(again) === APP);

  const NEW = fakeJs("b");
  writeFileSync(join(WEB, "assets", "burst-abc123.js"), NEW);
  const burst = await Promise.all(Array.from({ length: 8 }, () => get("/assets/burst-abc123.js", BROWSER)));
  check("8 concurrent first requests all correct", burst.every((r) => r.headers["content-encoding"] === "br" && decode(r) === NEW));
  check("…and share one compression (one new entry)", mobileCompressedCacheStats().entries === before.entries + 1, mobileCompressedCacheStats());

  // Dev rebuild in place: same name, new content → must not serve stale bytes.
  const CHANGED = fakeJs("c") + "\n// changed";
  writeFileSync(join(WEB, "assets", "app-abc123.js"), CHANGED);
  const after = await get("/assets/app-abc123.js", BROWSER);
  check("rewritten file is recompressed, not served stale", decode(after) === CHANGED);
}

console.log("D. legacy precompressed sibling");
{
  const r = await get("/assets/legacy-abc123.js", BROWSER);
  check("existing .br sibling served as-is", r.headers["content-encoding"] === "br" && r.body.equals(LEGACY_BR));
  check("…and decodes to the file", decode(r) === LEGACY);
  const g = await get("/assets/legacy-abc123.js", "gzip");
  check("no .gz sibling → gzip compressed on demand", g.headers["content-encoding"] === "gzip" && decode(g) === LEGACY);
}

console.log("E. build no longer emits .gz/.br copies");
{
  const cfg = readFileSync(resolve("electron.vite.config.ts"), "utf8");
  check("electron.vite.config.ts has no precompress plugin", !/precompressAssets\s*\(|brotliCompressSync|gzipSync/.test(cfg));
}

server.close();
console.log(`\n${checks - failures}/${checks} passed`);
if (failures) process.exit(1);
