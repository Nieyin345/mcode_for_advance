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

  /* ── 2. 连通性测试 ── */
  console.log("\n2. 连通性测试");
  {
    const r = await probeEndpoint({ baseUrl: base, apiKey: "sk-1", model: "alpha" });
    check("★ 通的端点判成功", r.ok === true, r);
  }
  {
    // 打到一个只回 500 的路径（模拟「模型名不对」）→ 必须判失败，不能只看连得上。
    const r = await probeEndpoint({ baseUrl: `${base}/dead`, apiKey: "sk-1", model: "nope" });
    check("★ 端点答错(500)判失败,不当成功", r.ok === false, r);
    check("失败原因带上状态码线索", /500/.test(r.error ?? ""), r.error);
  }

  /* ── 3. 地址守门 ── */
  console.log("\n3. 地址守门(相对地址 / 非法协议一律拒)");
  for (const bad of ["not-a-url", "ftp://x/y", "file:///etc/passwd"]) {
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
