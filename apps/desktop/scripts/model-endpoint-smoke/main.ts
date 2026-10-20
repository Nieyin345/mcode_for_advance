/**
 * `lib/modelEndpoint` 的回归 —— 「按用户填的地址发一次 HTTP」这两件事。
 *
 * ## 为什么单开一套
 *
 * 这是本应用里少有的**主进程主动外连**的地方（设置页「模型配置」的连通性测试 +
 * 拉模型列表）。它错的方式都不是报错，而是「看起来对了其实没对」：
 *
 *  - 拉列表把端点返回的 `{"error":"invalid api key"}` 当成模型名列表填进下拉框；
 *  - 连通性测试对 401 也判「成功」（只看连得上，不看答没答对）；
 *  - 地址拼接漏了路径段 / 多一个斜杠，请求打到错误的 URL 上。
 *
 * ## 怎么测
 *
 * 起一个**真的本地 HTTP 服务**当假网关（不是 mock fetch）—— 这样地址拼接、认证头、
 * 超时、状态码判据走的都是真路径。`run.sh` 用 `listenOnDialablePort` 同类做法绑随机口。
 *
 * Run: scripts/model-endpoint-smoke/run.sh
 */
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { listEndpointModels, probeEndpoint } from "@main/lib/modelEndpoint.js";

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

/** 记录假网关收到的每一次请求，断言认证头/路径用。 */
const seen: Array<{ method: string; url: string; auth: string; apiKey: string }> = [];

const server: Server = createServer((req, res) => {
  seen.push({
    method: req.method ?? "",
    url: req.url ?? "",
    auth: String(req.headers["authorization"] ?? ""),
    apiKey: String(req.headers["x-api-key"] ?? ""),
  });
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  // Fake-only hostile gateways: each is confined to this loopback server.
  if (req.url?.startsWith("/cross-api-ok/")) {
    if (req.url?.endsWith("/v1/messages")) send(200, { choices: [{ message: { content: "openai shape at anthropic route" } }] });
    else send(200, { content: [{ type: "text", text: "anthropic shape at openai route" }] });
    return;
  }
  if (req.url?.startsWith("/list-error-with-data/")) {
    send(200, { error: { message: "invalid API key" }, data: [{ id: "fake-premium-model" }] });
    return;
  }
  if (req.url?.startsWith("/false-ok/")) {
    send(200, { error: { message: "model unauthorized" } });
    return;
  }
  if (req.url?.startsWith("/html-ok/")) {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>Gateway sign in</title>");
    return;
  }
  if (req.url?.startsWith("/empty-ok/")) {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.url?.startsWith("/bogus-content-ok/")) {
    if (req.url?.endsWith("/v1/messages")) send(200, { content: [{ type: "untrusted_gateway_control" }] });
    else send(200, { choices: [{ message: { content: "" } }] });
    return;
  }
  if (req.url?.startsWith("/valid-tool-calls/")) {
    if (req.url?.endsWith("/v1/messages")) send(404, { error: "Anthropic not provided" });
    else send(200, { choices: [{ message: { tool_calls: [{ type: "function", function: { name: "ping_tool", arguments: "{}" } }] } }] });
    return;
  }
  if (req.url?.startsWith("/invalid-tool-calls-ok/")) {
    if (req.url?.endsWith("/v1/messages")) send(200, { content: [{ type: "tool_use", name: "" }] });
    else send(200, { choices: [{ message: { tool_calls: [null] } }] });
    return;
  }
  if (req.url?.startsWith("/invalid-content-parts-ok/")) {
    if (req.url?.endsWith("/v1/messages")) send(200, { content: [{ type: "text", text: "" }] });
    else send(200, { choices: [{ message: { content: [null] } }] });
    return;
  }
  if (req.url?.startsWith("/empty-tool-calls-ok/")) {
    if (req.url?.endsWith("/v1/messages")) send(200, { content: [{ type: "text" }] });
    else send(200, { choices: [{ message: { tool_calls: [] } }] });
    return;
  }
  if (req.url?.startsWith("/empty-array-ok/")) {
    if (req.url?.endsWith("/v1/messages")) send(200, { content: [] });
    else send(200, { choices: [{ message: {} }] });
    return;
  }
  if (req.url?.startsWith("/malformed-ok/")) {
    send(200, { "choices": "not an array" });
    return;
  }
  if (req.url?.startsWith("/echo/")) {
    send(401, { error: "invalid token " + String(req.headers["authorization"] ?? "") });
    return;
  }
  if (req.url?.startsWith("/redirect/")) {
    res.writeHead(302, { location: "/v1/models" });
    res.end();
    return;
  }
  if (req.url?.startsWith("/too-many-models/")) {
    send(200, { data: Array.from({ length: 1200 }, (_, i) => ({ id: "model-" + i })) });
    return;
  }
  if (req.url?.startsWith("/model-id-too-long/")) {
    send(200, { data: [{ id: "model-" + "x".repeat(8192) }] });
    return;
  }
  if (req.url?.startsWith("/model-id-control/")) {
    send(200, { data: [{ id: "alpha\u0000secret" }] });
    return;
  }
  if (req.url?.startsWith("/oversize/")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "x".repeat(700_000) }] }));
    return;
  }
  if (req.url?.startsWith("/double-slow/")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.flushHeaders();
    setTimeout(() => res.end(JSON.stringify({ data: [{ id: "late" }] })), 180);
    return;
  }
  if (req.url?.startsWith("/slow-body/")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.flushHeaders();
    setTimeout(() => res.end(JSON.stringify({ data: [{ id: "late" }] })), 130);
    return;
  }
  // 假网关路由
  if (req.url === "/v1/models" && req.headers["authorization"]) {
    send(200, { data: [{ id: "alpha" }, { id: "beta" }] });
    return;
  }
  if (req.url === "/v1/models") {
    // 无认证 → 401（很多网关这样）
    send(401, { error: "missing key" });
    return;
  }
  if (req.url === "/nokey/v1/models") {
    send(404, "no such route");
    return;
  }
  if (req.url === "/nokey/models") {
    // 该前缀下只有不带 v1 的路径存在 → 验证回退。
    send(200, { data: ["gpt-x", "gpt-y"] });
    return;
  }
  if (req.url === "/models") {
    // OpenAI 风格路径
    send(200, { data: ["gpt-x", "gpt-y"] });
    return;
  }
  if (req.url === "/v1/messages" && req.method === "POST") {
    if (req.headers["x-api-key"] || req.headers["authorization"]) {
      send(200, { content: [{ type: "text", text: "pong" }] });
    } else send(401, { error: "no key" });
    return;
  }
  if (req.url === "/v1/chat/completions" && req.method === "POST") {
    send(200, { choices: [{ message: { content: "pong" } }] });
    return;
  }
  if (req.url === "/dead/v1/messages" || req.url === "/dead/v1/chat/completions") {
    send(500, { error: "bad model" });
    return;
  }
  send(404, "not found");
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

