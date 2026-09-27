/**
 * M03 regression for the Claude SDK stdin-settle gate. A result must be
 * strictly newer than the latest background-task edge before it can release
 * the prompt stream; equal millisecond timestamps are not proof of ordering.
 * This uses only the real adapter with a fake ProviderContext—no model or DB.
 */
import { FileSnapshot } from "@main/lib/fileSnapshot.js";
import { SdkMessageAdapter } from "@main/providers/claude-sdk/SdkMessageAdapter.js";
import type { ProviderContext } from "@contracts/provider";
import type { RuntimeEvent } from "@contracts/runtime";

const SETTLE_GRACE_MS = 1_500;
let checks = 0;
let failures = 0;

function check(name: string, condition: boolean, actual?: unknown): void {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${actual === undefined ? "" : ` — ${JSON.stringify(actual)}`}`);
}

function makeAdapter(released: () => void): { adapter: SdkMessageAdapter; events: RuntimeEvent[] } {
  const events: RuntimeEvent[] = [];
  const ctx: ProviderContext = {
    emit: (event) => events.push(event),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
  const adapter = new SdkMessageAdapter(ctx, "m03-settle", false, process.cwd(), new FileSnapshot());
  adapter.setSettleGate(released);
  return { adapter, events };
}

function backgroundTasksChanged(): unknown {
  return { type: "system", subtype: "background_tasks_changed", tasks: [] };
}

function result(): unknown {
  return {
    type: "result",
    subtype: "success",
    stop_reason: "end_turn",
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
  };
}

async function waitForSettleGrace(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, SETTLE_GRACE_MS + 250));
}

async function main(): Promise<void> {
  const realNow = Date.now;
  let tiedReleases = 0;
  const tied = makeAdapter(() => { tiedReleases += 1; });
  try {
    // An empty background-task level signal can be the final edge just before
    // the result. Date.now() has millisecond precision, so both can tie.
    Date.now = () => 1_000;
    await tied.adapter.dispatch(backgroundTasksChanged() as never);
    await tied.adapter.dispatch(result() as never);
  } finally {
    Date.now = realNow;
  }
  await waitForSettleGrace();
  check("equal result/agent-edge timestamps do not release stdin", tiedReleases === 0, tiedReleases);

  // A genuinely later result is still allowed to release the hold after the
  // documented grace period.
  let laterReleases = 0;
  const later = makeAdapter(() => { laterReleases += 1; });
  try {
    Date.now = () => 2_000;
    await later.adapter.dispatch(backgroundTasksChanged() as never);
    Date.now = () => 2_001;
    await later.adapter.dispatch(result() as never);
  } finally {
    Date.now = realNow;
  }
  await waitForSettleGrace();
  check("strictly newer result releases stdin", laterReleases === 1, laterReleases);

  console.log(`\n${checks - failures}/${checks} M03 checks passed`);
  if (failures > 0) process.exit(1);
}

void main();
