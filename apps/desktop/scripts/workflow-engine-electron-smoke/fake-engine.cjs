// 【ARC-006 NR2】真 Electron U1 的「假引擎进程」—— 端口与数据目录由宿主给。
//
// ## 它为什么存在
//
// NR2 验收门要的是「真 Electron 宿主能嵌引擎编辑器地址并管住它」。真 Node-RED
// 需要 npm install（U1 不联网），所以这一片用**真进程 + 真端口 + 真 HTTP 页面**
// 的最小替身：它与生产引导脚本（`workflowEngines/registry.ts` 的 BOOTSTRAP）同形 ——
// 从 argv 拿端口与 userDir、只绑 127.0.0.1、就绪后往 stderr 打一行。
//
// ## 它被谁跑
//
// `EngineRuntime` 的**生产** spawn 端口：`process.execPath`（真 Electron 主进程里
// 就是 electron.exe）+ `ELECTRON_RUN_AS_NODE=1`。启动参数由**生产**
// `createEngineLaunchSpec` 生成（探针见 probe.ts）—— 套件不再自己拼 env，
// 生产缺了 Electron-as-Node 模式时这套会真的起不来。
//
// ## 最小编辑器页
//
// `GET /` 返回一个自限页面（CSP 禁一切外联，只允许同源 `connect-src 'self'`）；
// 页面里的 `window.__deploy()` 向**同一个引擎端口** POST `/deploy` —— 这是
// 「在编辑器里编辑、deploy」的最小替身：它证明 WebContentsView 真的把页面放在
// 引擎的 origin 上，页面里的请求真的到达引擎进程。
const http = require('node:http');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const port = Number(process.argv[2]);
const userDir = process.argv[3];
if (!Number.isInteger(port) || port <= 0) {
  console.error('[fake-engine] missing/invalid port argv: ' + process.argv[2]);
  process.exit(2);
}
if (!userDir) {
  console.error('[fake-engine] missing userDir argv');
  process.exit(2);
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'">
<title>engine editor</title></head>
<body data-engine="boot">
<script>
  window.__marker = 'kept-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  window.__deploy = async () => {
    const r = await fetch('/deploy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ flow: 'u1', at: Date.now() }),
    });
    const data = await r.json();
    document.body.dataset.deploy = String(data.deployed);
    return document.body.dataset.deploy;
  };
  document.body.dataset.engine = 'loaded:' + location.origin;
</script>
</body></html>`;

const deploys = [];
const adminToken = process.env.MCODE_ENGINE_ADMIN_TOKEN || '';
const server = http.createServer((req, res) => {
  // 【P1-3/P1-4】与生产 bootstrap 同一条控制面语义：/settings 只认宿主令牌。
  // 宿主探针（生产 defaultProbe）先匿名要 401、再带令牌要 200 + Node-RED 形状。
  // 令牌由**生产** createEngineLaunchSpec 生成并注入 —— 套件自己不补任何配置。
  if (req.url === '/settings') {
    if (adminToken === '' || req.headers.authorization !== 'Bearer ' + adminToken) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('Unauthorized');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ httpNodeRoot: '/api', version: '0.0.0-fake-engine' }));
    return;
  }
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }
  if (req.method === 'POST' && req.url === '/deploy') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      deploys.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ deployed: deploys.length }));
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/__state') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ deploys: deploys.length, lastBody: deploys.length > 0 ? deploys[deploys.length - 1] : null }));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(port, '127.0.0.1', () => {
  // 落在**宿主给的数据目录**里：探针据此断言 cwd/dataDir 真的传到了引擎进程。
  writeFileSync(join(userDir, 'engine-boot.txt'), 'booted on 127.0.0.1:' + port);
  console.error('[fake-engine] ready on 127.0.0.1:' + port);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  // 兜底：连接还挂着时也别赖着不走。
  setTimeout(() => process.exit(0), 2000).unref();
});