try {
  /* ── 1. 拉模型列表 ── */
  console.log("\n1. 拉模型列表");
  {
    seen.length = 0;
    const { models } = await listEndpointModels({ baseUrl: base, apiKey: "sk-1", authMode: "bearer" });
    check("★ /v1/models 的模型名都读出来了", models.join(",") === "alpha,beta", models);
    check("带了 Authorization: Bearer(sk-1 没漏进日志)", seen.some((s) => s.auth === "Bearer sk-1"), seen[0]);
  }
  {
    // 无 v1 前缀的 OpenAI 风格路径。
    seen.length = 0;
    const { models } = await listEndpointModels({ baseUrl: `${base}/nokey`, apiKey: "k" });
    check("★ /v1/models 不通时回落到 /models", models.join(",") === "gpt-x,gpt-y", models);
  }
  {
    // 端点没有列模型路由 → 必须抛，不能假装空列表成功。
    let threw = "";
    try {
      await listEndpointModels({ baseUrl: `${base}/dead`, apiKey: "k" });
    } catch (err) {
      threw = (err as Error).message;
    }
    check("★ 端点没有列模型接口时抛错(不静默返回空)", threw.length > 0, threw);
  }

  {
    for (const route of ["model-id-too-long", "model-id-control", "too-many-models"]) {
      let failed = false;
      try { await listEndpointModels({ baseUrl: base + "/" + route, apiKey: "fixture-key" }); }
      catch (err) { failed = /模型|ID|列表|name/i.test((err as Error).message); }
      check("malformed model identifiers are refused before entering the settings dropdown (" + route + ")", failed);
    }
  }

  {
    let refused = false;
    try { await listEndpointModels({ baseUrl: base + "/list-error-with-data", apiKey: "fixture-key" }); }
    catch { refused = true; }
    check("gateway JSON with error plus model data must not populate settings", refused);
  }

  {
    seen.length = 0;
    const { models } = await listEndpointModels({ baseUrl: base + "/v1", apiKey: "sk-prefix" });
    check("standard /v1 model base returns working model entries", models.includes("alpha"), models);
    check("model list with a /v1 base does not request /v1/v1/models or replay key", seen.length === 1 && seen[0].url === "/v1/models", seen);
  }

  /* ── 2. 连通性测试 ── */
  console.log("\n2. 连通性测试");
  {
    const r = await probeEndpoint({ baseUrl: base, apiKey: "sk-1", model: "alpha" });
    check("★ 通的端点判成功", r.ok === true, r);
  }
  {
    seen.length = 0;
    const r = await probeEndpoint({ baseUrl: base + "/v1", apiKey: "sk-prefix", model: "alpha" });
    check("user-configured /v1 API base is not accidentally doubled", r.ok, r);
    check("probe uses exactly the /v1/messages path with /v1 configured base",
      seen.length === 1 && seen[0].url === "/v1/messages", seen);
  }
  {
    // 打到一个只回 500 的路径（模拟「模型名不对」）→ 必须判失败，不能只看连得上。
    const r = await probeEndpoint({ baseUrl: `${base}/dead`, apiKey: "sk-1", model: "nope" });
    check("★ 端点答错(500)判失败,不当成功", r.ok === false, r);
    check("失败原因带上状态码线索", /500/.test(r.error ?? ""), r.error);
  }

  /* ── 2b. Fake 2xx is not evidence a model answered ── */
  for (const badGateway of ["false-ok", "html-ok", "empty-ok", "malformed-ok", "empty-array-ok", "bogus-content-ok", "empty-tool-calls-ok", "invalid-tool-calls-ok", "invalid-content-parts-ok", "cross-api-ok"]) {
    const r = await probeEndpoint({ baseUrl: base + "/" + badGateway, apiKey: "test-only-secret", model: "alpha" });
    check("200/204 without an actual model reply is not a successful connection (" + badGateway + ")", !r.ok, r);
  }

  {
    const r = await probeEndpoint({ baseUrl: base + "/valid-tool-calls", apiKey: "dummy", model: "alpha" });
    check("valid OpenAI tool call response still confirms API connectivity", r.ok, r);
  }

  /* ── 3. Network response abuse guards: bytes/redirect/body deadline ── */
  {
    seen.length = 0;
    let error = "";
    try { await listEndpointModels({ baseUrl: base + "/oversize", apiKey: "secret", timeoutMs: 200 }); }
    catch (err) { error = (err as Error).message; }
    check("oversize model body fails with explicit resource-budget error", /too large|过大|超过|预算|bytes/i.test(error), error);
  }
  {
    seen.length = 0;
    let error = "";
    try { await listEndpointModels({ baseUrl: base + "/slow-body", apiKey: "secret", timeoutMs: 25 }); }
    catch (err) { error = (err as Error).message; }
    check("body read deadline persists past response headers", /超时|timeout/i.test(error), error);
  }
  {
    seen.length = 0;
    let error = "";
    try { await listEndpointModels({ baseUrl: base + "/redirect", apiKey: "secret" }); }
    catch (err) { error = (err as Error).message; }
    check("authenticated model lookup refuses implicit 302 forwarding", /30[1278]|redirect|重定向/i.test(error), error);
    check("redirect endpoint never replays configured secret to new path",
      seen.every(v => v.url.startsWith("/redirect/")), seen);
  }

  {
    const r = await probeEndpoint({ baseUrl: base + "/echo", apiKey: "sk-localsecretXYZ", model: "alpha" });
    check("authentication rejection remains visible", !r.ok && (r.error ?? "").includes("401"), r);
    check("gateway echo of Authorization never leaks to model settings UI",
      !(r.error ?? "").includes("sk-localsecretXYZ"), r.error);
  }

  {
    const brokenKey = "fixture-only-secret-NEVER-SHOW" + String.fromCharCode(13, 10) + "x-test: value";
    const probe = await probeEndpoint({ baseUrl: base, apiKey: brokenKey, model: "alpha" });
    check("invalid credential headers never echo the supplied API key in probe error",
      !probe.ok && !(probe.error ?? "").includes("fixture-only-secret-NEVER-SHOW"), probe.error);
    let listError = "";
    try { await listEndpointModels({ baseUrl: base, apiKey: brokenKey }); }
    catch (err) { listError = (err as Error).message; }
    check("invalid credential headers never echo supplied API key in model-list error",
      listError.length > 0 && !listError.includes("fixture-only-secret-NEVER-SHOW"), listError);
  }

  /* ── 3b. A probe's deadline covers both fallback routes, not each separately ── */
  {
    seen.length = 0;
    let error = "";
    try { await listEndpointModels({ baseUrl: base + "/double-slow", apiKey: "fake-only", timeoutMs: 30 }); }
    catch (err) { error = (err as Error).message; }
    check("slow first model-list route does not spend another full deadline on fallback", seen.filter(s => s.url.startsWith("/double-slow/")).length === 1, seen);
    check("shared timeout failure is explicit", /timeout|超时/i.test(error), error);
  }
  {
    seen.length = 0;
    const result = await probeEndpoint({ baseUrl: base + "/double-slow", apiKey: "fake-only", model: "alpha", timeoutMs: 30 });
    check("slow first conversation probe does not send a second timed-out request", seen.filter(s => s.url.startsWith("/double-slow/")).length === 1, seen);
    check("shared timeout is not mislabeled successful", !result.ok, result);
  }

  /* ── 4. 地址守门 ── */
  console.log("\n3. 地址守门(相对地址 / 非法协议一律拒)");
  for (const bad of ["not-a-url", "ftp://x/y", "file:///etc/passwd", base + "/v1?token=test-only", base + "/v1#fragment", "http://user:password@127.0.0.1:" + port]) {
    let threw = false;
    try {
      await listEndpointModels({ baseUrl: bad });
    } catch {
      threw = true;
    }
    check(`★ 拒绝:${bad}`, threw);
  }
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

console.log(`\n${checks - failures}/${checks} model-endpoint checks passed`);
if (failures > 0) process.exit(1);
