/**
 * Headless smoke for `lib/loopbackPort.ts` — allocating a loopback port that an
 * HTTP client will actually dial.
 *
 * The bug this protects against: `listen(0)` hands back any free port, and the
 * OS has no idea that the fetch spec's *bad port* list (IRC/SIP/FTP/X11) makes
 * clients refuse to dial some of them. A local server on one of those ports
 * looks healthy from inside the process — bound, correct `server.address()`,
 * reachable by `curl` — while every `fetch` to it dies before a packet leaves.
 * That is how upstream-headers-smoke failed with `fetch failed: bad port`.
 *
 * Two levels of coverage, because either alone would pass on a broken fix:
 *
 *  1. A **real socket** through `listenOnDialablePort` — proving the returned
 *     port is genuinely bound and genuinely dialable by `fetch`, which is the
 *     exact call that used to fail.
 *  2. A **scripted fake server** that returns blocked ports first — the only way
 *     to exercise the retry path deterministically, since the real OS will not
 *     hand out a bad port on demand.
 *
 * Run: scripts/loopback-port-smoke/run.sh
 */
import { createServer } from "node:http";
import type { Server } from "node:http";
import { isBlockedPort, listenOnDialablePort } from "@main/lib/loopbackPort.js";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    return;
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

/* ───────────────────── the bad-port predicate ───────────────────── */

// Ports the spec blocks, and that we have observed Node refuse in this very
// environment (see the probe in the commit that added this suite).
for (const p of [6667, 6668, 6697, 5060, 6000, 10080]) {
  check(`isBlockedPort(${p}) — spec-blocked`, isBlockedPort(p));
}
// Wine/private-range ports the bridge and extension bridge actually land on.
for (const p of [17831, 49152, 65535, 1024, 8080]) {
  check(`isBlockedPort(${p}) is false`, !isBlockedPort(p));
}

/* ───────────────────── a real socket, dialed for real ───────────────────── */

{
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  });
  const binds: number[] = [];
  const port = await listenOnDialablePort(server, (p) => binds.push(p));

  check("real socket: bound to a port", port > 0, String(port));
  check("real socket: the chosen port is not blocked", !isBlockedPort(port), String(port));
  check("real socket: onBind fired exactly once", binds.length === 1, String(binds.length));
  check("real socket: onBind saw the returned port", binds[0] === port, `${binds[0]} vs ${port}`);

  // The decisive assertion: dial it the way the Claude binary does. Under the
  // old code this is where a blocked port surfaced as `fetch failed: bad port`
  // with nothing pointing at the port.
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    check("real socket: fetch reaches it", res.status === 200, String(res.status));
    check("real socket: body round-trips", (await res.text()) === "ok");
  } catch (err) {
    const e = err as { message?: string; cause?: { message?: string } };
    check("real socket: fetch reaches it", false, `${e.message} / ${e.cause?.message}`);
  }
  await new Promise<void>((r) => server.close(() => r()));
}

/* ───────────────────── the retry path, scripted ───────────────────── */

/** A stand-in for `Server` whose `listen(0)` returns a scripted port sequence,
 *  and which records the calls — enough to prove the loop rebinds, waits for
 *  `close` between attempts, and reports the port it gave up on.
 *
 *  Cast because `listenOnDialablePort` takes a real `Server`; this suite is the
 *  only place that wants a fake, and the alternative (injecting a draw function
 *  into production code purely for tests) buys less than it costs. */
function fakeServer(ports: number[]) {
  const calls: string[] = [];
  let i = 0;
  let bound: number | null = null;
  const srv = {
    calls,
    once(ev: string) {
      calls.push(`once:${ev}`);
      return srv;
    },
    off() {
      return srv;
    },
    listen(_p: number, _h: string, cb: () => void) {
      const next = ports[i++];
      if (next === undefined) {
        calls.push("listen:exhausted");
        throw new Error("fake server ran out of scripted ports");
      }
      bound = next;
      calls.push(`listen:${next}`);
      cb();
      return srv;
    },
    address: () => ({ port: bound }),
    close(cb: () => void) {
      calls.push("close");
      // Async on purpose — the loop must await this before re-listening, or the
      // next `listen` races the socket it is trying to escape.
      setTimeout(() => {
        calls.push("close:done");
        cb();
      }, 5);
    },
  };
  return srv;
}

{
  const srv = fakeServer([6667, 6697, 54321]);
  const port = await listenOnDialablePort(srv as unknown as Server);
  check("retry: returns the first dialable port", port === 54321, String(port));
  check(
    "retry: rebound once per blocked port",
    srv.calls.filter((c) => c.startsWith("listen:")).join(",") === "listen:6667,listen:6697,listen:54321",
    srv.calls.join(" "),
  );
  // Ordering, not an exact call list: a blocked bind must be closed — and the
  // close must have COMPLETED — before the next `listen`, or the rebind races
  // the socket it is trying to escape.
  const trace = srv.calls.join(" ");
  const firstBind = trace.indexOf("listen:6667");
  const firstCloseDone = trace.indexOf("close:done");
  const secondBind = trace.indexOf("listen:6697");
  check(
    "retry: every blocked attempt was closed and awaited before the next",
    firstBind >= 0 && firstCloseDone > firstBind && secondBind > firstCloseDone,
    trace,
  );
  check("retry: a successful bind is not closed", !trace.endsWith("close"), trace);
}

{
  // The error must name the last blocked port: without it the message is
  // "failed to bind" with no clue that the ports were the problem.
  //
  // ⚠️ 这句话会经 `BridgeRegistry.acquire → RuntimeManager` 包成
  // `自定义模型翻译桥启动失败: …` 画给用户,所以它**必须是人话中文**,不能是英文原句
  // (从前是 `failed to bind a dialable loopback port after 5 attempts (last was 6000)` ——
  // 半中半英)。
  const srv = fakeServer([6667, 6668, 6669, 6697, 6000]);
  let message = "";
  try {
    await listenOnDialablePort(srv as unknown as Server);
  } catch (err) {
    message = (err as Error).message;
  }
  check("giving up: throws rather than hanging", message !== "");
  check("giving up: names the attempt count", /5/.test(message), message);
  check("giving up: names the last blocked port", /6000/.test(message), message);
  check("★ giving up: 说的是人话中文(不是英文原句)", /[一-鿿]/.test(message) && !/failed to bind/.test(message), message);
}

/* ───────────────────────────── report ───────────────────────────── */

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ loopback-port smoke: ${passed} assertions passed`);
