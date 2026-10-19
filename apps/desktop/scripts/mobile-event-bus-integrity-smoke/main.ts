import { MobileEventBus } from "../../src/main/mobile/MobileEventBus.js";
import type { RuntimeEvent } from "@contracts/runtime";

let passed = 0, failed = 0;
function check(name: string, ok: boolean, details?: unknown): void {
  if (ok) { passed++; console.log("PASS " + name); }
  else { failed++; console.log("FAIL " + name + " " + JSON.stringify(details)); }
}
const ev = { type: "session.deleted", sessionId: "fictional-session" } as RuntimeEvent;
{
  const bus = new MobileEventBus();
  const seen: string[] = [];
  let registered = false;
  bus.subscribe(() => {
    seen.push("A");
    if (!registered) {
      registered = true;
      bus.subscribe(() => seen.push("B"));
    }
  });
  bus.broadcast(ev);
  check("★ A subscriber added while broadcasting must not receive this already-started event",
    seen.join(",") === "A", seen);
  check("new subscriber registered for future events", bus.size === 2, bus.size);
  bus.broadcast(ev);
  check("original and late subscriber both receive next broadcast", seen.join(",") === "A,A,B", seen);
}
{
  const bus = new MobileEventBus();
  const seen: string[] = [];
  let removeB = () => {};
  bus.subscribe(() => { seen.push("A"); removeB(); });
  removeB = bus.subscribe(() => seen.push("B"));
  bus.broadcast(ev);
  check("★ revoked subscriber never receives a queued event", seen.join(",") === "A", seen);
  check("revocation is idempotent", (removeB(), removeB(), bus.size === 1));
}
{
  const bus = new MobileEventBus();
  const seen: string[] = [];
  bus.subscribe(() => { throw new Error("FAKE_SSE_CLIENT_DISCONNECTED"); });
  const remove = bus.subscribe(() => seen.push("alive"));
  bus.broadcast(ev);
  check("throwing subscriber does not block healthy client", seen.join(",") === "alive", seen);
  remove();
  bus.broadcast(ev);
  check("unsubscribe prevents subsequent broadcasts", seen.join(",") === "alive" && bus.size === 1, seen);
}
{
  const bus = new MobileEventBus();
  let delivered = 0;
  bus.subscribe(() => {
    delivered++;
    if (delivered < 4) bus.subscribe(() => {
      delivered++;
      if (delivered < 4) bus.subscribe(() => delivered++);
    });
  });
  bus.broadcast(ev);
  check("★ recursive subscriber registration cannot recursively fan out same frame",
    delivered === 1, delivered);
}
console.log(`mobile-event-bus-integrity-smoke: ${passed}/${passed + failed}`);
if (failed > 0) process.exitCode = 1;
