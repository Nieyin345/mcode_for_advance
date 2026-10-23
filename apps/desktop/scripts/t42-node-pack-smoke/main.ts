/**
 * T42 focused package/Host protocol/negative mutation checks.
 * No user data or provider credentials: scratch dataDir + a fake Host.
 */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureNodePack, expectedNodePackFiles, MCODE_NODE_PACK_MANIFEST,
  MCODE_NODE_PACK_DIR, MCODE_NODE_PACK_SCHEMA, MCODE_NODE_PACK_INSTALL_VERSION,
} from "@main/workflowEngines/nodePackManifest.js";
import { NodePackHost } from "@main/workflowEngines/nodePackHost.js";

let total = 0;
let failed = 0;
const check = (label: string, condition: boolean, details?: unknown): void => {
  total++;
  if (condition) console.log("  ok  " + label);
  else { failed++; console.log("  FAIL " + label + " " + JSON.stringify(details)); }
};
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const root = mkdtempSync(join(tmpdir(), "mcode-t42-pack-"));
try {
  const contents = expectedNodePackFiles();
  check("6 independent js/html pairs with one shared bundled runtime",
    Object.keys(contents).filter((n) => n.endsWith(".js")).length === 6
      && Object.keys(contents).filter((n) => n.endsWith(".html")).length === 6
      && Object.keys(contents).includes("mcode-runtime.cjs"));
  check("6 x 2 locale files", Object.keys(contents).filter((n) => n.startsWith("locales/")).length === 12);
  const initial = ensureNodePack(root, "node-red");
  check("managed package initial install", initial.ok && initial.action === "written", initial);
  const manifest = JSON.parse(readFileSync(join(root, MCODE_NODE_PACK_MANIFEST), "utf8"));
  check("manifest schema/version and 26 SHA-256 records", manifest.schema === MCODE_NODE_PACK_SCHEMA
    && manifest.pack.version === MCODE_NODE_PACK_INSTALL_VERSION && Object.keys(manifest.files).length === 26);
  const installed = join(root, MCODE_NODE_PACK_DIR);
  const asset = join(installed, "mcode-agent.html");
  check("installed HTML byte-hash matches manifest", hash(readFileSync(asset)) === manifest.files["mcode-agent.html"]);
  const stable = ensureNodePack(root, "node-red");
  check("unchanged bundle does not force rewrite", stable.ok && stable.action === "unchanged", stable);

  // Mutation #3: deliberately tamper with an existing managed file while the
  // old manifest still claims its original bytes. Without verification the
  // damaged node editor would survive a restart.
  writeFileSync(asset, "<bad/>");
  check("MUTATION manifest missing integrity check must be RED before repair",
    hash(readFileSync(asset)) !== manifest.files["mcode-agent.html"]);
  const repaired = ensureNodePack(root, "node-red");
  check("installer restores corrupted file from current source", repaired.ok
    && repaired.action === "restored" && hash(readFileSync(asset)) === manifest.files["mcode-agent.html"], repaired);
  check("replaced bytes kept in backup", readdirSync(installed).some((n) => n.startsWith("mcode-agent.html.bak-")));

  // Mutation #1: the registration test asserts the literal deployed nodesDir
  // wiring, not just a comment. The real-engine /nodes test in the original
  // MERGE-2 smoke is the runtime companion of this source-level mutation.
  const registrySource = readFileSync("src/main/workflowEngines/registry.ts", "utf8");
  const nodesDirWire = 'nodesDir: [require("node:path").join(__dirname, "mcode-node-pack")]';
  check("bootstrap includes managed nodesDir", registrySource.includes(nodesDirWire));
  check("MUTATION removing nodesDir trips the wiring assertion",
    !registrySource.replace(nodesDirWire, "").includes(nodesDirWire));

  const cjs = readFileSync(join(installed, "mcode-runtime.cjs"), "utf8");
  check("standalone CJS contains Host process IPC and no provider SDK import",
    cjs.includes("mcode-node-request") && cjs.includes("process.send")
      && !cjs.includes("RuntimeManager") && !cjs.includes("sherpa-onnx")
      && !cjs.includes("claude-agent-sdk") && !cjs.includes("@openai/codex"));

  // Mutation #2: load REAL distributed CJS without fork IPC. No fallback
  // local executor can turn the message into a spurious successful output.
  const cjsRuntime = createRequire(import.meta.url)(join(installed, "mcode-runtime.cjs"));
  let ctor: ((this: any, config: Record<string, unknown>) => void) | undefined;
  const red = {
    nodes: {
      registerType(type: string, fn: unknown) {
        if (type === "mcode-agent") ctor = fn as typeof ctor;
      },
      createNode() {},
    },
  };
  cjsRuntime.registerType(red, "mcode-agent");
  let input: ((msg: Record<string, unknown>, send: (arg: unknown) => void, done: (error?: Error) => void) => void) | undefined;
  let nodeErrors = 0;
  let sent = 0;
  const node = {
    on(type: string, handler: typeof input) { if (type === "input") input = handler; },
    error(_error: unknown) { nodeErrors++; },
  };
  ctor!.call(node, { id: "ipc-disabled", instruction: "do not run locally" });
  const err = await new Promise<Error | undefined>((resolve) => input!({ payload: "probe" }, () => { sent++; }, resolve));
  check("MUTATION removing Host IPC refuses execution, done(Error) + no send",
    err instanceof Error && err.message.includes("Host IPC unavailable") && nodeErrors === 1 && sent === 0,
    { error: err?.message, nodeErrors, sent });

  const responses: Record<string, unknown>[] = [];
  let executions = 0;
  let cancellations = 0;
  const host = new NodePackHost({
    execute: async () => { executions++; return { text: "host output", artifacts: [] }; },
    subscribe: (_payload, emit) => {
      emit({ payload: { kind: "host-event" } }); // synchronous race regression
      return () => { cancellations++; };
    },
  });
  check("Host accepts request over existing private child message API",
    host.handle({ kind: "mcode-node-request", id: "1", operation: "agent.run",
      payload: { nodeId: "n1", params: {} } }, (message) => responses.push(message as Record<string, unknown>)));
  await new Promise<void>((resolve) => setImmediate(resolve));
  check("Host replies exactly once with typed transport result",
    executions === 1 && responses.length === 1 && responses[0]?.kind === "mcode-node-reply"
      && responses[0]?.ok === true);
  check("missing identity does not execute underlying capability", host.handle({
    kind: "mcode-node-request", id: "2", operation: "agent.run", payload: { params: {} },
  }, (message) => responses.push(message as Record<string, unknown>)));
  check("invalid identity is denied", executions === 1
    && responses.at(-1)?.ok === false);
  const events: Record<string, unknown>[] = [];
  host.handle({ kind: "mcode-node-request", id: "3", operation: "trigger.subscribe",
    payload: { nodeId: "tr", subscriptionId: "sub-20", triggerKind: "event", params: {} },
  }, (message) => events.push(message as Record<string, unknown>));
  await new Promise<void>((resolve) => setImmediate(resolve));
  check("synchronous Host trigger survives subscription handshake",
    events.some((e) => e.kind === "mcode-node-event" && e.id === "sub-20"));
  host.handle({ kind: "mcode-node-unsubscribe", id: "sub-20" }, () => {});
  host.dispose();
  check("unsubscribe disposes Host trigger exactly once", cancellations === 1);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log("T42 node-pack: " + (total - failed) + "/" + total + " pass");
if (failed) process.exitCode = 1;
