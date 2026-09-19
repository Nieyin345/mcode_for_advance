/**
 * Loopback port allocation that clients will actually dial.
 *
 * ## The problem this exists for
 *
 * `server.listen(0, "127.0.0.1")` asks the OS for *any* free port. The OS has
 * no idea that HTTP clients refuse to dial some of them: the fetch spec keeps a
 * "bad port" list (IRC, SIP, FTP, X11, …) and Node's undici implements it,
 * throwing `TypeError: fetch failed` with `cause: bad port` **before a single
 * packet leaves the process**. Browsers enforce the same list.
 *
 * That produced a nasty failure shape. A local server bound to, say, 6667 looks
 * perfectly healthy from the inside — it is listening, `server.address()` is
 * correct, `curl` to it works — but every request from the client that matters
 * dies instantly with an error that names neither the port nor the blocklist.
 * On Windows the ephemeral range runs to 65535 and includes 6665-6669 / 6679 /
 * 6697 (IRC), 5060-5061 (SIP) and 6000 (X11), so a random draw lands on one
 * often enough to show up as a flaky test rather than as a bug report.
 *
 * ## Why re-drawing works
 *
 * The OS will not hand back a port it just gave out, so a second `listen(0)`
 * gets a different one. Retrying a few times makes the odds of ending up
 * undialable negligible without any need to enumerate the ephemeral range or
 * fight the OS for a specific port.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

/** Ports the fetch spec calls "bad" — clients must refuse to dial them without
 *  sending a packet. Node's undici and every browser enforce this list.
 *
 *  Verbatim from the WHATWG fetch spec. Copied as a constant rather than
 *  probed at runtime because the list is fixed by the spec, and because probing
 *  with a real `fetch` would be confounded by proxy env vars in the very
 *  process doing the probing (a proxy makes even a good port look dialable). */
const BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 138, 139, 143, 161, 179, 389, 427,
  465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990,
  993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667,
  6668, 6669, 6679, 6697, 10080,
]);

/** How many times to re-ask the OS before giving up. Five draws from a range
 *  where ~60 ports are blocked puts the failure probability around 1e-7 — far
 *  below the odds of the machine being broken in some other way. */
const MAX_ATTEMPTS = 5;

/** True if an HTTP client would refuse to dial `port`. */
export function isBlockedPort(port: number): boolean {
  return BAD_PORTS.has(port);
}

/** Bind `server` to a free loopback port and resolve with it — retrying if the
 *  OS hands back one no client will dial.
 *
 *  `onBind(port)` runs after each successful bind so a caller with its own
 *  bookkeeping (logging, a stored handle) can see the accepted attempt. An
 *  `onBind` that throws aborts the loop.
 *
 *  Rejects only after every attempt was blocked. That is deliberately the last
 *  resort: the caller is usually on a critical path (a session's first turn),
 *  and a silent hang there is worse than a loud error. */
export async function listenOnDialablePort(
  server: Server,
  onBind?: (port: number, attempt: number) => void,
): Promise<number> {
  let lastBlocked = 0;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        const addr = server.address() as AddressInfo | null;
        if (addr && typeof addr === "object") resolve(addr.port);
        else reject(new Error("failed to bind loopback server"));
      });
    });
    onBind?.(port, attempt);
    if (!BAD_PORTS.has(port)) return port;

    // Blocked: close this listener before trying again. `close` is async, and
    // without awaiting it the next `listen` races the old socket.
    lastBlocked = port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  throw new Error(
    `failed to bind a dialable loopback port after ${MAX_ATTEMPTS} attempts (last was ${lastBlocked})`,
  );
}
